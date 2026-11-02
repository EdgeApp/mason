import { AppleApiError } from '../apple/connect.js'
import {
  deviceClasses,
  deviceClassOf,
  type ApplePlatform,
} from '../apple/profiles.js'
import type { AppleService } from '../apple/service.js'
import type { MasterDatabase } from './database.js'
import type { Jobs, JobView } from './jobs.js'
import type { Project, Projects } from './projects.js'
import { isGlob, ruleFor } from './rules.js'

/** Attempts at Apple for a device before it shows an error the tester can retry. */
const ATTEMPTS = 3
/** At most this many branches of a project are built for a new device. */
export const MAX_DEVICE_BRANCHES = 20

/**
 * Devices and "Prepare for this device" requests the host sent through its
 * outbox, handled on the master with its App Store Connect client: each new
 * device is registered with Apple in every team that signs an app for its
 * device class (an iPhone: an iOS app), the development and ad hoc profiles
 * Mason holds for those teams are made again with the full list of enabled
 * devices (the replacement before the old profile is deleted), and builds
 * of the automatic branches of each project with an app for the device's
 * class, whose build runs when a device is registered, are queued so they
 * can install on it. A prepare request becomes
 * a job pinned to the build's branch and commit. No Apple credential leaves
 * the master.
 */
export class Provisioning {
  private running: Promise<void> | undefined
  private again = false
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly options: {
      master: MasterDatabase
      apple: AppleService
      projects: Projects
      jobs: Jobs
      /** Workflows that run when a device is registered, and placing new jobs. */
      scheduler: { deviceRegistered(): JobView[]; poke(): void }
      log?: (line: string) => void
    },
  ) {}
  private get db(): MasterDatabase['db'] {
    return this.options.master.db
  }

  start(intervalMs = 10 * 60 * 1000): void {
    this.poke()
    this.timer = setInterval(() => {
      this.poke()
    }, intervalMs)
    this.timer.unref()
  }
  stop(): void {
    clearInterval(this.timer)
  }

  /** Handles what is waiting; one pass at a time, and once more when asked during a pass. */
  poke(): Promise<void> {
    if (this.running != null) {
      this.again = true
      return this.running
    }
    this.running = (async (): Promise<void> => {
      do {
        this.again = false
        await this.devices()
        this.prepares()
      } while (this.again)
    })()
      .catch((error: unknown) => {
        this.options.log?.(
          `Device provisioning failed: ${(error as Error).message}`,
        )
      })
      .finally(() => {
        this.running = undefined
      })
    return this.running
  }

  /** Projects with an app for a device class, and the Apple teams that sign those apps. */
  private projectsFor(
    deviceClass: string | undefined,
  ): Array<{ project: Project; teams: string[] }> {
    const fits = (app: Project['apps'][number]): boolean =>
      app.platforms.some(
        (platform) =>
          platform in deviceClasses &&
          deviceClasses[platform as ApplePlatform].includes(deviceClass ?? ''),
      )
    return this.options.projects
      .list()
      .filter((project) => project.enabled && project.apps.some(fits))
      .map((project) => ({
        project,
        teams: project.apps
          .filter((app) => fits(app) && app.apple != null)
          .map((app) => app.apple!.team),
      }))
  }

  private setStatus(id: number, status: string, message = ''): void {
    this.db
      .prepare('UPDATE devices SET status=?,message=?,updated_at=? WHERE id=?')
      .run(status, message, this.options.master.now(), id)
    this.options.master.change('device', id)
  }

  private async devices(): Promise<void> {
    const pending = this.db
      .prepare(
        "SELECT d.id,d.udid,d.product,(SELECT name FROM account_devices WHERE device_id=d.id ORDER BY created_at LIMIT 1) name FROM devices d WHERE d.status IN ('pending','processing') ORDER BY d.id",
      )
      .all() as Array<{
      id: number
      udid: string
      product: string
      name: string | null
    }>
    if (pending.length === 0) return
    const signing = (entries: Array<{ teams: string[] }>): string[] =>
      [...new Set(entries.flatMap((entry) => entry.teams))].filter(
        (team) => this.options.apple.connect(team) != null,
      )
    const registered: Array<{ id: number; projects: Project[] }> = []
    const changed = new Set<string>()
    for (const device of pending) {
      const projects = this.projectsFor(deviceClassOf(device.product))
      const teams = signing(projects)
      if (teams.length === 0) {
        this.setStatus(
          device.id,
          'error',
          `No Apple team with an App Store Connect key signs an app for this device (${device.product}) on this master`,
        )
        continue
      }
      this.setStatus(device.id, 'processing')
      try {
        for (const team of teams) await this.register(team, device)
        registered.push({
          id: device.id,
          projects: projects.map((entry) => entry.project),
        })
        for (const team of teams) changed.add(team)
        this.db
          .prepare('DELETE FROM apple_cache WHERE key=?')
          .run(`attempts:${device.id}`)
      } catch (error) {
        const attempts = this.attempt(device.id)
        const message =
          error instanceof AppleApiError && error.status === 409
            ? `Apple refused the device: ${error.message}`
            : (error as Error).message
        // A refusal is final; anything else is tried again, at most three times.
        if (
          (error instanceof AppleApiError &&
            error.status < 500 &&
            error.status !== 429) ||
          attempts >= ATTEMPTS
        )
          this.setStatus(device.id, 'error', message.slice(0, 500))
        else this.setStatus(device.id, 'pending', message.slice(0, 500))
      }
    }
    if (registered.length === 0) return
    // The profiles that list devices are made again, each with every enabled device.
    for (const team of [...changed].sort()) {
      await this.options.apple.profiles.devices(team, 'ios', true)
      const profiles = this.db
        .prepare(
          "SELECT DISTINCT bundle_id,distribution FROM apple_profiles WHERE team_id=? AND distribution IN ('development','adHoc') AND deleted_at IS NULL ORDER BY bundle_id,distribution",
        )
        .all(team) as Array<{
        bundle_id: string
        distribution: 'development' | 'adHoc'
      }>
      for (const profile of profiles)
        await this.options.apple.profiles
          .ensure({
            team,
            bundleId: profile.bundle_id,
            distribution: profile.distribution,
            platform: 'ios',
          })
          .catch((error: unknown) => {
            this.options.log?.(
              `Could not make the ${profile.distribution} profile of ${profile.bundle_id} again: ${(error as Error).message}`,
            )
          })
    }
    for (const { id } of registered) this.setStatus(id, 'registered')
    this.queueBuilds([
      ...new Set(registered.flatMap((entry) => entry.projects)),
    ])
  }

  private attempt(device: number): number {
    const key = `attempts:${device}`
    const row = this.db
      .prepare('SELECT value FROM apple_cache WHERE key=?')
      .get(key) as { value: string } | undefined
    const attempts = Number(row?.value ?? 0) + 1
    this.db
      .prepare(
        'INSERT INTO apple_cache(key,value,fetched_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,fetched_at=excluded.fetched_at',
      )
      .run(key, String(attempts), this.options.master.now())
    return attempts
  }

  /** Registers the device with a team unless Apple already has it. */
  private async register(
    team: string,
    device: { udid: string; product: string; name: string | null },
  ): Promise<void> {
    const connect = this.options.apple.connect(team)!
    const known = await connect.all<{ udid: string }>(
      `/v1/devices?filter[udid]=${encodeURIComponent(device.udid)}`,
    )
    if (known.some((entry) => entry.attributes.udid === device.udid)) return
    await connect.request('POST', '/v1/devices', {
      data: {
        type: 'devices',
        attributes: {
          name: (device.name ?? device.product)
            .replace(/[^A-Za-z0-9 ’'._-]/g, ' ')
            .slice(0, 50),
          udid: device.udid,
          platform: 'IOS',
        },
      },
    })
  }

  /**
   * Builds that can install on the new device: each iOS project's automatic
   * branches whose build, as the branch's last push setup recorded it, runs
   * when a device is registered, at their last seen commit, one waiting job
   * per branch and at most `MAX_DEVICE_BRANCHES` per project (the default
   * branch, then exact rules', then the most recently set up); and the
   * workflows that run when a device is registered. A branch whose triggers
   * the master does not know gets none: its next run makes its profiles
   * with the device anyway.
   */
  queueBuilds(projects: Project[]): void {
    for (const project of projects) {
      const exact = project.rules
        .filter((rule) => rule.mode === 'automatic' && !isGlob(rule.pattern))
        .map((rule) => rule.pattern)
      const rank = (branch: string): number =>
        branch === project.defaultBranch
          ? -1
          : exact.includes(branch)
            ? exact.indexOf(branch)
            : exact.length
      const branches = (
        this.db
          .prepare(
            'SELECT branch,observed_commit,device_registered FROM automatic_branches WHERE project_id=? AND observed_commit IS NOT NULL AND device_registered IS NOT NULL ORDER BY device_registered DESC,branch',
          )
          .all(project.id) as Array<{ branch: string; observed_commit: string }>
      )
        .filter(
          (entry) => ruleFor(project.rules, entry.branch)?.mode === 'automatic',
        )
        .map((entry, order) => ({ ...entry, order }))
        .sort((a, b) => rank(a.branch) - rank(b.branch) || a.order - b.order)
      let queued = 0
      for (const entry of branches) {
        if (queued >= MAX_DEVICE_BRANCHES) break
        const waiting = this.db
          .prepare(
            "SELECT 1 FROM jobs WHERE project_id=? AND branch=? AND status IN ('queued','running') LIMIT 1",
          )
          .get(project.id, entry.branch)
        if (waiting != null) continue
        this.options.jobs.create(project, entry.branch, 'deviceRegistered', {
          commit: entry.observed_commit,
        })
        queued++
      }
    }
    this.options.scheduler.deviceRegistered()
    this.options.scheduler.poke()
  }

  /** "Prepare for this device": a job pinned to the build's branch and commit. */
  private prepares(): void {
    const requests = this.db
      .prepare(
        "SELECT r.id,b.branch,b.commit_hash,b.platform,pa.project_id FROM device_build_requests r JOIN builds b ON b.id=r.build_id LEFT JOIN project_apps pa ON pa.app_id=b.app_id WHERE r.status='pending' ORDER BY r.id",
      )
      .all() as Array<{
      id: number
      branch: string
      commit_hash: string | null
      platform: string
      project_id: number | null
    }>
    for (const request of requests) {
      const fail = (message: string): void => {
        this.db
          .prepare(
            "UPDATE device_build_requests SET status='error',message=? WHERE id=?",
          )
          .run(message, request.id)
      }
      const project = this.options.projects
        .list()
        .find((entry) => entry.id === request.project_id)
      if (project == null) {
        fail('The build belongs to no project on this master')
        continue
      }
      if (
        request.commit_hash == null ||
        !/^[0-9a-f]{40}$/.test(request.commit_hash)
      ) {
        fail('The build has no commit to rebuild')
        continue
      }
      const job = this.options.jobs.create(project, request.branch, 'request', {
        commit: request.commit_hash,
      })
      this.db
        .prepare(
          "UPDATE device_build_requests SET status='queued',message=? WHERE id=?",
        )
        .run(job.id, request.id)
    }
    if (requests.length > 0) this.options.scheduler.poke()
  }
}
