import type { DatabaseSync } from 'node:sqlite'
import type { ControlHandler } from '../node/control.js'
import type { Identity } from '../node/identity.js'
import type { MethodTable } from '../link/link.js'
import { createFirstAdmin } from '../setup/setup.js'
import { MasterDatabase } from './database.js'
import { MasterKeys } from './keys.js'
import { NodeRegistry } from './nodes.js'
import { localOperator, requireRole } from './roles.js'
import { Settings } from './settings.js'
import { BuildNumbers } from './buildNumbers.js'
import { GitHub, storedConnection, type GitHubOptions } from './github.js'
import { Jobs } from './jobs.js'
import { gitHeadLister, Poller, type HeadLister } from './poller.js'
import { Projects } from './projects.js'
import { integer } from '../validation.js'
import path from 'node:path'
import { githubLfs, Mirrors, type RemoteResolver } from './mirrors.js'
import { Retention } from './retention.js'
import { Scheduler } from './scheduler.js'
import { Stashes } from './stash.js'
import { Releases } from './releases.js'
import { Updates } from './updates.js'
import { runningInstall } from '../release/install.js'
import { version } from '../version.js'
import {
  AppleDownloads,
  appleSetting,
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
  readonly runtimes: RuntimeStore
  readonly nodeStates: NodeStates
  private stopped = false
  constructor(
    db: DatabaseSync,
    readonly identity: Identity,
    private readonly options: MasterOptions = {},
  ) {
    this.database = new MasterDatabase(db, options.now)
    this.keys = new MasterKeys(this.database)
    this.settings = new Settings(this.database)
    this.registry = new NodeRegistry(db, identity, {
      methods: (role): MethodTable =>
        mergeMethods(
          role === 'worker'
            ? mergeMethods(this.scheduler.methods(), this.nodeStates.methods())
            : {},
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
    this.runtimes = new RuntimeStore(path.join(dir, 'runtimes'))
    this.scheduler = new Scheduler({
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
      now: this.database.now,
    })
    this.retention = new Retention(this.database, this.scheduler, this.stashes)
    this.settings.register('nodeTypes', {
      validate: nodeTypesSetting,
      changed: () => {
        this.nodeStates.reconcileAll()
      },
    })
    this.settings.register('apple', { validate: appleSetting })
    this.releases = new Releases(
      this.database,
      path.join(dir, 'releases'),
      identity,
      version,
    )
    this.updates = new Updates(
      this.registry,
      this.releases,
      (fingerprint) => this.scheduler.inventoryOf(fingerprint),
      (fingerprint) => this.scheduler.busy(fingerprint),
    )
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
    this.apple.start()
    void this.apple.check().catch(() => undefined)
    void this.releases
      .importOwn(runningInstall().appRoot)
      .catch(() => undefined)
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.registry.stop()
    this.retention.stop()
    this.updates.stop()
    this.apple.stop()
    await this.poller.close()
    await this.scheduler.stop()
  }

  configured(): boolean {
    return this.database.configured()
  }

  /**
   * Saves a project from one document: its fields, and optionally `apps`,
   * `rules` and `secrets`, as `mason projects set` sends it.
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
    this.projects.save(actor, slug, fields)
    for (const app of apps ?? []) this.projects.addApp(actor, slug, app)
    if (rules != null) this.projects.setRules(actor, slug, rules)
    if (secrets != null) this.projects.setSecrets(actor, slug, secrets)
    return this.projects.get(slug)
  }

  /** Seeds a project's build-number counters from a copy of buildNum.json. */
  seed(
    projectSlug: string,
    key: string,
    entries: unknown,
  ): { branches: number } {
    const project = this.projects.get(projectSlug)
    if (key === '') throw new Error('A build-number key is required')
    return this.buildNumbers.seed(project.id, key, entries)
  }

  /** What needs a person on the master: the Apple ID code, for `mason status` and the dashboard. */
  notices(): string[] {
    const apple = this.apple.status()
    return apple.notice == null ? [] : [apple.notice]
  }

  /** Signs the Apple ID in; Apple usually asks for a two-factor code next. */
  async appleSignIn(
    actor: typeof localOperator,
    appleId: unknown,
    password: unknown,
  ): Promise<AppleStatus> {
    requireRole(actor, 'manager')
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
    requireRole(actor, 'manager')
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
    }
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
      'buildNumbers.seed': (args) =>
        this.seed(
          String(args.project ?? ''),
          String(args.key ?? ''),
          args.entries,
        ),
      'nodes.add': async (args) =>
        await this.registry.add(
          String(args.address ?? ''),
          String(args.key ?? ''),
        ),
      'nodes.list': () => this.registry.list(),
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
      'nodes.remove': (args): null => {
        this.registry.remove(String(args.fingerprint ?? ''))
        return null
      },
    }
  }
}
