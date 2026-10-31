import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import ssh2 from 'ssh2'
import type { DatabaseSync } from 'node:sqlite'
import type { ControlHandler } from '../node/control.js'
import type { Identity } from '../node/identity.js'
import type { MethodTable, Stream } from '../link/link.js'
import { createFirstAdmin } from '../setup/setup.js'
import { MasterDatabase } from './database.js'
import { MasterKeys } from './keys.js'
import { MasterAuth } from './auth.js'
import { Forwarder } from './forward.js'
import { People } from './people.js'
import { Provisioning } from './provisioning.js'
import type { StageSigning } from '../pipeline/assignment.js'
import { appleArea, AppleService } from '../apple/service.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { backupArea, Backups, type BackupSetting } from './backup.js'
import { NodeRegistry } from './nodes.js'
import { allow } from './permissions.js'
import { localOperator, type Actor } from './roles.js'
import { clearSetting, Settings, type SettingValue } from './settings.js'
import { BuildNumbers } from './buildNumbers.js'
import { GitHub, storedConnection, type GitHubOptions } from './github.js'
import { Jobs } from './jobs.js'
import { gitHeadLister, Poller, type HeadLister } from './poller.js'
import { Projects, type ProjectApp } from './projects.js'
import { clusterCheck } from './clusterCheck.js'
import { integer } from '../validation.js'
import path from 'node:path'
import { githubLfs, Mirrors, type RemoteResolver } from './mirrors.js'
import { Retention } from './retention.js'
import { Scheduler } from './scheduler.js'
import { Stashes } from './stash.js'
import { Releases } from './releases.js'
import { Updates } from './updates.js'
import { runningInstall } from '../release/install.js'
import { repository, version } from '../version.js'
import {
  AppleDownloads,
  appleEndpoints,
  type AppleEndpoints,
  type AppleStatus,
  type AppleXcode,
} from './apple/developerDownloads.js'
import type { ChecklistItem } from '../worker/system/reconcile.js'
import {
  masterChecklist,
  NodeStates,
  type NodeType,
  nodeTypesSetting,
  storedNodeType,
} from './nodeTypes.js'
import { RuntimeStore } from './runtimes.js'
import {
  cloudArea,
  Pools,
  type CloudSetting,
  type PoolAnswer,
  type PoolsOptions,
} from './cloud/pools.js'
import {
  cloudAccountsArea,
  CloudAccounts,
  type CloudAccount,
  type CloudAccountsOptions,
} from './cloud/accounts.js'
import { HostDns } from './cloud/dns.js'
import { HostSpace, type SpaceStorage } from './cloud/hostSpace.js'
import { CloudHosts, type CloudHostsOptions } from './cloud/hosts.js'
import { hostView } from './cloudHostsApi.js'
import {
  AppleSetup,
  AppStoreConnectWeb,
  type AppleWeb,
} from './apple/accountSetup.js'
import type { CertificateView } from '../apple/certificates.js'
import { Changes } from './changes.js'
import { HostLinks } from './hosts.js'
import {
  hostArea,
  hostProjection,
  signInArea,
  storageArea,
} from './hostSettings.js'
import { Artifacts } from './artifacts.js'
import type { Graph } from '../pipeline/graph.js'
import { Secrets } from './secrets.js'

const sshUtils = ssh2.utils

export { nodeTypesSetting }

export interface MasterOptions {
  methods?: (role: 'worker' | 'host') => MethodTable
  heartbeatMs?: number
  redialBaseMs?: number
  /** Called once the first admin exists. */
  onConfigured?(): void
  github?: GitHubOptions
  /** Branch heads for the poller; `git ls-remote` with the GitHub connection otherwise. */
  headLister?: HeadLister
  /** Scratch space for git credentials and temporary files. */
  scratch?: string
  /** The data directory: mirrors, stashes and logs live under it. */
  dir?: string
  /** Push attempts before a backup fails. */
  backupAttempts?: number
  /** Where the master's own messages go; the console by default. */
  log?: (line: string) => void
  /** How mirrors reach a repository; the GitHub connection otherwise. */
  remote?: RemoteResolver
  /** The scheduler's pass interval. */
  tickMs?: number
  /** The time zone schedules are evaluated in; the system's otherwise. */
  timeZone?: string
  /** How long past a stage's timeout the master waits for a silent worker. */
  graceMs?: number
  /** Per-job stash limit (2 GiB). */
  stashLimit?: number
  /** The master's clock. */
  now?: () => number
  /** Apple's sign-in and download hosts; a fake Apple in tests. */
  appleEndpoints?: AppleEndpoints
  /** Whether the master runs with `--test-endpoints`: only then may Apple base URLs be set. */
  testEndpoints?: boolean
  /** How the master reaches Apple's API; a fake in tests. */
  appleFetch?: typeof fetch
  /** Waits between Apple API retries; instant in tests. */
  appleSleep?: (ms: number) => Promise<void>
  /** Cloud pool internals for tests: the provider, the master's address, timings. */
  cloud?: Pick<
    PoolsOptions,
    | 'provider'
    | 'publicAddress'
    | 'tickMs'
    | 'pairTimeoutMs'
    | 'linkPort'
    | 'log'
    | 'github'
    | 'releaseAssets'
    | 'nomac'
  >
  /** Cloud host internals for tests: the provider, the master's address, timings. */
  cloudHosts?: Pick<
    CloudHostsOptions,
    | 'provider'
    | 'publicAddress'
    | 'tickMs'
    | 'settleMs'
    | 'linkPort'
    | 'log'
    | 'trusted'
    | 'version'
    | 'updateTimeoutMs'
  >
  /** How the master reaches DigitalOcean Spaces: a fake S3 endpoint in tests. */
  spaces?: {
    endpoint?: (region: string) => string
    fetch?: typeof fetch
    wait?: (ms: number) => Promise<void>
  }
  /** How the master checks cloud accounts: a fake provider API in tests. */
  cloudAccounts?: Pick<
    CloudAccountsOptions,
    'fetch' | 'endpoints' | 'timeoutMs'
  >
}

/**
 * The master's SSH key for NoMac Macs, made once and kept in its database,
 * so a restored master reaches the same Macs' gateway as before.
 */
function nomacKey(database: MasterDatabase): {
  privateKey: string
  publicKey: string
} {
  const row = database.db
    .prepare("SELECT value FROM meta WHERE key='nomac_ssh_key'")
    .get() as { value: string } | undefined
  if (row != null)
    return JSON.parse(row.value) as { privateKey: string; publicKey: string }
  const pair = sshUtils.generateKeyPairSync('ed25519', {
    comment: 'mason-master',
  })
  const key = { privateKey: pair.private, publicKey: pair.public }
  database.db
    .prepare("INSERT INTO meta(key,value) VALUES('nomac_ssh_key',?)")
    .run(JSON.stringify(key))
  return key
}

/** Merges two method tables; the first wins on a clash. */
function mergeMethods(a: MethodTable, b: MethodTable): MethodTable {
  return {
    requests: { ...b.requests, ...a.requests },
    events: { ...b.events, ...a.events },
    streams: { ...b.streams, ...a.streams },
  }
}

/** The master role's parts, shared by its web listener and control socket. */
export class Master {
  readonly database: MasterDatabase
  readonly keys: MasterKeys
  /** Master sign-in and sessions. */
  readonly auth: MasterAuth
  /** People, their roles and addresses, and the groups testers see. */
  readonly people: People
  /** The API socket for requests the host forwards. */
  readonly forwarder = new Forwarder()
  readonly settings: Settings
  readonly registry: NodeRegistry
  readonly projects: Projects
  readonly jobs: Jobs
  readonly buildNumbers: BuildNumbers
  readonly github: GitHub
  readonly poller: Poller
  readonly mirrors: Mirrors
  readonly stashes: Stashes
  readonly scheduler: Scheduler
  readonly retention: Retention
  readonly releases: Releases
  readonly updates: Updates
  readonly apple: AppleDownloads
  /** Signing, profiles, TestFlight and notarization through App Store Connect. */
  readonly appleSigning: AppleService
  /** Devices and prepare requests from the host, provisioned with Apple. */
  readonly provisioning: Provisioning
  readonly runtimes: RuntimeStore
  readonly nodeStates: NodeStates
  readonly changes: Changes
  readonly hosts: HostLinks
  readonly pools: Pools
  readonly cloudAccounts: CloudAccounts
  readonly cloudHosts: CloudHosts
  /** Makes DigitalOcean Spaces and their keys, for hosts and for storage. */
  readonly hostSpace: HostSpace
  /** This master's short id, in the names of its cloud resources. */
  readonly masterId: string
  readonly appleSetup: AppleSetup
  readonly artifacts: Artifacts
  readonly backups: Backups
  /** Project secrets: variants, their audit, and changes gated on a pushed backup. */
  readonly secrets: Secrets
  private expiry: NodeJS.Timeout | undefined
  private backupTimer: NodeJS.Timeout | undefined
  private stopped = false
  private readonly appleSetups = new Set<Promise<void>>()
  /** The latest Apple setup of each app ID, which the next one follows. */
  private readonly appleQueue = new Map<string, Promise<void>>()
  private compaction: NodeJS.Timeout | undefined
  constructor(
    db: DatabaseSync,
    readonly identity: Identity,
    private readonly options: MasterOptions = {},
  ) {
    this.database = new MasterDatabase(db, options.now)
    this.keys = new MasterKeys(this.database)
    this.auth = new MasterAuth(this.database)
    this.people = new People(this.database)
    this.settings = new Settings(this.database)
    this.registry = new NodeRegistry(db, identity, {
      // A NoMac Mac is reached through NoMac's SSH gateway.
      transport: (host, port): (() => Promise<Duplex>) | undefined =>
        host.startsWith('nomac:')
          ? async (): Promise<Duplex> => await this.pools.tunnel(host, port)
          : undefined,
      methods: (role): MethodTable =>
        mergeMethods(
          role === 'worker'
            ? mergeMethods(this.scheduler.methods(), this.nodeStates.methods())
            : this.hosts.methods(),
          options.methods?.(role) ?? {},
        ),
      ...(options.heartbeatMs == null
        ? {}
        : { heartbeatMs: options.heartbeatMs }),
      ...(options.redialBaseMs == null
        ? {}
        : { redialBaseMs: options.redialBaseMs }),
    })
    this.projects = new Projects(this.database)
    this.jobs = new Jobs(this.database, this.projects)
    this.buildNumbers = new BuildNumbers(this.database, () =>
      Number(this.settings.value('buildNumbers')?.countBase ?? 0),
    )
    this.github = new GitHub(
      () => storedConnection(this.settings.value('github')),
      options.github,
      this.database.now,
    )
    this.settings.register('github', this.github.area())
    this.settings.register('buildNumbers', {
      validate: (input) => ({
        countBase: integer(
          0,
          9999,
        )((input as { countBase?: unknown } | null)?.countBase ?? 0),
      }),
    })
    this.poller = new Poller(
      this.database,
      this.projects,
      this.jobs,
      options.headLister ??
        gitHeadLister(this.github, options.scratch ?? '/tmp'),
    )
    const dir = options.dir ?? options.scratch ?? '/tmp'
    this.mirrors = new Mirrors(
      path.join(dir, 'mirrors'),
      options.remote ??
        (async (
          repository,
        ): Promise<{
          url: string
          env: NodeJS.ProcessEnv
          lfs?: ReturnType<typeof githubLfs>
        }> => {
          const access = await this.github.gitAccess(
            repository,
            options.scratch ?? '/tmp',
          )
          const lfs = githubLfs(access)
          return { ...access, ...(lfs == null ? {} : { lfs }) }
        }),
    )
    this.stashes = new Stashes(
      this.database,
      path.join(dir, 'stashes'),
      options.stashLimit,
    )
    this.apple = new AppleDownloads(this.database, {
      keyFile: path.join(dir, 'apple.key'),
      ...(options.appleEndpoints == null
        ? {}
        : { endpoints: options.appleEndpoints }),
    })
    this.appleSigning = new AppleService(this.database, {
      setting: (): SettingValue | undefined => this.settings.value('apple'),
      testEndpoints: options.testEndpoints === true,
      scratch: options.scratch ?? path.join(dir, 'scratch'),
      ...(options.appleFetch == null ? {} : { fetch: options.appleFetch }),
      ...(options.appleSleep == null ? {} : { sleep: options.appleSleep }),
      clone: async (repository, branch, into): Promise<void> => {
        const access = /github\.com/.test(repository)
          ? await this.github
              .gitAccess(repository, options.scratch ?? '/tmp')
              .catch(() => ({ url: repository, env: process.env }))
          : { url: repository, env: process.env }
        await promisify(execFile)(
          'git',
          [
            'clone',
            '-q',
            '--depth',
            '1',
            '--branch',
            branch,
            '--',
            access.url,
            into,
          ],
          { env: access.env },
        )
      },
    })
    // An app ID with an Apple team gets its bundle IDs and profiles when it is added or changed.
    this.database.listeners.add((entity, key) => {
      if (entity === 'app') this.setupApple((app) => String(app.id) === key)
    })
    this.runtimes = new RuntimeStore(path.join(dir, 'runtimes'))
    this.artifacts = new Artifacts({
      master: this.database,
      privateKey: identity.privateKey,
      host: (): ReturnType<HostLinks['access']> => this.hosts.access(),
      retentionDays: (): number => 14,
    })
    this.scheduler = new Scheduler({
      artifacts: this.artifacts,
      // The host links are made below; a relay asks for them when it runs.
      toHost: (method, params): Stream =>
        this.hosts.openHostStream(method, params),
      apple: {
        signing: async (project, stage): Promise<StageSigning> =>
          await this.appleSigning.signing(project, stage),
        service: this.appleSigning,
      },
      master: this.database,
      projects: this.projects,
      jobs: this.jobs,
      buildNumbers: this.buildNumbers,
      registry: this.registry,
      mirrors: this.mirrors,
      stashes: this.stashes,
      logs: path.join(dir, 'logs'),
      ...(options.tickMs == null ? {} : { tickMs: options.tickMs }),
      ...(options.timeZone == null ? {} : { timeZone: options.timeZone }),
      ...(options.graceMs == null ? {} : { graceMs: options.graceMs }),
      androidLicencesAccepted: (type): boolean =>
        (
          this.settings.value('nodeTypes')?.[type] as
            | { androidLicensesAccepted?: unknown }
            | undefined
        )?.androidLicensesAccepted != null,
      nodeType: (name): NodeType | undefined =>
        storedNodeType(this.settings.value('nodeTypes')?.[name]),
      appleXcodes: (): AppleXcode[] => this.apple.cachedXcodes(),
      masterChecklist: (): ChecklistItem[] =>
        masterChecklist(this.apple.status(), this.nodeStates.wantsXcode()),
      cloud: {
        demand: (type): PoolAnswer | undefined => this.pools.demand(type),
        makesMacs: (type): boolean | undefined => this.pools.makesMacs(type),
        draining: (fingerprint): boolean => this.pools.draining(fingerprint),
        setupDemand: (): string | undefined => this.pools.setupDemand(),
      },
    })
    this.nodeStates = new NodeStates({
      registry: this.registry,
      settings: this.settings,
      apple: this.apple,
      runtimes: this.runtimes,
      storeInventory: (fingerprint, inventory): void => {
        this.scheduler.storeInventory(fingerprint, inventory)
        this.scheduler.poke()
      },
      requested: (fingerprint, tool, name): boolean =>
        this.scheduler.requested(fingerprint, tool, name),
      mirror: {
        authorize: (version): ReturnType<HostLinks['mirrorAuthorization']> =>
          this.hosts.mirrorAuthorization(version),
        relay: async (params, stream): Promise<void> => {
          await this.hosts.mirror(params, stream)
        },
      },
      now: this.database.now,
    })
    this.retention = new Retention(this.database, this.scheduler, this.stashes)
    this.settings.register('nodeTypes', {
      validate: nodeTypesSetting,
      changed: () => {
        this.nodeStates.reconcileAll()
      },
    })
    this.settings.register('apple', {
      ...appleArea(options.testEndpoints === true),
      changed: (): void => {
        // A new App Store Connect key checks again the app IDs whose setup was incomplete.
        this.setupApple((app) => this.appleSigning.incomplete(app))
      },
    })
    this.settings.register('host', hostArea)
    this.cloudAccounts = new CloudAccounts({
      settings: this.settings,
      now: this.database.now,
      ...options.cloudAccounts,
    })
    this.settings.register(
      'cloudAccounts',
      cloudAccountsArea((id) => [
        ...this.pools
          .pools()
          .filter((pool) => pool.account === id)
          .map((pool) => `pool ${pool.name}`),
        ...this.cloudHosts.usedBy(id),
      ]),
    )
    this.settings.register(
      'cloud',
      cloudArea(() => this.cloudAccounts.all()),
    )
    this.settings.register('storage', storageArea)
    this.settings.register('signIn', signInArea)
    this.backups = new Backups({
      master: this.database,
      dir,
      scratch: options.scratch ?? path.join(dir, 'scratch'),
      setting: (): BackupSetting | undefined =>
        this.settings.value('backup') as BackupSetting | undefined,
      fingerprint: identity.fingerprint,
      github: async (
        repository,
      ): Promise<{
        url: string
        env: NodeJS.ProcessEnv
      }> => await this.github.gitAccess(repository, options.scratch ?? '/tmp'),
      hasGitHub: (): boolean =>
        storedConnection(this.settings.value('github')) != null,
      ...(options.backupAttempts == null
        ? {}
        : { attempts: options.backupAttempts }),
    })
    this.secrets = new Secrets(this.database, this.backups)
    this.settings.register('backup', {
      ...backupArea,
      changed: (): void => {
        // The key is made when backups are first configured.
        this.backups.key()
      },
    })
    this.releases = new Releases(
      this.database,
      path.join(dir, 'releases'),
      identity,
      version,
    )
    this.changes = new Changes(this.database, hostProjection)
    this.hosts = new HostLinks({
      master: this.database,
      registry: this.registry,
      changes: this.changes,
      projects: this.projects,
      jobs: this.jobs,
      artifacts: this.artifacts,
      privateKey: identity.privateKey,
      onDevices: (): void => {
        if (!this.stopped) void this.provisioning.poke()
      },
      forward: async (params, stream): Promise<void> => {
        await this.forwarder.forward(params, stream)
      },
      password: {
        parameters: (username): unknown => this.auth.parameters(username),
        verify: async (value, address): Promise<number> =>
          await this.auth.verify(value, address),
      },
      origins: (): { origin?: string; workerOrigin?: string } =>
        (this.settings.value('host') ?? {}) as {
          origin?: string
          workerOrigin?: string
        },
    })
    this.provisioning = new Provisioning({
      master: this.database,
      apple: this.appleSigning,
      projects: this.projects,
      jobs: this.jobs,
      scheduler: this.scheduler,
      log: (line): void => (this.options.log ?? console.log)(line),
    })
    // Names this master's cloud resources, so a shared provider account's
    // other masters are left alone; a restored master keeps it.
    const masterId = createHash('sha256')
      .update(identity.fingerprint)
      .digest('hex')
      .slice(0, 10)
    this.masterId = masterId
    this.pools = new Pools({
      master: this.database,
      masterId,
      registry: this.registry,
      setting: (): CloudSetting | undefined =>
        this.settings.value('cloud') as CloudSetting | undefined,
      accountKey: (account): string | undefined =>
        this.cloudAccounts.get(account)?.key,
      accountProvider: (account): 'digitalocean' | 'nomac' | undefined =>
        this.cloudAccounts.get(account)?.provider,
      busy: (fingerprint): boolean => this.scheduler.busy(fingerprint),
      github: (): { repository: string; version: string } | undefined =>
        repository == null ? undefined : { repository, version },
      publicAddress: async (): Promise<string | undefined> => {
        const response = await fetch('https://api.ipify.org', {
          signal: AbortSignal.timeout(10_000),
        })
        return response.ok ? (await response.text()).trim() : undefined
      },
      log: (line): void => console.log(line),
      ...options.cloud,
      // A test's NoMac API and gateway, always with the master's own SSH key.
      nomac: {
        ...options.cloud?.nomac,
        sshKey: (): { privateKey: string; publicKey: string } =>
          nomacKey(this.database),
      },
    })
    this.appleSetup = new AppleSetup({
      web: (): AppleWeb | undefined =>
        this.apple.ready()
          ? new AppStoreConnectWeb(
              async (url, init) => await this.apple.webRequest(url, init),
              (options.appleEndpoints ?? appleEndpoints).olympus,
              (options.appleEndpoints ?? appleEndpoints).developer,
            )
          : undefined,
      teamKey: (team): { keyId: string } | undefined =>
        (
          this.settings.value('apple') as
            | { teams?: Record<string, { keyId: string }> }
            | undefined
        )?.teams?.[team],
      saveTeamKey: async (team, key): Promise<void> => {
        const stored = (this.settings.value('apple') ?? {}) as {
          teams?: Record<string, unknown>
        }
        await this.settings.set(localOperator, 'apple', {
          teams: { ...stored.teams, [team]: key },
        })
      },
      certificate: (team, kind): CertificateView | undefined =>
        this.appleSigning.certificates.current(team, kind),
      createCertificate: async (team, kind): Promise<CertificateView> =>
        await this.appleSigning.certificates.create(team, kind),
      appleCertificates: async (team): Promise<string[]> => {
        const connect = this.appleSigning.connect(team)
        if (connect == null) return []
        return (
          await connect.all(
            '/v1/certificates?filter[certificateType]=DISTRIBUTION&limit=200',
          )
        ).map((item) => {
          const attributes = (
            item as { attributes?: { name?: string; expirationDate?: string } }
          ).attributes
          return `${attributes?.name ?? item.id}${attributes?.expirationDate == null ? '' : ` (expires ${attributes.expirationDate.slice(0, 10)})`}`
        })
      },
      fingerprint: identity.fingerprint,
    })
    this.cloudHosts = new CloudHosts({
      master: this.database,
      masterId,
      registry: this.registry,
      account: (id): CloudAccount | undefined => this.cloudAccounts.get(id),
      github: (): { repository: string; version: string } | undefined =>
        repository == null ? undefined : { repository, version },
      hostSettings: {
        get: (): { origin?: string } | undefined =>
          this.settings.value('host') as { origin?: string } | undefined,
        set: async (origin): Promise<void> => {
          if (origin == null) clearSetting(this.settings, localOperator, 'host')
          else
            await this.settings.set(localOperator, 'host', {
              ...(this.settings.value('host') ?? {}),
              origin,
            })
        },
      },
      publicAddress: async (): Promise<string | undefined> => {
        const response = await fetch('https://api.ipify.org', {
          signal: AbortSignal.timeout(10_000),
        })
        return response.ok ? (await response.text()).trim() : undefined
      },
      dns: new HostDns(this.database),
      space: (this.hostSpace = new HostSpace({
        master: this.database,
        storage: {
          get: (): SpaceStorage | undefined => {
            const value = this.settings.value('storage') as
              | { driver?: string; s3?: SpaceStorage }
              | undefined
            return value?.driver === 's3' ? value.s3 : undefined
          },
          set: async (s3): Promise<void> => {
            await this.settings.set(localOperator, 'storage', {
              driver: 's3',
              s3,
            })
          },
          clear: async (): Promise<void> => {
            await this.settings.set(localOperator, 'storage', {
              driver: 'disk',
            })
          },
        },
        ...(options.spaces?.endpoint == null
          ? {}
          : { endpoint: options.spaces.endpoint }),
        ...(options.spaces?.fetch == null
          ? {}
          : { fetch: options.spaces.fetch }),
        ...(options.spaces?.wait == null ? {} : { wait: options.spaces.wait }),
      })),
      log: (line): void => console.log(line),
      ...options.cloudHosts,
    })
    this.updates = new Updates(
      this.registry,
      this.releases,
      (fingerprint) => this.scheduler.inventoryOf(fingerprint),
      (fingerprint) => this.scheduler.busy(fingerprint),
    )
    this.registry.on('retyped', (fingerprint: string) => {
      this.nodeStates.reconcile(fingerprint)
    })
    // A worker that reconnects may be behind the current release.
    this.registry.on('connected', (fingerprint: string) => {
      setTimeout(() => {
        if (!this.stopped) void this.updates.tick()
      }, 2000).unref()
      // Once the scheduler has its inventory, the node reconciles its type's software.
      setTimeout(() => {
        if (!this.stopped) this.nodeStates.reconcile(fingerprint)
      }, 1000).unref()
    })
  }

  /** Starts dialing nodes and polling repositories. */
  start(pollMs?: number): void {
    this.registry.start()
    this.poller.start(pollMs)
    // A new or changed project is polled at once rather than at the next interval.
    let pending: NodeJS.Timeout | undefined
    this.database.listeners.add((entity) => {
      if (entity !== 'project' || pending != null) return
      pending = setTimeout(() => {
        pending = undefined
        void this.poller.poll()
      }, 200)
      pending.unref()
    })
    this.scheduler.start()
    this.retention.start()
    this.updates.start()
    this.hosts.start()
    this.pools.start()
    this.cloudHosts.start()
    // Expired builds and saved artifacts become deleting; the host removes the files.
    this.expiry = setInterval(
      () => {
        if (!this.stopped) this.expire()
      },
      60 * 60 * 1000,
    )
    this.expiry.unref()
    // The change log keeps seven days; a host further behind gets a snapshot.
    this.compaction = setInterval(
      () => {
        if (!this.stopped) this.changes.compact()
      },
      60 * 60 * 1000,
    )
    this.compaction.unref()
    // Hourly backups once configured; a weekly reminder until they work.
    this.backupTimer = setInterval(
      () => {
        if (!this.stopped) void this.backupTick()
      },
      60 * 60 * 1000,
    )
    this.backupTimer.unref()
    this.provisioning.start()
    this.apple.start()
    for (const warning of this.appleSigning.startupWarnings())
      (this.options.log ?? console.log)(warning)
    void this.apple.check().catch(() => undefined)
    void this.releases
      .importOwn(runningInstall().appRoot)
      .catch(() => undefined)
  }
  /** Runs the Apple setup of the matching app IDs in the background; stop() waits for it. */
  setupApple(which: (app: ProjectApp) => boolean): void {
    if (this.stopped) return
    for (const app of this.projects
      .list()
      .flatMap((project) => project.apps)
      .filter((entry) => entry.apple != null && which(entry))) {
      // One setup per app ID at a time: a second waits, then finds what the
      // first made, so Apple never gets the same profile twice.
      const previous = this.appleQueue.get(app.bundleId) ?? Promise.resolve()
      const setup: Promise<void> = previous
        .then(async () => await this.appleSigning.setupApp(app))
        .then(
          () => undefined,
          (error: unknown) => {
            ;(this.options.log ?? console.log)(
              `Apple setup of ${app.bundleId} failed: ${(error as Error).message}`,
            )
          },
        )
        .finally(() => {
          this.appleSetups.delete(setup)
          if (this.appleQueue.get(app.bundleId) === setup)
            this.appleQueue.delete(app.bundleId)
        })
      this.appleQueue.set(app.bundleId, setup)
      this.appleSetups.add(setup)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    await Promise.all([...this.appleSetups])
    await this.forwarder.close()
    this.registry.stop()
    this.retention.stop()
    this.updates.stop()
    this.hosts.stop()
    clearInterval(this.expiry)
    await this.pools.stop()
    await this.cloudHosts.stop()
    clearInterval(this.compaction)
    clearInterval(this.backupTimer)
    // A change waiting on its backup is applied before the database closes.
    await this.backups.stop()
    this.provisioning.stop()
    this.apple.stop()
    await this.poller.close()
    await this.scheduler.stop()
  }

  configured(): boolean {
    return this.database.configured()
  }

  /**
   * Saves a project from one document: its fields, and optionally `apps`
   * and `rules`, as `mason projects set` sends it. Secrets are not part of
   * it: each variant is its own change, backed up before it is saved.
   */
  saveProject(
    actor: typeof localOperator,
    slug: string,
    value: unknown,
  ): unknown {
    const { apps, rules, secrets, ...fields } = (value ?? {}) as {
      apps?: unknown[]
      rules?: unknown
      secrets?: unknown
    }
    if (secrets != null)
      throw new Error(
        "Set secrets one variant at a time: the project's Secrets tab or /api/v2/projects/:slug/secrets",
      )
    this.projects.save(actor, slug, fields)
    for (const app of apps ?? []) this.projects.addApp(actor, slug, app)
    if (rules != null) this.projects.setRules(actor, slug, rules)
    return this.projects.get(slug)
  }

  /** Sets where a project's build-number sequence stands (`POST /api/v2/build-numbers/seed`). */
  seed(
    projectSlug: string,
    key: string,
    value: unknown,
    actor: Actor,
  ): { key: string; branch: string; last: string } {
    const project = this.projects.get(projectSlug)
    if (key === '') throw new Error('A build-number key is required')
    return this.buildNumbers.seed(project.id, key, value, actor)
  }

  /** What needs a person on the master, for `mason status` and the dashboard. */
  notices(): string[] {
    const apple = this.apple.status()
    const cloud = this.pools.notice()
    const backup = this.configured() ? this.backups.notice() : undefined
    return [
      ...(backup == null ? [] : [backup]),
      ...this.appleSigning.notices(),
      ...(apple.notice == null ? [] : [apple.notice]),
      ...(cloud == null ? [] : [cloud]),
    ]
  }

  /** The hourly backup, and the weekly reminder while there is none. */
  async backupTick(): Promise<void> {
    this.auth.prune()
    if (!this.configured()) return
    if (this.backups.status().configured)
      await this.backups.backup().catch(() => undefined)
    const reminder = this.backups.remind()
    if (reminder != null)
      (this.options.log ?? console.log)(
        `${reminder}; configure backups in Settings → Backups or with PUT /api/v2/settings/backup`,
      )
  }

  /** Signs the Apple ID in; Apple usually asks for a two-factor code next. */
  async appleSignIn(
    actor: typeof localOperator,
    appleId: unknown,
    password: unknown,
  ): Promise<AppleStatus> {
    allow(actor, 'apple.change')
    const id =
      typeof appleId === 'string' && appleId !== ''
        ? appleId
        : String(this.settings.value('apple')?.appleId ?? '')
    if (typeof password !== 'string') throw new Error('A password is required')
    await this.settings.set(actor, 'apple', { appleId: id })
    const status = await this.apple.signIn(id, password)
    this.database.audit(actor, 'apple.signIn', id)
    this.nodeStates.reconcileAll()
    return status
  }

  async appleCode(
    actor: typeof localOperator,
    code: unknown,
  ): Promise<AppleStatus> {
    allow(actor, 'apple.change')
    const status = await this.apple.submitCode(String(code ?? ''))
    this.database.audit(actor, 'apple.code', status.appleId ?? '')
    if (status.state === 'signedIn') {
      this.nodeStates.reconcileAll()
      this.scheduler.poke()
    }
    return status
  }

  /** A node's last inventory summary and update state, for the nodes API. */
  nodeDetails(fingerprint: string): Record<string, unknown> {
    const inventory = this.scheduler.inventoryOf(fingerprint)
    const update = this.updates.state(fingerprint)
    const checklist = [
      ...(inventory?.checklist ?? []),
      ...masterChecklist(this.apple.status(), this.nodeStates.wantsXcode()),
    ]
    return {
      checklist,
      ...this.nodeStates.details(fingerprint),
      ...(inventory == null
        ? {}
        : {
            inventory: {
              version: inventory.version,
              os: inventory.os,
              osVersion: inventory.osVersion,
              arch: inventory.arch,
              freeDisk: inventory.freeDisk,
              xcodes: inventory.xcodes ?? [],
              tools: inventory.tools,
              ...(inventory.system == null ? {} : { system: inventory.system }),
              ...(inventory.helper == null ? {} : { helper: inventory.helper }),
              ...(inventory.quarantine == null
                ? {}
                : { quarantine: inventory.quarantine }),
            },
          }),
      ...(update == null ? {} : { update }),
    }
  }

  /** Runs, newest first, filtered by project, workflow, branch and status. */
  runs(
    filter: {
      project?: unknown
      workflow?: unknown
      branch?: unknown
      status?: unknown
      limit?: unknown
    } = {},
  ): unknown[] {
    const where: string[] = []
    const values: Array<string | number> = []
    if (typeof filter.project === 'string') {
      where.push('p.slug=?')
      values.push(filter.project)
    }
    for (const field of ['workflow', 'branch', 'status'] as const)
      if (typeof filter[field] === 'string') {
        where.push(`j.${field}=?`)
        values.push(filter[field])
      }
    const limit = Math.min(Math.max(Number(filter.limit ?? 50) || 50, 1), 500)
    return this.database.db
      .prepare(
        `SELECT j.id FROM jobs j JOIN projects p ON p.id=j.project_id ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY j.created DESC, j.id DESC LIMIT ${limit}`,
      )
      .all(...values)
      .map((row) => this.run(String(row.id)))
  }

  /** One run with its stages and steps. */
  run(id: string): unknown {
    const job = this.jobs.job(id)
    if (job == null) return undefined
    const row = this.database.db
      .prepare(
        'SELECT description,reason,restart_of,restart_from FROM jobs WHERE id=?',
      )
      .get(id)!
    return {
      ...job,
      ...(row.description == null
        ? {}
        : { description: String(row.description) }),
      ...(row.reason == null ? {} : { reason: String(row.reason) }),
      ...(row.restart_of == null
        ? {}
        : {
            restartOf: String(row.restart_of),
            restartFrom: String(row.restart_from),
          }),
      stages: this.scheduler.stageViews(id),
      ...this.artifacts.forRun(id),
    }
  }

  /** The hourly expiry of builds and of saved artifacts past their workflow's `keep.artifactDays`. */
  expire(): { builds: number; artifacts: number } {
    const db = this.database.db
    return this.artifacts.expire((job) => {
      const row = db
        .prepare(
          'SELECT j.workflow,g.graph FROM jobs j JOIN graphs g ON g.key=j.graph_key WHERE j.id=?',
        )
        .get(job) as { workflow: string; graph: string } | undefined
      if (row == null) return undefined
      return (JSON.parse(row.graph) as Graph).workflows.find(
        (workflow) => workflow.name === row.workflow,
      )?.keep.artifactDays
    })
  }

  /** How this master reaches DigitalOcean Spaces (a fake in tests). */
  get spacesOptions(): NonNullable<MasterOptions['spaces']> {
    return this.options.spaces ?? {}
  }

  /** Operator commands; the control socket proves ownership of the data directory. */
  controlHandlers(): Record<string, ControlHandler> {
    const actor = localOperator
    return {
      setup: async (args): Promise<unknown> => {
        const result = await createFirstAdmin(this.database, this.keys, args)
        this.options.onConfigured?.()
        return result
      },
      'settings.get': (args) =>
        this.settings.get(actor, String(args.area ?? '')),
      'settings.set': (args) =>
        this.settings.set(actor, String(args.area ?? ''), args.value),
      'keys.create': (args) => this.keys.create(actor, args),
      'keys.list': () => this.keys.list(),
      'keys.revoke': (args): null => {
        this.keys.revoke(actor, String(args.id ?? ''))
        return null
      },
      'projects.list': () => this.projects.list(),
      'projects.get': (args) => this.projects.get(String(args.slug ?? '')),
      'projects.set': (args) =>
        this.saveProject(actor, String(args.slug ?? ''), args.value),
      'projects.remove': (args): null => {
        this.projects.remove(actor, String(args.slug ?? ''))
        return null
      },
      'nodes.add': async (args) =>
        await this.registry.add(
          String(args.address ?? ''),
          String(args.key ?? ''),
        ),
      'nodes.list': () => this.registry.list(),
      'cluster.check': async () => await clusterCheck(this),
      'nodes.set': async (args): Promise<unknown> => {
        const node = this.registry
          .list()
          .find(
            (entry) =>
              entry.fingerprint === args.node || entry.name === args.node,
          )
        if (node == null) throw new Error('No such node')
        return await this.registry.assign(node.fingerprint, args.value as never)
      },
      'runs.cleanup': () => this.retention.cleanup(),
      'releases.list': () => this.releases.list(),
      'releases.add': async (args): Promise<string> => {
        const added = await this.releases.add(String(args.dir ?? ''))
        void this.updates.tick()
        return added
      },
      'releases.fetch': async (args): Promise<string> => {
        const connection = this.settings.value('github') as
          | { kind?: string; token?: string }
          | undefined
        return await this.releases.fetch(
          String(args.tag ?? ''),
          connection?.kind === 'token'
            ? connection.token
            : (process.env.GITHUB_TOKEN ?? undefined),
          this.options.scratch ?? '/tmp',
        )
      },
      'releases.current': (args): { current: string | null } => {
        if (typeof args.version === 'string') {
          this.releases.setCurrent(args.version)
          void this.updates.tick()
        }
        return { current: this.releases.current() ?? null }
      },
      'runs.list': (args) => this.runs(args),
      'apple.status': () => this.apple.status(),
      'apple.signIn': async (args) =>
        await this.appleSignIn(actor, args.appleId, args.password),
      'apple.code': async (args) => await this.appleCode(actor, args.code),
      'apple.signOut': async (): Promise<null> => {
        await this.apple.signOut()
        return null
      },
      'runtimes.list': () => this.runtimes.list(),
      'cloud.status': () => this.pools.view(),
      'cloud.accounts.list': () => this.cloudAccounts.list(actor),
      'cloud.accounts.add': async (args) =>
        await this.cloudAccounts.add(actor, args),
      'cloud.accounts.check': async (args) =>
        await this.cloudAccounts.check(actor, String(args.id ?? '')),
      'cloud.accounts.remove': async (args): Promise<null> => {
        await this.cloudAccounts.remove(actor, String(args.id ?? ''))
        return null
      },
      'cloud.hosts.list': () => this.cloudHosts.list().map(hostView),
      'cloud.hosts.add': async (args) =>
        hostView(await this.cloudHosts.create(args.value)),
      'cloud.hosts.reconcile': async (args) =>
        hostView(await this.cloudHosts.reconcile(String(args.name ?? ''))),
      'cloud.hosts.remove': async (args): Promise<null> => {
        await this.cloudHosts.remove(String(args.name ?? ''), args.name)
        return null
      },
      'cloud.nodes.list': () => this.cloudHosts.list('worker').map(hostView),
      'cloud.nodes.add': async (args) =>
        hostView(await this.cloudHosts.createNode(args.value)),
      'cloud.nodes.reconcile': async (args) =>
        hostView(
          await this.cloudHosts.reconcile(String(args.name ?? ''), 'worker'),
        ),
      'cloud.nodes.remove': async (args): Promise<null> => {
        await this.cloudHosts.remove(String(args.name ?? ''), args.name, {
          role: 'worker',
        })
        return null
      },
      'nodes.remove': (args): null => {
        this.registry.remove(String(args.fingerprint ?? ''))
        return null
      },
      backup: async () => await this.backups.backup(),
      'backup.status': () => this.backups.status(),
      'people.list': () => this.people.list(actor),
      'people.add': async (args) => await this.people.create(actor, args.value),
      'people.set': async (args) =>
        await this.people.update(actor, Number(args.id), args.value),
      'people.remove': (args): null => {
        this.people.remove(actor, Number(args.id))
        return null
      },
      'groups.list': () => this.people.groups(actor),
      'groups.add': (args) => this.people.createGroup(actor, args.value),
      'groups.set': (args) =>
        this.people.updateGroup(actor, Number(args.id), args.value),
      'groups.remove': (args): null => {
        this.people.removeGroup(actor, Number(args.id))
        return null
      },
    }
  }
}
