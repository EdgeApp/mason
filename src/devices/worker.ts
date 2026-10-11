import { asArray, asObject, asOptional, asString } from 'cleaners'
import { execFile } from 'node:child_process'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBuilderConfig } from '../builder/config.js'
import { BuilderStore, hash, exclusiveLock } from '../builder/store.js'
import { remoteHead } from '../builder/automatic.js'
import { privateDirectory, readPrivateJson } from '../config.js'
import { asOrigin, asId, object, text } from '../validation.js'
import { asDevice } from './store.js'

export const asWorkerConfig = object({
  origin: asOrigin,
  tokenFile: text(4096),
  builderConfigFile: text(4096),
  stateDirectory: text(4096),
  bundle: text(4096),
  gemfile: text(4096),
  bundlePath: text(4096),
  ruby: asOptional(text(4096), 'ruby'),
  apple: object({
    teamId: text(80),
    certificateId: text(80),
    loginFile: asOptional(text(4096)),
    apiKeyFile: asOptional(text(4096)),
  }),
})
export type WorkerConfig = ReturnType<typeof asWorkerConfig>
type RemoteDevice = ReturnType<typeof asDevice> & { name: string }
const asRemote = asObject({
  devices: asArray(
    (v: unknown): RemoteDevice => ({
      ...asDevice(v),
      name: asObject({ name: asString })(v).name,
    }),
  ),
  requests: asArray(
    asObject({
      id: asId,
      device_id: asId,
      app: asString,
      branch: asString,
      commit_hash: asString,
    }),
  ),
})
const asProfiles = asObject({
  revision: text(16),
  devices: asArray(asObject({ id: asId, status: asString, message: asString })),
  profiles: asArray(
    asObject({
      app: asString,
      name: asString,
      file: asString,
      sha256: asString,
    }),
  ),
  udids: asArray(asString),
})
type Profiles = ReturnType<typeof asProfiles>
interface Batch {
  revision: string
  ids: number[]
  jobs: Array<{ id: string; app: string; attempt: number }>
  registered: Array<{ id: number; status: string; message: string }>
}
interface State {
  batch?: Batch
  configuredRevision?: string
  retries: Record<string, number>
  errors: Record<string, string>
}
const shell = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"
export class DeviceWorker {
  private active?: Promise<void>
  private closed = false
  private readonly abort = new AbortController()
  private readonly state: State
  private readonly stateFile: string
  private readonly store: BuilderStore
  private readonly lock: ReturnType<typeof exclusiveLock>
  private readonly timer: NodeJS.Timeout
  private readonly token: string
  constructor(
    readonly config: WorkerConfig,
    private readonly provisionOverride?: (
      devices: RemoteDevice[],
      apps: string[],
    ) => Promise<Profiles>,
    interval = 30000,
    private readonly apiOverride?: (
      method: string,
      body?: unknown,
    ) => Promise<unknown>,
    private readonly headOverride = remoteHead,
  ) {
    if (!config.apple.loginFile && !config.apple.apiKeyFile)
      throw new Error('Apple credentials required')
    readPrivateJson(config.apple.apiKeyFile ?? config.apple.loginFile!)
    privateDirectory(config.stateDirectory)
    this.lock = exclusiveLock(path.join(config.stateDirectory, 'worker.sqlite'))
    this.stateFile = path.join(config.stateDirectory, 'state.json')
    this.state = existsSync(this.stateFile)
      ? (readPrivateJson(this.stateFile) as State)
      : { retries: {}, errors: {} }
    this.token = object({ token: text(64) })(
      readPrivateJson(config.tokenFile),
    ).token
    if (!/^[a-f0-9]{64}$/.test(this.token))
      throw new Error('Invalid worker key')
    this.store = new BuilderStore(loadBuilderConfig(config.builderConfigFile))
    this.timer = setInterval(() => {
      void this.poll().catch(() =>
        console.error(
          'Mason device worker could not reach provisioning service',
        ),
      )
    }, interval)
    this.timer.unref()
  }
  private save(): void {
    const tmp = this.stateFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(tmp, this.stateFile)
  }
  private async api(method: string, body?: unknown): Promise<unknown> {
    if (this.apiOverride) return this.apiOverride(method, body)
    const result = await fetch(
      this.config.origin + '/api/device-provisioning',
      {
        method,
        headers: {
          Authorization: 'Bearer ' + this.token,
          'Content-Type': 'application/json',
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(15000),
        ]),
      },
    )
    if (!result.ok) throw new Error('Provisioning service unavailable')
    const bytes = await result.text()
    if (bytes.length > 1024 * 1024)
      throw new Error('Provisioning reply too large')
    return JSON.parse(bytes) as unknown
  }
  poll(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return (this.active ??= this.run().finally(() => {
      this.active = undefined
    }))
  }
  bootstrap(): Promise<void> {
    return (this.active ??= this.bootstrapProfiles().finally(() => {
      this.active = undefined
    }))
  }
  private async bootstrapProfiles(): Promise<void> {
    const profiles = await this.provision(
      [],
      this.store
        .apps()
        .filter((a) => a.enabled && a.platforms.includes('ios'))
        .map((a) => a.slug),
    )
    this.configure(profiles)
    console.log(
      JSON.stringify({
        profiles: profiles.profiles.length,
        devices: profiles.udids.length,
        configured: true,
      }),
    )
  }
  private async provision(
    devices: RemoteDevice[],
    apps: string[],
  ): Promise<Profiles> {
    if (this.provisionOverride) return this.provisionOverride(devices, apps)
    const request = path.join(this.config.stateDirectory, 'apple-request.json')
    writeFileSync(
      request,
      JSON.stringify({
        apple: this.config.apple,
        devices: devices.map((d) => ({ id: d.id, udid: d.udid, name: d.name })),
        apps,
        directory: this.config.stateDirectory,
      }),
      { mode: 0o600 },
    )
    try {
      const stdout = await new Promise<string>((resolve, reject) =>
        execFile(
          this.config.bundle,
          [
            'exec',
            'ruby',
            fileURLToPath(
              new URL('../../src/devices/apple-provision.rb', import.meta.url),
            ),
            request,
          ],
          {
            cwd: this.config.stateDirectory,
            env: {
              ...process.env,
              CI: '1',
              BUNDLE_GEMFILE: this.config.gemfile,
              BUNDLE_PATH: this.config.bundlePath,
              BUNDLE_FROZEN: 'true',
            },
            timeout: 180000,
            maxBuffer: 1024 * 1024,
            signal: this.abort.signal,
          },
          (error, stdout) =>
            error
              ? reject(
                  new Error(
                    'Apple provisioning failed; credentials, device limits or Apple availability need attention',
                  ),
                )
              : resolve(stdout),
        ),
      )
      return asProfiles(JSON.parse(stdout))
    } finally {
      // The request contains device IDs; keep it private and overwrite on the next operation.
    }
  }
  private configure(profiles: Profiles): void {
    const directory = path.join(this.config.stateDirectory, profiles.revision)
    privateDirectory(directory)
    const manifest = path.join(directory, 'manifest.json')
    writeFileSync(manifest, JSON.stringify(profiles), { mode: 0o600 })
    for (const app of this.store
      .apps()
      .filter((a) => a.enabled && a.platforms.includes('ios'))) {
      const file = app.files.find((f) => f.env === 'DEPLOY_CONFIG_FILE')
      if (!file) throw new Error('App deployment settings unavailable')
      const deployment = JSON.parse(
        Buffer.from(file.contents, 'base64').toString(),
      ) as {
        branches: Record<
          string,
          {
            settings: {
              tools?: Record<string, string>
              apps?: Record<
                string,
                {
                  ios?: {
                    apple?: {
                      teamId?: string
                      profileNames?: Record<string, string>
                      requiredDevices?: string[]
                    }
                  }
                }
              >
            }
          }
        >
      }
      const settings = deployment.branches.master?.settings
      if (!settings?.tools || !settings.apps)
        throw new Error('Master deployment settings required')
      const apple = settings.apps[app.slug]?.ios?.apple
      const profile = profiles.profiles.find((p) => p.app === app.slug)
      if (!apple || !profile || apple.teamId !== this.config.apple.teamId)
        throw new Error('Signing team or app profile mismatch')
      const wrapper = path.join(directory, 'bundle')
      const program = fileURLToPath(
        new URL('../../src/devices/bundle-profiles.rb', import.meta.url),
      )
      writeFileSync(
        wrapper,
        `#!/bin/sh\nexec ${shell(this.config.ruby)} ${shell(program)} ${shell(this.config.bundle)} ${shell(manifest)} "$@"\n`,
        { mode: 0o700 },
      )
      settings.tools.bundle = wrapper
      apple.profileNames ??= {}
      apple.profileNames[app.slug] = profile.name
      apple.requiredDevices = [
        ...new Set([...(apple.requiredDevices ?? []), ...profiles.udids]),
      ]
      for (const branch of Object.values(deployment.branches)) {
        if (branch.settings.tools?.bundle != null)
          branch.settings.tools.bundle = wrapper
        const override = branch.settings.apps?.[app.slug]?.ios?.apple
        if (override?.profileNames?.[app.slug] != null)
          override.profileNames[app.slug] = profile.name
        if (override?.requiredDevices != null)
          override.requiredDevices = [
            ...new Set([...override.requiredDevices, ...profiles.udids]),
          ]
      }
      file.contents = Buffer.from(JSON.stringify(deployment)).toString('base64')
      this.store.importApp(app)
    }
    this.state.configuredRevision = profiles.revision
    this.save()
  }
  private async enqueue(
    app: string,
    branch: string,
    revision: string,
    attempt: number,
    commit?: string,
  ): Promise<string> {
    const def = this.store.apps().find((a) => a.slug === app)
    if (!def) throw new Error('App unavailable')
    const sha =
      commit ??
      (await this.headOverride(def.repository, branch, this.abort.signal))
    return this.store.enqueuePinned(
      {
        app,
        branch,
        platforms: ['ios'],
        idempotencyKey:
          'device-' + hash([revision, app, branch, sha, attempt].join(':')),
      },
      'device-worker',
      sha,
    ).id
  }
  private async run(): Promise<void> {
    const remote = asRemote(await this.api('GET'))
    const batch = this.state.batch
    if (batch) {
      let failed = false,
        pending = false
      for (const item of batch.jobs) {
        const job = this.store.job(item.id)
        if (job?.status === 'queued' || job?.status === 'running') {
          pending = true
          continue
        }
        if (job?.status !== 'succeeded') {
          if (item.attempt < 3) {
            item.attempt++
            item.id = await this.enqueue(
              item.app,
              job?.branch ?? this.store.buildSettings(item.app).defaultBranch,
              batch.revision,
              item.attempt,
              job?.requested_commit,
            )
            pending = true
            this.save()
          } else failed = true
        }
      }
      if (!pending) {
        await this.api('POST', {
          devices: batch.registered.map((d) => ({
            ...d,
            message:
              d.status === 'processing'
                ? d.message
                : failed
                  ? 'Some compatible builds failed. Browse apps to prepare a build again.'
                  : 'Compatible builds are ready. Choose an app to install.',
          })),
          requests: [],
        })
        this.state.batch = undefined
        this.save()
      }
    }
    const todo = remote.devices.filter(
      (d) => d.status === 'pending' || d.status === 'processing',
    )
    if (todo.length > 0 && !this.state.batch) {
      const signature = hash(todo.map((d) => [d.id, d.updated_at]).join(':'))
      if ((this.state.retries[signature] ?? 0) >= 3) {
        await this.api('POST', {
          devices: todo.map((d) => ({
            id: d.id,
            status: 'error',
            message:
              this.state.errors[signature] ??
              'Apple provisioning needs attention. Retry preparation after checking the builder.',
          })),
          requests: [],
        })
        return
      }
      try {
        const apps = this.store
          .apps()
          .filter((a) => a.enabled && a.platforms.includes('ios'))
          .map((a) => a.slug)
        const profiles = await this.provision(todo, apps)
        this.configure(profiles)
        const jobs = []
        for (const app of apps)
          jobs.push({
            id: await this.enqueue(
              app,
              this.store.buildSettings(app).defaultBranch,
              profiles.revision,
              1,
            ),
            app,
            attempt: 1,
          })
        this.state.batch = {
          revision: profiles.revision,
          ids: todo.map((d) => d.id),
          jobs,
          registered: profiles.devices,
        }
        this.save()
        await this.api('POST', { devices: profiles.devices, requests: [] })
      } catch {
        this.state.retries[signature] = (this.state.retries[signature] ?? 0) + 1
        this.state.errors[signature] =
          'Apple provisioning could not complete. Check the Apple session, device allowance and builder status.'
        this.save()
        if (this.state.retries[signature] >= 3)
          await this.api('POST', {
            devices: todo.map((d) => ({
              id: d.id,
              status: 'error',
              message: this.state.errors[signature]!,
            })),
            requests: [],
          })
      }
    }
    const requests = []
    for (const r of remote.requests) {
      const device = remote.devices.find((d) => d.id === r.device_id)
      if (device?.status !== 'registered' || !this.state.configuredRevision)
        continue
      try {
        const id = await this.enqueue(
          r.app,
          r.branch,
          this.state.configuredRevision + '-request-' + r.id,
          1,
          r.commit_hash,
        )
        requests.push({
          id: r.id,
          status: 'queued',
          message: 'Compatible build queued: ' + id,
        })
      } catch {
        requests.push({
          id: r.id,
          status: 'error',
          message: 'Build could not be queued. Try again shortly.',
        })
      }
    }
    if (requests.length) await this.api('POST', { devices: [], requests })
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    this.abort.abort()
    await this.active?.catch(() => {})
    this.store.close()
    this.lock.close()
  }
}
export async function runDeviceWorker(file: string): Promise<void> {
  process.umask(0o077)
  const worker = new DeviceWorker(asWorkerConfig(readPrivateJson(file)))
  const stop = (): void => {
    void worker
      .close()
      .then(() => process.exit())
      .catch(() => {
        process.exitCode = 1
      })
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  // Keep the daemon alive even when the first poll has no pending devices.
  const keepalive = setInterval(() => {}, 3600000)
  try {
    await worker.poll()
  } catch {
    console.error('Mason device worker is waiting for provisioning service')
  }
  process.once('exit', () => clearInterval(keepalive))
}
