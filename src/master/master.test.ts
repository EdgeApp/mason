import assert from 'node:assert/strict'
import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
} from '../auth/passwordProtocol.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import { nodeMain, type MainIO } from '../node/main.js'
import { startNode, statusFromFiles, type RunningNode } from '../node/serve.js'
import { deploymentFixture } from '../test/deployment.js'
import { createFirstAdmin } from '../setup/setup.js'
import { withStoppedMaster } from '../setup/cli.js'
import { MasterDatabase } from './database.js'
import { importDeployment, ImportRefused } from './import.js'
import { MasterKeys } from './keys.js'
import {
  decoyParameters,
  passwordMatches,
  readPasswordRecord,
} from './passwords.js'
import { localOperator } from './roles.js'
import { migrateMaster, MASTER_SCHEMA } from './schema.js'
import { keepSecret } from './settings.js'

let root: string
// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const quiet = (): void => undefined

async function master(
  name = 'm',
  extra: Partial<Parameters<typeof startNode>[0]> = {},
): Promise<RunningNode> {
  return await startNode(
    {
      role: 'master',
      data: path.join(root, name),
      port: 0,
      listen: '127.0.0.1',
      heartbeatMs: 0,
      ...extra,
    },
    quiet,
  )
}
async function setupRequest(
  username = 'paul',
  password = 'Correct-Horse-9',
  apiKey = true,
): Promise<Record<string, unknown>> {
  const parameters = clientParameters('0f'.repeat(16), DEFAULT_PASSWORD_COSTS)
  return {
    username,
    clientHash: await clientPasswordHash(password, parameters),
    clientParameters: parameters,
    apiKey,
  }
}
function io(
  extra: Partial<MainIO> = {},
): MainIO & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    system: (): never => {
      throw new Error('unused')
    },
    stopped: async () => undefined,
    program: () => [],
    passwordCosts: DEFAULT_PASSWORD_COSTS,
    ...extra,
  }
}
/** Calls the master's API with a bearer key, trusting it by pin. */
async function api(
  node: RunningNode,
  method: string,
  route: string,
  key?: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await pinnedFetch(
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:') + route,
    {
      method,
      headers: {
        ...(key == null ? {} : { Authorization: `Bearer ${key}` }),
        ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
    },
    node.identity.pin,
  )
  const text = await response.text()
  return {
    status: response.status,
    json: text === '' ? null : JSON.parse(text),
  }
}

describe('Master database, setup and import', function () {
  this.timeout(60000)
  beforeEach(() => {
    process.umask(0o077)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'master-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates and migrates the schema idempotently and refuses a newer one', () => {
    const db = new DatabaseSync(path.join(root, 'm.sqlite'), {
      enableForeignKeyConstraints: true,
    })
    migrateMaster(db)
    migrateMaster(db)
    assert.equal(
      (
        db
          .prepare("SELECT value FROM meta WHERE key='master_schema'")
          .get() as { value: string }
      ).value,
      String(MASTER_SCHEMA),
    )
    assert.equal(
      (db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
      7,
    )
    for (const table of [
      'accounts',
      'account_addresses',
      'groups',
      'group_apps',
      'group_members',
      'api_keys',
      'projects',
      'project_apps',
      'project_secrets',
      'secret_audit',
      'branch_rules',
      'settings',
      'change_log',
      'nodes',
      'builds',
      'devices',
    ])
      assert(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table) != null,
        table,
      )
    db.prepare("UPDATE meta SET value='99' WHERE key='master_schema'").run()
    assert.throws(() => migrateMaster(db), /newer Mason/)
    db.close()
    const newer = new DatabaseSync(path.join(root, 'n.sqlite'))
    newer.exec('PRAGMA user_version=8')
    assert.throws(() => migrateMaster(newer), /newer Mason/)
    newer.close()
  })

  it('U1.1 schema 17 makes every known Space a storage location: the storage setting’s, and each cloud host’s', () => {
    const db = new DatabaseSync(path.join(root, 'locations.sqlite'))
    migrateMaster(db)
    db.exec(`DROP TABLE storage_locations;
    UPDATE meta SET value='16' WHERE key='master_schema';
    INSERT INTO cloud_hosts(name,account,provider,region,size,image,state,created_at,updated_at,space_bucket,space_region,space_key_id,space_secret,space_owned,space_key_owned,role)
      VALUES('h','do','digitalocean','sfo3','s','i','ready',1,2,'host-space','sfo3','HOSTKEY12345','host-secret-1',1,1,'host'),
            ('gone','do','digitalocean','sfo3','s','i','removed',1,2,'old-space','sfo3','OLDKEY123456','old-secret-12',1,1,'host');`)
    db.prepare(
      "INSERT INTO settings(area,value,updated_at,updated_by) VALUES('storage',?,1,'paul')",
    ).run(
      JSON.stringify({
        driver: 's3',
        s3: {
          endpoint: 'https://nyc3.digitaloceanspaces.com',
          bucket: 'made-space',
          region: 'nyc3',
          accessKeyId: 'MADEKEY12345',
          secretAccessKey: 'made-secret-1',
        },
        managed: { account: 'do', keyId: 'MADEKEY12345' },
      }),
    )
    migrateMaster(db)
    migrateMaster(db)
    assert.deepEqual(
      (
        db
          .prepare(
            'SELECT id,bucket,origin,bucket_owned,key_owned,account,key_id,host FROM storage_locations ORDER BY bucket',
          )
          .all() as object[]
      ).map((row) => ({ ...row })),
      [
        {
          id: 'space-host-space-sfo3.digitaloceanspaces.com',
          bucket: 'host-space',
          origin: 'host',
          bucket_owned: 1,
          key_owned: 1,
          account: 'do',
          key_id: 'HOSTKEY12345',
          host: 'h',
        },
        {
          id: 'space-made-space-nyc3.digitaloceanspaces.com',
          bucket: 'made-space',
          origin: 'made',
          bucket_owned: 1,
          key_owned: 1,
          account: 'do',
          key_id: 'MADEKEY12345',
          host: null,
        },
      ],
    )
    db.close()
  })

  it('U2.1 schema 15 keeps every cloud host and lets one be updating', () => {
    const db = new DatabaseSync(path.join(root, 'hosts.sqlite'))
    migrateMaster(db)
    // Back to schema 14's cloud_hosts, with a host in it.
    db.exec(`DROP TABLE cloud_hosts;
    CREATE TABLE cloud_hosts (
      name TEXT NOT NULL, account TEXT NOT NULL, provider TEXT NOT NULL,
      region TEXT NOT NULL, size TEXT NOT NULL, image TEXT NOT NULL,
      dns_domain TEXT, dns_name TEXT, provider_id TEXT, address TEXT, port INTEGER,
      dns_record_id TEXT, dns_owned INTEGER NOT NULL DEFAULT 0 CHECK(dns_owned IN (0,1)),
      fingerprint TEXT, pairing_hash TEXT, pairing_secret TEXT, origin TEXT,
      state TEXT NOT NULL CHECK(state IN ('creating','installing','pairing','ready','error','removing','removed')),
      error TEXT, version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX cloud_hosts_name ON cloud_hosts(name) WHERE state<>'removed';
    ALTER TABLE cloud_hosts ADD COLUMN certificate_at INTEGER;
    ALTER TABLE cloud_hosts ADD COLUMN space_bucket TEXT;
    ALTER TABLE cloud_hosts ADD COLUMN space_region TEXT;
    ALTER TABLE cloud_hosts ADD COLUMN space_key_id TEXT;
    ALTER TABLE cloud_hosts ADD COLUMN space_secret TEXT;
    ALTER TABLE cloud_hosts ADD COLUMN space_owned INTEGER NOT NULL DEFAULT 0 CHECK(space_owned IN (0,1));
    ALTER TABLE cloud_hosts ADD COLUMN space_key_owned INTEGER NOT NULL DEFAULT 0 CHECK(space_key_owned IN (0,1));
    ALTER TABLE cloud_hosts ADD COLUMN space_pending INTEGER NOT NULL DEFAULT 0 CHECK(space_pending IN (0,1));
    INSERT INTO cloud_hosts(name,account,provider,region,size,image,fingerprint,state,version,created_at,updated_at,certificate_at,space_bucket,space_owned)
      VALUES('h','do','digitalocean','sfo3','s-1vcpu-1gb','ubuntu-24-04-x64','fp','ready','0.2.0',1,2,3,'b',1);
    UPDATE meta SET value='14' WHERE key='master_schema';`)
    assert.throws(() =>
      db.exec("UPDATE cloud_hosts SET state='updating' WHERE name='h'"),
    )
    migrateMaster(db)
    db.exec("UPDATE cloud_hosts SET state='updating' WHERE name='h'")
    assert.deepEqual(
      {
        ...(db
          .prepare(
            'SELECT name,fingerprint,state,version,created_at,certificate_at,space_bucket,space_owned FROM cloud_hosts',
          )
          .get() as object),
      },
      {
        name: 'h',
        fingerprint: 'fp',
        state: 'updating',
        version: '0.2.0',
        created_at: 1,
        certificate_at: 3,
        space_bucket: 'b',
        space_owned: 1,
      },
    )
    assert.throws(() =>
      db.exec("UPDATE cloud_hosts SET state='lost' WHERE name='h'"),
    )
    db.close()
  })

  it('U13.15 schema 18 records which credential pushed each backup', () => {
    const db = new DatabaseSync(path.join(root, 'auth.sqlite'))
    migrateMaster(db)
    db.exec(`ALTER TABLE backup_runs DROP COLUMN auth;
    INSERT INTO backup_runs(started_at,finished_at,status,commit_sha) VALUES(1,2,'succeeded','c');
    UPDATE meta SET value='17' WHERE key='master_schema';`)
    migrateMaster(db)
    assert.deepEqual(
      {
        ...(db
          .prepare('SELECT commit_sha,auth FROM backup_runs')
          .get() as object),
      },
      { commit_sha: 'c', auth: null },
    )
    db.exec("UPDATE backup_runs SET auth='github'")
    db.close()
  })

  it('U5.7/U12.5 schemas 20 and 21 give reservations a block and drop upload keys', () => {
    const db = new DatabaseSync(path.join(root, 'blocks.sqlite'))
    migrateMaster(db)
    db.exec(`ALTER TABLE build_number_reservations DROP COLUMN block;
    ALTER TABLE build_reservations DROP COLUMN block;
    INSERT INTO projects(id,slug,name,repository,format,timeout_seconds,created_at)
      VALUES(1,'p','P','https://github.com/a/p','pipeline',60,0);
    INSERT INTO build_number_reservations(project_id,key,reservation,value,created_at) VALUES(1,'app','run1','7',0);
    INSERT INTO api_keys(id,hash,name,apps,created_at,role) VALUES
      ('u','${'a'.repeat(64)}','zealot','[1]',0,'upload'),
      ('d','${'b'.repeat(64)}','ci','"all"',0,'developer');
    UPDATE meta SET value='19' WHERE key='master_schema';`)
    migrateMaster(db)
    assert.deepEqual(
      {
        ...(db
          .prepare('SELECT value,block FROM build_number_reservations')
          .get() as object),
      },
      { value: '7', block: 1 },
    )
    assert(
      db
        .prepare('PRAGMA table_info(build_reservations)')
        .all()
        .some((column) => column.name === 'block'),
    )
    assert.deepEqual(
      db
        .prepare('SELECT id FROM api_keys ORDER BY id')
        .all()
        .map((row) => row.id),
      ['d'],
    )
    // Again: nothing to add, nothing to delete.
    db.exec("UPDATE meta SET value='19' WHERE key='master_schema'")
    migrateMaster(db)
    db.close()
  })

  it('U18.10 schema 19 turns project_env and project_files into default variants and drops them', () => {
    const db = new DatabaseSync(path.join(root, 'variants.sqlite'))
    migrateMaster(db)
    const b64 = (text: string): string => Buffer.from(text).toString('base64')
    db.exec(`
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
    INSERT INTO projects(id,slug,name,repository,format,timeout_seconds,created_at)
      VALUES(1,'pipe','Pipe','https://github.com/a/pipe','pipeline',60,0),
            (2,'scr','Scr','https://github.com/a/scr','script',60,0);
    INSERT INTO project_env VALUES(1,'API_TOKEN','tok',1),(2,'CONFIG','v',1),(2,'PLAIN','p',0);
    INSERT INTO project_files VALUES
      (1,'master/config.json','${b64('{"a":1}')}',NULL),
      (1,'keystore.jks','${Buffer.from([0, 255]).toString('base64')}','ANDROID_KEYSTORE'),
      (1,'API_TOKEN','${b64('x')}',NULL),
      (1,'X.file','${b64('y')}',NULL),
      (1,'a.json','${b64('{}')}','X'),
      (1,'X','${b64('z')}',NULL),
      (1,'me@x.json','${b64('{}')}',NULL),
      (1,'.git/hooks','${Buffer.from([0, 1]).toString('base64')}',NULL),
      (2,'CONFIG','${b64('{}')}','CONFIG_FILE');
    UPDATE meta SET value='18' WHERE key='master_schema';`)
    migrateMaster(db)
    assert.deepEqual(
      db
        .prepare(
          'SELECT project_id,name,kind,configs,text,masked,path_env,destination,bytes FROM project_secrets ORDER BY project_id,name',
        )
        .all()
        .map((row) => Object.values(row)),
      [
        [1, 'ANDROID_KEYSTORE', 'file', '', 0, 1, 'ANDROID_KEYSTORE', null, 2],
        [1, 'API_TOKEN', 'value', '', 1, 1, null, null, 3],
        [1, 'API_TOKEN.file', 'file', '', 1, 1, null, null, 1],
        // Files with a variable first: a.json takes X, so the file named X gains .file,
        // past X.file, which a file already holds.
        [1, 'X', 'file', '', 1, 1, 'X', null, 2],
        [1, 'X.file', 'file', '', 1, 1, null, null, 1],
        [1, 'X.file.file', 'file', '', 1, 1, null, null, 1],
        [1, '_git/hooks', 'file', '', 0, 1, null, null, 2],
        [1, 'master/config.json', 'file', '', 1, 1, null, null, 7],
        [1, 'me_x.json', 'file', '', 1, 1, null, null, 2],
        [2, 'CONFIG', 'value', '', 1, 1, null, null, 1],
        [2, 'CONFIG.file', 'file', '', 1, 1, 'CONFIG_FILE', 'CONFIG', 2],
        [2, 'PLAIN', 'value', '', 1, 0, null, null, 1],
      ],
    )
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('project_env','project_files')",
        )
        .get()!.n,
      0,
    )
    db.close()
  })

  it('U3.1 schema 16 keeps every cloud host as a host and allows a worker row with its type and labels', () => {
    const db = new DatabaseSync(path.join(root, 'nodes.sqlite'))
    migrateMaster(db)
    db.exec(`INSERT INTO cloud_hosts(name,account,provider,region,size,image,fingerprint,state,version,created_at,updated_at,certificate_at,space_bucket,space_owned)
      VALUES('h','do','digitalocean','sfo3','s-1vcpu-1gb','ubuntu-24-04-x64','fp','ready','0.2.0',1,2,3,'b',1)`)
    const host = db.prepare('SELECT * FROM cloud_hosts').get() as Record<
      string,
      unknown
    >
    assert.equal(host.role, 'host')
    assert.equal(host.node_type, null)
    assert.equal(host.labels, '[]')
    assert.equal(host.space_owned, 1)
    db.exec(`INSERT INTO cloud_hosts(name,account,provider,region,size,image,state,role,node_type,labels,created_at,updated_at)
      VALUES('n','do','digitalocean','sfo3','s-1vcpu-1gb','ubuntu-24-04-x64','creating','worker','linux-x86','["e2e"]',1,1)`)
    assert.throws(() =>
      db.exec(`INSERT INTO cloud_hosts(name,account,provider,region,size,image,state,role,created_at,updated_at)
        VALUES('x','do','digitalocean','sfo3','s','i','creating','pool',1,1)`),
    )
    // Names are unique across hosts and nodes.
    assert.throws(() =>
      db.exec(`INSERT INTO cloud_hosts(name,account,provider,region,size,image,state,role,created_at,updated_at)
        VALUES('h','do','digitalocean','sfo3','s','i','creating','worker',1,1)`),
    )
    db.close()
  })

  it('imports the current deployment with IDs, roles, addresses, keys and projects', async () => {
    const fixture = deploymentFixture(root)
    const db = new DatabaseSync(path.join(root, 'master.sqlite'), {
      enableForeignKeyConstraints: true,
    })
    const database = new MasterDatabase(db)
    const summary = importDeployment(database, fixture)
    assert.deepEqual(
      { ...summary, adminKeys: summary.adminKeys.length },
      {
        accounts: 5,
        addresses: 5,
        invitedTesters: 1,
        groups: 1,
        apps: 3,
        channels: 2,
        builds: 3,
        devices: 1,
        keys: { admin: 1, developer: 1, uploadSkipped: 1 },
        projects: 2,
        branchRules: 4,
        adminKeys: 1,
        skippedAddresses: 1,
      },
    )
    const role = (id: number): string =>
      (
        db.prepare('SELECT role FROM accounts WHERE id=?').get(id) as {
          role: string
        }
      ).role
    assert.equal(role(fixture.accounts.admin), 'admin')
    assert.equal(role(fixture.accounts.both), 'admin')
    assert.equal(role(fixture.accounts.tester), 'tester')
    assert.equal(role(fixture.accounts.neither), 'tester')
    const addresses = db
      .prepare(
        'SELECT account_id,method,email FROM account_addresses ORDER BY account_id,method',
      )
      .all()
    assert.deepEqual(
      addresses.map((row) => [row.account_id, row.method, row.email]),
      [
        [fixture.accounts.admin, 'google', 'admin@example.test'],
        [fixture.accounts.tester, 'google', 'tester@example.test'],
        [fixture.accounts.tester, 'okta', 'tester.okta@example.test'],
        [fixture.accounts.neither, 'google', 'waiting@example.test'],
        [6, 'google', 'invited@example.test'],
      ],
    )
    // The invited tester exists with that address and no group.
    assert.equal(
      (
        db.prepare('SELECT role FROM accounts WHERE id=6').get() as {
          role: string
        }
      ).role,
      'tester',
    )
    const members = db
      .prepare('SELECT account_id FROM group_members ORDER BY account_id')
      .all()
      .map((row) => row.account_id)
    assert.deepEqual(members, [
      fixture.accounts.tester,
      fixture.accounts.both,
      fixture.accounts.disabled,
    ])
    // The group holds the deployment's existing apps.
    assert.equal(
      Number(
        (db.prepare('SELECT COUNT(*) n FROM group_apps').get() as { n: number })
          .n,
      ),
      2,
    )
    // Sessions stay with the host; device and build rows keep their IDs.
    assert.equal(
      Number(
        (db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number })
          .n,
      ),
      0,
    )
    assert.equal(
      Number(
        (db.prepare('SELECT COUNT(*) n FROM identities').get() as { n: number })
          .n,
      ),
      0,
    )
    assert.deepEqual(
      db
        .prepare('SELECT id,build_number FROM builds ORDER BY id')
        .all()
        .map((row) => row.id),
      [1, 2, 3],
    )
    assert.equal(
      (
        db.prepare('SELECT channel_key FROM channels WHERE id=1').get() as {
          channel_key: string
        }
      ).channel_key,
      'ios-key',
    )
    assert.equal(
      (db.prepare('SELECT name FROM account_devices').get() as { name: string })
        .name,
      'My iPhone',
    )
    // Imported keys keep their digests, so each still authenticates; upload
    // keys stay behind, since the cluster publishes only through ctx.publish.
    const keys = new MasterKeys(database)
    assert.equal(keys.authenticate(fixture.tokens.upload), undefined)
    assert.equal(summary.keys.uploadSkipped, 1)
    assert.equal(keys.authenticate(fixture.tokens.admin)!.role, 'admin')
    const builder = keys.authenticate(fixture.tokens.builder)!
    assert.deepEqual(
      [builder.role, builder.format, builder.id],
      ['developer', 'builder', fixture.builderKeyId],
    )
    assert.equal(summary.adminKeys[0]!.name, 'admin key')
    // Builder apps became script projects with their secrets byte for byte.
    const project = db
      .prepare("SELECT * FROM projects WHERE slug='app.example.fixture'")
      .get()!
    assert.deepEqual(
      [
        project.format,
        project.repository,
        project.entrypoint,
        project.default_branch,
        JSON.parse(String(project.script)),
      ],
      [
        'script',
        'https://github.com/example/fixture.git',
        'tools/Masonfile.ts',
        'develop',
        { workspace: 'git-worktrees', platforms: ['ios', 'android'] },
      ],
    )
    // The app's environment and files become the script project's default variants.
    assert.deepEqual(
      db
        .prepare(
          "SELECT name,contents,masked FROM project_secrets WHERE project_id=? AND kind='value' ORDER BY name",
        )
        .all(project.id as number)
        .map((row) => [row.name, row.contents, row.masked]),
      [
        ['APP_SERVER_URL', 'https://example.test', 0],
        ['SIGNING_TOKEN', 'tok=en/+value', 1],
      ],
    )
    const file = db
      .prepare(
        "SELECT * FROM project_secrets WHERE project_id=? AND kind='file'",
      )
      .get(project.id as number)!
    assert.equal(
      Buffer.from(String(file.contents), 'base64').toString(),
      '{"secret":1}',
    )
    assert.equal(file.path_env, 'DEPLOY_CONFIG_FILE')
    assert.equal(file.destination, file.name)
    assert.equal(file.configs, '')
    assert.deepEqual(
      db
        .prepare(
          'SELECT pattern,mode FROM branch_rules WHERE project_id=? ORDER BY position',
        )
        .all(project.id as number)
        .map((row) => [row.pattern, row.mode]),
      [
        ['develop', 'automatic'],
        ['master', 'automatic'],
        ['**', 'request'],
      ],
    )
    // A builder app with no distribution app gets one, owned by its project.
    const owned = db
      .prepare(
        "SELECT a.slug FROM project_apps pa JOIN apps a ON a.id=pa.app_id JOIN projects p ON p.id=pa.project_id WHERE p.slug='app.example.newapp'",
      )
      .get()!
    assert.equal(owned.slug, 'app.example.newapp')
    // A second import, or one into a used database, is refused.
    assert.throws(() => importDeployment(database, fixture), ImportRefused)
    db.close()
  })

  it('refuses to import from an old distribution schema or an unknown builder', () => {
    const fixture = deploymentFixture(root)
    const old = path.join(root, 'old.sqlite')
    writeFileSync(old, readFileSync(fixture.distribution))
    const oldDb = new DatabaseSync(old)
    oldDb.exec('PRAGMA user_version=6')
    oldDb.close()
    const db = new DatabaseSync(path.join(root, 'master.sqlite'))
    const database = new MasterDatabase(db)
    assert.throws(
      () => importDeployment(database, { ...fixture, distribution: old }),
      /schema 6/,
    )
    const builder = new DatabaseSync(fixture.builder)
    builder.exec('UPDATE builder_meta SET version=2')
    builder.close()
    assert.throws(() => importDeployment(database, fixture), /Unknown builder/)
    db.close()
  })

  it('sets up the first admin through a running master or a stopped one, once', async () => {
    const node = await master()
    const code = path.join(node.dir, 'setup-code')
    assert(existsSync(code))
    assert.equal(node.status().setup, 'waiting')
    const keyFile = path.join(root, 'admin.key')
    const piped = io({ stdin: async () => 'Correct-Horse-9\n' })
    assert.equal(
      await nodeMain(
        [
          'setup',
          '--data',
          node.dir,
          '--username',
          'paul',
          '--password-stdin',
          '--api-key-out',
          keyFile,
        ],
        piped,
      ),
      0,
    )
    assert.deepEqual(piped.lines, [
      'Created admin paul; this master is now set up.',
      `Admin API key written to ${keyFile}`,
    ])
    assert.equal(statSync(keyFile).mode & 0o777, 0o600)
    assert(!existsSync(code))
    assert.equal(node.status().setup, 'configured')
    const token = readFileSync(keyFile, 'utf8').trim()
    const keys = await api(node, 'GET', '/api/v2/keys', token)
    assert.equal(keys.status, 200)
    assert.equal(keys.json[0].role, 'admin')
    // The password is stored as two Argon2id hashes.
    const db = node.databases.get('master.sqlite')!
    const row = db
      .prepare("SELECT * FROM accounts WHERE username='paul'")
      .get()!
    assert.deepEqual([row.role, row.is_admin], ['admin', 1])
    const record = readPasswordRecord(String(row.password))!
    assert.equal(record.server.iterations, record.client.iterations * 4)
    assert.notEqual(record.server.salt, record.client.salt)
    assert.equal(
      await passwordMatches(
        await clientPasswordHash('Correct-Horse-9', record.client),
        String(row.password),
      ),
      true,
    )
    assert.equal(
      await passwordMatches(
        await clientPasswordHash('Wrong-Horse-9', record.client),
        String(row.password),
      ),
      false,
    )
    assert.equal(await passwordMatches('ab'.repeat(32), 'not a record'), false)
    const again = io({ stdin: async () => 'Correct-Horse-9' })
    assert.equal(
      await nodeMain(
        [
          'setup',
          '--data',
          node.dir,
          '--username',
          'other',
          '--password-stdin',
        ],
        again,
      ),
      1,
    )
    assert.match(again.errors[0]!, /already set up/)
    await node.close()
    assert.equal(statusFromFiles(node.dir).setup, 'configured')
    // Against a stopped, never-started master the command works directly.
    const fresh = io({ stdin: async () => 'Another-Horse-7' })
    assert.equal(
      await nodeMain(
        [
          'setup',
          '--data',
          path.join(root, 'fresh'),
          '--username',
          'ops',
          '--password-stdin',
        ],
        fresh,
      ),
      0,
    )
    assert.equal(statusFromFiles(path.join(root, 'fresh')).setup, 'configured')
    const second = io({ stdin: async () => 'Another-Horse-7' })
    assert.equal(
      await nodeMain(
        [
          'setup',
          '--data',
          path.join(root, 'fresh'),
          '--username',
          'ops2',
          '--password-stdin',
        ],
        second,
      ),
      1,
    )
    for (const [argv, message] of [
      [['setup', '--username', 'x'], /Usage/],
      [['setup', '--username', 'bad name', '--password-stdin'], /username/],
      [
        [
          'setup',
          '--username',
          'x',
          '--password-stdin',
          '--api-key-out',
          keyFile,
        ],
        /already exists/,
      ],
    ] as const) {
      const bad = io({ stdin: async () => 'Correct-Horse-9' })
      assert.equal(
        await nodeMain([...argv, '--data', path.join(root, 'x')], bad),
        1,
      )
      assert.match(bad.errors[0]!, message)
    }
    const weak = io({ stdin: async () => 'short' })
    assert.equal(
      await nodeMain(
        [
          'setup',
          '--data',
          path.join(root, 'w'),
          '--username',
          'x',
          '--password-stdin',
        ],
        weak,
      ),
      1,
    )
    assert.match(weak.errors[0]!, /at least 8 characters/)
  })

  it('refuses raw passwords, taken usernames and a second admin by direct call', async () => {
    const db = new DatabaseSync(path.join(root, 'master.sqlite'))
    const database = new MasterDatabase(db)
    const keys = new MasterKeys(database)
    await assert.rejects(
      createFirstAdmin(database, keys, { username: 'x', password: 'raw' }),
      /client password hash/,
    )
    db.prepare(
      "INSERT INTO accounts(name,username,role,created_at) VALUES('Imported','paul','tester',1)",
    ).run()
    await assert.rejects(
      createFirstAdmin(database, keys, await setupRequest('PAUL')),
      /taken/,
    )
    const made = await createFirstAdmin(
      database,
      keys,
      await setupRequest('ops', 'Correct-Horse-9', false),
    )
    assert.equal(made.token, undefined)
    await assert.rejects(
      createFirstAdmin(database, keys, await setupRequest('ops2')),
      /already set up/,
    )
    assert.equal(
      decoyParameters('nobody', 'secret').salt,
      decoyParameters('nobody', 'secret').salt,
    )
    assert.notEqual(
      decoyParameters('nobody', 'secret').salt,
      decoyParameters('somebody', 'secret').salt,
    )
    db.close()
  })

  it('imports only into a stopped master, from the command line', async () => {
    const fixture = deploymentFixture(root)
    const data = path.join(root, 'import')
    const result = io()
    assert.equal(
      await nodeMain(
        [
          'import',
          '--data',
          data,
          '--distribution',
          fixture.distribution,
          '--builder',
          fixture.builder,
        ],
        result,
      ),
      0,
    )
    assert.equal(JSON.parse(result.lines.join('\n')).projects, 2)
    const node = await master('import')
    try {
      const busy = io()
      assert.equal(
        await nodeMain(
          [
            'import',
            '--data',
            data,
            '--distribution',
            fixture.distribution,
            '--builder',
            fixture.builder,
          ],
          busy,
        ),
        1,
      )
      assert.match(busy.errors[0]!, /Another Mason process/)
      // Imported accounts are not local admins, so the master still needs setup.
      assert.equal(node.status().setup, 'waiting')
    } finally {
      await node.close()
    }
    const again = io()
    assert.equal(
      await nodeMain(
        [
          'import',
          '--data',
          data,
          '--distribution',
          fixture.distribution,
          '--builder',
          fixture.builder,
        ],
        again,
      ),
      1,
    )
    assert.match(again.errors[0]!, /empty master database/)
    for (const argv of [
      ['import', '--distribution', fixture.distribution],
      ['import', '--distribution', 'missing', '--builder', 'missing'],
    ]) {
      const bad = io()
      assert.equal(await nodeMain([...argv, '--data', data], bad), 1)
    }
    const worker = io()
    await withStoppedMaster(path.join(root, 'plain'), () => undefined)
    assert.equal(statusFromFiles(path.join(root, 'plain')).role, 'master')
    void worker
  })

  it('creates, scopes and revokes API keys no higher than their creator', async () => {
    const node = await master()
    try {
      const { token: admin } = await createFirstAdmin(
        node.master!.database,
        node.master!.keys,
        await setupRequest(),
      )
      const create = async (
        key: string,
        body: unknown,
      ): Promise<{ status: number; json: Json }> =>
        await api(node, 'POST', '/api/v2/keys', key, body)
      const manager = await create(admin!, { role: 'manager', name: 'ops' })
      assert.equal(manager.status, 201)
      assert.match(manager.json.token, /^mason_v1_[a-f0-9]{32}\./)
      const developer = await create(admin!, {
        role: 'developer',
        projects: ['fixtures'],
        branches: ['feature/*'],
      })
      assert.deepEqual(
        [developer.json.projects, developer.json.branches],
        [['fixtures'], ['feature/*']],
      )
      // The token is shown once; the list holds neither tokens nor hashes.
      const list = await api(node, 'GET', '/api/v2/keys', admin)
      assert(
        list.json.every(
          (key: Record<string, unknown>) =>
            key.token == null && key.hash == null,
        ),
      )
      assert.equal(
        (await create(manager.json.token, { role: 'admin' })).status,
        403,
      )
      assert.equal(
        (await create(developer.json.token, { role: 'manager' })).status,
        403,
      )
      // A scoped key makes keys only within its own scopes.
      assert.equal(
        (await create(developer.json.token, { role: 'tester' })).status,
        403,
      )
      assert.equal(
        (
          await create(developer.json.token, {
            role: 'tester',
            projects: ['fixtures'],
            branches: ['feature/*'],
          })
        ).status,
        201,
      )
      assert.equal(
        (
          await create(developer.json.token, {
            role: 'tester',
            projects: ['other'],
            branches: ['feature/*'],
          })
        ).status,
        403,
      )
      const tester = await create(admin!, { role: 'tester' })
      assert.equal(
        (await create(tester.json.token, { role: 'tester' })).status,
        403,
      )
      assert.equal(
        (await api(node, 'GET', '/api/v2/keys', developer.json.token)).status,
        403,
      )
      // The cluster has no upload keys: publishing goes through ctx.publish.
      const refused = await create(admin!, { role: 'upload' })
      assert.equal(refused.status, 400)
      assert.match(
        JSON.stringify(refused.json),
        /Expected a role: admin, manager, developer or tester/,
      )
      assert.equal(
        (await create(admin!, { role: 'developer', expiresAt: 1 })).status,
        400,
      )
      assert.equal((await create(admin!, { role: 'emperor' })).status, 400)
      // Revocation takes effect on the next request.
      assert.equal(
        (
          await api(
            node,
            'DELETE',
            `/api/v2/keys/${manager.json.id}`,
            developer.json.token,
          )
        ).status,
        403,
      )
      assert.equal(
        (await api(node, 'DELETE', `/api/v2/keys/${manager.json.id}`, admin))
          .status,
        200,
      )
      assert.equal(
        (await api(node, 'GET', '/api/v2/keys', manager.json.token)).status,
        401,
      )
      assert.equal(
        (await api(node, 'DELETE', '/api/v2/keys/nope', admin)).status,
        404,
      )
      const adminKey = (await create(admin!, { role: 'admin' })).json
      const secondManager = (await create(admin!, { role: 'manager' })).json
      assert.equal(
        (
          await api(
            node,
            'DELETE',
            `/api/v2/keys/${adminKey.id}`,
            secondManager.token,
          )
        ).status,
        403,
      )
      assert.equal((await api(node, 'GET', '/api/v2/keys')).status, 401)
      assert.equal(
        (await api(node, 'GET', '/api/v2/keys', 'mason_v1_nonsense')).status,
        401,
      )
      assert.equal(
        (await api(node, 'GET', '/api/v2/elsewhere', admin)).status,
        404,
      )
      // Expired keys stop working.
      const keys = node.master!.keys
      const soon = keys.create(localOperator, {
        role: 'developer',
        expiresAt: Date.now() + 50,
      })
      assert(keys.authenticate(soon.token) != null)
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(keys.authenticate(soon.token), undefined)
      assert.equal(keys.authenticate(42), undefined)
      // The command line makes keys through the control socket.
      const out = path.join(root, 'cli.key')
      const made = io()
      assert.equal(
        await nodeMain(
          [
            'keys',
            'create',
            '--data',
            node.dir,
            '--role',
            'developer',
            '--project',
            'fixtures',
            '--branch',
            'master',
            '--out',
            out,
            '--name',
            'ci',
          ],
          made,
        ),
        0,
      )
      assert.equal(statSync(out).mode & 0o777, 0o600)
      assert.equal(
        keys.authenticate(readFileSync(out, 'utf8').trim())!.name,
        'ci',
      )
      const listed = io()
      assert.equal(
        await nodeMain(['keys', 'list', '--data', node.dir], listed),
        0,
      )
      assert(listed.lines.some((line) => line.includes('developer  ci')))
      assert(listed.lines.some((line) => line.endsWith('revoked')))
      const json = io()
      assert.equal(
        await nodeMain(['keys', 'list', '--data', node.dir, '--json'], json),
        0,
      )
      const id = keys.authenticate(readFileSync(out, 'utf8').trim())!.id
      assert.equal(
        await nodeMain(['keys', 'revoke', id, '--data', node.dir], io()),
        0,
      )
      assert.equal(
        keys.authenticate(readFileSync(out, 'utf8').trim()),
        undefined,
      )
      for (const argv of [
        ['keys', 'create', '--role', 'developer'],
        ['keys', 'create', '--role', 'developer', '--out', out],
        ['keys', 'frob'],
      ])
        assert.equal(await nodeMain([...argv, '--data', node.dir], io()), 1)
      const audit = node.databases
        .get('master.sqlite')!
        .prepare(
          "SELECT via FROM audit WHERE action='key.create' ORDER BY id DESC",
        )
        .get()!
      assert.equal(audit.via, 'local operator')
    } finally {
      await node.close()
    }
  })

  it('serves settings areas to admins and managers with write-only secrets', async () => {
    const node = await master()
    try {
      const changes: unknown[] = []
      node.master!.settings.register('example', {
        secrets: ['token'],
        validate(input, previous) {
          const value = (input ?? {}) as Record<string, unknown>
          if (
            typeof value.url !== 'string' ||
            !value.url.startsWith('https://')
          )
            throw new Error('url must be https')
          const token = keepSecret(value.token, previous?.token, (raw) => {
            if (typeof raw !== 'string')
              throw new Error('token must be a string')
            return raw
          })
          return { url: value.url, ...(token == null ? {} : { token }) }
        },
        changed: (value) => {
          changes.push(value)
        },
      })
      assert.throws(
        () =>
          node.master!.settings.register('Bad-Name', {
            validate: (x) => x as never,
          }),
        /Invalid area/,
      )
      assert(node.master!.settings.names().includes('example'))
      const { token: admin } = await createFirstAdmin(
        node.master!.database,
        node.master!.keys,
        await setupRequest(),
      )
      const keys = node.master!.keys
      const manager = keys.create(localOperator, { role: 'manager' }).token
      const developer = keys.create(localOperator, { role: 'developer' }).token
      const tester = keys.create(localOperator, { role: 'tester' }).token
      assert.deepEqual(
        (await api(node, 'GET', '/api/v2/settings/example', admin)).json,
        { token: { set: false } },
      )
      const set = await api(node, 'PUT', '/api/v2/settings/example', manager, {
        url: 'https://a.example',
        token: 's3cret',
      })
      assert.equal(set.status, 200)
      assert.deepEqual(set.json, {
        url: 'https://a.example',
        token: { set: true },
      })
      assert.deepEqual(changes, [{ url: 'https://a.example', token: 's3cret' }])
      const kept = await api(node, 'PUT', '/api/v2/settings/example', admin, {
        url: 'https://b.example',
        token: { keep: true },
      })
      assert.deepEqual(kept.json, {
        url: 'https://b.example',
        token: { set: true },
      })
      assert.equal(node.master!.settings.value('example')!.token, 's3cret')
      for (const key of [developer, tester]) {
        assert.equal(
          (await api(node, 'GET', '/api/v2/settings/example', key)).status,
          403,
        )
        assert.equal(
          (
            await api(node, 'PUT', '/api/v2/settings/example', key, {
              url: 'https://c.example',
            })
          ).status,
          403,
        )
      }
      const invalid = await api(
        node,
        'PUT',
        '/api/v2/settings/example',
        admin,
        { url: 'http://insecure' },
      )
      assert.equal(invalid.status, 400)
      assert.equal(
        node.master!.settings.value('example')!.url,
        'https://b.example',
      )
      assert.equal(
        (
          await api(node, 'PUT', '/api/v2/settings/example', admin, {
            url: 'https://d.example',
            token: 5,
          })
        ).status,
        400,
      )
      assert.equal(
        (await api(node, 'GET', '/api/v2/settings/missing', admin)).status,
        404,
      )
      const fresh = await master('fresh')
      try {
        fresh.master!.settings.register('example', {
          validate: (input) => input as Record<string, unknown>,
          secrets: ['token'],
        })
        assert.throws(
          () =>
            fresh.master!.settings.set(localOperator, 'example', {
              token: { keep: true },
              x: keepSecret({ keep: true }, undefined, String),
            }),
          /No stored value/,
        )
      } finally {
        await fresh.close()
      }
      assert.equal(
        (await api(node, 'PUT', '/api/v2/settings/example', admin, '{bad json'))
          .status,
        400,
      )
      const audit = node.databases
        .get('master.sqlite')!
        .prepare(
          "SELECT via FROM audit WHERE action='settings.set' ORDER BY id",
        )
        .all()
        .map((row) => row.via)
      assert.equal(audit.length, 2)
      // The command line goes through the same validator.
      const file = path.join(root, 'example.json')
      writeFileSync(
        file,
        JSON.stringify({ url: 'https://cli.example', token: { keep: true } }),
      )
      const cli = io()
      assert.equal(
        await nodeMain(
          ['settings', 'set', 'example', '--file', file, '--data', node.dir],
          cli,
        ),
        0,
      )
      assert.equal(JSON.parse(cli.lines.join('\n')).url, 'https://cli.example')
      writeFileSync(file, JSON.stringify({ url: 'ftp://no' }))
      const refused = io()
      assert.equal(
        await nodeMain(
          ['settings', 'set', 'example', '--file', file, '--data', node.dir],
          refused,
        ),
        1,
      )
      assert.match(refused.errors[0]!, /https/)
      const got = io()
      assert.equal(
        await nodeMain(['settings', 'get', 'example', '--data', node.dir], got),
        0,
      )
      assert.deepEqual(JSON.parse(got.lines.join('\n')), {
        url: 'https://cli.example',
        token: { set: true },
      })
      for (const argv of [
        ['settings', 'get'],
        ['settings', 'set', 'example'],
        ['settings', 'frob', 'example'],
      ])
        assert.equal(await nodeMain([...argv, '--data', node.dir], io()), 1)
      assert.equal(
        node.databases
          .get('master.sqlite')!
          .prepare(
            "SELECT via FROM audit WHERE action='settings.set' ORDER BY id DESC",
          )
          .get()!.via,
        'local operator',
      )
    } finally {
      await node.close()
    }
  })

  it('adds nodes over HTTP with a manager or admin key', async () => {
    const node = await master()
    const worker = await startNode(
      {
        role: 'worker',
        data: path.join(root, 'w'),
        linkPort: 0,
        listen: '127.0.0.1',
        heartbeatMs: 0,
      },
      quiet,
    )
    try {
      const { token: admin } = await createFirstAdmin(
        node.master!.database,
        node.master!.keys,
        await setupRequest(),
      )
      const developer = node.master!.keys.create(localOperator, {
        role: 'developer',
      }).token
      const key = worker.pairing!.key()!
      const address = `127.0.0.1:${worker.link!.port}`
      assert.equal(
        (await api(node, 'POST', '/api/v2/nodes', developer, { address, key }))
          .status,
        403,
      )
      assert.equal(
        (await api(node, 'POST', '/api/v2/nodes', admin, { address })).status,
        400,
      )
      const added = await api(node, 'POST', '/api/v2/nodes', admin, {
        address,
        key,
      })
      assert.equal(added.status, 201)
      assert.equal(added.json.fingerprint, worker.identity.fingerprint)
      assert.equal(
        (await api(node, 'POST', '/api/v2/nodes', admin, { address, key }))
          .status,
        409,
      )
      assert.equal(
        (await api(node, 'GET', '/api/v2/nodes', admin)).json.length,
        1,
      )
      assert.equal(
        (await api(node, 'GET', '/api/v2/nodes', developer)).status,
        403,
      )
      const other = await startNode(
        {
          role: 'worker',
          data: path.join(root, 'w2'),
          linkPort: 0,
          listen: '127.0.0.1',
          heartbeatMs: 0,
        },
        quiet,
      )
      try {
        const wrong = other
          .pairing!.key()!
          .replace(/\.[^.]+$/, '.' + 'Z'.repeat(43))
        assert.equal(
          (
            await api(node, 'POST', '/api/v2/nodes', admin, {
              address: `127.0.0.1:${other.link!.port}`,
              key: wrong,
            })
          ).status,
          502,
        )
      } finally {
        await other.close()
      }
      assert.equal(
        (
          await api(
            node,
            'DELETE',
            `/api/v2/nodes/${encodeURIComponent(added.json.fingerprint)}`,
            developer,
          )
        ).status,
        403,
      )
      assert.equal(
        (
          await api(
            node,
            'DELETE',
            `/api/v2/nodes/${encodeURIComponent(added.json.fingerprint)}`,
            admin,
          )
        ).status,
        200,
      )
      assert.equal(
        (await api(node, 'DELETE', '/api/v2/nodes/nope', admin)).status,
        404,
      )
    } finally {
      await node.close()
      await worker.close()
    }
  })

  it('reads no configuration file: nodes keep state only in their data directory', () => {
    // The legacy configuration loaders are used only by the legacy commands.
    const roots = ['master', 'node', 'link', 'setup'].map(
      (dir) => new URL(`../../src/${dir}/`, import.meta.url).pathname,
    )
    const files = roots.flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => path.join(dir, name)),
    )
    assert(files.length > 15)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      assert(!/loadConfig|readPrivateJson|loadBuilderConfig/.test(source), file)
    }
    // Everything read from a data directory is a file the node wrote itself.
    const reads = files.flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /(?:readPrivate|readFileSync)\(\s*(?:path\.join\([^,]+,\s*|this\.file\(|file\()?'([^']+)'/g,
        ),
      ].map((match) => match[1]!),
    )
    const allowed = new Set([
      'identity.key',
      'identity.pub',
      'tls.crt',
      'tls.key',
      'pairing.json',
      'node.json',
      'master.json',
      'assigned.json',
      'lock.pid',
      'setup-code',
    ])
    for (const name of reads) assert(allowed.has(name), name)
  })
})
