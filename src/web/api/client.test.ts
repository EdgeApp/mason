import assert from 'node:assert/strict'
import { asNumber, asObject } from 'cleaners'
import { describe, it } from 'mocha'
import { asNodeInfo, type SessionInfo } from '../../shared/api/index.js'
import { ApiClient, ApiError, ContractError } from './client.js'

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  credentials?: string
}

const session: SessionInfo = {
  accountId: 7,
  name: 'Ada',
  role: 'developer',
  csrf: 'proof-of-the-session',
  permissions: ['builds.read', 'runs.read'],
  emails: [{ email: 'ada@example.com', confirmed: true }],
}

/** A node that answers each request from a table of `METHOD path` replies, in order. */
function fakeNode(replies: Record<string, Array<() => Response>>): {
  fetch: typeof fetch
  sent: Sent[]
} {
  const sent: Sent[] = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    sent.push({
      url,
      method,
      headers: init.headers as Record<string, string>,
      ...(init.body == null ? {} : { body: String(init.body) }),
      ...(init.credentials == null ? {} : { credentials: init.credentials }),
    })
    const next = replies[`${method} ${url}`]?.shift()
    if (next == null) throw new TypeError('fetch failed')
    return next()
  }) as typeof globalThis.fetch
  return { fetch, sent }
}

const json = (value: unknown, status = 200): (() => Response) => {
  return () =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    })
}

const asCount = asObject({ count: asNumber })

describe('The web API client', () => {
  it('sends the session’s CSRF proof on a change, read once from GET /api/v2/session', async () => {
    const node = fakeNode({
      'GET /api/v2/session': [json(session)],
      'POST /api/v2/runs': [json({ count: 1 }, 201)],
      'PUT /api/v2/runs/1': [json({ count: 2 })],
      'GET /api/v2/runs': [json({ count: 3 })],
    })
    const client = new ApiClient({ signIn: '/sign-in', fetch: node.fetch })
    assert.deepEqual(
      await client.post('/api/v2/runs', asCount, { body: { project: 'a' } }),
      { count: 1 },
    )
    assert.deepEqual(await client.put('/api/v2/runs/1', asCount), {
      count: 2,
    })
    assert.deepEqual(await client.get('/api/v2/runs', asCount), { count: 3 })
    assert.deepEqual(
      node.sent.map((entry) => `${entry.method} ${entry.url}`),
      [
        'GET /api/v2/session',
        'POST /api/v2/runs',
        'PUT /api/v2/runs/1',
        'GET /api/v2/runs',
      ],
    )
    const [read, post, put, get] = node.sent as [Sent, Sent, Sent, Sent]
    assert.equal(read.headers['X-Mason-CSRF'], undefined)
    assert.equal(post.headers['X-Mason-CSRF'], session.csrf)
    assert.equal(post.headers['Content-Type'], 'application/json')
    assert.equal(post.body, '{"project":"a"}')
    assert.equal(post.credentials, 'same-origin')
    assert.equal(put.headers['X-Mason-CSRF'], session.csrf)
    assert.equal(put.headers['Content-Type'], undefined)
    assert.equal(get.headers['X-Mason-CSRF'], undefined)
  })

  it('signs in without a proof, keeps the one it answers, and forgets it on sign-out', async () => {
    const parameters = {
      algorithm: 'argon2id',
      version: 19,
      memoryKiB: 32768,
      iterations: 6,
      parallelism: 4,
      hashLength: 32,
      salt: '0f'.repeat(16),
    }
    const node = fakeNode({
      'POST /api/v2/session/parameters': [json(parameters)],
      'POST /api/v2/session': [
        json({ name: 'Ada', role: 'developer', csrf: 'fresh' }),
      ],
      'DELETE /api/v2/session': [json(null)],
      'GET /api/v2/session': [json({ ...session, csrf: 'next' })],
      'POST /api/v2/runs': [json({ count: 1 })],
    })
    const navigated: string[] = []
    const client = new ApiClient({
      signIn: '/auth/login',
      fetch: node.fetch,
      navigate: (url): void => {
        navigated.push(url)
      },
    })
    assert.deepEqual(await client.parameters('ada'), parameters)
    const reply = await client.signIn('ada', 'ab'.repeat(32))
    assert.equal(reply.csrf, 'fresh')
    await client.signOut()
    await client.post('/api/v2/runs', asCount)
    const [given, signIn, signOut, read, post] = node.sent as Sent[]
    assert.equal(given!.headers['X-Mason-CSRF'], undefined)
    assert.equal(given!.body, '{"identifier":"ada"}')
    assert.equal(signIn!.headers['X-Mason-CSRF'], undefined)
    assert.equal(signOut!.headers['X-Mason-CSRF'], 'fresh')
    assert.equal(read!.url, '/api/v2/session')
    assert.equal(post!.headers['X-Mason-CSRF'], 'next')
    assert.deepEqual(navigated, [])
  })

  it('turns an answer that does not match the contract into a ContractError', async () => {
    const node = fakeNode({
      'GET /api/v2/node': [
        json({ role: 'worker', version: '1.0.0' }),
        (): Response => new Response('<!doctype html><p>Not JSON</p>'),
      ],
    })
    const client = new ApiClient({ signIn: '/sign-in', fetch: node.fetch })
    for (let i = 0; i < 2; i++) {
      const error = await client.get('/api/v2/node', asNodeInfo).then(
        () => assert.fail('cleaned garbage'),
        (error: unknown) => error,
      )
      assert(error instanceof ContractError)
      assert(error instanceof ApiError)
      assert.equal(error.name, 'ContractError')
      assert.equal(error.status, 200)
      assert.match(
        error.message,
        /^GET \/api\/v2\/node answered something this app does not understand: /,
      )
    }
  })

  it('leaves for sign-in on a 401 unless told not to, and reads the proof again after', async () => {
    const node = fakeNode({
      'GET /api/v2/session': [
        json(session),
        json({ error: 'Not signed in' }, 401),
        json({ error: 'Not signed in' }, 401),
      ],
      'POST /api/v2/runs': [json({ error: 'Sign in or use an API key' }, 401)],
    })
    const navigated: string[] = []
    const client = new ApiClient({
      signIn: '/sign-in',
      fetch: node.fetch,
      navigate: (url): void => {
        navigated.push(url)
      },
    })
    await client.session()
    const expired = await client.post('/api/v2/runs', asCount).catch((e) => e)
    assert(expired instanceof ApiError)
    assert.equal(expired.status, 401)
    assert.equal(expired.message, 'Sign in or use an API key')
    assert.deepEqual(navigated, ['/sign-in'])
    // The proof went with the session: the next change reads the session first.
    const quiet = await client
      .session({ redirect: false })
      .catch((error) => error)
    assert.equal(quiet.status, 401)
    assert.deepEqual(navigated, ['/sign-in'])
    const again = await client.post('/api/v2/runs', asCount).catch((e) => e)
    assert.equal(again.status, 401)
    assert.equal(again.message, 'Not signed in')
    assert.deepEqual(navigated, ['/sign-in', '/sign-in'])
    assert.equal(node.sent.at(-1)!.url, '/api/v2/session')
  })

  it('uses location.assign to leave for sign-in by default', async () => {
    const node = fakeNode({
      'GET /api/v2/session': [json({ error: 'Not signed in' }, 401)],
    })
    const assigned: string[] = []
    // jsdom's Location cannot be changed, so the test lends a window whose can.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window')!
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      get: (): unknown => ({
        location: {
          assign: (url: string): void => {
            assigned.push(url)
          },
        },
      }),
    })
    try {
      const client = new ApiClient({
        signIn: '/auth/login',
        fetch: node.fetch,
      })
      await client.session().catch(() => undefined)
    } finally {
      Object.defineProperty(globalThis, 'window', original)
    }
    assert.deepEqual(assigned, ['/auth/login'])
  })

  it('reads an error’s message and retry time, and says what it can without one', async () => {
    const node = fakeNode({
      'POST /api/v2/session': [
        json({ error: 'Too many failed sign-ins', retryAt: 1_700_000 }, 429),
      ],
      'GET /api/v2/a': [
        (): Response =>
          new Response('Not found', { status: 404, statusText: 'Not Found' }),
      ],
      'GET /api/v2/b': [(): Response => new Response('', { status: 503 })],
      'GET /api/v2/c': [json({ error: 'The master is unreachable' }, 503)],
    })
    const client = new ApiClient({ signIn: '/sign-in', fetch: node.fetch })
    const locked = await client
      .signIn('ada', 'ab'.repeat(32))
      .catch((error) => error)
    assert(locked instanceof ApiError)
    assert.equal(locked.name, 'ApiError')
    assert.equal(locked.status, 429)
    assert.equal(locked.message, 'Too many failed sign-ins')
    assert.equal(locked.retryAt, 1_700_000)
    const plain = await client.get('/api/v2/a', asCount).catch((e) => e)
    assert.deepEqual(
      [plain.status, plain.message, plain.retryAt],
      [404, 'Not Found', undefined],
    )
    const empty = await client.get('/api/v2/b', asCount).catch((e) => e)
    assert.deepEqual(
      [empty.status, empty.message],
      [503, 'The request failed (503)'],
    )
    const away = await client.get('/api/v2/c', asCount).catch((e) => e)
    assert.deepEqual(
      [away.status, away.message],
      [503, 'The master is unreachable'],
    )
  })

  it('reports an unreachable node as status 0, and passes an abort through', async () => {
    const node = fakeNode({})
    const client = new ApiClient({ signIn: '/sign-in', fetch: node.fetch })
    const down = await client.get('/api/v2/node', asNodeInfo).catch((e) => e)
    assert(down instanceof ApiError)
    assert.equal(down.status, 0)
    assert.match(down.message, /could not be reached/)
    const controller = new AbortController()
    controller.abort()
    const aborted = await client
      .delete('/api/v2/x', asCount, { csrf: false, signal: controller.signal })
      .catch((e) => e)
    assert(!(aborted instanceof ApiError))
    assert.equal(node.sent.at(-1)!.method, 'DELETE')
  })

  it('uses the page’s fetch when given none', async () => {
    const original = globalThis.fetch
    const node = fakeNode({ 'GET /api/v2/x': [json({ count: 9 })] })
    globalThis.fetch = node.fetch
    try {
      const client = new ApiClient({ signIn: '/sign-in' })
      assert.deepEqual(await client.get('/api/v2/x', asCount), { count: 9 })
    } finally {
      globalThis.fetch = original
    }
  })
})
