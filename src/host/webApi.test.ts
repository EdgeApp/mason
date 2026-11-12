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
  asNodeInfo,
  asSessionInfo,
  asSignInReply,
} from '../shared/api/index.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { proofLog } from '../test/proofLog.js'
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
    // The old pages' sign-out form takes the same proof in its field.
    const form = await fetch(c.hosts.get('host')!.web!.url + '/auth/logout', {
      method: 'POST',
      redirect: 'manual',
      // @ts-expect-error undici's dispatcher option
      dispatcher: insecure,
      headers: {
        cookie: `${SESSION}=${b.cookie!}`,
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }),
    })
    assert.equal(form.status, 303)
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
})
