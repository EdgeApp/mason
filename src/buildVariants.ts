import type { DatabaseSync } from 'node:sqlite'

const COLUMNS =
  'id,app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,deleted_at,changelog,source,custom_fields'

/**
 * Schema 8: a build is one variant of a publication — the default (`''`)
 * or a named one — and records the pipeline run that published it, so one
 * run's variants show and expire as one build. Existing builds become the
 * default variant, with the run their custom fields name (`mason.run`, set
 * on pipeline publications), so they still group by run. Numbers and files
 * are unique per variant. Rebuilt without renaming the old table,
 * preserving dependent foreign keys.
 */
export function migrateBuildVariants(db: DatabaseSync): void {
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
      variant TEXT NOT NULL DEFAULT '', run TEXT,
      UNIQUE(channel_id, branch, variant, digest), UNIQUE(channel_id, branch, variant, build_number)
    ) STRICT;
    INSERT INTO builds_next(${COLUMNS},run)
      SELECT ${COLUMNS},CASE WHEN json_valid(custom_fields) THEN json_extract(custom_fields,'$.mason.run') END FROM builds;
    DROP TABLE builds;
    ALTER TABLE builds_next RENAME TO builds;
    CREATE INDEX build_catalog ON builds(app_id, branch, platform, published_at DESC);
    CREATE INDEX build_expiry ON builds(state, expires_at);
    PRAGMA user_version=8;`)
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
