import type { DatabaseSync } from 'node:sqlite'
import type { Actor } from './roles.js'
import { migrateMaster } from './schema.js'

/** The master's database: migrations, transactions, audit and change log. */
export class MasterDatabase {
  constructor(
    readonly db: DatabaseSync,
    readonly now: () => number = Date.now,
  ) {
    migrateMaster(db)
  }
  transaction<T>(body: () => T): T {
    if (this.db.isTransaction) return body()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = body()
      this.db.exec('COMMIT')
      return out
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  audit(actor: Actor, action: string, target: string): void {
    this.db
      .prepare(
        'INSERT INTO audit(actor,action,target,at,via) VALUES(?,?,?,?,?)',
      )
      .run(actor.accountId ?? null, action, target, this.now(), actor.label)
  }
  /** Records a replicated write for the host's cache. */
  change(
    entity: string,
    key: string | number,
    operation: 'put' | 'delete' = 'put',
  ): void {
    this.db
      .prepare(
        'INSERT INTO change_log(entity,key,operation,at) VALUES(?,?,?,?)',
      )
      .run(entity, String(key), operation, this.now())
  }
  /** Whether a local admin exists, which locks the master's setup. */
  configured(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM accounts WHERE role='admin' AND password IS NOT NULL AND disabled=0 LIMIT 1",
        )
        .get() != null
    )
  }
}
