import { asString } from 'cleaners'
import type { Response } from 'express'
import { Accounts, type Session } from '../auth/accounts.js'
import { Devices, type DeviceRelay } from '../devices/store.js'
import { Store, digest } from '../store.js'
import { downloadOnly, text, type Build, type Platform } from '../validation.js'
import {
  installDelivery,
  Installations,
  sendDelivery,
  type FileRequest,
} from './install.js'
import { branchName } from './platform.js'
import type {
  AppData,
  AppsData,
  BranchData,
  CatalogApp,
  CatalogBuild,
  CompleteData,
  DevicesData,
} from './views.js'

/** A refusal the pages answer with its status: 403 for tester access, 404 for an app or device the person may not see. */
export class CatalogRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** What Install answers: a grant to download or install, or what the device needs first. */
export type InstallResult =
  | { kind: 'download' | 'ios'; token: string; expiresAt?: number }
  | { kind: 'register' }
  | { kind: 'prepare'; buildId: number }

export type DeviceAction = 'select' | 'rename' | 'retry' | 'remove'

/**
 * Where Install apps and Devices get their data: the node's own store, or
 * the host over the master's link. Each method answers for one account and
 * checks what that account may see; a device id is checked to be theirs.
 */
export interface CatalogSource {
  apps(accountId: number): Promise<AppsData>
  app(accountId: number, appId: number, platform: Platform): Promise<AppData>
  branch(
    accountId: number,
    appId: number,
    branchKey: string,
    platform: Platform,
    deviceId?: number,
  ): Promise<BranchData>
  install(
    accountId: number,
    buildId: number,
    deviceId?: number,
  ): Promise<InstallResult>
  /** Requests a build for the device; false when the device is not the account's. */
  prepare(
    accountId: number,
    buildId: number,
    deviceId: number,
  ): Promise<boolean>
  /** A grant's manifest or package, streamed into the response. */
  installFile(
    token: string,
    part: 'manifest.plist' | 'artifact',
    request: FileRequest,
    res: Response,
  ): Promise<void>
  devices(accountId: number, deviceId?: number): Promise<DevicesData>
  /** A registration profile; the device returns to `origin` once registered. */
  deviceProfile(accountId: number, origin?: string): Promise<string>
  /** Whether the device is the account's (and the action was taken). */
  deviceAction(
    accountId: number,
    id: number,
    action: DeviceAction,
    name?: string,
  ): Promise<boolean>
  complete(accountId: number, token: string): Promise<CompleteData>
}

/** An account's branches, master first, then the most recently built. */
export function branches(
  builds: Build[],
): Array<{ name: string; time: number }> {
  const map = new Map<string, number>()
  for (const build of builds)
    map.set(
      build.branch,
      Math.max(map.get(build.branch) ?? 0, build.published_at),
    )
  return [...map]
    .map(([name, time]) => ({ name, time }))
    .sort((a, b) =>
      a.name === b.name
        ? 0
        : a.name === 'master'
          ? -1
          : b.name === 'master'
            ? 1
            : b.time - a.time || (a.name < b.name ? -1 : 1),
    )
}

const TESTER_ACCESS = 'Tester access required'

/**
 * The catalog over a distribution store: a standalone server's, or a
 * host's cache. Grants and registration requests hang off `session`.
 */
export class StoreCatalogSource implements CatalogSource {
  readonly installs: Installations
  readonly registry: Devices
  private readonly accounts: Accounts
  constructor(
    readonly store: Store,
    private readonly options: {
      session?: Session
      relay?: DeviceRelay
      /** Whether a branch page mints grants for its iOS rows; not for a master that cannot serve them. */
      grants?: boolean
    } = {},
  ) {
    this.installs = new Installations(store)
    this.registry = new Devices(store, options.relay)
    this.accounts = new Accounts(store)
  }

  private get session(): Session {
    if (this.options.session == null) throw new Error('A session is required')
    return this.options.session
  }

  private tester(accountId: number): void {
    const account = this.accounts.account(accountId)
    if (!account.is_admin && !account.is_tester)
      throw new CatalogRefused(403, TESTER_ACCESS)
  }

  private registrant(accountId: number): void {
    if (!this.registry.allowed(this.accounts.account(accountId)))
      throw new CatalogRefused(403, TESTER_ACCESS)
  }

  private visibleApps(accountId: number): CatalogApp[] {
    return this.store
      .apps()
      .filter((app) => this.store.visible(accountId, app.id))
      .map((app) => ({ id: app.id, name: app.name, slug: app.slug }))
  }

  private platforms(apps: CatalogApp[]): Platform[] {
    if (apps.length === 0) return []
    return this.store.db
      .prepare(
        `SELECT DISTINCT platform FROM channels WHERE enabled=1 AND app_id IN (${apps.map(() => '?').join(',')})`,
      )
      .all(...apps.map((item) => item.id))
      .map((row) => String(row.platform) as Platform)
  }

  private visibleApp(accountId: number, appId: number): CatalogApp {
    this.tester(accountId)
    const app = this.visibleApps(accountId).find((item) => item.id === appId)
    if (app == null) throw new CatalogRefused(404, 'App unavailable')
    return app
  }

  /** A build of an app the account may see; any other build is unknown to them. */
  private visibleBuild(
    accountId: number,
    buildId: number,
  ): NonNullable<ReturnType<Store['build']>> {
    const build = this.store.build(buildId)
    if (build == null) throw new CatalogRefused(404, 'Build unavailable')
    this.visibleApp(accountId, build.app_id)
    return build
  }

  private device(
    accountId: number,
    deviceId: number | undefined,
  ): ReturnType<Devices['list']>[number] | undefined {
    return deviceId == null
      ? undefined
      : this.registry.list(accountId).find((d) => d.id === deviceId)
  }

  async apps(accountId: number): Promise<AppsData> {
    this.tester(accountId)
    const apps = this.visibleApps(accountId)
    return { apps, platforms: this.platforms(apps) }
  }

  async app(accountId: number, appId: number): Promise<AppData> {
    const app = this.visibleApp(accountId, appId)
    const all = this.store.builds(app.id)
    const latest: AppData['latest'] = {}
    for (const build of all)
      latest[build.platform] = Math.max(
        latest[build.platform] ?? 0,
        build.published_at,
      )
    return {
      app,
      platforms: this.platforms([app]),
      branches: branches(all),
      latest,
    }
  }

  async branch(
    accountId: number,
    appId: number,
    branchKey: string,
    platform: Platform,
    deviceId?: number,
  ): Promise<BranchData> {
    const app = this.visibleApp(accountId, appId)
    const branch = branchName(branchKey)
    const device = this.device(accountId, deviceId)
    const builds = this.store
      .builds(app.id, branch)
      .filter((build) => build.platform === platform)
      .map((build): CatalogBuild => {
        const download = downloadOnly(build)
        const eligible = this.registry.eligible(build, device)
        const grant =
          eligible &&
          download == null &&
          build.format === 'ipa' &&
          this.options.grants !== false
            ? this.installs.create(build.id, this.session, device)
            : undefined
        return {
          id: build.id,
          platform: build.platform,
          format: build.format,
          version: build.version,
          buildNumber: build.build_number,
          commit: build.commit_hash,
          publishedAt: build.published_at,
          size: build.size,
          variant: build.variant,
          run: build.run ?? null,
          eligible,
          ...(download == null ? {} : { download }),
          ...(grant == null ? {} : { token: grant.token }),
        }
      })
    return {
      app,
      platforms: this.platforms([app]),
      branch,
      builds,
      device: device != null,
    }
  }

  async install(
    accountId: number,
    buildId: number,
    deviceId?: number,
  ): Promise<InstallResult> {
    const build = this.visibleBuild(accountId, buildId)
    const device = this.device(accountId, deviceId)
    if (!this.registry.eligible(build, device))
      return device == null
        ? { kind: 'register' }
        : { kind: 'prepare', buildId: build.id }
    const grant = this.installs.create(buildId, this.session, device)
    // Only an iOS IPA installs over the air; the rest (a tvOS app too) download.
    return {
      kind:
        grant.build.format !== 'ipa' || downloadOnly(grant.build) != null
          ? 'download'
          : 'ios',
      token: grant.token,
      expiresAt: grant.expiresAt,
    }
  }

  async prepare(
    accountId: number,
    buildId: number,
    deviceId: number,
  ): Promise<boolean> {
    this.registrant(accountId)
    if (this.store.config.devices == null)
      throw new CatalogRefused(403, TESTER_ACCESS)
    this.visibleBuild(accountId, buildId)
    if (this.device(accountId, deviceId) == null) return false
    this.registry.requestBuild(accountId, deviceId, buildId)
    return true
  }

  async installFile(
    token: string,
    part: 'manifest.plist' | 'artifact',
    request: FileRequest,
    res: Response,
  ): Promise<void> {
    await sendDelivery(
      res,
      await installDelivery(this.store, this.installs, token, part, request),
    )
  }

  async devices(accountId: number, deviceId?: number): Promise<DevicesData> {
    this.registrant(accountId)
    const selected = this.device(accountId, deviceId)
    return {
      devices: this.registry.list(accountId),
      ...(selected == null ? {} : { selected: selected.id }),
      registration: this.store.config.devices != null,
      all: this.accounts.account(accountId).is_admin
        ? this.store.db
            .prepare(
              'SELECT a.name,d.model,d.status FROM account_devices a JOIN devices d ON d.id=a.device_id ORDER BY a.created_at DESC LIMIT 500',
            )
            .all()
            .map((r) => ({
              name: asString(r.name),
              model: asString(r.model),
              status: asString(r.status),
            }))
        : [],
    }
  }

  async deviceProfile(accountId: number, origin?: string): Promise<string> {
    this.registrant(accountId)
    if (this.store.config.devices == null)
      throw new CatalogRefused(403, TESTER_ACCESS)
    return this.registry.profile(this.registry.challenge(this.session, origin))
  }

  async deviceAction(
    accountId: number,
    id: number,
    action: DeviceAction,
    name?: string,
  ): Promise<boolean> {
    this.registrant(accountId)
    const device = this.device(accountId, id)
    if (device == null) return false
    if (!['select', 'rename', 'retry', 'remove'].includes(action))
      throw new CatalogRefused(404, 'Unknown action')
    if (action !== 'select')
      this.registry.act(
        accountId,
        device,
        action,
        action === 'rename' ? text(120)(name) : undefined,
      )
    this.accounts.audit(accountId, 'device.' + action, String(device.id))
    return true
  }

  async complete(accountId: number, token: string): Promise<CompleteData> {
    this.registrant(accountId)
    const row = this.store.db
      .prepare(
        'SELECT device_id FROM device_challenges WHERE hash=? AND account_id=? AND expires_at>?',
      )
      .get(digest(token), accountId, this.store.now())
    // On a host the registration went to the master; its device row comes back by UDID.
    const sent = this.registry.registration(token, accountId)
    const own = this.registry.list(accountId)
    const device = row?.device_id
      ? own.find((d) => d.id === row.device_id)
      : sent == null
        ? undefined
        : own.find((d) => d.udid === sent)
    if (device == null)
      return sent != null ? { state: 'registering' } : { state: 'unavailable' }
    return {
      state: 'registered',
      device: { id: device.id, model: device.model },
    }
  }
}

/** A master session as the host's relay session stands for it. */
export interface RelayedSession {
  /** The digest the master keeps the session by; the host keys its relay session by an HMAC of it. */
  id: string
  expiresAt: number
  permissionVersion: number
}

/** How the master reaches its host: a request, and a relayed stream into a response. */
export interface CatalogLink {
  ask(method: string, params: Record<string, unknown>): Promise<unknown>
  relay(
    method: string,
    params: Record<string, unknown>,
    res: Response,
  ): Promise<void>
}

/** A host's answer to a `catalog.*` or `devices.*` request. */
export type CatalogAnswer<T> =
  | { ok: T }
  | { refused: { status: number; message: string } }

/**
 * The catalog on the master: each method a link request to the host,
 * which answers from its cache for the account the master's session
 * authenticated, with that session's relay session holding its grants and
 * registration requests. `origin` is the master's public address, which
 * manifests and registration callbacks name; without it the host mints no
 * grants for the master's pages.
 */
export class LinkCatalogSource implements CatalogSource {
  constructor(
    private readonly link: CatalogLink,
    private readonly session?: RelayedSession,
    private readonly origin?: string,
  ) {}

  private async call<T>(
    method: string,
    accountId: number,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const answer = (await this.link.ask(method, {
      accountId,
      session: this.session,
      ...params,
    })) as CatalogAnswer<T>
    if ('refused' in answer)
      throw new CatalogRefused(answer.refused.status, answer.refused.message)
    return answer.ok
  }

  async apps(accountId: number): Promise<AppsData> {
    return await this.call('catalog.apps', accountId)
  }
  async app(
    accountId: number,
    appId: number,
    platform: Platform,
  ): Promise<AppData> {
    return await this.call('catalog.app', accountId, { appId, platform })
  }
  async branch(
    accountId: number,
    appId: number,
    branchKey: string,
    platform: Platform,
    deviceId?: number,
  ): Promise<BranchData> {
    return await this.call('catalog.branch', accountId, {
      appId,
      branchKey,
      platform,
      deviceId,
      grants: this.origin != null,
    })
  }
  async install(
    accountId: number,
    buildId: number,
    deviceId?: number,
  ): Promise<InstallResult> {
    return await this.call('catalog.install', accountId, { buildId, deviceId })
  }
  async prepare(
    accountId: number,
    buildId: number,
    deviceId: number,
  ): Promise<boolean> {
    return await this.call('catalog.prepare', accountId, { buildId, deviceId })
  }
  async installFile(
    token: string,
    part: 'manifest.plist' | 'artifact',
    request: FileRequest,
    res: Response,
  ): Promise<void> {
    await this.link.relay(
      'catalog.installFile',
      {
        token,
        part,
        method: request.method,
        ...(request.range == null ? {} : { range: request.range }),
        ...(request.ifRange == null ? {} : { ifRange: request.ifRange }),
        ...(this.origin == null ? {} : { origin: this.origin }),
      },
      res,
    )
  }
  async devices(accountId: number, deviceId?: number): Promise<DevicesData> {
    return await this.call('devices.list', accountId, { deviceId })
  }
  async deviceProfile(accountId: number, origin?: string): Promise<string> {
    return await this.call('devices.profile', accountId, {
      origin: origin ?? this.origin,
    })
  }
  async deviceAction(
    accountId: number,
    id: number,
    action: DeviceAction,
    name?: string,
  ): Promise<boolean> {
    return await this.call('devices.action', accountId, { id, action, name })
  }
  async complete(accountId: number, token: string): Promise<CompleteData> {
    return await this.call('devices.complete', accountId, { token })
  }
}
