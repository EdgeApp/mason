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
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'mocha'
import { SESSION_COOKIE } from '../auth/routes.js'
import { branchKey } from '../catalog/platform.js'
import { DEVICE_COOKIE } from '../devices/store.js'
import { assertShell } from '../test/webShell.js'
import { HostCache } from '../host/cache.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { digest, insertBuild } from '../store.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { crumbTrail } from '../test/crumbs.js'
import { MASTER_SESSION_COOKIE } from './auth.js'
import { localOperator } from './roles.js'

// Rows and answers are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const admin = localOperator
const ALPHA = 'com.example.alpha'
const BETA = 'com.example.beta'
const MASTER_ORIGIN = 'https://master.example.test'
const udidTess = 'B'.repeat(39) + '1'
const udidNora = 'B'.repeat(39) + '2'
const udidNew = 'B'.repeat(39) + '3'
const sha = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex')
const files = {
  apk: Buffer.from('android package '.repeat(40)),
  ipa: Buffer.from('ios application '.repeat(30)),
  stale: Buffer.from('an ios build without the device '.repeat(5)),
  beta: Buffer.from('beta android package'),
}

interface Reply {
  status: number
  text: string
  body: Buffer
  headers: { get(name: string): string | null }
}

describe('Install apps and Devices on the master, through the host', function () {
  this.timeout(180_000)
  let root: string
  let c: Cluster
  let host: RunningNode
  const people: Record<string, number> = {}
  const apps: Record<string, number> = {}
  const builds: Record<string, number> = {}
  const devices: Record<string, number> = {}

  const url = (node: RunningNode): string =>
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  const request = async (
    node: RunningNode,
    route: string,
    init: {
      method?: string
      cookie?: string
      headers?: Record<string, string>
      form?: Record<string, string>
      body?: Uint8Array
    } = {},
  ): Promise<Reply> => {
    const response = await pinnedFetch(
      url(node) + route,
      {
        method: init.method ?? (init.form == null ? 'GET' : 'POST'),
        redirect: 'manual',
        headers: {
          ...(init.cookie == null ? {} : { cookie: init.cookie }),
          ...(init.form == null
            ? {}
            : {
                origin: url(node),
                'content-type': 'application/x-www-form-urlencoded',
              }),
          ...init.headers,
        },
        ...(init.form == null
          ? init.body == null
            ? {}
            : { body: init.body }
          : { body: new URLSearchParams(init.form).toString() }),
      },
      node.web!.certificate!.pin,
    )
    const body = Buffer.from(await response.arrayBuffer())
    return {
      status: response.status,
      text: body.toString(),
      body,
      headers: response.headers,
    }
  }
  /** A master session: its cookie, its form proof, and its token for signing out. */
  const onMaster = (
    person: string,
  ): { cookie: string; csrf: string; token: string } => {
    const { token, session } = c.master.master!.auth.start(
      people[person]!,
      '127.0.0.1',
    )
    return {
      cookie: `${MASTER_SESSION_COOKIE}=${token}`,
      csrf: session.csrf,
      token,
    }
  }
  const onHost = (person: string): { cookie: string; csrf: string } => {
    const { token, session } = host.host!.accounts.startSession(people[person]!)
    return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrf }
  }
  const db = (): DatabaseSync => c.master.master!.database.db
  const setOrigin = async (origin: string): Promise<void> => {
    await c.master.master!.settings.set(admin, 'master', { origin })
  }
  /** The side menu's links on a page, in order; the current one starred. */
  const rail = (html: string): string[] =>
    [
      ...(/<nav class="rail"[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? '').matchAll(
        /<a href="([^"]+)"( aria-current="page")?/g,
      ),
    ].map((match) => match[1]! + (match[2] == null ? '' : '*'))
  const cards = (html: string): string[] =>
    [...html.matchAll(/<a class="app-card" href="([^"]+)"/g)].map(
      (match) => match[1]!,
    )
  const openssl = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
  }
  /** A payload signed by the fixture "Apple" device CA, as an iPhone's Profile Service response is. */
  const signed = (token: string, udid: string): Uint8Array => {
    writeFileSync(
      path.join(root, 'data.plist'),
      `<plist version="1.0"><dict><key>CHALLENGE</key><string>${token}</string><key>UDID</key><string>${udid}</string><key>PRODUCT</key><string>iPhone14,5</string><key>VERSION</key><string>26.0</string></dict></plist>`,
    )
    openssl(
      `cms -sign -binary -nodetach -in data.plist -signer leaf.pem -inkey leaf.key -certfile ca.pem -outform DER -out signed.der`.split(
        ' ',
      ),
    )
    return new Uint8Array(readFileSync(path.join(root, 'signed.der')))
  }
  const publish = async (
    app: string,
    platform: string,
    format: string,
    bytes: Buffer,
    number: string,
    branch = 'master',
  ): Promise<number> => {
    const channel = (
      db()
        .prepare('SELECT id FROM channels WHERE app_id=? AND platform=?')
        .get(apps[app]!, platform) as Json
    ).id
    const key = sha(bytes).slice(0, 32) + '.' + format
    const build = insertBuild(
      db(),
      {
        channelId: Number(channel),
        branch,
        commit: 'c'.repeat(40),
        version: '1.0',
        buildNumber: number,
        bundleId: app,
        format: format as Json,
        size: bytes.length,
        digest: sha(bytes),
        changelog: '',
        source: 'test',
        customFields: '{}',
      },
      key,
      { now: Date.now(), retentionDays: 14 },
    )
    const file = path.join(root, `upload-${number}`)
    writeFileSync(file, bytes)
    await host.host!.objects.put(key, file, sha(bytes))
    c.master.master!.database.change('build', build.id)
    return build.id
  }

  before(async () => {
    root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'catalog-relay-'),
    )
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
    c = await cluster(path.join(root, 'cluster'))
    // A tester's home is Install apps, even before a host exists.
    host = await c.startHost('host', { testEndpoints: true })
    host.host!.setTrustRoot(readFileSync(path.join(root, 'ca.pem'), 'utf8'))
    const master = c.master.master!
    await master.settings.set(admin, 'host', { origin: url(host) })
    await setOrigin(MASTER_ORIGIN)
    const repo = c.repo('fixtures/relay')
    repo.commit({ 'Masonfile.ts': 'export function setup() {}' })
    master.saveProject(admin, 'relay', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
      apps: [
        { bundleId: ALPHA, name: 'Alpha', platforms: ['ios', 'android'] },
        { bundleId: BETA, name: 'Beta', platforms: ['android'] },
      ],
    })
    for (const slug of [ALPHA, BETA])
      apps[slug] = Number(
        (db().prepare('SELECT id FROM apps WHERE slug=?').get(slug) as Json).id,
      )
    for (const name of ['tess', 'nora'])
      people[name] = (
        await master.people.create(admin, {
          name: name === 'tess' ? 'Tess Tester' : 'Nora Tester',
          emails: [`${name}@example.test`],
          role: 'tester',
        })
      ).id
    people.dev = (
      await master.people.create(admin, {
        name: 'Dev Developer',
        emails: ['dev@example.test'],
        role: 'developer',
      })
    ).id
    master.people.createGroup(admin, {
      name: 'Testers',
      apps: [apps[ALPHA]!],
      members: [people.tess!, people.nora!],
    })
    // Each tester has a registered iPhone; the iOS build includes Tess's only.
    const now = Date.now()
    for (const [name, udid] of [
      ['tess', udidTess],
      ['nora', udidNora],
    ] as const) {
      const id = Number(
        db()
          .prepare(
            "INSERT INTO devices(udid,product,model,os_version,status,created_at,updated_at) VALUES(?,'iPhone14,5','iPhone 13','26.0','registered',?,?)",
          )
          .run(udid, now, now).lastInsertRowid,
      )
      db()
        .prepare(
          'INSERT INTO account_devices(account_id,device_id,name,created_at) VALUES(?,?,?,?)',
        )
        .run(people[name]!, id, `iPhone of ${name}`, now)
      devices[name] = id
      master.database.change('device', id)
      master.database.change('account', people[name]!)
    }
    builds.apk = await publish(ALPHA, 'android', 'apk', files.apk, '1')
    builds.ipa = await publish(ALPHA, 'ios', 'ipa', files.ipa, '2')
    builds.stale = await publish(ALPHA, 'ios', 'ipa', files.stale, '3')
    builds.beta = await publish(BETA, 'android', 'apk', files.beta, '4')
    db()
      .prepare(
        "INSERT INTO build_provisioning(build_id,devices,expires_at,team) VALUES(?,?,?,'ABCDE12345')",
      )
      .run(builds.ipa, JSON.stringify([udidTess]), now + 86_400_000)
    master.database.change('build', builds.ipa)
    await c.until(
      () =>
        host
          .host!.cache.db.prepare(
            'SELECT COUNT(*) n FROM build_provisioning WHERE build_id=?',
          )
          .get(builds.ipa!)!.n === 1 &&
        host
          .host!.cache.db.prepare(
            'SELECT COUNT(*) n FROM account_devices WHERE device_id IN (?,?)',
          )
          .get(devices.tess!, devices.nora!)!.n === 2 &&
        host
          .host!.cache.db.prepare(
            'SELECT 1 FROM group_members WHERE account_id=?',
          )
          .get(people.nora!) &&
        host
          .host!.cache.db.prepare('SELECT 1 FROM builds WHERE id=?')
          .get(builds.beta!) &&
        host
          .host!.cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(people.dev!),
      10_000,
      'the builds, devices and group on the host',
    )
  })
  after(async () => {
    await c?.close()
  })

  it('opens Install apps at a tester’s home on the master, which lists what the host lists for them', async () => {
    const tess = onMaster('tess')
    const home = await request(c.master, '/?platform=android', {
      cookie: tess.cookie,
    })
    assert.equal(home.status, 200)
    assert.deepEqual(cards(home.text), [
      `/apps/${apps[ALPHA]}?platform=android`,
    ])
    const signedOut = await request(c.master, '/apps')
    assert.equal(signedOut.status, 303)
    assert.equal(signedOut.headers.get('location'), '/sign-in')
    const page = await request(c.master, '/apps?platform=android', {
      cookie: tess.cookie,
    })
    assert.equal(page.status, 200, page.text)
    const onHostPage = await request(host, '/apps?platform=android', {
      cookie: onHost('tess').cookie,
    })
    assert.deepEqual(cards(page.text), cards(onHostPage.text))
    assert.deepEqual(cards(page.text), [
      `/apps/${apps[ALPHA]}?platform=android`,
    ])
    // In the master's shell, with the platform switch; Devices is in the side menu.
    assert.match(page.text, /href="\/account" aria-label="Your account"/)
    assert.match(
      page.text,
      /<nav class="catalog-nav" data-catalog-platforms aria-label="Build platform"><div class="platforms"[^>]*>.*iOS.*Android.*<\/div><\/nav>/,
    )
    assert.doesNotMatch(page.text, /Register Device</)
    // The relay session the host keeps for it never signs a browser in.
    const relay = host
      .host!.cache.db.prepare(
        'SELECT relayed FROM sessions WHERE account_id=? AND relayed=1',
      )
      .get(people.tess!) as Json
    assert.equal(relay.relayed, 1)
  })

  it('M7 keeps the side menu for a tester on both nodes, with only Install apps and Devices; to her /projects does not exist', async () => {
    const device = `; ${DEVICE_COOKIE}=${devices.tess}`
    const branch = `/apps/${apps[ALPHA]}/branches/${branchKey('master')}?platform=ios`
    for (const [node, who] of [
      [c.master, onMaster('tess')],
      [host, onHost('tess')],
    ] as const) {
      const name = node === host ? 'host' : 'master'
      // The breadcrumbs start from the node; the platform is left out here.
      const root = node === host ? 'Mason Host /' : 'Mason Master /'
      const app = `/apps/${apps[ALPHA]}`
      for (const [route, menu, crumbs] of [
        ['/', ['/apps*', '/devices'], ['Install apps /apps *']],
        ['/apps', ['/apps*', '/devices'], ['Install apps /apps *']],
        [app, ['/apps*', '/devices'], ['Install apps /apps', `Alpha ${app} *`]],
        [
          branch,
          ['/apps*', '/devices'],
          [
            'Install apps /apps',
            `Alpha ${app}`,
            `master ${app}/branches/${branchKey('master')} *`,
          ],
        ],
        ['/devices', ['/apps', '/devices*'], ['Devices /devices *']],
      ] as const) {
        const reply = await request(node, route, {
          cookie: who.cookie + device,
        })
        assert.equal(reply.status, 200, `${name} ${route}`)
        assert.deepEqual(rail(reply.text), menu, `${name} ${route}`)
        assert.deepEqual(
          crumbTrail(reply.text).map((crumb) =>
            crumb.replace(/\?platform=[a-z]+/, ''),
          ),
          [root, ...crumbs],
          `${name} ${route}`,
        )
        assert.match(
          reply.text,
          /href="\/account" aria-label="Your account"/,
          `${name} ${route}`,
        )
        assert.match(
          reply.text,
          new RegExp(
            `<div class="section">${node === host ? 'Host' : 'Master'}</div>`,
          ),
        )
      }
      // The iOS installer page, after Install.
      const installed = await request(node, `/builds/${builds.ipa}/install`, {
        cookie: who.cookie + device,
        form: { csrf: who.csrf },
      })
      assert.equal(installed.status, 200, `${name}: ${installed.text}`)
      assert.match(installed.text, /<h1>Install app<\/h1>/)
      assert.deepEqual(rail(installed.text), ['/apps*', '/devices'])
      for (const route of [
        '/projects',
        '/projects/relay',
        '/projects/relay/runs',
        '/projects/relay/masonfile',
      ]) {
        const reply = await request(node, route, { cookie: who.cookie })
        assert.equal(reply.status, 404, `${name} ${route}`)
        assert.deepEqual(rail(reply.text), ['/apps*', '/devices'])
      }
    }
    assert.equal(
      (
        await request(c.master, '/projects/new', {
          cookie: onMaster('tess').cookie,
        })
      ).status,
      404,
    )
  })

  it('M7 lands developers on Projects & apps on the master and on Install apps on the host', async () => {
    for (const [node, who] of [
      [c.master, onMaster('dev')],
      [host, onHost('dev')],
    ] as const) {
      const name = node === host ? 'host' : 'master'
      const home = await request(node, '/', { cookie: who.cookie })
      assert.equal(home.status, 200, name)
      if (node === host) {
        assert.match(home.text, /<h1>Apps<\/h1>/)
        assert.deepEqual(
          rail(home.text),
          ['/apps*', '/projects', '/artifacts', '/devices'],
          name,
        )
      } else assertShell(home)
      // Projects & apps is the web app's on both nodes, filters and all.
      const projects = await request(node, '/projects?platform=android', {
        cookie: who.cookie,
      })
      assertShell(projects)
      const project = await request(node, '/projects/relay', {
        cookie: who.cookie,
      })
      assert.equal(project.status, 200, name)
    }
    // Signed out, /projects asks for a sign-in on both nodes.
    assert.equal(
      (await request(c.master, '/projects')).headers.get('location'),
      '/sign-in',
    )
    assert.match(
      (await request(host, '/projects')).headers.get('location')!,
      /^\/auth\/login\?return=%2Fprojects/,
    )
  })

  it('answers 404 for an app the person may not see, on the master as on the host', async () => {
    const tess = onMaster('tess')
    for (const route of [
      `/apps/${apps[BETA]}`,
      `/apps/${apps[BETA]}/branches/${branchKey('master')}`,
    ]) {
      const reply = await request(c.master, route, { cookie: tess.cookie })
      assert.equal(reply.status, 404, route)
      assert.match(reply.text, /This app is unavailable/)
      assert.equal(
        (await request(host, route, { cookie: onHost('tess').cookie })).status,
        404,
      )
    }
    // An install or a device rebuild of that app's build is refused too, on
    // both nodes, and nothing is queued for it.
    const device = `; ${DEVICE_COOKIE}=${devices.tess}`
    for (const [node, session] of [
      [c.master, tess],
      [host, onHost('tess')],
    ] as const)
      for (const action of ['install', 'prepare']) {
        const reply = await request(node, `/builds/${builds.beta}/${action}`, {
          cookie: session.cookie + device,
          form: { csrf: session.csrf },
        })
        assert.equal(
          reply.status,
          404,
          `${action}: ${reply.text.slice(0, 200)}`,
        )
        assert.match(reply.text, /App unavailable/)
      }
    assert.equal(
      db()
        .prepare('SELECT 1 FROM device_build_requests WHERE build_id=?')
        .get(builds.beta!),
      undefined,
    )
  })

  it('streams the host’s bytes from the master, with HEAD, a range and an unsatisfiable range', async () => {
    const tess = onMaster('tess')
    const branch = await request(
      c.master,
      `/apps/${apps[ALPHA]}/branches/${branchKey('master')}?platform=android`,
      { cookie: tess.cookie },
    )
    assert.match(
      branch.text,
      new RegExp(
        `<form id="build-${builds.apk}" method="post" action="/builds/${builds.apk}/install">`,
      ),
    )
    const install = await request(c.master, `/builds/${builds.apk}/install`, {
      cookie: tess.cookie,
      form: { csrf: tess.csrf },
    })
    assert.equal(install.status, 303, install.text)
    const artifact = install.headers.get('location')!
    assert.match(artifact, /^\/install\/[A-Za-z0-9_-]{43}\/artifact$/)
    const full = await request(c.master, artifact)
    assert.equal(full.status, 200)
    assert.equal(sha(full.body), sha(files.apk))
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    assert.equal(full.headers.get('etag'), `"${sha(files.apk)}"`)
    assert.equal(
      full.headers.get('content-type'),
      'application/vnd.android.package-archive',
    )
    const head = await request(c.master, artifact, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.equal(head.headers.get('content-length'), String(files.apk.length))
    const range = await request(c.master, artifact, {
      headers: { range: 'bytes=0-99' },
    })
    assert.equal(range.status, 206)
    assert.equal(
      range.headers.get('content-range'),
      `bytes 0-99/${files.apk.length}`,
    )
    assert.deepEqual(range.body, files.apk.subarray(0, 100))
    // If-Range with another entity tag gets the whole file.
    const whole = await request(c.master, artifact, {
      headers: { range: 'bytes=0-99', 'if-range': '"other"' },
    })
    assert.equal(whole.status, 200)
    assert.equal(whole.body.length, files.apk.length)
    const beyond = await request(c.master, artifact, {
      headers: { range: `bytes=${files.apk.length}-` },
    })
    assert.equal(beyond.status, 416)
    assert.equal(
      beyond.headers.get('content-range'),
      `bytes */${files.apk.length}`,
    )
    // A token that names no grant, and a part that is no file.
    const bogus = `/install/${'A'.repeat(43)}/artifact`
    assert.equal((await request(c.master, bogus)).status, 404)
    assert.equal(
      (await request(c.master, artifact.replace('artifact', 'other'))).status,
      404,
    )
    // An Android build has no manifest.
    assert.equal(
      (await request(c.master, artifact.replace('artifact', 'manifest.plist')))
        .status,
      404,
    )
  })

  it('links a grant from the master’s branch page to the master’s manifest, and refuses it once the master session signs out', async () => {
    const tess = onMaster('tess')
    const device = `; ${DEVICE_COOKIE}=${devices.tess}`
    const page = await request(
      c.master,
      `/apps/${apps[ALPHA]}/branches/${branchKey('master')}?platform=ios`,
      { cookie: tess.cookie + device },
    )
    assert.equal(page.status, 200, page.text)
    const href = new RegExp(
      `<a id="build-${builds.ipa}" class="list-row build-row" data-install aria-label="[^"]*" href="itms-services://\\?action=download-manifest&amp;url=([^"]+)"`,
    ).exec(page.text)
    assert(href != null, page.text)
    const manifestUrl = decodeURIComponent(href[1]!)
    const token = new RegExp(
      `^${MASTER_ORIGIN}/install/([A-Za-z0-9_-]{43})/manifest\\.plist$`,
    ).exec(manifestUrl)?.[1]
    assert(token != null, manifestUrl)
    // The build the device is not in offers Prepare instead.
    assert.match(
      page.text,
      new RegExp(
        `<form id="build-${builds.stale}" method="post" action="/builds/${builds.stale}/install">.*Prepare for device`,
      ),
    )
    const manifest = await request(c.master, `/install/${token}/manifest.plist`)
    assert.equal(manifest.status, 200)
    assert.match(manifest.headers.get('content-type')!, /application\/xml/)
    assert.equal(manifest.headers.get('set-cookie'), null)
    assert.match(
      manifest.text,
      new RegExp(
        `<string>${MASTER_ORIGIN}/install/${token}/artifact</string>.*<string>${ALPHA}</string>`,
      ),
    )
    const ipa = await request(c.master, `/install/${token}/artifact`)
    assert.equal(sha(ipa.body), sha(files.ipa))
    // Signing out of the master ends the relay session and its grants.
    c.master.master!.auth.signOut(tess.token)
    await c.until(
      async () =>
        (await request(c.master, `/install/${token}/manifest.plist`)).status ===
          404 || undefined,
      5000,
      'the grant to end',
    )
    assert.equal(
      (await request(c.master, `/install/${token}/artifact`)).status,
      404,
    )
    // Signed out while the host is away: the host hears of it when it next
    // syncs, and drops that relay session (review 3.harness-review.3).
    const relays = (): number =>
      Number(
        host
          .host!.cache.db.prepare(
            'SELECT COUNT(*) n FROM sessions WHERE account_id=? AND relayed=1',
          )
          .get(people.tess!)!.n,
      )
    const away = onMaster('tess')
    await request(c.master, '/apps', { cookie: away.cookie })
    const before = relays()
    assert.ok(before >= 1)
    await c.drop('host', 1500, async () => {
      c.master.master!.auth.signOut(away.token)
    })
    await c.until(
      () => relays() === before - 1 || undefined,
      10_000,
      'the relay session to end',
    )
    // A session that ends without the host hearing of it (the notice was
    // lost, or the master restarted before the host came back): the host's
    // next sync lists the master's live sessions, which no longer include it
    // (review 4.2).
    const lost = onMaster('tess')
    await request(c.master, '/apps', { cookie: lost.cookie })
    const kept = onMaster('tess')
    await request(c.master, '/apps', { cookie: kept.cookie })
    const relayed = relays()
    c.master
      .master!.database.db.prepare('DELETE FROM master_sessions WHERE hash=?')
      .run(createHash('sha256').update(lost.token).digest('hex'))
    assert.equal(relays(), relayed)
    await c.drop('host', 500)
    await c.until(
      () => relays() === relayed - 1 || undefined,
      10_000,
      'the relay session to end at the next sync',
    )
    assert.equal(
      (await request(c.master, '/apps', { cookie: kept.cookie })).status,
      200,
      'a live session keeps its relay session',
    )
    assert.equal(relays(), relayed - 1)
  })

  it('selects a device on the master only when it is the person’s, and the branch page and Install follow it', async () => {
    const tess = onMaster('tess')
    const own = await request(c.master, `/devices/${devices.tess}/select`, {
      cookie: tess.cookie,
      form: { csrf: tess.csrf },
    })
    assert.equal(own.status, 303)
    assert.equal(own.headers.get('location'), '/devices')
    assert.match(
      own.headers.get('set-cookie')!,
      new RegExp(`^${DEVICE_COOKIE}=${devices.tess}; .*HttpOnly; Secure`),
    )
    // Another account's device: refused, and no cookie.
    const other = await request(c.master, `/devices/${devices.nora}/select`, {
      cookie: tess.cookie,
      form: { csrf: tess.csrf },
    })
    assert.equal(other.status, 404)
    assert.match(other.text, /Device unavailable/)
    assert.equal(other.headers.get('set-cookie'), null)
    // A form without the session's proof.
    assert.equal(
      (
        await request(c.master, `/devices/${devices.tess}/select`, {
          cookie: tess.cookie,
          form: { csrf: 'wrong' },
        })
      ).status,
      400,
    )
    const branch = `/apps/${apps[ALPHA]}/branches/${branchKey('master')}?platform=ios`
    // With Nora's device in the cookie the page offers registration, as with none.
    const forged = await request(c.master, branch, {
      cookie: `${tess.cookie}; ${DEVICE_COOKIE}=${devices.nora}`,
    })
    assert.match(forged.text, /aria-label="Register Device for 1\.0 build 2"/)
    assert.doesNotMatch(forged.text, /itms-services/)
    const none = await request(c.master, `/builds/${builds.ipa}/install`, {
      cookie: tess.cookie,
      form: { csrf: tess.csrf },
    })
    assert.equal(none.status, 409)
    assert.match(none.text, /Register or select your iPhone or iPad/)
    // With hers: Install for the build she is in; the other is refused.
    const device = `; ${DEVICE_COOKIE}=${devices.tess}`
    const page = await request(c.master, branch, {
      cookie: tess.cookie + device,
    })
    assert.match(page.text, /aria-label="Install 1\.0 build 2"/)
    const refused = await request(c.master, `/builds/${builds.stale}/install`, {
      cookie: tess.cookie + device,
      form: { csrf: tess.csrf },
    })
    assert.equal(refused.status, 409)
    assert.match(
      refused.text,
      new RegExp(
        `<form method="post" action="/builds/${builds.stale}/prepare">`,
      ),
    )
    const installed = await request(c.master, `/builds/${builds.ipa}/install`, {
      cookie: tess.cookie + device,
      form: { csrf: tess.csrf },
    })
    assert.equal(installed.status, 200)
    assert.match(
      installed.text,
      new RegExp(
        `href="itms-services://\\?action=download-manifest&amp;url=${encodeURIComponent(MASTER_ORIGIN)}%2Finstall%2F[A-Za-z0-9_-]{43}%2Fmanifest\\.plist"`,
      ),
    )
    assert.match(installed.text, /src="\/assets\/catalog\.js"/)
    // The Devices page lists what the host has for her, with hers selected.
    const list = await request(c.master, '/devices', {
      cookie: tess.cookie + device,
    })
    assert.equal(list.status, 200)
    assert.match(list.text, /iPhone of tess/)
    assert.doesNotMatch(list.text, /iPhone of nora/)
    assert.match(list.text, /Selected device/)
    assert.match(
      (await request(host, '/devices', { cookie: onHost('tess').cookie })).text,
      /iPhone of tess/,
    )
    // Removing the selected device clears the cookie; the device stays hers until the master hears it.
    const rename = await request(c.master, `/devices/${devices.tess}/rename`, {
      cookie: tess.cookie,
      form: { csrf: tess.csrf, name: 'Tess phone' },
    })
    assert.equal(rename.status, 303)
    await c.until(
      () =>
        (
          db()
            .prepare('SELECT name FROM account_devices WHERE device_id=?')
            .get(devices.tess!) as Json
        ).name === 'Tess phone',
      5000,
      'the rename on the master',
    )
    assert.equal(
      (
        await request(c.master, `/devices/${devices.tess}/dance`, {
          cookie: tess.cookie,
          form: { csrf: tess.csrf },
        })
      ).status,
      404,
    )
  })

  it('reaches the host with Prepare for this device from the master', async () => {
    const tess = onMaster('tess')
    const device = `; ${DEVICE_COOKIE}=${devices.tess}`
    const prepared = await request(
      c.master,
      `/builds/${builds.stale}/prepare`,
      {
        cookie: tess.cookie + device,
        form: { csrf: tess.csrf },
      },
    )
    assert.equal(prepared.status, 200, prepared.text)
    assert.match(prepared.text, /Preparing build/)
    await c.until(
      () =>
        db()
          .prepare(
            'SELECT 1 FROM device_build_requests WHERE account_id=? AND device_id=? AND build_id=?',
          )
          .get(people.tess!, devices.tess!, builds.stale!),
      5000,
      'the prepare request on the master',
    )
    // Without a device, or with another's, it goes to Devices.
    for (const cookie of ['', `; ${DEVICE_COOKIE}=${devices.nora}`]) {
      const reply = await request(c.master, `/builds/${builds.stale}/prepare`, {
        cookie: tess.cookie + cookie,
        form: { csrf: tess.csrf },
      })
      assert.equal(reply.status, 303)
      assert.equal(reply.headers.get('location'), '/devices')
    }
  })

  it('registers a device from the master: the callback returns to the master, and the device appears on the host', async () => {
    const tess = onMaster('tess')
    const profile = await request(c.master, '/devices/profile', {
      cookie: tess.cookie,
      form: { csrf: tess.csrf },
    })
    assert.equal(profile.status, 200, profile.text)
    assert.equal(
      profile.headers.get('content-type'),
      'application/x-apple-aspen-config; charset=utf-8',
    )
    const token = /<key>Challenge<\/key><string>([^<]+)<\/string>/.exec(
      profile.text,
    )![1]!
    // The profile carries the host's callback: devices live on the host.
    assert.match(
      profile.text,
      new RegExp(`<string>${url(host)}/devices/callback/${token}</string>`),
    )
    assert.equal(
      (
        host
          .host!.cache.db.prepare(
            'SELECT return_origin FROM device_challenges WHERE hash=?',
          )
          .get(digest(token)) as Json
      ).return_origin,
      MASTER_ORIGIN,
    )
    const callback = await request(host, `/devices/callback/${token}`, {
      method: 'POST',
      body: signed(token, udidNew),
    })
    assert.equal(callback.status, 301, callback.text)
    assert.equal(
      callback.headers.get('location'),
      `${MASTER_ORIGIN}/devices/complete/${token}`,
    )
    const waiting = await request(c.master, `/devices/complete/${token}`, {
      cookie: tess.cookie,
    })
    assert.equal(waiting.status, 200)
    assert.match(waiting.text, /Registering device|Device registered/)
    const id = await c.until(
      () =>
        (
          host
            .host!.cache.db.prepare(
              'SELECT d.id FROM devices d JOIN account_devices a ON a.device_id=d.id WHERE d.udid=? AND a.account_id=?',
            )
            .get(udidNew, people.tess!) as Json
        )?.id as number | undefined,
      10_000,
      'the device on the host',
    )
    const done = await request(c.master, `/devices/complete/${token}`, {
      cookie: tess.cookie,
    })
    assert.match(done.text, /Device registered/)
    assert.match(
      done.headers.get('set-cookie')!,
      new RegExp(`^${DEVICE_COOKIE}=${id}; `),
    )
    assert.match(
      (await request(host, '/devices', { cookie: onHost('tess').cookie })).text,
      new RegExp(udidNew),
    )
    // Another person's registration link is not hers.
    assert.equal(
      (
        await request(c.master, `/devices/complete/${token}`, {
          cookie: onMaster('nora').cookie,
        })
      ).status,
      410,
    )
    const qr = await request(c.master, '/devices/qr', { cookie: tess.cookie })
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8')
  })

  it('without a public master address, links iOS installs and registration to the host', async () => {
    await setOrigin('')
    try {
      const tess = onMaster('tess')
      const device = `; ${DEVICE_COOKIE}=${devices.tess}`
      const page = await request(
        c.master,
        `/apps/${apps[ALPHA]}/branches/${branchKey('master')}?platform=ios`,
        { cookie: tess.cookie + device },
      )
      assert.match(
        page.text,
        new RegExp(
          `<a id="build-${builds.ipa}" class="list-row build-row" aria-label="Install on the host 1\\.0 build 2" href="${url(host)}/apps/${apps[ALPHA]}/branches/${branchKey('master')}\\?platform=ios">`,
        ),
      )
      assert.match(
        page.text,
        /go through the host until the master has a public address/,
      )
      assert.doesNotMatch(page.text, /itms-services/)
      // An Android build still downloads from the master.
      const android = await request(
        c.master,
        `/apps/${apps[ALPHA]}/branches/${branchKey('master')}?platform=android`,
        { cookie: tess.cookie },
      )
      assert.match(android.text, /action="\/builds\/\d+\/install"/)
      const list = await request(c.master, '/devices', { cookie: tess.cookie })
      assert.match(
        list.text,
        new RegExp(
          `<a class="button register-device" href="${url(host)}/devices">Register on the host</a>`,
        ),
      )
      assert.doesNotMatch(list.text, /action="\/devices\/profile"/)
    } finally {
      await setOrigin(MASTER_ORIGIN)
    }
  })

  it('loads the catalog script on the master under its CSP', async () => {
    const tess = onMaster('tess')
    const page = await request(c.master, `/apps/${apps[ALPHA]}`, {
      cookie: tess.cookie,
    })
    assert.match(
      page.text,
      /<script type="module" src="\/assets\/catalog\.js">/,
    )
    assert.match(
      page.headers.get('content-security-policy')!,
      /script-src 'self'[;]/,
    )
    const script = await request(c.master, '/assets/catalog.js')
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type')!, /javascript/)
    assert.match(script.text, /mason-platform/)
  })

  it('gives a tester on the master app results that open Install apps, and no projects', async () => {
    const tess = onMaster('tess')
    const results = JSON.parse(
      (await request(c.master, '/search?q=alpha', { cookie: tess.cookie }))
        .text,
    ) as Json[]
    assert.deepEqual(
      results.map((result) => [result.kind, result.href]),
      [['app', `/apps/${apps[ALPHA]}`]],
    )
    assert.deepEqual(
      JSON.parse(
        (await request(c.master, '/search?q=relay', { cookie: tess.cookie }))
          .text,
      ),
      [],
    )
  })

  it('drops the relay session with a permission change, and never accepts one as a host cookie', async () => {
    const tess = onMaster('tess')
    await request(c.master, '/apps', { cookie: tess.cookie })
    const cache = host.host!.cache.db
    const relays = (): number =>
      Number(
        cache
          .prepare(
            'SELECT COUNT(*) n FROM sessions WHERE account_id=? AND relayed=1',
          )
          .get(people.nora!)!.n,
      )
    await request(c.master, '/apps', { cookie: onMaster('nora').cookie })
    // One relay session for each of her master sessions that used the pages.
    assert(relays() >= 1)
    // A relay session whose hash a browser could present is still refused.
    const token = 'R'.repeat(43)
    cache
      .prepare(
        "INSERT INTO sessions(hash,account_id,permission_version,csrf,created_at,expires_at,relayed) SELECT ?,id,permission_version,'c',0,?,1 FROM accounts WHERE id=?",
      )
      .run(digest(token), Date.now() + 3_600_000, people.nora!)
    assert.equal(host.host!.accounts.session(token), undefined)
    assert(host.host!.accounts.sessionHash(digest(token)) != null)
    const refused = await request(host, '/apps', {
      cookie: `${SESSION_COOKIE}=${token}`,
    })
    assert.equal(refused.status, 303)
    assert.match(refused.headers.get('location')!, /^\/auth\/login/)
    // A permission change on the master ends Nora's relay sessions on the host.
    db()
      .prepare(
        'UPDATE accounts SET permission_version=permission_version+1 WHERE id=?',
      )
      .run(people.nora!)
    c.master.master!.database.change('account', people.nora!)
    await c.until(() => relays() === 0, 5000, 'the relay sessions to end')
    // A master session newer than the host's copy of the account: the host
    // catches up first, and says so when the master has not sent it yet.
    db()
      .prepare(
        'UPDATE accounts SET permission_version=permission_version+1 WHERE id=?',
      )
      .run(people.nora!)
    const ahead = onMaster('nora')
    const lagging = await request(c.master, '/apps', { cookie: ahead.cookie })
    assert.equal(lagging.status, 503)
    assert.match(lagging.text, /catching up with the master/)
    c.master.master!.database.change('account', people.nora!)
    const caught = await request(c.master, '/apps', { cookie: ahead.cookie })
    assert.equal(caught.status, 200, caught.text.slice(0, 300))
    // A relay request naming no master session is refused.
    const answer = (await c.master
      .master!.hosts.askHost('catalog.apps', { accountId: people.tess! })
      .catch((error: Error) => error)) as Json
    assert.deepEqual(answer, {
      refused: { status: 400, message: 'A master session is required' },
    })
  })

  it('shows “The host is unreachable” (503) while the host is away', async () => {
    const tess = onMaster('tess')
    await c.drop('host', 0, async () => {
      for (const route of ['/apps', '/devices', `/apps/${apps[ALPHA]}`]) {
        const reply = await request(c.master, route, { cookie: tess.cookie })
        assert.equal(reply.status, 503, route)
        assert.match(reply.text, /The host is unreachable/)
        assert.match(reply.text, /aria-label="Your account"/)
      }
      const file = await request(
        c.master,
        `/install/${'A'.repeat(43)}/artifact`,
      )
      assert.equal(file.status, 503)
    })
  })

  it('migrates a host cache at host schema v11 to distribution user_version 9', () => {
    const dir = path.join(root, 'old-host')
    const cache = new HostCache(dir)
    cache.db.exec(`ALTER TABLE sessions DROP COLUMN relayed;
      ALTER TABLE device_challenges DROP COLUMN return_origin;
      PRAGMA user_version=8;`)
    cache.close()
    const reopened = new HostCache(dir)
    try {
      assert.equal(
        (reopened.db.prepare('PRAGMA user_version').get() as Json).user_version,
        9,
      )
      assert.equal(
        (
          reopened.db
            .prepare("SELECT value FROM host_meta WHERE key='host_schema'")
            .get() as Json
        ).value,
        '11',
      )
      for (const [table, column] of [
        ['sessions', 'relayed'],
        ['device_challenges', 'return_origin'],
      ])
        assert(
          (
            reopened.db.prepare(`PRAGMA table_info(${table})`).all() as Json[]
          ).some((entry) => entry.name === column),
          column,
        )
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
