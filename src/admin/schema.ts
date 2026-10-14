import type { DatabaseSync } from 'node:sqlite'

/** Operator keys carry a role: upload keys publish, admin keys manage apps. */
export function migrateAdmin(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'upload' CHECK(role IN ('upload','admin'));
    PRAGMA user_version=7;
    COMMIT;`)
}
