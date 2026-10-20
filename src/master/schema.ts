import type { DatabaseSync } from 'node:sqlite'
import { migrate } from '../schema.js'

/**
 * The master's own tables, versioned in `meta` under `master_schema` so the
 * distribution tables can keep their `PRAGMA user_version` migrations.
 */
export const MASTER_SCHEMA = 3

const migrations: Array<(db: DatabaseSync) => void> = [
  (db): void =>
    db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      certificate_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('worker','host')),
      host TEXT NOT NULL,
      port INTEGER NOT NULL CHECK(port >= 0 AND port <= 65535),
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '',
      labels TEXT NOT NULL DEFAULT '[]',
      version TEXT NOT NULL DEFAULT '',
      added_at INTEGER NOT NULL,
      last_seen INTEGER,
      removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1))
    ) STRICT;`),
  (db): void => {
    db.exec(`
    ALTER TABLE accounts ADD COLUMN username TEXT;
    ALTER TABLE accounts ADD COLUMN password TEXT;
    ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'tester'
      CHECK(role IN ('admin','manager','developer','tester'));
    CREATE UNIQUE INDEX account_username ON accounts(username COLLATE NOCASE) WHERE username IS NOT NULL;
    CREATE TABLE account_addresses (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      method TEXT NOT NULL, email TEXT NOT NULL,
      PRIMARY KEY(account_id, method), UNIQUE(method, email)
    ) STRICT;
    ALTER TABLE audit ADD COLUMN via TEXT NOT NULL DEFAULT '';
    CREATE TABLE groups (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE group_apps (
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      PRIMARY KEY(group_id, app_id)
    ) STRICT;
    CREATE TABLE group_members (
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      PRIMARY KEY(group_id, account_id)
    ) STRICT;
    CREATE TABLE api_keys_next (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, apps TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
      role TEXT NOT NULL CHECK(role IN ('admin','manager','developer','tester','upload')),
      projects TEXT NOT NULL DEFAULT '[]', branches TEXT NOT NULL DEFAULT '[]',
      format TEXT NOT NULL DEFAULT 'v1' CHECK(format IN ('v1','builder')),
      creator INTEGER REFERENCES accounts(id)
    ) STRICT;
    INSERT INTO api_keys_next(id,hash,name,apps,created_at,expires_at,revoked,role)
      SELECT id,hash,name,apps,created_at,expires_at,revoked,role FROM api_keys;
    DROP TABLE api_keys;
    ALTER TABLE api_keys_next RENAME TO api_keys;
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, repository TEXT NOT NULL,
      format TEXT NOT NULL CHECK(format IN ('pipeline','script')), entrypoint TEXT,
      timeout_seconds INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      position INTEGER NOT NULL DEFAULT 0, default_branch TEXT NOT NULL DEFAULT 'master',
      webhook_secret TEXT, script TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE project_apps (
      app_id INTEGER PRIMARY KEY REFERENCES apps(id),
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE project_env (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, value TEXT NOT NULL, secret INTEGER NOT NULL DEFAULT 1 CHECK(secret IN (0,1)),
      PRIMARY KEY(project_id, name)
    ) STRICT;
    CREATE TABLE project_files (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      destination TEXT NOT NULL, contents TEXT NOT NULL, env TEXT,
      PRIMARY KEY(project_id, destination)
    ) STRICT;
    CREATE TABLE branch_rules (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, pattern TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('automatic','request')),
      PRIMARY KEY(project_id, position)
    ) STRICT;
    CREATE TABLE settings (
      area TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
    ) STRICT;
    CREATE TABLE change_log (
      revision INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, key TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('put','delete')), at INTEGER NOT NULL
    ) STRICT;`)
  },
  (db): void => {
    db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
      workflow TEXT NOT NULL DEFAULT 'build', number INTEGER NOT NULL,
      branch TEXT NOT NULL, requested_commit TEXT, commit_sha TEXT,
      trigger TEXT NOT NULL CHECK(trigger IN ('push','request','schedule','after','deviceRegistered','restart')),
      status TEXT NOT NULL, created INTEGER NOT NULL, started INTEGER, finished INTEGER,
      params TEXT NOT NULL DEFAULT '{}', request TEXT NOT NULL, token TEXT UNIQUE,
      client_ip TEXT, key_id TEXT, actor TEXT NOT NULL DEFAULT '',
      cancel INTEGER NOT NULL DEFAULT 0 CHECK(cancel IN (0,1)),
      exit_code INTEGER, result TEXT,
      UNIQUE(project_id, workflow, number)
    ) STRICT;
    CREATE INDEX jobs_queue ON jobs(status, created);
    CREATE TABLE automatic_branches (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, branch TEXT NOT NULL,
      last_checked INTEGER, observed_commit TEXT, poll_error TEXT,
      last_attempted_commit TEXT, last_successful_commit TEXT, last_job_id TEXT,
      PRIMARY KEY(project_id, branch)
    ) STRICT;
    CREATE TABLE automatic_attempts (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, branch TEXT NOT NULL,
      commit_sha TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      succeeded INTEGER NOT NULL DEFAULT 0 CHECK(succeeded IN (0,1)),
      PRIMARY KEY(project_id, branch, commit_sha)
    ) STRICT;
    CREATE TABLE build_number_schemes (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key TEXT NOT NULL,
      scheme TEXT NOT NULL, PRIMARY KEY(project_id, key)
    ) STRICT;
    CREATE TABLE build_numbers (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key TEXT NOT NULL,
      branch TEXT NOT NULL, date_part TEXT NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY(project_id, key, branch, date_part)
    ) STRICT;
    CREATE TABLE build_number_last (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key TEXT NOT NULL,
      branch TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(project_id, key, branch)
    ) STRICT;
    CREATE TABLE build_number_reservations (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key TEXT NOT NULL,
      reservation TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, key, reservation)
    ) STRICT;`)
  },
]

export function migrateMaster(db: DatabaseSync): void {
  // The distribution tables (accounts, apps, builds, devices, keys) come first.
  migrate(db)
  db.exec(
    'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  )
  const row = db
    .prepare("SELECT value FROM meta WHERE key='master_schema'")
    .get() as { value: string } | undefined
  const current = row == null ? 0 : Number(row.value)
  if (current > MASTER_SCHEMA)
    throw new Error('Database belongs to a newer Mason version')
  for (let version = current + 1; version <= MASTER_SCHEMA; version++) {
    db.exec('BEGIN IMMEDIATE')
    try {
      migrations[version - 1]!(db)
      db.prepare(
        "INSERT INTO meta(key,value) VALUES('master_schema',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(version))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
