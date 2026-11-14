import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { fixture } from '../auth/providers.test.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { proofLog } from '../test/proofLog.js'
import { assertShell } from '../test/webShell.js'
import type { NodeInfo, SignInFlow } from '../shared/api/index.js'
import { localOperator } from './roles.js'

const admin = localOperator

// Replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** A browser on the master's listener: its cookies, no redirects followed. */
class Browser {
  readonly cookies = new Map<string, string>()
  constructor(
    readonly c: Cluster,
    readonly hostname = '127.0.0.1',
  ) {}
  async get(
    route: string,
    init: {
      method?: string
      headers?: Record<string, string>
      body?: string
    } = {},
  ): Promise<Awaited<ReturnType<typeof pinnedFetch>>> {
    const base = this.c.master.web!.url.replace(
      /\/\/[^:]+:/,
      `//${this.hostname}:`,
    )
    const response = await pinnedFetch(
      base + route,
      {
        ...init,
        redirect: 'manual',
        headers: {
          cookie: [...this.cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join('; '),
          ...init.headers,
        },
      },
      this.c.master.web!.certificate?.pin,
    )
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]!
      const index = pair.indexOf('=')
      if (pair.slice(index + 1) === '')
        this.cookies.delete(pair.slice(0, index))
      else this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    return response
  }
}

/** A reply that is the web app's shell: the provider sign-in state it carries, if any. */
async function shell(
  reply: Awaited<ReturnType<typeof pinnedFetch>>,
  status = 200,
): Promise<SignInFlow | undefined> {
  return assertShell(
    { status: reply.status, headers: reply.headers, text: await reply.text() },
    status,
  )
}

describe('Provider sign-in on the master', function () {
  this.timeout(120_000)
  let c: Cluster
  let env: Awaited<ReturnType<typeof fixture>>
  let origin: string
  before(async () => {
    const fixtureFetch: { transport?: typeof fetch } = {}
    c = await cluster(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'master-oidc-'),
      ),
      {
        masterOptions: {
          providerFetch: async (input, init) =>
            await fixtureFetch.transport!(input, init),
        },
      },
    )
    origin = c.master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
    env = await fixture(origin)
    fixtureFetch.transport = env.transport
    const master = c.master.master!
    await master.settings.set(admin, 'host', {
      origin: 'https://builds.example.test',
    })
    await master.settings.set(admin, 'signIn', {
      methods: [
        ...env.configs.map((config) => ({ ...config, enabled: true })),
        { ...env.configs[1]!, id: 'off', name: 'Off', enabled: false },
      ],
    })
    await master.people.create(admin, {
      name: 'Alex Lee',
      role: 'developer',
      emails: ['alex@example.test'],
    })
    await master.people.create(admin, {
      name: 'Jordan Lee',
      emails: ['someone@example.test', 'jordan@example.test'],
    })
    await master.people.create(admin, {
      name: 'Dana Off',
      emails: ['dana@example.test'],
      disabled: true,
    })
  })
  after(async () => {
    await c?.close()
    await env?.close()
  })

  /** Starts at the master, goes through the provider, and opens the callback. */
  const signIn = async (
    b: Browser,
    provider: string,
    claims: { email?: string; email_verified?: boolean } = {},
  ): ReturnType<Browser['get']> => {
    env.setClaims(claims)
    const start = await b.get(`/auth/start/${provider}?return=/nodes`)
    assert.equal(start.status, 303, await start.text())
    const callback = await env.authorize(start.headers.get('location')!)
    lastCallback = `GET ${callback.pathname}?code=<code>&state=<state>`
    return await b.get(callback.pathname + callback.search)
  }
  /** The last provider callback signIn opened, for the proof log. */
  let lastCallback = ''

  it('M1.1 without the master address the sign-in page offers only a password, and the provider routes are unavailable', async () => {
    const b = new Browser(c)
    // The web app draws the page from the node's description: no providers.
    assert.equal(await shell(await b.get('/sign-in')), undefined)
    const node = (await (await b.get('/api/v2/node')).json()) as NodeInfo
    assert.deepEqual(node.signIn, { password: true, providers: [] })
    assert.equal(node.masterOrigin, undefined)
    assert.deepEqual(await shell(await b.get('/auth/start/first'), 404), {
      state: 'unavailable',
    })
    assert.deepEqual(
      await shell(await b.get('/auth/callback/first?state=x'), 404),
      { state: 'unavailable' },
    )
  })

  it('M1.2 the master area takes an https origin or nothing', async () => {
    const settings = c.master.master!.settings
    await assert.rejects(
      settings.set(admin, 'master', { origin: 'http://mason.example.test' }),
      /HTTPS/,
    )
    await assert.rejects(
      settings.set(admin, 'master', { origin: 'https://m.example.test/x' }),
      /origin/,
    )
    assert.deepEqual(await settings.set(admin, 'master', { origin: '' }), {})
    assert.deepEqual(
      await settings.set(admin, 'master', {
        origin: 'https://Mason-Admin.example.test:9300/',
      }),
      { origin: 'https://mason-admin.example.test:9300' },
    )
    await settings.set(admin, 'master', { origin })
    assert.equal(c.master.master!.providerSignIn.origin(), origin)
  })

  it('M1.3 the sign-in page offers each enabled method at the master address, and Settings shows each method’s callbacks', async () => {
    const b = new Browser(c)
    // The web app's sign-in starts each offered method at the master address.
    await shell(await b.get('/sign-in'))
    const node = (await (await b.get('/api/v2/node')).json()) as NodeInfo
    assert.equal(node.masterOrigin, origin)
    assert.deepEqual(
      node.signIn.providers.map((provider) => provider.id),
      ['first', 'second', 'plain'],
    )
    assert.equal(node.signIn.password, true)
    const settings = await c.api('GET', '/api/v2/settings/master')
    assert.deepEqual(settings.json, { origin })
    // An administrator signed in with a provider sees each method's callbacks.
    await c.master.master!.people.create(admin, {
      name: 'Ada Admin',
      role: 'admin',
      emails: ['ada@example.test'],
    })
    const ada = new Browser(c)
    assert.equal(
      (await signIn(ada, 'first', { email: 'ada@example.test' })).status,
      200,
    )
    env.setClaims({})
    // Settings is the web app's: it draws each method's callback at the
    // host's and the master's address from the areas it reads.
    await shell(await ada.get('/settings'))
    const read = async (route: string): Promise<Json> => {
      const reply = await ada.get(route)
      assert.equal(reply.status, 200, route)
      return await reply.json()
    }
    assert.deepEqual(
      ((await read('/api/v2/settings/signIn')).methods as Json[]).map(
        (method) => method.id,
      ),
      ['first', 'second', 'plain', 'off'],
    )
    assert.equal(
      (await read('/api/v2/settings/host')).origin,
      'https://builds.example.test',
    )
    assert.equal((await read('/api/v2/settings/master')).origin, origin)
    assert.match(origin, /^https:\/\/127\.0\.0\.1:/)
  })

  it('M1.4 a verified email that is a person’s signs them in on the master; the flow moves to the master address first', async () => {
    // A browser that opened the master at another name is sent to its address.
    const elsewhere = new Browser(c, 'localhost')
    const moved = await elsewhere.get('/auth/start/first?return=/nodes')
    assert.equal(moved.status, 303)
    assert.equal(
      moved.headers.get('location'),
      `${origin}/auth/start/first?return=/nodes`,
    )
    assert.equal(elsewhere.cookies.size, 0)

    const b = new Browser(c)
    const done = await signIn(b, 'first')
    const set = done.headers.getSetCookie().join('\n')
    // The web app moves on from the master's own origin.
    assert.deepEqual(await shell(done), { state: 'signedIn', next: '/nodes' })
    assert.match(set, /__Host-mason-master=[^;]+;.*HttpOnly/)
    assert.match(set, /SameSite=Strict/)
    assert.match(set, /__Host-mason-master-oauth=;/, 'the flow cookie goes')
    const session = await b.get('/api/v2/session')
    assert.equal(session.status, 200)
    const body = (await session.json()) as { name: string; role: string }
    assert.equal(body.name, 'Alex Lee')
    assert.equal(body.role, 'developer')
    // Signed in, the start sends the browser home.
    const again = await b.get('/auth/start/first')
    assert.equal(again.headers.get('location'), '/')
    const audit = c.master
      .master!.database.db.prepare(
        "SELECT target FROM audit WHERE action='session.provider'",
      )
      .all()
      .map((row) => row.target)
    assert.deepEqual(audit, ['first', 'first'])

    // A plain OAuth 2 method matches the person's address for that method.
    const plain = new Browser(c)
    assert.equal((await signIn(plain, 'plain')).status, 200)
    const jordan = (await (await plain.get('/api/v2/session')).json()) as {
      name: string
    }
    assert.equal(jordan.name, 'Jordan Lee')
  })

  it('M1.5 refuses an unknown, unverified or disabled person, a disabled method, and a broken or replayed flow', async () => {
    const refusal = async (
      claims: { email?: string; email_verified?: boolean },
      reason: RegExp,
    ): Promise<void> => {
      const b = new Browser(c)
      const flow = await shell(await signIn(b, 'second', claims), 403)
      assert.equal(flow?.state, 'failed')
      assert.match((flow as { message: string }).message, reason)
      assert.equal(b.cookies.get('__Host-mason-master'), undefined)
    }
    await refusal(
      { email: 'stranger@example.test' },
      /No Mason account has stranger@example.test for second/,
    )
    await refusal(
      { email: 'alex@example.test', email_verified: false },
      /did not confirm a verified email/,
    )
    await refusal({ email: 'dana@example.test' }, /No Mason account/)
    env.setClaims({})

    const b = new Browser(c)
    assert.equal((await b.get('/auth/start/off')).status, 400)
    const expired = {
      state: 'failed',
      message: 'The sign-in is invalid or has expired.',
    }
    assert.deepEqual(
      await shell(await b.get('/auth/callback/off?state=x&code=y'), 400),
      expired,
    )
    // A method disabled while a browser is at the provider signs nobody in.
    const midway = new Browser(c)
    const begun = await midway.get('/auth/start/second?return=/')
    assert.equal(begun.status, 303)
    const back = await env.authorize(begun.headers.get('location')!)
    const settings = c.master.master!.settings
    const enabled = settings.value('signIn')
    await settings.set(admin, 'signIn', {
      methods: [
        ...env.configs.map((config) => ({
          ...config,
          enabled: config.id !== 'second',
        })),
        { ...env.configs[1]!, id: 'off', name: 'Off', enabled: false },
      ],
    })
    const late = await midway.get(back.pathname + back.search)
    assert.deepEqual(await shell(late, 400), expired)
    assert.equal(midway.cookies.get('__Host-mason-master'), undefined)
    assert.equal((await midway.get('/api/v2/session')).status, 401)
    await settings.set(admin, 'signIn', enabled)
    assert.equal((await b.get('/auth/start/BAD')).status, 400)

    // No flow cookie, a wrong one, a replayed callback and a forged state.
    const start = await b.get('/auth/start/first')
    const callback = await env.authorize(start.headers.get('location')!)
    const route = callback.pathname + callback.search
    const flow = b.cookies.get('__Host-mason-master-oauth')!
    b.cookies.delete('__Host-mason-master-oauth')
    assert.deepEqual(await shell(await b.get(route), 400), expired)
    b.cookies.set('__Host-mason-master-oauth', 'x'.repeat(43))
    assert.equal((await b.get(route)).status, 400)
    b.cookies.set('__Host-mason-master-oauth', flow)
    assert.equal((await b.get(route)).status, 200)
    b.cookies.delete('__Host-mason-master')
    b.cookies.set('__Host-mason-master-oauth', flow)
    assert.equal((await b.get(route)).status, 400, 'used once')
    assert.equal(
      (await b.get('/auth/callback/first?state=a&state=b')).status,
      400,
    )
  })

  it('M1.6 a verified email matches whatever its case, and any of a person’s confirmed emails signs them in through any method', async () => {
    const b = new Browser(c)
    assert.equal(
      (await signIn(b, 'first', { email: 'ALEX@Example.TEST' })).status,
      200,
    )
    assert.equal(
      ((await (await b.get('/api/v2/session')).json()) as { name: string })
        .name,
      'Alex Lee',
    )
    const master = c.master.master!
    const both = await master.people.create(admin, {
      name: 'Two Addresses',
      emails: ['first-address@example.test', 'second-address@example.test'],
    })
    const whom = async (provider: string, email: string): Promise<string> => {
      const browser = new Browser(c)
      const reply = await signIn(browser, provider, { email })
      assert.equal(reply.status, 200)
      const session = await browser.get('/api/v2/session')
      const name = ((await session.json()) as { name: string }).name
      proofLog(
        `${lastCallback}    # on the master, ${provider} verified ${email}`,
        `HTTP ${reply.status}\nSet-Cookie: ${(reply.headers.get('set-cookie') ?? '(none)').replace(/(__Host-[\w-]+)=([^;]+)/g, '$1=<redacted>')}\n$ GET /api/v2/session\nHTTP ${session.status} {"name":"${name}"}`,
      )
      return name
    }
    for (const provider of ['first', 'second'])
      for (const email of [
        'first-address@example.test',
        'Second-Address@example.test',
      ])
        assert.equal(await whom(provider, email), both.name)
    // An unconfirmed address signs nobody in.
    master.database.db
      .prepare(
        'INSERT INTO account_emails(account_id,email,position,confirmed) VALUES(?,?,2,0)',
      )
      .run(both.id, 'claimed@example.test')
    const refused = await signIn(new Browser(c), 'first', {
      email: 'claimed@example.test',
    })
    assert.notEqual(refused.status, 200)
    env.setClaims({})
  })

  it('M1.7 only an administrator changes sign-in methods or the master address; a manager sees them without editors', async () => {
    const master = c.master.master!
    const key = (role: 'manager' | 'admin'): string =>
      master.keys.create(admin, { role, name: `sign-in ${role}` }).token
    const manager = key('manager')
    const method = {
      type: 'oidc',
      name: 'Mine',
      issuer: 'https://idp.example.test',
      clientId: 'mine',
      clientSecret: 'mine-secret',
    }
    for (const [verb, route, body] of [
      ['PUT', '/api/v2/settings/signIn/methods/mine', method],
      ['DELETE', '/api/v2/settings/signIn/methods/first', undefined],
      [
        'PUT',
        '/api/v2/settings/master',
        { origin: 'https://evil.example.test' },
      ],
      ['PUT', '/api/v2/settings/signIn', { methods: [] }],
    ] as const) {
      const reply = await c.api(verb, route, body, manager)
      assert.equal(reply.status, 403, `${verb} ${route}: ${reply.text}`)
    }
    assert.equal(master.providerSignIn.origin(), origin)
    assert.equal(master.providerSignIn.methods().length, 3)
    // A manager may still read them, and change other settings.
    assert.equal(
      (await c.api('GET', '/api/v2/settings/signIn', undefined, manager))
        .status,
      200,
    )
    const owner = key('admin')
    const added = await c.api(
      'PUT',
      '/api/v2/settings/signIn/methods/mine',
      method,
      owner,
    )
    assert.equal(added.status, 200, added.text)
    assert.equal(
      (
        await c.api(
          'DELETE',
          '/api/v2/settings/signIn/methods/mine',
          undefined,
          owner,
        )
      ).status,
      200,
    )
    assert.equal(
      (await c.api('PUT', '/api/v2/settings/master', { origin }, owner)).status,
      200,
    )
    await master.people.create(admin, {
      name: 'Mona Manager',
      role: 'manager',
      emails: ['mona@example.test'],
    })
    const mona = new Browser(c)
    assert.equal(
      (await signIn(mona, 'first', { email: 'mona@example.test' })).status,
      200,
    )
    env.setClaims({})
    // A manager reads the methods and the master address, whose callbacks
    // Settings shows, but only an administrator changes sign-in.
    await shell(await mona.get('/settings'))
    const methods = await mona.get('/api/v2/settings/signIn')
    assert.equal(methods.status, 200)
    assert(
      ((await methods.json()) as { methods: Json[] }).methods.some(
        (method) => method.id === 'first',
      ),
    )
    const masterArea = await mona.get('/api/v2/settings/master')
    assert.deepEqual(await masterArea.json(), { origin })
    const session = (await (await mona.get('/api/v2/session')).json()) as {
      permissions: string[]
    }
    assert(!session.permissions.includes('signIn.change'))
  })

  it('M1.8 the master address cleared takes the buttons away again', async () => {
    await c.master.master!.settings.set(admin, 'master', {})
    const b = new Browser(c)
    const node = (await (await b.get('/api/v2/node')).json()) as NodeInfo
    assert.deepEqual(node.signIn.providers, [])
    assert.equal((await b.get('/auth/start/first')).status, 404)
  })
})
