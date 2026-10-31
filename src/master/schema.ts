import type { DatabaseSync } from 'node:sqlite'
import { migrate } from '../schema.js'

/**
 * The master's own tables, versioned in `meta` under `master_schema` so the
 * distribution tables can keep their `PRAGMA user_version` migrations.
 */
export const MASTER_SCHEMA = 22

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
  (db): void => {
    db.exec(`
    ALTER TABLE nodes ADD COLUMN slots INTEGER NOT NULL DEFAULT 1 CHECK(slots BETWEEN 1 AND 64);
    ALTER TABLE nodes ADD COLUMN workspace_roots TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE projects ADD COLUMN repositories TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE projects ADD COLUMN tag_pushes INTEGER NOT NULL DEFAULT 0 CHECK(tag_pushes IN (0,1));
    ALTER TABLE jobs ADD COLUMN description TEXT;
    ALTER TABLE jobs ADD COLUMN graph_key TEXT;
    ALTER TABLE jobs ADD COLUMN restart_of TEXT;
    ALTER TABLE jobs ADD COLUMN restart_from TEXT;
    ALTER TABLE jobs ADD COLUMN concurrency TEXT;
    ALTER TABLE jobs ADD COLUMN deadline INTEGER;
    ALTER TABLE jobs ADD COLUMN reason TEXT;
    CREATE TABLE graphs (
      key TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      branch TEXT NOT NULL, commit_sha TEXT NOT NULL, workflow TEXT NOT NULL,
      graph TEXT NOT NULL, created INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX graphs_branch ON graphs(project_id, branch, created);
    CREATE TABLE job_stages (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, name TEXT NOT NULL,
      position INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0, worker TEXT, assigned INTEGER, started INTEGER, finished INTEGER,
      deadline INTEGER, disconnected INTEGER NOT NULL DEFAULT 0 CHECK(disconnected IN (0,1)),
      log_seq INTEGER NOT NULL DEFAULT 0, step_seq INTEGER NOT NULL DEFAULT 0,
      output TEXT, reason TEXT, reused INTEGER NOT NULL DEFAULT 0 CHECK(reused IN (0,1)),
      token TEXT, approval TEXT, cancel INTEGER NOT NULL DEFAULT 0 CHECK(cancel IN (0,1)),
      PRIMARY KEY(job_id, name)
    ) STRICT;
    CREATE INDEX job_stages_worker ON job_stages(worker, status);
    CREATE TABLE job_steps (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, stage TEXT NOT NULL,
      attempt INTEGER NOT NULL, id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, ms INTEGER, at INTEGER NOT NULL,
      PRIMARY KEY(job_id, stage, attempt, id)
    ) STRICT;
    CREATE TABLE stashes (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, name TEXT NOT NULL,
      stage TEXT NOT NULL, size INTEGER NOT NULL, file TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY(job_id, name)
    ) STRICT;
    CREATE TABLE worker_inventory (
      fingerprint TEXT PRIMARY KEY, inventory TEXT NOT NULL, quarantine TEXT, updated INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE resource_locks (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
      job_id TEXT NOT NULL, stage TEXT NOT NULL, PRIMARY KEY(project_id, name)
    ) STRICT;
    CREATE TABLE schedule_fires (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, workflow TEXT NOT NULL,
      branch TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(project_id, workflow, branch, at)
    ) STRICT;`)
  },
  (db): void => {
    db.exec(`
    CREATE TABLE host_receipts (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('device','prepare','artifact')),
      host TEXT NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE xcode_mirrors (
      version TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL
    ) STRICT;`)
  },
  (db): void => {
    db.exec(`
    CREATE TABLE cloud_machines (
      id INTEGER PRIMARY KEY, pool TEXT NOT NULL, provider_id TEXT, address TEXT, port INTEGER,
      fingerprint TEXT, size TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('creating','pairing','ready','retiring','snapshotting','destroyed')),
      created_at INTEGER NOT NULL, ready_at INTEGER, last_used INTEGER, destroyed_at INTEGER,
      from_snapshot INTEGER, error TEXT
    ) STRICT;
    CREATE INDEX cloud_machines_state ON cloud_machines(state);
    CREATE TABLE cloud_snapshots (
      id INTEGER PRIMARY KEY, pool TEXT NOT NULL, provider_id TEXT NOT NULL, source_machine INTEGER,
      size_gb REAL NOT NULL, version TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
    ) STRICT;`)
  },
  (db): void => {
    db.exec(`
    CREATE TABLE build_reservations (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, stage TEXT NOT NULL,
      attempt INTEGER NOT NULL, project_id INTEGER NOT NULL, app_id INTEGER NOT NULL, platform TEXT NOT NULL,
      build_number TEXT NOT NULL, created_at INTEGER NOT NULL, build_id INTEGER, staged_at INTEGER
    ) STRICT;
    CREATE INDEX build_reservations_job ON build_reservations(job_id, stage, attempt);
    CREATE TABLE run_artifacts (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, stage TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, visible_to TEXT, entry TEXT,
      storage_key TEXT NOT NULL, created_at INTEGER NOT NULL, deleting INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(job_id, name)
    ) STRICT;
    CREATE TABLE run_tests (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, stage TEXT NOT NULL, attempt INTEGER NOT NULL,
      summary TEXT NOT NULL, PRIMARY KEY(job_id, stage, attempt)
    ) STRICT;`)
  },
  (db): void => {
    db.exec(`
    ALTER TABLE accounts ADD COLUMN removed_at INTEGER;
    CREATE TABLE master_sessions (
      hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      permission_version INTEGER NOT NULL, csrf TEXT NOT NULL, address TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX master_sessions_account ON master_sessions(account_id);
    CREATE TABLE sign_in_failures (
      key TEXT PRIMARY KEY, failures INTEGER NOT NULL, first_at INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE backup_confirmations (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      key_digest TEXT NOT NULL, confirmed_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE backup_runs (
      id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
      kind TEXT NOT NULL DEFAULT 'commit' CHECK(kind IN ('commit','orphan')),
      commit_sha TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 1
    ) STRICT;`)
  },
  (db): void => {
    db.exec(`
    ALTER TABLE project_apps ADD COLUMN apple TEXT;
    ALTER TABLE projects ADD COLUMN signing_label TEXT;
    CREATE TABLE apple_certificates (
      id INTEGER PRIMARY KEY, team_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('development','distribution','developerIdApplication','developerIdInstaller')),
      apple_id TEXT, serial TEXT NOT NULL, name TEXT NOT NULL, sha1 TEXT NOT NULL,
      certificate TEXT NOT NULL, private_key TEXT NOT NULL, expires_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('p12','match','created')),
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), created_at INTEGER NOT NULL,
      UNIQUE(team_id, serial)
    ) STRICT;
    CREATE TABLE apple_bundle_ids (
      team_id TEXT NOT NULL, identifier TEXT NOT NULL, apple_id TEXT NOT NULL,
      platform TEXT NOT NULL, capabilities TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
      PRIMARY KEY(team_id, identifier)
    ) STRICT;
    CREATE TABLE apple_profiles (
      id INTEGER PRIMARY KEY, team_id TEXT NOT NULL, bundle_id TEXT NOT NULL,
      distribution TEXT NOT NULL, apple_id TEXT NOT NULL, name TEXT NOT NULL, uuid TEXT NOT NULL,
      content TEXT NOT NULL, expires_at INTEGER NOT NULL, certificate_id INTEGER NOT NULL,
      devices TEXT NOT NULL, capabilities TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
    ) STRICT;
    CREATE INDEX apple_profiles_current ON apple_profiles(team_id, bundle_id, distribution) WHERE deleted_at IS NULL;
    CREATE TABLE apple_cache (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE apple_uploads (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, stage TEXT NOT NULL, team_id TEXT NOT NULL,
      app_id TEXT NOT NULL, file_id TEXT NOT NULL, options TEXT NOT NULL,
      state TEXT NOT NULL, build_id TEXT, result TEXT, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE apple_submissions (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, stage TEXT NOT NULL, team_id TEXT NOT NULL,
      name TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;`)
  },
  // 10: where each step's lines are in its stage log, so a step can show only its own.
  (db): void => {
    db.exec(`ALTER TABLE job_steps ADD COLUMN log_start INTEGER;
    ALTER TABLE job_steps ADD COLUMN log_end INTEGER;`)
  },
  // 11: cloud accounts. The `cloud` area's token becomes the `digitalocean`
  // account, every pool names it, and machines and snapshots record theirs.
  (db): void => {
    db.exec(`ALTER TABLE cloud_machines ADD COLUMN account TEXT;
    ALTER TABLE cloud_snapshots ADD COLUMN account TEXT;`)
    const row = db
      .prepare("SELECT value FROM settings WHERE area='cloud'")
      .get() as { value: string } | undefined
    if (row == null) return
    const cloud = JSON.parse(row.value) as {
      token?: string
      pools?: Array<Record<string, unknown>>
    }
    const { token, ...rest } = cloud
    if (token != null) {
      db.prepare(
        "INSERT INTO settings(area,value,updated_at,updated_by) VALUES('cloudAccounts',?,?,'migration') ON CONFLICT(area) DO NOTHING",
      ).run(
        JSON.stringify({
          accounts: [
            {
              id: 'digitalocean',
              name: 'DigitalOcean',
              provider: 'digitalocean',
              key: token,
            },
          ],
        }),
        Date.now(),
      )
      db.exec(
        "UPDATE cloud_machines SET account='digitalocean'; UPDATE cloud_snapshots SET account='digitalocean';",
      )
    }
    db.prepare("UPDATE settings SET value=? WHERE area='cloud'").run(
      JSON.stringify({
        ...rest,
        pools: (rest.pools ?? []).map((pool) => ({
          ...pool,
          account: pool.account ?? 'digitalocean',
        })),
      }),
    )
  },
  // 12: Mason hosts the master made on a cloud provider, reconciled from these rows.
  (db): void => {
    db.exec(`
    CREATE TABLE cloud_hosts (
      name TEXT NOT NULL, account TEXT NOT NULL, provider TEXT NOT NULL,
      region TEXT NOT NULL, size TEXT NOT NULL, image TEXT NOT NULL,
      dns_domain TEXT, dns_name TEXT, provider_id TEXT, address TEXT, port INTEGER,
      dns_record_id TEXT, dns_owned INTEGER NOT NULL DEFAULT 0 CHECK(dns_owned IN (0,1)),
      fingerprint TEXT, pairing_hash TEXT, pairing_secret TEXT, origin TEXT,
      state TEXT NOT NULL CHECK(state IN ('creating','installing','pairing','ready','error','removing','removed')),
      error TEXT, version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX cloud_hosts_name ON cloud_hosts(name) WHERE state<>'removed';`)
  },
  // 13: when a host's DNS name first answered with a trusted certificate.
  (db): void => {
    db.exec('ALTER TABLE cloud_hosts ADD COLUMN certificate_at INTEGER;')
  },
  // 14: a cloud host's DigitalOcean Space for its builds, and the key limited to it.
  (db): void => {
    db.exec(`ALTER TABLE cloud_hosts ADD COLUMN space_bucket TEXT;
    ALTER TABLE cloud_hosts ADD COLUMN space_region TEXT;
    ALTER TABLE cloud_hosts ADD COLUMN space_key_id TEXT;
    ALTER TABLE cloud_hosts ADD COLUMN space_secret TEXT;
    ALTER TABLE cloud_hosts ADD COLUMN space_owned INTEGER NOT NULL DEFAULT 0 CHECK(space_owned IN (0,1));
    ALTER TABLE cloud_hosts ADD COLUMN space_key_owned INTEGER NOT NULL DEFAULT 0 CHECK(space_key_owned IN (0,1));
    ALTER TABLE cloud_hosts ADD COLUMN space_pending INTEGER NOT NULL DEFAULT 0 CHECK(space_pending IN (0,1));`)
  },
  // 15: a cloud host restarting into the release its master asked for.
  (db): void => {
    db.exec(`
    CREATE TABLE cloud_hosts_15 (
      name TEXT NOT NULL, account TEXT NOT NULL, provider TEXT NOT NULL,
      region TEXT NOT NULL, size TEXT NOT NULL, image TEXT NOT NULL,
      dns_domain TEXT, dns_name TEXT, provider_id TEXT, address TEXT, port INTEGER,
      dns_record_id TEXT, dns_owned INTEGER NOT NULL DEFAULT 0 CHECK(dns_owned IN (0,1)),
      fingerprint TEXT, pairing_hash TEXT, pairing_secret TEXT, origin TEXT,
      state TEXT NOT NULL CHECK(state IN ('creating','installing','pairing','ready','updating','error','removing','removed')),
      error TEXT, version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      certificate_at INTEGER,
      space_bucket TEXT, space_region TEXT, space_key_id TEXT, space_secret TEXT,
      space_owned INTEGER NOT NULL DEFAULT 0 CHECK(space_owned IN (0,1)),
      space_key_owned INTEGER NOT NULL DEFAULT 0 CHECK(space_key_owned IN (0,1)),
      space_pending INTEGER NOT NULL DEFAULT 0 CHECK(space_pending IN (0,1))
    ) STRICT;
    INSERT INTO cloud_hosts_15 SELECT name,account,provider,region,size,image,
      dns_domain,dns_name,provider_id,address,port,dns_record_id,dns_owned,
      fingerprint,pairing_hash,pairing_secret,origin,state,error,version,
      created_at,updated_at,certificate_at,space_bucket,space_region,
      space_key_id,space_secret,space_owned,space_key_owned,space_pending
      FROM cloud_hosts;
    DROP TABLE cloud_hosts;
    ALTER TABLE cloud_hosts_15 RENAME TO cloud_hosts;
    CREATE UNIQUE INDEX cloud_hosts_name ON cloud_hosts(name) WHERE state<>'removed';`)
  },
  // 16: permanent cloud nodes beside the host: each row's role, and a node's type and labels.
  (db): void => {
    db.exec(`
    CREATE TABLE cloud_hosts_16 (
      name TEXT NOT NULL, account TEXT NOT NULL, provider TEXT NOT NULL,
      region TEXT NOT NULL, size TEXT NOT NULL, image TEXT NOT NULL,
      dns_domain TEXT, dns_name TEXT, provider_id TEXT, address TEXT, port INTEGER,
      dns_record_id TEXT, dns_owned INTEGER NOT NULL DEFAULT 0 CHECK(dns_owned IN (0,1)),
      fingerprint TEXT, pairing_hash TEXT, pairing_secret TEXT, origin TEXT,
      state TEXT NOT NULL CHECK(state IN ('creating','installing','pairing','ready','updating','error','removing','removed')),
      error TEXT, version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      certificate_at INTEGER,
      space_bucket TEXT, space_region TEXT, space_key_id TEXT, space_secret TEXT,
      space_owned INTEGER NOT NULL DEFAULT 0 CHECK(space_owned IN (0,1)),
      space_key_owned INTEGER NOT NULL DEFAULT 0 CHECK(space_key_owned IN (0,1)),
      space_pending INTEGER NOT NULL DEFAULT 0 CHECK(space_pending IN (0,1)),
      role TEXT NOT NULL DEFAULT 'host' CHECK(role IN ('host','worker')),
      node_type TEXT, labels TEXT NOT NULL DEFAULT '[]'
    ) STRICT;
    INSERT INTO cloud_hosts_16(name,account,provider,region,size,image,
      dns_domain,dns_name,provider_id,address,port,dns_record_id,dns_owned,
      fingerprint,pairing_hash,pairing_secret,origin,state,error,version,
      created_at,updated_at,certificate_at,space_bucket,space_region,
      space_key_id,space_secret,space_owned,space_key_owned,space_pending)
      SELECT name,account,provider,region,size,image,
      dns_domain,dns_name,provider_id,address,port,dns_record_id,dns_owned,
      fingerprint,pairing_hash,pairing_secret,origin,state,error,version,
      created_at,updated_at,certificate_at,space_bucket,space_region,
      space_key_id,space_secret,space_owned,space_key_owned,space_pending
      FROM cloud_hosts;
    DROP TABLE cloud_hosts;
    ALTER TABLE cloud_hosts_16 RENAME TO cloud_hosts;
    CREATE UNIQUE INDEX cloud_hosts_name ON cloud_hosts(name) WHERE state<>'removed';`)
  },
  // 17: what pushed each backup: the deploy key or the GitHub connection.
  (db): void => {
    const columns = db.prepare('PRAGMA table_info(backup_runs)').all()
    if (!columns.some((column) => column.name === 'auth'))
      db.exec('ALTER TABLE backup_runs ADD COLUMN auth TEXT')
  },
  // 18: secrets become variants (values or files, each limited to build
  // configs), with an audit of every view and change.
  (db): void => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS project_secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('value','file')),
      configs TEXT NOT NULL DEFAULT '', contents TEXT NOT NULL,
      text INTEGER NOT NULL CHECK(text IN (0,1)),
      masked INTEGER NOT NULL DEFAULT 1 CHECK(masked IN (0,1)),
      path_env TEXT, destination TEXT, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(project_id, name, configs)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS secret_audit (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, configs TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('viewed','added','edited','replaced','deleted','configs changed','refused')),
      account_id INTEGER REFERENCES accounts(id), key_id TEXT, via TEXT NOT NULL,
      address TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS secret_audit_project ON secret_audit(project_id, id);`)
    const legacy = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='project_env'",
      )
      .get()
    if (legacy == null) return
    // This step keeps its own copy of the legacy mapping (secrets.ts
    // legacyRows does the same for mason import): a migration must do what it
    // did when it shipped, whatever later changes make to the live code.
    const now = Date.now()
    const insert = db.prepare(
      "INSERT INTO project_secrets(project_id,name,kind,configs,contents,text,masked,path_env,destination,bytes,updated_at) VALUES(?,?,?,'',?,?,?,?,?,?,?)",
    )
    for (const project of db.prepare('SELECT id,format FROM projects').all()) {
      const id = Number(project.id)
      // Values keep their names. A pipeline file is named by its variable,
      // else its destination, as stages declared it; a script file by its
      // destination, which it keeps to be injected at. A name that is not a
      // safe relative path has its other characters replaced, and a taken
      // name falls back to the destination, then gains .file until free.
      const taken = new Set<string>()
      for (const row of db
        .prepare(
          'SELECT name,value,secret FROM project_env WHERE project_id=? ORDER BY name',
        )
        .all(id)) {
        taken.add(String(row.name))
        insert.run(
          id,
          String(row.name),
          'value',
          String(row.value),
          1,
          row.secret === 1 ? 1 : 0,
          null,
          null,
          Buffer.byteLength(String(row.value)),
          now,
        )
      }
      const safe = (name: string): string =>
        name
          .split('/')
          .map((part) =>
            part.toLowerCase() === '.git'
              ? '_git'
              : part === '.' || part === '..' || part === ''
                ? '_'
                : part.replace(/[^A-Za-z0-9_.-]/g, '_'),
          )
          .join('/')
      for (const row of db
        .prepare(
          'SELECT destination,contents,env FROM project_files WHERE project_id=? ORDER BY env IS NULL, destination',
        )
        .all(id)) {
        const destination = String(row.destination)
        const env = row.env == null ? null : String(row.env)
        let name = safe(
          project.format === 'script' ? destination : (env ?? destination),
        )
        if (taken.has(name)) name = safe(destination)
        while (taken.has(name)) name += '.file'
        taken.add(name)
        const bytes = Buffer.from(String(row.contents), 'base64')
        let text = !bytes.includes(0)
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          text = false
        }
        insert.run(
          id,
          name,
          'file',
          String(row.contents),
          text ? 1 : 0,
          1,
          env,
          project.format === 'script' ? destination : null,
          bytes.length,
          now,
        )
      }
    }
    db.exec('DROP TABLE project_env; DROP TABLE project_files;')
  },
  // 19: a run's build number may be a block of numbers, N to N+block−1.
  (db): void => {
    for (const table of ['build_number_reservations', 'build_reservations'])
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((column) => column.name === 'block')
      )
        db.exec(
          `ALTER TABLE ${table} ADD COLUMN block INTEGER NOT NULL DEFAULT 1`,
        )
  },
  // 20: the Zealot upload API left the cluster, and its upload keys with it.
  (db): void => {
    db.exec("DELETE FROM api_keys WHERE role='upload'")
  },
  // 21: a reservation may publish several variants; each is recorded here.
  // A staged publication from before has no digest yet; its confirm sets it.
  // build_reservations.build_id and staged_at stay in the table but are no
  // longer read or written.
  (db): void => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS build_publications (
      reservation_id TEXT NOT NULL REFERENCES build_reservations(id) ON DELETE CASCADE,
      variant TEXT NOT NULL, digest TEXT, build_id INTEGER, staged_at INTEGER,
      PRIMARY KEY(reservation_id, variant)
    ) STRICT;
    INSERT OR IGNORE INTO build_publications(reservation_id,variant,digest,build_id,staged_at)
      SELECT r.id,'',b.digest,r.build_id,r.staged_at FROM build_reservations r LEFT JOIN builds b ON b.id=r.build_id
      WHERE r.build_id IS NOT NULL OR r.staged_at IS NOT NULL;`)
  },
  // 22: setup runs only on nodes labelled setup; every node, permanent
  // cloud worker and pool had run it, so each gains the label.
  (db): void => {
    const withSetup = (labels: unknown): string => {
      const list = JSON.parse(String(labels ?? '[]')) as unknown
      const out = Array.isArray(list) ? list.map(String) : []
      return JSON.stringify(out.includes('setup') ? out : [...out, 'setup'])
    }
    for (const row of db.prepare('SELECT fingerprint,labels FROM nodes').all())
      db.prepare('UPDATE nodes SET labels=? WHERE fingerprint=?').run(
        withSetup(row.labels),
        String(row.fingerprint),
      )
    for (const row of db
      .prepare("SELECT rowid,labels FROM cloud_hosts WHERE role='worker'")
      .all())
      db.prepare('UPDATE cloud_hosts SET labels=? WHERE rowid=?').run(
        withSetup(row.labels),
        Number(row.rowid),
      )
    const cloud = db
      .prepare("SELECT value FROM settings WHERE area='cloud'")
      .get() as { value: string } | undefined
    if (cloud == null) return
    const value = JSON.parse(cloud.value) as {
      pools?: Array<{ labels?: unknown }>
    }
    if (!Array.isArray(value.pools)) return
    for (const pool of value.pools)
      pool.labels = JSON.parse(withSetup(JSON.stringify(pool.labels ?? [])))
    db.prepare("UPDATE settings SET value=? WHERE area='cloud'").run(
      JSON.stringify(value),
    )
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
