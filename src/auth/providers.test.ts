import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import { after, before, describe, it } from 'mocha'
import Provider, { type Account, type AccountClaims } from 'oidc-provider'
import { Agent } from 'undici'
import { asProvider, type ProviderConfig } from './providerConfig.js'
import { boundedFetch, claim, Providers, type OAuthProof } from './providers.js'
import { randomToken } from './accounts.js'

interface Fixture {
  origin: string
  configs: ProviderConfig[]
  transport: typeof fetch
  signToken: (token: string, updates: Record<string, unknown>) => string
  close: () => Promise<void>
  authorize: (url: string, cookies?: Map<string, string>) => Promise<URL>
  selectSubject: (subject: string) => void
}
/** Real HTTPS authorization, token, JWKS and user-info endpoints; no TLS bypass. */
export async function fixture(): Promise<Fixture> {
  assert(process.env.MASON_TEST_ROOT)
  const root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'protocol-'))
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=identity.example.test',
      '-addext',
      'subjectAltName=DNS:identity.example.test',
      '-keyout',
      path.join(root, 'tls.key'),
      '-out',
      path.join(root, 'tls.crt'),
    ],
    { stdio: 'ignore' },
  )
  const app = express()
  const server: Server = createServer(
    {
      key: readFileSync(path.join(root, 'tls.key')),
      cert: readFileSync(path.join(root, 'tls.crt')),
    },
    app,
  ).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `https://identity.example.test:${(server.address() as AddressInfo).port}`
  const agent = new Agent({
    connect: {
      ca: readFileSync(path.join(root, 'tls.crt')),
      lookup: (_hostname, _options, callback): void =>
        callback(null, [{ address: '127.0.0.1', family: 4 }]),
    },
  })
  const transport: typeof fetch = async (input, init) => {
    const options: RequestInit = { ...init }
    Object.assign(options, { dispatcher: agent })
    return await fetch(input, options)
  }
  const configs: ProviderConfig[] = []
  let selectedSubject = 'fixture-subject'
  const signingKeys = new Map<
    string,
    ReturnType<typeof generateKeyPairSync>['privateKey']
  >()
  for (const id of ['first', 'second']) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = {
      ...pair.privateKey.export({ format: 'jwk' }),
      kid: id,
      alg: 'RS256',
      use: 'sig',
    }
    signingKeys.set(id, pair.privateKey)
    const issuer = `${origin}/${id}`
    const provider = new Provider(issuer, {
      clients: [
        {
          client_id: 'fixture',
          client_secret: 'fixture-secret',
          redirect_uris: [`https://builds.example.test/auth/callback/${id}`],
          response_types: ['code'],
          grant_types: ['authorization_code'],
          token_endpoint_auth_method:
            id === 'first' ? 'client_secret_post' : 'client_secret_basic',
        },
      ],
      jwks: { keys: [jwk] },
      cookies: { keys: [randomToken()] },
      features: { devInteractions: { enabled: false } },
      pkce: { required: (): boolean => true },
      claims: {
        openid: ['sub'],
        profile: ['name'],
        email: ['email', 'email_verified'],
      },
      findAccount: async (_ctx, sub): Promise<Account> => ({
        accountId: sub,
        claims: async (): Promise<AccountClaims> => ({
          sub,
          name: 'Alex Lee',
          email: 'alex@example.test',
          email_verified: true,
        }),
      }),
      interactions: {
        url: (_ctx, interaction): string =>
          `${issuer}/interaction/${interaction.uid}`,
      },
    })
    app.get(`/${id}/interaction/:uid`, async (req, res) => {
      const details = await provider.interactionDetails(req, res)
      const grant = new provider.Grant({
        accountId: selectedSubject,
        clientId: 'fixture',
      })
      grant.addOIDCScope('openid profile email')
      await provider.interactionFinished(
        req,
        res,
        {
          login: { accountId: selectedSubject },
          consent: { grantId: await grant.save() },
        },
        { mergeWithLastSubmission: false },
      )
      void details
    })
    app.use(`/${id}`, provider.callback())
    configs.push(
      asProvider({
        id,
        name: id,
        type: 'oidc',
        issuer,
        clientId: 'fixture',
        clientSecret: 'fixture-secret',
        authentication: id === 'first' ? 'post' : 'basic',
      }),
    )
  }
  const codes = new Map<string, { challenge: string; redirect: string }>()
  app.use('/plain', express.urlencoded({ extended: false }))
  app.get('/plain/authorize', (req, res) => {
    assert.equal(req.query.client_id, 'fixture')
    assert.equal(req.query.code_challenge_method, 'S256')
    assert.equal(
      req.query.redirect_uri,
      'https://builds.example.test/auth/callback/plain',
    )
    const code = randomToken()
    codes.set(code, {
      challenge: String(req.query.code_challenge),
      redirect: String(req.query.redirect_uri),
    })
    const target = new URL(String(req.query.redirect_uri))
    target.searchParams.set('code', code)
    target.searchParams.set('state', String(req.query.state))
    res.redirect(303, target.href)
  })
  app.post('/plain/token', (req, res) => {
    const code = codes.get(String(req.body.code))
    codes.delete(String(req.body.code))
    if (
      code == null ||
      req.body.client_id !== 'fixture' ||
      req.body.client_secret !== 'fixture-secret' ||
      req.body.redirect_uri !== code.redirect ||
      createHash('sha256')
        .update(String(req.body.code_verifier))
        .digest('base64url') !== code.challenge
    ) {
      res.status(400).json({ error: 'invalid_grant' })
      return
    }
    res.json({ access_token: 'fixture-access', token_type: 'Bearer' })
  })
  app.get('/plain/user', (req, res) => {
    if (req.get('authorization') !== 'Bearer fixture-access') {
      res.status(401).end()
      return
    }
    res.json({
      user: {
        id: 42,
        name: 'Jordan Lee',
        email: 'jordan@example.test',
        verified: true,
      },
    })
  })
  configs.push(
    asProvider({
      id: 'plain',
      name: 'Plain OAuth',
      type: 'oauth2',
      issuer: origin + '/plain',
      clientId: 'fixture',
      clientSecret: 'fixture-secret',
      authorizationEndpoint: origin + '/plain/authorize',
      tokenEndpoint: origin + '/plain/token',
      userinfoEndpoint: origin + '/plain/user',
      scopes: ['profile', 'email'],
      claims: {
        subject: 'user.id',
        name: 'user.name',
        email: 'user.email',
        emailVerified: 'user.verified',
      },
    }),
  )
  return {
    signToken: (token, updates): string => {
      const parts = token.split('.')
      const header = JSON.parse(
        Buffer.from(parts[0]!, 'base64url').toString(),
      ) as { kid: string }
      const claims = JSON.parse(
        Buffer.from(parts[1]!, 'base64url').toString(),
      ) as Record<string, unknown>
      const content =
        parts[0] +
        '.' +
        Buffer.from(JSON.stringify({ ...claims, ...updates })).toString(
          'base64url',
        )
      return (
        content +
        '.' +
        sign(
          'RSA-SHA256',
          Buffer.from(content),
          signingKeys.get(header.kid)!,
        ).toString('base64url')
      )
    },
    origin,
    configs,
    transport,
    close: async (): Promise<void> => {
      server.close()
      await once(server, 'close')
      await agent.close()
      rmSync(root, { recursive: true, force: true })
    },
    selectSubject: (subject): void => {
      selectedSubject = subject
    },
    authorize: async (
      url,
      cookies = new Map<string, string>(),
    ): Promise<URL> => {
      let submission: RequestInit = {}
      for (let i = 0; i < 12; i++) {
        const response: Response = await transport(url, {
          ...submission,
          redirect: 'manual',
          headers: {
            cookie: [...cookies.values()].join('; '),
            ...submission.headers,
          },
        })
        for (const value of response.headers.getSetCookie()) {
          const pair = value.split(';')[0]!
          cookies.set(pair.split('=')[0]!, pair)
        }
        if (response.status === 200) {
          const html: string = await response.text()
          const action: string | undefined = /<form[^>]+action="([^"]+)"/.exec(
            html,
          )?.[1]
          assert(action, 'Expected provider account-switch form')
          const target: URL = new URL(action.replaceAll('&amp;', '&'), url)
          assert.equal(target.origin, new URL(origin).origin)
          const body = new URLSearchParams()
          for (const input of html.matchAll(
            /<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g,
          ))
            body.set(input[1]!, input[2]!.replaceAll('&amp;', '&'))
          url = target.href
          submission = {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
          }
          continue
        }
        assert(
          response.status >= 300 && response.status < 400,
          `Provider authorization returned ${response.status}`,
        )
        url = new URL(response.headers.get('location')!, url).href
        submission = {}
        if (url.startsWith('https://builds.example.test/')) return new URL(url)
      }
      throw new Error('Provider did not return to Mason')
    },
  }
}
const proof = (): OAuthProof => ({
  state: randomToken(),
  verifier: randomToken(),
  nonce: randomToken(),
})
describe('Mason OAuth provider protocols', () => {
  let env: Fixture
  before(async () => {
    env = await fixture()
  })
  after(async () => {
    await env.close()
  })
  it('validates provider-specific switching methods without overriding OAuth security parameters', async () => {
    for (const value of [
      [],
      {},
      { state: 'changed' },
      { prompt: 1 },
      { constructor: 'changed' },
      Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => ['key' + i, 'value']),
      ),
    ])
      assert.throws(() =>
        asProvider({ ...env.configs[2], switchParameters: value }),
      )
    const providers = new Providers(
      'https://builds.example.test',
      env.configs,
      env.transport,
    )
    await assert.rejects(
      providers.authorize('plain', proof(), true),
      /switching configuration/,
    )
    const configured = asProvider({
      ...env.configs[2],
      switchParameters: { prompt: 'select_account' },
    })
    const custom = new Providers(
      'https://builds.example.test',
      [configured],
      env.transport,
    )
    assert.equal(
      new URL(await custom.authorize('plain', proof(), true)).searchParams.get(
        'prompt',
      ),
      'select_account',
    )
  })
  it('exchanges real HTTPS codes with two OIDC providers and a plain OAuth provider', async () => {
    const providers = new Providers(
      'https://builds.example.test',
      env.configs,
      env.transport,
    )
    for (const id of ['first', 'second', 'plain']) {
      const p = proof()
      const callback = await env.authorize(await providers.authorize(id, p))
      const identity = await providers.identity(id, callback, p)
      assert.equal(identity.provider, id)
      assert.equal(identity.issuer, env.origin + '/' + id)
      assert.equal(identity.subject, id === 'plain' ? '42' : 'fixture-subject')
      assert.equal(identity.emailVerified, true)
      await assert.rejects(providers.identity(id, callback, p))
    }
    assert.throws(() => providers.provider('unknown'))
  })
  it('rejects wrong state, nonce, verifier, callback and provider', async () => {
    const providers = new Providers(
      'https://builds.example.test',
      env.configs,
      env.transport,
    )
    for (const kind of ['state', 'nonce', 'verifier', 'callback', 'provider']) {
      const p = proof()
      const callback = await env.authorize(
        await providers.authorize('first', p),
      )
      const altered = { ...p }
      if (kind === 'state' || kind === 'nonce' || kind === 'verifier')
        altered[kind] = randomToken()
      if (kind === 'callback') callback.hostname = 'hostile.example.test'
      await assert.rejects(
        providers.identity(
          kind === 'provider' ? 'second' : 'first',
          callback,
          altered,
        ),
      )
    }
  })
  it('requires valid ID-token signatures, issuer, audience, expiry and user-info subject', async () => {
    for (const kind of [
      'signature',
      'issuer',
      'audience',
      'expiry',
      'subject',
      'verified',
    ]) {
      const transport: typeof fetch = async (input, init) => {
        const response = await env.transport(input, init)
        const url = String(input)
        if (
          url.endsWith('/token') &&
          kind !== 'subject' &&
          kind !== 'verified'
        ) {
          const body = (await response.json()) as { id_token: string }
          const parts = body.id_token.split('.')
          const claims = JSON.parse(
            Buffer.from(parts[1]!, 'base64url').toString(),
          ) as Record<string, unknown>
          if (kind === 'issuer') claims.iss = 'https://hostile.example.test'
          if (kind === 'audience') claims.aud = 'wrong-client'
          if (kind === 'expiry') claims.exp = 1
          const content =
            parts[0] +
            '.' +
            Buffer.from(JSON.stringify(claims)).toString('base64url')
          const key = generateKeyPairSync('rsa', {
            modulusLength: 2048,
          }).privateKey
          body.id_token =
            kind === 'signature'
              ? content +
                '.' +
                sign('RSA-SHA256', Buffer.from(content), key).toString(
                  'base64url',
                )
              : env.signToken(body.id_token, claims)
          return Response.json(body)
        }
        if (
          url.endsWith('/me') &&
          (kind === 'subject' || kind === 'verified')
        ) {
          const body = (await response.json()) as Record<string, unknown>
          if (kind === 'subject') body.sub = 'other-subject'
          else body.email_verified = 'true'
          return Response.json(body)
        }
        return response
      }
      const providers = new Providers(
        'https://builds.example.test',
        env.configs,
        transport,
      )
      const p = proof(),
        callback = await env.authorize(await providers.authorize('first', p))
      await assert.rejects(providers.identity('first', callback, p), kind)
    }
  })
  it('bounds network data, rejects insecure metadata and retries failed discovery', async () => {
    assert.equal(claim({ nested: { id: 2 } }, 'nested.id'), 2)
    for (const key of [
      undefined,
      '__proto__',
      'nested.constructor',
      'missing.id',
    ])
      assert.equal(claim({ nested: {} }, key), undefined)
    await assert.rejects(boundedFetch()(new Request('http://example.test')))
    const empty = boundedFetch(async () => new Response(null, { status: 204 }))
    assert.equal(
      (
        await empty(new URL('https://example.test'), {
          signal: AbortSignal.timeout(1000),
        })
      ).status,
      204,
    )
    const huge = boundedFetch(
      async () => new Response('x'.repeat(256 * 1024 + 1)),
    )
    await assert.rejects(huge('https://example.test'), /too large/)
    let failure = true
    const providers = new Providers(
      'https://builds.example.test',
      env.configs,
      async (input, init) => {
        const response = await env.transport(input, init)
        if (failure && String(input).includes('.well-known')) {
          const body = (await response.json()) as Record<string, unknown>
          body.jwks_uri = 'http://insecure.example.test/jwks'
          return Response.json(body)
        }
        return response
      },
    )
    await assert.rejects(providers.authorize('first', proof()))
    failure = false
    assert((await providers.authorize('first', proof())).startsWith(env.origin))
  })
})
