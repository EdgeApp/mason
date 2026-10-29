import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MasterDatabase } from './database.js'

/**
 * What the host's cache holds: each replicated entity, projected from the
 * master's tables at send time. Secrets, env, files, branch rules, password
 * hashes, node keys and channel keys are never part of a projection.
 */

type Row = Record<string, unknown>

/** One entity's projected state: its row and the rows of its child tables. */
export interface Projected {
  row: Row
  children?: Record<string, Row[]>
}

export interface Change {
  revision: number
  entity: string
  key: string
  operation: 'put' | 'delete'
  value?: Projected
}

export type Sync =
  | { kind: 'changes'; revision: number; changes: Change[] }
  | {
      kind: 'snapshot'
      revision: number
      entities: Record<string, Projected[]>
    }

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

const all = (
  db: DatabaseSync,
  sql: string,
  ...args: Array<string | number>
): Row[] => db.prepare(sql).all(...args) as Row[]
const one = (
  db: DatabaseSync,
  sql: string,
  ...args: Array<string | number>
): Row | undefined => db.prepare(sql).get(...args) as Row | undefined

/** Settings areas the host needs; anything else stays on the master. */
export const publishedSettings = ['host', 'signIn', 'storage'] as const

interface Entity {
  /** Every key, for a snapshot. */
  keys(db: DatabaseSync): string[]
  /** The projection of one key, or undefined once it is gone. */
  project(db: DatabaseSync, key: string): Projected | undefined
}

/** The master's view of a setting as the host may hold it (a hook strips what the host must not see). */
export type SettingProjection = (area: string, value: Row) => Row

export function entities(setting: SettingProjection): Record<string, Entity> {
  return {
    project: {
      keys: (db): string[] =>
        all(db, 'SELECT slug FROM projects').map((row) => String(row.slug)),
      project: (db, slug): Projected | undefined => {
        const row = one(
          db,
          'SELECT id,slug,name,position,enabled,default_branch FROM projects WHERE slug=?',
          slug,
        )
        if (row == null) return undefined
        return {
          row,
          children: {
            project_apps: all(
              db,
              'SELECT app_id,project_id FROM project_apps WHERE project_id=?',
              Number(row.id),
            ),
          },
        }
      },
    },
    app: {
      keys: (db): string[] =>
        all(db, 'SELECT id FROM apps').map((row) => String(row.id)),
      project: (db, id): Projected | undefined => {
        const row = one(
          db,
          'SELECT id,slug,name,position,enabled FROM apps WHERE id=?',
          Number(id),
        )
        if (row == null) return undefined
        // A channel's key is a credential: the host keeps only its digest.
        const channels = all(
          db,
          'SELECT id,app_id,platform,channel_key,formats,enabled FROM channels WHERE app_id=?',
          Number(id),
        ).map((channel) => ({
          ...channel,
          channel_key: digest(String(channel.channel_key)),
        }))
        return { row, children: { channels } }
      },
    },
    build: {
      keys: (db): string[] =>
        all(db, "SELECT id FROM builds WHERE state<>'deleted'").map((row) =>
          String(row.id),
        ),
      project: (db, id): Projected | undefined => {
        const row = one(db, 'SELECT * FROM builds WHERE id=?', Number(id))
        if (row == null || row.state === 'deleted') return undefined
        return {
          row,
          children: {
            build_provisioning: all(
              db,
              'SELECT * FROM build_provisioning WHERE build_id=?',
              Number(id),
            ),
          },
        }
      },
    },
    account: {
      keys: (db): string[] =>
        all(db, 'SELECT id FROM accounts').map((row) => String(row.id)),
      project: (db, id): Projected | undefined => {
        const row = one(
          db,
          'SELECT id,name,email,is_admin,is_tester,disabled,permission_version,created_at,role FROM accounts WHERE id=?',
          Number(id),
        )
        if (row == null) return undefined
        return {
          row,
          children: {
            account_addresses: all(
              db,
              'SELECT account_id,method,email FROM account_addresses WHERE account_id=?',
              Number(id),
            ),
            account_devices: all(
              db,
              'SELECT * FROM account_devices WHERE account_id=?',
              Number(id),
            ),
          },
        }
      },
    },
    group: {
      keys: (db): string[] =>
        all(db, 'SELECT id FROM groups').map((row) => String(row.id)),
      project: (db, id): Projected | undefined => {
        const row = one(
          db,
          'SELECT id,name,created_at FROM groups WHERE id=?',
          Number(id),
        )
        if (row == null) return undefined
        return {
          row,
          children: {
            group_apps: all(
              db,
              'SELECT group_id,app_id FROM group_apps WHERE group_id=?',
              Number(id),
            ),
            group_members: all(
              db,
              'SELECT group_id,account_id FROM group_members WHERE group_id=?',
              Number(id),
            ),
          },
        }
      },
    },
    device: {
      keys: (db): string[] =>
        all(db, 'SELECT id FROM devices').map((row) => String(row.id)),
      project: (db, id): Projected | undefined => {
        const row = one(db, 'SELECT * FROM devices WHERE id=?', Number(id))
        return row == null ? undefined : { row }
      },
    },
    api_key: {
      keys: (db): string[] =>
        all(db, 'SELECT id FROM api_keys').map((row) => String(row.id)),
      project: (db, id): Projected | undefined => {
        // `hash` is already a digest of the token; the token itself is never stored.
        const row = one(
          db,
          'SELECT id,hash,name,apps,created_at,expires_at,revoked,role,projects,branches,format FROM api_keys WHERE id=?',
          id,
        )
        return row == null ? undefined : { row }
      },
    },
    job: {
      keys: (db): string[] =>
        all(db, 'SELECT id FROM jobs').map((row) => String(row.id)),
      project: (db, id): Projected | undefined => {
        const row = one(
          db,
          'SELECT id,project_id,workflow,number,branch,commit_sha,trigger,status,created,started,finished,params,actor,description,graph_key,reason FROM jobs WHERE id=?',
          id,
        )
        if (row == null) return undefined
        const graph =
          row.graph_key == null
            ? undefined
            : one(
                db,
                'SELECT graph FROM graphs WHERE key=?',
                String(row.graph_key),
              )
        const rest = { ...row }
        delete rest.graph_key
        return {
          row: { ...rest, graph: graph?.graph ?? null },
          children: {
            job_stages: all(
              db,
              // The host shows the node's name, never its fingerprint.
              'SELECT job_id,name,position,kind,status,attempt,(SELECT n.name FROM nodes n WHERE n.fingerprint=job_stages.worker) AS worker,started,finished,reason,output,reused,approval FROM job_stages WHERE job_id=?',
              id,
            ),
            job_steps: all(
              db,
              'SELECT job_id,stage,attempt,id,kind,title,status,ms,log_start,log_end FROM job_steps WHERE job_id=?',
              id,
            ),
            run_artifacts: all(
              db,
              'SELECT job_id,stage,name,kind,size,digest,visible_to,entry,storage_key,created_at,deleting FROM run_artifacts WHERE job_id=?',
              id,
            ),
            run_tests: all(
              db,
              'SELECT job_id,stage,attempt,summary FROM run_tests WHERE job_id=?',
              id,
            ),
          },
        }
      },
    },
    setting: {
      keys: (): string[] => [...publishedSettings],
      project: (db, area): Projected | undefined => {
        if (!(publishedSettings as readonly string[]).includes(area))
          return undefined
        const row = one(db, 'SELECT value FROM settings WHERE area=?', area)
        if (row == null) return undefined
        return {
          row: {
            area,
            value: JSON.stringify(
              setting(area, JSON.parse(String(row.value)) as Row),
            ),
          },
        }
      },
    },
  }
}

/** How long change rows are kept; a host further behind gets a snapshot. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000

/** The master's change log, read by the host's sync. */
export class Changes {
  readonly entities: Record<string, Entity>
  constructor(
    private readonly master: MasterDatabase,
    setting: SettingProjection,
  ) {
    this.entities = entities(setting)
  }

  revision(): number {
    return Number(
      (
        this.master.db
          .prepare('SELECT COALESCE(MAX(revision),0) n FROM change_log')
          .get() as { n: number }
      ).n,
    )
  }

  private project(entity: string, key: string): Projected | undefined {
    const known = this.entities[entity]
    if (known == null) return undefined
    return known.project(this.master.db, key)
  }

  /**
   * Everything after `revision`: the changes, each projected as it is now
   * (later writes to the same key collapse into one), or a snapshot when the
   * host is new or the log was compacted past it.
   */
  since(revision: number): Sync {
    const db = this.master.db
    return this.master.transaction(() => {
      const current = this.revision()
      const oldest = Number(
        (
          db
            .prepare('SELECT COALESCE(MIN(revision),0) n FROM change_log')
            .get() as { n: number }
        ).n,
      )
      if (
        revision <= 0 ||
        revision > current ||
        (oldest > 0 && revision < oldest - 1)
      )
        return this.snapshot(current)
      const rows = db
        .prepare(
          'SELECT revision,entity,key,operation FROM change_log WHERE revision>? ORDER BY revision',
        )
        .all(revision) as Array<{
        revision: number
        entity: string
        key: string
        operation: 'put' | 'delete'
      }>
      const latest = new Map<string, (typeof rows)[number]>()
      for (const row of rows) {
        if (this.entities[row.entity] == null) continue
        const id = `${row.entity}\u0000${row.key}`
        latest.delete(id)
        latest.set(id, row)
      }
      const changes: Change[] = []
      for (const row of latest.values()) {
        const value =
          row.operation === 'delete'
            ? undefined
            : this.project(row.entity, row.key)
        changes.push({
          revision: Number(row.revision),
          entity: row.entity,
          key: row.key,
          operation: value == null ? 'delete' : 'put',
          ...(value == null ? {} : { value }),
        })
      }
      return { kind: 'changes', revision: current, changes }
    })
  }

  snapshot(revision = this.revision()): Sync {
    const db = this.master.db
    const out: Record<string, Projected[]> = {}
    for (const [name, entity] of Object.entries(this.entities))
      out[name] = entity.keys(db).flatMap((key) => {
        const value = entity.project(db, key)
        return value == null ? [] : [value]
      })
    return { kind: 'snapshot', revision, entities: out }
  }

  /** Drops change rows older than seven days. */
  compact(now = this.master.now()): number {
    return Number(
      this.master.db
        .prepare('DELETE FROM change_log WHERE at<?')
        .run(now - KEEP_MS).changes,
    )
  }
}
