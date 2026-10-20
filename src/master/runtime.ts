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

export interface MasterOptions {
  methods?: (role: 'worker' | 'host') => MethodTable
  heartbeatMs?: number
  redialBaseMs?: number
  /** Called once the first admin exists. */
  onConfigured?(): void
}

/** The master role's parts, shared by its web listener and control socket. */
export class Master {
  readonly database: MasterDatabase
  readonly keys: MasterKeys
  readonly settings: Settings
  readonly registry: NodeRegistry
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
  }

  configured(): boolean {
    return this.database.configured()
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
