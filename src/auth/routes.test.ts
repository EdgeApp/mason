import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Request, Response as ExpressResponse } from 'express'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { Agent } from 'undici'
import { run } from '../cli.js'
import { asConfig } from '../config.js'
import { localOperator } from '../master/roles.js'
import type { RunningNode } from '../node/serve.js'
import type { SignInFlow } from '../shared/api/index.js'
import { digest, Store } from '../store.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { assertShell } from '../test/webShell.js'
import { Accounts, randomToken } from './accounts.js'
import { clientPasswordHash } from './passwordKdf.js'
import { clientParameters, DEFAULT_PASSWORD_COSTS } from './passwordProtocol.js'
import { Providers } from './providers.js'
import { fixture } from './providers.test.js'
import {
  authLimiter,
  csrf,
  passwordRefusal,
  returnPath,
  SESSION_COOKIE,
} from './routes.js'

// Replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const ORIGIN = 'https://builds.example.test'
const FLOW_COOKIE = '__Host-mason-oauth'
const admin = localOperator
const insecure = new Agent({ connect: { rejectUnauthorized: false } })
/** What the web app shows for a refused sign-in request. */
const INVALID = {
  state: 'invalid',
  message:
    'The request is invalid or has expired. Return to sign in and try again.',
}

/** A browser on the host's HTTPS listener: its cookies, no redirects followed. */
class Browser {
  readonly cookies = new Map<string, string>()
  constructor(readonly base: () => string) {}
  async get(url: string, init: RequestInit = {}): Promise<Response> {
    const parsed = new URL(url, ORIGIN)
    const response = await fetch(
      this.base() + parsed.pathname + parsed.search,
      {
        ...init,
        redirect: 'manual',
        // @ts-expect-error undici's dispatcher option
        dispatcher: insecure,
        headers: {
          cookie: [...this.cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join('; '),
          ...(init.headers as Record<string, string>),
        },
      },
    )
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]!
      const index = pair.indexOf('=')
      // The session and the flow cookie are host-only, secure and script-free.
      assert(
        value.includes('HttpOnly') &&
          value.includes('Secure') &&
          value.includes('SameSite=Lax') &&
          value.includes('Path=/'),
        value,
      )
      if (pair.slice(index + 1) === '')
        this.cookies.delete(pair.slice(0, index))
      else this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    return response
  }
  /** A form post, from the host's own origin unless `headers` say otherwise. */
  async post(
    url: string,
    body: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return await this.get(url, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body: new URLSearchParams(body),
    })
  }
  /** A JSON post, as the web app sends it. */
  async json(
    url: string,
    value: unknown,
    headers: Record<string, string> = { origin: ORIGIN },
  ): Promise<Response> {
    return await this.get(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    })
  }
}

/** A reply that is the web app's shell: the sign-in state it carries, if any. */
async function shell(
  reply: Response,
  status = 200,
): Promise<SignInFlow | undefined> {
  return assertShell(
    { status: reply.status, headers: reply.headers, text: await reply.text() },
    status,
  )
}

describe('Mason sign-in routes', () => {
  it('bounds new clients without locking out existing clients at saturation', () => {
    let time = 1,
      accepted = 0,
      rejected = 0
    const limit = authLimiter(() => time)
    const response = {
      status: (code: number): object => {
        assert.equal(code, 429)
        rejected++
        return { send: () => undefined }
      },
    } as ExpressResponse
    const request = (id: number): void => {
      limit({ ip: `2001:db8::${id.toString(16)}` } as Request, response, () => {
        accepted++
      })
    }
    for (let i = 0; i < 10000; ++i) request(i)
    assert.equal(accepted, 10000)
    for (let i = 10000; i < 11000; ++i) request(i)
    assert.equal(rejected, 1000)
    request(0)
    assert.equal(accepted, 10001)
    for (let i = 0; i < 120; ++i) request(0)
    assert.equal(rejected, 1002)
    time += 60001
    request(11000)
    assert.equal(accepted, 10120)
    // A request with no address shares one bucket.
    limit({} as Request, response, () => {
      accepted++
    })
    assert.equal(accepted, 10121)
  })

  it('checks return paths, and says why a refused password relay failed', () => {
    for (const value of [
      '//hostile.example.test',
      '/\\hostile.example.test',
      '/auth/start/first',
      '/x#fragment',
      '/\n/x',
      '/\t/hostile.example.test',
      '/\r/hostile.example.test',
      'https://hostile.example.test',
      'x'.repeat(1025),
    ])
      assert.throws(() => returnPath(value))
    assert.equal(returnPath(undefined), '/')
    assert.equal(returnPath('/apps/1?platform=ios'), '/apps/1?platform=ios')
    const unreachable = Object.assign(new Error('down'), { code: 'closed' })
    assert.equal(passwordRefusal(unreachable).status, 503)
    assert.equal(
      passwordRefusal(Object.assign(new Error('slow'), { code: 'timeout' }))
        .status,
      503,
    )
    assert.deepEqual(passwordRefusal(new Error('wrong password')), {
      status: 401,
      body: { error: 'wrong password' },
    })
    assert.deepEqual(
      passwordRefusal(
        new Error(JSON.stringify({ error: 'Locked', retryAt: 42 })),
      ),
      { status: 401, body: { error: 'Locked', retryAt: 42 } },
    )
  })
})

describe('Mason sign-in routes on a host', function () {
  this.timeout(120_000)
  let c: Cluster
  let env: Awaited<ReturnType<typeof fixture>>
  const people: Record<string, { id: number; name: string }> = {}
  const runtime = (): NonNullable<RunningNode['host']> =>
    c.hosts.get('host')!.host!
  const browser = (): Browser =>
    new Browser(() => c.hosts.get('host')!.web!.url)
  const token = (b: Browser): string | undefined =>
    b.cookies.get(SESSION_COOKIE)
  /** The host session a browser holds. */
  const context = (
    b: Browser,
  ): NonNullable<ReturnType<Accounts['session']>> => {
    const value = runtime().accounts.session(token(b))
    assert(value, 'a host session')
    return value
  }
  const onHost = (id: number): boolean =>
    runtime()
      .cache.db.prepare('SELECT 1 FROM accounts WHERE id=? AND disabled=0')
      .get(id) != null
  const methods = (admitTesters?: string): Json[] =>
    env.configs.map((config) => ({
      ...config,
      clientSecret: { keep: true },
      enabled: true,
      ...(admitTesters === config.id ? { admitTesters: true } : {}),
    }))

  before(async () => {
    env = await fixture(ORIGIN)
    c = await cluster(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'routes-'),
      ),
    )
    const master = c.master.master!
    await master.settings.set(admin, 'host', { origin: ORIGIN })
    await master.settings.set(admin, 'signIn', {
      methods: env.configs.map((config) => ({ ...config, enabled: true })),
    })
    // The fixture's OIDC providers assert alex@ unless told otherwise; its
    // plain OAuth provider asserts jordan@.
    for (const [key, name, email] of [
      ['alex', 'Alex Lee', 'alex@example.test'],
      ['blake', 'Blake Doe', 'blake@example.test'],
      ['jordan', 'Jordan Lee', 'jordan@example.test'],
    ] as const)
      people[key] = await master.people.create(admin, {
        name,
        role: 'developer',
        emails: [email],
      })
    const p = clientParameters('b1'.repeat(16), DEFAULT_PASSWORD_COSTS)
    people.hugo = await master.people.create(admin, {
      name: 'Hugo',
      emails: ['hugo@example.test'],
      username: 'hugo',
      role: 'developer',
      password: {
        clientHash: await clientPasswordHash('Hugo-Horse-9', p),
        clientParameters: p,
      },
    })
    await c.startHost('host', { hostOptions: { transport: env.transport } })
    await c.until(
      () => Object.values(people).every((person) => onHost(person.id)),
      5000,
      'the people on the host',
    )
    await c.until(
      () => runtime().cache.signInMethods().length === 3,
      5000,
      'the sign-in methods on the host',
    )
  })
  after(async () => {
    await c?.close()
    await env?.close()
  })
  // Every request here comes from one address: each case starts a fresh
  // minute of the sign-in limiter on the host's clock.
  beforeEach(() => {
    runtime().advanceClock(60_001)
  })
  afterEach(() => {
    env.setClaims({})
    env.selectSubject('fixture-subject')
  })

  /** Starts a provider sign-in; answers the provider's callback address on the host. */
  const start = async (
    b: Browser,
    provider: string,
    destination = '/',
    cookies?: Map<string, string>,
  ): Promise<string> => {
    const started = await b.get(
      `/auth/start/${provider}?return=${encodeURIComponent(destination)}`,
    )
    assert.equal(started.status, 303, await started.text())
    const callback = await env.authorize(
      started.headers.get('location')!,
      cookies,
    )
    assert.equal(callback.origin, ORIGIN)
    return callback.pathname + callback.search
  }
  /** Signs in through a provider with the claims given; answers the callback's reply. */
  const signIn = async (
    b: Browser,
    provider: string,
    claims: { email?: string; email_verified?: boolean } = {},
  ): Promise<Response> => {
    env.setClaims(claims)
    return await b.get(await start(b, provider))
  }

  it('continues to the provider and back to the requested destination; the web app signs out with the session’s proof', async () => {
    const b = browser()
    const destination = '/apps/edge?platform=ios'
    const started = await b.get(
      '/auth/start/first?return=' + encodeURIComponent(destination),
    )
    assert.equal(started.status, 303)
    const target = new URL(started.headers.get('location')!)
    assert.equal(target.origin, env.origin)
    assert.equal(target.searchParams.get('prompt'), null)
    assert(b.cookies.has(FLOW_COOKIE))
    assert.equal(token(b), undefined)
    const callback = await env.authorize(target.href)
    const done = await b.get(callback.pathname + callback.search)
    assert.equal(done.status, 303)
    assert.equal(done.headers.get('location'), destination)
    // The flow cookie goes; the session's is the host's own.
    assert(!b.cookies.has(FLOW_COOKIE))
    assert.equal(context(b).account.id, people.alex!.id)
    assert.notEqual(
      runtime()
        .cache.db.prepare('SELECT hash FROM sessions WHERE hash=?')
        .get(digest(token(b)!))?.hash,
      token(b),
    )
    // The plain OAuth provider continues the same way, signed out.
    const plain = browser()
    assert.equal((await signIn(plain, 'plain')).status, 303)
    assert.equal(context(plain).account.id, people.jordan!.id)
    // The web app signs out with DELETE /api/v2/session and the proof.
    const previous = token(b)!
    const proof = context(b).session.csrf
    const out = await b.get('/api/v2/session', {
      method: 'DELETE',
      headers: { origin: ORIGIN, 'x-mason-csrf': proof },
    })
    assert.equal(out.status, 200, await out.text())
    assert.equal(token(b), undefined)
    assert.equal(runtime().accounts.session(previous), undefined)
  })

  it('binds one-use callbacks to provider, browser, session and expiry', async () => {
    const b = browser()
    const callback = await start(b, 'first')
    // Another browser, without the flow cookie or with another one.
    const other = browser()
    assert.deepEqual(await shell(await other.get(callback), 400), INVALID)
    other.cookies.set(FLOW_COOKIE, randomToken())
    assert.deepEqual(await shell(await other.get(callback), 400), INVALID)
    // Another provider's callback address.
    assert.deepEqual(
      await shell(
        await b.get(
          callback.replace('/auth/callback/first', '/auth/callback/second'),
        ),
        400,
      ),
      INVALID,
    )
    // A session that changed while the browser was at the provider.
    b.cookies.set(SESSION_COOKIE, randomToken())
    assert.deepEqual(await shell(await b.get(callback), 400), INVALID)
    b.cookies.delete(SESSION_COOKIE)
    // This browser, once.
    assert.equal((await b.get(callback)).status, 303)
    assert(token(b) != null)
    b.cookies.delete(SESSION_COOKIE)
    assert.deepEqual(await shell(await b.get(callback), 400), INVALID)
    // Ten minutes later the flow has expired.
    const late = browser()
    const expired = await start(late, 'first')
    runtime().advanceClock(600_001)
    assert.deepEqual(await shell(await late.get(expired), 400), INVALID)
    assert.equal(token(late), undefined)
    runtime().accounts.prune()
    assert.equal(
      runtime()
        .cache.db.prepare('SELECT COUNT(*) total FROM oauth_transactions')
        .get()?.total,
      0,
    )
    // A broken start or callback is the web app's to explain.
    const anonymous = browser()
    for (const route of [
      '/auth/start/unknown',
      '/auth/start/BAD',
      '/auth/start/first?return=https://hostile.example.test',
      '/auth/start/first?return=/auth/login',
      '/auth/start/first?return=/%09/hostile.example.test',
      '/auth/callback/first?state=a&state=b',
      '/auth/callback/first?state=x&code=y',
      '/auth/login?return=https://hostile.example.test',
      '/auth/login?return=/%09/hostile.example.test',
      '/auth/login?return=/%0A/hostile.example.test',
    ])
      assert.deepEqual(
        await shell(await anonymous.get(route), 400),
        INVALID,
        route,
      )
    // Two session cookies are none: the start continues as signed out.
    const twice = await anonymous.get('/auth/start/first', {
      headers: { cookie: `${SESSION_COOKIE}=a; ${SESSION_COOKIE}=b` },
    })
    assert.equal(twice.status, 303)
  })

  it('distinguishes provider identities and unverified email claims before granting access', async () => {
    const identities = (account: number): Json[] =>
      runtime()
        .cache.db.prepare(
          'SELECT provider,issuer,subject,email,email_verified FROM identities WHERE account_id=? ORDER BY provider',
        )
        .all(account)
    // An unverified email signs nobody in, whoever has it.
    const unverified = browser()
    assert.deepEqual(
      await shell(
        await signIn(unverified, 'first', {
          email: 'alex@example.test',
          email_verified: false,
        }),
        400,
      ),
      {
        state: 'invalid',
        message: 'The provider did not confirm a verified email',
      },
    )
    assert.equal(token(unverified), undefined)
    // A verified email nobody has signs nobody in.
    assert.deepEqual(
      await shell(
        await signIn(browser(), 'second', { email: 'stranger@example.test' }),
        400,
      ),
      {
        state: 'invalid',
        message: 'No Mason account has stranger@example.test for second',
      },
    )
    // Each provider's identity is its own row, for the account its verified email names.
    for (const provider of ['first', 'second']) {
      const b = browser()
      assert.equal(
        (await signIn(b, provider, { email: 'Blake@Example.test' })).status,
        303,
      )
      assert.equal(context(b).account.id, people.blake!.id)
    }
    const rows = identities(people.blake!.id)
    assert.deepEqual(
      rows.map((row) => [row.provider, row.subject, row.email_verified]),
      [
        ['first', 'fixture-subject', 1],
        ['second', 'fixture-subject', 1],
      ],
    )
    assert.notEqual(rows[0].issuer, rows[1].issuer)
    // A method that admits testers asks the master to add a verified newcomer.
    const master = c.master.master!
    await master.settings.set(admin, 'signIn', { methods: methods('second') })
    await c.until(
      () => runtime().cache.admitsTesters('second'),
      5000,
      'admission on the host',
    )
    try {
      assert.deepEqual(
        await shell(
          await signIn(browser(), 'second', {
            email: 'casey@example.test',
            email_verified: false,
          }),
          400,
        ),
        {
          state: 'invalid',
          message: 'The provider did not confirm a verified email',
        },
      )
      assert.deepEqual(
        await shell(
          await signIn(browser(), 'first', { email: 'casey@example.test' }),
          400,
        ),
        {
          state: 'invalid',
          message: 'No Mason account has casey@example.test for first',
        },
      )
      const casey = browser()
      assert.equal(
        (await signIn(casey, 'second', { email: 'casey@example.test' })).status,
        303,
      )
      const admitted = context(casey).account
      const row = master.database.db
        .prepare('SELECT role FROM accounts WHERE id=?')
        .get(admitted.id) as { role: string }
      assert.equal(row.role, 'tester')
      assert.deepEqual(
        identities(admitted.id).map((entry) => entry.provider),
        ['second'],
      )
    } finally {
      await master.settings.set(admin, 'signIn', { methods: methods() })
      await c.until(
        () => !runtime().cache.admitsTesters('second'),
        5000,
        'admission off again',
      )
    }
  })

  it('requires CSRF approval to switch accounts and rotates the previous session', async () => {
    const b = browser()
    assert.equal((await signIn(b, 'first')).status, 303)
    const previous = token(b)!
    const proof = context(b).session.csrf
    // Signed in, another provider asks first, with the session's proof.
    assert.deepEqual(
      await shell(await b.get('/auth/start/second?return=/apps')),
      {
        state: 'switch',
        name: 'Alex Lee',
        provider: { id: 'second', name: 'second' },
        csrf: proof,
        return: '/apps',
      },
    )
    assert(!b.cookies.has(FLOW_COOKIE))
    // Without the proof, or from elsewhere, nothing switches.
    for (const [body, headers] of [
      [{ csrf: 'bad', return: '/' }, {}],
      [{ return: '/' }, {}],
      [
        { csrf: proof, return: '/' },
        { origin: 'https://hostile.example.test' },
      ],
      [{ csrf: proof, return: '//hostile.example.test' }, {}],
    ] as const)
      assert.deepEqual(
        await shell(
          await b.post('/auth/switch/second', { ...body }, { ...headers }),
          400,
        ),
        INVALID,
      )
    assert(!b.cookies.has(FLOW_COOKIE))
    assert.equal(context(b).account.id, people.alex!.id)
    // Signed out, there is no session to switch from.
    assert.deepEqual(
      await shell(
        await browser().post('/auth/switch/second', {
          csrf: proof,
          return: '/',
        }),
        400,
      ),
      INVALID,
    )
    // Confirmed, the web app links to the provider's account chooser.
    const choose = await shell(
      await b.post('/auth/switch/second', { csrf: proof, return: '/apps' }),
    )
    assert.equal(choose?.state, 'chooseAccount')
    const { provider, target } = choose as Extract<
      SignInFlow,
      { state: 'chooseAccount' }
    >
    assert.equal(provider, 'second')
    assert.equal(new URL(target).searchParams.get('prompt'), 'login')
    assert(b.cookies.has(FLOW_COOKIE))
    env.setClaims({ email: 'blake@example.test' })
    const callback = await env.authorize(target)
    const switched = await b.get(callback.pathname + callback.search)
    assert.equal(switched.status, 303)
    assert.equal(switched.headers.get('location'), '/apps')
    assert.equal(runtime().accounts.session(previous), undefined)
    assert.notEqual(token(b), previous)
    assert.equal(context(b).account.id, people.blake!.id)
  })

  it('requests reauthentication when switching within an active OIDC provider session', async () => {
    const providerCookies = new Map<string, string>()
    const b = browser()
    const first = await start(b, 'first', '/', providerCookies)
    assert.equal((await b.get(first)).status, 303)
    const previous = token(b)!
    env.selectSubject('fixture-switched-subject')
    // Without a prompt the provider would sign the same person in again.
    const providers = new Providers(ORIGIN, env.configs, env.transport)
    const proof = {
      state: randomToken(),
      verifier: randomToken(),
      nonce: randomToken(),
    }
    const reused = await env.authorize(
      await providers.authorize('first', proof),
      providerCookies,
    )
    assert.equal(
      (await providers.identity('first', reused, proof)).subject,
      'fixture-subject',
    )
    const choose = (await shell(
      await b.post('/auth/switch/first', {
        csrf: context(b).session.csrf,
        return: '/',
      }),
    )) as Extract<SignInFlow, { state: 'chooseAccount' }>
    assert.equal(choose.state, 'chooseAccount')
    assert.equal(new URL(choose.target).searchParams.get('prompt'), 'login')
    env.setClaims({ email: 'blake@example.test' })
    const callback = await env.authorize(choose.target, providerCookies)
    assert.equal((await b.get(callback.pathname + callback.search)).status, 303)
    assert.equal(context(b).account.id, people.blake!.id)
    assert.equal(runtime().accounts.session(previous), undefined)
    assert.deepEqual(
      {
        ...runtime()
          .cache.db.prepare(
            "SELECT account_id FROM identities WHERE provider='first' AND subject='fixture-switched-subject'",
          )
          .get(),
      },
      { account_id: people.blake!.id },
    )
  })

  it('explains an unconfigured OAuth provider account switch without promising a choice', async () => {
    const b = browser()
    assert.equal((await signIn(b, 'first')).status, 303)
    assert.deepEqual(await shell(await b.get('/auth/start/plain')), {
      state: 'switchUnavailable',
    })
    assert.deepEqual(
      await shell(
        await b.post('/auth/switch/plain', {
          csrf: context(b).session.csrf,
          return: '/',
        }),
        400,
      ),
      INVALID,
    )
    assert(!b.cookies.has(FLOW_COOKIE))
    assert.equal(context(b).account.id, people.alex!.id)
  })

  it('accepts private same-origin forms only with trusted Fetch Metadata and the session proof', async () => {
    const b = browser()
    assert.equal((await signIn(b, 'first')).status, 303)
    const { session } = context(b)
    const store = runtime().cache.store
    function form(
      headers: Record<string, string>,
      proof: unknown = session.csrf,
    ): Request {
      return {
        get: (name: string): string | undefined => headers[name],
        body: { csrf: proof },
      } as Request
    }
    const headers = {
      origin: 'null',
      'sec-fetch-site': 'same-origin',
      host: 'builds.example.test',
    }
    csrf(form(headers), store, session)
    assert.throws(() => csrf(form(headers, 'wrong'), store, session))
    assert.throws(() => csrf(form(headers, 42), store, session))
    for (const changed of [
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site' },
      { host: 'hostile.example.test' },
      { origin: 'https://hostile.example.test' },
    ])
      assert.throws(
        () => csrf(form({ ...headers, ...changed }), store, session),
        /Untrusted origin/,
      )
    // The web app's own origin, with the proof in its header.
    csrf(
      form({ origin: ORIGIN, 'x-mason-csrf': session.csrf }, undefined),
      store,
      session,
    )
    // Over the wire: a no-referrer form needs same-origin metadata for this
    // node's own address, which a request to another name never has.
    for (const metadata of [
      { origin: 'null', 'sec-fetch-site': 'same-origin' },
      { origin: 'null', 'sec-fetch-site': 'cross-site' },
    ])
      assert.deepEqual(
        await shell(
          await b.post(
            '/auth/switch/second',
            { csrf: session.csrf, return: '/' },
            metadata,
          ),
          400,
        ),
        INVALID,
      )
    // The proof may come in the web app's header instead of the form.
    const choose = await shell(
      await b.post(
        '/auth/switch/second',
        { return: '/' },
        { 'x-mason-csrf': session.csrf },
      ),
    )
    assert.equal(choose?.state, 'chooseAccount')
  })

  it('limits sign-in requests and exposes no secret details on malformed requests', async () => {
    const b = browser()
    for (let i = 0; i < 120; i++)
      assert.equal((await b.get('/auth/login')).status, 200)
    const limited = await b.get('/auth/login')
    assert.equal(limited.status, 429)
    assert.equal(await limited.text(), 'Please wait before trying again')
    assert.equal((await b.get('/auth/start/first')).status, 429)
    runtime().advanceClock(60_001)
    await shell(await b.get('/auth/login'))
    // Bodies past the limits are refused before anything reads them.
    const huge = await b.post('/auth/switch/first', {
      csrf: 'x'.repeat(20_000),
      return: '/',
    })
    const tooBig = await b.json('/auth/password', {
      username: 'x'.repeat(5000),
    })
    const invalid = await b.get('/auth/start/first?return=//example.test')
    const callback = await b.get('/auth/callback/first?state=x&code=y')
    for (const reply of [huge, tooBig, invalid, callback]) {
      const text = await reply.text()
      assert.equal(reply.status, 400, text.slice(0, 200))
      for (const secret of [
        'fixture-secret',
        c.root,
        env.origin,
        'Missing browser transaction',
        'Error:',
        '    at ',
      ])
        assert(!text.includes(secret), secret)
    }
  })

  it('relays a username and password to the master and signs the account in on the host', async () => {
    const b = browser()
    const given = (await (
      await b.json('/auth/password/parameters', { username: 'Hugo' })
    ).json()) as Parameters<typeof clientPasswordHash>[1]
    const wrong = await b.json('/auth/password', {
      username: 'hugo',
      clientHash: await clientPasswordHash('not-it', given),
    })
    assert.equal(wrong.status, 401)
    assert.match(((await wrong.json()) as { error: string }).error, /wrong/)
    assert.equal(token(b), undefined)
    const right = await b.json('/auth/password', {
      identifier: 'hugo@example.test',
      clientHash: await clientPasswordHash('Hugo-Horse-9', given),
    })
    assert.equal(right.status, 200, await right.clone().text())
    assert.deepEqual(await right.json(), { signedIn: true })
    assert.equal(context(b).account.id, people.hugo!.id)
    // Without the master no password can be checked.
    const link = runtime().options.link
    runtime().options.link = (): undefined => undefined
    try {
      for (const route of ['/auth/password/parameters', '/auth/password']) {
        const reply = await b.json(route, { username: 'hugo', clientHash: 'x' })
        assert.equal(reply.status, 503)
        assert.deepEqual(await reply.json(), {
          error: 'Password sign-in needs the master; try again shortly',
        })
      }
    } finally {
      runtime().options.link = link
    }
  })

  it('opens an invitation link on the host: the master checks and uses it, and the host signs the person in', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Ivy Invitee',
      emails: ['ivy@example.test'],
      username: 'ivy',
      invite: true,
    })
    assert.equal(made.status, 201, made.text)
    const invitation = made.json.invitation.url as string
    assert(invitation.startsWith(ORIGIN + '/auth/invite#'))
    const secret = invitation.split('#')[1]!
    const b = browser()
    // The page is the web app's; it reads the token from the fragment.
    assert.equal(await shell(await b.get('/auth/invite')), undefined)
    for (const origin of ['https://hostile.example.test', 'not a url']) {
      const foreign = await b.json(
        '/auth/invite/lookup',
        { token: secret },
        { origin },
      )
      assert.equal(foreign.status, 400)
      assert.deepEqual(await foreign.json(), { error: 'Untrusted origin' })
    }
    const unsent = await b.json('/auth/invite/lookup', { token: secret }, {})
    assert.equal(unsent.status, 400)
    const found = await b.json('/auth/invite/lookup', { token: secret })
    assert.equal(found.status, 200)
    assert.deepEqual(await found.json(), {
      name: 'Ivy Invitee',
      username: 'ivy',
      usernameRequired: false,
    })
    const p = clientParameters('e3'.repeat(16), DEFAULT_PASSWORD_COSTS)
    const password = {
      clientHash: await clientPasswordHash('Ivy-Horse-9', p),
      clientParameters: p,
    }
    const accepted = await b.json('/auth/invite', {
      token: secret,
      ...password,
    })
    assert.equal(accepted.status, 200, await accepted.clone().text())
    assert.deepEqual(await accepted.json(), { signedIn: true })
    assert.equal(context(b).account.id, made.json.id)
    // Used once.
    const reused = await browser().json('/auth/invite', {
      token: secret,
      ...password,
    })
    assert.equal(reused.status, 400)
    assert.deepEqual(await reused.json(), {
      error: 'This invitation link is not valid or has expired',
    })
    // Without the master no link can be checked or used.
    const link = runtime().options.link
    runtime().options.link = (): undefined => undefined
    try {
      for (const route of ['/auth/invite/lookup', '/auth/invite']) {
        const reply = await b.json(route, { token: secret, ...password })
        assert.equal(reply.status, 503)
        assert.deepEqual(await reply.json(), {
          error: 'Invitations need the master; try again shortly',
        })
      }
    } finally {
      runtime().options.link = link
    }
  })
})

describe('Mason operator accounts on a pre-cluster distribution database', () => {
  const providers = [
    {
      id: 'first',
      name: 'First',
      type: 'oidc',
      issuer: 'https://first.example.test/oauth',
      clientId: 'fixture',
      clientSecret: 'fixture-secret',
    },
    {
      id: 'second',
      name: 'Second',
      type: 'oidc',
      issuer: 'https://second.example.test/oauth',
      clientId: 'fixture',
      clientSecret: 'fixture-secret',
    },
  ]
  let root: string, store: Store, accounts: Accounts, now: number, file: string
  beforeEach(() => {
    root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'operator-'),
    )
    now = Date.now()
    store = new Store(
      asConfig({
        origin: ORIGIN,
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
        providers,
      }),
      () => now,
    )
    accounts = new Accounts(store)
    file = path.join(root, 'config.json')
    writeFileSync(file, JSON.stringify(store.config), { mode: 0o600 })
  })
  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  /** `mason <command> --config <file> …`, as the operator runs it. */
  const cli = (command: string, ...args: string[]): string => {
    const lines: string[] = []
    run([command, '--config', file, ...args], (line) => lines.push(line))
    return lines.join('\n')
  }
  const identity = (
    provider: (typeof providers)[number],
    subject: string,
    email?: string,
    emailVerified = true,
  ): object => ({
    provider: provider.id,
    issuer: provider.issuer,
    subject,
    name: 'Example Person',
    ...(email == null ? {} : { email }),
    emailVerified,
  })

  it('distinguishes provider identities and unverified email claims', () => {
    const [first, second] = providers as [
      (typeof providers)[number],
      (typeof providers)[number],
    ]
    const claimed = accounts.login(
      identity(first, 'claimed-person', 'tester@example.test', false),
    )
    const verified = accounts.login(
      identity(second, 'verified-person', 'tester@example.test'),
    )
    const missing = accounts.login(identity(first, '<no-email>'))
    // The same email through two providers is two accounts, never a match.
    assert.notEqual(claimed.account.id, verified.account.id)
    assert.deepEqual(
      accounts
        .identities(claimed.account.id)
        .map((row) => [row.provider, row.subject, row.email_verified]),
      [['first', 'claimed-person', 0]],
    )
    assert.equal(accounts.identities(missing.account.id)[0]!.email, undefined)
    assert.equal(accounts.identities().length, 3)
    assert.throws(() => accounts.identities(-1))
    // Only a verified identity is promoted.
    assert.throws(() =>
      accounts.promote('first', 'claimed-person', 'tester@example.test'),
    )
    assert.equal(
      accounts.promote('second', 'verified-person', 'tester@example.test'),
      verified.account.id,
    )
  })

  it('promotes only authenticated verified identities using the operator CLI', () => {
    const [first, second] = providers as [
      (typeof providers)[number],
      (typeof providers)[number],
    ]
    const grant = (provider: string, email: string): string =>
      cli(
        'admin-grant',
        '--provider',
        provider,
        '--subject',
        'fixture-subject',
        '--email',
        email,
      )
    assert.throws(() => grant('first', 'alex@example.test'))
    const { token } = accounts.login(
      identity(first, 'fixture-subject', 'alex@example.test'),
    )
    assert.throws(() => grant('first', 'someone@example.test'))
    assert.throws(() => grant('unknown', 'alex@example.test'))
    assert.throws(() =>
      accounts.promote('unknown', 'fixture-subject', 'alex@example.test'),
    )
    assert.throws(() => cli('accounts', 'extra'), /Usage/)
    assert.throws(() => run(['admin-grant', '--config', file]), /Usage/)
    assert.match(cli('accounts'), /fixture-subject/)
    assert.match(grant('first', 'alex@example.test'), /"admin":true/)
    // Promotion ends the account's sessions.
    assert.equal(accounts.session(token), undefined)
    const promoted = accounts.list()[0]!
    assert.equal(promoted.is_admin, 1)
    // The final administrator stays.
    assert.throws(() => cli('admin-revoke', '--account', String(promoted.id)))
    accounts.login(identity(second, 'fixture-subject', 'alex@example.test'))
    accounts.promote('second', 'fixture-subject', 'alex@example.test')
    assert.match(
      cli('admin-revoke', '--account', String(promoted.id)),
      /revoked/,
    )
    assert.equal(accounts.account(promoted.id).is_admin, 0)
    store.db
      .prepare('UPDATE identities SET email_verified=0 WHERE account_id=?')
      .run(promoted.id)
    assert.throws(() =>
      accounts.promote('first', 'fixture-subject', 'alex@example.test'),
    )
    // Sessions lapse; prune drops them and stale flows.
    assert.match(cli('prune'), /\{/)
    assert(accounts.session(accounts.startSession(promoted.id).token) != null)
    now += 31 * 86400000
    accounts.prune()
    assert.equal(
      store.db.prepare('SELECT COUNT(*) total FROM sessions').get()?.total,
      0,
    )
    assert.notEqual(digest(token), token)
  })
})
