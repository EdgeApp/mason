import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import { after, before, describe, it } from 'mocha'
import { Agent } from 'undici'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
} from '../auth/passwordProtocol.js'
import { permissionsOf } from '../master/permissions.js'
import { localOperator } from '../master/roles.js'
import {
  asAccountInfo,
  asAppData,
  asAppsData,
  asArtifactRunDetail,
  asBranchData,
  asDashboardData,
  asDevicesData,
  asInstallAnswer,
  asMasonfileText,
  asNodeInfo,
  asNotifications,
  asPrepareAnswer,
  asProjectApp,
  asProjectOverview,
  asProjectRuns,
  asRegistrationAnswer,
  asRunPage,
  asSessionInfo,
  asSignInReply,
  asStatusInfo,
} from '../shared/api/index.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { proofLog } from '../test/proofLog.js'
import {
  ALPHA,
  readFixture,
  shape,
  type ReadFixture,
  type Reply as FixtureReply,
  type Who,
} from '../test/readFixture.js'
import { branchKey } from '../catalog/platform.js'
import type { RunningNode } from '../node/serve.js'
import type { Role } from '../shared/permissions.js'
import { WebSocket } from 'ws'
import { version } from '../version.js'
import type { HostRuntime } from './runtime.js'
import { hostSessionApi } from './sessionApi.js'
import { hostApp } from './web.js'

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'hostapi-'))
const insecure = new Agent({ connect: { rejectUnauthorized: false } })
const ORIGIN = 'https://builds.example.test'
const MASTER_ORIGIN = 'https://mason.example.test'
const SESSION = '__Host-mason-session'

interface Reply {
  status: number
  // API responses are read field by field in assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
  text: string
  headers: Headers
}

/** A browser against a host's HTTPS listener: it keeps the session cookie. */
class Browser {
  cookie: string | undefined
  constructor(readonly base: () => string) {}
  async send(
    method: string,
    route: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Reply> {
    const response = await fetch(this.base() + route, {
      method,
      redirect: 'manual',
      // @ts-expect-error undici's dispatcher option
      dispatcher: insecure,
      headers: {
        ...(this.cookie == null ? {} : { cookie: `${SESSION}=${this.cookie}` }),
        ...(options.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    })
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';')
      if (!pair!.startsWith(`${SESSION}=`)) continue
      const token = pair!.slice(SESSION.length + 1)
      this.cookie = token === '' ? undefined : token
    }
    const text = await response.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    proofLog(`${method} ${route}`, `${response.status} ${text}`)
    return { status: response.status, json, text, headers: response.headers }
  }
}

describe('Host web API: node and session', function () {
  this.timeout(120_000)
  let c: Cluster
  let hugo: number
  const runtime = (): HostRuntime => c.hosts.get('host')!.host!
  const browser = (): Browser =>
    new Browser(() => c.hosts.get('host')!.web!.url)
  const fromHost = { origin: ORIGIN }

  before(async () => {
    c = await cluster(root())
    const master = c.master.master!
    await master.settings.set(localOperator, 'host', { origin: ORIGIN })
    await master.settings.set(localOperator, 'master', {
      origin: MASTER_ORIGIN,
    })
    await master.settings.set(localOperator, 'signIn', {
      methods: [
        {
          id: 'google',
          name: 'Google',
          type: 'oidc',
          issuer: 'https://accounts.example.test',
          clientId: 'mason',
          clientSecret: 'never-shown',
        },
      ],
    })
    const p = clientParameters('b1'.repeat(16), DEFAULT_PASSWORD_COSTS)
    hugo = (
      await master.people.create(localOperator, {
        name: 'Hugo',
        emails: ['hugo@example.com'],
        username: 'hugo',
        role: 'developer',
        password: {
          clientHash: await clientPasswordHash('Hugo-Horse-9', p),
          clientParameters: p,
        },
      })
    ).id
    await c.startHost('host', { testEndpoints: true })
    await c.until(
      () =>
        runtime()
          .cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(hugo) != null,
      5000,
      'Hugo on the host',
    )
  })
  after(async () => {
    await c?.close()
  })

  /** Signs Hugo in through the host's session API. */
  const signIn = async (
    b: Browser,
    password = 'Hugo-Horse-9',
  ): Promise<Reply> => {
    const given = await b.send('POST', '/api/v2/session/parameters', {
      body: { identifier: 'hugo' },
      headers: fromHost,
    })
    assert.equal(given.status, 200, given.text)
    return await b.send('POST', '/api/v2/session', {
      body: {
        identifier: 'hugo',
        clientHash: await clientPasswordHash(password, given.json),
      },
      headers: fromHost,
    })
  }

  it('GET /api/v2/node on a host: its origins, the master’s sign-in methods and test endpoints, never forwarded', async () => {
    await c.until(
      () => runtime().cache.setting<{ origin?: string }>('master')?.origin,
      5000,
      'the master setting on the host',
    )
    const link = runtime().options.link
    // Answered with no master to forward to.
    runtime().options.link = (): undefined => undefined
    try {
      const reply = await browser().send('GET', '/api/v2/node')
      assert.equal(reply.status, 200, reply.text)
      const info = asNodeInfo(reply.json)
      assert.equal(info.role, 'host')
      assert.equal(info.version, version)
      assert.equal(info.hostOrigin, ORIGIN)
      assert.equal(info.masterOrigin, MASTER_ORIGIN)
      assert.equal(info.setupNeeded, false)
      assert.deepEqual(info.signIn, {
        password: true,
        providers: [{ id: 'google', name: 'Google' }],
      })
      assert.equal(info.state, 'ok')
      assert.equal(info.testEndpoints, true)
      assert.doesNotMatch(reply.text, /never-shown/)
    } finally {
      runtime().options.link = link
    }
  })

  it('GET /api/v2/node says maintenance past the offline grace window, and the session waits with it', async () => {
    const b = browser()
    await c.drop('host', 1000, async () => {
      await c.until(() => !runtime().online(), 2000, 'offline')
      assert.equal((await b.send('GET', '/api/v2/node')).json.state, 'ok')
      runtime().advanceClock(73 * 3_600_000)
      try {
        const node = await b.send('GET', '/api/v2/node')
        assert.equal(node.status, 200)
        assert.equal(node.json.state, 'maintenance')
        const session = await b.send('GET', '/api/v2/session')
        assert.equal(session.status, 503)
        assert.match(session.json.error, /too long/)
      } finally {
        runtime().resetClock()
      }
    })
    await c.until(() => runtime().online(), 10000, 'online')
    assert.equal((await b.send('GET', '/api/v2/node')).json.state, 'ok')
  })

  it('GET /api/v2/node on a host still waiting for its master', async () => {
    const server = hostApp({ role: 'host', testEndpoints: false }).listen(
      0,
      '127.0.0.1',
    )
    await new Promise((resolve) => server.once('listening', resolve))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const reply = await fetch(`${base}/api/v2/node`)
      assert.equal(reply.status, 200)
      const info = asNodeInfo(await reply.json())
      assert.equal(info.state, 'waitingForMaster')
      assert.equal(info.testEndpoints, false)
      assert.deepEqual(info.signIn, { password: false, providers: [] })
      assert.equal(info.hostOrigin, undefined)
      // Everything else still says the host is waiting.
      assert.equal((await fetch(`${base}/api/v2/session`)).status, 503)
    } finally {
      server.close()
    }
  })

  it('the session API refuses with 503 until the host has synced its setting', async () => {
    const app = express()
    const waiting = {
      cache: {
        host: () => undefined,
        store: { now: Date.now, config: { origin: ORIGIN } },
      },
      maintenance: () => false,
    } as unknown as HostRuntime
    app.use(
      hostSessionApi(waiting, {
        parameters: async () => ({}),
        signIn: async () => assert.fail('not reached'),
      }),
    )
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    try {
      const reply = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/session`,
      )
      assert.equal(reply.status, 503)
      assert.deepEqual(await reply.json(), {
        error: 'This Mason host is waiting for its master',
      })
    } finally {
      server.close()
    }
  })

  it('signs in, reads and signs out on the host itself, with the host session cookie', async () => {
    const b = browser()
    assert.deepEqual((await b.send('GET', '/api/v2/session')).json, {
      error: 'Not signed in',
    })
    const wrong = await signIn(b, 'not-it')
    assert.equal(wrong.status, 401)
    assert.match(wrong.json.error, /wrong/)
    assert.equal(b.cookie, undefined)
    const right = await signIn(b)
    assert.equal(right.status, 200, right.text)
    const reply = asSignInReply(right.json)
    assert.deepEqual([reply.name, reply.role], ['Hugo', 'developer'])
    const set = right.headers.getSetCookie().join('\n')
    assert.match(set, /__Host-mason-session=/)
    assert.match(set, /HttpOnly/)
    assert.match(set, /Secure/)
    // The host's own session, not the master's.
    assert.equal(runtime().accounts.session(b.cookie)!.account.id, hugo)
    const read = await b.send('GET', '/api/v2/session')
    assert.equal(read.status, 200, read.text)
    const session = asSessionInfo(read.json)
    assert.deepEqual(session, {
      accountId: hugo,
      name: 'Hugo',
      role: 'developer',
      csrf: reply.csrf,
      permissions: permissionsOf('developer'),
      emails: [{ email: 'hugo@example.com', confirmed: true }],
    })
    // The old pages' routes keep working beside it.
    assert.equal(
      (
        await b.send('POST', '/auth/password/parameters', {
          body: { username: 'hugo' },
          headers: fromHost,
        })
      ).status,
      200,
    )
    const out = await b.send('DELETE', '/api/v2/session', {
      headers: { ...fromHost, 'x-mason-csrf': session.csrf },
    })
    assert.equal(out.status, 200, out.text)
    assert.equal(out.json, null)
    assert.equal(b.cookie, undefined)
    assert.equal((await b.send('GET', '/api/v2/session')).status, 401)
    assert.equal((await b.send('DELETE', '/api/v2/session')).status, 401)
  })

  it('needs the CSRF proof and the host’s own origin to change the session', async () => {
    const b = browser()
    assert.equal((await signIn(b)).status, 200)
    const { csrf } = (await b.send('GET', '/api/v2/session')).json
    const refused = async (
      headers: Record<string, string>,
    ): Promise<string> => {
      const reply = await b.send('DELETE', '/api/v2/session', { headers })
      assert.equal(reply.status, 403, reply.text)
      return reply.json.error
    }
    assert.equal(await refused(fromHost), 'Invalid request proof')
    assert.equal(
      await refused({ ...fromHost, 'x-mason-csrf': 'not-the-proof' }),
      'Invalid request proof',
    )
    assert.equal(
      await refused({ origin: 'https://evil.example', 'x-mason-csrf': csrf }),
      'Untrusted origin',
    )
    assert.equal(await refused({ 'x-mason-csrf': csrf }), 'Untrusted origin')
    // Sign-in posts from another origin are refused before the master is asked.
    for (const route of ['/api/v2/session/parameters', '/api/v2/session']) {
      const foreign = await b.send('POST', route, {
        body: { identifier: 'hugo', clientHash: 'ab'.repeat(32) },
        headers: { origin: 'https://evil.example' },
      })
      assert.equal(foreign.status, 403, foreign.text)
      assert.equal(foreign.json.error, 'Untrusted origin')
    }
    // Still signed in after all that.
    assert.equal((await b.send('GET', '/api/v2/session')).status, 200)
    // Signing out takes the same proof.
    const out = await b.send('DELETE', '/api/v2/session', {
      headers: { ...fromHost, 'x-mason-csrf': csrf },
    })
    assert.equal(out.status, 200, out.text)
    assert.equal((await b.send('GET', '/api/v2/session')).status, 401)
  })

  it('answers 503 when sign-in needs the master and it is unreachable, and reads the session from the cache', async () => {
    const b = browser()
    assert.equal((await signIn(b)).status, 200)
    const link = runtime().options.link
    runtime().options.link = (): undefined => undefined
    try {
      for (const route of ['/api/v2/session/parameters', '/api/v2/session']) {
        const reply = await b.send('POST', route, {
          body: { identifier: 'hugo', clientHash: 'ab'.repeat(32) },
          headers: fromHost,
        })
        assert.equal(reply.status, 503, reply.text)
        assert.deepEqual(reply.json, {
          error: 'Password sign-in needs the master; try again shortly',
        })
      }
      const read = await b.send('GET', '/api/v2/session')
      assert.equal(read.status, 200)
      assert.equal(read.json.accountId, hugo)
    } finally {
      runtime().options.link = link
    }
  })

  it('answers 429 with retryAt once the master locks the account', async () => {
    const b = browser()
    let last: Reply | undefined
    for (let i = 0; i < 6; i++) {
      last = await b.send('POST', '/api/v2/session', {
        body: { identifier: 'locked-out', clientHash: 'ab'.repeat(32) },
        headers: fromHost,
      })
      if (last.status === 429) break
      assert.equal(last.status, 401, last.text)
    }
    assert.equal(last!.status, 429, last!.text)
    assert.equal(typeof last!.json.retryAt, 'number')
  })

  it('refuses a sign-in to a role it does not know, keeping no session', async () => {
    const db = runtime().cache.db
    const role = db.prepare('UPDATE accounts SET role=? WHERE id=?')
    // A role from a newer master.
    role.run('owner', hugo)
    try {
      const b = browser()
      const refused = await signIn(b)
      assert.equal(refused.status, 401, refused.text)
      assert.deepEqual(refused.json, {
        error: 'This host does not know this account’s role; update the host',
      })
      // The cookie set for the session is cleared, and the session is gone.
      const [set, cleared] = refused.headers.getSetCookie()
      const token = /^__Host-mason-session=([^;]+)/.exec(set!)![1]
      assert.equal(runtime().accounts.session(token), undefined)
      assert.match(cleared!, /^__Host-mason-session=;/)
      assert.equal(b.cookie, undefined)
      assert.equal((await b.send('GET', '/api/v2/session')).status, 401)
    } finally {
      role.run('developer', hugo)
    }
    assert.equal((await signIn(browser())).status, 200)
  })
})

type Reply2 = FixtureReply

describe('Host web API: the pages’ reads, from its cache', function () {
  this.timeout(300_000)
  let f: ReadFixture
  let host: RunningNode
  const as = (role: Role): Who => f.on('host', role)
  const get = async (route: string, who: Who): Promise<Reply2> =>
    await f.request(host, 'GET', route, who)
  const post = async (
    route: string,
    who: Who,
    body: unknown = {},
  ): Promise<Reply2> => await f.request(host, 'POST', route, who, body)
  /** Every read the host answers itself, with the roles that may make it. */
  const reads = (): Array<[string, Role[]]> => {
    const developers: Role[] = ['developer', 'manager', 'admin']
    const everyone: Role[] = ['tester', ...developers]
    return [
      ['/api/v2/status', everyone],
      ['/api/v2/notifications', everyone],
      ['/api/v2/search?q=reads', everyone],
      ['/api/v2/dashboard', developers],
      ['/api/v2/queue', developers],
      ['/api/v2/artifacts', developers],
      [`/api/v2/artifacts/runs/${f.runs.built}`, developers],
      [
        `/api/v2/runs/${f.runs.built}?include=graph,steps,history,details`,
        developers,
      ],
      ['/api/v2/projects/reads/overview', developers],
      ['/api/v2/projects/reads/runs', developers],
      [`/api/v2/projects/reads/apps/${ALPHA}`, developers],
      ['/api/v2/projects/reads/masonfile/commits', developers],
      ['/api/v2/projects/reads/masonfile', developers],
      ['/api/v2/account', everyone],
      ['/api/v2/catalog/apps', everyone],
      ['/api/v2/devices', everyone],
      [`/api/v2/builds?run=${f.runs.built}`, everyone],
    ]
  }
  /** Master-only routes, which a host session may not reach through the forwarder. */
  const masterOnly = [
    '/api/v2/people',
    '/api/v2/groups/1',
    '/api/v2/apps',
    '/api/v2/apple/signing',
    '/api/v2/nodes',
    '/api/v2/cloud/budget',
    '/api/v2/projects/reads/secrets/backups',
    '/api/v2/settings/backup',
  ]

  before(async () => {
    f = await readFixture(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'hostreads-'),
      ),
    )
    host = f.host
  })
  after(async () => {
    await f?.c.close()
  })

  it('answers every read itself, for each role it allows, as the master would', async () => {
    for (const [route, allowed] of reads())
      for (const role of ['tester', 'developer', 'manager', 'admin'] as const) {
        const reply = await get(route, as(role))
        assert.equal(
          reply.status,
          allowed.includes(role) ? 200 : 403,
          `${role} ${route}: ${reply.text}`,
        )
      }
    for (const [route] of reads())
      assert.equal((await get(route, {})).status, 401, route)
    // The host's own answers, in the shared shapes.
    const status = shape(
      asStatusInfo,
      (await get('/api/v2/status', as('tester'))).json,
    )
    assert.deepEqual(status.link?.online, true)
    assert.equal(status.node, 'host')
    assert.equal(typeof status.link?.lastContact, 'number')
    assert.deepEqual(status.banners, [
      {
        kind: 'testEndpoints',
        text: 'Test endpoints are enabled on this Mason node.',
      },
    ])
    const manager = shape(
      asNotifications,
      (await get('/api/v2/notifications', as('manager'))).json,
    )
    // Approvals only: the master's notices are the master's.
    assert.deepEqual(
      manager.map((entry) => [entry.kind, entry.href]),
      [['approval', `/runs/${f.runs.waiting}`]],
    )
    const dashboard = shape(
      asDashboardData,
      (await get('/api/v2/dashboard', as('developer'))).json,
    )
    assert.equal(dashboard.nodes, undefined)
    assert.deepEqual(
      dashboard.projects.map((project) => project.slug),
      ['reads'],
    )
    const detail = shape(
      asArtifactRunDetail,
      (await get(`/api/v2/artifacts/runs/${f.runs.built}`, as('developer')))
        .json,
    )
    assert.equal(detail.artifactOrigin, '')
    assert.equal(
      detail.artifacts[0]!.url,
      `/runs/${f.runs.built}/artifacts/report.html`,
    )
    const route = `/api/v2/runs/${f.runs.built}?include=graph,steps,history,details`
    const onHost = shape(asRunPage, (await get(route, as('developer'))).json)
    const onMaster = (
      await f.request(f.c.master, 'GET', route, f.on('master', 'developer'))
    ).json
    for (const part of ['graph', 'layout', 'history', 'project'] as const)
      assert.deepEqual(onHost[part], onMaster[part], part)
    // The same artifacts, downloading from the host itself.
    assert.deepEqual(
      onHost.artifacts.map((artifact) => artifact.url),
      onMaster.artifacts.map((artifact: { url: string }) =>
        artifact.url.replace(/^https?:\/\/[^/]+/, ''),
      ),
    )
    assert.equal(onHost.artifacts.length > 0, true)
    assert.deepEqual(onHost.details?.buildNumber, onMaster.details.buildNumber)
    const overview = shape(
      asProjectOverview,
      (await get('/api/v2/projects/reads/overview', as('manager'))).json,
    )
    // The host's copy is read-only, with no Secrets tab; Request run reads
    // the workflows of the Masonfile its copy of the latest run recorded.
    assert.deepEqual([overview.canSeed, overview.secrets], [false, false])
    assert.deepEqual(
      overview.workflows?.map((workflow) => workflow.name),
      ['build', 'release'],
    )
    const runs = shape(
      asProjectRuns,
      (await get('/api/v2/projects/reads/runs', as('developer'))).json,
    )
    assert.equal(runs.more, false)
    const newest = shape(
      asProjectRuns,
      (await get('/api/v2/projects/reads/runs?limit=1', as('developer'))).json,
    )
    assert.deepEqual(
      [newest.runs.map((run) => run.id), newest.more],
      [[runs.runs[0]!.id], true],
    )
    const refused = await get(
      '/api/v2/projects/reads/runs?limit=0',
      as('developer'),
    )
    assert.equal(refused.status, 400)
    assert.equal(refused.json.error, 'limit is a whole number from 1 to 500')
    shape(
      asProjectApp,
      (await get(`/api/v2/projects/reads/apps/${ALPHA}`, as('developer'))).json,
    )
    const text = shape(
      asMasonfileText,
      (await get('/api/v2/projects/reads/masonfile', as('developer'))).json,
    )
    assert.match(text.text, /compiled/)
    const account = shape(
      asAccountInfo,
      (await get('/api/v2/account', as('tester'))).json,
    )
    assert.deepEqual(
      [account.id, account.editable, account.passwordHere],
      [f.people.tester, true, true],
    )
    assert.equal(
      (await get('/api/v2/account', as('developer'))).json.passwordHere,
      false,
    )
    // An API key the host verifies itself.
    assert.equal(
      (await get('/api/v2/dashboard', { key: f.keys.developer })).status,
      200,
    )
    assert.equal(
      (await get('/api/v2/dashboard', { key: f.keys.scoped })).status,
      403,
    )
    // The shell's reads are about the whole node, so a scoped key is refused.
    for (const route of ['/api/v2/status', '/api/v2/notifications']) {
      assert.equal((await get(route, { key: f.keys.developer })).status, 200)
      for (const key of [f.keys.scoped, f.keys.release])
        assert.equal((await get(route, { key })).status, 403, route)
    }
    assert.equal(
      (await get('/api/v2/account', { key: f.keys.developer })).status,
      401,
    )
  })

  it('keeps answering every read from its cache while the master is unreachable, and refuses master-only paths', async () => {
    const tester = as('tester') as { cookie: string; csrf: string }
    // With the master reachable, the forwarder refuses a host session.
    for (const route of masterOnly) {
      const reply = await get(route, as('admin'))
      assert.equal(reply.status, 403, `${route}: ${reply.text}`)
      assert.match(reply.json.error, /A host session may only/)
    }
    await f.c.drop('host', 1000, async () => {
      await f.c.until(() => !host.host!.online(), 5000, 'offline')
      proofLog(
        'mason: the master drops the host’s link (the host is offline)',
        `host.online() = ${String(host.host!.online())}`,
      )
      for (const [route, allowed] of reads()) {
        const role = allowed.includes('developer') ? 'developer' : 'tester'
        const reply = await get(route, as(role))
        assert.equal(reply.status, 200, `${route} offline: ${reply.text}`)
      }
      const status = shape(
        asStatusInfo,
        (await get('/api/v2/status', as('developer'))).json,
      )
      assert.equal(status.link?.online, false)
      assert.deepEqual(status.banners.at(-1), {
        kind: 'offline',
        text: 'The Mason master is unreachable. You are seeing the last synced builds.',
      })
      assert.equal(
        (await get('/api/v2/account', as('developer'))).json.editable,
        false,
      )
      // Master-only paths need the master.
      for (const route of masterOnly) {
        const reply = await get(route, as('admin'))
        assert.equal(reply.status, 503, `${route}: ${reply.text}`)
      }
      // Installs still work from the host's own storage.
      const install = await post(
        `/api/v2/catalog/builds/${f.build}/install`,
        tester,
      )
      assert.equal(install.status, 200, install.text)
      assert.equal(install.json.kind, 'download')
    })
    await f.c.until(() => host.host!.online(), 10_000, 'online')
    proofLog(
      'mason: the master redials the host (the host is online)',
      `host.online() = ${String(host.host!.online())}`,
    )
  })

  it('Install apps and Devices as JSON on the host', async () => {
    const tester = as('tester') as { cookie: string; csrf: string }
    const apps = shape(
      asAppsData,
      (await get('/api/v2/catalog/apps', tester)).json,
    )
    const id = apps.apps[0]!.id
    shape(asAppData, (await get(`/api/v2/catalog/apps/${id}`, tester)).json)
    const branch = shape(
      asBranchData,
      (
        await get(
          `/api/v2/catalog/apps/${id}/branches/${branchKey('master')}?platform=android`,
          tester,
        )
      ).json,
    )
    assert.equal(branch.builds[0]!.id, f.build)
    const install = shape(
      asInstallAnswer,
      (await post(`/api/v2/catalog/builds/${f.build}/install`, tester)).json,
    )
    assert.equal(install.kind, 'download')
    const file = await get(install.url!, {})
    assert.equal(file.status, 200)
    assert.equal(
      (
        await f.request(
          host,
          'POST',
          `/api/v2/catalog/builds/${f.build}/install`,
          { cookie: tester.cookie, csrf: 'not-it' },
          {},
        )
      ).status,
      403,
    )
    // An iOS build needs a registered device first.
    const ipa = await f.publish('ios', '30')
    assert.deepEqual(
      (await post(`/api/v2/catalog/builds/${ipa}/install`, tester)).json,
      { kind: 'register' },
    )
    const devices = shape(
      asDevicesData,
      (await get('/api/v2/devices', tester)).json,
    )
    assert.equal(devices.registration, true)
    const made = shape(
      asRegistrationAnswer,
      (await post('/api/v2/devices/registrations', tester)).json,
    )
    const profile = await get(made.url, {})
    assert.equal(profile.status, 200)
    assert.match(profile.text, /PayloadType/)
    assert.deepEqual(
      shape(
        asPrepareAnswer,
        (await post(`/api/v2/catalog/builds/${f.build}/prepare`, tester)).json,
      ),
      { prepared: false },
    )
    assert.deepEqual(
      (await get('/api/v2/devices/complete/nope', tester)).json,
      { state: 'unavailable' },
    )
    assert.equal(
      (await post('/api/v2/devices/424242/select', tester)).status,
      404,
    )
    // The host answers from its copies only.
    const copy = await get(
      `/api/v2/projects/reads/masonfile?commit=${'0'.repeat(40)}`,
      as('developer'),
    )
    assert.deepEqual(
      [copy.status, copy.json],
      [404, { error: 'The host has no copy of that commit’s Masonfile.' }],
    )
    assert.equal((await get('/api/v2/catalog/apps', {})).status, 401)
  })

  it('/live status on the host is its own link to the master, answered without the master', async () => {
    const url = host.web!.url.replace(/^https:\/\/[^:]+:/, 'wss://127.0.0.1:')
    const session = as('developer') as { cookie: string }
    const ws = new WebSocket(`${url}/live`, {
      headers: {
        cookie: session.cookie,
        origin: host.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:'),
      },
      rejectUnauthorized: false,
    })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const frames: Array<{ key?: string; event: string; data?: unknown }> = []
    ws.on('message', (data) => {
      frames.push(JSON.parse(String(data)) as (typeof frames)[number])
    })
    ws.send(JSON.stringify({ subscribe: 'status' }))
    ws.send(JSON.stringify({ subscribe: 'status', key: 'again' }))
    ws.send(JSON.stringify({ unsubscribe: 'again' }))
    ws.send(JSON.stringify({ subscribe: 'queue', key: 'queue' }))
    await f.c.until(() => frames.length >= 3, 5000, 'three frames')
    ws.close()
    proofLog(
      'WS host/live {subscribe:status} (developer session)',
      JSON.stringify(frames),
    )
    const status = frames.find((frame) => frame.key === 'status')!
    assert.equal(status.event, 'status')
    assert.equal(shape(asStatusInfo, status.data).link?.online, true)
    // The queue is still the master's, relayed.
    assert.equal(frames.find((frame) => frame.key === 'queue')?.event, 'queue')
  })

  it('answers a project with no app the same on its pages and its reads, as the master does', async () => {
    f.c.master.master!.saveProject(localOperator, 'appless', {
      name: 'Appless',
      repository: 'https://github.com/example/appless',
    })
    await f.c.until(
      () =>
        host
          .host!.cache.db.prepare(
            "SELECT 1 FROM projects WHERE slug='appless' AND details IS NOT NULL",
          )
          .get() != null,
      10_000,
      'the project on the host',
    )
    // A project's pages ask for the project and its reads for the role and
    // scope only, on either node: no app to see hides neither.
    for (const node of [f.c.master, host]) {
      const who = f.on(node === host ? 'host' : 'master', 'developer')
      for (const route of [
        '/projects/appless',
        '/projects/appless/runs',
        '/projects/appless/masonfile',
        '/api/v2/projects/appless/overview',
        '/api/v2/projects/appless/runs',
        '/api/v2/projects/appless/masonfile/commits',
      ]) {
        const reply = await f.request(node, 'GET', route, who)
        assert.equal(
          reply.status,
          200,
          `${node === host ? 'host' : 'master'} ${route}: ${reply.text}`,
        )
      }
    }
  })

  it('lists a branch-scoped key only its branches’ runs, artifacts and commits, on either node', async () => {
    const key = { key: f.keys.release }
    const cache = host.host!.cache.db
    // The host lists the commits it holds a Masonfile copy of.
    await f.c.until(
      () =>
        cache
          .prepare(
            "SELECT 1 FROM jobs j JOIN masonfiles m ON m.key=j.project_id || ':' || j.commit_sha WHERE j.id=? AND m.text IS NOT NULL",
          )
          .get(f.runs.waiting) != null,
      20_000,
      'the release run’s Masonfile on the host',
    )
    const release = String(
      cache
        .prepare('SELECT commit_sha FROM jobs WHERE id=?')
        .get(f.runs.waiting)!.commit_sha,
    )
    const master = String(
      cache.prepare('SELECT commit_sha FROM jobs WHERE id=?').get(f.runs.built)!
        .commit_sha,
    )
    for (const node of [f.c.master, host]) {
      const where = node === host ? 'host' : 'master'
      const read = async (route: string): Promise<Reply2> =>
        await f.request(node, 'GET', route, key)
      const onRelease = (runs: Array<{ id: string; branch: string }>): void => {
        assert(runs.length > 0, `${where}: no runs`)
        assert(
          runs.every((run) => run.branch === 'release'),
          `${where}: ${JSON.stringify(runs)}`,
        )
        assert(!runs.some((run) => run.id === f.runs.built), where)
      }
      // Without ?branch=, a project's runs and its branch list.
      const runs = shape(
        asProjectRuns,
        (await read('/api/v2/projects/reads/runs')).json,
      )
      onRelease(runs.runs)
      assert.deepEqual(
        runs.branches.map((entry) => entry.branch),
        ['release'],
        where,
      )
      assert.equal(runs.more, false, where)
      // Only build publishes alpha, and it ran on master.
      const app = (await read(`/api/v2/projects/reads/runs?app=${ALPHA}`)).json
      assert.deepEqual([app.branches, app.runs], [[], []], where)
      assert.equal(
        (await read('/api/v2/projects/reads/runs?branch=master')).status,
        403,
        where,
      )
      // Artifacts narrowed to the project, and the branches it offers.
      const artifacts = (await read('/api/v2/artifacts?project=reads')).json
      onRelease(artifacts.runs)
      assert.deepEqual(artifacts.branches, ['release'], where)
      // The Masonfile tab's commits, the one it shows, and another branch's.
      assert.deepEqual(
        (await read('/api/v2/projects/reads/masonfile/commits')).json,
        [{ sha: release, branch: 'release' }],
        where,
      )
      assert.equal(
        (await read('/api/v2/projects/reads/masonfile')).json.commit,
        release,
        where,
      )
      const other = await read(
        `/api/v2/projects/reads/masonfile?commit=${master}`,
      )
      assert.deepEqual(
        [other.status, other.json],
        [404, { error: 'No run this key covers has that commit.' }],
        where,
      )
      assert.equal(
        (await read('/api/v2/projects/reads/overview')).status,
        200,
        where,
      )
    }
  })

  it('answers a disabled project 404 on its pages and its reads, on either node', async () => {
    const m = f.c.master.master!
    const cache = host.host!.cache.db
    const onHost = async (enabled: number): Promise<void> => {
      await f.c.until(
        () =>
          cache
            .prepare(
              "SELECT 1 FROM projects WHERE slug='dormant' AND enabled=? AND details IS NOT NULL",
            )
            .get(enabled) != null,
        10_000,
        `the project on the host, enabled=${enabled}`,
      )
    }
    const routes = [
      '/projects/dormant',
      '/projects/dormant/runs',
      '/projects/dormant/masonfile',
      '/api/v2/projects/dormant/overview',
      '/api/v2/projects/dormant/runs',
      '/api/v2/projects/dormant/masonfile/commits',
    ]
    const answers = async (status: number): Promise<void> => {
      for (const node of [f.c.master, host]) {
        const who = f.on(node === host ? 'host' : 'master', 'admin')
        for (const route of routes) {
          const reply = await f.request(node, 'GET', route, who)
          assert.equal(
            reply.status,
            status,
            `${node === host ? 'host' : 'master'} ${route}: ${reply.text}`,
          )
        }
      }
    }
    m.saveProject(localOperator, 'dormant', {
      name: 'Dormant',
      repository: 'https://github.com/example/dormant',
      enabled: false,
    })
    try {
      await onHost(0)
      // One rule on both nodes: a disabled project is 404, even to an admin.
      await answers(404)
      m.saveProject(localOperator, 'dormant', { enabled: true })
      await onHost(1)
      await answers(200)
    } finally {
      m.projects.remove(localOperator, 'dormant')
    }
  })
})
