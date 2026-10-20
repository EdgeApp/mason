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
  constructor(
    db: DatabaseSync,
    readonly identity: Identity,
    private readonly options: MasterOptions = {},
  ) {
    this.database = new MasterDatabase(db)
    this.keys = new MasterKeys(this.database)
    this.settings = new Settings(this.database)
    this.registry = new NodeRegistry(db, identity, {
      methods: options.methods ?? ((): MethodTable => ({})),
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
  }

  /** Starts dialing nodes and polling repositories. */
  start(pollMs?: number): void {
    this.registry.start()
    this.poller.start(pollMs)
  }
  async stop(): Promise<void> {
    this.registry.stop()
    await this.poller.close()
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
      'nodes.remove': (args): null => {
        this.registry.remove(String(args.fingerprint ?? ''))
        return null
      },
    }
  }
}
