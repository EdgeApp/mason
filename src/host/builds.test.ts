import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import type { Projected, Sync } from '../master/changes.js'
import type { Stream } from '../link/link.js'
import { FakeS3 } from '../test/fakeS3.js'
import { asBuildsQuery, asViewer, fileName, refusal } from './builds.js'
import { HostRuntime } from './runtime.js'
import { hostApp } from './web.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const sha = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex')
const v1 = (n: number): string =>
  `mason_v1_${String(n).padStart(32, '0')}.${'K'.repeat(42)}${n % 10}`
const v1Id = (n: number): string => String(n).padStart(32, '0')
const BUILDER = 'b'.repeat(64)
const HOUR = 3_600_000

describe('The host’s builds API', function () {
  this.timeout(60_000)
  const now = Date.now()
  const lines: string[] = []
  let dir: string
  let host: HostRuntime
  let server: http.Server
  let base: string
  let s3: FakeS3
  const apk = Buffer.from('PK\u0003\u0004 a default apk')
  const dmg = Buffer.from('a disk image for the Space')
  const key = (n: number, digit: string): string =>
    `${digit.repeat(32)}-${String(n).padStart(16, '0')}.apk`
  const fileKeys = {
    101: key(101, 'a'),
    102: key(102, 'b'),
    103: key(103, 'c'),
    104: key(104, 'd').replace('.apk', '.dmg'),
    105: key(105, 'e'),
  }

  const build = (
    id: number,
    app: number,
    channel: number,
    fields: Record<string, unknown> = {},
  ): Projected => ({
    row: {
      id,
      app_id: app,
      channel_id: channel,
      platform: 'android',
      branch: 'master',
      commit_hash: String(id).repeat(14).slice(0, 40),
      version: '1.2.3',
      build_number: String(id),
      bundle_id: `app.${app}`,
      format: 'apk',
      digest: sha(`build ${id}`),
      size: apk.length,
      file_key: fileKeys[id as keyof typeof fileKeys] ?? key(id, 'f'),
      published_at: now - 10_000 + id,
      expires_at: now + 30 * 24 * HOUR,
      state: 'ready',
      changelog: '',
      source: 'pipeline',
      custom_fields: '{}',
      variant: '',
      run: `run-${id}`,
      ...fields,
    },
    children: { build_provisioning: [] },
  })
  const account = (
    id: number,
    role: string,
    fields: Record<string, unknown> = {},
  ): Projected => ({
    row: {
      id,
      name: `Person ${id}`,
      email: `p${id}@example.test`,
      is_admin: 0,
      is_tester: 1,
      disabled: 0,
      permission_version: 1,
      created_at: now,
      role,
      open_admission: 0,
      ...fields,
    },
    children: { account_emails: [], account_devices: [] },
  })
  const hostKey = (
    id: string,
    token: string,
    role: string,
    fields: Record<string, unknown> = {},
  ): Projected => ({
    row: {
      id,
      hash: sha(token),
      role,
      projects: '[]',
      branches: '[]',
      format: 'v1',
      creator: null,
      expires_at: null,
      ...fields,
    },
  })
  const channel = (
    id: number,
    app: number,
    platform: string,
    formats: string[],
  ): Record<string, unknown> => ({
    id,
    app_id: app,
    platform,
    channel_key: sha(`channel ${id}`),
    formats: JSON.stringify(formats),
    enabled: 1,
  })
  const snapshot = (storage?: Record<string, unknown>): Sync => ({
    kind: 'snapshot',
    revision: 5,
    entities: {
      setting: [
        {
          row: {
            area: 'host',
            value: JSON.stringify({
              origin: 'https://builds.example.test',
              offlineGraceHours: 72,
            }),
          },
        },
        ...(storage == null
          ? []
          : [{ row: { area: 'storage', value: JSON.stringify(storage) } }]),
      ],
      project: [
        {
          row: {
            id: 1,
            slug: 'phones',
            name: 'Phones',
            position: 0,
            enabled: 1,
            default_branch: 'master',
          },
          children: { project_apps: [{ app_id: 1, project_id: 1 }] },
        },
        {
          row: {
            id: 2,
            slug: 'other',
            name: 'Other',
            position: 1,
            enabled: 1,
            default_branch: 'master',
          },
          children: { project_apps: [{ app_id: 2, project_id: 2 }] },
        },
      ],
      app: [
        {
          row: { id: 1, slug: 'app.one', name: 'One', position: 0, enabled: 1 },
          children: {
            channels: [
              channel(1, 1, 'android', ['apk']),
              channel(11, 1, 'macos', ['dmg']),
            ],
          },
        },
        {
          row: { id: 2, slug: 'app.two', name: 'Two', position: 1, enabled: 1 },
          children: { channels: [channel(2, 2, 'android', ['apk'])] },
        },
        {
          row: {
            id: 3,
            slug: 'app.loose',
            name: 'Loose',
            position: 2,
            enabled: 1,
          },
          children: { channels: [channel(3, 3, 'android', ['apk'])] },
        },
      ],
      build: [
        build(101, 1, 1, { run: 'run-2' }),
        build(102, 1, 1, { variant: 'arm64-v8a', run: 'run-2', size: 3 }),
        build(103, 1, 1, { digest: sha(apk) }),
        build(104, 1, 11, {
          platform: 'macos',
          branch: 'release/1.0',
          format: 'dmg',
          digest: sha(dmg),
          size: dmg.length,
          run: null,
        }),
        build(105, 2, 2, { digest: sha(apk) }),
        build(106, 3, 3),
        build(107, 1, 1, { branch: 'gone', expires_at: now - 1 }),
      ],
      account: [
        account(10, 'tester'),
        account(11, 'developer'),
        account(12, 'tester', { disabled: 1 }),
        account(13, 'tester'),
        account(14, 'tester', { open_admission: 1 }),
        account(20, 'developer'),
        account(21, 'developer'),
      ],
      group: [
        {
          row: { id: 1, name: 'One testers', created_at: now },
          children: {
            group_apps: [{ group_id: 1, app_id: 1 }],
            group_members: [
              { group_id: 1, account_id: 10 },
              { group_id: 1, account_id: 20 },
            ],
          },
        },
      ],
      key: [
        hostKey(v1Id(1), v1(1), 'admin'),
        hostKey(v1Id(2), v1(2), 'developer', { projects: '["other"]' }),
        hostKey(v1Id(3), v1(3), 'developer', { branches: '["release/*"]' }),
        hostKey(v1Id(4), v1(4), 'tester', { creator: 20 }),
        hostKey(v1Id(5), v1(5), 'tester', { creator: 21 }),
        hostKey(v1Id(6), v1(6), 'tester'),
        hostKey(v1Id(7), v1(7), 'admin', { expires_at: now - 1 }),
        hostKey(v1Id(8), v1(8), 'developer', { creator: 12 }),
        hostKey(v1Id(9), v1(9), 'developer', { creator: 99 }),
        hostKey(v1Id(10), v1(10), 'admin', { creator: 10 }),
        hostKey('builder1', BUILDER, 'developer', { format: 'builder' }),
      ],
    },
  })

  before(async () => {
    s3 = new FakeS3({
      bucket: 'mason-builds',
      region: 'nyc3',
      accessKeyId: 'AKIAFAKEBUILDS1',
      secretAccessKey: 'fake-builds-secret-1',
    })
    await s3.start()
    dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'builds-'),
    )
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
    host = new HostRuntime({
      dir,
      link: (): undefined => undefined,
      log: (line): void => {
        lines.push(line)
      },
      storageFetch: plain as typeof fetch,
    })
    host.apply(snapshot())
    const file = (name: string, data: Buffer): string => {
      const out = path.join(dir, name)
      writeFileSync(out, data)
      return out
    }
    await host.objects.put(fileKeys[103], file('103.apk', apk), sha(apk))
    await host.objects.put(fileKeys[105], file('105.apk', apk), sha(apk))
    // 102's file is shorter than its build says; 101 has none.
    await host.objects.put(fileKeys[102], file('102.apk', apk), sha(apk))
    // 104 is in the Space.
    host.apply(
      snapshot({
        driver: 's3',
        s3: {
          endpoint: s3.endpoint.replace(/^http:/, 'https:'),
          bucket: 'mason-builds',
          region: 'nyc3',
          accessKeyId: 'AKIAFAKEBUILDS1',
          secretAccessKey: 'fake-builds-secret-1',
        },
      }),
    )
    await host.objects.put(fileKeys[104], file('104.dmg', dmg), sha(dmg))
    server = http.createServer(
      hostApp({ role: 'host', testEndpoints: false, host }),
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    if (server != null) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    await host?.stop()
    await s3?.close()
  })

  const get = async (
    route: string,
    credential?: string,
    init: RequestInit = {},
  ): Promise<{
    status: number
    json: Json
    body: Buffer
    headers: Headers
  }> => {
    const response = await fetch(base + route, {
      redirect: 'manual',
      ...init,
      headers: {
        ...(credential == null
          ? {}
          : credential.startsWith('cookie:')
            ? { cookie: `__Host-mason-session=${credential.slice(7)}` }
            : { authorization: `Bearer ${credential}` }),
        ...(init.headers as Record<string, string>),
      },
    })
    const body = Buffer.from(await response.arrayBuffer())
    let json: Json
    try {
      json = JSON.parse(body.toString())
    } catch {
      json = undefined
    }
    return { status: response.status, json, body, headers: response.headers }
  }
  const ids = (list: Json): number[] => list.map((entry: Json) => entry.id)
  const session = (account: number): string =>
    'cookie:' + host.accounts.startSession(account).token

  it('lists ready builds newest first, by every filter, with latest=1 and limit', async () => {
    const all = await get('/api/v2/builds', v1(1))
    assert.equal(all.status, 200, all.body.toString())
    assert.deepEqual(ids(all.json), [106, 105, 104, 103, 102, 101])
    const first = all.json.find((entry: Json) => entry.id === 104)
    assert.deepEqual(first, {
      id: 104,
      app: 'app.one',
      appName: 'One',
      project: 'phones',
      branch: 'release/1.0',
      platform: 'macos',
      variant: '',
      version: '1.2.3',
      buildNumber: '104',
      commit: '104'.repeat(14).slice(0, 40),
      bundleId: 'app.1',
      format: 'dmg',
      size: dmg.length,
      digest: sha(dmg),
      publishedAt: now - 10_000 + 104,
      expiresAt: now + 30 * 24 * HOUR,
      run: null,
      download: '/api/v2/builds/104/download',
    })
    assert.equal(all.json.find((entry: Json) => entry.id === 106).project, null)
    const cases: Array<[string, number[]]> = [
      ['project=phones', [104, 103, 102, 101]],
      ['app=app.two', [105]],
      ['branch=release%2F1.0', [104]],
      ['platform=android', [106, 105, 103, 102, 101]],
      ['variant=arm64-v8a', [102]],
      ['variant=&project=phones', [104, 103, 101]],
      ['latest=1&project=phones', [104, 103, 102]],
      ['latest=true&app=app.one&platform=android&variant=', [103]],
      ['latest=0&limit=2', [106, 105]],
      ['project=nothing', []],
    ]
    for (const [query, expected] of cases) {
      const reply = await get(`/api/v2/builds?${query}`, v1(1))
      assert.equal(reply.status, 200, `${query}: ${reply.body.toString()}`)
      assert.deepEqual(ids(reply.json), expected, query)
    }
    for (const query of [
      'platform=amiga',
      'variant=-bad',
      'latest=yes',
      'limit=0',
      'limit=501',
      'limit=1.5',
      'project=a&project=b',
      `branch=${'x'.repeat(257)}`,
    ]) {
      const reply = await get(`/api/v2/builds?${query}`, v1(1))
      assert.equal(reply.status, 400, query)
      assert.match(reply.json.error, /^(Invalid|Give) /, query)
    }
  })

  it('answers one build, 404 for an unknown, hidden or expired one', async () => {
    const one = await get('/api/v2/builds/103', v1(1))
    assert.equal(one.status, 200)
    assert.equal(one.json.id, 103)
    for (const id of ['999999', '107', 'abc', '0', '-1', '1e3']) {
      const reply = await get(`/api/v2/builds/${id}`, v1(1))
      assert.equal(reply.status, 404, id)
      assert.deepEqual(reply.json, { error: 'No such build' })
    }
  })

  it('checks keys as the master does: unknown, wrong, expired, a disabled or missing creator, and a creator’s lower role', async () => {
    const wrong = v1(1).replace(/.$/, '9')
    for (const token of [
      wrong,
      'mason_v1_nope',
      v1(77),
      v1(7),
      'c'.repeat(64),
    ]) {
      const reply = await get('/api/v2/builds', token)
      assert.equal(reply.status, 401, token.slice(0, 12))
      assert.deepEqual(reply.json, { error: 'An API key is required' })
    }
    for (const token of [v1(8), v1(9)]) {
      const reply = await get('/api/v2/builds', token)
      assert.equal(reply.status, 403)
      assert.deepEqual(reply.json, { error: 'The key’s owner is disabled' })
    }
    const bare = await get('/api/v2/builds', undefined, {
      headers: { authorization: 'Basic abc' },
    })
    assert.equal(bare.status, 401)
    // An imported builder token is found by its digest.
    assert.deepEqual(ids((await get('/api/v2/builds?limit=1', BUILDER)).json), [
      106,
    ])
    // An admin key made by a tester acts as that tester: its groups' apps.
    assert.deepEqual(
      ids((await get('/api/v2/builds', v1(10))).json),
      [104, 103, 102, 101],
    )
    // A cache upgraded to keep keys, not yet synced since: an unknown key is
    // the host waiting, not a refusal; a key it holds still works.
    host.cache.db
      .prepare("UPDATE host_meta SET value='0' WHERE key='keys_synced'")
      .run()
    try {
      const waiting = await get('/api/v2/builds', v1(77))
      assert.equal(waiting.status, 503)
      assert.deepEqual(waiting.json, {
        error: 'This Mason host is waiting for its master',
      })
      assert.equal((await get('/api/v2/builds', v1(1))).status, 200)
    } finally {
      host.cache.db
        .prepare("UPDATE host_meta SET value='1' WHERE key='keys_synced'")
        .run()
    }
    const none = await get('/api/v2/builds')
    assert.equal(none.status, 401)
    assert.deepEqual(none.json, { error: 'Sign in or use an API key' })
  })

  it('shows a tester only its groups’ apps, by session and by a key its creator made', async () => {
    const tester = session(10)
    assert.deepEqual(
      ids((await get('/api/v2/builds', tester)).json),
      [104, 103, 102, 101],
    )
    assert.equal((await get('/api/v2/builds/105', tester)).status, 404)
    assert.equal((await get('/api/v2/builds/105/download', tester)).status, 404)
    assert.equal((await get('/api/v2/builds/103', tester)).status, 200)
    // In no group: nothing. Admitted by a sign-in method: every app.
    assert.deepEqual((await get('/api/v2/builds', session(13))).json, [])
    assert.equal((await get('/api/v2/builds', session(14))).json.length, 6)
    // A developer sees every app.
    assert.equal((await get('/api/v2/builds', session(11))).json.length, 6)
    // A tester key acts for its creator's groups, not the creator's role.
    assert.deepEqual(
      ids((await get('/api/v2/builds', v1(4))).json),
      [104, 103, 102, 101],
    )
    assert.deepEqual((await get('/api/v2/builds', v1(5))).json, [])
    assert.equal((await get('/api/v2/builds/103', v1(5))).status, 404)
    assert.deepEqual((await get('/api/v2/builds', v1(6))).json, [])
    // The catalog still shows a developer every app.
    assert.equal(host.cache.scope(20), 'all')
    assert.deepEqual([...(host.cache.testerApps(20) as Set<number>)], [1])
  })

  it('limits a key to its project and branch scopes, refusing outside them', async () => {
    assert.deepEqual(ids((await get('/api/v2/builds', v1(2))).json), [105])
    for (const route of [
      '/api/v2/builds?project=phones',
      '/api/v2/builds/103',
      '/api/v2/builds/103/download',
      '/api/v2/builds/106',
    ]) {
      const reply = await get(route, v1(2))
      assert.equal(reply.status, 403, route)
      assert.deepEqual(reply.json, {
        error: 'This key does not cover that project or branch',
      })
    }
    assert.equal(
      (await get('/api/v2/builds?project=other', v1(2))).json.length,
      1,
    )
    // A branch scope: only release/* builds, of apps that have a project.
    assert.deepEqual(ids((await get('/api/v2/builds', v1(3))).json), [104])
    assert.equal(
      (await get('/api/v2/builds?project=phones&branch=master', v1(3))).status,
      403,
    )
  })

  it('streams a build from disk with its name, size and digest, and logs it', async () => {
    lines.length = 0
    const reply = await get('/api/v2/builds/103/download', v1(1))
    assert.equal(reply.status, 200)
    assert(reply.body.equals(apk))
    assert.equal(reply.headers.get('content-length'), String(apk.length))
    assert.equal(
      reply.headers.get('content-type'),
      'application/vnd.android.package-archive',
    )
    assert.equal(
      reply.headers.get('content-disposition'),
      'attachment; filename="app.one-1.2.3-103.apk"',
    )
    assert.equal(
      reply.headers.get('repr-digest'),
      `sha-256=:${Buffer.from(sha(apk), 'hex').toString('base64')}:`,
    )
    assert.equal(reply.headers.get('etag'), `"${sha(apk)}"`)
    assert.equal(sha(reply.body), sha(apk))
    assert.deepEqual(lines, [
      `Build 103 downloaded by key ${v1Id(1).slice(0, 6)} through the host`,
    ])
    const head = await get('/api/v2/builds/103/download', session(10), {
      method: 'HEAD',
    })
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.equal(head.headers.get('content-length'), String(apk.length))
    assert.equal(lines.length, 1)
    for (const id of [101, 102]) {
      const missing = await get(`/api/v2/builds/${id}/download`, v1(1))
      assert.equal(missing.status, 404)
      assert.deepEqual(missing.json, {
        error: 'The build’s file is no longer available',
      })
    }
    assert.equal(
      fileName({
        app: 'app one',
        version: '1.0/2',
        buildNumber: '7',
        variant: 'arm64-v8a',
        format: 'apk',
      } as Json),
      'app_one-1.0_2-7-arm64-v8a.apk',
    )
  })

  it('redirects a Space-stored build to a signed URL that serves it', async () => {
    lines.length = 0
    const reply = await get('/api/v2/builds/104/download', v1(1))
    assert.equal(reply.status, 302)
    assert.equal(reply.headers.get('cache-control'), 'no-store')
    assert.equal(reply.headers.get('etag'), `"${sha(dmg)}"`)
    const location = reply.headers.get('location')!
    assert.match(location, /X-Amz-Signature=[0-9a-f]{64}/)
    assert.match(location, /X-Amz-Expires=300/)
    assert(!location.includes('fake-builds-secret-1'))
    assert(
      lines.includes(
        `Build 104 redirected to its Space for key ${v1Id(1).slice(0, 6)} through the host`,
      ),
    )
    const followed = await fetch(location.replace(/^https:/, 'http:'))
    assert.equal(followed.status, 200)
    assert.equal(
      followed.headers.get('content-type'),
      'application/x-apple-diskimage',
    )
    assert.equal(
      followed.headers.get('content-disposition'),
      'attachment; filename="app.one-1.2.3-104.dmg"',
    )
    assert.equal(sha(Buffer.from(await followed.arrayBuffer())), sha(dmg))
    // The Space stops answering: 502, not a redirect to nothing.
    await s3.close()
    try {
      const down = await get('/api/v2/builds/104/download', v1(1))
      assert.equal(down.status, 502)
      assert.deepEqual(down.json, {
        error: 'The build’s storage is unreachable',
      })
    } finally {
      await s3.start()
    }
    // Restarted on a new port, the object is gone from the fake's memory.
    s3.objects.clear()
  })

  it('answers the master’s builds.request and builds.download over the link', async () => {
    const viewer = { role: 'tester', account: 10, label: 'account:10' }
    assert.deepEqual(
      ids(host.builds.request({ viewer, op: 'list', query: {} }).body),
      [104, 103, 102, 101],
    )
    assert.equal(
      (host.builds.request({ viewer, op: 'get', id: 103 }).body as Json).id,
      103,
    )
    assert.deepEqual(host.builds.request({ viewer, op: 'get', id: 105 }), {
      status: 404,
      body: { error: 'No such build' },
    })
    assert.equal(host.builds.request({ viewer, op: 'drop' }).status, 400)
    for (const bad of [
      { role: 'owner', label: 'x' },
      { role: 'tester', label: '' },
      { role: 'tester', label: 'x', account: 1.5 },
      { role: 'tester', label: 'x', scopes: { projects: 'all', branches: [] } },
    ])
      assert.equal(
        host.builds.request({ viewer: bad, op: 'list' }).status,
        400,
        JSON.stringify(bad),
      )
    assert.deepEqual(
      asViewer({
        role: 'developer',
        label: 'key:1',
        account: 3,
        scopes: { projects: ['p'], branches: [] },
      }),
      {
        role: 'developer',
        label: 'key:1',
        account: 3,
        scopes: { projects: ['p'], branches: [] },
      },
    )
    assert.deepEqual(asBuildsQuery(undefined), { latest: false, limit: 50 })
    // Anything the host did not expect is its own fault, not a bad request.
    for (const odd of ['odd', new TypeError('x is undefined')])
      assert.deepEqual(refusal(odd), {
        status: 500,
        error: 'The host could not answer the request',
      })
    // A key's scopes are relayed however many it has.
    const wide = {
      role: 'developer',
      label: 'key:wide',
      scopes: {
        projects: [...Array.from({ length: 150 }, (_, n) => `p${n}`), 'other'],
        branches: [],
      },
    }
    assert.deepEqual(
      ids(host.builds.request({ viewer: wide, op: 'list' }).body),
      [105],
    )

    /** A link stream's sending end, collecting what the host writes. */
    class Sink extends EventEmitter {
      chunks: Buffer[] = []
      ended = false
      aborted: string | undefined
      failAfter = Infinity
      async write(chunk: Buffer): Promise<void> {
        if (this.aborted != null) throw new Error(this.aborted)
        this.chunks.push(Buffer.from(chunk))
        if (this.chunks.length > this.failAfter) {
          this.aborted = 'The download was cancelled'
          this.emit('abort', this.aborted)
          throw new Error(this.aborted)
        }
      }
      end(): void {
        this.ended = true
      }
      abort(reason: string): void {
        this.aborted = reason
      }
      parts(): { line: Json; rest: Buffer } {
        const all = Buffer.concat(this.chunks)
        const end = all.indexOf(10)
        return {
          line: JSON.parse(all.subarray(0, end).toString()),
          rest: all.subarray(end + 1),
        }
      }
    }
    const download = async (params: unknown): Promise<Sink> => {
      const sink = new Sink()
      await host.builds.stream(sink as unknown as Stream, params)
      return sink
    }
    lines.length = 0
    const file = await download({ viewer, id: 103 })
    assert(file.ended)
    assert.equal(file.parts().line.status, 200)
    assert.equal(
      file.parts().line.headers['Content-Length'],
      String(apk.length),
    )
    assert(file.parts().rest.equals(apk))
    assert.deepEqual(lines, [
      'Build 103 downloaded by account:10 through the master',
    ])
    const head = await download({ viewer, id: 103, head: true })
    assert.equal(head.parts().line.status, 200)
    assert.equal(head.parts().rest.length, 0)
    const refused = await download({ viewer, id: 105 })
    assert.equal(refused.parts().line.status, 404)
    assert.equal(
      refused.parts().line.headers['Content-Type'],
      'application/json; charset=utf-8',
    )
    assert.deepEqual(JSON.parse(refused.parts().rest.toString()), {
      error: 'No such build',
    })
    const invalid = await download({ viewer: { role: 'nobody' }, id: 103 })
    assert.equal(invalid.parts().line.status, 400)
    // The master's side goes away after the header line: the host stops.
    const cancelled = new Sink()
    cancelled.failAfter = 1
    await host.builds.stream(cancelled as unknown as Stream, {
      viewer,
      id: 103,
    })
    assert.equal(cancelled.aborted, 'The download was cancelled')
    assert(!cancelled.ended)
  })

  it('keeps serving with the master away, and answers 503 past the grace window or before its first sync', async () => {
    assert.equal(host.online(), false)
    assert.equal((await get('/api/v2/builds', v1(1))).status, 200)
    // Other methods and other /api/v2 paths still go to the forwarder.
    const posted = await get('/api/v2/builds', v1(1), { method: 'POST' })
    assert.equal(posted.status, 503)
    assert.match(posted.json.error, /master is unreachable/)
    assert.equal((await get('/api/v2/runs', v1(1))).status, 503)
    host.advanceClock(73 * HOUR)
    try {
      const late = await get('/api/v2/builds', v1(1))
      assert.equal(late.status, 503)
      assert.deepEqual(late.json, {
        error:
          'This Mason host has not reached its master for too long to serve builds',
      })
      assert.equal(
        host.builds.request({
          viewer: { role: 'admin', label: 'x' },
          op: 'list',
        }).status,
        503,
      )
    } finally {
      host.resetClock()
    }
    const fresh = new HostRuntime({
      dir: mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'builds-new-'),
      ),
      link: (): undefined => undefined,
    })
    try {
      const reply = refusal(
        ((): unknown => {
          try {
            fresh.builds.ready()
          } catch (error) {
            return error
          }
          return undefined
        })(),
      )
      assert.deepEqual(reply, {
        status: 503,
        error: 'This Mason host is waiting for its master',
      })
    } finally {
      await fresh.stop()
    }
  })
})
