import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { fixture } from '../auth/providers.test.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { localOperator } from './roles.js'

const admin = localOperator

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
      email: 'alex@example.test',
    })
    await master.people.create(admin, {
      name: 'Jordan Lee',
      email: 'someone@example.test',
      addresses: { plain: 'jordan@example.test' },
    })
    await master.people.create(admin, {
      name: 'Dana Off',
      email: 'dana@example.test',
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
    return await b.get(callback.pathname + callback.search)
  }

  it('M1.1 without the master address the sign-in page offers only a password, and the provider routes are unavailable', async () => {
    const b = new Browser(c)
    const page = await (await b.get('/sign-in')).text()
    assert.match(page, /data-mason="sign-in"/)
    assert.doesNotMatch(page, /Sign in with/)
    const start = await b.get('/auth/start/first')
    assert.equal(start.status, 404)
    assert.match(await start.text(), /only its username and password/)
    assert.equal((await b.get('/auth/callback/first?state=x')).status, 404)
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
    const page = await (await b.get('/sign-in')).text()
    for (const id of ['first', 'second', 'plain'])
      assert(
        page.includes(`href="${origin}/auth/start/${id}?return=/"`),
        `${id} is offered`,
      )
    assert.doesNotMatch(page, /Sign in with Off/)
    assert.match(page, /data-mason="sign-in"/)
    const settings = await c.api('GET', '/api/v2/settings/master')
    assert.deepEqual(settings.json, { origin })
    // An administrator signed in with a provider sees each method's callbacks.
    await c.master.master!.people.create(admin, {
      name: 'Ada Admin',
      role: 'admin',
      email: 'ada@example.test',
    })
    const ada = new Browser(c)
    assert.equal(
      (await signIn(ada, 'first', { email: 'ada@example.test' })).status,
      200,
    )
    env.setClaims({})
    const shown = await (await ada.get('/settings')).text()
    for (const id of ['first', 'second', 'plain', 'off']) {
      assert(shown.includes(`https://builds.example.test/auth/callback/${id}`))
      assert(shown.includes(`${origin}/auth/callback/${id}`))
    }
    assert.match(shown, /name="origin" value="https:\/\/127\.0\.0\.1:/)
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
    assert.equal(done.status, 200)
    const html = await done.text()
    assert.match(html, /<meta http-equiv="refresh" content="0;url=\/nodes">/)
    const set = done.headers.getSetCookie().join('\n')
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
      const reply = await signIn(b, 'second', claims)
      assert.equal(reply.status, 403)
      assert.match(await reply.text(), reason)
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
    const disabled = await b.get('/auth/callback/off?state=x&code=y')
    assert.equal(disabled.status, 400)
    assert.match(await disabled.text(), /invalid or has expired/)
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
    assert.equal(late.status, 400)
    assert.match(await late.text(), /invalid or has expired/)
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
    const missing = await b.get(route)
    assert.equal(missing.status, 400)
    assert.match(await missing.text(), /invalid or has expired/)
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

  it('M1.6 a verified email matches whatever its case, and a person’s address for the method wins over another’s email', async () => {
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
    // Rows the API would refuse as a conflict, as an older master might hold.
    const master = c.master.master!
    const everywhere = await master.people.create(admin, {
      name: 'Email Everywhere',
      email: 'shared@example.test',
    })
    const second = await master.people.create(admin, {
      name: 'Second Only',
      email: 'second-only@example.test',
    })
    master.database.db
      .prepare(
        "INSERT INTO account_addresses(account_id,method,email) VALUES(?,'second','shared@example.test')",
      )
      .run(second.id)
    const whom = async (provider: string): Promise<string> => {
      const browser = new Browser(c)
      assert.equal(
        (await signIn(browser, provider, { email: 'Shared@example.test' }))
          .status,
        200,
      )
      return (
        (await (await browser.get('/api/v2/session')).json()) as {
          name: string
        }
      ).name
    }
    assert.equal(await whom('second'), 'Second Only')
    assert.equal(await whom('first'), everywhere.name)
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
      email: 'mona@example.test',
    })
    const mona = new Browser(c)
    assert.equal(
      (await signIn(mona, 'first', { email: 'mona@example.test' })).status,
      200,
    )
    env.setClaims({})
    const page = await (await mona.get('/settings')).text()
    assert(page.includes(`${origin}/auth/callback/first`), 'callbacks shown')
    assert.doesNotMatch(page, /data-path="\/api\/v2\/settings\/signIn/)
    assert.doesNotMatch(page, /data-path="\/api\/v2\/settings\/master"/)
    assert.match(page, /Only an administrator changes sign-in/)
  })

  it('M1.8 the master address cleared takes the buttons away again', async () => {
    await c.master.master!.settings.set(admin, 'master', {})
    const b = new Browser(c)
    assert.doesNotMatch(await (await b.get('/sign-in')).text(), /Sign in with/)
    assert.equal((await b.get('/auth/start/first')).status, 404)
  })
})
