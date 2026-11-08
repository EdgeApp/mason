import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { after, before, describe, it } from 'mocha'
import { SESSION_COOKIE } from '../auth/routes.js'
import type { Stream } from '../link/link.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { FakeS3 } from '../test/fakeS3.js'
import { seedLegacySecrets } from '../test/secrets.js'
import { desktop, manifest, zip } from '../upload/fixtures.test.js'
import { MASTER_SESSION_COOKIE } from './auth.js'
import { relayDownload } from './buildsApi.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const admin = { role: 'admin' as const, label: 'paul' }
const APP = 'test.example.app'
const OTHER = 'test.example.other'
const HOUR = 3_600_000
const sha = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex')
const apk = zip([['AndroidManifest.xml', manifest()]])
const apk2 = zip([['AndroidManifest.xml', manifest(false, false, 43)]])
const dmg = desktop('dmg')
const dmg2 = Buffer.from(dmg)
dmg2[16] = (dmg2[16]! + 1) % 256

const masonfile = (app: string): string => `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber('${app}', { start: 42, block: 1 })
  m.workflow('build', { params: { mode: { type: 'string', default: 'apk' } } }, () => {})
  m.stage('ship', { on: {}, publishes: ['${app}'], secrets: ['FIXTURE_APK', 'FIXTURE_APK2', 'FIXTURE_DMG'], run: ship })
}
export async function ship(ctx: Stage) {
  const { writeFileSync } = await import('node:fs')
  const mode = String(ctx.run.params.mode)
  if (mode === 'dmg') {
    writeFileSync('app.dmg', Buffer.from(ctx.secret('FIXTURE_DMG'), 'base64'))
    return await ctx.publish({ app: '${app}', platform: 'macos', path: 'app.dmg', version: '1.2.3' })
  }
  writeFileSync('app.apk', Buffer.from(ctx.secret(mode === 'apk2' ? 'FIXTURE_APK2' : 'FIXTURE_APK'), 'base64'))
  return await ctx.publish({ app: '${app}', platform: 'android', path: 'app.apk' })
}
`

describe('The builds API through the host and the master', function () {
  this.timeout(240_000)
  let c: Cluster
  let host: RunningNode
  let s3: FakeS3
  const people: Record<string, number> = {}
  const keys: Record<string, string> = {}
  const builds: Record<string, number> = {}

  const origin = (node: RunningNode): string =>
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  const call = async (
    node: RunningNode,
    route: string,
    credential: { key?: string; cookie?: string } = {},
    method = 'GET',
  ): Promise<{
    status: number
    json: Json
    body: Buffer
    headers: { get(name: string): string | null }
  }> => {
    const response = await pinnedFetch(
      origin(node) + route,
      {
        method,
        redirect: 'manual',
        headers: {
          ...(credential.key == null
            ? {}
            : { authorization: `Bearer ${credential.key}` }),
          ...(credential.cookie == null ? {} : { cookie: credential.cookie }),
        },
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
    return { status: response.status, json, body, headers: response.headers }
  }
  const both = (): Array<[string, RunningNode]> => [
    ['host', host],
    ['master', c.master],
  ]
  const ids = (list: Json): number[] => list.map((entry: Json) => entry.id)
  const onHost = (person: string): { cookie: string } => ({
    cookie: `${SESSION_COOKIE}=${host.host!.accounts.startSession(people[person]!).token}`,
  })
  const onMaster = (person: string): { cookie: string } => ({
    cookie: `${MASTER_SESSION_COOKIE}=${c.master.master!.auth.start(people[person]!, '127.0.0.1').token}`,
  })
  const run = async (project: string, mode: string): Promise<number> => {
    const created = await c.api('POST', '/api/v2/runs', {
      project,
      branch: 'master',
      params: { mode },
    })
    assert.equal(created.status, 202, created.text)
    const value = await c.until(
      () => {
        const found = c.master.master!.run(created.json.id) as Json
        return ['succeeded', 'failed', 'cancelled', 'unstable'].includes(
          found.status,
        )
          ? found
          : undefined
      },
      60_000,
      `the ${project} ${mode} run`,
    )
    assert.equal(
      value.status,
      'succeeded',
      c.master.master!.scheduler.logs(value.id),
    )
    const id = value.stages.find((stage: Json) => stage.name === 'ship').output
      .buildId as number
    await c.until(
      () =>
        host
          .host!.cache.db.prepare(
            "SELECT 1 FROM builds WHERE id=? AND state='ready'",
          )
          .get(id),
      5000,
      'the build on the host',
    )
    return id
  }

  before(async () => {
    s3 = new FakeS3({
      bucket: 'mason-builds',
      region: 'nyc3',
      accessKeyId: 'AKIAFAKEBUILDS2',
      secretAccessKey: 'fake-builds-secret-2',
    })
    await s3.start()
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'builds-api-'),
    )
    c = await cluster(path.join(dir, 'cluster'), { workers: [{ name: 'w' }] })
    const master = c.master.master!
    // Before any host is paired the master has nowhere to relay.
    keys.admin = c.admin
    const none = await call(c.master, '/api/v2/builds', { key: keys.admin })
    assert.equal(none.status, 503)
    assert.deepEqual(none.json, { error: 'This cluster has no host' })
    const plain = (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> =>
      fetch(
        String(url instanceof Request ? url.url : url).replace(
          /^https:/,
          'http:',
        ),
        init,
      )
    host = await c.startHost('host', {
      hostOptions: { storageFetch: plain as typeof fetch },
    })
    await master.settings.set(admin, 'host', {
      origin: 'https://builds.example.test',
      workerOrigin: host.web!.url,
    })
    for (const [slug, app, platforms] of [
      ['ship', APP, ['android', 'macos']],
      ['other', OTHER, ['macos']],
    ] as const) {
      const repo = c.repo(`fixtures/${slug}`)
      repo.commit({ 'Masonfile.ts': masonfile(app) })
      master.saveProject(admin, slug, {
        repository: repo.url,
        rules: [{ pattern: '*', mode: 'request' }],
        apps: [{ bundleId: app, name: slug, platforms: [...platforms] }],
      })
      seedLegacySecrets(master.database.db, slug, {
        env: [
          { name: 'FIXTURE_APK', value: apk.toString('base64'), secret: false },
          {
            name: 'FIXTURE_APK2',
            value: apk2.toString('base64'),
            secret: false,
          },
          {
            name: 'FIXTURE_DMG',
            value: (slug === 'ship' ? dmg2 : dmg).toString('base64'),
            secret: false,
          },
        ],
      })
    }
    const appId = (slug: string): number =>
      Number(
        (
          master.database.db
            .prepare('SELECT id FROM apps WHERE slug=?')
            .get(slug) as Json
        ).id,
      )
    for (const [name, role] of [
      ['tess', 'tester'],
      ['nora', 'tester'],
      ['dana', 'developer'],
      ['dirk', 'developer'],
    ] as const)
      people[name] = (
        await master.people.create(admin, {
          name,
          emails: [`${name}@example.test`],
          role,
        })
      ).id
    master.people.createGroup(admin, {
      name: 'Ship testers',
      apps: [appId(APP)],
      members: [people.tess!, people.dana!],
    })
    const as = (person: string): Json => ({
      role: 'developer',
      accountId: people[person],
      label: `account:${people[person]}`,
    })
    keys.danaTester = master.keys.create(as('dana'), { role: 'tester' }).token
    keys.dirkTester = master.keys.create(as('dirk'), { role: 'tester' }).token
    keys.scoped = master.keys.create(admin, {
      role: 'developer',
      projects: ['other'],
    }).token
    builds.apk = await run('ship', 'apk')
    builds.other = await run('other', 'dmg')
    await c.until(
      () =>
        host.host!.cache.db.prepare('SELECT COUNT(*) n FROM host_keys').get()!
          .n === 4 &&
        host
          .host!.cache.db.prepare(
            'SELECT 1 FROM group_members WHERE account_id=?',
          )
          .get(people.tess!),
      5000,
      'the keys and groups on the host',
    )
  })
  after(async () => {
    await c?.close()
    await s3?.close()
  })

  it('lists a published build and answers it by id on the host and the master alike', async () => {
    const lists: Json[] = []
    for (const [name, node] of both()) {
      const list = await call(node, '/api/v2/builds?project=ship', {
        key: keys.admin,
      })
      assert.equal(list.status, 200, `${name}: ${list.body.toString()}`)
      assert.deepEqual(ids(list.json), [builds.apk], name)
      lists.push(list.json)
      const one = await call(node, `/api/v2/builds/${builds.apk}`, {
        key: keys.admin,
      })
      assert.equal(one.status, 200, name)
      assert.deepEqual(one.json, list.json[0], name)
      const missing = await call(node, '/api/v2/builds/999999', {
        key: keys.admin,
      })
      assert.equal(missing.status, 404, name)
      assert.deepEqual(missing.json, { error: 'No such build' })
      const bad = await call(node, '/api/v2/builds?platform=amiga', {
        key: keys.admin,
      })
      assert.equal(bad.status, 400, name)
      assert.deepEqual(bad.json, { error: 'Invalid platform' })
    }
    assert.deepEqual(lists[0], lists[1])
    const build = lists[0][0]
    assert.equal(build.app, APP)
    assert.equal(build.project, 'ship')
    assert.equal(build.platform, 'android')
    assert.equal(build.variant, '')
    assert.equal(build.buildNumber, '42')
    assert.equal(build.digest, sha(apk))
    assert.equal(build.size, apk.length)
    assert.equal(typeof build.run, 'string')
    assert.equal(build.commit.length, 40)
  })

  it('downloads the build through the host and through the master with a matching digest', async () => {
    for (const [name, node] of both()) {
      const reply = await call(node, `/api/v2/builds/${builds.apk}/download`, {
        key: keys.admin,
      })
      assert.equal(reply.status, 200, `${name}: ${reply.body.toString()}`)
      assert.equal(sha(reply.body), sha(apk), name)
      assert.equal(reply.headers.get('content-length'), String(apk.length))
      const { version } = (
        await call(node, `/api/v2/builds/${builds.apk}`, { key: keys.admin })
      ).json
      assert.equal(
        reply.headers.get('content-disposition'),
        `attachment; filename="${APP}-${version}-42.apk"`,
      )
      assert.equal(reply.headers.get('etag'), `"${sha(apk)}"`)
      assert.equal(
        reply.headers.get('repr-digest'),
        `sha-256=:${Buffer.from(sha(apk), 'hex').toString('base64')}:`,
      )
      const head = await call(
        node,
        `/api/v2/builds/${builds.apk}/download`,
        { key: keys.admin },
        'HEAD',
      )
      assert.equal(head.status, 200, name)
      assert.equal(head.body.length, 0)
      assert.equal(head.headers.get('content-length'), String(apk.length))
      // A refusal through either is the host's JSON.
      const refused = await call(node, '/api/v2/builds/999999/download', {
        key: keys.admin,
      })
      assert.equal(refused.status, 404, name)
      assert.deepEqual(refused.json, { error: 'No such build' })
    }
  })

  it('keeps the newest build per app, branch, platform and variant with latest=1', async () => {
    builds.apk2 = await run('ship', 'apk2')
    for (const [name, node] of both()) {
      const all = await call(node, '/api/v2/builds?app=' + APP, {
        key: keys.admin,
      })
      assert.deepEqual(ids(all.json), [builds.apk2, builds.apk], name)
      const latest = await call(
        node,
        `/api/v2/builds?app=${APP}&latest=1&platform=android`,
        { key: keys.admin },
      )
      assert.deepEqual(ids(latest.json), [builds.apk2], name)
    }
  })

  it('limits testers to their groups’ apps, by session on either node and by a tester key', async () => {
    const visible = [builds.apk2, builds.apk]
    for (const [name, node] of both()) {
      const session = (person: string): { cookie: string } =>
        node === host ? onHost(person) : onMaster(person)
      const tess = session('tess')
      assert.deepEqual(
        ids((await call(node, '/api/v2/builds', tess)).json),
        visible,
        name,
      )
      assert.equal(
        (await call(node, `/api/v2/builds/${builds.other}`, tess)).status,
        404,
        name,
      )
      const download = await call(
        node,
        `/api/v2/builds/${builds.apk}/download`,
        tess,
      )
      assert.equal(sha(download.body), sha(apk), name)
      const nora = session('nora')
      assert.deepEqual((await call(node, '/api/v2/builds', nora)).json, [])
      assert.equal(
        (await call(node, `/api/v2/builds/${builds.apk}`, nora)).status,
        404,
      )
      // A tester key acts for its creator's groups, not the creator's role.
      assert.deepEqual(
        ids(
          (await call(node, '/api/v2/builds', { key: keys.danaTester })).json,
        ),
        visible,
        name,
      )
      assert.deepEqual(
        (await call(node, '/api/v2/builds', { key: keys.dirkTester })).json,
        [],
        name,
      )
      assert.equal(
        (
          await call(node, `/api/v2/builds/${builds.apk}/download`, {
            key: keys.dirkTester,
          })
        ).status,
        404,
        name,
      )
      // A developer sees every app.
      assert.equal(
        (await call(node, '/api/v2/builds', session('dirk'))).json.length,
        3,
        name,
      )
      assert.equal((await call(node, '/api/v2/builds')).status, 401, name)
    }
  })

  it('refuses a key outside its project scopes on the host and the master', async () => {
    for (const [name, node] of both()) {
      assert.deepEqual(
        ids((await call(node, '/api/v2/builds', { key: keys.scoped })).json),
        [builds.other],
        name,
      )
      for (const route of [
        '/api/v2/builds?project=ship',
        `/api/v2/builds/${builds.apk}`,
        `/api/v2/builds/${builds.apk}/download`,
      ]) {
        const reply = await call(node, route, { key: keys.scoped })
        assert.equal(reply.status, 403, `${name} ${route}`)
        assert.deepEqual(reply.json, {
          error: 'This key does not cover that project or branch',
        })
      }
    }
  })

  it('redirects a Space-stored build to a signed URL from the host and the master', async () => {
    const endpoint = s3.endpoint.replace(/^http:/, 'https:')
    await c.master.master!.settings.set(admin, 'storage', {
      driver: 's3',
      s3: {
        endpoint,
        bucket: 'mason-builds',
        region: 'nyc3',
        accessKeyId: 'AKIAFAKEBUILDS2',
        secretAccessKey: 'fake-builds-secret-2',
      },
    })
    await c.until(
      () => host.host!.cache.setting<Json>('storage')?.driver === 's3',
      5000,
      'the storage setting on the host',
    )
    builds.dmg = await run('ship', 'dmg')
    for (const [name, node] of both()) {
      const reply = await call(node, `/api/v2/builds/${builds.dmg}/download`, {
        key: keys.admin,
      })
      assert.equal(reply.status, 302, `${name}: ${reply.body.toString()}`)
      assert.equal(reply.headers.get('cache-control'), 'no-store')
      assert.equal(reply.headers.get('etag'), `"${sha(dmg2)}"`)
      const location = reply.headers.get('location')!
      assert(location.startsWith(`${endpoint}/mason-builds/`), location)
      assert.match(location, /X-Amz-Expires=300&/)
      // FakeS3 speaks plain HTTP behind the https endpoint the setting needs;
      // the signature covers the host, path and query, not the scheme.
      const followed = await fetch(location.replace(/^https:/, 'http:'))
      assert.equal(followed.status, 200, name)
      assert.equal(sha(Buffer.from(await followed.arrayBuffer())), sha(dmg2))
      assert.match(
        followed.headers.get('content-disposition')!,
        /^attachment; filename=".+\.dmg"$/,
      )
    }
    // The disk-stored build still streams.
    const disk = await call(c.master, `/api/v2/builds/${builds.apk}/download`, {
      key: keys.admin,
    })
    assert.equal(sha(disk.body), sha(apk))
  })

  it('keeps serving from the host while the master is away, and stops past the grace window', async () => {
    const tess = onHost('tess')
    await c.drop('host', 100, async () => {
      assert.equal(host.host!.online(), false)
      const list = await call(host, '/api/v2/builds?project=ship', {
        key: keys.admin,
      })
      assert.equal(list.status, 200)
      assert.deepEqual(ids(list.json), [builds.dmg, builds.apk2, builds.apk])
      const download = await call(
        host,
        `/api/v2/builds/${builds.apk}/download`,
        { key: keys.admin },
      )
      assert.equal(sha(download.body), sha(apk))
      assert.equal((await call(host, '/api/v2/builds', tess)).json.length, 3)
      for (const route of [
        '/api/v2/builds',
        `/api/v2/builds/${builds.apk}`,
        `/api/v2/builds/${builds.apk}/download`,
      ]) {
        const relayed = await call(c.master, route, { key: keys.admin })
        assert.equal(relayed.status, 503, route)
        assert.deepEqual(relayed.json, { error: 'The host is not connected' })
      }
      host.host!.advanceClock(73 * HOUR)
      try {
        const late = await call(host, '/api/v2/builds', { key: keys.admin })
        assert.equal(late.status, 503)
        assert.match(late.json.error, /too long to serve builds/)
      } finally {
        host.host!.resetClock()
      }
    })
    await c.until(() => host.host!.online(), 10_000, 'the host to sync again')
    assert.equal(
      (await call(c.master, '/api/v2/builds', { key: keys.admin })).status,
      200,
    )
  })

  it('relays a download with held credit, and answers 502 for a malformed or aborted answer', async () => {
    /** One end of a link stream that the test feeds. */
    class Fake extends EventEmitter {
      held = false
      granted = 0
      ended = false
      aborted: string | undefined
      holdCredit(): void {
        this.held = true
      }
      grant(bytes: number): void {
        this.granted += bytes
      }
      end(): void {
        this.ended = true
      }
      abort(reason: string): void {
        this.aborted = reason
      }
    }
    let feed: (stream: Fake) => void = () => undefined
    const streams: Fake[] = []
    const app = express()
    app.get('/', (_req, res) => {
      const stream = new Fake()
      streams.push(stream)
      void relayDownload(stream as unknown as Stream, res)
      feed(stream)
    })
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    try {
      feed = (stream): void => {
        stream.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              status: 200,
              headers: { 'Content-Length': '6', 'X-Secret': 'no' },
            }).slice(0, 10),
          ),
        )
        setImmediate(() => {
          stream.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                status: 200,
                headers: { 'Content-Length': '6', 'X-Secret': 'no' },
              }).slice(10) + '\nabc',
            ),
          )
          stream.emit('data', Buffer.from('def'))
          stream.emit('end')
        })
      }
      const ok = await fetch(url)
      assert.equal(ok.status, 200)
      assert.equal(await ok.text(), 'abcdef')
      assert.equal(ok.headers.get('x-secret'), null)
      await new Promise((resolve) => setImmediate(resolve))
      assert(streams[0]!.held)
      assert(streams[0]!.ended)
      const line = JSON.stringify({
        status: 200,
        headers: { 'Content-Length': '6', 'X-Secret': 'no' },
      })
      assert.equal(streams[0]!.granted, line.length + 1 + 6)
      for (const bad of [
        (stream: Fake): void => {
          stream.emit('data', Buffer.from('not json\n'))
        },
        (stream: Fake): void => {
          stream.emit('data', Buffer.alloc(17 * 1024, 'x'))
        },
        (stream: Fake): void => {
          stream.emit('data', Buffer.from('{"status":200}'))
          stream.emit('end')
        },
        (stream: Fake): void => {
          stream.emit('abort', 'The host went away')
        },
        (stream: Fake): void => {
          stream.emit('data', Buffer.from('{"status":1000}\n'))
        },
        // The file's headers arrive, then the host cannot read the file.
        (stream: Fake): void => {
          stream.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                status: 200,
                headers: {
                  'Content-Type': 'application/vnd.android.package-archive',
                  'Content-Disposition': 'attachment; filename="x.apk"',
                  'Content-Length': '6',
                  ETag: '"abc"',
                },
              }) + '\n',
            ),
          )
          setImmediate(() => stream.emit('abort', 'The host went away'))
        },
      ]) {
        feed = (stream): void => {
          setImmediate(() => bad(stream))
        }
        const reply = await fetch(url)
        assert.equal(reply.status, 502)
        assert.match(reply.headers.get('content-type')!, /^application\/json/)
        assert.equal(reply.headers.get('content-disposition'), null)
        // Express gives the JSON its own weak ETag, never the file's.
        assert.notEqual(reply.headers.get('etag'), '"abc"')
        assert.match((await reply.json()).error, /malformed|went away/)
      }
      // An abort after the line cuts the response short.
      feed = (stream): void => {
        setImmediate(() => {
          stream.emit('data', Buffer.from('{"status":200}\npartial'))
          setImmediate(() => stream.emit('abort', 'gone'))
        })
      }
      await assert.rejects(async () => await (await fetch(url)).text())
      // A client that goes away aborts the stream.
      feed = (stream): void => {
        setImmediate(() =>
          stream.emit(
            'data',
            Buffer.from('{"status":200,"headers":{"Content-Length":"100"}}\nx'),
          ),
        )
      }
      const controller = new AbortController()
      const response = await fetch(url, { signal: controller.signal })
      controller.abort()
      await response.body?.cancel().catch(() => undefined)
      const last = streams[streams.length - 1]!
      await c.until(() => last.aborted, 5000, 'the stream to abort')
      assert.equal(last.aborted, 'The download was cancelled')
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
