import type { DatabaseSync } from 'node:sqlite'
import type { ControlHandler } from '../node/control.js'
import type { Identity } from '../node/identity.js'
import type { MethodTable } from '../link/link.js'
import { createFirstAdmin } from '../setup/setup.js'
import { MasterDatabase } from './database.js'
import { MasterKeys } from './keys.js'
import { NodeRegistry } from './nodes.js'
import { localOperator } from './roles.js'
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
}

/**
 * Per-node-type settings. `androidLicensesAccepted: true` records who
 * accepted the Android SDK licences for that type, and when; the worker's
 * Android installer accepts them only then.
 */
export function nodeTypesSetting(
  input: unknown,
  previous: Record<string, unknown> | undefined,
  context: { actor: { label: string }; now: number },
): Record<string, unknown> {
  if (input == null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('nodeTypes maps node type names to their settings')
  const out: Record<string, unknown> = {}
  for (const [type, value] of Object.entries(input)) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(type))
      throw new Error(`Invalid node type ${type}`)
    const fields = (value ?? {}) as { androidLicensesAccepted?: unknown }
    const before = (
      previous?.[type] as { androidLicensesAccepted?: unknown } | undefined
    )?.androidLicensesAccepted
    if (fields.androidLicensesAccepted === true)
      out[type] = {
        androidLicensesAccepted: before ?? {
          by: context.actor.label,
          at: context.now,
        },
      }
    else if (
      fields.androidLicensesAccepted == null ||
      fields.androidLicensesAccepted === false
    )
      out[type] = {}
    else throw new Error('androidLicensesAccepted is true or false')
  }
  return out
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
          role === 'worker' ? this.scheduler.methods() : {},
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
    })
    this.retention = new Retention(this.database, this.scheduler, this.stashes)
    this.settings.register('nodeTypes', { validate: nodeTypesSetting })
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
  }
  async stop(): Promise<void> {
    this.registry.stop()
    this.retention.stop()
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
      'runs.list': (args) => this.runs(args),
      'nodes.remove': (args): null => {
        this.registry.remove(String(args.fingerprint ?? ''))
        return null
      },
    }
  }
}
