import { createHash } from 'node:crypto'
import type { MasterDatabase } from '../master/database.js'
import type { Project, ProjectApp } from '../master/projects.js'
import type { SettingsArea, SettingValue } from '../master/settings.js'
import type { GraphStage } from '../pipeline/graph.js'
import type { StageSigning } from '../pipeline/assignment.js'
import { Certificates, type Tool } from './certificates.js'
import {
  appleApiBases,
  asConnectKey,
  AppStoreConnect,
  type AppleApiBases,
  type ConnectKey,
} from './connect.js'
import { Notary } from './notary.js'
import {
  certificateKindFor,
  Profiles,
  type ApplePlatform,
  type Distribution,
} from './profiles.js'
import { TestFlight } from './testflight.js'

const asAppleId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(value))
    throw new Error('appleId is an email address')
  return value
}
const asBase = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s]+$/.test(value))
    throw new Error(`endpoints.${name} is a URL`)
  return value.replace(/\/$/, '')
}

/**
 * The `apple` settings area: the Apple ID for Xcode downloads (M9), and per
 * team the App Store Connect key — its private key write-only — and, only
 * when the master runs with `--test-endpoints`, the base URLs of a fake
 * Apple.
 */
export function appleArea(testEndpoints: boolean): SettingsArea {
  return {
    validate: (input, previous): SettingValue => {
      const value = (input ?? {}) as Record<string, unknown>
      const stored = (previous ?? {}) as {
        appleId?: string
        teams?: Record<string, ConnectKey & { name?: string }>
        endpoints?: SettingValue
      }
      const out: SettingValue = {}
      // A field left out keeps what is stored; null clears it.
      const appleId =
        value.appleId === undefined ? stored.appleId : value.appleId
      if (appleId != null) out.appleId = asAppleId(appleId)
      if (value.teams != null) {
        if (typeof value.teams !== 'object' || Array.isArray(value.teams))
          throw new Error('teams maps team IDs to App Store Connect keys')
        const teams: Record<string, ConnectKey & { name?: string }> = {}
        for (const [team, raw] of Object.entries(
          value.teams as Record<string, unknown>,
        )) {
          if (!/^[A-Z0-9]{10}$/.test(team))
            throw new Error(`${team} is not an Apple team ID`)
          const entry = (raw ?? {}) as Record<string, unknown>
          const keep =
            typeof entry.privateKey === 'object' &&
            (entry.privateKey as { keep?: unknown } | null)?.keep === true
          const previousKey = stored.teams?.[team]
          if (keep && previousKey == null)
            throw new Error(`No stored key to keep for team ${team}`)
          const key = asConnectKey({
            ...entry,
            privateKey: keep ? previousKey!.privateKey : entry.privateKey,
          })
          teams[team] = {
            ...key,
            ...(typeof entry.name === 'string' && entry.name !== ''
              ? { name: entry.name.slice(0, 120) }
              : {}),
          }
        }
        out.teams = teams
      } else if (value.teams === undefined && stored.teams != null)
        out.teams = stored.teams
      if (value.endpoints === undefined && stored.endpoints != null)
        out.endpoints = stored.endpoints
      if (value.endpoints != null) {
        if (!testEndpoints)
          throw new Error(
            'Apple base URLs can only be set on a master started with --test-endpoints',
          )
        const endpoints = value.endpoints as Record<string, unknown>
        out.endpoints = {
          ...(endpoints.api == null
            ? {}
            : { api: asBase(endpoints.api, 'api') }),
          ...(endpoints.notary == null
            ? {}
            : { notary: asBase(endpoints.notary, 'notary') }),
          ...(endpoints.s3 == null ? {} : { s3: asBase(endpoints.s3, 's3') }),
        }
      }
      return out
    },
    redact: (value): SettingValue => {
      const teams = (value.teams ?? {}) as Record<
        string,
        ConnectKey & { name?: string }
      >
      return {
        ...value,
        ...(value.teams == null
          ? {}
          : {
              teams: Object.fromEntries(
                Object.entries(teams).map(([team, key]) => [
                  team,
                  {
                    ...(key.name == null ? {} : { name: key.name }),
                    issuerId: key.issuerId,
                    keyId: key.keyId,
                    privateKey: { set: true },
                  },
                ]),
              ),
            }),
      }
    },
  }
}

/**
 * Apple on the master: the App Store Connect client per team, certificates,
 * profiles, TestFlight and notarization. It is the only node that talks to
 * Apple's API, and it makes no Apple command-line calls.
 */
export class AppleService {
  readonly certificates: Certificates
  readonly profiles: Profiles
  readonly testflight: TestFlight
  readonly notary: Notary
  private clients = new Map<string, { key: string; client: AppStoreConnect }>()

  constructor(
    private readonly master: MasterDatabase,
    private readonly options: {
      setting: () => SettingValue | undefined
      testEndpoints: boolean
      fetch?: typeof fetch
      tool?: Tool
      openssl?: string
      clone?: (
        repository: string,
        branch: string,
        into: string,
      ) => Promise<void>
      scratch?: string
      sleep?: (ms: number) => Promise<void>
    },
  ) {
    const connect = (team: string): AppStoreConnect | undefined =>
      this.connect(team)
    this.certificates = new Certificates(master, {
      connect,
      ...(options.tool == null ? {} : { tool: options.tool }),
      ...(options.openssl == null ? {} : { openssl: options.openssl }),
      ...(options.clone == null ? {} : { clone: options.clone }),
      ...(options.scratch == null ? {} : { scratch: options.scratch }),
    })
    this.profiles = new Profiles(master, {
      connect,
      certificates: this.certificates,
    })
    this.testflight = new TestFlight(master, connect)
    this.notary = new Notary(
      master,
      connect,
      options.fetch ?? fetch,
      () => this.bases().s3,
    )
  }

  /** Apple's hosts, or a fake's only with `--test-endpoints`. */
  bases(): AppleApiBases {
    const stored = this.options.setting()?.endpoints as
      | Partial<AppleApiBases>
      | undefined
    if (!this.options.testEndpoints || stored == null) return appleApiBases
    return { ...appleApiBases, ...stored }
  }

  /** Why stored Apple base URLs are ignored, for the start-up log. */
  startupWarnings(): string[] {
    return !this.options.testEndpoints &&
      this.options.setting()?.endpoints != null
      ? [
          'Ignoring the Apple base URLs stored in the apple settings: this master was not started with --test-endpoints',
        ]
      : []
  }

  teams(): string[] {
    return Object.keys((this.options.setting()?.teams ?? {}) as object).sort()
  }

  connect(team: string): AppStoreConnect | undefined {
    const key = (
      this.options.setting()?.teams as Record<string, ConnectKey> | undefined
    )?.[team]
    if (key == null) return undefined
    const bases = this.bases()
    const id = createHash('sha256')
      .update(JSON.stringify([key, bases]))
      .digest('hex')
    const cached = this.clients.get(team)
    if (cached?.key === id) return cached.client
    const client = new AppStoreConnect(key, {
      bases,
      ...(this.options.fetch == null ? {} : { fetch: this.options.fetch }),
      ...(this.options.sleep == null ? {} : { sleep: this.options.sleep }),
      now: this.master.now,
    })
    this.clients.set(team, { key: id, client })
    return client
  }

  /**
   * The identity and profiles a signing stage receives, ensuring each of its
   * bundle IDs has a valid profile for the stage's distribution.
   */
  async signing(project: Project, stage: GraphStage): Promise<StageSigning> {
    const options = stage.apple!
    const appId =
      options.app ??
      (project.apps.filter((app) => app.apple != null).length === 1
        ? project.apps.find((app) => app.apple != null)!.bundleId
        : undefined)
    if (appId == null)
      throw new Error(
        `Stage ${stage.name} must name the app ID it signs (apple.app)`,
      )
    const app = project.apps.find((entry) => entry.bundleId === appId)
    if (app?.apple == null)
      throw new Error(
        `The app ID ${appId} has no Apple team configured on the master`,
      )
    const team = app.apple.team
    const bundleIds = options.bundleIds ?? app.apple.bundleIds
    const unknown = bundleIds.filter((id) => !app.apple!.bundleIds.includes(id))
    if (unknown.length !== 0)
      throw new Error(`${appId} does not sign ${unknown.join(', ')}`)
    const distribution = options.distribution
    const applePlatforms = app.platforms.filter(
      (platform): platform is ApplePlatform =>
        platform === 'ios' || platform === 'macos',
    )
    const platform: ApplePlatform =
      distribution === 'developerId' || distribution === 'macAppStore'
        ? 'macos'
        : applePlatforms.includes('ios')
          ? 'ios'
          : 'macos'
    const profiles = []
    for (const bundleId of bundleIds)
      profiles.push(
        await this.profiles.ensure({
          team,
          bundleId,
          distribution,
          platform,
          platforms: applePlatforms.length === 0 ? [platform] : applePlatforms,
        }),
      )
    const certificate = this.certificates.current(
      team,
      certificateKindFor(distribution),
    )!
    return {
      team,
      distribution,
      platform,
      app: appId,
      bundleIds,
      identity: this.certificates.identity(certificate.id),
      profiles,
    }
  }

  /**
   * When an app ID with an Apple team is added or changed, its bundle IDs
   * missing from the account are created and each distribution's profiles
   * made at once, so problems show on the master rather than at the first
   * build. A missing certificate, a refusal and a missing App Store Connect
   * app record (TestFlight needs one; the API cannot make it) stay among the
   * master's notices until they are resolved.
   */
  async setupApp(app: ProjectApp): Promise<string[]> {
    if (app.apple == null) return []
    const team = app.apple.team
    const problems: string[] = []
    if (this.connect(team) == null)
      problems.push(`Team ${team} has no App Store Connect key`)
    else {
      const platforms = app.platforms.filter(
        (platform): platform is ApplePlatform =>
          platform === 'ios' || platform === 'macos',
      )
      const wanted: Array<[Distribution, ApplePlatform]> = [
        ...(platforms.includes('ios')
          ? ([
              ['development', 'ios'],
              ['adHoc', 'ios'],
              ['appStore', 'ios'],
            ] as Array<[Distribution, ApplePlatform]>)
          : platforms.includes('macos')
            ? ([['development', 'macos']] as Array<
                [Distribution, ApplePlatform]
              >)
            : []),
        ...(platforms.includes('macos')
          ? ([
              ['macAppStore', 'macos'],
              ['developerId', 'macos'],
            ] as Array<[Distribution, ApplePlatform]>)
          : []),
      ]
      for (const [distribution, platform] of wanted) {
        const kind = certificateKindFor(distribution)
        if (this.certificates.current(team, kind) == null) {
          const note = `Team ${team} has no ${kind} certificate, so ${app.bundleId} has no ${distribution} profiles yet`
          if (!problems.includes(note)) problems.push(note)
          continue
        }
        for (const bundleId of app.apple.bundleIds)
          await this.profiles
            .ensure({ team, bundleId, distribution, platform, platforms })
            .catch((error: unknown) => {
              problems.push(
                `The ${distribution} profile of ${bundleId} could not be made: ${(error as Error).message}`,
              )
            })
      }
      if (platforms.includes('ios')) {
        const records = await this.connect(team)!
          .all<{ bundleId: string }>(
            `/v1/apps?filter[bundleId]=${encodeURIComponent(app.bundleId)}`,
          )
          .catch(() => undefined)
        if (
          records != null &&
          !records.some((record) => record.attributes.bundleId === app.bundleId)
        )
          problems.push(
            `App Store Connect has no app record for ${app.bundleId}; create it there before sending builds to TestFlight`,
          )
      }
    }
    const key = `app:${app.bundleId}`
    if (problems.length === 0)
      this.master.db.prepare('DELETE FROM apple_cache WHERE key=?').run(key)
    else
      this.master.db
        .prepare(
          'INSERT INTO apple_cache(key,value,fetched_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,fetched_at=excluded.fetched_at',
        )
        .run(key, JSON.stringify(problems), this.master.now())
    return problems
  }

  /** Whether the app ID's last Apple setup left a problem. */
  incomplete(app: ProjectApp): boolean {
    return (
      this.master.db
        .prepare('SELECT 1 FROM apple_cache WHERE key=?')
        .get(`app:${app.bundleId}`) != null
    )
  }

  /** What needs a person: expiring certificates and app IDs whose Apple setup is incomplete. */
  notices(): string[] {
    return [
      ...this.certificates.expiring(),
      ...this.master.db
        .prepare(
          "SELECT value FROM apple_cache WHERE key LIKE 'app:%' ORDER BY key",
        )
        .all()
        .flatMap((row) => JSON.parse(String(row.value)) as string[]),
    ]
  }
}
