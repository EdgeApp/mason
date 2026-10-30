import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ProviderConfig } from '../auth/providerConfig.js'
import { asConfig, type Config } from '../config.js'
import type { Change, Projected, Sync } from '../master/changes.js'
import type { HostSetting, SignInMethod } from '../master/hostSettings.js'
import { Store } from '../store.js'

type Row = Record<string, unknown>

/** Where each replicated entity lives in the cache, and the child tables replaced with it. */
const tables: Record<
  string,
  {
    table: string
    key: string
    children?: Record<string, { column: string; field: string }>
  }
> = {
  project: {
    table: 'projects',
    key: 'slug',
    children: { project_apps: { column: 'project_id', field: 'id' } },
  },
  app: {
    table: 'apps',
    key: 'id',
    children: { channels: { column: 'app_id', field: 'id' } },
  },
  build: {
    table: 'builds',
    key: 'id',
    children: { build_provisioning: { column: 'build_id', field: 'id' } },
  },
  account: {
    table: 'accounts',
    key: 'id',
    children: {
      account_addresses: { column: 'account_id', field: 'id' },
      account_devices: { column: 'account_id', field: 'id' },
    },
  },
  group: {
    table: 'groups',
    key: 'id',
    children: {
      group_apps: { column: 'group_id', field: 'id' },
      group_members: { column: 'group_id', field: 'id' },
    },
  },
  device: { table: 'devices', key: 'id' },
  job: {
    table: 'jobs',
    key: 'id',
    children: {
      job_stages: { column: 'job_id', field: 'id' },
      job_steps: { column: 'job_id', field: 'id' },
      run_artifacts: { column: 'job_id', field: 'id' },
      run_tests: { column: 'job_id', field: 'id' },
    },
  },
  setting: { table: 'host_settings', key: 'area' },
}

/** Deleting in this order keeps foreign keys satisfied; applying uses the reverse. */
const order = [
  'setting',
  'project',
  'app',
  'account',
  'group',
  'device',
  'build',
  'job',
]

const HOST_SCHEMA = 4

/** The host's own tables beside the distribution tables a `Store` creates. */
function migrateHost(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS host_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  )
  const row = db
    .prepare("SELECT value FROM host_meta WHERE key='host_schema'")
    .get() as { value: string } | undefined
  const current = row == null ? 0 : Number(row.value)
  if (current > HOST_SCHEMA)
    throw new Error('The host cache belongs to a newer Mason version')
  if (current === HOST_SCHEMA) return
  if (current < 1) migrateHostV1(db)
  if (current < 2) migrateHostV2(db)
  // Where each step's lines are in its stage log, replicated with the step.
  if (current < 3)
    db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE job_steps ADD COLUMN log_start INTEGER;
    ALTER TABLE job_steps ADD COLUMN log_end INTEGER;
    INSERT INTO host_meta(key,value) VALUES('host_schema','3') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    COMMIT;`)
  // The host no longer serves the Zealot upload API, the only reader of keys.
  db.exec(`BEGIN IMMEDIATE;
    DELETE FROM api_keys;
    INSERT INTO host_meta(key,value) VALUES('host_schema','4') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    COMMIT;`)
}

function migrateHostV2(db: DatabaseSync): void {
  // Saved artifacts and test results of runs, replicated with their run.
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE run_artifacts(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, stage TEXT NOT NULL,
      name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, visible_to TEXT, entry TEXT,
      storage_key TEXT NOT NULL, created_at INTEGER NOT NULL, deleting INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(job_id, name)) STRICT;
    CREATE TABLE run_tests(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, stage TEXT NOT NULL,
      attempt INTEGER NOT NULL, summary TEXT NOT NULL, PRIMARY KEY(job_id, stage, attempt)) STRICT;
    INSERT INTO host_meta(key,value) VALUES('host_schema','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    COMMIT;`)
}

function migrateHostV1(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'tester';
    -- The master's keys carry every role; the distribution table allowed only upload and admin.
    CREATE TABLE api_keys_next (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, apps TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL, projects TEXT NOT NULL DEFAULT '[]', branches TEXT NOT NULL DEFAULT '[]',
      format TEXT NOT NULL DEFAULT 'v1'
    ) STRICT;
    INSERT INTO api_keys_next(id,hash,name,apps,created_at,expires_at,revoked,role)
      SELECT id,hash,name,apps,created_at,expires_at,revoked,role FROM api_keys;
    DROP TABLE api_keys;
    ALTER TABLE api_keys_next RENAME TO api_keys;
    CREATE TABLE host_settings(area TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE host_release(id TEXT PRIMARY KEY, version TEXT NOT NULL, files TEXT NOT NULL) STRICT;
    CREATE TABLE account_addresses(
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      method TEXT NOT NULL, email TEXT NOT NULL, PRIMARY KEY(account_id, method)) STRICT;
    CREATE INDEX account_address_email ON account_addresses(method, email COLLATE NOCASE);
    CREATE TABLE groups(id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
    CREATE TABLE group_apps(group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      app_id INTEGER NOT NULL, PRIMARY KEY(group_id, app_id)) STRICT;
    CREATE TABLE group_members(group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL, PRIMARY KEY(group_id, account_id)) STRICT;
    CREATE TABLE projects(id INTEGER NOT NULL UNIQUE, slug TEXT PRIMARY KEY, name TEXT NOT NULL,
      position INTEGER NOT NULL, enabled INTEGER NOT NULL, default_branch TEXT NOT NULL) STRICT;
    CREATE TABLE project_apps(app_id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL) STRICT;
    CREATE TABLE jobs(id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, workflow TEXT NOT NULL,
      number INTEGER NOT NULL, branch TEXT NOT NULL, commit_sha TEXT, trigger TEXT NOT NULL,
      status TEXT NOT NULL, created INTEGER NOT NULL, started INTEGER, finished INTEGER,
      params TEXT NOT NULL, actor TEXT NOT NULL, description TEXT, reason TEXT, graph TEXT) STRICT;
    CREATE TABLE job_stages(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, name TEXT NOT NULL,
      position INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL,
      worker TEXT, started INTEGER, finished INTEGER, reason TEXT, output TEXT, reused INTEGER NOT NULL,
      approval TEXT, PRIMARY KEY(job_id, name)) STRICT;
    CREATE TABLE job_steps(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, stage TEXT NOT NULL,
      attempt INTEGER NOT NULL, id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, ms INTEGER, PRIMARY KEY(job_id, stage, attempt, id)) STRICT;
    INSERT INTO host_meta(key,value) VALUES('host_schema','1');
    COMMIT;`)
}

const ROLES_SEEING_EVERY_APP = new Set(['admin', 'manager', 'developer'])

/**
 * The host's copy of the master's replicated data in `host-cache.sqlite`,
 * kept in the distribution schema so the catalog, install and sign-in code
 * reads it as it reads a standalone server's database. Host-local tables
 * (sessions, identities, install grants, device challenges, the outbox)
 * live in the same file and are never replicated.
 */
export class HostCache {
  readonly store: Store
  readonly db: DatabaseSync
  private readonly columns = new Map<string, string[]>()

  constructor(
    readonly dir: string,
    readonly now: () => number = Date.now,
  ) {
    const storage = path.join(dir, 'storage')
    mkdirSync(storage, { recursive: true, mode: 0o700 })
    const base = asConfig({
      origin: 'https://host.invalid',
      database: path.join(dir, 'host-cache.sqlite'),
      storage,
    })
    // The origin and sign-in methods are master settings, read from the cache each time.
    const config = Object.defineProperties({ ...base } as Config, {
      origin: {
        get: (): string => this.host()?.origin ?? 'https://host.invalid',
        enumerable: true,
      },
      providers: {
        get: (): ProviderConfig[] => this.signInMethods(),
        enumerable: true,
      },
    })
    this.store = new Store(config, now)
    this.db = this.store.db
    migrateHost(this.db)
    this.store.scope = (accountId): ReadonlySet<number> | 'all' =>
      this.scope(accountId)
  }

  close(): void {
    this.store.close()
  }

  private meta(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM host_meta WHERE key=?').get(key) as
        | { value: string }
        | undefined
    )?.value
  }
  private setMeta(key: string, value: string | number): void {
    this.db
      .prepare(
        'INSERT INTO host_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, String(value))
  }

  /** The last master revision applied. */
  revision(): number {
    return Number(this.meta('revision') ?? 0)
  }
  /** When the host last heard from its master, or undefined if never. */
  syncedAt(): number | undefined {
    const value = this.meta('synced_at')
    return value == null ? undefined : Number(value)
  }
  /** Records contact with the master while the link stays open. */
  touch(): void {
    this.setMeta('synced_at', this.now())
  }

  setting<T>(area: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM host_settings WHERE area=?')
      .get(area) as { value: string } | undefined
    return row == null ? undefined : (JSON.parse(row.value) as T)
  }
  host(): HostSetting | undefined {
    return this.setting<HostSetting>('host')
  }
  /** The sign-in methods enabled on the master. */
  signInMethods(): ProviderConfig[] {
    return (this.setting<{ methods?: SignInMethod[] }>('signIn')?.methods ?? [])
      .filter((method) => method.enabled)
      .map(({ enabled: _enabled, ...provider }) => provider as ProviderConfig)
  }

  /** Testers see the apps of their groups; developers, managers and admins see every app. */
  scope(accountId: number): ReadonlySet<number> | 'all' {
    const row = this.db
      .prepare('SELECT role FROM accounts WHERE id=?')
      .get(accountId) as { role: string } | undefined
    if (row != null && ROLES_SEEING_EVERY_APP.has(row.role)) return 'all'
    return new Set(
      (
        this.db
          .prepare(
            'SELECT DISTINCT ga.app_id FROM group_members gm JOIN group_apps ga ON ga.group_id=gm.group_id WHERE gm.account_id=?',
          )
          .all(accountId) as Array<{ app_id: number }>
      ).map((entry) => Number(entry.app_id)),
    )
  }

  private tableColumns(table: string): string[] {
    let out = this.columns.get(table)
    if (out == null) {
      out = (
        this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string
        }>
      ).map((column) => column.name)
      this.columns.set(table, out)
    }
    return out
  }

  private insert(table: string, row: Row, conflict: string): void {
    const known = this.tableColumns(table)
    const fields = Object.keys(row).filter((field) => known.includes(field))
    const values = fields.map((field) => {
      const value = row[field]
      return value === undefined ? null : (value as string | number | null)
    })
    const update = fields.filter((field) => field !== conflict)
    this.db
      .prepare(
        `INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')}) ON CONFLICT(${conflict}) DO ${
          update.length === 0
            ? 'NOTHING'
            : `UPDATE SET ${update.map((field) => `${field}=excluded.${field}`).join(',')}`
        }`,
      )
      .run(...values)
  }

  /** Applies one entity's projection: upserts its row (never a delete-and-insert that would cascade) and replaces its children. */
  private put(entity: string, value: Projected): void {
    const spec = tables[entity]!
    let row = value.row
    if (entity === 'account') row = { ...row, is_admin: 0, is_tester: 1 }
    this.insert(spec.table, row, spec.key)
    for (const [child, link] of Object.entries(spec.children ?? {})) {
      this.db
        .prepare(`DELETE FROM ${child} WHERE ${link.column}=?`)
        .run(row[link.field] as string | number)
      for (const entry of value.children?.[child] ?? [])
        this.insertChild(child, entry)
    }
  }
  private insertChild(table: string, row: Row): void {
    const known = this.tableColumns(table)
    const fields = Object.keys(row).filter((field) => known.includes(field))
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`,
      )
      .run(...fields.map((field) => row[field] as string | number | null))
  }
  private remove(entity: string, key: string): void {
    const spec = tables[entity]!
    if (entity === 'build') {
      // A build the master deleted is gone from the catalog at once; its file goes with the cleanup.
      this.db
        .prepare("UPDATE builds SET state='deleted' WHERE id=?")
        .run(Number(key))
      this.db
        .prepare('DELETE FROM install_grants WHERE build_id=?')
        .run(Number(key))
      return
    }
    for (const [child, link] of Object.entries(spec.children ?? {}))
      if (link.field === spec.key)
        this.db.prepare(`DELETE FROM ${child} WHERE ${link.column}=?`).run(key)
    this.db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.key}=?`).run(key)
  }

  /** Ends sessions whose account changed permissions, was disabled or is gone. */
  private endStaleSessions(): void {
    this.db.exec(
      'DELETE FROM sessions WHERE account_id NOT IN (SELECT id FROM accounts) OR account_id IN (SELECT a.id FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE a.disabled<>0 OR a.permission_version<>s.permission_version)',
    )
  }

  /** Applies a sync from the master in one transaction, then records its revision and the time. */
  apply(sync: Sync): void {
    this.store.transaction(() => {
      this.db.exec('PRAGMA defer_foreign_keys=ON')
      if (sync.kind === 'snapshot') {
        for (const entity of [...order].reverse()) {
          const values = sync.entities[entity] ?? []
          for (const value of values) this.put(entity, value)
        }
        for (const entity of order) {
          const spec = tables[entity]!
          const keep = new Set(
            (sync.entities[entity] ?? []).map((value) =>
              String(value.row[spec.key]),
            ),
          )
          const condition = entity === 'build' ? " WHERE state<>'deleted'" : ''
          for (const row of this.db
            .prepare(`SELECT ${spec.key} AS k FROM ${spec.table}${condition}`)
            .all() as Array<{ k: unknown }>)
            if (!keep.has(String(row.k))) this.remove(entity, String(row.k))
        }
      } else
        for (const change of sync.changes as Change[]) {
          if (tables[change.entity] == null) continue
          if (change.operation === 'put' && change.value != null)
            this.put(change.entity, change.value)
          else this.remove(change.entity, change.key)
        }
      this.endStaleSessions()
      this.setMeta('revision', sync.revision)
      this.setMeta('synced_at', this.now())
    })
  }
}
