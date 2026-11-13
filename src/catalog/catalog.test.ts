import assert from 'node:assert/strict'
import { asObject } from 'cleaners'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { text as readText } from 'node:stream/consumers'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { Accounts } from '../auth/accounts.js'
import { SESSION_COOKIE } from '../auth/routes.js'
import { asConfig } from '../config.js'
import { DEVICE_COOKIE } from '../devices/store.js'
import { localOperator } from '../master/roles.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { Store, digest, insertBuild } from '../store.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { assertShell } from '../test/webShell.js'
import { asId, type Build, type Format, type Platform } from '../validation.js'
import {
  byteRange,
  formatTypes,
  installDelivery,
  Installations,
  iosInstallUrl,
  type FileDelivery,
} from './install.js'
import { branchKey, branchName, platform } from './platform.js'
import { branches, CatalogRefused, StoreCatalogSource } from './source.js'

// Answers are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const content = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const defaultFormat = (os: Platform): Format =>
  os === 'ios' || os === 'tvos'
    ? 'ipa'
    : os === 'android'
      ? 'apk'
      : os === 'macos'
        ? 'dmg'
        : 'exe'

interface Reply {
  status: number
  text: string
  json: Json
  headers: { get(name: string): string | null }
}

describe('Install apps on the host, as the web app reads them', function () {
  this.timeout(180_000)
  let root: string
  let c: Cluster
  let host: RunningNode
  const apps: Record<string, number> = {}
  const people: Record<string, number> = {}
  let device: number
  const UDID = 'C'.repeat(39) + '1'
  const EXAMPLE = 'test.example.app'
  const NEXT = 'test.example.next'
  const LAST = 'test.example.last'
  const M4 = 'test.example.m4'
  const VARIANTS = 'test.example.variants'
  const IOS = 'test.example.ios'
  const TV = 'test.example.tv'
  const FORMATS = 'test.example.formats'
  const FILES = 'test.example.files'
  const HIDDEN = 'test.example.hidden'
  const db = (): Json => c.master.master!.database.db
  const cache = (): Json => host.host!.cache.db
  const base = (): string => host.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  /** The host's public origin, which manifests name and changes come from. */
  const origin = (): string => host.host!.cache.store.config.origin

  /** A raw request to the host; a cookie-free one unless `cookie` is given. */
  const request = async (
    route: string,
    init: {
      method?: string
      cookie?: string
      headers?: Record<string, string>
      body?: string
    } = {},
  ): Promise<Reply> => {
    const parsed = new URL(route, base())
    const response = await pinnedFetch(
      base() + parsed.pathname + parsed.search,
      {
        method: init.method ?? 'GET',
        redirect: 'manual',
        headers: {
          ...(init.cookie == null ? {} : { cookie: init.cookie }),
          ...init.headers,
        },
        ...(init.body == null ? {} : { body: init.body }),
      },
      host.web!.certificate!.pin,
    )
    const text = await response.text()
    let json: Json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, text, json, headers: response.headers }
  }
  interface Who {
    cookie: string
    csrf: string
    token: string
  }
  /** A host session for a person. */
  const as = (person: string): Who => {
    const { token, session } = host.host!.accounts.startSession(people[person]!)
    return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrf, token }
  }
  /** A JSON call as the web app makes it: a change carries its proof from the host's origin. */
  const api = async (
    method: 'GET' | 'POST',
    route: string,
    who?: Who,
    options: { cookie?: string; headers?: Record<string, string> } = {},
  ): Promise<Reply> =>
    await request(route, {
      method,
      ...(who == null ? {} : { cookie: who.cookie + (options.cookie ?? '') }),
      headers: {
        ...(method === 'POST' && who != null
          ? { origin: origin(), 'x-mason-csrf': who.csrf }
          : {}),
        ...options.headers,
      },
    })
  const withDevice = (): { cookie: string } => ({
    cookie: `; ${DEVICE_COOKIE}=${device}`,
  })
  const appRoute = (slug: string, query = ''): string =>
    `/api/v2/catalog/apps/${apps[slug]}${query}`
  const branchRoute = (slug: string, branch: string, query = ''): string =>
    `/api/v2/catalog/apps/${apps[slug]}/branches/${branchKey(branch)}${query}`
  const install = async (
    id: number,
    who: Who,
    options: { cookie?: string; headers?: Record<string, string> } = {},
  ): Promise<Reply> =>
    await api('POST', `/api/v2/catalog/builds/${id}/install`, who, options)

  let serial = 0
  /**
   * Publishes a build on the master (its bytes in the host's storage, an
   * iOS build provisioned for the tester's iPhone when asked) and waits
   * until the host has it.
   */
  const publish = async (
    slug: string,
    os: Platform,
    options: {
      branch?: string
      number?: string
      format?: Format
      variant?: string
      run?: string
      at?: number
      bytes?: string
      provision?: boolean
    } = {},
  ): Promise<{ id: number; key: string; bytes: Buffer; sha: string }> => {
    serial++
    const format = options.format ?? defaultFormat(os)
    const number = options.number ?? String(serial)
    const bytes = Buffer.from(
      options.bytes ?? `${slug} ${os} ${number} ${serial} `.repeat(3),
    )
    const sha = digest(bytes)
    const key = `${sha.slice(0, 32)}.${format}`
    const channel = asObject({ id: asId })(
      db()
        .prepare('SELECT id FROM channels WHERE app_id=? AND platform=?')
        .get(apps[slug]!, os),
    ).id
    const build = insertBuild(
      db(),
      {
        channelId: channel,
        branch: options.branch ?? 'master',
        commit: 'abcdef0123456789abcdef0123456789abcdef01',
        version: '1.2.3',
        buildNumber: number,
        bundleId: slug,
        format,
        size: bytes.length,
        digest: sha,
        changelog: '',
        source: 'test',
        customFields: '{}',
        ...(options.variant == null ? {} : { variant: options.variant }),
        ...(options.run == null ? {} : { run: options.run }),
      },
      key,
      { now: options.at ?? Date.now(), retentionDays: 14 },
    )
    const file = path.join(root, `upload-${serial}`)
    writeFileSync(file, bytes)
    await host.host!.objects.put(key, file, sha)
    if (options.provision === true)
      db()
        .prepare(
          "INSERT INTO build_provisioning(build_id,devices,expires_at,team) VALUES(?,?,?,'ABCDE12345')",
        )
        .run(build.id, JSON.stringify([UDID]), Date.now() + 86_400_000)
    c.master.master!.database.change('build', build.id)
    await c.until(
      () =>
        cache().prepare('SELECT 1 FROM builds WHERE id=?').get(build.id) !=
          null &&
        (options.provision !== true ||
          cache()
            .prepare('SELECT 1 FROM build_provisioning WHERE build_id=?')
            .get(build.id) != null),
      10_000,
      `build ${number} on the host`,
    )
    return { id: build.id, key, bytes, sha }
  }
  /** Enables or disables an app on the master and waits until the host follows. */
  const enable = async (slug: string, enabled: boolean): Promise<void> => {
    db()
      .prepare('UPDATE apps SET enabled=? WHERE id=?')
      .run(Number(enabled), apps[slug]!)
    c.master.master!.database.change('app', apps[slug]!)
    await c.until(
      () =>
        cache().prepare('SELECT enabled FROM apps WHERE id=?').get(apps[slug]!)
          ?.enabled === Number(enabled),
      10_000,
      `${slug} enabled=${enabled} on the host`,
    )
  }

  before(async () => {
    root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'catalog-'),
    )
    c = await cluster(path.join(root, 'cluster'))
    host = await c.startHost('host', { testEndpoints: true })
    const master = c.master.master!
    await master.settings.set(localOperator, 'host', { origin: base() })
    const repo = c.repo('fixtures/catalog')
    repo.commit({ 'Masonfile.ts': 'export function setup() {}' })
    const all: Platform[] = ['ios', 'android', 'macos', 'windows']
    const defined: Array<[string, string, Platform[], number]> = [
      [EXAMPLE, 'Example App', ['ios', 'android', 'windows'], 0],
      [LAST, 'Last App', ['android'], 8],
      [NEXT, 'Next App', ['android'], 1],
      [M4, 'Platforms App', ['ios', 'android', 'windows'], 2],
      [VARIANTS, 'Variants App', ['android'], 3],
      [IOS, 'Phone App', ['ios'], 4],
      [TV, 'TV App', ['tvos'], 5],
      [FORMATS, 'Formats App', all, 6],
      [FILES, 'Files App', ['android'], 7],
      [HIDDEN, 'Hidden App', ['android'], 9],
    ]
    master.saveProject(localOperator, 'catalog', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
      apps: defined.map(([bundleId, name, platforms]) => ({
        bundleId,
        name,
        platforms,
      })),
    })
    for (const [slug, , , position] of defined) {
      apps[slug] = asObject({ id: asId })(
        db().prepare('SELECT id FROM apps WHERE slug=?').get(slug),
      ).id
      db()
        .prepare('UPDATE apps SET position=? WHERE id=?')
        .run(position, apps[slug]!)
      master.database.change('app', apps[slug]!)
    }
    for (const [name, role] of [
      ['tess', 'tester'],
      ['nobody', 'tester'],
      ['dev', 'developer'],
    ] as const)
      people[name] = (
        await master.people.create(localOperator, {
          name,
          emails: [`${name}@example.test`],
          role,
        })
      ).id
    // Tess sees every app but the hidden one; nobody is in no group.
    master.people.createGroup(localOperator, {
      name: 'Testers',
      apps: defined
        .filter(([slug]) => slug !== HIDDEN)
        .map(([slug]) => apps[slug]!),
      members: [people.tess!],
    })
    // Tess's registered iPhone, which provisioned builds include.
    const now = Date.now()
    device = Number(
      db()
        .prepare(
          "INSERT INTO devices(udid,product,model,os_version,status,created_at,updated_at) VALUES(?,'iPhone14,5','iPhone 13','26.0','registered',?,?)",
        )
        .run(UDID, now, now).lastInsertRowid,
    )
    db()
      .prepare(
        'INSERT INTO account_devices(account_id,device_id,name,created_at) VALUES(?,?,?,?)',
      )
      .run(people.tess!, device, 'Tess’s iPhone', now)
    master.database.change('device', device)
    master.database.change('account', people.tess!)
    await c.until(
      () =>
        origin() === base() &&
        cache().prepare('SELECT position FROM apps WHERE id=?').get(apps[LAST]!)
          ?.position === 8 &&
        cache()
          .prepare('SELECT 1 FROM account_devices WHERE device_id=?')
          .get(device) != null &&
        cache()
          .prepare('SELECT 1 FROM group_members WHERE account_id=?')
          .get(people.tess!) != null &&
        cache().prepare('SELECT 1 FROM accounts WHERE id=?').get(people.dev!) !=
          null &&
        cache()
          .prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(people.nobody!) != null,
      10_000,
      'the apps, people and device on the host',
    )
  })
  after(async () => {
    await c?.close()
    if (root != null) rmSync(root, { recursive: true, force: true })
  })

  it('orders apps, branches across platforms, master first and builds newest first', async () => {
    const tess = as('tess')
    const at = Date.now() - 60_000
    await publish(EXAMPLE, 'ios', { number: '1', at })
    await publish(EXAMPLE, 'android', {
      branch: 'feature/new',
      number: '2',
      at: at + 1000,
    })
    await publish(EXAMPLE, 'ios', {
      branch: 'feature/new',
      number: '3',
      at: at + 2000,
    })
    await publish(EXAMPLE, 'ios', {
      branch: 'feature/new',
      number: '4',
      at: at + 3000,
    })
    // Apps by their position; the hidden app is not Tess's.
    const list = await api('GET', '/api/v2/catalog/apps', tess)
    assert.equal(list.status, 200, list.text)
    const names = (list.json.apps as Json[]).map((app) => app.name)
    assert(
      names.indexOf('Example App') < names.indexOf('Next App') &&
        names.indexOf('Next App') < names.indexOf('Last App'),
      names.join(),
    )
    assert.equal(names[0], 'Example App')
    assert(!names.includes('Hidden App'))
    assert.deepEqual([...list.json.platforms].sort(), [
      'android',
      'ios',
      'macos',
      'tvos',
      'windows',
    ])
    // Branches across platforms, master first, then the newest.
    const app = await api('GET', appRoute(EXAMPLE, '?platform=ios'), tess)
    assert.equal(app.status, 200, app.text)
    assert.deepEqual(
      (app.json.branches as Json[]).map((branch) => branch.name),
      ['master', 'feature/new'],
    )
    assert.deepEqual(app.json.app, {
      id: apps[EXAMPLE],
      name: 'Example App',
      slug: EXAMPLE,
    })
    assert.deepEqual(Object.keys(app.json.latest).sort(), ['android', 'ios'])
    // A branch's builds for the chosen platform, newest first.
    const builds = await api(
      'GET',
      branchRoute(EXAMPLE, 'feature/new', '?platform=ios'),
      tess,
    )
    assert.equal(builds.status, 200, builds.text)
    assert.equal(builds.json.branch, 'feature/new')
    assert.deepEqual(
      (builds.json.builds as Json[]).map((build) => build.buildNumber),
      ['4', '3'],
    )
    assert.equal(
      builds.json.builds[0].commit,
      'abcdef0123456789abcdef0123456789abcdef01',
    )
    assert.deepEqual(builds.json.ios, { via: 'here' })
    assert.deepEqual(
      (
        (
          await api(
            'GET',
            branchRoute(EXAMPLE, 'feature/new', '?platform=android'),
            tess,
          )
        ).json.builds as Json[]
      ).map((build) => build.buildNumber),
      ['2'],
    )
    assert.deepEqual(
      (
        await api(
          'GET',
          branchRoute(EXAMPLE, 'feature/new', '?platform=windows'),
          tess,
        )
      ).json.builds,
      [],
    )
    // Each page is the web app's shell.
    for (const route of [
      '/apps',
      `/apps/${apps[EXAMPLE]}`,
      `/apps/${apps[EXAMPLE]}/branches/${branchKey('feature/new')}`,
    ])
      assertShell(await request(route, { cookie: tess.cookie }))
    assertShell(await request('/apps/999999', { cookie: tess.cookie }), 404)
    assert.deepEqual(
      (await api('GET', '/api/v2/catalog/apps/999999', tess)).json,
      { error: 'App unavailable' },
    )
    assert.equal(
      (await api('GET', '/api/v2/catalog/apps/nope', tess)).status,
      404,
    )
    assert.equal(
      (await api('GET', appRoute(EXAMPLE, '?platform=untrusted'), tess)).status,
      400,
    )
    assert.equal(
      (
        await api(
          'GET',
          `/api/v2/catalog/apps/${apps[EXAMPLE]}/branches/a=`,
          tess,
        )
      ).status,
      400,
    )
    // A disabled app is gone from Install apps.
    await enable(EXAMPLE, false)
    try {
      const without = await api('GET', '/api/v2/catalog/apps', tess)
      assert(
        !(without.json.apps as Json[]).some((item) => item.slug === EXAMPLE),
      )
      assert.equal((await api('GET', appRoute(EXAMPLE), tess)).status, 404)
    } finally {
      await enable(EXAMPLE, true)
    }
    // Builds past their retention are not listed.
    await publish(NEXT, 'android', { at: Date.now() - 15 * 86_400_000 })
    const expired = await api('GET', appRoute(NEXT), tess)
    assert.deepEqual([expired.json.branches, expired.json.latest], [[], {}])
  })

  it('M4 names the platforms that have builds when the chosen one has none on any branch, each opening its branches', async () => {
    const tess = as('tess')
    const empty = await api('GET', appRoute(M4, '?platform=windows'), tess)
    assert.deepEqual([empty.json.branches, empty.json.latest], [[], {}])
    assert.deepEqual([...empty.json.platforms].sort(), [
      'android',
      'ios',
      'windows',
    ])
    const at = Date.now() - 30_000
    await publish(M4, 'ios', { number: '1', at })
    await publish(M4, 'android', {
      branch: 'feature/new',
      number: '2',
      at: at + 1000,
    })
    // Windows has none: the platforms that do are named, with when they last built.
    const windows = await api('GET', appRoute(M4, '?platform=windows'), tess)
    assert.deepEqual(Object.keys(windows.json.latest).sort(), [
      'android',
      'ios',
    ])
    assert.equal(windows.json.latest.ios, at)
    assert.equal(windows.json.latest.android, at + 1000)
    assert.deepEqual(
      (windows.json.branches as Json[]).map((branch) => branch.name),
      ['master', 'feature/new'],
    )
    // The platform is the query's, else the remembered one, else the browser's.
    const numbers = async (
      route: string,
      headers: Record<string, string> = {},
      cookie = '',
    ): Promise<string[]> =>
      (
        (await api('GET', route, tess, { cookie, headers })).json
          .builds as Json[]
      ).map((build) => build.buildNumber)
    const master = branchRoute(M4, 'master')
    const iphone = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0)' }
    assert.deepEqual(await numbers(master, iphone), ['1'])
    assert.deepEqual(
      await numbers(master, iphone, '; mason-platform=android'),
      [],
    )
    assert.deepEqual(
      await numbers(
        master,
        { 'user-agent': 'Android' },
        '; mason-platform=bad',
      ),
      [],
    )
    assert.deepEqual(await numbers(master, iphone, '; mason-platform=bad'), [
      '1',
    ])
    assert.deepEqual(
      await numbers(
        branchRoute(M4, 'feature/new', '?platform=android'),
        iphone,
        '; mason-platform=ios',
      ),
      ['2'],
    )
  })

  it('U12.16 lists a run’s variants together, newest first, each with its size and its own download', async () => {
    const tess = as('tess')
    const at = Date.now() - 20_000
    const lone = await publish(VARIANTS, 'android', { number: '90', at })
    const run = (
      variant: string,
      number: string,
      size: number,
    ): ReturnType<typeof publish> =>
      publish(VARIANTS, 'android', {
        number,
        variant,
        run: 'run-7',
        at: at + 1000,
        bytes: variant.padEnd(size, '.'),
      })
    const arm64 = await run('arm64-v8a', '102', 200)
    const plain = await run('', '100', 300)
    const v7 = await run('armeabi-v7a', '101', 100)
    const branch = await api(
      'GET',
      branchRoute(VARIANTS, 'master', '?platform=android'),
      tess,
    )
    const rows = branch.json.builds as Json[]
    // The run's builds lead, newest first; the build of no run follows as it was.
    assert.deepEqual(
      rows.map((row) => row.id),
      [v7.id, plain.id, arm64.id, lone.id],
    )
    assert.deepEqual(
      rows.map((row) => [row.run, row.variant, row.buildNumber, row.size]),
      [
        ['run-7', 'armeabi-v7a', '101', 100],
        ['run-7', '', '100', 300],
        ['run-7', 'arm64-v8a', '102', 200],
        [null, '', '90', lone.bytes.length],
      ],
    )
    assert(rows.every((row) => row.eligible === true && row.token == null))
    // Each variant installs its own package.
    for (const [build, bytes] of [
      [v7, v7.bytes],
      [arm64, arm64.bytes],
    ] as const) {
      const answer = await install(build.id, tess)
      assert.equal(answer.json.kind, 'download', answer.text)
      const file = await request(answer.json.url)
      assert.equal(file.status, 200)
      assert.equal(file.text, bytes.toString())
      assert.equal(
        file.headers.get('content-disposition'),
        `attachment; filename="build-${build.id}.apk"`,
      )
    }
  })

  it('does not reveal catalog data to anonymous people, or to people without tester access or the app', async () => {
    const hidden = await publish(HIDDEN, 'android')
    const routes = [
      '/api/v2/catalog/apps',
      appRoute(HIDDEN),
      branchRoute(HIDDEN, 'master'),
    ]
    // Signed out: 401 as JSON; the pages ask for a sign-in, back to the address.
    for (const route of routes)
      assert.deepEqual((await api('GET', route)).json, {
        error: 'Not signed in',
      })
    assert.equal(
      (await api('POST', `/api/v2/catalog/builds/${hidden.id}/install`)).status,
      401,
    )
    for (const route of ['/apps', `/apps/${apps[HIDDEN]}`]) {
      const signedOut = await request(route)
      assert.equal(signedOut.status, 303, route)
      assert.equal(
        signedOut.headers.get('location'),
        '/auth/login?return=' + encodeURIComponent(route),
      )
    }
    // A tester in no group sees no apps, and the app is unknown to her.
    const nobody = as('nobody')
    assert.deepEqual((await api('GET', '/api/v2/catalog/apps', nobody)).json, {
      apps: [],
      platforms: [],
    })
    for (const route of routes.slice(1)) {
      const reply = await api('GET', route, nobody)
      assert.equal(reply.status, 404, route)
      assert(!reply.text.includes('Hidden App'))
    }
    assert.deepEqual((await install(hidden.id, nobody)).json, {
      error: 'App unavailable',
    })
    assertShell(await request(`/apps/${apps[HIDDEN]}`, nobody), 404)
    // Without tester access: 403, and nothing of the catalog.
    cache()
      .prepare('UPDATE accounts SET is_tester=0 WHERE id=?')
      .run(people.nobody!)
    try {
      for (const route of routes) {
        const reply = await api('GET', route, nobody)
        assert.equal(reply.status, 403, route)
        assert.deepEqual(reply.json, { error: 'Tester access required' })
      }
      assertShell(await request('/apps', nobody), 403)
    } finally {
      cache()
        .prepare('UPDATE accounts SET is_tester=1 WHERE id=?')
        .run(people.nobody!)
    }
    // A developer sees every app.
    const dev = await api('GET', '/api/v2/catalog/apps', as('dev'))
    assert((dev.json.apps as Json[]).some((app) => app.slug === HIDDEN))
  })

  it('offers a direct iOS install link tied to the authorized session', async () => {
    const tess = as('tess')
    const build = await publish(IOS, 'ios', { provision: true })
    // Without a device, the build waits for one; no grant is made.
    const plain = await api(
      'GET',
      branchRoute(IOS, 'master', '?platform=ios'),
      tess,
    )
    const without = (plain.json.builds as Json[]).find(
      (row) => row.id === build.id,
    )
    assert.equal(without.eligible, false)
    assert.equal(without.token, undefined)
    assert.equal(plain.json.device, false)
    // With Tess's iPhone selected, the row links straight to the installer.
    const branch = await api(
      'GET',
      branchRoute(IOS, 'master', '?platform=ios'),
      tess,
      withDevice(),
    )
    assert.equal(branch.json.device, true)
    const row = (branch.json.builds as Json[]).find(
      (item) => item.id === build.id,
    )
    assert.equal(row.eligible, true)
    assert.equal(row.installUrl, iosInstallUrl(origin(), row.token))
    const link = new URL(row.installUrl)
    assert.equal(link.protocol, 'itms-services:')
    const manifest = link.searchParams.get('url')!
    assert.equal(new URL(manifest).origin, origin())
    const plist = await request(manifest)
    assert.equal(plist.status, 200)
    assert.match(plist.text, /<string>test\.example\.ios<\/string>/)
    assert(plist.text.includes(`${origin()}/install/${row.token}/artifact`))
    host.host!.accounts.logout(tess.token)
    assert.equal((await request(manifest)).status, 404)
    assert.equal((await request(`/install/${row.token}/artifact`)).status, 404)
  })

  it('U12.19 offers an iPhone Simulator build as a download only: no install link, no manifest, no device check', async () => {
    const tess = as('tess')
    const at = Date.now() - 10_000
    const phone = await publish(IOS, 'ios', {
      branch: 'simulator',
      number: '201',
      run: 'run-20',
      at,
    })
    const bytes = 'a zipped simulator app'
    const simulator = await publish(IOS, 'ios', {
      branch: 'simulator',
      number: '201',
      run: 'run-20',
      variant: 'maestro',
      format: 'zip',
      bytes,
      at,
    })
    const branch = await api(
      'GET',
      branchRoute(IOS, 'simulator', '?platform=ios'),
      tess,
      withDevice(),
    )
    const row = (id: number): Json =>
      (branch.json.builds as Json[]).find((item) => item.id === id)
    // The device build waits for this device; the simulator build is a download.
    assert.equal(row(phone.id).eligible, false)
    assert.equal(row(phone.id).download, undefined)
    assert.deepEqual(
      [
        row(simulator.id).download,
        row(simulator.id).eligible,
        row(simulator.id).token,
        row(simulator.id).installUrl,
      ],
      ['iPhone Simulator', true, undefined, undefined],
    )
    assert.doesNotMatch(branch.text, /itms-services/)
    // Install asks for this device's build, or a device at all.
    assert.deepEqual((await install(phone.id, tess, withDevice())).json, {
      kind: 'prepare',
      buildId: phone.id,
    })
    assert.deepEqual((await install(phone.id, tess)).json, {
      kind: 'register',
    })
    const answer = await install(simulator.id, tess)
    assert.equal(answer.json.kind, 'download', answer.text)
    assert.equal(typeof answer.json.expiresAt, 'number')
    const download = await request(answer.json.url)
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('content-type'), 'application/zip')
    assert.equal(download.text, bytes)
    assert.equal(
      (await request(answer.json.url.replace('/artifact', '/manifest.plist')))
        .status,
      404,
    )
  })

  it('U14.13 offers a tvOS app as an Apple TV download: no install link, no manifest', async () => {
    const tess = as('tess')
    const tv = await publish(TV, 'tvos', { number: '300' })
    // The app has the platforms it has channels for.
    const app = await api('GET', appRoute(TV, '?platform=tvos'), tess)
    assert.deepEqual(app.json.platforms, ['tvos'])
    const branch = await api(
      'GET',
      branchRoute(TV, 'master', '?platform=tvos'),
      tess,
      withDevice(),
    )
    assert.deepEqual(branch.json.platforms, ['tvos'])
    const row = (branch.json.builds as Json[])[0]
    assert.deepEqual(
      [row.id, row.download, row.eligible, row.token, row.format],
      [tv.id, 'Apple TV', true, undefined, 'ipa'],
    )
    assert.doesNotMatch(branch.text, /itms-services/)
    const answer = await install(tv.id, tess, withDevice())
    assert.equal(answer.json.kind, 'download', answer.text)
    assert.equal((await request(answer.json.url)).status, 200)
    assert.equal(
      (await request(answer.json.url.replace('/artifact', '/manifest.plist')))
        .status,
      404,
    )
  })

  it('issues cookie-free iOS manifests and streams GET, HEAD and single ranges', async () => {
    const tess = as('tess')
    const build = await publish(IOS, 'ios', {
      branch: 'ranges',
      bytes: content,
      provision: true,
    })
    const answer = await install(build.id, tess, withDevice())
    assert.equal(answer.json.kind, 'itms', answer.text)
    const manifestUrl = new URL(answer.json.url).searchParams.get('url')!
    const token = /\/install\/([^/]+)\/manifest\.plist$/.exec(manifestUrl)![1]!
    // The host keeps the grant by its digest, never the token itself.
    assert(
      cache()
        .prepare('SELECT 1 FROM install_grants WHERE hash=?')
        .get(digest(token)) != null,
    )
    assert.equal(
      cache().prepare('SELECT 1 FROM install_grants WHERE hash=?').get(token),
      undefined,
    )
    const manifest = await request(manifestUrl)
    assert.equal(manifest.status, 200)
    assert.match(manifest.text, /test\.example\.ios/)
    const url = `/install/${token}/artifact`
    for (const method of ['GET', 'HEAD']) {
      const response = await request(url, { method })
      assert.equal(response.status, 200)
      assert.equal(
        response.headers.get('content-length'),
        String(content.length),
      )
      assert.equal(response.headers.get('etag'), `"${digest(content)}"`)
      assert.equal(response.headers.get('accept-ranges'), 'bytes')
      assert.equal(response.text, method === 'HEAD' ? '' : content)
    }
    for (const [range, expected] of [
      ['bytes=2-5', content.slice(2, 6)],
      ['bytes=30-', content.slice(30)],
      ['bytes=-4', content.slice(-4)],
      ['bytes=0-999', content],
      ['bytes=-999', content],
    ] as const) {
      const response = await request(url, { headers: { range } })
      assert.equal(response.status, 206, range)
      assert.equal(response.text, expected)
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
      const response = await request(url, { headers: { range } })
      assert.equal(response.status, 416, range)
      assert.equal(
        response.headers.get('content-range'),
        `bytes */${content.length}`,
      )
    }
    const mismatch = await request(url, {
      headers: { range: 'bytes=0-1', 'if-range': '"other"' },
    })
    assert.equal(mismatch.status, 200)
    assert.equal(mismatch.text, content)
    const rangeHead = await request(url, {
      method: 'HEAD',
      headers: { range: 'bytes=2-3', 'if-range': `"${digest(content)}"` },
    })
    assert.equal(rangeHead.status, 206)
    assert.equal(rangeHead.headers.get('content-length'), '2')
    assert.equal(rangeHead.headers.get('content-range'), 'bytes 2-3/36')
    assert.equal(rangeHead.text, '')
    for (const route of [
      '/install/invalid/artifact',
      '/install/invalid/manifest.plist',
      `/install/${token}/other`,
    ])
      assert.equal((await request(route)).status, 404, route)
  })

  it('requires CSRF for installation and returns the appropriate installer for all formats', async () => {
    const tess = as('tess')
    for (const os of ['ios', 'android', 'macos', 'windows'] as const) {
      const build = await publish(FORMATS, os, { provision: os === 'ios' })
      assert.equal((await install(build.id, undefined as never)).status, 401)
      // The proof and the host's own origin are both needed.
      for (const headers of [
        { origin: '', 'x-mason-csrf': '' },
        { origin: 'https://elsewhere.example.test' },
        { 'x-mason-csrf': 'not-it' },
      ] as Array<Record<string, string>>) {
        const refused = await install(build.id, tess, {
          ...withDevice(),
          headers,
        })
        assert.equal(refused.status, 403, `${os} ${JSON.stringify(headers)}`)
      }
      const answer = await install(build.id, tess, withDevice())
      assert.equal(answer.status, 200, answer.text)
      if (os === 'ios') {
        assert.equal(answer.json.kind, 'itms')
        assert.match(
          answer.json.url,
          /^itms-services:\/\/\?action=download-manifest&url=/,
        )
        assert(answer.json.expiresAt > Date.now())
      } else {
        assert.equal(answer.json.kind, 'download')
        const file = await request(answer.json.url)
        assert.equal(file.status, 200)
        assert.equal(
          file.headers.get('content-type'),
          formatTypes[defaultFormat(os)],
        )
        assert.equal(
          (
            await request(
              answer.json.url.replace('/artifact', '/manifest.plist'),
            )
          ).status,
          404,
        )
      }
    }
    const msi = await publish(FORMATS, 'windows', { format: 'msi' })
    const answer = await install(msi.id, tess)
    assert.equal(answer.json.kind, 'download')
    const file = await request(answer.json.url)
    assert.equal(file.status, 200)
    assert.equal(file.text, msi.bytes.toString())
    assert.deepEqual((await install(999999, tess)).json, {
      error: 'Build unavailable',
    })
    assert.equal(
      (await api('POST', '/api/v2/catalog/builds/nope/install', tess)).status,
      404,
    )
  })

  it('never follows replaced links or streams missing, wrong-sized or nonregular files', async () => {
    const tess = as('tess')
    const build = await publish(FILES, 'android')
    const answer = await install(build.id, tess)
    const url = answer.json.url as string
    assert.equal((await request(url)).status, 200)
    const file = path.join(
      host.host!.options.dir,
      'storage',
      'files',
      build.key,
    )
    rmSync(file)
    assert.equal((await request(url)).status, 404)
    const outside = path.join(root, 'outside')
    writeFileSync(outside, build.bytes)
    symlinkSync(outside, file)
    assert.equal((await request(url)).status, 404)
    rmSync(file)
    mkdirSync(file)
    assert.equal((await request(url)).status, 404)
    rmSync(file, { recursive: true })
    writeFileSync(file, 'wrong size')
    chmodSync(file, 0o400)
    assert.equal((await request(url)).status, 404)
  })
})

describe('Install grants on a distribution store', () => {
  let store: Store,
    accounts: Accounts,
    installs: Installations,
    root: string,
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
  function publish(
    os: Platform,
    branch = 'master',
    number = '1',
    format: Format = defaultFormat(os),
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
  /** A grant's file as the host would send it, its bytes read. */
  const deliver = async (
    token: string,
    part: 'manifest.plist' | 'artifact',
    request: { method?: 'GET' | 'HEAD'; range?: string; ifRange?: string } = {},
  ): Promise<FileDelivery & { text: string }> => {
    const delivery = await installDelivery(store, installs, token, part, {
      method: request.method ?? 'GET',
      ...(request.range == null ? {} : { range: request.range }),
      ...(request.ifRange == null ? {} : { ifRange: request.ifRange }),
    })
    const text =
      delivery.body ??
      (delivery.open == null
        ? ''
        : await readText((await delivery.open()) as Readable))
    return { ...delivery, text }
  }
  beforeEach(() => {
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
  })
  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('migrates a standalone store to distribution user_version 9, whose relay sessions never sign a browser in', () => {
    const file = path.join(root, 'v8.sqlite')
    const old = new Store(
      asConfig({
        origin: 'https://builds.example.test',
        database: file,
        storage: path.join(root, 'v8-packages'),
        freeSpaceBytes: 0,
      }),
    )
    old.db.exec(`ALTER TABLE sessions DROP COLUMN relayed;
      ALTER TABLE device_challenges DROP COLUMN return_origin;
      PRAGMA user_version=8;`)
    old.close()
    const migrated = new Store(
      asConfig({
        origin: 'https://builds.example.test',
        database: file,
        storage: path.join(root, 'v8-packages'),
        freeSpaceBytes: 0,
      }),
    )
    try {
      assert.equal(
        migrated.db.prepare('PRAGMA user_version').get()?.user_version,
        9,
      )
      const people = new Accounts(migrated)
      const started = people.login(identity)
      assert.equal(
        migrated.db
          .prepare('SELECT relayed FROM sessions WHERE hash=?')
          .get(started.session.hash)?.relayed,
        0,
      )
      assert(people.session(started.token) != null)
      migrated.db
        .prepare('UPDATE sessions SET relayed=1 WHERE hash=?')
        .run(started.session.hash)
      assert.equal(people.session(started.token), undefined)
      assert(people.sessionHash(started.session.hash) != null)
    } finally {
      migrated.close()
    }
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
    assert.throws(() => platform('bad', undefined, ''))
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
    // Master first; then the newest; a tie by name.
    const at = (branch: string, time: number): Build =>
      ({ ...a, branch, published_at: time }) as Build
    assert.deepEqual(
      branches([
        at('b', 5),
        at('a', 5),
        at('c', 9),
        at('master', 1),
        at('c', 2),
      ]),
      [
        { name: 'master', time: 1 },
        { name: 'c', time: 9 },
        { name: 'a', time: 5 },
        { name: 'b', time: 5 },
      ],
    )
  })

  it('streams a grant’s file from its own disk: GET, HEAD, single ranges and the manifest for an iOS app only', async () => {
    const ipa = publish('ios')
    const grant = installs.create(ipa.id, user.session)
    const manifest = await deliver(grant.token, 'manifest.plist')
    assert.equal(manifest.status, 200)
    assert(
      manifest.text.includes(
        installs.url(grant.token, 'artifact').replaceAll('&', '&amp;'),
      ),
    )
    assert.match(manifest.text, /<string>Example App<\/string>/)
    // A manifest names its package on the origin it is asked for.
    assert(
      installs
        .manifest(ipa, grant.token, 'https://other.example.test')
        .includes(`https://other.example.test/install/${grant.token}/artifact`),
    )
    const full = await deliver(grant.token, 'artifact')
    assert.deepEqual(
      [full.status, full.text, full.headers.ETag],
      [200, content, `"${digest(content)}"`],
    )
    const head = await deliver(grant.token, 'artifact', { method: 'HEAD' })
    assert.deepEqual(
      [head.status, head.text, head.headers['Content-Length']],
      [200, '', String(content.length)],
    )
    const part = await deliver(grant.token, 'artifact', { range: 'bytes=2-5' })
    assert.deepEqual([part.status, part.text], [206, content.slice(2, 6)])
    const unsatisfiable = await deliver(grant.token, 'artifact', {
      range: 'bytes=99-',
    })
    assert.deepEqual(
      [unsatisfiable.status, unsatisfiable.headers['Content-Range']],
      [416, `bytes */${content.length}`],
    )
    const stale = await deliver(grant.token, 'artifact', {
      range: 'bytes=2-5',
      ifRange: '"other"',
    })
    assert.deepEqual([stale.status, stale.text], [200, content])
    for (const token of ['invalid', 'A'.repeat(43)])
      for (const resource of ['artifact', 'manifest.plist'] as const)
        assert.equal((await deliver(token, resource)).status, 404)
    assert.equal(byteRange(undefined, 10), undefined)
    // Nothing but an iOS app has a manifest.
    const apk = publish('android')
    const download = installs.create(apk.id, user.session)
    assert.equal((await deliver(download.token, 'manifest.plist')).status, 404)
    assert.throws(() => installs.manifest(apk, 'fixture'), /iOS/)
    const msi = publish('windows', 'master', '2', 'msi')
    assert.throws(() => installs.manifest(msi, 'fixture'), /iOS/)
    assert.equal(
      (await deliver(installs.create(msi.id, user.session).token, 'artifact'))
        .status,
      200,
    )
    assert.throws(() => installs.create(999, user.session), /unavailable/)
  })

  it('never follows replaced links or streams missing, wrong-sized or nonregular files from its disk', async () => {
    const build = publish('android'),
      grant = installs.create(build.id, user.session),
      file = store.filePath(build.file_key)
    rmSync(file)
    assert.equal((await deliver(grant.token, 'artifact')).status, 404)
    const outside = path.join(root, 'outside')
    writeFileSync(outside, content)
    symlinkSync(outside, file)
    assert.equal((await deliver(grant.token, 'artifact')).status, 404)
    rmSync(file)
    mkdirSync(file)
    assert.equal((await deliver(grant.token, 'artifact')).status, 404)
    rmSync(file, { recursive: true })
    writeFileSync(file, 'wrong size')
    chmodSync(file, 0o400)
    assert.equal((await deliver(grant.token, 'artifact')).status, 404)
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

  it('refuses grants and devices to an account without tester access, and lists every device to an administrator', async () => {
    const build = publish('android')
    const pending = accounts.login({ ...identity, subject: 'pending' })
    assert.throws(() => installs.create(build.id, pending.session), /Tester/)
    const refused = new StoreCatalogSource(store, { session: pending.session })
    await assert.rejects(
      refused.apps(pending.account.id),
      (error: unknown) =>
        error instanceof CatalogRefused && error.status === 403,
    )
    await assert.rejects(
      refused.devices(pending.account.id),
      (error: unknown) =>
        error instanceof CatalogRefused && error.status === 403,
    )
    const id = Number(
      store.db
        .prepare(
          "INSERT INTO devices(udid,product,model,os_version,status,created_at,updated_at) VALUES(?,'iPhone14,5','iPhone 13','26.0','registered',?,?)",
        )
        .run('D'.repeat(40), now, now).lastInsertRowid,
    )
    store.db
      .prepare(
        'INSERT INTO account_devices(account_id,device_id,name,created_at) VALUES(?,?,?,?)',
      )
      .run(user.account.id, id, 'Alex’s iPhone', now)
    const source = new StoreCatalogSource(store, { session: user.session })
    const listed = await source.devices(user.account.id, id)
    assert.equal(listed.selected, id)
    assert.equal(listed.registration, false)
    assert.deepEqual(listed.all, [
      { name: 'Alex’s iPhone', model: 'iPhone 13', status: 'registered' },
    ])
    assert.deepEqual(
      listed.devices.map((item) => item.id),
      [id],
    )
  })
})
