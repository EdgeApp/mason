import { migrateAdmin } from './admin/schema.js'
import { migrateDevices } from './devices/schema.js'
import { migrateBranchNumbers } from './branchNumbers.js'
import { migrateBuildVariants } from './buildVariants.js'
import { migrateUploads } from './upload/schema.js'
import { migrateCatalog } from './catalog/schema.js'
import { migrateAuth } from './auth/schema.js'
import type { DatabaseSync } from 'node:sqlite'
import { asObject } from 'cleaners'
import { integer } from './validation.js'

export function migrate(db: DatabaseSync): void {
  const version = asObject({ user_version: integer() })(
    db.prepare('PRAGMA user_version').get(),
  ).user_version
  if (version > 8) throw new Error('Database belongs to a newer Mason version')
  if (version < 1)
    db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
      is_tester INTEGER NOT NULL DEFAULT 0 CHECK(is_tester IN (0,1)),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
      permission_version INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE apps (
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position >= 0), enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
    ) STRICT;
    CREATE TABLE channels (
      id INTEGER PRIMARY KEY, app_id INTEGER NOT NULL REFERENCES apps(id), platform TEXT NOT NULL,
      channel_key TEXT NOT NULL UNIQUE, formats TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      UNIQUE(app_id, platform)
    ) STRICT;
    CREATE TABLE builds (
      id INTEGER PRIMARY KEY, app_id INTEGER NOT NULL REFERENCES apps(id), channel_id INTEGER NOT NULL REFERENCES channels(id),
      platform TEXT NOT NULL, branch TEXT NOT NULL, commit_hash TEXT NOT NULL, version TEXT NOT NULL,
      build_number TEXT NOT NULL, bundle_id TEXT NOT NULL, format TEXT NOT NULL, digest TEXT NOT NULL,
      size INTEGER NOT NULL CHECK(size > 0), file_key TEXT NOT NULL UNIQUE, published_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('ready','deleting','deleted')),
      deleted_at INTEGER, changelog TEXT NOT NULL, source TEXT NOT NULL, custom_fields TEXT NOT NULL,
      UNIQUE(channel_id, branch, digest), UNIQUE(channel_id, build_number)
    ) STRICT;
    CREATE INDEX build_catalog ON builds(app_id, branch, platform, published_at DESC);
    CREATE INDEX build_expiry ON builds(state, expires_at);
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    PRAGMA user_version=1;
    COMMIT;`)
  if (version < 2) migrateAuth(db)
  if (version < 3) migrateCatalog(db)
  if (version < 4) migrateUploads(db)
  if (version < 5) migrateBranchNumbers(db)
  if (version < 6) migrateDevices(db)
  if (version < 7) migrateAdmin(db)
  if (version < 8) migrateBuildVariants(db)
}
