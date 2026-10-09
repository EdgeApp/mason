import type { DatabaseSync } from 'node:sqlite'

/** Rebuild without renaming the old table, preserving dependent foreign keys. */
export function migrateBranchNumbers(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys=OFF')
  try {
    db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE builds_next (
      id INTEGER PRIMARY KEY, app_id INTEGER NOT NULL REFERENCES apps(id), channel_id INTEGER NOT NULL REFERENCES channels(id),
      platform TEXT NOT NULL, branch TEXT NOT NULL, commit_hash TEXT NOT NULL, version TEXT NOT NULL,
      build_number TEXT NOT NULL, bundle_id TEXT NOT NULL, format TEXT NOT NULL, digest TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size > 0), file_key TEXT NOT NULL UNIQUE, published_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('ready','deleting','deleted')),
      deleted_at INTEGER, changelog TEXT NOT NULL, source TEXT NOT NULL, custom_fields TEXT NOT NULL,
      UNIQUE(channel_id, branch, digest), UNIQUE(channel_id, branch, build_number)
    ) STRICT;
    INSERT INTO builds_next SELECT * FROM builds;
    DROP TABLE builds;
    ALTER TABLE builds_next RENAME TO builds;
    CREATE INDEX build_catalog ON builds(app_id, branch, platform, published_at DESC);
    CREATE INDEX build_expiry ON builds(state, expires_at);
    PRAGMA user_version=5;`)
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Invalid migrated foreign keys')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.exec('PRAGMA foreign_keys=ON')
  }
}
