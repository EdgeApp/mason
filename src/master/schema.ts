import type { DatabaseSync } from 'node:sqlite'

/**
 * The master's own tables, versioned in `meta` under `master_schema` so the
 * distribution tables can keep their `PRAGMA user_version` migrations.
 */
export const MASTER_SCHEMA = 1

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
]

export function migrateMaster(db: DatabaseSync): void {
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
