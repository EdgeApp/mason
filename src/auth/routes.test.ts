import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { asConfig } from '../config.js'
import { Store, digest } from '../store.js'
import { createApp } from '../server.js'
import { Accounts, randomToken } from './accounts.js'
import { Providers } from './providers.js'
import { fixture } from './providers.test.js'
import type { Request, Response as ExpressResponse } from 'express'
import { authLimiter, csrf, returnPath, SESSION_COOKIE } from './routes.js'

class Browser {
  readonly cookies = new Map<string, string>()
  constructor(readonly origin: string) {}
  async get(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url, this.origin)
    const response = await fetch(
      this.origin + parsed.pathname + parsed.search,
      {
        ...init,
        redirect: 'manual',
        headers: {
          cookie: [...this.cookies]
            .map(([name, value]) => name + '=' + value)
            .join('; '),
          ...init?.headers,
        },
      },
    )
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]!,
        index = pair.indexOf('=')
      assert(
        value.includes('HttpOnly') &&
          value.includes('Secure') &&
          value.includes('SameSite=Lax') &&
          value.includes('Path=/'),
      )
      if (pair.slice(index + 1) === '')
        this.cookies.delete(pair.slice(0, index))
      else this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    return response
  }
  async post(
    url: string,
    body: Record<string, string>,
    origin = 'https://builds.example.test',
  ): Promise<Response> {
    return await this.get(url, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body),
    })
  }
}
describe('Mason login routes and administrator controls', () => {
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
  })
  let env: Awaited<ReturnType<typeof fixture>>,
    store: Store,
    accounts: Accounts,
    server: Server,
    root: string,
    browser: Browser,
    now: number
  before(async () => {
    env = await fixture()
  })
  after(async () => {
    await env.close()
  })
  beforeEach(async () => {
    assert(process.env.MASON_TEST_ROOT)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'routes-'))
    now = Date.now()
    store = new Store(
      asConfig({
        origin: 'https://builds.example.test',
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
        providers: env.configs,
      }),
      () => now,
    )
    accounts = new Accounts(store)
    server = createApp(
      store,
      new Providers(store.config.origin, env.configs, env.transport),
    ).listen(0, '127.0.0.1')
    await once(server, 'listening')
    browser = new Browser(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    )
  })
  afterEach(async () => {
    server.close()
    await once(server, 'close')
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  async function start(
    target = browser,
    id = 'first',
    destination = '/',
  ): Promise<URL> {
    const response = await target.get(
      `/auth/start/${id}?return=${encodeURIComponent(destination)}`,
    )
    assert.equal(response.status, 303)
    return await env.authorize(response.headers.get('location')!)
  }
  async function login(target = browser, id = 'first'): Promise<void> {
    const callback = await start(target, id)
    assert.equal((await target.get(callback.href)).status, 303)
  }
  function context(
    target = browser,
  ): NonNullable<ReturnType<Accounts['session']>> {
    const value = accounts.session(target.cookies.get(SESSION_COOKIE))
    assert(value)
    return value
  }
  async function admin(): Promise<void> {
    await login()
    const identity = accounts.identities()[0]!
    accounts.promote(identity.provider, identity.subject, identity.email!)
    await login()
  }
  it('authenticates a pending account, persists cookies, hides builds and requires admin for People', async () => {
    assert.equal((await browser.get('/')).status, 303)
    assert.match(
      await (await browser.get('/auth/login')).text(),
      /Sign in with first/,
    )
    assert.equal((await browser.get('/people')).status, 403)
    await login()
    assert.equal(context().account.is_admin, 0)
    assert.equal(context().account.is_tester, 0)
    const pending = await browser.get('/')
    assert.equal(pending.status, 403)
    assert.match(await pending.text(), /Waiting for tester access/)
    assert.equal((await browser.get('/people')).status, 403)
    assert.equal((await browser.get('/assets/style.css')).status, 200)
    assert.equal((await browser.get('/unknown')).status, 404)
    assert.match(
      pending.headers.get('content-security-policy')!,
      /frame-ancestors 'none'/,
    )
    const token = browser.cookies.get(SESSION_COOKIE)!
    assert.notEqual(
      store.db.prepare('SELECT hash FROM sessions').get()?.hash,
      token,
    )
    const csrf = context().session.csrf
    assert.equal(
      (
        await browser.post(
          '/auth/logout',
          { csrf },
          'https://hostile.example.test',
        )
      ).status,
      400,
    )
    assert.equal(
      (await browser.post('/auth/logout', { csrf: 'wrong' })).status,
      400,
    )
    assert.equal((await browser.post('/auth/logout', { csrf })).status, 303)
    assert.equal(accounts.session(token), undefined)
    assert.equal((await browser.post('/auth/logout', { csrf })).status, 400)
  })
  it('continues directly to a single provider and preserves the requested destination', async () => {
    store.config.providers = store.config.providers.slice(0, 1)
    const destination = '/apps/1?platform=ios'
    const entry = await browser.get(
      '/auth/login?return=' + encodeURIComponent(destination),
    )
    assert.equal(entry.status, 303)
    assert.equal(
      entry.headers.get('location'),
      '/auth/start/first?return=' + encodeURIComponent(destination),
    )
    const started = await browser.get(entry.headers.get('location')!)
    assert.equal(started.status, 303)
    const callback = await env.authorize(started.headers.get('location')!)
    const completed = await browser.get(callback.href)
    assert.equal(completed.status, 303)
    assert.equal(completed.headers.get('location'), destination)
    assert.equal(context().account.is_tester, 0)
    assert.equal((await browser.get('/auth/login')).status, 200)
    const session = context().session
    const signedOut = await browser.post('/auth/logout', { csrf: session.csrf })
    assert.equal(signedOut.status, 303)
    const landing = await browser.get(signedOut.headers.get('location')!)
    assert.equal(landing.status, 200)
    assert.match(await landing.text(), /Sign in with first/)
    assert.equal(
      accounts.session(browser.cookies.get(SESSION_COOKIE)),
      undefined,
    )
  })
  it('accepts private same-origin forms only with trusted Fetch Metadata and a session proof', async () => {
    await login()
    const session = context().session
    function form(
      headers: Record<string, string>,
      proof = session.csrf,
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
    assert.throws(() =>
      csrf(form({ ...headers, 'sec-fetch-site': 'same-site' }), store, session),
    )
    assert.throws(() =>
      csrf(
        form({ ...headers, 'sec-fetch-site': 'cross-site' }),
        store,
        session,
      ),
    )
    assert.throws(() =>
      csrf(form({ ...headers, host: 'hostile.example.test' }), store, session),
    )
    assert.throws(() =>
      csrf(
        form({ ...headers, origin: 'https://hostile.example.test' }),
        store,
        session,
      ),
    )
  })
  it('binds one-use callbacks to provider, browser, session and expiry', async () => {
    const callback = await start()
    const other = new Browser(browser.origin)
    assert.equal((await other.get(callback.href)).status, 400)
    other.cookies.set('__Host-mason-oauth', randomToken())
    assert.equal((await other.get(callback.href)).status, 400)
    const swapped = new URL(callback)
    swapped.pathname = '/auth/callback/second'
    assert.equal((await browser.get(swapped.href)).status, 400)
    browser.cookies.set(SESSION_COOKIE, randomToken())
    assert.equal((await browser.get(callback.href)).status, 400)
    browser.cookies.delete(SESSION_COOKIE)
    assert.equal((await browser.get(callback.href)).status, 303)
    assert.equal((await browser.get(callback.href)).status, 400)
    const fresh = new Browser(browser.origin),
      expired = await start(fresh)
    now += 600001
    assert.equal((await fresh.get(expired.href)).status, 400)
    accounts.prune()
    assert.equal(
      store.db.prepare('SELECT COUNT(*) total FROM oauth_transactions').get()
        ?.total,
      0,
    )
    for (const value of [
      '//hostile.example.test',
      '/\\hostile.example.test',
      '/auth/start/first',
      '/x#fragment',
      '/\n/x',
    ])
      assert.throws(() => returnPath(value))
    assert.equal(returnPath('/apps/1?platform=ios'), '/apps/1?platform=ios')
    assert.equal(
      (await browser.get('/auth/login?return=https://hostile.example.test'))
        .status,
      400,
    )
    assert.equal((await browser.get('/auth/start/unknown')).status, 400)
    assert.equal(
      (await browser.get('/auth/callback/first?state=a&state=b')).status,
      400,
    )
    assert.equal(
      (
        await browser.get('/auth/start/first', {
          headers: { cookie: `${SESSION_COOKIE}=a; ${SESSION_COOKIE}=b` },
        })
      ).status,
      303,
    )
  })
  it('preapproves a verified first login through People and immediately revokes tester sessions', async () => {
    await admin()
    const csrf = context().session.csrf
    const people = await browser.get('/people')
    assert.equal(people.status, 200)
    assert.match(await people.text(), /Preapprove a tester/)
    assert.equal(
      (
        await browser.post('/people/invitations', {
          csrf,
          provider: 'plain',
          email: 'jordan@example.test',
          days: '30',
        })
      ).status,
      200,
    )
    assert.equal(accounts.invitations().length, 1)
    const tester = new Browser(browser.origin)
    await login(tester, 'plain')
    assert.equal(context(tester).account.is_tester, 1)
    assert.equal((await tester.get('/')).status, 200)
    const testerId = context(tester).account.id,
      testerToken = tester.cookies.get(SESSION_COOKIE)!
    assert.equal(
      (
        await tester.post(`/people/${context().account.id}/tester`, {
          csrf: context(tester).session.csrf,
          enabled: 'true',
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await browser.post(`/people/${testerId}/tester`, {
          csrf,
          enabled: 'false',
        })
      ).status,
      303,
    )
    assert.equal(accounts.session(testerToken), undefined)
    assert.equal((await tester.get('/')).status, 303)
    assert.equal(
      (
        await browser.post(`/people/${testerId}/tester`, {
          csrf,
          enabled: 'true',
        })
      ).status,
      303,
    )
    assert.equal(accounts.session(testerToken), undefined)
    assert.equal(
      (
        await browser.post(`/people/${testerId}/tester`, {
          csrf,
          enabled: 'arbitrary',
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await browser.post('/people/invitations', {
          csrf,
          provider: 'first',
          email: 'later@example.test',
          days: '1',
        })
      ).status,
      200,
    )
    const pending = accounts
      .invitations()
      .find((item) => item.email === 'later@example.test')!
    assert.equal(
      (
        await browser.post(`/people/invitations/${pending.id}/revoke`, {
          csrf,
        })
      ).status,
      303,
    )
    assert.match(await (await browser.get('/people')).text(), /Revoked/)
    assert.match(await (await browser.get('/people')).text(), /Claimed/)
  })
  it('distinguishes provider identities and unverified email claims before granting access', async () => {
    await admin()
    const provider = store.config.providers[0]!
    const first = accounts.login({
      provider: provider.id,
      issuer: provider.issuer,
      subject: 'claimed-person',
      name: 'Example Person',
      email: 'tester@example.test',
      emailVerified: false,
    })
    const secondProvider = store.config.providers[1]!
    const second = accounts.login({
      provider: secondProvider.id,
      issuer: secondProvider.issuer,
      subject: 'verified-person',
      name: 'Example Person',
      email: 'tester@example.test',
      emailVerified: true,
    })
    const missing = accounts.login({
      provider: provider.id,
      issuer: provider.issuer,
      subject: '<no-email>',
      name: 'Example Person',
      emailVerified: false,
    })
    const html = await (await browser.get('/people')).text()
    const row = (id: number): string =>
      html
        .split('<div class="row">')
        .find((part) => part.includes(`/people/${id}/tester`))!
    assert.match(row(first.account.id), /Unverified email/)
    assert(row(first.account.id).includes(`(${provider.id})`))
    assert.match(row(first.account.id), /Account reference: claimed-person/)
    assert.match(row(second.account.id), /Verified email/)
    assert(row(second.account.id).includes(`(${secondProvider.id})`))
    assert.match(row(second.account.id), /Account reference: verified-person/)
    assert.match(row(missing.account.id), /No email provided/)
    assert.match(row(missing.account.id), /&lt;no-email&gt;/)
    assert.equal(accounts.identities(first.account.id).length, 1)
    assert.throws(() => accounts.identities(-1))
    assert.equal(
      (
        await browser.post(`/people/${first.account.id}/tester`, {
          csrf: context().session.csrf,
          enabled: 'true',
        })
      ).status,
      303,
    )
    assert.equal(accounts.account(first.account.id).is_tester, 1)
    assert.equal(accounts.account(second.account.id).is_tester, 0)
  })
  it('requires CSRF approval to switch accounts and rotates the previous session', async () => {
    await login()
    const previous = browser.cookies.get(SESSION_COOKIE)!,
      csrf = context().session.csrf
    assert.match(
      await (await browser.get('/auth/start/second')).text(),
      /Switch account/,
    )
    assert.equal(
      (
        await browser.post('/auth/switch/second', {
          csrf: 'bad',
          return: '/',
        })
      ).status,
      400,
    )
    const response = await browser.post('/auth/switch/second', {
      csrf,
      return: '/people',
    })
    assert.equal(response.status, 200)
    const html = await response.text(),
      href = /class="button" href="([^"]+)"/
        .exec(html)![1]!
        .replaceAll('&amp;', '&')
    const callback = await env.authorize(href)
    const switched = await browser.get(callback.href)
    assert.equal(switched.headers.get('location'), '/people')
    assert.equal(accounts.session(previous), undefined)
    assert.equal(accounts.identities().length, 2)
    assert.equal(context().account.is_admin, 0)
    assert.equal((await browser.get('/people')).status, 403)
  })
  it('requests reauthentication when switching within an active OIDC provider session', async () => {
    const providerCookies = new Map<string, string>()
    const first = await browser.get('/auth/start/first')
    const firstCallback = await env.authorize(
      first.headers.get('location')!,
      providerCookies,
    )
    await browser.get(firstCallback.href)
    const previous = browser.cookies.get(SESSION_COOKIE)!
    const providers = new Providers(
      store.config.origin,
      env.configs,
      env.transport,
    )
    env.selectSubject('fixture-switched-subject')
    try {
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
      const response = await browser.post('/auth/switch/first', {
        csrf: context().session.csrf,
        return: '/',
      })
      const href = /class="button" href="([^"]+)"/
        .exec(await response.text())![1]!
        .replaceAll('&amp;', '&')
      assert.equal(new URL(href).searchParams.get('prompt'), 'login')
      const callback = await env.authorize(href, providerCookies)
      assert.equal((await browser.get(callback.href)).status, 303)
      assert.equal(
        context().account.id !== accounts.identities()[0]!.account_id,
        true,
      )
      assert.equal(
        accounts.identities().at(-1)!.subject,
        'fixture-switched-subject',
      )
      assert.equal(accounts.session(previous), undefined)
    } finally {
      env.selectSubject('fixture-subject')
    }
  })
  it('explains an unconfigured OAuth provider account switch without promising a choice', async () => {
    await login()
    const page = await browser.get('/auth/start/plain')
    assert.equal(page.status, 200)
    assert.match(
      await page.text(),
      /does not have an account switching method configured/,
    )
    assert.equal(
      (
        await browser.post('/auth/switch/plain', {
          csrf: context().session.csrf,
          return: '/',
        })
      ).status,
      400,
    )
  })
  it('limits login requests and exposes no secret details on malformed requests', async () => {
    const anonymous = new Browser(browser.origin)
    for (const url of [
      '/people/1/tester',
      '/people/invitations',
      '/people/invitations/1/revoke',
      '/auth/switch/first',
    ])
      assert.equal((await anonymous.post(url, {})).status, 400)
    for (let i = 0; i < 121; i++) await browser.get('/auth/login')
    assert.equal((await browser.get('/auth/login')).status, 429)
    now += 60001
    assert.equal((await browser.get('/auth/login')).status, 200)
    const invalid = await browser.get('/auth/start/first?return=//example.test')
    const body = await invalid.text()
    assert(!body.includes('fixture-secret') && !body.includes(root))
  })
  it('promotes only authenticated verified identities using the actual operator CLI', async () => {
    const file = path.join(root, 'config.json')
    writeFileSync(file, JSON.stringify(store.config), { mode: 0o600 })
    const cli = (...args: string[]): string =>
      execFileSync(
        process.execPath,
        ['lib/cli.js', ...args.slice(0, 1), '--config', file, ...args.slice(1)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    assert.throws(() =>
      cli(
        'admin-grant',
        '--provider',
        'first',
        '--subject',
        'fixture-subject',
        '--email',
        'alex@example.test',
      ),
    )
    await login()
    const token = browser.cookies.get(SESSION_COOKIE)!
    assert.throws(() =>
      cli(
        'admin-grant',
        '--provider',
        'first',
        '--subject',
        'fixture-subject',
        '--email',
        'someone@example.test',
      ),
    )
    assert.throws(() =>
      accounts.promote('unknown', 'fixture-subject', 'alex@example.test'),
    )
    assert.match(cli('accounts'), /fixture-subject/)
    assert.match(
      cli(
        'admin-grant',
        '--provider',
        'first',
        '--subject',
        'fixture-subject',
        '--email',
        'alex@example.test',
      ),
      /"admin":true/,
    )
    assert.equal(accounts.session(token), undefined)
    const first = accounts.list()[0]!
    assert.equal(first.is_admin, 1)
    assert.throws(() => cli('admin-revoke', '--account', String(first.id)))
    const other = new Browser(browser.origin)
    await login(other, 'second')
    accounts.promote('second', 'fixture-subject', 'alex@example.test')
    assert.match(cli('admin-revoke', '--account', String(first.id)), /revoked/)
    assert.equal(accounts.account(first.id).is_admin, 0)
    store.db
      .prepare('UPDATE identities SET email_verified=0 WHERE account_id=?')
      .run(first.id)
    assert.throws(() =>
      accounts.promote('first', 'fixture-subject', 'alex@example.test'),
    )
    now += 31 * 86400000
    accounts.prune()
    assert.equal(
      store.db.prepare('SELECT COUNT(*) total FROM sessions').get()?.total,
      0,
    )
    assert.notEqual(digest(token), token)
  })
})
