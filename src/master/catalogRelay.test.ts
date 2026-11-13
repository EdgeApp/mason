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
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { after, before, describe, it } from 'mocha'
import { SESSION_COOKIE } from '../auth/routes.js'
import { branchKey } from '../catalog/platform.js'
import {
  catalogShellRoutes,
  catalogStatus,
  type CatalogShellOptions,
} from '../catalog/shell.js'
import { CatalogRefused, type CatalogSource } from '../catalog/source.js'
import { DEVICE_COOKIE } from '../devices/store.js'
import { HOST_UNREACHABLE_ERROR } from '../shared/api/index.js'
import { assertShell } from '../test/webShell.js'
import { HostCache } from '../host/cache.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { digest, insertBuild } from '../store.js'
import { cluster, type Cluster } from '../test/cluster.js'
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
      body?: Uint8Array
    } = {},
  ): Promise<Reply> => {
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
    return {
      status: response.status,
      text: body.toString(),
      body,
      headers: response.headers,
    }
  }
  /**
   * A JSON call as the web app makes it: a change carries the session's
   * proof in its header, from the node's own origin.
   */
  const api = async (
    node: RunningNode,
    method: 'GET' | 'POST',
    route: string,
    who: { cookie: string; csrf: string },
    extra = '',
    body?: unknown,
  ): Promise<Reply & { json: Json }> => {
    const reply = await request(node, route, {
      method,
      cookie: who.cookie + extra,
      headers:
        method === 'GET'
          ? {}
          : {
              origin:
                node === host
                  ? host.host!.cache.store.config.origin
                  : url(node),
              'x-mason-csrf': who.csrf,
              ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
            },
      ...(body === undefined
        ? {}
        : { body: new TextEncoder().encode(JSON.stringify(body)) }),
    })
    let json: Json
    try {
      json = JSON.parse(reply.text)
    } catch {
      json = undefined
    }
    return { ...reply, json }
  }
  /** A branch's JSON, as the web app reads it. */
  const branchOf = async (
    node: RunningNode,
    who: { cookie: string; csrf: string },
    platform: string,
    extra = '',
    app = ALPHA,
  ): Promise<Json> => {
    const reply = await api(
      node,
      'GET',
      `/api/v2/catalog/apps/${apps[app]}/branches/${branchKey('master')}?platform=${platform}`,
      who,
      extra,
    )
    assert.equal(reply.status, 200, reply.text)
    return reply.json
  }
  /** A build's row in a branch's JSON. */
  const row = (branch: Json, id: number): Json =>
    (branch.builds as Json[]).find((build) => build.id === id)
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
    // Her home and Install apps are the web app's, which reads the apps as JSON.
    assertShell(
      await request(c.master, '/?platform=android', { cookie: tess.cookie }),
    )
    assertShell(
      await request(c.master, '/apps?platform=android', {
        cookie: tess.cookie,
      }),
    )
    // Signed out, each page asks for a sign-in.
    for (const route of [
      '/apps',
      `/apps/${apps[ALPHA]}`,
      '/devices',
      '/devices/qr',
      `/devices/complete/${'A'.repeat(43)}`,
    ]) {
      const signedOut = await request(c.master, route)
      assert.equal(signedOut.status, 303, route)
      assert.equal(signedOut.headers.get('location'), '/sign-in', route)
    }
    const list = await api(c.master, 'GET', '/api/v2/catalog/apps', tess)
    assert.equal(list.status, 200, list.text)
    const onHostList = await api(
      host,
      'GET',
      '/api/v2/catalog/apps',
      onHost('tess'),
    )
    assert.deepEqual(list.json, onHostList.json)
    assert.deepEqual(
      (list.json.apps as Json[]).map((app) => app.id),
      [apps[ALPHA]],
    )
    assert.deepEqual(list.json.platforms, ['android', 'ios'])
    // The relay session the host keeps for it never signs a browser in.
    const relay = host
      .host!.cache.db.prepare(
        'SELECT relayed FROM sessions WHERE account_id=? AND relayed=1',
      )
      .get(people.tess!) as Json
    assert.equal(relay.relayed, 1)
  })

  it('M7 answers a tester’s Install apps and Devices with the web app’s shell on both nodes; to her /projects does not exist', async () => {
    const device = `; ${DEVICE_COOKIE}=${devices.tess}`
    const branch = `/apps/${apps[ALPHA]}/branches/${branchKey('master')}?platform=ios`
    for (const [node, who] of [
      [c.master, onMaster('tess')],
      [host, onHost('tess')],
    ] as const) {
      const name = node === host ? 'host' : 'master'
      // The side menu, the breadcrumbs and the account button are the web
      // app's; each address answers its shell.
      for (const route of [
        '/',
        '/apps',
        `/apps/${apps[ALPHA]}`,
        branch,
        '/devices',
      ]) {
        const reply = await request(node, route, {
          cookie: who.cookie + device,
        })
        assertShell(reply)
      }
      // Install answers the installer's link on the node's own address.
      const installed = await api(
        node,
        'POST',
        `/api/v2/catalog/builds/${builds.ipa}/install`,
        who,
        device,
      )
      assert.equal(installed.status, 200, `${name}: ${installed.text}`)
      assert.equal(installed.json.kind, 'itms', name)
      assert.match(
        installed.json.url,
        /^itms-services:\/\/\?action=download-manifest&url=/,
        name,
      )
      for (const route of [
        '/projects',
        '/projects/relay',
        '/projects/relay/runs',
        '/projects/relay/masonfile',
      ]) {
        assertShell(await request(node, route, { cookie: who.cookie }), 404)
      }
    }
    assertShell(
      await request(c.master, '/projects/new', {
        cookie: onMaster('tess').cookie,
      }),
      404,
    )
    // A developer reads the wizard's 403 inside the web app.
    assertShell(
      await request(c.master, '/projects/new', {
        cookie: onMaster('dev').cookie,
      }),
      403,
    )
  })

  it('M7 lands developers on Projects & apps on the master and on Install apps on the host', async () => {
    for (const [node, who] of [
      [c.master, onMaster('dev')],
      [host, onHost('dev')],
    ] as const) {
      const name = node === host ? 'host' : 'master'
      // Both homes are the web app's: Projects & apps on the master,
      // Install apps (which lists every app to a developer) on the host.
      assertShell(await request(node, '/', { cookie: who.cookie }))
      if (node === host)
        assert.deepEqual(
          (
            (await api(node, 'GET', '/api/v2/catalog/apps', who)).json
              .apps as Json[]
          ).map((app) => app.id),
          [apps[ALPHA], apps[BETA]],
          name,
        )
      // Projects & apps is the web app's on both nodes, filters and all.
      const projects = await request(node, '/projects?platform=android', {
        cookie: who.cookie,
      })
      assertShell(projects)
      // A project's pages are the web app's too.
      for (const route of [
        '/projects/relay',
        '/projects/relay/runs',
        '/projects/relay/masonfile',
      ])
        assertShell(await request(node, route, { cookie: who.cookie }))
      assertShell(
        await request(node, '/projects/none', { cookie: who.cookie }),
        404,
      )
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
    ])
      for (const [node, session] of [
        [c.master, tess],
        [host, onHost('tess')],
      ] as const) {
        // The page's shell carries the status; its JSON says why.
        assertShell(await request(node, route, { cookie: session.cookie }), 404)
        const reply = await api(node, 'GET', `/api/v2/catalog${route}`, session)
        assert.equal(reply.status, 404, route)
        assert.deepEqual(reply.json, { error: 'App unavailable' }, route)
      }
    // An install or a device rebuild of that app's build is refused too, on
    // both nodes, and nothing is queued for it.
    const device = `; ${DEVICE_COOKIE}=${devices.tess}`
    for (const [node, session] of [
      [c.master, tess],
      [host, onHost('tess')],
    ] as const)
      for (const action of ['install', 'prepare']) {
        const reply = await api(
          node,
          'POST',
          `/api/v2/catalog/builds/${builds.beta}/${action}`,
          session,
          device,
        )
        assert.equal(
          reply.status,
          404,
          `${action}: ${reply.text.slice(0, 200)}`,
        )
        assert.deepEqual(reply.json, { error: 'App unavailable' })
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
    // An Android build installs by download: no grant until Install.
    const branch = await branchOf(c.master, tess, 'android')
    const apk = row(branch, builds.apk!)
    assert.deepEqual(
      [apk.eligible, apk.token, apk.installUrl],
      [true, undefined, undefined],
    )
    const install = await api(
      c.master,
      'POST',
      `/api/v2/catalog/builds/${builds.apk}/install`,
      tess,
    )
    assert.equal(install.status, 200, install.text)
    assert.equal(install.json.kind, 'download')
    const artifact = install.json.url as string
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
    const page = await branchOf(c.master, tess, 'ios', device)
    assert.deepEqual([page.ios, page.device], [{ via: 'here' }, true])
    const ipa = row(page, builds.ipa!)
    const href = /^itms-services:\/\/\?action=download-manifest&url=(.+)$/.exec(
      ipa.installUrl,
    )
    assert(href != null, ipa.installUrl)
    const manifestUrl = decodeURIComponent(href[1]!)
    const token = new RegExp(
      `^${MASTER_ORIGIN}/install/([A-Za-z0-9_-]{43})/manifest\\.plist$`,
    ).exec(manifestUrl)?.[1]
    assert(token != null, manifestUrl)
    assert.equal(ipa.token, token)
    // The build the device is not in has no grant: the web app offers Prepare.
    const stale = row(page, builds.stale!)
    assert.deepEqual(
      [stale.eligible, stale.token, stale.installUrl],
      [false, undefined, undefined],
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
    const bytes = await request(c.master, `/install/${token}/artifact`)
    assert.equal(sha(bytes.body), sha(files.ipa))
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
    const own = await api(
      c.master,
      'POST',
      `/api/v2/devices/${devices.tess}/select`,
      tess,
    )
    assert.equal(own.status, 200, own.text)
    assert.equal(own.json.selected, devices.tess)
    assert.match(
      own.headers.get('set-cookie')!,
      new RegExp(`^${DEVICE_COOKIE}=${devices.tess}; .*HttpOnly; Secure`),
    )
    // Another account's device: refused, and no cookie.
    const other = await api(
      c.master,
      'POST',
      `/api/v2/devices/${devices.nora}/select`,
      tess,
    )
    assert.equal(other.status, 404)
    assert.deepEqual(other.json, { error: 'Device unavailable' })
    assert.equal(other.headers.get('set-cookie'), null)
    // A request without the session's proof.
    const unproven = await api(
      c.master,
      'POST',
      `/api/v2/devices/${devices.tess}/select`,
      { ...tess, csrf: 'wrong' },
    )
    assert.equal(unproven.status, 403)
    assert.equal(unproven.headers.get('set-cookie'), null)
    // With Nora's device in the cookie the branch offers registration, as with none.
    const forged = await branchOf(
      c.master,
      tess,
      'ios',
      `; ${DEVICE_COOKIE}=${devices.nora}`,
    )
    assert.equal(forged.device, false)
    for (const build of forged.builds as Json[])
      assert.deepEqual(
        [build.eligible, build.token, build.installUrl],
        [false, undefined, undefined],
      )
    const none = await api(
      c.master,
      'POST',
      `/api/v2/catalog/builds/${builds.ipa}/install`,
      tess,
    )
    assert.deepEqual(none.json, { kind: 'register' })
    // With hers: Install for the build she is in; the other is to prepare.
    const device = `; ${DEVICE_COOKIE}=${devices.tess}`
    const page = await branchOf(c.master, tess, 'ios', device)
    assert.equal(row(page, builds.ipa!).eligible, true)
    const refused = await api(
      c.master,
      'POST',
      `/api/v2/catalog/builds/${builds.stale}/install`,
      tess,
      device,
    )
    assert.deepEqual(refused.json, { kind: 'prepare', buildId: builds.stale })
    const installed = await api(
      c.master,
      'POST',
      `/api/v2/catalog/builds/${builds.ipa}/install`,
      tess,
      device,
    )
    assert.equal(installed.status, 200)
    assert.equal(installed.json.kind, 'itms')
    assert.match(
      installed.json.url,
      new RegExp(
        `^itms-services://\\?action=download-manifest&url=${encodeURIComponent(MASTER_ORIGIN)}%2Finstall%2F[A-Za-z0-9_-]{43}%2Fmanifest\\.plist$`,
      ),
    )
    assert.equal(typeof installed.json.expiresAt, 'number')
    // Devices lists what the host has for her, with hers selected.
    assertShell(await request(c.master, '/devices', { cookie: tess.cookie }))
    const list = await api(c.master, 'GET', '/api/v2/devices', tess, device)
    assert.equal(list.status, 200, list.text)
    const names = (list.json.devices as Json[]).map((entry) => entry.name)
    assert(names.includes('iPhone of tess'), names.join())
    assert(!names.includes('iPhone of nora'), names.join())
    assert.equal(list.json.selected, devices.tess)
    assert.equal(list.json.registration, true)
    assert.equal(list.json.via, undefined)
    assert(
      (
        (await api(host, 'GET', '/api/v2/devices', onHost('tess'))).json
          .devices as Json[]
      ).some((entry) => entry.name === 'iPhone of tess'),
    )
    // A rename reaches the master.
    const rename = await api(
      c.master,
      'POST',
      `/api/v2/devices/${devices.tess}/rename`,
      tess,
      device,
      { name: 'Tess phone' },
    )
    assert.equal(rename.status, 200, rename.text)
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
        await api(
          c.master,
          'POST',
          `/api/v2/devices/${devices.tess}/dance`,
          tess,
        )
      ).status,
      404,
    )
  })

  it('reaches the host with Prepare for this device from the master', async () => {
    const tess = onMaster('tess')
    const device = `; ${DEVICE_COOKIE}=${devices.tess}`
    const prepared = await api(
      c.master,
      'POST',
      `/api/v2/catalog/builds/${builds.stale}/prepare`,
      tess,
      device,
    )
    assert.equal(prepared.status, 200, prepared.text)
    assert.deepEqual(prepared.json, { prepared: true })
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
    // Without a device, or with another's, nothing is prepared: the web
    // app sends her to Devices.
    for (const cookie of ['', `; ${DEVICE_COOKIE}=${devices.nora}`]) {
      const reply = await api(
        c.master,
        'POST',
        `/api/v2/catalog/builds/${builds.stale}/prepare`,
        tess,
        cookie,
      )
      assert.equal(reply.status, 200, reply.text)
      assert.deepEqual(reply.json, { prepared: false })
    }
  })

  it('registers a device from the master: the callback returns to the master, and the device appears on the host', async () => {
    const tess = onMaster('tess')
    // Registering answers a profile to download once, the way the web app
    // hands it to the iPhone.
    const made = await api(
      c.master,
      'POST',
      '/api/v2/devices/registrations',
      tess,
    )
    assert.equal(made.status, 200, made.text)
    assert.match(made.json.url, /^\/devices\/profiles\/[A-Za-z0-9_-]{43}$/)
    const profile = await request(c.master, made.json.url)
    assert.equal(profile.status, 200, profile.text)
    assert.equal((await request(c.master, made.json.url)).status, 404)
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
    // The completion link answers the shell; its JSON says how far it is.
    assertShell(
      await request(c.master, `/devices/complete/${token}`, {
        cookie: tess.cookie,
      }),
    )
    assert.match(
      (await api(c.master, 'GET', `/api/v2/devices/complete/${token}`, tess))
        .json.state,
      /^(registering|registered)$/,
    )
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
    // Once registered, the link selects the device, then answers the shell.
    const done = await request(c.master, `/devices/complete/${token}`, {
      cookie: tess.cookie,
    })
    assertShell(done)
    assert.match(
      done.headers.get('set-cookie')!,
      new RegExp(`^${DEVICE_COOKIE}=${id}; .*HttpOnly; Secure`),
    )
    const registered = await api(
      c.master,
      'GET',
      `/api/v2/devices/complete/${token}`,
      tess,
    )
    assert.equal(registered.json.state, 'registered')
    assert.equal(registered.json.device.id, id)
    assert(
      (
        (await api(host, 'GET', '/api/v2/devices', onHost('tess'))).json
          .devices as Json[]
      ).some((entry) => entry.udid === udidNew),
    )
    // Another person's registration link is not hers.
    const nora = onMaster('nora')
    const unavailable = await request(c.master, `/devices/complete/${token}`, {
      cookie: nora.cookie,
    })
    assertShell(unavailable, 410)
    assert.equal(unavailable.headers.get('set-cookie'), null)
    assert.deepEqual(
      (await api(c.master, 'GET', `/api/v2/devices/complete/${token}`, nora))
        .json,
      { state: 'unavailable' },
    )
    // The QR code opens Devices on the master's public address.
    const qr = await request(c.master, '/devices/qr', { cookie: tess.cookie })
    assert.equal(qr.status, 200)
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8')
    assert.match(qr.text, /^<svg /)
  })

  it('without a public master address, links iOS installs and registration to the host', async () => {
    await setOrigin('')
    try {
      const tess = onMaster('tess')
      const device = `; ${DEVICE_COOKIE}=${devices.tess}`
      // iOS installs go through the host's own pages: no installer link here.
      const page = await branchOf(c.master, tess, 'ios', device)
      assert.deepEqual(page.ios, { via: 'host', host: url(host) })
      assert.equal(row(page, builds.ipa!).eligible, true)
      for (const build of page.builds as Json[])
        assert.equal(build.installUrl, undefined)
      // An Android build still downloads from the master.
      const android = await branchOf(c.master, tess, 'android')
      assert.deepEqual(android.ios, { via: 'host', host: url(host) })
      const download = await api(
        c.master,
        'POST',
        `/api/v2/catalog/builds/${builds.apk}/install`,
        tess,
      )
      assert.equal(download.json.kind, 'download')
      assert.match(
        download.json.url,
        /^\/install\/[A-Za-z0-9_-]{43}\/artifact$/,
      )
      // Devices register on the host, and its QR code opens the host's Devices.
      const list = await api(c.master, 'GET', '/api/v2/devices', tess)
      assert.equal(list.json.via, url(host))
      const qr = await request(c.master, '/devices/qr', { cookie: tess.cookie })
      assert.equal(qr.status, 200)
    } finally {
      await setOrigin(MASTER_ORIGIN)
    }
  })

  it('answers Install apps with the web app’s shell under its CSP, and plain statuses for what it cannot show', async () => {
    const tess = onMaster('tess')
    // The shell carries the web app's policy; the old catalog script is gone.
    assertShell(
      await request(c.master, `/apps/${apps[ALPHA]}`, { cookie: tess.cookie }),
    )
    // An id that names nothing is a 404, as its JSON is.
    for (const route of ['/apps/nope', '/apps/0']) {
      assertShell(await request(c.master, route, { cookie: tess.cookie }), 404)
      assert.equal(
        (await api(c.master, 'GET', `/api/v2/catalog${route}`, tess)).status,
        404,
        route,
      )
    }
    // So is a branch key that is no key; its JSON refuses the request.
    const key = `/apps/${apps[ALPHA]}/branches/not*a*key`
    assertShell(await request(c.master, key, { cookie: tess.cookie }), 404)
    assert.deepEqual(
      (await api(c.master, 'GET', `/api/v2/catalog${key}`, tess)).json,
      { error: 'Invalid branch key' },
    )
  })

  it('gives a tester on the master app results that open Install apps, and no projects', async () => {
    const tess = onMaster('tess')
    const results = JSON.parse(
      (
        await request(c.master, '/api/v2/search?q=alpha', {
          cookie: tess.cookie,
        })
      ).text,
    ) as Json[]
    assert.deepEqual(
      results.map((result) => [result.kind, result.href]),
      [['app', `/apps/${apps[ALPHA]}`]],
    )
    assert.deepEqual(
      JSON.parse(
        (
          await request(c.master, '/api/v2/search?q=relay', {
            cookie: tess.cookie,
          })
        ).text,
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
    assertShell(await request(c.master, '/apps', { cookie: ahead.cookie }), 503)
    const lagging = await api(c.master, 'GET', '/api/v2/catalog/apps', ahead)
    assert.equal(lagging.status, 503)
    assert.match(lagging.json.error, /catching up with the master/)
    c.master.master!.database.change('account', people.nora!)
    assertShell(await request(c.master, '/apps', { cookie: ahead.cookie }))
    // A relay request naming no master session is refused.
    const answer = (await c.master
      .master!.hosts.askHost('catalog.apps', { accountId: people.tess! })
      .catch((error: Error) => error)) as Json
    assert.deepEqual(answer, {
      refused: { status: 400, message: 'A master session is required' },
    })
  })

  it('answers 503, the host unreachable, while the host is away', async () => {
    const tess = onMaster('tess')
    await c.drop('host', 0, async () => {
      // Each page's shell carries the 503; its JSON says why.
      for (const route of [
        '/apps',
        '/devices',
        `/apps/${apps[ALPHA]}`,
        `/devices/complete/${'A'.repeat(43)}`,
      ])
        assertShell(
          await request(c.master, route, { cookie: tess.cookie }),
          503,
        )
      for (const route of [
        '/api/v2/catalog/apps',
        `/api/v2/catalog/apps/${apps[ALPHA]}`,
        '/api/v2/devices',
      ]) {
        const reply = await api(c.master, 'GET', route, tess)
        assert.equal(reply.status, 503, route)
        assert.deepEqual(reply.json, { error: HOST_UNREACHABLE_ERROR }, route)
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

describe('Install apps and Devices addresses on any node', function () {
  // The shell's routes over a source that fails as a node's can: a person
  // who may not register, a refusal, a failure the node knows, and one it
  // does not.
  let server: Server
  let base = ''
  let mayRegister = true
  let failure: Error | undefined
  let known: number | undefined
  const options: CatalogShellOptions = {
    caller: (req) =>
      req.get('cookie') == null
        ? undefined
        : {
            accountId: 1,
            source: source as CatalogSource,
            checkCsrf: () => undefined,
            mayRegister,
            registration: true,
          },
    signIn: (req) => `/sign-in?return=${encodeURIComponent(req.originalUrl)}`,
    files: () => source as CatalogSource,
    qr: () => 'https://node.example.test/devices',
    failure: () => known,
  }
  /** The pages' statuses, as a node's page routes answer them. */
  const pages =
    (subject: 'catalog' | 'devices'): express.RequestHandler =>
    (req, res, next) => {
      catalogStatus(options, subject, req).then((answer) => {
        if (typeof answer === 'number')
          res.status(answer).type('text/plain').send('shell')
        else res.redirect(303, answer.redirect)
      }, next)
    }
  const fail = async (): Promise<never> => {
    throw failure ?? new Error('Nothing here')
  }
  const source: Partial<CatalogSource> = {
    apps: fail,
    app: fail,
    devices: fail,
    complete: fail,
    installFile: async (_token, part, _request, res) => {
      if (part === 'manifest.plist') {
        res.status(200).type('application/xml')
        res.write('<?xml')
        throw new Error('The stream broke')
      }
      await fail()
    },
  }
  const get = async (
    route: string,
    signedIn = true,
  ): Promise<{ status: number; text: string; location: string | null }> => {
    const reply = await fetch(base + route, {
      redirect: 'manual',
      headers: signedIn ? { cookie: 'session=1' } : {},
    })
    return {
      status: reply.status,
      text: await reply.text(),
      location: reply.headers.get('location'),
    }
  }

  before(async () => {
    const app = express()
    app.use(catalogShellRoutes(options))
    app.get(
      ['/apps', '/apps/:appId', '/apps/:appId/branches/:branchKey'],
      pages('catalog'),
    )
    app.get('/devices', pages('devices'))
    // The server's own error, without its stack on the console.
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).send('Server error')
      },
    )
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    server?.close()
  })

  it('sends a signed-out person to sign in, back to the address', async () => {
    const reply = await get('/apps/1', false)
    assert.deepEqual(
      [reply.status, reply.location],
      [303, '/sign-in?return=%2Fapps%2F1'],
    )
  })

  it('answers 403 at Devices, its completion link and its QR code to someone who may not register', async () => {
    mayRegister = false
    try {
      assert.deepEqual(await get('/devices'), {
        status: 403,
        text: 'shell',
        location: null,
      })
      // The completion link answers the app's shell itself.
      const complete = await fetch(
        `${base}/devices/complete/${'A'.repeat(43)}`,
        { redirect: 'manual', headers: { cookie: 'session=1' } },
      )
      assertShell(
        {
          status: complete.status,
          text: await complete.text(),
          headers: complete.headers,
        },
        403,
      )
      const qr = await get('/devices/qr')
      assert.deepEqual([qr.status, qr.text], [403, 'Tester access required'])
    } finally {
      mayRegister = true
    }
  })

  it('answers a refusal’s status, a known failure’s, else 400', async () => {
    failure = new CatalogRefused(404, 'App unavailable')
    for (const route of ['/apps', '/apps/1', '/devices', '/devices/complete/x'])
      assert.equal((await get(route)).status, 404, route)
    failure = new Error('Away')
    known = 503
    assert.equal((await get('/apps')).status, 503)
    known = undefined
    assert.equal((await get('/apps')).status, 400)
    failure = undefined
  })

  it('answers a grant file’s refusal and known failure plainly, and stops a broken stream', async () => {
    const file = `/install/${'A'.repeat(43)}`
    failure = new CatalogRefused(410, 'This install link has expired')
    assert.deepEqual(
      [
        (await get(`${file}/artifact`)).status,
        (await get(`${file}/artifact`)).text,
      ],
      [410, 'This install link has expired'],
    )
    failure = new Error('The host is away')
    known = 503
    assert.deepEqual(
      [
        (await get(`${file}/artifact`)).status,
        (await get(`${file}/artifact`)).text,
      ],
      [503, 'The host is away'],
    )
    // A failure the node does not know is the server's own error.
    known = undefined
    assert.equal((await get(`${file}/artifact`)).status, 500)
    failure = undefined
    // A file that fails once its headers are out ends the response.
    await assert.rejects(get(`${file}/manifest.plist`))
    assert.equal((await get(`${file}/other`)).status, 404)
  })
})
