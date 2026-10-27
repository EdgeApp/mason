import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { Accounts } from '../auth/accounts.js'
import { SESSION_COOKIE } from '../auth/routes.js'
import { asConfig } from '../config.js'
import { Store } from '../store.js'
import { createApp } from '../server.js'
import { Devices, friendlyName, DEVICE_COOKIE } from './store.js'
import { decodePlist } from './plist.js'
import { verifyCms } from './cms.js'
import { inspectProvisioning, saveProvisioning } from './provisioning.js'
import { backfillDevices } from './backfill.js'
import { branchKey } from '../catalog/platform.js'
import { zip, plist } from '../upload/fixtures.test.js'

const fakeUdid = '0'.repeat(39) + '1'
const fakeOther = '0'.repeat(39) + '2'
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
  user: ReturnType<Accounts['login']>,
  server: Server,
  origin: string
function openssl(args: string[]): void {
  execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
}
function sign(xml: string): Buffer {
  writeFileSync(path.join(root, 'data.plist'), xml, { mode: 0o600 })
  openssl([
    'cms',
    '-sign',
    '-binary',
    '-nodetach',
    '-in',
    'data.plist',
    '-signer',
    'leaf.pem',
    '-inkey',
    'leaf.key',
    '-certfile',
    'ca.pem',
    '-outform',
    'DER',
    '-out',
    'signed.der',
  ])
  return readFileSync(path.join(root, 'signed.der'))
}
const payload = (token: string, id = fakeUdid): string =>
  `<plist version="1.0"><dict><key>CHALLENGE</key><string>${token}</string><key>UDID</key><string>${id}</string><key>PRODUCT</key><string>iPhone14,5</string><key>VERSION</key><string>26.0</string></dict></plist>`
async function request(
  url: string,
  options: RequestInit = {},
  signed = true,
): Promise<Response> {
  return fetch(origin + url, {
    ...options,
    redirect: 'manual',
    headers: {
      ...(signed ? { cookie: `${SESSION_COOKIE}=${user.token}` } : {}),
      ...options.headers,
    },
  })
}
function post(
  url: string,
  fields: Record<string, string>,
  cookie = '',
): Promise<Response> {
  return request(url, {
    method: 'POST',
    headers: {
      origin: store.config.origin,
      'Content-Type': 'application/x-www-form-urlencoded',
      cookie: `${SESSION_COOKIE}=${user.token}${cookie}`,
    },
    body: new URLSearchParams({ csrf: user.session.csrf, ...fields }),
  })
}
describe('Device registration, account ownership and iOS compatibility', () => {
  beforeEach(async () => {
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'devices-'))
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '2',
      '-subj',
      '/CN=Apple Fixture Device CA',
    ])
    openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'leaf.key',
      '-out',
      'leaf.csr',
      '-subj',
      '/CN=Fixture Device',
    ])
    openssl([
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'leaf.pem',
      '-days',
      '1',
    ])
    writeFileSync(
      path.join(root, 'worker.json'),
      JSON.stringify({ token: 'a'.repeat(64) }),
      { mode: 0o600 },
    )
    store = new Store(
      asConfig({
        origin: 'https://builds.example.test',
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
        freeSpaceBytes: 0,
        devices: {
          workerTokenFile: path.join(root, 'worker.json'),
          trustStoreFile: path.join(root, 'ca.pem'),
        },
      }),
    )
    accounts = new Accounts(store)
    devices = new Devices(store)
    const first = accounts.login(identity)
    accounts.setAdmin(first.account.id, true)
    user = accounts.login(identity)
    server = createApp(store).listen(0, '127.0.0.1')
    await once(server, 'listening')
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    server.close()
    await once(server, 'close')
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('collects a signed device callback once, generates its name, and saves it to the correct account', async () => {
    const response = await post('/devices/profile', {})
    assert.equal(response.status, 200)
    assert.match(
      response.headers.get('content-type')!,
      /application\/x-apple-aspen-config/,
    )
    const profile = decodePlist(Buffer.from(await response.text()))
    assert.match(String(profile.PayloadUUID), /^[a-f0-9-]{36}$/)
    const content = profile.PayloadContent as Record<string, unknown>,
      token = String(content.Challenge)
    assert.deepEqual(content.DeviceAttributes, ['UDID', 'PRODUCT', 'VERSION'])
    const callback = await request(
      '/devices/callback/' + token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/pkcs7-signature' },
        body: new Uint8Array(sign(payload(token))),
      },
      false,
    )
    assert.equal(callback.status, 301)
    assert.equal(
      callback.headers.get('location'),
      store.config.origin + '/devices/complete/' + token,
    )
    assert.equal(callback.headers.get('cache-control'), 'no-store')
    const found = devices.list(user.account.id)
    assert.equal(found.length, 1)
    assert.equal(found[0]!.name, 'iPhone13 of mark@example')
    assert.equal(found[0]!.status, 'pending')
    const complete = await request(
      new URL(callback.headers.get('location')!).pathname,
    )
    assert.equal(complete.status, 200)
    assert.match(complete.headers.get('set-cookie')!, /__Host-mason-device=/)
    const confirmation = await complete.text()
    assert.match(confirmation, /You've registered the following device:/)
    assert.match(confirmation, /<strong>iPhone 13<\/strong>/)
    assert.match(confirmation, /Mason will prepare these builds automatically/)
    assert.match(confirmation, /30 to 60 minutes/)
    assert.equal(
      (
        await request(
          '/devices/callback/' + token,
          { method: 'POST', body: new Uint8Array(sign(payload(token))) },
          false,
        )
      ).status,
      410,
    )
    const next = devices.challenge(user.session)
    devices.receive(next, {
      ...decodePlist(Buffer.from(payload(next))),
      PRODUCT: 'iPhone18,1',
    })
    assert.equal(devices.list(user.account.id).length, 1)
    assert.match(
      await (await request('/devices/complete/' + next)).text(),
      /<strong>iPhone 17 Pro<\/strong>/,
    )
    const otherInitial = accounts.login({
      ...identity,
      subject: 'another',
      email: 'another@example.test',
    })
    accounts.setAdmin(otherInitial.account.id, true)
    const other = accounts.login({
      ...identity,
      subject: 'another',
      email: 'another@example.test',
    })
    assert.equal(devices.list(other.account.id).length, 0)
    assert.equal(
      (
        await request('/devices/complete/' + token, {
          headers: { cookie: `${SESSION_COOKIE}=${other.token}` },
        })
      ).status,
      410,
    )
  })
  it('rejects unsigned, tampered, wrong-challenge, expired and invalid identifiers', async () => {
    const t = devices.challenge(user.session),
      signed = sign(payload(t))
    signed[signed.length - 1] = signed[signed.length - 1]! ^ 1
    await assert.rejects(verifyCms(signed, path.join(root, 'ca.pem'), true))
    assert.equal(
      (
        await request(
          '/devices/callback/' + t,
          { method: 'POST', body: Buffer.from(payload(t)) },
          false,
        )
      ).status,
      400,
    )
    assert.throws(() =>
      devices.receive(t, decodePlist(Buffer.from(payload('wrong')))),
    )
    assert.throws(() =>
      devices.receive(t, decodePlist(Buffer.from(payload(t, 'invalid')))),
    )
    store.db.prepare('UPDATE device_challenges SET expires_at=0').run()
    assert.throws(() =>
      devices.receive(t, decodePlist(Buffer.from(payload(t)))),
    )
  })
  it('enforces account ownership and CSRF', async () => {
    assert.equal((await request('/devices', {}, false)).status, 303)
    assert.equal((await post('/devices/profile', { csrf: 'bad' })).status, 400)
    const t = devices.challenge(user.session),
      device = devices.receive(t, decodePlist(Buffer.from(payload(t))))
    const other = accounts.login({ ...identity, subject: 'other' })
    const attack = await request(`/devices/${device.id}/rename`, {
      method: 'POST',
      headers: {
        origin: store.config.origin,
        'Content-Type': 'application/x-www-form-urlencoded',
        cookie: `${SESSION_COOKIE}=${other.token}`,
      },
      body: new URLSearchParams({
        csrf: other.session.csrf,
        name: 'Changed',
      }),
    })
    assert.equal(attack.status, 403)
    assert.equal(
      devices.list(user.account.id)[0]!.name,
      'iPhone13 of mark@example',
    )
    assert.equal(
      (await post(`/devices/${device.id}/rename`, { name: 'My iPhone' }))
        .status,
      303,
    )
    assert.equal(devices.list(user.account.id)[0]!.name, 'My iPhone')
    const html = await (await request('/devices')).text()
    assert.match(
      html,
      /Register Device<\/a><form method="post" action="\/auth\/logout"/,
    )
    assert.equal((await request('/devices/qr')).status, 200)
  })
  it('verifies embedded ad hoc profiles and prevents installation on excluded devices', async () => {
    const t = devices.challenge(user.session),
      device = devices.receive(t, decodePlist(Buffer.from(payload(t))))
    store.db
      .prepare("UPDATE devices SET status='registered' WHERE id=?")
      .run(device.id)
    const xml = `<plist version="1.0"><dict><key>ProvisionedDevices</key><array><string>${fakeUdid}</string></array><key>TeamIdentifier</key><array><string>FIXTURE</string></array><key>ExpirationDate</key><date>${new Date(Date.now() + 86400000).toISOString()}</date><key>Entitlements</key><dict><key>get-task-allow</key><false/><key>application-identifier</key><string>FIXTURE.test.example.app</string></dict></dict></plist>`
    const bytes = zip([
      ['Payload/Test.app/Info.plist', plist()],
      ['Payload/Test.app/embedded.mobileprovision', sign(xml)],
    ])
    const file = path.join(root, 'fixture.ipa')
    writeFileSync(file, bytes, { mode: 0o600 })
    const profile = await inspectProvisioning(file, path.join(root, 'ca.pem'))
    assert.deepEqual(profile.devices, [fakeUdid])
    const app = store.addApp({
        slug: 'test.example.app',
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
      bundleId: 'test.example.app',
      format: 'ipa',
      size: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
    })
    const cookie = `; ${DEVICE_COOKIE}=${device.id}`
    const catalog = `/apps/${app}/branches/${branchKey('master')}?platform=ios`
    const selectedCookie = {
      headers: { cookie: `${SESSION_COOKIE}=${user.token}${cookie}` },
    }
    assert.equal(
      (await (await request(catalog, selectedCookie)).text()).includes(
        'data-install',
      ),
      false,
    )
    assert.equal(
      (await post(`/builds/${build.id}/install`, {}, cookie)).status,
      409,
    )
    // devices-inspect records retained IPAs' profiles.
    const config = path.join(root, 'distribution.json')
    writeFileSync(
      config,
      JSON.stringify({
        origin: store.config.origin,
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
        freeSpaceBytes: 0,
        devices: { trustStoreFile: path.join(root, 'ca.pem') },
      }),
      { mode: 0o600 },
    )
    await backfillDevices(config)
    assert.equal(
      JSON.parse(
        String(
          store.db
            .prepare('SELECT devices FROM build_provisioning WHERE build_id=?')
            .get(build.id)!.devices,
        ),
      )[0],
      fakeUdid,
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
    saveProvisioning(store, build.id, profile)
    assert.match(
      await (await request(catalog, selectedCookie)).text(),
      /data-install[^>]*href="itms-services:/,
    )
    assert.equal(
      (await (await request(catalog)).text()).includes('data-install'),
      false,
    )
    assert.equal(
      devices.eligible(build, { ...device, status: 'registered' }),
      true,
    )
    assert.equal(
      devices.eligible(build, {
        ...device,
        status: 'registered',
        udid: fakeOther,
      }),
      false,
    )
    assert.equal(
      (await post(`/builds/${build.id}/install`, {}, cookie)).status,
      200,
    )
    assert.equal((await post(`/builds/${build.id}/install`, {})).status, 409)
    profile.expiresAt = 0
    saveProvisioning(store, build.id, profile)
    assert.equal(devices.eligible(build, device), false)
  })
  it('names known models automatically and rejects unsafe plist structures', () => {
    assert.equal(
      friendlyName('iPhone14,5', {
        email: 'mark@gmail.com',
        name: 'Fixture',
      }),
      'iPhone13 of mark@gmail',
    )
    assert.equal(
      friendlyName('iPhone18,3', {
        email: 'paul@vtex.net',
        name: 'Fixture',
      }),
      'iPhone17 of paul@vtex',
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
  it('persists device actions and clears a removed selection without affecting other accounts', async () => {
    const token = devices.challenge(user.session)
    const device = devices.receive(
      token,
      decodePlist(Buffer.from(payload(token))),
    )
    const selected = await post(`/devices/${device.id}/select`, {})
    assert.match(
      selected.headers.get('set-cookie')!,
      new RegExp(`${DEVICE_COOKIE}=${device.id}`),
    )
    store.db
      .prepare(
        "UPDATE devices SET status='error',message='Retry needed' WHERE id=?",
      )
      .run(device.id)
    assert.equal((await post(`/devices/${device.id}/retry`, {})).status, 303)
    assert.equal(devices.list(user.account.id)[0]!.status, 'pending')
    assert.equal(devices.list(user.account.id)[0]!.message, '')
    assert.equal((await post(`/devices/${device.id}/unknown`, {})).status, 404)
    assert.equal(
      (await post(`/devices/${device.id + 1}/select`, {})).status,
      404,
    )
    const removed = await post(
      `/devices/${device.id}/remove`,
      {},
      `; ${DEVICE_COOKIE}=${device.id}`,
    )
    assert.equal(removed.status, 303)
    assert.match(removed.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/)
    assert.deepEqual(devices.list(user.account.id), [])
    assert.equal(store.db.prepare('SELECT count(*) n FROM devices').get()?.n, 1)
  })
  it('rejects anonymous and non-tester registration and bounds callback attempts', async () => {
    assert.equal(
      (await request('/devices/profile', { method: 'POST' }, false)).status,
      403,
    )
    assert.equal(
      (await request('/builds/1/prepare', { method: 'POST' }, false)).status,
      403,
    )
    const other = accounts.login({ ...identity, subject: 'unprivileged' })
    assert.equal(
      (
        await request('/devices', {
          headers: { cookie: `${SESSION_COOKIE}=${other.token}` },
        })
      ).status,
      403,
    )
    assert.equal(
      (await request('/devices/callback/invalid', { method: 'POST' }, false))
        .status,
      400,
    )
    for (let i = 0; i < 30; i++)
      assert.equal(
        (
          await request(
            '/devices/callback/' + 'A'.repeat(43),
            { method: 'POST' },
            false,
          )
        ).status,
        410,
      )
    assert.equal(
      (
        await request(
          '/devices/callback/' + 'A'.repeat(43),
          { method: 'POST' },
          false,
        )
      ).status,
      429,
    )
    const report = await request(
      '/api/device-provisioning',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + 'a'.repeat(64),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          devices: Array.from({ length: 501 }, () => ({
            id: 1,
            status: 'pending',
            message: '',
          })),
          requests: [],
        }),
      },
      false,
    )
    assert.equal(report.status, 400)
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
