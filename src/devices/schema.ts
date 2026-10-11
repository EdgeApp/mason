import type { DatabaseSync } from 'node:sqlite'
export function migrateDevices(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE install_grants ADD COLUMN device_id INTEGER REFERENCES devices(id);
    CREATE TABLE devices(id INTEGER PRIMARY KEY, udid TEXT NOT NULL UNIQUE,
      product TEXT NOT NULL, model TEXT NOT NULL, os_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','registered','error')),
      message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE account_devices(account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_id INTEGER NOT NULL REFERENCES devices(id), name TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(account_id,device_id)) STRICT;
    CREATE TABLE device_challenges(hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, device_id INTEGER REFERENCES devices(id)) STRICT;
    CREATE TABLE build_provisioning(build_id INTEGER PRIMARY KEY REFERENCES builds(id) ON DELETE CASCADE,
      devices TEXT NOT NULL, expires_at INTEGER NOT NULL, team TEXT NOT NULL) STRICT;
    CREATE TABLE device_build_requests(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
      device_id INTEGER NOT NULL REFERENCES devices(id), build_id INTEGER NOT NULL REFERENCES builds(id),
      status TEXT NOT NULL DEFAULT 'pending', message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL) STRICT;
    CREATE UNIQUE INDEX device_build_pending ON device_build_requests(device_id,build_id) WHERE status='pending';
    PRAGMA user_version=6;
    COMMIT;`)
}
