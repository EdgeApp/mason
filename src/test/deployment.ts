import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BuilderStore } from '../builder/store.js'
import { asBuilderConfig } from '../builder/config.js'
import { migrate } from '../schema.js'

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

export interface DeploymentFixture {
  distribution: string
  builder: string
  tokens: { upload: string; admin: string; builder: string }
  /** Account IDs by role in the source. */
  accounts: {
    admin: number
    tester: number
    both: number
    neither: number
    disabled: number
  }
  apps: { app: number; other: number }
  builderKeyId: string
}

/**
 * A current deployment in miniature: a distribution database at schema 7 with
 * accounts, identities, an invitation, apps, channels, builds, devices and
 * keys, and a builder database with two app definitions and two keys.
 */
export function deploymentFixture(
  root: string,
  now = Date.now(),
): DeploymentFixture {
  const distribution = path.join(root, 'distribution.sqlite')
  const db = new DatabaseSync(distribution, {
    enableForeignKeyConstraints: true,
  })
  migrate(db)
  const account = (
    name: string,
    email: string | null,
    admin: number,
    tester: number,
    disabled = 0,
  ): number =>
    Number(
      db
        .prepare(
          'INSERT INTO accounts(name,email,is_admin,is_tester,disabled,permission_version,created_at) VALUES(?,?,?,?,?,3,?)',
        )
        .run(name, email, admin, tester, disabled, now - 1000).lastInsertRowid,
    )
  const accounts = {
    admin: account('Admin', 'admin@example.test', 1, 0),
    tester: account('Tester', 'Tester@Example.test', 0, 1),
    both: account('Both', 'both@example.test', 1, 1),
    neither: account('Waiting', 'waiting@example.test', 0, 0),
    disabled: account('Gone', 'gone@example.test', 0, 1, 1),
  }
  const identity = db.prepare(
    'INSERT INTO identities(account_id,provider,issuer,subject,email,email_verified) VALUES(?,?,?,?,?,?)',
  )
  identity.run(
    accounts.admin,
    'google',
    'https://accounts.google.com',
    's1',
    'admin@example.test',
    1,
  )
  identity.run(
    accounts.tester,
    'google',
    'https://accounts.google.com',
    's2',
    'Tester@Example.test',
    1,
  )
  identity.run(
    accounts.tester,
    'okta',
    'https://auth.example.test',
    's3',
    'tester.okta@example.test',
    1,
  )
  identity.run(
    accounts.both,
    'google',
    'https://accounts.google.com',
    's4',
    'both@example.test',
    0,
  )
  identity.run(
    accounts.neither,
    'google',
    'https://accounts.google.com',
    's5',
    'waiting@example.test',
    1,
  )
  // A second identity claiming an address another account already has.
  identity.run(
    accounts.disabled,
    'google',
    'https://accounts.google.com',
    's6',
    'admin@example.test',
    1,
  )
  db.prepare("INSERT INTO sessions VALUES('h1',?,3,'c',?,?)").run(
    accounts.tester,
    now,
    now + 86400000,
  )
  const invite = db.prepare(
    'INSERT INTO invitations(provider,issuer,email,creator,created_at,expires_at,revoked,claimed_account) VALUES(?,?,?,?,?,?,?,?)',
  )
  invite.run(
    'google',
    'https://accounts.google.com',
    'Invited@example.test',
    accounts.admin,
    now,
    now + 86400000,
    0,
    null,
  )
  invite.run(
    'google',
    'https://accounts.google.com',
    'revoked@example.test',
    accounts.admin,
    now,
    now + 86400000,
    1,
    null,
  )
  invite.run(
    'google',
    'https://accounts.google.com',
    'expired@example.test',
    accounts.admin,
    now - 9e6,
    now - 1000,
    0,
    null,
  )
  db.prepare(
    "INSERT INTO audit(actor,action,target,at) VALUES(?,'login',?,?)",
  ).run(accounts.tester, String(accounts.tester), now)
  const app = Number(
    db
      .prepare(
        "INSERT INTO apps(slug,name,position,enabled) VALUES('app.example.fixture','Fixture',0,1)",
      )
      .run().lastInsertRowid,
  )
  const other = Number(
    db
      .prepare(
        "INSERT INTO apps(slug,name,position,enabled) VALUES('app.example.other','Other',1,1)",
      )
      .run().lastInsertRowid,
  )
  const channel = Number(
    db
      .prepare(
        "INSERT INTO channels(app_id,platform,channel_key,formats,enabled) VALUES(?,'ios','ios-key','[\"ipa\"]',1)",
      )
      .run(app).lastInsertRowid,
  )
  db.prepare(
    "INSERT INTO channels(app_id,platform,channel_key,formats,enabled) VALUES(?,'android','android-key','[\"apk\"]',1)",
  ).run(other)
  const build = db.prepare(
    "INSERT INTO builds(app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields) VALUES(?,?,'ios','master','abc123','1.0',?,?,'ipa',?,10,?,?,?,'ready','','api','{}')",
  )
  for (let i = 1; i <= 3; i++)
    build.run(
      app,
      channel,
      String(26101900 + i),
      'app.example.fixture',
      sha256(String(i)),
      randomBytes(16).toString('hex') + '.ipa',
      now,
      now + 86400000,
    )
  const device = Number(
    db
      .prepare(
        "INSERT INTO devices(udid,product,model,os_version,status,created_at,updated_at) VALUES('00008110-0001','iPhone15,2','iPhone','18.0','registered',?,?)",
      )
      .run(now, now).lastInsertRowid,
  )
  db.prepare("INSERT INTO account_devices VALUES(?,?,'My iPhone',?)").run(
    accounts.tester,
    device,
    now,
  )
  db.prepare("INSERT INTO build_provisioning VALUES(1,?,?,'TEAM')").run(
    JSON.stringify(['00008110-0001']),
    now + 86400000,
  )
  const key = (role: string, apps: unknown): string => {
    const id = randomBytes(16).toString('hex')
    const token = `mason_v1_${id}.${randomBytes(32).toString('base64url')}`
    db.prepare(
      'INSERT INTO api_keys(id,hash,name,apps,created_at,expires_at,revoked,role) VALUES(?,?,?,?,?,NULL,0,?)',
    ).run(id, sha256(token), `${role} key`, JSON.stringify(apps), now, role)
    return token
  }
  const tokens = {
    upload: key('upload', [app]),
    admin: key('admin', 'all'),
    builder: '',
  }
  db.close()

  const builder = new BuilderStore(
    asBuilderConfig({ workspace: path.join(root, 'builder'), port: 9599 }),
  )
  builder.importApp({
    slug: 'app.example.fixture',
    name: 'Fixture',
    repository: 'https://github.com/example/fixture.git',
    platforms: ['ios', 'android'],
    entrypoint: 'tools/Masonfile.ts',
    env: [
      { name: 'APP_SERVER_URL', value: 'https://example.test', secret: false },
      { name: 'SIGNING_TOKEN', value: 'tok=en/+value' },
    ],
    files: [
      {
        destination: 'deployConfig.json',
        contents: Buffer.from('{"secret":1}').toString('base64'),
        env: 'DEPLOY_CONFIG_FILE',
      },
    ],
  })
  builder.importApp({
    slug: 'app.example.newapp',
    name: 'New App',
    repository: 'git@github.com:example/newapp.git',
    platforms: ['macos'],
    position: 3,
  })
  builder.configureBuilds('app.example.fixture', {
    defaultBranch: 'develop',
    automaticBranches: ['develop', 'master'],
  })
  const tokenFile = path.join(root, 'builder-key')
  const builderKeyId = builder.key(tokenFile)
  // The token file holds the 64-hex token and a newline.
  tokens.builder = readFileSync(tokenFile, 'utf8').trim()
  const file = path.join(builder.config.workspace, 'builder.sqlite')
  builder.close()
  return {
    distribution,
    builder: file,
    tokens,
    accounts,
    apps: { app, other },
    builderKeyId,
  }
}
