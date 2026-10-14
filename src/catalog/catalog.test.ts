import assert from 'node:assert/strict'
import { asObject } from 'cleaners'
import { asId } from '../validation.js'
import { once } from 'node:events'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { Accounts } from '../auth/accounts.js'
import { SESSION_COOKIE } from '../auth/routes.js'
import { asConfig } from '../config.js'
import { createApp } from '../server.js'
import { Store, digest } from '../store.js'
import type { Build, Format, Platform } from '../validation.js'
import { byteRange, Installations } from './install.js'
import { branchKey, branchName, platform } from './platform.js'
import { branches } from './routes.js'

let store: Store,
  accounts: Accounts,
  installs: Installations,
  root: string,
  server: Server,
  origin: string,
  now: number,
  app: number,
  user: ReturnType<Accounts['login']>
const identity = {
  provider: 'example',
  issuer: 'https://identity.example.test/',
  subject: 'fixture',
  name: 'Alex Lee',
  email: 'alex@example.test',
  emailVerified: true,
}
const content = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
function publish(
  os: Platform,
  branch = 'master',
  number = '1',
  format: Format = os === 'ios'
    ? 'ipa'
    : os === 'android'
      ? 'apk'
      : os === 'macos'
        ? 'dmg'
        : 'exe',
): Build {
  const existing = store.db
    .prepare('SELECT id FROM channels WHERE app_id=? AND platform=?')
    .get(app, os)
  const channel =
    existing == null
      ? store.addChannel({
          appId: app,
          platform: os,
          key: os,
          allowedFormats: os === 'windows' ? ['exe', 'msi'] : [format],
        })
      : asObject({ id: asId })(existing).id
  const payload = number === '1' ? content : content + number
  const id = store.reserve('fixture', payload.length)
  writeFileSync(store.incomingPath(id), payload, { flag: 'wx', mode: 0o600 })
  return store.publish(id, {
    channelId: channel,
    branch,
    commit: 'abcdef0123456789abcdef0123456789abcdef0123',
    version: '1.2.3',
    buildNumber: number,
    bundleId: 'test.example.app',
    format,
    size: payload.length,
    digest: digest(payload),
  })
}
async function request(
  url: string,
  options: RequestInit = {},
  signedIn = true,
): Promise<Response> {
  const parsed = new URL(url, origin)
  return await fetch(origin + parsed.pathname + parsed.search, {
    ...options,
    redirect: 'manual',
    headers: {
      ...(signedIn ? { cookie: `${SESSION_COOKIE}=${user.token}` } : {}),
      ...options.headers,
    },
  })
}
describe('Mason protected catalog and installation', () => {
  beforeEach(async () => {
    assert(process.env.MASON_TEST_ROOT)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'catalog-'))
    now = Date.now()
    store = new Store(
      asConfig({
        origin: 'https://builds.example.test',
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
        freeSpaceBytes: 0,
      }),
      () => now,
    )
    accounts = new Accounts(store)
    installs = new Installations(store)
    const first = accounts.login(identity)
    accounts.setAdmin(first.account.id, true)
    user = accounts.login(identity)
    app = store.addApp({
      slug: 'test.example.app',
      name: 'Example App',
      position: 0,
    })
    server = createApp(store).listen(0, '127.0.0.1')
    await once(server, 'listening')
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    server.close()
    await once(server, 'close')
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('orders apps, branches across platforms, master first and builds newest first', async () => {
    store.addApp({ slug: 'test.example.last', name: 'Last App', position: 8 })
    store.addApp({ slug: 'test.example.next', name: 'Next App', position: 1 })
    publish('ios')
    now += 1000
    publish('android', 'feature/new', '2')
    now += 1000
    publish('ios', 'feature/new', '3')
    now += 1000
    publish('ios', 'feature/new', '4')
    assert.deepEqual(
      branches(store.builds(app)).map((item) => item.name),
      ['master', 'feature/new'],
    )
    const home = await (await request('/')).text()
    assert(
      home.indexOf('Example App') < home.indexOf('Next App') &&
        home.indexOf('Next App') < home.indexOf('Last App'),
    )
    const list = await (await request(`/apps/${app}?platform=ios`)).text()
    assert(
      list.indexOf('<strong>master') < list.indexOf('<strong>feature/new'),
    )
    const route = `/apps/${app}/branches/${branchKey('feature/new')}`
    const builds = await (await request(route + '?platform=ios')).text()
    assert(builds.indexOf('build 4') < builds.indexOf('build 3'))
    assert(!builds.includes('build 2'))
    assert(builds.includes('abcdef012345') && builds.includes('UTC'))
    assert(builds.includes(`href="${route}?platform=android"`))
    assert.match(
      await (await request(route + '?platform=windows')).text(),
      /No Windows builds/,
    )
    assert.equal((await request('/apps/999')).status, 404)
    assert.equal((await request('/?platform=untrusted')).status, 400)
    assert.equal((await request('/assets/catalog.js')).status, 200)
    store.db.prepare('UPDATE apps SET enabled=0').run()
    assert.match(
      await (await request('/')).text(),
      /No apps have been configured/,
    )
    store.db.prepare('UPDATE apps SET enabled=1').run()
    now += 15 * 86400000
    assert.match(
      await (await request(`/apps/${app}`)).text(),
      /No retained builds/,
    )
  })
  it('does not reveal catalog data to anonymous or pending accounts', async () => {
    publish('android')
    const anonymous = await request(`/apps/${app}`, {}, false)
    assert.equal(anonymous.status, 303)
    assert.match(anonymous.headers.get('location')!, /return=/)
    user = accounts.login({ ...identity, subject: 'pending' })
    for (const route of [
      '/',
      `/apps/${app}`,
      `/apps/${app}/branches/${branchKey('master')}`,
    ]) {
      const response = await request(route)
      assert.equal(response.status, 403)
      assert(!(await response.text()).includes('Example App'))
    }
    assert.throws(() => installs.create(1, user.session), /Tester/)
  })
  it('offers a direct iOS install link tied to the authorized session', async () => {
    const build = publish('ios')
    const route = `/apps/${app}/branches/${branchKey('master')}?platform=ios`
    const html = await (await request(route)).text()
    assert.match(html, /<a id="build-/)
    assert.equal(html.includes(`<form id="build-${build.id}"`), false)
    const link = new URL(/data-install[^>]*href="([^"]+)"/.exec(html)![1]!.replaceAll('&amp;', '&'))
    assert.equal(link.protocol, 'itms-services:')
    const manifest = link.searchParams.get('url')!
    assert.equal(new URL(manifest).origin, store.config.origin)
    assert.equal((await request(manifest, {}, false)).status, 200)
    accounts.logout(user.token)
    assert.equal((await request(manifest, {}, false)).status, 404)
  })
  it('selects platforms safely and round-trips arbitrary branch names without paths', () => {
    for (const [agent, expected] of [
      ['iPhone', 'ios'],
      ['iPad', 'ios'],
      ['Android', 'android'],
      ['Macintosh', 'macos'],
      ['Windows', 'windows'],
      ['', 'ios'],
    ] as const)
      assert.equal(platform(undefined, undefined, agent), expected)
    assert.equal(platform('windows', 'ios', 'Android'), 'windows')
    assert.equal(platform(undefined, 'ios', 'Android'), 'ios')
    assert.equal(platform(undefined, 'bad', 'Android'), 'android')
    for (const name of [
      'feature/new',
      '../not-a-path',
      'release/日本語',
      '<script>alert(1)</script>',
    ])
      assert.equal(branchName(branchKey(name)), name)
    for (const key of ['a=', '*', '_w', 'a', ''])
      assert.throws(() => branchName(key))
    const a = publish('ios', 'z'),
      b = publish('android', 'a')
    assert.deepEqual(
      branches([a, b]).map((row) => row.name),
      ['a', 'z'],
    )
  })
  it('issues cookie-free iOS manifests and streams GET, HEAD and single ranges', async () => {
    const build = publish('ios')
    const grant = installs.create(build.id, user.session),
      url = installs.url(grant.token, 'artifact')
    assert.notEqual(
      store.db.prepare('SELECT hash FROM install_grants').get()?.hash,
      grant.token,
    )
    const manifest = await request(
      installs.url(grant.token, 'manifest.plist'),
      {},
      false,
    )
    assert.equal(manifest.status, 200)
    assert.match(await manifest.text(), /test.example.app/)
    for (const method of ['GET', 'HEAD']) {
      const response = await request(url, { method }, false)
      assert.equal(response.status, 200)
      assert.equal(
        response.headers.get('content-length'),
        String(content.length),
      )
      assert.equal(response.headers.get('etag'), `"${digest(content)}"`)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(await response.text(), method === 'HEAD' ? '' : content)
    }
    for (const [range, expected] of [
      ['bytes=2-5', content.slice(2, 6)],
      ['bytes=30-', content.slice(30)],
      ['bytes=-4', content.slice(-4)],
      ['bytes=0-999', content],
      ['bytes=-999', content],
    ]) {
      const response = await request(
        url,
        { headers: { range: range! } },
        false,
      )
      assert.equal(response.status, 206)
      assert.equal(await response.text(), expected)
    }
    for (const range of [
      'bytes=999-',
      'bytes=5-1',
      'bytes=-0',
      'bytes=-',
      'bytes=0-1,2-3',
      'items=0-1',
      'bytes=999999999999999999999999-',
    ]) {
      const response = await request(url, { headers: { range } }, false)
      assert.equal(response.status, 416)
      assert.equal(
        response.headers.get('content-range'),
        `bytes */${content.length}`,
      )
    }
    const mismatch = await request(
      url,
      { headers: { range: 'bytes=0-1', 'if-range': '"other"' } },
      false,
    )
    assert.equal(mismatch.status, 200)
    assert.equal(await mismatch.text(), content)
    const rangeHead = await request(
      url,
      {
        method: 'HEAD',
        headers: { range: 'bytes=2-3', 'if-range': `"${digest(content)}"` },
      },
      false,
    )
    assert.equal(rangeHead.status, 206)
    assert.equal(rangeHead.headers.get('content-length'), '2')
    assert.equal(await rangeHead.text(), '')
    assert.equal(
      (await request('/install/invalid/artifact', {}, false)).status,
      404,
    )
    assert.equal(
      (await request('/install/invalid/manifest.plist', {}, false)).status,
      404,
    )
    assert.equal(byteRange(undefined, 10), undefined)
  })
  it('requires CSRF for installation and returns the appropriate installer for all formats', async () => {
    for (const os of ['ios', 'android', 'macos', 'windows'] as const) {
      const build = publish(os),
        route = `/builds/${build.id}/install`
      assert.equal(
        (await request(route, { method: 'POST' }, false)).status,
        401,
      )
      assert.equal((await request(route, { method: 'POST' })).status, 400)
      const response = await request(route, {
        method: 'POST',
        headers: {
          origin: store.config.origin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ csrf: user.session.csrf }),
      })
      if (os === 'ios') {
        assert.equal(response.status, 200)
        assert.match(await response.text(), /itms-services:/)
      } else {
        assert.equal(response.status, 303)
        const url = response.headers.get('location')!
        assert.equal((await request(url, {}, false)).status, 200)
        assert.equal(
          (
            await request(
              url.replace('/artifact', '/manifest.plist'),
              {},
              false,
            )
          ).status,
          404,
        )
      }
    }
    const msi = publish('windows', 'master', '2', 'msi')
    assert.equal(
      (
        await request(
          installs.url(
            installs.create(msi.id, user.session).token,
            'artifact',
          ),
          {},
          false,
        )
      ).status,
      200,
    )
    assert.throws(() => installs.manifest(msi, 'fixture'))
    assert.throws(() => installs.create(999, user.session))
  })
  it('expires and revokes grants with the artifact, account and original session', () => {
    const build = publish('android')
    const first = installs.create(build.id, user.session)
    now = first.expiresAt
    assert.equal(installs.build(first.token), undefined)
    const second = installs.create(build.id, user.session)
    accounts.logout(user.token)
    assert.equal(installs.build(second.token), undefined)
    assert.throws(() => installs.create(build.id, user.session))
    user = accounts.login(identity)
    const third = installs.create(build.id, user.session)
    store.db
      .prepare('UPDATE accounts SET disabled=1 WHERE id=?')
      .run(user.account.id)
    assert.equal(installs.build(third.token), undefined)
    store.db
      .prepare('UPDATE accounts SET disabled=0,is_admin=0 WHERE id=?')
      .run(user.account.id)
    assert.equal(installs.build(third.token), undefined)
    store.db
      .prepare('UPDATE accounts SET is_admin=1 WHERE id=?')
      .run(user.account.id)
    store.db
      .prepare('UPDATE sessions SET expires_at=? WHERE hash=?')
      .run(now + 1000, user.session.hash)
    const short = installs.create(build.id, user.session)
    assert.equal(short.expiresAt, now + 1000)
    now += 1000
    assert.equal(installs.build(short.token), undefined)
    user = accounts.login(identity)
    now = build.expires_at - 1000
    assert.equal(
      installs.create(build.id, user.session).expiresAt,
      build.expires_at,
    )
    now = build.expires_at
    assert.equal(installs.build(installs.create.bind), undefined)
    store.prune()
    now += 8 * 86400000
    store.prune()
    assert.equal(
      store.db.prepare('SELECT COUNT(*) total FROM install_grants').get()
        ?.total,
      0,
    )
  })
  it('never follows replaced links or streams missing, wrong-sized or nonregular files', async () => {
    const build = publish('android'),
      grant = installs.create(build.id, user.session),
      url = installs.url(grant.token, 'artifact'),
      file = store.filePath(build.file_key)
    rmSync(file)
    assert.equal((await request(url, {}, false)).status, 404)
    const outside = path.join(root, 'outside')
    writeFileSync(outside, 'private fixture')
    symlinkSync(outside, file)
    assert.equal((await request(url, {}, false)).status, 404)
    rmSync(file)
    mkdirSync(file)
    assert.equal((await request(url, {}, false)).status, 404)
    rmSync(file, { recursive: true })
    writeFileSync(file, 'wrong size')
    chmodSync(file, 0o400)
    assert.equal((await request(url, {}, false)).status, 404)
  })
})
