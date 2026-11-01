import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { WebSocket } from 'ws'
import { SESSION_COOKIE } from '../auth/routes.js'
import { Link } from '../link/link.js'
import { memoryPair } from '../link/wire.js'
import { serveLive, serveLiveStream, type LiveFrame } from '../master/live.js'
import type { Actor } from '../master/roles.js'
import { FakeLiveSource, liveRun, liveStage } from '../test/fakeLiveSource.js'
import { hostLive } from './live.js'
import type { HostRuntime } from './runtime.js'

const token = 'a'.repeat(43)
/** Bearer headers in a key's token format. */
const key = `Bearer mason_v1_${'1'.repeat(32)}.${'k'.repeat(43)}`
const other = `Bearer mason_v1_${'2'.repeat(32)}.${'k'.repeat(43)}`

describe('The host’s live socket', () => {
  let server: Server
  let base: string
  /** The host, for a socket server of a test's own. */
  let fakeHost: HostRuntime
  let live: { close(): void }
  let source: FakeLiveSource
  let hostLink: Link | undefined
  let online = true
  let signedIn = true
  /** What the master was asked to serve, and whom it lets watch. */
  const asked: unknown[] = []
  let viewer: (params: unknown) => Actor | undefined = (params) =>
    (params as { account?: { id: number } }).account?.id === 7 ||
    (params as { authorization?: string }).authorization === key
      ? { role: 'developer', accountId: 7, label: 'host:7' }
      : undefined
  /** Links the host to a master that serves `live` from the fake source. */
  const link = (serves = true): void => {
    const [a, b] = memoryPair()
    new Link(a, {
      localRole: 'master',
      peerRole: 'host',
      dialer: true,
      heartbeatMs: 0,
      methods: {
        // An older master serves no live pages.
        streams: !serves
          ? {}
          : {
              live: (stream, params): void => {
                asked.push(params)
                serveLiveStream(source, () => viewer(params), stream, {
                  checkMs: 50,
                })
              },
            },
      },
    })
    hostLink = new Link(b, {
      localRole: 'host',
      peerRole: 'master',
      dialer: false,
      heartbeatMs: 0,
      methods: {},
    })
  }
  before(async () => {
    source = new FakeLiveSource(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'host-live-'),
      ),
    )
    source.runs.set('r', liveRun('r', [liveStage('build', 'running', 1)]))
    writeFileSync(source.logFile('r', 'build'), 'one\n')
    link()
    const host = {
      accounts: {
        session: (value: string | undefined) =>
          signedIn && value === token
            ? { account: { id: 7 }, session: { permission_version: 3 } }
            : undefined,
      },
      options: { link: () => hostLink },
      online: () => online,
    } as unknown as HostRuntime
    server = createServer((_req, res) => res.end())
    fakeHost = host
    live = serveLive(server, hostLive(host, { maxStreams: 3 }), {
      pingMs: 50,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `127.0.0.1:${(server.address() as { port: number }).port}`
  })
  after(async () => {
    live.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const page = { cookie: `${SESSION_COOKIE}=${token}`, origin: '' }
  /** A page's socket and the frames it receives, or the status that refused it. */
  const connect = async (
    headers: Record<string, string> = {
      ...page,
      origin: `http://${base}`,
    },
    at = base,
  ): Promise<
    | number
    | {
        ws: WebSocket
        frames: LiveFrame[]
        closed: Promise<number>
        next: (test: (frame: LiveFrame) => boolean) => Promise<LiveFrame>
      }
  > => {
    const ws = new WebSocket(`ws://${at}/live`, { headers })
    ws.on('error', () => undefined)
    const frames: LiveFrame[] = []
    const heard: Array<() => void> = []
    ws.on('message', (data) => {
      frames.push(JSON.parse(String(data)) as LiveFrame)
      for (const wake of heard.splice(0)) wake()
    })
    const closed = new Promise<number>((resolve) =>
      ws.once('close', (code) => resolve(code)),
    )
    const status = await new Promise<number>((resolve) => {
      ws.once('open', () => resolve(0))
      ws.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 1)
        ws.terminate()
      })
    })
    if (status !== 0) return status
    const next = async (
      test: (frame: LiveFrame) => boolean,
    ): Promise<LiveFrame> => {
      for (;;) {
        const found = frames.find(test)
        if (found != null) return found
        await new Promise<void>((resolve) => heard.push(resolve))
      }
    }
    return { ws, frames, closed, next }
  }

  it('relays a page’s subscription to the master as its session’s account, and the master’s frames back', async () => {
    const socket = await connect()
    assert(typeof socket !== 'number')
    socket.ws.send(
      JSON.stringify({ subscribe: 'run', run: 'r', stage: 'build' }),
    )
    const first = await socket.next((frame) => frame.event === 'log')
    assert.deepEqual(first.data, {
      stage: 'build',
      offset: 4,
      first: 1,
      text: 'one\n',
    })
    assert.deepEqual(asked.at(-1), {
      account: { id: 7, permissionVersion: 3 },
    })
    source.write('r', 'build', 'two\n')
    const second = await socket.next(
      (frame) => frame.event === 'log' && frame !== first,
    )
    assert.equal((second.data as { text: string }).text, 'two\n')
    // A page that leaves ends its subscriptions on the master.
    socket.ws.close()
    assert.equal(await socket.closed, 1005)
    for (let n = 0; n < 100 && source.listeners.size > 0; n++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(source.listeners.size, 0)
  })

  it('refuses a page without a session or from another origin, and every page while the master is unreachable', async () => {
    assert.equal(await connect({ origin: `http://${base}` }), 401)
    assert.equal(await connect({ cookie: page.cookie }), 403)
    assert.equal(
      await connect({ ...page, origin: 'https://elsewhere.example' }),
      403,
    )
    online = false
    assert.equal(await connect(), 503)
    online = true
    // A script's key goes to the master, which authenticates it.
    // A header that is no key's token never reaches the master.
    const opened = asked.length
    assert.equal(await connect({ authorization: 'Bearer key' }), 401)
    assert.equal(asked.length, opened)
    const script = await connect({ authorization: key })
    assert(typeof script !== 'number')
    script.ws.send(JSON.stringify({ subscribe: 'status', run: 'r' }))
    assert.equal(
      (await script.next((frame) => frame.event === 'run')).key,
      'status:r',
    )
    assert.deepEqual(asked.at(-1), { authorization: key })
    script.ws.close()
    // One the master refuses is closed with its code.
    const refused = await connect({ authorization: other })
    assert(typeof refused !== 'number')
    assert.equal(await refused.closed, 1008)
  })

  it('closes pages with 1012 when the link drops, and a page that reconnects resumes after its last line', async () => {
    const socket = await connect()
    assert(typeof socket !== 'number')
    socket.ws.send(
      JSON.stringify({ subscribe: 'run', run: 'r', stage: 'build' }),
    )
    const last = await socket.next(
      (frame) =>
        frame.event === 'log' &&
        (frame.data as { text: string }).text.endsWith('two\n'),
    )
    hostLink!.close()
    assert.equal(await socket.closed, 1012)
    source.write('r', 'build', 'three\n')
    assert.equal(await connect(), 503)
    link()
    const again = await connect()
    assert(typeof again !== 'number')
    again.ws.send(
      JSON.stringify({
        subscribe: 'run',
        run: 'r',
        stage: 'build',
        after: (last.data as { offset: number }).offset,
      }),
    )
    const resumed = await again.next((frame) => frame.event === 'log')
    assert.deepEqual(resumed.data, {
      stage: 'build',
      offset: 14,
      first: 3,
      text: 'three\n',
    })
    // A session that ends on the host closes its pages.
    signedIn = false
    assert.equal(await again.closed, 1008)
    signedIn = true
    // So does a viewer the master stops trusting.
    const trusted = await connect()
    assert(typeof trusted !== 'number')
    const before = viewer
    viewer = (): undefined => undefined
    assert.equal(await trusted.closed, 1008)
    viewer = before
  })

  it('sends a page slower than the link a long log whole: the master waits for the page, not the host', async () => {
    const size = 40 * 1024 * 1024
    source.runs.set('big', liveRun('big', [liveStage('build', 'running', 1)]))
    writeFileSync(
      source.logFile('big', 'build'),
      ('s'.repeat(1023) + '\n').repeat(size / 1024),
    )
    // A server pinging at its usual pace, so a page that stops reading for a while stays.
    const slow = createServer((_req, res) => res.end())
    const slowLive = serveLive(slow, hostLive(fakeHost))
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    const at = `127.0.0.1:${(slow.address() as { port: number }).port}`
    try {
      const socket = await connect({ ...page, origin: `http://${at}` }, at)
      assert(typeof socket !== 'number')
      let reached = 0
      socket.ws.on('message', (data) => {
        const frame = JSON.parse(String(data)) as LiveFrame
        if (frame.event === 'log')
          reached = (frame.data as { offset: number }).offset
      })
      socket.ws.send(
        JSON.stringify({ subscribe: 'run', run: 'big', stage: 'build' }),
      )
      // The page stops reading for a while, as a slow connection does.
      socket.ws.pause()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      assert.equal(socket.ws.readyState, WebSocket.OPEN)
      socket.ws.resume()
      for (let n = 0; n < 1000 && reached < size; n++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(reached, size)
      assert.equal(socket.ws.readyState, WebSocket.OPEN)
      socket.ws.close()
      await socket.closed
    } finally {
      slowLive.close()
      await new Promise<void>((resolve) => slow.close(() => resolve()))
      source.runs.delete('big')
    }
  })

  it('holds a link to three live streams here, and closes pages for good with 4000 when the master serves no live pages', async () => {
    const pages = await Promise.all([connect(), connect(), connect()])
    assert.equal(await connect(), 503)
    for (const page of pages) if (typeof page !== 'number') page.ws.close()
    for (const page of pages) if (typeof page !== 'number') await page.closed
    // Pages that leave free their streams.
    let again: Awaited<ReturnType<typeof connect>> = 0
    for (let n = 0; n < 100 && typeof again === 'number'; n++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      again = await connect()
    }
    assert(typeof again !== 'number')
    again.ws.close()
    await again.closed
    hostLink!.close()
    link(false)
    const old = await connect()
    assert(typeof old !== 'number')
    assert.equal(await old.closed, 4000)
  })
})
