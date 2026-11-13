import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { Accounts, type Session } from '../auth/accounts.js'
import { SESSION_COOKIE } from '../auth/routes.js'
import { branchKey } from '../catalog/platform.js'
import { asConfig } from '../config.js'
import { localOperator } from '../master/roles.js'
import type { RunningNode } from '../node/serve.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import { Store, digest, insertBuild } from '../store.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { assertShell } from '../test/webShell.js'
import { packageFields, plist, zip } from '../upload/fixtures.test.js'
import { backfillDevices } from './backfill.js'
import { verifyCms } from './cms.js'
import { decodePlist } from './plist.js'
import { inspectProvisioning, saveProvisioning } from './provisioning.js'
import { DEVICE_COOKIE, Devices, friendlyName } from './store.js'

// Answers are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const admin = localOperator
const MASTER_ORIGIN = 'https://master.example.test'
/** A device identifier of the fixture's own, numbered. */
const device = (n: number): string =>
  '0'.repeat(38) + n.toString(16).toUpperCase().padStart(2, '0')
const sha = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex')

/** A fixture "Apple" device CA and an identity it signed, in `root`. */
function makeIdentity(root: string): void {
  const openssl = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
  }
  openssl([
    ...'req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -subj'.split(
      ' ',
    ),
    '/CN=Apple Fixture Device CA',
  ])
  openssl(
    'req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj /CN=Fixture-Device'.split(
      ' ',
    ),
  )
  openssl(
    'x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem -days 1'.split(
      ' ',
    ),
  )
}
/** `xml` signed by the fixture identity, as an iPhone's Profile Service answer or a profile is. */
function sign(root: string, xml: string, signer = 'leaf'): Buffer {
  writeFileSync(path.join(root, 'data.plist'), xml, { mode: 0o600 })
  execFileSync(
    'openssl',
    `cms -sign -binary -nodetach -in data.plist -signer ${signer}.pem -inkey ${signer}.key -certfile ca.pem -outform DER -out signed.der`.split(
      ' ',
    ),
    { cwd: root, stdio: 'ignore' },
  )
  return readFileSync(path.join(root, 'signed.der'))
}
/** What an iPhone answers the Profile Service with. */
const payload = (token: string, id: string, product = 'iPhone14,5'): string =>
  `<plist version="1.0"><dict><key>CHALLENGE</key><string>${token}</string><key>UDID</key><string>${id}</string><key>PRODUCT</key><string>${product}</string><key>VERSION</key><string>26.0</string></dict></plist>`
/** An ad hoc profile carrying `devices`, as Xcode embeds it in an IPA. */
const adHoc = (devices: string[], getTaskAllow = false): string =>
  `<plist version="1.0"><dict><key>ProvisionedDevices</key><array>${devices.map((id) => `<string>${id}</string>`).join('')}</array><key>TeamIdentifier</key><array><string>FIXTURE</string></array><key>ExpirationDate</key><date>${new Date(Date.now() + 86400000).toISOString()}</date><key>Entitlements</key><dict><key>get-task-allow</key>${getTaskAllow ? '<true/>' : '<false/>'}<key>application-identifier</key><string>FIXTURE.${packageFields.bundleId}</string></dict></dict></plist>`

interface Reply {
  status: number
  text: string
  body: Buffer
  json: Json
  headers: { get(name: string): string | null }
}
/** A tester signed in on the host. */
interface Who {
  id: number
  cookie: string
  csrf: string
  session: Session
}

describe('Device registration on the host, through the cluster', function () {
  this.timeout(180_000)
  let root: string
  let c: Cluster
  let host: RunningNode
  let appId: number
  let channelId: number

  const url = (node: RunningNode): string =>
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  const hostDb = (): DatabaseSync => host.host!.cache.db
  const masterDb = (): DatabaseSync => c.master.master!.database.db
  const request = async (
    route: string,
    init: {
      method?: string
      cookie?: string
      headers?: Record<string, string>
      body?: Uint8Array
      node?: RunningNode
    } = {},
  ): Promise<Reply> => {
    const node = init.node ?? host
    const response = await pinnedFetch(
      url(node) + route,
      {
        method: init.method ?? 'GET',
        redirect: 'manual',
        headers: {
          ...(init.cookie == null ? {} : { cookie: init.cookie }),
          ...init.headers,
        },
        ...(init.body == null ? {} : { body: init.body }),
      },
      node.web!.certificate!.pin,
    )
    const body = Buffer.from(await response.arrayBuffer())
    let json: Json
    try {
      json = JSON.parse(body.toString())
    } catch {
      json = undefined
    }
    return {
      status: response.status,
      text: body.toString(),
      body,
      json,
      headers: response.headers,
    }
  }
  /** A JSON call as the web app makes it: a change carries the session's proof from the host's origin. */
  const api = async (
    method: 'GET' | 'POST',
    route: string,
    who: Who | undefined,
    options: { extra?: string; body?: unknown; csrf?: string } = {},
  ): Promise<Reply> =>
    await request(route, {
      method,
      ...(who == null ? {} : { cookie: who.cookie + (options.extra ?? '') }),
      headers:
        method === 'GET'
          ? {}
          : {
              origin: host.host!.cache.store.config.origin,
              'x-mason-csrf': options.csrf ?? who?.csrf ?? '',
              ...(options.body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
            },
      ...(options.body === undefined
        ? {}
        : { body: new TextEncoder().encode(JSON.stringify(options.body)) }),
    })
  const callback = async (token: string, body?: Buffer): Promise<Reply> =>
    await request(`/devices/callback/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pkcs7-signature' },
      ...(body == null ? {} : { body: new Uint8Array(body) }),
    })
  /** A tester the master made, once the host has them, signed in on the host. */
  const tester = async (name: string, email: string): Promise<Who> => {
    const master = c.master.master!
    const id = (
      await master.people.create(admin, {
        name,
        emails: [email],
        role: 'tester',
      })
    ).id
    await c.until(
      () => hostDb().prepare('SELECT 1 FROM accounts WHERE id=?').get(id),
      10_000,
      `${name} on the host`,
    )
    const { token, session } = host.host!.accounts.startSession(id)
    return {
      id,
      cookie: `${SESSION_COOKIE}=${token}`,
      csrf: session.csrf,
      session,
    }
  }
  /** Register Device: the profile the web app hands the iPhone, downloaded once; its challenge. */
  const challenge = async (who: Who): Promise<string> => {
    const made = await api('POST', '/api/v2/devices/registrations', who)
    assert.equal(made.status, 200, made.text)
    const profile = await request(made.json.url)
    assert.equal(profile.status, 200, profile.text)
    const content = decodePlist(profile.body).PayloadContent as Record<
      string,
      unknown
    >
    return String(content.Challenge)
  }
  /** The device row on the host, once the master has it for `who`. */
  const onHost = async (who: Who, udid: string): Promise<number> =>
    await c.until(
      () =>
        (
          hostDb()
            .prepare(
              'SELECT d.id FROM devices d JOIN account_devices a ON a.device_id=d.id WHERE d.udid=? AND a.account_id=?',
            )
            .get(udid, who.id) as Json
        )?.id as number | undefined,
      10_000,
      'the device on the host',
    )
  /** A device registered end to end: profile, signed callback, the master's row back on the host. */
  const register = async (
    who: Who,
    udid: string,
    product?: string,
  ): Promise<number> => {
    const token = await challenge(who)
    const reply = await callback(
      token,
      sign(root, payload(token, udid, product)),
    )
    assert.equal(reply.status, 301, reply.text)
    return await onHost(who, udid)
  }
  /** A row of the host's cache, once the master's change to it arrives. */
  const synced = async (
    sql: string,
    args: Array<string | number>,
    check: (row: Json) => boolean,
    label: string,
  ): Promise<Json> =>
    await c.until(
      () => {
        const row = hostDb()
          .prepare(sql)
          .get(...args) as Json
        return row != null && check(row) ? row : undefined
      },
      10_000,
      label,
    )
  const deviceList = async (who: Who, extra = ''): Promise<Json> => {
    const reply = await api('GET', '/api/v2/devices', who, { extra })
    assert.equal(reply.status, 200, reply.text)
    return reply.json
  }

  before(async () => {
    root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'devices-'),
    )
    makeIdentity(root)
    c = await cluster(path.join(root, 'cluster'))
    host = await c.startHost('host', { testEndpoints: true })
    host.host!.setTrustRoot(readFileSync(path.join(root, 'ca.pem'), 'utf8'))
    const master = c.master.master!
    await master.settings.set(admin, 'host', { origin: url(host) })
    await master.settings.set(admin, 'master', { origin: MASTER_ORIGIN })
    await c.until(
      () => host.host!.cache.store.config.origin === url(host),
      10_000,
      'the host origin on the host',
    )
    const repo = c.repo('fixtures/devices')
    repo.commit({ 'Masonfile.ts': 'export function setup() {}' })
    master.saveProject(admin, 'devices', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
      apps: [
        {
          bundleId: packageFields.bundleId,
          name: 'Fixture',
          platforms: ['ios'],
        },
      ],
    })
    appId = Number(
      (
        masterDb()
          .prepare('SELECT id FROM apps WHERE slug=?')
          .get(packageFields.bundleId) as Json
      ).id,
    )
    channelId = Number(
      (
        masterDb()
          .prepare("SELECT id FROM channels WHERE app_id=? AND platform='ios'")
          .get(appId) as Json
      ).id,
    )
  })
  after(async () => {
    await c?.close()
    if (root != null) rmSync(root, { recursive: true, force: true })
  })

  it('collects a signed device callback once, generates its name, and saves it to the correct account', async () => {
    const mark = await tester('Fixture User', 'mark@example.test')
    const made = await api('POST', '/api/v2/devices/registrations', mark)
    assert.equal(made.status, 200, made.text)
    assert.match(made.json.url, /^\/devices\/profiles\/[A-Za-z0-9_-]{43}$/)
    const response = await request(made.json.url)
    assert.equal(response.status, 200)
    assert.match(
      response.headers.get('content-type')!,
      /application\/x-apple-aspen-config/,
    )
    assert.equal(response.headers.get('cache-control'), 'no-store')
    // The download is once.
    assert.equal((await request(made.json.url)).status, 404)
    const profile = decodePlist(response.body)
    assert.match(String(profile.PayloadUUID), /^[a-f0-9-]{36}$/)
    const content = profile.PayloadContent as Record<string, unknown>,
      token = String(content.Challenge)
    assert.deepEqual(content.DeviceAttributes, ['UDID', 'PRODUCT', 'VERSION'])
    assert.equal(content.URL, `${url(host)}/devices/callback/${token}`)
    // A registration the host started names no other origin to return to.
    assert.equal(
      (
        hostDb()
          .prepare('SELECT return_origin FROM device_challenges WHERE hash=?')
          .get(digest(token)) as Json
      ).return_origin,
      null,
    )
    const reply = await callback(token, sign(root, payload(token, device(1))))
    assert.equal(reply.status, 301, reply.text)
    assert.equal(
      reply.headers.get('location'),
      `${url(host)}/devices/complete/${token}`,
    )
    // Until the master's row comes back, the link says it is registering.
    const early = await api('GET', `/api/v2/devices/complete/${token}`, mark)
    assert.match(early.json.state, /^(registering|registered)$/)
    const id = await onHost(mark, device(1))
    const found = (await deviceList(mark)).devices as Json[]
    assert.equal(found.length, 1)
    // Named for the model and the person (the master sent no email address).
    assert.equal(found[0].name, 'iPhone13 of Fixture User')
    assert.equal(found[0].model, 'iPhone13')
    assert.equal(found[0].udid, device(1))
    // The completion link selects the device and answers the web app's shell.
    const complete = await request(`/devices/complete/${token}`, {
      cookie: mark.cookie,
    })
    assertShell(complete)
    assert.match(
      complete.headers.get('set-cookie')!,
      new RegExp(`^${DEVICE_COOKIE}=${id}; .*HttpOnly; Secure`),
    )
    const done = await api('GET', `/api/v2/devices/complete/${token}`, mark)
    assert.deepEqual(done.json, {
      state: 'registered',
      device: { id, model: 'iPhone13' },
    })
    assert.match(done.headers.get('set-cookie')!, new RegExp(`=${id};`))
    // The same answer again is refused: the request is used. (The host's
    // relay never marks the challenge used, so this is the registration's
    // refusal, 400, not the expired request's 410.)
    const again = await callback(token, sign(root, payload(token, device(1))))
    assert.equal(again.status, 400, again.text)
    assert.equal(
      hostDb()
        .prepare(
          'SELECT COUNT(*) n FROM host_device_registrations WHERE hash=?',
        )
        .get(digest(token))!.n,
      1,
    )
    // One another origin asked for (the master's) returns there.
    const registry = new Devices(host.host!.cache.store, host.host!.devices)
    const returning = registry.challenge(mark.session, MASTER_ORIGIN)
    const elsewhere = await callback(
      returning,
      sign(root, payload(returning, device(2))),
    )
    assert.equal(elsewhere.status, 301, elsewhere.text)
    assert.equal(
      elsewhere.headers.get('location'),
      `${MASTER_ORIGIN}/devices/complete/${returning}`,
    )
    await onHost(mark, device(2))
    // The same device again, as a newer model, is still one device.
    assert.equal(await register(mark, device(1), 'iPhone18,1'), id)
    await synced(
      'SELECT model FROM devices WHERE id=?',
      [id],
      (row) => row.model === 'iPhone17Pro',
      'the new model on the host',
    )
    const listed = (await deviceList(mark)).devices as Json[]
    assert.deepEqual(listed.map((entry) => entry.udid).sort(), [
      device(1),
      device(2),
    ])
    // Another account has none of them, and the link is not theirs.
    const other = await tester('Another', 'another@example.test')
    assert.deepEqual((await deviceList(other)).devices, [])
    assertShell(
      await request(`/devices/complete/${token}`, { cookie: other.cookie }),
      410,
    )
    assert.deepEqual(
      (await api('GET', `/api/v2/devices/complete/${token}`, other)).json,
      { state: 'unavailable' },
    )
  })

  it('rejects unsigned, tampered, wrong-challenge, expired and invalid identifiers', async () => {
    const rita = await tester('Rita', 'rita@example.test')
    const token = await challenge(rita)
    const tampered = sign(root, payload(token, device(3)))
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1
    await assert.rejects(
      verifyCms(tampered, path.join(root, 'ca.pem'), true),
      /could not be verified/,
    )
    await assert.rejects(
      verifyCms(Buffer.alloc(0), path.join(root, 'ca.pem'), true),
      /size/,
    )
    for (const body of [
      // Tampered, unsigned, and none at all.
      tampered,
      Buffer.from(payload(token, device(3))),
      undefined,
      // Signed, but for another challenge, an invalid identifier or a Mac.
      sign(root, payload('wrong', device(3))),
      sign(root, payload(token, 'invalid')),
      sign(root, payload(token, device(3), 'Mac14,2')),
    ]) {
      const reply = await callback(token, body)
      assert.equal(reply.status, 400, reply.text)
      assert.match(reply.text, /could not be verified/)
    }
    // None of them was recorded.
    assert.equal(
      hostDb()
        .prepare('SELECT 1 FROM host_device_registrations WHERE hash=?')
        .get(digest(token)),
      undefined,
    )
    // An expired request is gone.
    hostDb()
      .prepare('UPDATE device_challenges SET expires_at=0 WHERE hash=?')
      .run(digest(token))
    assert.equal(
      (await callback(token, sign(root, payload(token, device(3))))).status,
      410,
    )
    assert.deepEqual((await deviceList(rita)).devices, [])
  })

  it('enforces account ownership and CSRF', async () => {
    // Signed out: Devices sends to sign in; its JSON refuses.
    const page = await request('/devices')
    assert.equal(page.status, 303)
    assert.equal(page.headers.get('location'), '/auth/login?return=%2Fdevices')
    assert.equal((await api('GET', '/api/v2/devices', undefined)).status, 401)
    const olga = await tester('Olga', 'olga@example.test')
    // A change without the session's proof, or from another origin.
    const unproven = await api('POST', '/api/v2/devices/registrations', olga, {
      csrf: 'bad',
    })
    assert.equal(unproven.status, 403)
    assert.deepEqual(unproven.json, { error: 'Invalid request proof' })
    const foreign = await request('/api/v2/devices/registrations', {
      method: 'POST',
      cookie: olga.cookie,
      headers: {
        origin: 'https://elsewhere.example',
        'x-mason-csrf': olga.csrf,
      },
    })
    assert.equal(foreign.status, 403)
    const id = await register(olga, device(4))
    // Another tester cannot rename it.
    const other = await tester('Otto', 'otto@example.test')
    const attack = await api('POST', `/api/v2/devices/${id}/rename`, other, {
      body: { name: 'Changed' },
    })
    assert.equal(attack.status, 404)
    assert.deepEqual(attack.json, { error: 'Device unavailable' })
    const renamed = await api('POST', `/api/v2/devices/${id}/rename`, olga, {
      body: { name: 'My iPhone' },
    })
    assert.equal(renamed.status, 200, renamed.text)
    await synced(
      'SELECT name FROM account_devices WHERE device_id=? AND account_id=?',
      [id, olga.id],
      (row) => row.name === 'My iPhone',
      'the rename on the host',
    )
    assert.equal(
      (
        masterDb()
          .prepare('SELECT name FROM account_devices WHERE device_id=?')
          .get(id) as Json
      ).name,
      'My iPhone',
    )
    // Devices is the web app's page; its QR code is the host's own.
    assertShell(await request('/devices', { cookie: olga.cookie }))
    const qr = await request('/devices/qr', { cookie: olga.cookie })
    assert.equal(qr.status, 200)
    assert.match(qr.text, /^<svg /)
  })

  it('verifies embedded ad hoc profiles and prevents installation on excluded devices', async () => {
    const ada = await tester('Ada', 'ada@example.test')
    c.master.master!.people.createGroup(admin, {
      name: 'Ad hoc',
      apps: [appId],
      members: [ada.id],
    })
    const included = await register(ada, device(5))
    const excluded = await register(ada, device(6))
    // Registered with Apple, as the master's provisioning leaves them.
    for (const id of [included, excluded]) {
      masterDb()
        .prepare("UPDATE devices SET status='registered',message='' WHERE id=?")
        .run(id)
      c.master.master!.database.change('device', id)
    }
    await synced(
      "SELECT COUNT(*) n FROM devices WHERE id IN (?,?) AND status='registered'",
      [included, excluded],
      (row) => row.n === 2,
      'the registered devices on the host',
    )
    // The IPA's embedded profile, verified against the trust store.
    const bytes = zip([
      ['Payload/Test.app/Info.plist', plist()],
      [
        'Payload/Test.app/embedded.mobileprovision',
        sign(root, adHoc([device(5), device(5)])),
      ],
    ])
    const file = path.join(root, 'fixture.ipa')
    writeFileSync(file, bytes, { mode: 0o600 })
    const profile = await inspectProvisioning(file, path.join(root, 'ca.pem'))
    assert.deepEqual(profile.devices, [device(5)])
    assert.equal(profile.team, 'FIXTURE')
    assert.equal(profile.appId, packageFields.bundleId)
    // A development profile is not ad hoc.
    const development = path.join(root, 'development.ipa')
    writeFileSync(
      development,
      zip([
        ['Payload/Test.app/Info.plist', plist()],
        [
          'Payload/Test.app/embedded.mobileprovision',
          sign(root, adHoc([device(5)], true)),
        ],
      ]),
    )
    await assert.rejects(
      inspectProvisioning(development, path.join(root, 'ca.pem')),
      /ad hoc/,
    )
    // The build, published on the master with its file on the host.
    const key = sha(bytes).slice(0, 32) + '.ipa'
    const build = insertBuild(
      masterDb(),
      {
        channelId,
        branch: 'master',
        commit: 'a'.repeat(40),
        version: '1.0',
        buildNumber: '1',
        bundleId: packageFields.bundleId,
        format: 'ipa',
        size: bytes.length,
        digest: sha(bytes),
        changelog: '',
        source: 'test',
        customFields: '{}',
      },
      key,
      { now: Date.now(), retentionDays: 14 },
    ).id
    await host.host!.objects.put(key, file, sha(bytes))
    c.master.master!.database.change('build', build)
    await synced(
      'SELECT 1 FROM builds WHERE id=?',
      [build],
      () => true,
      'the build on the host',
    )
    const branch = `/api/v2/catalog/apps/${appId}/branches/${branchKey('master')}?platform=ios`
    const row = async (extra = ''): Promise<Json> => {
      const reply = await api('GET', branch, ada, { extra })
      assert.equal(reply.status, 200, reply.text)
      return (reply.json.builds as Json[]).find((entry) => entry.id === build)
    }
    const install = async (extra = ''): Promise<Json> => {
      const reply = await api(
        'POST',
        `/api/v2/catalog/builds/${build}/install`,
        ada,
        { extra },
      )
      assert.equal(reply.status, 200, reply.text)
      return reply.json
    }
    const selected = `; ${DEVICE_COOKIE}=${included}`
    // Before the master knows the build's profile, nothing installs.
    const before = await row(selected)
    assert.deepEqual(
      [before.eligible, before.token, before.installUrl],
      [false, undefined, undefined],
    )
    assert.deepEqual(await install(selected), {
      kind: 'prepare',
      buildId: build,
    })
    assert.deepEqual(await install(), { kind: 'register' })
    // The profile the master recorded reaches the host.
    const provision = (expiresAt: number): void => {
      masterDb()
        .prepare(
          'INSERT INTO build_provisioning(build_id,devices,expires_at,team) VALUES(?,?,?,?) ON CONFLICT(build_id) DO UPDATE SET devices=excluded.devices,expires_at=excluded.expires_at',
        )
        .run(build, JSON.stringify(profile.devices), expiresAt, profile.team)
      c.master.master!.database.change('build', build)
    }
    provision(profile.expiresAt)
    await synced(
      'SELECT expires_at FROM build_provisioning WHERE build_id=?',
      [build],
      (r) => r.expires_at === profile.expiresAt,
      'the profile on the host',
    )
    const eligible = await row(selected)
    assert.equal(eligible.eligible, true)
    assert.match(
      eligible.installUrl,
      /^itms-services:\/\/\?action=download-manifest&url=/,
    )
    const granted = await install(selected)
    assert.equal(granted.kind, 'itms')
    assert.match(granted.url, /^itms-services:/)
    // Without a device, or on the one the profile leaves out, it does not.
    assert.equal((await row()).eligible, false)
    assert.deepEqual(await install(), { kind: 'register' })
    assert.equal((await row(`; ${DEVICE_COOKIE}=${excluded}`)).eligible, false)
    assert.deepEqual(await install(`; ${DEVICE_COOKIE}=${excluded}`), {
      kind: 'prepare',
      buildId: build,
    })
    // An expired profile installs nowhere.
    provision(Date.now() - 1000)
    await synced(
      'SELECT expires_at FROM build_provisioning WHERE build_id=?',
      [build],
      (r) => r.expires_at < Date.now(),
      'the expired profile on the host',
    )
    assert.equal((await row(selected)).eligible, false)
    // Prepare for this device reaches the master.
    const prepared = await api(
      'POST',
      `/api/v2/catalog/builds/${build}/prepare`,
      ada,
      { extra: selected },
    )
    assert.deepEqual(prepared.json, { prepared: true })
    await c.until(
      () =>
        masterDb()
          .prepare(
            'SELECT 1 FROM device_build_requests WHERE account_id=? AND device_id=? AND build_id=?',
          )
          .get(ada.id, included, build),
      10_000,
      'the prepare request on the master',
    )
  })

  it('persists device actions and clears a removed selection without affecting other accounts', async () => {
    const sam = await tester('Sam', 'sam@example.test')
    const id = await register(sam, device(7))
    // Pat registered the same iPhone.
    const pat = await tester('Pat', 'pat@example.test')
    assert.equal(await register(pat, device(7)), id)
    const selected = await api('POST', `/api/v2/devices/${id}/select`, sam)
    assert.equal(selected.status, 200, selected.text)
    assert.equal(selected.json.selected, id)
    assert.match(
      selected.headers.get('set-cookie')!,
      new RegExp(`^${DEVICE_COOKIE}=${id};`),
    )
    // Retry sends a device Apple refused back to the master's provisioning.
    masterDb()
      .prepare(
        "UPDATE devices SET status='error',message='Retry needed' WHERE id=?",
      )
      .run(id)
    c.master.master!.database.change('device', id)
    await synced(
      'SELECT message FROM devices WHERE id=?',
      [id],
      (row) => row.message === 'Retry needed',
      'the error on the host',
    )
    const retried = await api('POST', `/api/v2/devices/${id}/retry`, sam)
    assert.equal(retried.status, 200, retried.text)
    // The master tried it again: without an Apple team it fails anew.
    await synced(
      'SELECT status,message FROM devices WHERE id=?',
      [id],
      (row) => row.message !== 'Retry needed',
      'the retry on the host',
    )
    assert.equal(
      (await api('POST', `/api/v2/devices/${id}/unknown`, sam)).status,
      404,
    )
    assert.equal(
      (await api('POST', `/api/v2/devices/${id + 1000}/select`, sam)).status,
      404,
    )
    assert.equal(
      (await api('POST', '/api/v2/devices/none/select', sam)).status,
      404,
    )
    // Removing the selected device clears the selection.
    const removed = await api('POST', `/api/v2/devices/${id}/remove`, sam, {
      extra: `; ${DEVICE_COOKIE}=${id}`,
    })
    assert.equal(removed.status, 200, removed.text)
    assert.match(removed.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/)
    assert.equal(removed.json.selected, undefined)
    await synced(
      'SELECT COUNT(*) n FROM account_devices WHERE account_id=?',
      [sam.id],
      (row) => row.n === 0,
      'the removal on the host',
    )
    assert.deepEqual((await deviceList(sam)).devices, [])
    // Pat still has it.
    assert.deepEqual(
      ((await deviceList(pat)).devices as Json[]).map((entry) => entry.id),
      [id],
    )
  })

  it('rejects anonymous registration and bounds callback attempts', async () => {
    assert.equal(
      (await api('POST', '/api/v2/devices/registrations', undefined)).status,
      401,
    )
    assert.equal(
      (await api('POST', '/api/v2/catalog/builds/1/prepare', undefined)).status,
      401,
    )
    for (const route of ['/devices/qr', `/devices/complete/${'A'.repeat(43)}`])
      assert.equal((await request(route)).status, 303, route)
    // A fresh host, so that only these attempts count.
    const bounded = await c.startHost('bounded')
    const attempt = async (token: string): Promise<number> =>
      (
        await request(`/devices/callback/${token}`, {
          method: 'POST',
          node: bounded,
        })
      ).status
    assert.equal(await attempt('invalid'), 400)
    for (let i = 0; i < 30; i++)
      assert.equal(await attempt('A'.repeat(43)), 410)
    assert.equal(await attempt('A'.repeat(43)), 429)
  })
})

describe('Devices on a distribution database', () => {
  const identity = {
    provider: 'fixture',
    issuer: 'https://identity.example.test/',
    subject: 'device-owner',
    name: 'Fixture User',
    email: 'mark@example.test',
    emailVerified: true,
  }
  let root: string,
    store: Store,
    accounts: Accounts,
    devices: Devices,
    user: ReturnType<Accounts['login']>
  const config = (extra: object = {}): ReturnType<typeof asConfig> =>
    asConfig({
      origin: 'https://builds.example.test',
      database: path.join(root, 'state.sqlite'),
      storage: path.join(root, 'packages'),
      freeSpaceBytes: 0,
      ...extra,
    })
  const trust = (): string => path.join(root, 'ca.pem')
  const received = (
    token: string,
    id = device(1),
  ): ReturnType<Devices['receive']> =>
    devices.receive(token, decodePlist(Buffer.from(payload(token, id))))

  beforeEach(() => {
    root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'devices-store-'),
    )
    makeIdentity(root)
    store = new Store(config({ devices: { trustStoreFile: trust() } }))
    accounts = new Accounts(store)
    devices = new Devices(store)
    const first = accounts.login(identity)
    accounts.setAdmin(first.account.id, true)
    user = accounts.login(identity)
  })
  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('records a registration once, by account, and refuses one it cannot trust', () => {
    const token = devices.challenge(user.session)
    // A registration this store started names no other origin to return to.
    assert.equal(
      store.db
        .prepare('SELECT return_origin FROM device_challenges WHERE hash=?')
        .get(digest(token))?.return_origin,
      null,
    )
    const first = received(token)
    assert.equal(first.status, 'pending')
    const found = devices.list(user.account.id)
    assert.equal(found.length, 1)
    assert.equal(found[0]!.name, 'iPhone13 of mark@example')
    assert.throws(() => received(token), /Expired or used/)
    const returning = devices.challenge(user.session, MASTER_ORIGIN)
    assert.equal(
      store.db
        .prepare('SELECT return_origin FROM device_challenges WHERE hash=?')
        .get(digest(returning))?.return_origin,
      MASTER_ORIGIN,
    )
    // The same device again, as a newer model, is still one device.
    const next = devices.challenge(user.session)
    devices.receive(next, {
      ...decodePlist(Buffer.from(payload(next, device(1)))),
      PRODUCT: 'iPhone18,1',
    })
    assert.equal(devices.list(user.account.id).length, 1)
    assert.equal(devices.list(user.account.id)[0]!.model, 'iPhone17Pro')
    // Wrong challenge, invalid identifier, a Mac, expired.
    const t = devices.challenge(user.session)
    assert.throws(
      () =>
        devices.receive(
          t,
          decodePlist(Buffer.from(payload('wrong', device(2)))),
        ),
      /mismatch/,
    )
    assert.throws(() => received(t, 'invalid'), /Invalid device identifier/)
    assert.throws(
      () =>
        devices.receive(
          t,
          decodePlist(Buffer.from(payload(t, device(2), 'Mac14,2'))),
        ),
      /iPhone or iPad/,
    )
    store.db.prepare('UPDATE device_challenges SET expires_at=0').run()
    assert.throws(() => received(t), /Expired or used/)
    assert.throws(() => devices.profile('short'), /Invalid request/)
  })

  it('trusts a device answer only from an Apple device identity', async () => {
    const openssl = (args: string[]): void => {
      execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
    }
    openssl([
      ...'req -x509 -newkey rsa:2048 -nodes -keyout other.key -out other.pem -days 2 -subj'.split(
        ' ',
      ),
      '/CN=Fixture Other CA',
    ])
    openssl(
      'req -newkey rsa:2048 -nodes -keyout stranger.key -out stranger.csr -subj /CN=Stranger'.split(
        ' ',
      ),
    )
    openssl(
      'x509 -req -in stranger.csr -CA other.pem -CAkey other.key -CAcreateserial -out stranger.pem -days 1'.split(
        ' ',
      ),
    )
    const both = path.join(root, 'both.pem')
    writeFileSync(
      both,
      readFileSync(trust(), 'utf8') +
        readFileSync(path.join(root, 'other.pem'), 'utf8'),
    )
    const xml = payload('A'.repeat(43), device(1))
    // A profile may come from any trusted signer; a device answer may not.
    assert.equal(
      String(await verifyCms(sign(root, xml, 'stranger'), both)),
      xml,
    )
    await assert.rejects(
      verifyCms(sign(root, xml, 'stranger'), both, true),
      /Apple device identity/,
    )
    assert.equal(String(await verifyCms(sign(root, xml), both, true)), xml)
  })

  it('refuses registration to someone who is not a tester, and bounds pending requests', () => {
    const other = accounts.login({ ...identity, subject: 'unprivileged' })
    // A distribution database has no roles: only testers and admins register.
    assert.equal(devices.allowed(other.account), false)
    const token = devices.challenge(other.session)
    assert.throws(() => received(token), /Tester access required/)
    accounts.setTester(user.account.id, other.account.id, true)
    // The change ends their sessions; a new one may register.
    const tester = accounts.login({ ...identity, subject: 'unprivileged' })
    assert.equal(devices.allowed(tester.account), true)
    for (let i = 0; i < 10; i++) devices.challenge(tester.session)
    assert.throws(
      () => devices.challenge(tester.session),
      /Too many pending registration requests/,
    )
  })

  it('acts on an account’s devices directly and reads its selection', () => {
    const token = devices.challenge(user.session)
    const found = received(token)
    const own = devices.list(user.account.id)[0]!
    assert.equal(
      devices.selected(user.account.id, `a=b; ${DEVICE_COOKIE}=${found.id}`)
        ?.id,
      found.id,
    )
    assert.equal(devices.selected(user.account.id, undefined), undefined)
    assert.equal(devices.registration(token, user.account.id), undefined)
    devices.act(user.account.id, own, 'rename', 'My iPhone')
    assert.equal(devices.list(user.account.id)[0]!.name, 'My iPhone')
    store.db
      .prepare(
        "UPDATE devices SET status='error',message='Retry needed' WHERE id=?",
      )
      .run(found.id)
    devices.act(user.account.id, own, 'retry')
    assert.equal(devices.list(user.account.id)[0]!.status, 'pending')
    assert.equal(devices.list(user.account.id)[0]!.message, '')
    assert.throws(
      () => devices.requestBuild(user.account.id, found.id, 999),
      /unavailable/,
    )
    devices.act(user.account.id, own, 'remove')
    assert.deepEqual(devices.list(user.account.id), [])
    assert.equal(store.db.prepare('SELECT count(*) n FROM devices').get()?.n, 1)
  })

  it('records retained IPAs’ profiles and decides which devices may install', async () => {
    const t = devices.challenge(user.session),
      own = received(t)
    store.db
      .prepare("UPDATE devices SET status='registered' WHERE id=?")
      .run(own.id)
    const registered = { ...own, status: 'registered' as const }
    const bytes = zip([
      ['Payload/Test.app/Info.plist', plist()],
      [
        'Payload/Test.app/embedded.mobileprovision',
        sign(root, adHoc([device(1)])),
      ],
    ])
    const app = store.addApp({
        slug: packageFields.bundleId,
        name: 'Fixture App',
        position: 0,
      }),
      channel = store.addChannel({
        appId: app,
        platform: 'ios',
        key: 'fixture',
        allowedFormats: ['ipa'],
      })
    const reservation = store.reserve('fixture', bytes.length)
    writeFileSync(store.incomingPath(reservation), bytes, { mode: 0o600 })
    const build = store.publish(reservation, {
      channelId: channel,
      branch: 'master',
      commit: 'a'.repeat(40),
      version: '1.0',
      buildNumber: '1',
      bundleId: packageFields.bundleId,
      format: 'ipa',
      size: bytes.length,
      digest: sha(bytes),
    })
    assert.equal(devices.eligible(build, registered), false)
    // Preparation requests, bounded per hour.
    devices.requestBuild(user.account.id, own.id, build.id)
    assert.equal(
      store.db.prepare('SELECT count(*) n FROM device_build_requests').get()?.n,
      1,
    )
    // devices-inspect records retained IPAs' profiles.
    const file = path.join(root, 'distribution.json')
    writeFileSync(
      file,
      JSON.stringify({
        origin: store.config.origin,
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
        freeSpaceBytes: 0,
        devices: { trustStoreFile: trust() },
      }),
      { mode: 0o600 },
    )
    await backfillDevices(file)
    assert.deepEqual(
      JSON.parse(
        String(
          store.db
            .prepare('SELECT devices FROM build_provisioning WHERE build_id=?')
            .get(build.id)!.devices,
        ),
      ),
      [device(1)],
    )
    const bare = path.join(root, 'bare.json')
    writeFileSync(
      bare,
      JSON.stringify({
        origin: store.config.origin,
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
        freeSpaceBytes: 0,
      }),
      { mode: 0o600 },
    )
    await assert.rejects(backfillDevices(bare), /must be configured/)
    assert.equal(devices.eligible(build, registered), true)
    assert.equal(devices.eligible(build, own), false)
    assert.equal(devices.eligible(build, undefined), false)
    assert.equal(
      devices.eligible(build, { ...registered, udid: device(2) }),
      false,
    )
    const profile = {
      devices: [device(1)],
      expiresAt: 0,
      team: 'FIXTURE',
      appId: packageFields.bundleId,
    }
    assert.throws(
      () => saveProvisioning(store, build.id, { ...profile, appId: 'other' }),
      /does not match/,
    )
    saveProvisioning(store, build.id, profile)
    assert.equal(devices.eligible(build, registered), false)
  })

  it('names known models automatically and rejects unsafe plist structures', () => {
    assert.equal(
      friendlyName('iPhone14,5', {
        email: 'robin@example.org',
        name: 'Fixture',
      }),
      'iPhone13 of robin@example',
    )
    assert.equal(
      friendlyName('iPhone18,3', {
        email: 'alex@example.com',
        name: 'Fixture',
      }),
      'iPhone17 of alex@example',
    )
    assert.throws(() =>
      decodePlist(
        Buffer.from(
          '<!DOCTYPE plist [<!ENTITY x "bad">]><plist><dict/></plist>',
        ),
      ),
    )
    assert.throws(() =>
      decodePlist(
        Buffer.from(
          '<plist><dict><key>a</key><string>1</string><key>a</key><string>2</string></dict></plist>',
        ),
      ),
    )
  })
})

describe('Bounded property-list decoding', () => {
  it('reads binary dictionaries and rejects a binary array root', () => {
    assert.deepEqual(
      decodePlist(
        Buffer.from(
          'YnBsaXN0MDDTAQIDBAUGVWNvdW50V2VuYWJsZWRVbGFiZWwQBwlXZml4dHVyZQgPFR0jJSYAAAAAAAABAQAAAAAAAAAHAAAAAAAAAAAAAAAAAAAALg==',
          'base64',
        ),
      ),
      { count: 7, enabled: true, label: 'fixture' },
    )
    assert.throws(
      () =>
        decodePlist(
          Buffer.from(
            'YnBsaXN0MDChAV8QEG5vdC1hLWRpY3Rpb25hcnkICgAAAAAAAAEBAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAd',
            'base64',
          ),
        ),
      /dictionary/,
    )
  })
  it('reads array values and refuses excessive depth, malformed values and non-dictionary roots', () => {
    const parsed = decodePlist(
      Buffer.from(
        '<plist><dict><key>values</key><array><true/><false/><integer>7</integer><string/></array></dict></plist>',
      ),
    )
    assert.deepEqual(parsed.values, [true, false, 7, ''])
    assert.throws(
      () =>
        decodePlist(
          Buffer.from(
            '<plist>' +
              '<array>'.repeat(14) +
              '<true/>' +
              '</array>'.repeat(14) +
              '</plist>',
          ),
        ),
      /deep/,
    )
    for (const body of [
      '<real>1.2</real>',
      '<dict><key>orphan</key></dict>',
      '<string>root</string>',
    ])
      assert.throws(() => decodePlist(Buffer.from(`<plist>${body}</plist>`)))
    assert.throws(() => decodePlist(Buffer.alloc(1024 * 1024 + 1)), /large/)
    assert.throws(
      () => decodePlist(Buffer.from('<plist><dict/><dict/></plist>')),
      /root/,
    )
    assert.equal(
      friendlyName('iPad999,1', { name: 'Hank Aaron', email: undefined }),
      'iPad of Hank Aaron',
    )
    assert.equal(
      friendlyName('iPod999,1', { name: 'Hank Aaron', email: undefined }),
      'iPod of Hank Aaron',
    )
    assert.equal(
      friendlyName('Unknown', { name: 'Hank Aaron', email: undefined }),
      'iPhone of Hank Aaron',
    )
  })
})
