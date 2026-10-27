import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import { after, before, describe, it } from 'mocha'
import { Agent } from 'undici'
import { fixture } from '../auth/providers.test.js'
import { asConfig } from '../config.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { digest, Store } from '../store.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { FakeApple } from '../test/fakeApple.js'
import { FakeMac, fakeXcode } from '../test/fakeMac.js'
import { importHost } from './import.js'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
} from '../auth/passwordProtocol.js'
import { releaseRoutes } from './web.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'host-'))
const admin = { role: 'admin' as const, label: 'paul' }
const insecure = new Agent({ connect: { rejectUnauthorized: false } })
const ORIGIN = 'https://builds.example.test'
const KEY = 'a'.repeat(32) + '.apk'
const EXPIRING = 'b'.repeat(32) + '.apk'
const ZCASH = 'c'.repeat(32) + '.apk'

/** Values of the master the host must never hold. */
const secrets = (c: Cluster): string[] => {
  const db = c.master.master!.database.db
  const values: string[] = []
  for (const row of db
    .prepare(
      'SELECT webhook_secret FROM projects WHERE webhook_secret IS NOT NULL',
    )
    .all())
    values.push(String(row.webhook_secret))
  for (const row of db.prepare('SELECT value FROM project_env').all())
    values.push(String(row.value))
  for (const row of db
    .prepare('SELECT password FROM accounts WHERE password IS NOT NULL')
    .all())
    values.push(String(row.password))
  for (const row of db.prepare('SELECT channel_key FROM channels').all())
    values.push(String(row.channel_key))
  for (const row of db.prepare('SELECT public_key FROM nodes').all())
    values.push(String(row.public_key))
  return values
}

/** Seeds the master with the distribution rows an import brings. */
function seed(c: Cluster): void {
  const db = c.master.master!.database.db
  const now = Date.now()
  const build = (
    id: number,
    app: number,
    channel: number,
    key: string,
    expires: number,
  ): string =>
    `(${id},${app},${channel},'android','develop','${'1'.repeat(40)}','1.0.${id}','${id}','app.edge','apk','${String(id).repeat(22).slice(0, 64)}',${`apk ${key}`.length},'${key}',${now - 1000},${expires},'ready','notes','upload','{}')`
  db.exec(`
    INSERT INTO apps(id,slug,name,position,enabled) VALUES(1,'edge','Edge Wallet',0,1),(2,'zcash','Zcash',1,1);
    INSERT INTO channels(id,app_id,platform,channel_key,formats,enabled) VALUES
      (1,1,'android','channel-key-edge-android','["apk"]',1),(2,2,'android','channel-key-zcash-android','["apk"]',1);
    INSERT INTO builds(id,app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields) VALUES
      ${build(100, 1, 1, KEY, now + 30 * 86_400_000)},${build(101, 2, 2, ZCASH, now + 30 * 86_400_000)},${build(102, 1, 1, EXPIRING, now + 60_000)};
    INSERT INTO accounts(id,name,email,role,permission_version,created_at) VALUES
      (10,'Tess Tester','tess@example.com','tester',1,${now}),
      (11,'Dev','dev@example.com','developer',1,${now}),
      (12,'Gone','gone@example.com','tester',1,${now});
    UPDATE accounts SET disabled=1 WHERE id=12;
    INSERT INTO account_addresses(account_id,method,email) VALUES
      (10,'first','Tess@Example.com'),(10,'second','tess.second@example.com'),(11,'first','dev@example.com'),(12,'first','gone@example.com');
    INSERT INTO groups(id,name,created_at) VALUES(1,'Edge testers',${now});
    INSERT INTO group_apps(group_id,app_id) VALUES(1,1);
    INSERT INTO group_members(group_id,account_id) VALUES(1,10);
  `)
}

/** A browser against the host's HTTPS listener that keeps cookies and checks their attributes. */
class Browser {
  readonly cookies = new Map<string, string>()
  readonly attributes: string[] = []
  constructor(readonly base: () => string) {}
  async get(url: string, init: RequestInit = {}): Promise<Response> {
    const parsed = new URL(url, ORIGIN)
    const response = await fetch(
      this.base() + parsed.pathname + parsed.search,
      {
        ...init,
        redirect: 'manual',
        // @ts-expect-error undici's dispatcher option
        dispatcher: insecure,
        headers: {
          cookie: [...this.cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join('; '),
          ...(init.headers as Record<string, string>),
        },
      },
    )
    for (const value of response.headers.getSetCookie()) {
      this.attributes.push(value)
      const pair = value.split(';')[0]!
      const index = pair.indexOf('=')
      if (pair.slice(index + 1) === '')
        this.cookies.delete(pair.slice(0, index))
      else this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    return response
  }
  async post(url: string, body: Record<string, string>): Promise<Response> {
    return await this.get(url, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body),
    })
  }
}

describe('Host release files', () => {
  it('U9.14 serves the release from a data directory under a dot folder, as service installs keep it', async () => {
    const dir = path.join(root(), '.mason', 'releases', '0.3.0')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'install.sh'), '#!/bin/bash\n')
    writeFileSync(path.join(dir, 'SHA256SUMS'), 'sums\n')
    const app = express()
    app.use(
      releaseRoutes({
        currentRelease: () => ({
          version: '0.3.0',
          dir,
          files: { 'install.sh': 'x' },
        }),
        xcodeFile: () => path.join(dir, 'missing.xip'),
        granted: () => false,
      }),
    )
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      assert.equal(
        await (await fetch(`${base}/install.sh`)).text(),
        '#!/bin/bash\n',
      )
      assert.equal(
        await (await fetch(`${base}/releases/current/SHA256SUMS`)).text(),
        'sums\n',
      )
    } finally {
      server.close()
    }
  })
})

describe('Host cache, sign-in and offline serving', function () {
  this.timeout(120_000)
  let c: Cluster
  let env: Awaited<ReturnType<typeof fixture>>
  let host: RunningNode
  let apple: FakeApple
  let mac: FakeMac
  const runtime = (): NonNullable<RunningNode['host']> =>
    c.hosts.get('host')!.host!
  const browser = (): Browser =>
    new Browser(() => c.hosts.get('host')!.web!.url)

  before(async () => {
    env = await fixture(ORIGIN)
    apple = new FakeApple('builds@example.com', 'Apple-Password-9')
    await apple.start()
    const dir = root()
    mac = new FakeMac(path.join(dir, 'mac'))
    writeFileSync(path.join(dir, 'mac-helper.sock'), '')
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [
        {
          name: 'mac',
          type: 'mac-xcode',
          workerOptions: {
            applications: mac.applications,
            systemRun: mac.run,
            helper: mac.helper,
            helperSocket: path.join(dir, 'mac-helper.sock'),
          },
        },
      ],
      masterOptions: { appleEndpoints: apple.endpoints },
    })
    seed(c)
    const master = c.master.master!
    master.saveProject(admin, 'edge', {
      name: 'Edge',
      repository: 'https://github.com/EdgeApp/edge-react-gui',
      webhookSecret: 'webhook-secret-value',
      rules: [
        { pattern: 'develop', mode: 'automatic' },
        { pattern: 'feature/*', mode: 'request' },
      ],
      secrets: {
        env: [{ name: 'API_TOKEN', value: 'env-secret-value' }],
        files: [],
      },
    })
    master.database.db.exec(
      "INSERT INTO project_apps(app_id,project_id) SELECT 1,id FROM projects WHERE slug='edge'",
    )
    master.database.change('project', 'edge')
    await master.settings.set(admin, 'host', { origin: ORIGIN })
    await master.settings.set(admin, 'signIn', {
      methods: env.configs
        .filter((config) => config.id !== 'plain')
        .map((config) => ({ ...config, enabled: true })),
    })
    host = await c.startHost('host', {
      hostOptions: { transport: env.transport },
      testEndpoints: true,
    })
    for (const key of [KEY, EXPIRING, ZCASH]) {
      mkdirSync(path.join(host.dir, 'storage', 'files'), { recursive: true })
      writeFileSync(path.join(host.dir, 'storage', 'files', key), `apk ${key}`)
    }
  })
  after(async () => {
    await c?.close()
    await env?.close()
    await apple?.close()
  })

  /** Signs in through a fixture provider with the claims given; answers the callback's response. */
  const signIn = async (
    b: Browser,
    provider: string,
    claims: { email?: string; email_verified?: boolean },
  ): Promise<Response> => {
    env.setClaims(claims)
    const start = await b.get(`/auth/start/${provider}?return=/`)
    assert.equal(start.status, 303, await start.text())
    const callback = await env.authorize(start.headers.get('location')!)
    return await b.get(callback.pathname + callback.search)
  }
  const session = (b: Browser): string | undefined =>
    b.cookies.get('__Host-mason-session')

  it('U10.1/U10.2 replicated writes are in the change log without secrets; changes from a revision, a snapshot after compaction', () => {
    const changes = c.master.master!.changes
    const snapshot = changes.since(0)
    assert.equal(snapshot.kind, 'snapshot')
    const text = JSON.stringify(snapshot)
    for (const secret of secrets(c))
      assert(
        !text.includes(secret),
        `a projection carries ${secret.slice(0, 10)}…`,
      )
    if (snapshot.kind !== 'snapshot') return
    const ids = snapshot.entities.account!.map((entry) => entry.row.id)
    for (const id of [10, 11, 12]) assert(ids.includes(id))
    assert.deepEqual(
      snapshot.entities.setting!.map((entry) => entry.row.area).sort(),
      ['host', 'signIn'],
    )
    const revision = changes.revision()
    c.master.master!.projects.save(admin, 'edge', { name: 'Edge App' })
    const next = changes.since(revision)
    assert.equal(next.kind, 'changes')
    if (next.kind !== 'changes') return
    assert.deepEqual(
      next.changes.map((change) => [
        change.entity,
        change.key,
        change.operation,
      ]),
      [['project', 'edge', 'put']],
    )
    assert.equal(next.changes[0]!.value!.row.name, 'Edge App')
    const db = c.master.master!.database.db
    const latest = changes.revision()
    db.prepare('UPDATE change_log SET at=0 WHERE revision<?').run(latest)
    assert(changes.compact() > 0)
    assert.equal(changes.since(1).kind, 'snapshot')
    assert.equal(changes.since(latest).kind, 'changes')
    // The host cache file holds none of them either.
    const cache = readFileSync(path.join(host.dir, 'host-cache.sqlite'))
    for (const secret of secrets(c)) assert(!cache.includes(secret))
  })

  it('U10.3 applies changes atomically and records the revision; a change reaches the host within a second', async () => {
    const started = Date.now()
    c.master.master!.projects.save(admin, 'edge', { name: 'Edge' })
    const revision = c.master.master!.changes.revision()
    await c.until(
      () => host.status().sync?.revision === revision,
      1000,
      'the change on the host',
    )
    assert(Date.now() - started < 1000)
    assert(host.status().sync!.syncedAt! >= started)
    // Keys of every role replicate as digests.
    const key = c.master.master!.keys.create(admin, {
      role: 'developer',
      name: 'ci',
    })
    await c.until(
      () =>
        runtime()
          .cache.db.prepare('SELECT role FROM api_keys WHERE id=?')
          .get(key.id) != null,
      1000,
      'the developer key on the host',
    )
    assert(
      !readFileSync(path.join(host.dir, 'host-cache.sqlite')).includes(
        key.token,
      ),
    )
    assert.equal(
      (
        runtime()
          .cache.db.prepare("SELECT name FROM projects WHERE slug='edge'")
          .get() as Json
      ).name,
      'Edge',
    )
    // A failing change rolls back whole: the revision does not move.
    const before = runtime().cache.revision()
    assert.throws(() =>
      runtime().cache.apply({
        kind: 'changes',
        revision: before + 5,
        changes: [
          {
            revision: before + 4,
            entity: 'project',
            key: 'x',
            operation: 'put',
            value: {
              row: {
                slug: 'x',
                name: 'X',
                position: 0,
                enabled: 1,
                default_branch: 'master',
              },
            },
          },
        ],
      }),
    )
    assert.equal(runtime().cache.revision(), before)
  })

  it('U10.8/U10.9 signs in only a verified email matching an enabled account’s address for that provider', async () => {
    const tess = browser()
    const accepted = await signIn(tess, 'first', { email: 'tess@example.com' })
    assert.equal(accepted.status, 303)
    assert(session(tess) != null)
    const cookie = tess.attributes.find((value) =>
      value.startsWith('__Host-mason-session='),
    )!
    assert.match(cookie, /Secure/)
    assert.match(cookie, /HttpOnly/)
    // Case-insensitive and exact: the same account through the other provider's address.
    const second = browser()
    assert.equal(
      (await signIn(second, 'second', { email: 'TESS.SECOND@example.com' }))
        .status,
      303,
    )
    assert.equal(runtime().accounts.session(session(second))!.account.id, 10)
    assert.equal(runtime().accounts.session(session(tess))!.account.id, 10)
    for (const [provider, claims, reason] of [
      [
        'first',
        { email: 'tess@example.com', email_verified: false },
        /verified email/,
      ],
      ['first', { email: 'nobody@example.com' }, /No Mason account/],
      ['first', { email: 'tess@example.com.evil' }, /No Mason account/],
      ['first', { email: 'gone@example.com' }, /No Mason account/],
      ['first', { email: 'tess.second@example.com' }, /No Mason account/],
      ['second', { email: 'dev@example.com' }, /No Mason account/],
    ] as const) {
      const refused = await signIn(browser(), provider, claims)
      assert.equal(refused.status, 400, `${provider} ${claims.email}`)
      assert.match(await refused.text(), reason)
    }
    // A person's email signs them in through every enabled provider that confirms it.
    const master = c.master.master!
    const eve = await master.people.create(admin, {
      name: 'Eve',
      email: 'eve@example.com',
    })
    await c.until(
      () =>
        runtime()
          .cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(eve.id) != null,
      2000,
      'Eve on the host',
    )
    for (const provider of ['first', 'second'] as const) {
      const eveBrowser = browser()
      assert.equal(
        (await signIn(eveBrowser, provider, { email: 'EVE@example.com' }))
          .status,
        303,
      )
      assert.equal(
        runtime().accounts.session(session(eveBrowser))!.account.id,
        eve.id,
      )
    }
    // A provider disabled on the master is not offered.
    await master.settings.set(admin, 'signIn', {
      methods: env.configs
        .filter((config) => config.id !== 'plain')
        .map((config) => ({
          ...config,
          clientSecret: { keep: true },
          enabled: config.id === 'first',
        })),
    })
    await c.until(
      () => runtime().cache.signInMethods().length === 1,
      2000,
      'the disabled method on the host',
    )
    const login = await browser().get('/auth/login?return=/&signed_out=1')
    const page = await login.text()
    assert.match(page, /Sign in with first/)
    assert.doesNotMatch(page, /Sign in with second/)
    assert.equal(
      (await browser().get('/auth/start/second?return=/')).status,
      400,
    )
    // The host never holds the disabled method's client secret.
    const stored = JSON.stringify(runtime().cache.setting('signIn'))
    assert(!stored.includes('"second"'))
    await master.settings.set(admin, 'signIn', {
      methods: env.configs
        .filter((config) => config.id !== 'plain')
        .map((config) => ({
          ...config,
          clientSecret: { keep: true },
          enabled: true,
        })),
    })
    await c.until(
      () => runtime().cache.signInMethods().length === 2,
      2000,
      'both methods again',
    )
  })

  it('U10.4/U10.7 serves the catalog, project home and installs of the tester’s apps from the cache with the master link down', async () => {
    const tess = browser()
    await signIn(tess, 'first', { email: 'tess@example.com' })
    const online = await (await tess.get('/')).text()
    assert.match(online, /Edge Wallet/)
    assert.doesNotMatch(online, /Zcash/, 'testers see only their groups’ apps')
    assert.doesNotMatch(online, /master is unreachable/)
    await c.drop('host', 3000, async () => {
      await c.until(() => !runtime().online(), 2000, 'the host offline')
      const catalog = await tess.get('/')
      assert.equal(catalog.status, 200, 'catalog')
      const text = await catalog.text()
      assert.match(text, /The Mason master is unreachable/)
      assert.match(text, /Edge Wallet/)
      const branch = await (
        await tess.get(
          '/apps/1/branches/' +
            Buffer.from('develop').toString('base64url') +
            '?platform=android',
        )
      ).text()
      assert.match(branch, /1\.0\.100/)
      assert.equal((await tess.get('/apps/2')).status, 404)
      const project = await tess.get('/projects/edge')
      assert.equal(project.status, 200, 'project home')
      assert.match(await project.text(), /Edge Wallet/)
      const csrf = runtime().accounts.session(session(tess))!.session.csrf
      const install = await tess.post('/builds/100/install', { csrf })
      assert.equal(install.status, 303)
      const artifact = await tess.get(install.headers.get('location')!)
      assert.equal(
        artifact.status,
        200,
        `artifact ${install.headers.get('location')}`,
      )
      assert.equal(await artifact.text(), `apk ${KEY}`)
      assert.equal(
        (await tess.post('/builds/101/install', { csrf })).status,
        400,
        'another group’s build',
      )
      // An expired build stops at once, even offline.
      runtime().advanceClock(120_000)
      const later = await (
        await tess.get(
          '/apps/1/branches/' +
            Buffer.from('develop').toString('base64url') +
            '?platform=android',
        )
      ).text()
      assert.doesNotMatch(later, /1\.0\.102/)
      assert.equal(
        (await tess.post('/builds/102/install', { csrf })).status,
        400,
      )
      // Sign-in keeps working from the cache.
      const again = browser()
      assert.equal(
        (await signIn(again, 'first', { email: 'tess@example.com' })).status,
        303,
      )
      assert.equal((await again.get('/')).status, 200)
    })
    await c.until(() => runtime().online(), 10000, 'the host back online')
    runtime().resetClock()
    const developer = browser()
    await signIn(developer, 'first', { email: 'dev@example.com' })
    const all = await (await developer.get('/')).text()
    assert.match(all, /Zcash/, 'developers see every app')
    assert.match(
      await (await developer.get('/projects/edge')).text(),
      /Recent runs/,
    )
  })

  it('U10.10 a permission-version change ends that account’s host sessions', async () => {
    const tess = browser()
    await signIn(tess, 'first', { email: 'tess@example.com' })
    assert.equal((await tess.get('/')).status, 200)
    const db = c.master.master!.database.db
    db.prepare(
      'UPDATE accounts SET permission_version=permission_version+1 WHERE id=10',
    ).run()
    c.master.master!.database.change('account', 10)
    await c.until(
      () =>
        runtime()
          .cache.db.prepare('SELECT 1 FROM sessions WHERE account_id=10')
          .get() == null,
      2000,
      'the sessions ended',
    )
    const after = await tess.get('/')
    assert.equal(after.status, 303)
    assert.match(after.headers.get('location')!, /^\/auth\/login/)
    assert.equal(
      (await signIn(tess, 'first', { email: 'tess@example.com' })).status,
      303,
    )
  })

  it('U10.5 shows a maintenance page after the offline grace window and recovers on reconnect', async () => {
    const b = browser()
    await signIn(b, 'first', { email: 'tess@example.com' })
    await c.drop('host', 2000, async () => {
      await c.until(() => !runtime().online(), 2000, 'offline')
      assert.equal((await b.get('/')).status, 200)
      runtime().advanceClock(73 * 3_600_000)
      const maintenance = await b.get('/')
      assert.equal(maintenance.status, 503)
      assert.match(await maintenance.text(), /Maintenance/)
      assert.equal((await b.get('/health')).status, 200)
    })
    await c.until(() => runtime().online(), 10000, 'online')
    // Grace counts from the last sync, which the reconnect renewed.
    const back = await b.get('/')
    assert.notEqual(back.status, 503)
    runtime().resetClock()
  })

  it('U10.6 delivers the outbox in order, once, with receipts; only device, prepare and artifact messages exist', async () => {
    const r = runtime()
    const master = c.master.master!
    let id = ''
    await c.drop('host', 1500, async () => {
      await c.until(() => !r.online(), 2000, 'offline')
      id = r.outbox.enqueue('device', {
        udid: '00008110-000A',
        product: 'iPhone15,2',
        model: 'D73AP',
        osVersion: '26.1',
        accountId: 10,
        name: 'Tess’s iPhone',
      })
      r.outbox.enqueue('prepare', { accountId: 10, deviceId: 1, buildId: 100 })
      assert.equal(r.outbox.pending().length, 2)
    })
    await c.until(
      () => r.outbox.pending().length === 0,
      10000,
      'the outbox delivered',
    )
    const receipts = master.database.db
      .prepare('SELECT id,kind FROM host_receipts ORDER BY received_at')
      .all() as Json[]
    assert.deepEqual(
      receipts.map((row) => row.kind),
      ['device', 'prepare'],
    )
    assert.equal(receipts[0].id, id)
    const device = master.database.db
      .prepare(
        "SELECT d.id,a.name FROM devices d JOIN account_devices a ON a.device_id=d.id WHERE d.udid='00008110-000A'",
      )
      .get() as Json
    assert.equal(device.name, 'Tess’s iPhone')
    // The prepare request became a job pinned to build 100's branch and commit;
    // it is removed so later cases start with no waiting job.
    const pinned = await c.until(
      () =>
        master.database.db
          .prepare(
            'SELECT r.status,j.id,j.requested_commit,b.commit_hash FROM device_build_requests r JOIN jobs j ON j.id=r.message JOIN builds b ON b.id=r.build_id WHERE r.build_id=100',
          )
          .get() as Json,
      10_000,
      'the pinned job',
    )
    assert.equal(pinned.status, 'queued')
    assert.equal(pinned.requested_commit, pinned.commit_hash)
    master.database.db.prepare('DELETE FROM jobs WHERE id=?').run(pinned.id)
    // The device reaches the host's cache through the change log.
    await c.until(
      () =>
        r.cache.db
          .prepare("SELECT 1 FROM devices WHERE udid='00008110-000A'")
          .get() != null,
      2000,
      'the device on the host',
    )
    // Redelivery is harmless.
    const link = master.registry.link(c.fingerprint('host'))!
    void link
    const again = master.hosts.deliver(
      { id, kind: 'device', payload: {} },
      c.fingerprint('host'),
    )
    assert.deepEqual(again, { receipt: id, duplicate: true })
    assert.throws(
      () => r.outbox.enqueue('config' as never, {}),
      /not an outbox message/,
    )
    assert.throws(
      () =>
        master.hosts.deliver(
          { id: 'abcdefghij', kind: 'settings', payload: {} },
          'x',
        ),
      /not an outbox message/,
    )
    assert.throws(
      () => master.hosts.deliver({ id: 'x', kind: 'device', payload: {} }, 'x'),
      /idempotency ID/,
    )
    assert.throws(
      () =>
        master.hosts.deliver(
          { id: 'abcdefghik', kind: 'device', payload: { udid: 'u' } },
          'x',
        ),
      /required/,
    )
    // A message the master refuses is set aside after three refusals and no
    // longer holds back the messages behind it.
    const refused = r.outbox.enqueue('prepare', { accountId: 10 })
    r.outbox.enqueue('device', {
      udid: '00008110-000B',
      product: 'iPhone15,2',
      model: 'D73AP',
      osVersion: '26.1',
      accountId: 10,
      name: 'Second iPhone',
    })
    const hostLink = r.options.link()
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(r.outbox.pending().length, 2)
      await r.outbox.flush(hostLink)
    }
    await r.outbox.flush(hostLink)
    assert.deepEqual(r.outbox.pending(), [])
    assert.deepEqual(r.outbox.refused(), [
      {
        id: refused,
        kind: 'prepare',
        refused: 'prepare needs accountId, deviceId and buildId',
      },
    ])
    assert(
      master.database.db
        .prepare("SELECT 1 FROM devices WHERE udid='00008110-000B'")
        .get(),
    )
  })

  const deliver = async (
    event: string,
    body: object,
    secret = 'webhook-secret-value',
    project = 'edge',
  ): Promise<Response> => {
    const raw = Buffer.from(JSON.stringify(body))
    return await fetch(
      `${c.hosts.get('host')!.web!.url}/api/webhooks/github/${project}`,
      {
        method: 'POST',
        // @ts-expect-error undici's dispatcher option
        dispatcher: insecure,
        headers: {
          'content-type': 'application/json',
          'x-github-event': event,
          'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
        },
        body: raw,
      },
    )
  }
  const push = (branch: string, commit: string): object => ({
    ref: `refs/heads/${branch}`,
    after: commit,
    repository: { full_name: 'EdgeApp/edge-react-gui' },
  })

  it('U10.17 signs a master account in on the host with its username and password, checked by the master', async () => {
    const master = c.master.master!
    const p = clientParameters('b1'.repeat(16), DEFAULT_PASSWORD_COSTS)
    const hugo = await master.people.create(admin, {
      name: 'Hugo',
      email: 'hugo@example.com',
      username: 'hugo',
      role: 'developer',
      password: {
        clientHash: await clientPasswordHash('Hugo-Horse-9', p),
        clientParameters: p,
      },
    })
    await c.until(
      () =>
        runtime()
          .cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(hugo.id) != null,
      2000,
      'Hugo on the host',
    )
    const hugoBrowser = browser()
    const login = await hugoBrowser.get('/auth/login?return=/apps')
    const form = await login.text()
    assert.match(form, /data-session="\/auth\/password"/)
    assert.match(form, /data-return="\/apps"/)
    assert.match(
      login.headers.get('content-security-policy')!,
      /'wasm-unsafe-eval'/,
    )
    assert.equal(
      (await hugoBrowser.get('/assets/password-worker.js')).status,
      200,
    )
    const json = async (route: string, value: unknown): Promise<Response> =>
      await hugoBrowser.get(route, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      })
    const given = (await (
      await json('/auth/password/parameters', { username: 'Hugo' })
    ).json()) as Parameters<typeof clientPasswordHash>[1]
    const wrong = await json('/auth/password', {
      username: 'hugo',
      clientHash: await clientPasswordHash('not-it', given),
    })
    assert.equal(wrong.status, 401)
    assert.match(((await wrong.json()) as { error: string }).error, /wrong/)
    assert.equal(session(hugoBrowser), undefined)
    const right = await json('/auth/password', {
      username: 'hugo',
      clientHash: await clientPasswordHash('Hugo-Horse-9', given),
    })
    assert.equal(right.status, 200)
    const signedIn = runtime().accounts.session(session(hugoBrowser))!
    assert.equal(signedIn.account.id, hugo.id)
    assert.equal(signedIn.account.is_admin, 0)
    // Without the master no password can be checked.
    const link = runtime().options.link
    runtime().options.link = (): undefined => undefined
    try {
      assert.equal(
        (await json('/auth/password/parameters', { username: 'hugo' })).status,
        503,
      )
    } finally {
      runtime().options.link = link
    }
  })

  it('U10.12 relays a signed push to the master, which verifies it and schedules it under the branch rules', async () => {
    const jobs = (): Json[] =>
      c.master
        .master!.database.db.prepare(
          "SELECT branch,commit_sha,requested_commit,status FROM jobs WHERE trigger='push'",
        )
        .all() as Json[]
    assert.equal((await deliver('ping', { zen: 'hi' })).status, 202)
    const scheduled = await deliver('push', push('develop', 'e'.repeat(40)))
    assert.equal(scheduled.status, 202)
    assert.equal(((await scheduled.json()) as Json).status, 'scheduled')
    assert.deepEqual(
      jobs().map((row) => row.requested_commit),
      ['e'.repeat(40)],
    )
    assert.equal(
      (
        (await (
          await deliver('push', push('feature/x', 'f'.repeat(40)))
        ).json()) as Json
      ).status,
      'ignored',
    )
    assert.equal(
      (await deliver('push', push('develop', '1'.repeat(40)), 'wrong secret'))
        .status,
      401,
    )
    assert.equal(
      (
        await deliver('push', {
          ...push('develop', '2'.repeat(40)),
          repository: { full_name: 'Other/repo' },
        })
      ).status,
      422,
    )
    assert.equal(
      (await deliver('push', push('develop', '3'.repeat(40)), 'x', 'nope'))
        .status,
      404,
    )
    const unsigned = await fetch(
      `${c.hosts.get('host')!.web!.url}/api/webhooks/github/edge`,
      {
        method: 'POST',
        // @ts-expect-error undici's dispatcher option
        dispatcher: insecure,
        body: '{}',
      },
    )
    assert.equal(unsigned.status, 401)
    const big = await fetch(
      `${c.hosts.get('host')!.web!.url}/api/webhooks/github/edge`,
      {
        method: 'POST',
        // @ts-expect-error undici's dispatcher option
        dispatcher: insecure,
        headers: {
          'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
          'x-github-event': 'push',
        },
        body: Buffer.alloc(1024 * 1024 + 1, 'x'),
      },
    )
    assert.equal(big.status, 413)
    assert.equal(jobs().length, 1)
    // The secret stays on the master: not in the project API, the change log or the host.
    const shown = await c.api('GET', '/api/v2/projects/edge')
    assert.deepEqual(shown.json.webhookSecret, { set: true })
    assert(
      !readFileSync(path.join(host.dir, 'host-cache.sqlite')).includes(
        'webhook-secret-value',
      ),
    )
  })

  it('U10.13 keeps only the latest delivery per project and branch while the master is unreachable, then forwards it', async () => {
    const db = c.master.master!.database.db
    db.exec("UPDATE jobs SET status='cancelled' WHERE trigger='push'")
    await c.drop('host', 2000, async () => {
      await c.until(() => !runtime().online(), 2000, 'offline')
      for (const commit of ['4', '5', '6']) {
        const kept = await deliver('push', push('develop', commit.repeat(40)))
        assert.equal(kept.status, 202)
        assert.equal(((await kept.json()) as Json).status, 'queued')
      }
      await deliver('push', push('main', '7'.repeat(40)))
      assert.deepEqual(
        runtime()
          .webhooks.queued()
          .map((row) => row.branch)
          .sort(),
        ['develop', 'main'],
      )
    })
    await c.until(
      () => runtime().webhooks.queued().length === 0,
      10000,
      'the deliveries forwarded',
    )
    const develop = db
      .prepare(
        "SELECT requested_commit FROM jobs WHERE trigger='push' AND status<>'cancelled'",
      )
      .all() as Json[]
    assert.deepEqual(
      develop.map((row) => row.requested_commit),
      ['6'.repeat(40)],
    )
    // Excessive deliveries are refused.
    let status = 0
    for (let i = 0; i < 70 && status !== 429; i++)
      status = (await deliver('ping', {})).status
    assert.equal(status, 429)
  })

  it('U10.11 mason host import moves sessions and identities, which stay valid, and refuses while the host runs', async () => {
    const dir = root()
    const storage = path.join(dir, 'storage')
    mkdirSync(storage, { mode: 0o700 })
    const legacy = new Store(
      asConfig({
        origin: ORIGIN,
        database: path.join(dir, 'distribution.sqlite'),
        storage,
      }),
    )
    const token = 't'.repeat(43)
    const now = Date.now()
    legacy.db.exec(`
      INSERT INTO accounts(id,name,email,is_tester,permission_version,created_at) VALUES(10,'Tess Tester','tess@example.com',1,0,${now});
      INSERT INTO identities(account_id,provider,issuer,subject,email,email_verified) VALUES(10,'first','https://identity.example.test/first','tess-subject','tess@example.com',1);
      INSERT INTO sessions VALUES('${digest(token)}',10,0,'${'c'.repeat(43)}',${now},${now + 86_400_000});
    `)
    mkdirSync(path.join(storage, 'files'), { recursive: true })
    writeFileSync(
      path.join(storage, 'files', 'e'.repeat(32) + '.apk'),
      'old build',
    )
    legacy.close()
    assert.throws(
      () =>
        importHost(host.dir, {
          distribution: path.join(dir, 'distribution.sqlite'),
        }),
      /Another Mason process .* is using this data directory/,
    )
    // The master's account carries the permission version the session was made with.
    const master = c.master.master!
    master.database.db
      .prepare('UPDATE accounts SET permission_version=0 WHERE id=10')
      .run()
    master.database.change('account', 10)
    const data = path.join(c.root, 'imported')
    const summary = importHost(data, {
      distribution: path.join(dir, 'distribution.sqlite'),
      storage,
    })
    assert.deepEqual(summary, { sessions: 1, identities: 1, files: 1 })
    const imported = await c.startHost('imported', {
      hostOptions: { transport: env.transport },
    })
    const b = new Browser(() => imported.web!.url)
    b.cookies.set('__Host-mason-session', token)
    const catalog = await b.get('/')
    const text = await catalog.text()
    assert.equal(catalog.status, 200, text)
    assert.match(text, /Edge Wallet/)
    assert(
      existsSync(path.join(data, 'storage', 'files', 'e'.repeat(32) + '.apk')),
    )
    assert.throws(
      () =>
        importHost(data, {
          distribution: path.join(dir, 'distribution.sqlite'),
        }),
      /Another Mason process .* is using this data directory/,
    )
    master.database.db
      .prepare('UPDATE accounts SET permission_version=1 WHERE id=10')
      .run()
    master.database.change('account', 10)
  })

  it('U10.14 serves exactly the current release at /install.sh and switches with it', async () => {
    const b = browser()
    assert.equal((await b.get('/install.sh')).status, 404)
    const release = (version: string): string => {
      const dir = path.join(root(), version)
      mkdirSync(dir)
      const files: Record<string, string> = {
        'install.sh': `#!/bin/bash\necho ${version}\n`,
        [`mason-${version}-linux-x64.tar.gz`]: `tarball ${version}`,
      }
      for (const [name, text] of Object.entries(files))
        writeFileSync(path.join(dir, name), text)
      writeFileSync(
        path.join(dir, 'SHA256SUMS'),
        Object.entries(files)
          .map(
            ([name, text]) =>
              `${createHash('sha256').update(text).digest('hex')}  ${name}`,
          )
          .join('\n') + '\n',
      )
      return dir
    }
    const master = c.master.master!
    await master.releases.add(release('0.2.0'))
    master.releases.setCurrent('0.2.0')
    await c.until(
      () => runtime().currentRelease()?.version === '0.2.0',
      5000,
      'install.sh on the host',
    )
    assert.equal(
      await (await b.get('/install.sh')).text(),
      '#!/bin/bash\necho 0.2.0\n',
    )
    assert.equal(
      await (
        await b.get('/releases/current/mason-0.2.0-linux-x64.tar.gz')
      ).text(),
      'tarball 0.2.0',
    )
    assert.match(
      await (await b.get('/releases/current/SHA256SUMS')).text(),
      /mason-0\.2\.0-linux-x64/,
    )
    assert.equal((await b.get('/releases/current/other.txt')).status, 404)
    await master.releases.add(release('0.2.1'))
    master.releases.setCurrent('0.2.1')
    await c.until(
      () => runtime().currentRelease()?.version === '0.2.1',
      5000,
      'the new release',
    )
    assert.equal(
      await (await b.get('/install.sh')).text(),
      '#!/bin/bash\necho 0.2.1\n',
    )
    assert(!existsSync(path.join(host.dir, 'storage', 'releases', '0.2.0')))
  })

  it('U10.14 mirrors the first Xcode a node downloads on the host, and nodes install it from there once Apple’s session lapses', async () => {
    const master = c.master.master!
    await master.settings.set(admin, 'nodeTypes', {
      'mac-xcode': { software: { xcode: ['26.1'] } },
    })
    assert.equal(
      (
        await master.appleSignIn(
          admin,
          'builds@example.com',
          'Apple-Password-9',
        )
      ).state,
      'needsCode',
    )
    assert.equal((await master.appleCode(admin, apple.code)).state, 'signedIn')
    await c.until(
      () => existsSync(path.join(mac.applications, 'Xcode-26.1.app')),
      20000,
      'Xcode from Apple',
    )
    await c.until(
      () => existsSync(runtime().xcodeFile('26.1')),
      10000,
      'the mirror on the host',
    )
    assert.equal(
      readFileSync(runtime().xcodeFile('26.1'), 'utf8'),
      'xcode:26.1:17B55',
    )
    assert.equal(apple.downloadCookies.length, 1)
    // Apple's session lapses; a new node gets the version from the host with the master's grant.
    apple.expire()
    await master.apple.check()
    assert.notEqual(master.apple.status().state, 'signedIn')
    const authorization = master.hosts.mirrorAuthorization('26.1')!
    assert(authorization.pin != null)
    assert.match(authorization.url, /\/xcode\/Xcode-26\.1\.xip\?grant=/)
    const direct = await pinnedFetch(authorization.url, {}, authorization.pin)
    assert.equal(await direct.text(), 'xcode:26.1:17B55')
    assert.equal(
      (
        await pinnedFetch(
          authorization.url.replace(/grant=.*/, 'grant=forged.sig'),
          {},
          authorization.pin,
        )
      ).status,
      403,
    )
    assert.equal(
      (
        await pinnedFetch(
          authorization.url.replace('26.1.xip', '26.2.xip'),
          {},
          authorization.pin,
        )
      ).status,
      403,
    )
    const spare = root()
    const second = new FakeMac(path.join(spare, 'mac2'))
    writeFileSync(path.join(spare, 'mac2-helper.sock'), '')
    fakeXcode(path.join(second.applications, 'Xcode.app'), '26.0.1', '17A400')
    await c.startWorker({
      name: 'mac2',
      type: 'mac-xcode',
      workerOptions: {
        applications: second.applications,
        systemRun: second.run,
        helper: second.helper,
        helperSocket: path.join(spare, 'mac2-helper.sock'),
      },
    })
    await c.until(
      () => existsSync(path.join(second.applications, 'Xcode-26.1.app')),
      20000,
      'Xcode from the mirror',
    )
    assert.equal(
      apple.downloadCookies.length,
      1,
      'the second node never went to Apple',
    )
    // An expired grant is refused.
    runtime().advanceClock(2 * 3_600_000)
    assert.equal(
      (await pinnedFetch(authorization.url, {}, authorization.pin)).status,
      403,
    )
    runtime().resetClock()
  })

  it('U10.4 answers unavailable pages, missing files and the waiting host plainly', async () => {
    const anonymous = browser()
    const login = await anonymous.get('/projects/edge')
    assert.equal(login.status, 303)
    assert.match(login.headers.get('location')!, /^\/auth\/login\?return=/)
    const tess = browser()
    await signIn(tess, 'first', { email: 'tess@example.com' })
    const master = c.master.master!
    master.saveProject(admin, 'hidden', {
      name: 'Hidden',
      repository: 'https://github.com/EdgeApp/hidden',
    })
    master.database.db.exec(
      "INSERT INTO project_apps(app_id,project_id) SELECT 2,id FROM projects WHERE slug='hidden'",
    )
    master.database.change('project', 'hidden')
    await c.until(
      () =>
        runtime()
          .cache.db.prepare('SELECT 1 FROM project_apps WHERE app_id=2')
          .get() != null,
      2000,
      'the hidden project',
    )
    assert.equal((await tess.get('/projects/hidden')).status, 404)
    assert.equal((await tess.get('/projects/none')).status, 404)
    const script = await tess.get('/assets/catalog.js')
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type')!, /javascript/)
    assert.equal((await tess.get('/nothing-here')).status, 404)
    assert.equal((await tess.get('/releases/current/..%2Fsecret')).status, 404)
    // A listed release file missing from disk, and a granted Xcode the host does not have.
    const release = runtime().currentRelease()!
    const { rmSync } = await import('node:fs')
    rmSync(path.join(release.dir, 'install.sh'))
    assert.equal((await tess.get('/install.sh')).status, 404)
    master.database.db
      .prepare(
        "INSERT INTO xcode_mirrors(version,sha256,size,at) VALUES('27.0',?,1,0)",
      )
      .run('0'.repeat(64))
    const grant = master.hosts.mirrorAuthorization('27.0')!
    assert.equal((await pinnedFetch(grant.url, {}, grant.pin)).status, 404)
    // Offline, plain answers pass through without the banner.
    await c.drop('host', 1000, async () => {
      await c.until(() => !runtime().online(), 2000, 'offline')
      const missing = await tess.get('/nothing-here')
      assert.equal(await missing.text(), 'Not found')
    })
    await c.until(() => runtime().online(), 10000, 'online')
    // A host started before it has a runtime only says it is waiting.
    const { hostApp } = await import('./web.js')
    const server = hostApp({ role: 'host', testEndpoints: true }).listen(
      0,
      '127.0.0.1',
    )
    await new Promise((resolve) => server.once('listening', resolve))
    const waiting = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/anything`,
    )
    assert.equal(waiting.status, 503)
    assert.match(await waiting.text(), /waiting for its master/)
    server.close()
  })

  it('U10.5 test endpoints move the host clock and open a session, only with --test-endpoints', async () => {
    const { controlRequest } = await import('../node/control.js')
    const before = runtime().now()
    const moved = (await controlRequest(host.dir, 'test.clock', {
      ms: 1000,
    })) as { now: number }
    assert(moved.now >= before + 1000)
    runtime().resetClock()
    const { token } = (await controlRequest(host.dir, 'test.session', {
      account: 10,
    })) as { token: string }
    const b = browser()
    b.cookies.set('__Host-mason-session', token)
    assert.equal((await b.get('/')).status, 200)
  })

  it('U10.15 validates the host and signIn areas, keeps client secrets write-only, and publishes them to the host', async () => {
    const settings = c.master.master!.settings
    await assert.rejects(
      settings.set(admin, 'host', { origin: 'http://builds.example.test' }),
      /HTTPS/,
    )
    await assert.rejects(
      settings.set(admin, 'host', {
        origin: 'https://builds.example.test/path',
      }),
      /origin/,
    )
    await assert.rejects(
      settings.set(admin, 'host', { origin: ORIGIN, workerOrigin: 'ftp://x' }),
      /HTTPS/,
    )
    await assert.rejects(
      settings.set(admin, 'host', { origin: ORIGIN, offlineGraceHours: 0 }),
    )
    const shown = settings.get(admin, 'signIn') as Json
    assert(
      shown.methods.every((method: Json) => method.clientSecret.set === true),
    )
    assert(!JSON.stringify(shown).includes('fixture-secret'))
    await assert.rejects(
      settings.set(admin, 'signIn', {
        methods: [
          { ...env.configs[0]!, id: 'newone', clientSecret: { keep: true } },
        ],
      }),
      /No stored client secret/,
    )
    await assert.rejects(
      settings.set(admin, 'signIn', {
        methods: [{ ...env.configs[0]!, issuer: 'http://insecure' }],
      }),
    )
    await assert.rejects(settings.set(admin, 'signIn', { methods: {} }), /list/)
    await assert.rejects(
      settings.set(admin, 'signIn', {
        methods: [env.configs[0], env.configs[0]],
      }),
      /twice/,
    )
    await assert.rejects(
      settings.set(admin, 'signIn', {
        methods: [{ ...env.configs[0]!, enabled: 'yes' }],
      }),
      /true or false/,
    )
    await settings.set(admin, 'host', {
      origin: ORIGIN,
      workerOrigin: 'https://workers.example.test',
      offlineGraceHours: 24,
    })
    await c.until(
      () => runtime().cache.host()?.offlineGraceHours === 24,
      2000,
      'the host setting on the host',
    )
    assert.equal(
      runtime().cache.host()!.workerOrigin,
      'https://workers.example.test',
    )
  })
})
