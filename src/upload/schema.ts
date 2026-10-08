import type { DatabaseSync } from 'node:sqlite'
export function migrateUploads(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, apps TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
    ) STRICT;
    PRAGMA user_version=4;
    COMMIT;`)
}
