import type { DatabaseSync } from 'node:sqlite'
export function migrateCatalog(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE install_grants (
      hash TEXT PRIMARY KEY, build_id INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX grant_expiry ON install_grants(expires_at);
    PRAGMA user_version=3;
    COMMIT;`)
}
