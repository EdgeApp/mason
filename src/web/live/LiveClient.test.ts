import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import {
  LIVE_MESSAGE_BURST,
  LIVE_MESSAGES_PER_SECOND,
  LIVE_TOO_MANY,
} from '../../shared/live.js'
import { FakeLiveWindow } from '../test/fakeLiveSocket.js'
import {
  backoff,
  browserLiveWindow,
  CLIENT_BURST,
  CLIENT_MESSAGES_PER_SECOND,
  LIVE_UNAVAILABLE,
  LiveClient,
  liveUrl,
  type LiveState,
} from './LiveClient.js'

const client = (): {
  win: FakeLiveWindow
  live: LiveClient
  states: LiveState[]
} => {
  const win = new FakeLiveWindow()
  const live = new LiveClient('wss://mason.test/live', win)
  const states: LiveState[] = []
  live.onState((state) => states.push(state))
  return { win, live, states }
}

describe('The app’s live client', () => {
  it('goes to /live on its own origin, waiting 1, 2, 4… up to 30 s between tries', () => {
    assert.equal(
      liveUrl({ protocol: 'https:', host: 'mason.test:9300' }),
      'wss://mason.test:9300/live',
    )
    assert.equal(
      liveUrl({ protocol: 'http:', host: 'localhost' }),
      'ws://localhost/live',
    )
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 9].map(backoff),
      [1000, 2000, 4000, 8000, 16000, 30000, 30000],
    )
  })

  it('keeps below the node’s message budget: a burst at once, the rest one per refill, again after a reconnect', () => {
    // Headroom for messages that reach the node together although sent apart.
    assert.equal(CLIENT_BURST, 40)
    assert.equal(CLIENT_MESSAGES_PER_SECOND, 15)
    assert(CLIENT_BURST < LIVE_MESSAGE_BURST)
    assert(CLIENT_MESSAGES_PER_SECOND < LIVE_MESSAGES_PER_SECOND)
    const { win, live } = client()
    const runs = LIVE_MESSAGE_BURST + 10
    for (let n = 0; n < runs; n++)
      live.subscribe(
        `run-status:${n}`,
        () => ({ subscribe: 'status', run: String(n) }),
        () => undefined,
      )
    win.socket.accept()
    assert.equal(win.socket.sent.length, CLIENT_BURST)
    // The rest wait for the refill, one message's worth of time each.
    assert.deepEqual(win.tick(), [1000 / CLIENT_MESSAGES_PER_SECOND])
    assert.equal(win.socket.sent.length, CLIENT_BURST + 1)
    while (win.timers.size > 0) win.tick()
    assert.equal(win.socket.sent.length, runs)
    assert.deepEqual(
      win.socket.sent.map((message) => (message as { key: string }).key),
      Array.from({ length: runs }, (_, n) => `run-status:${n}`),
    )
    // A new socket has a new budget, and sends every subscription again.
    win.socket.drop(1006)
    win.tick()
    win.socket.accept()
    assert.equal(win.socket.sent.length, CLIENT_BURST)
    while (win.timers.size > 0) win.tick()
    assert.equal(win.socket.sent.length, runs)
    // What waited on a socket that closed is not sent on the next one.
    live.close()
    assert.equal(win.timers.size, 0)
  })

  it('sends a subscription the node refused as over its budget again after a refill, or its end if the page left it', () => {
    const { win, live } = client()
    const frames: string[] = []
    const stop = live.subscribe(
      'run:1',
      () => ({ subscribe: 'run', run: '1', after: 7 }),
      (frame) => frames.push(frame.event),
    )
    const leaving = live.subscribe(
      'run:2',
      () => ({ subscribe: 'run', run: '2' }),
      () => undefined,
    )
    win.socket.accept()
    assert.equal(win.socket.sent.length, 2)
    const refusal = (key?: string): void =>
      win.socket.frame({
        ...(key == null ? {} : { key }),
        event: 'error',
        data: { error: LIVE_TOO_MANY },
      })
    refusal('run:1')
    // Not at once: the node's budget is empty, so the client waits a refill.
    assert.equal(win.socket.sent.length, 2)
    assert.deepEqual(win.tick(), [1000 / CLIENT_MESSAGES_PER_SECOND])
    assert.deepEqual(win.socket.sent.at(-1), {
      subscribe: 'run',
      run: '1',
      after: 7,
      key: 'run:1',
    })
    // A refusal is the client's to handle, not the subscription's.
    assert.deepEqual(frames, [])
    // One the page has left meanwhile is not resubscribed; its end goes again.
    leaving()
    while (win.timers.size > 0) win.tick()
    const before = win.socket.sent.length
    refusal('run:2')
    while (win.timers.size > 0) win.tick()
    assert.deepEqual(win.socket.sent.slice(before), [{ unsubscribe: 'run:2' }])
    // A refusal naming nothing only slows the client down.
    refusal()
    assert.equal(win.timers.size, 0)
    assert.equal(win.socket.sent.length, before + 1)
    stop()
    assert.equal(win.socket.closed, true)
  })

  it('opens on the first subscription, sends each once open, and routes frames by key', () => {
    const { win, live, states } = client()
    assert.equal(live.state, 'connecting')
    const frames: string[] = []
    const stop = live.subscribe(
      'status',
      () => ({ subscribe: 'status' }),
      (frame) => frames.push(`a:${frame.event}`),
    )
    live.subscribe(
      'queue',
      () => ({ subscribe: 'queue' }),
      (frame) => frames.push(`b:${frame.event}`),
    )
    assert.equal(win.sockets.length, 1)
    assert.equal(win.socket.url, 'wss://mason.test/live')
    assert.deepEqual(win.socket.sent, [])
    win.socket.accept()
    assert.deepEqual(states, ['open'])
    assert.deepEqual(win.socket.sent, [
      { subscribe: 'status', key: 'status' },
      { subscribe: 'queue', key: 'queue' },
    ])
    live.subscribe(
      'run:1',
      () => ({ subscribe: 'run', run: '1' }),
      (frame) => frames.push(`c:${frame.event}`),
    )
    assert.deepEqual(win.socket.sent.at(-1), {
      subscribe: 'run',
      run: '1',
      key: 'run:1',
    })
    win.socket.frame({ key: 'status', event: 'status', data: {} })
    win.socket.frame({ key: 'nobody', event: 'queue' })
    win.socket.frame({ event: 'error', data: { error: 'bad' } })
    win.socket.frame('not json')
    win.socket.frame({ key: 'run:1', event: 'end' })
    win.socket.frame({ key: 'run:1', event: 'run' })
    assert.deepEqual(frames, ['a:status', 'c:end'])
    stop()
    stop()
    assert.deepEqual(win.socket.sent.at(-1), { unsubscribe: 'status' })
    assert.equal(win.socket.closed, false)
  })

  it('reconnects after a drop with a growing wait, resubscribing, and resets the wait once frames come', () => {
    const { win, live, states } = client()
    live.subscribe(
      'status',
      () => ({ subscribe: 'status' }),
      () => undefined,
    )
    win.socket.accept()
    win.socket.drop(1006)
    assert.deepEqual(states, ['open', 'reconnecting'])
    // A subscription while reconnecting waits for the socket.
    live.subscribe(
      'queue',
      () => ({ subscribe: 'queue' }),
      () => undefined,
    )
    assert.deepEqual(win.tick(), [1000])
    win.socket.drop(1012)
    assert.deepEqual(win.tick(), [2000])
    win.socket.accept()
    assert.deepEqual(win.socket.sent, [
      { subscribe: 'status', key: 'status' },
      { subscribe: 'queue', key: 'queue' },
    ])
    win.socket.frame({ key: 'status', event: 'status', data: {} })
    win.socket.drop(1006)
    assert.deepEqual(win.tick(), [1000])
    assert.equal(win.sockets.length, 4)
    // A stale socket's events are ignored.
    win.sockets[0]!.accept()
    win.sockets[0]!.frame({ key: 'status', event: 'status' })
    win.sockets[0]!.drop()
    assert.equal(live.state, 'reconnecting')
  })

  it('stops for good when the session ends (1008), and starts again on a new subscription', () => {
    const { win, live, states } = client()
    live.subscribe(
      'status',
      () => ({ subscribe: 'status' }),
      () => undefined,
    )
    win.socket.accept()
    win.socket.drop(1008)
    assert.deepEqual(states, ['open', 'closed'])
    assert.deepEqual(win.tick(), [])
    live.subscribe(
      'queue',
      () => ({ subscribe: 'queue' }),
      () => undefined,
    )
    assert.deepEqual(states, ['open', 'closed', 'connecting'])
    assert.equal(win.sockets.length, 2)
  })

  it('stops when the node serves no live updates (4000), and stays unavailable', () => {
    const { win, live, states } = client()
    const stop = live.subscribe(
      'status',
      () => ({ subscribe: 'status' }),
      () => undefined,
    )
    win.socket.drop(LIVE_UNAVAILABLE)
    assert.deepEqual(states, ['unavailable'])
    live.subscribe(
      'queue',
      () => ({ subscribe: 'queue' }),
      () => undefined,
    )
    assert.equal(win.sockets.length, 1)
    stop()
    live.close()
    assert.equal(live.state, 'unavailable')
  })

  it('closes when the last subscription ends, by unsubscribe or by `gone`, and when asked', () => {
    const { win, live } = client()
    live.subscribe(
      'run:9',
      () => ({ subscribe: 'run', run: '9' }),
      () => undefined,
    )
    win.socket.accept()
    win.socket.frame({ key: 'run:9', event: 'gone' })
    assert.equal(win.socket.closed, true)
    assert.equal(live.state, 'closed')
    const stop = live.subscribe(
      'status',
      () => ({ subscribe: 'status' }),
      () => undefined,
    )
    const socket = win.socket
    stop()
    assert.equal(socket.closed, true)
    live.subscribe(
      'status',
      () => ({ subscribe: 'status' }),
      () => undefined,
    )
    win.socket.drop()
    live.close()
    assert.deepEqual(win.tick(), [])
    // The closed socket's late close changes nothing.
    win.socket.drop()
    assert.equal(live.state, 'closed')
    const off = live.onState(() => assert.fail('unsubscribed'))
    off()
    live.subscribe(
      'x',
      () => ({ subscribe: 'queue' }),
      () => undefined,
    )
  })

  it('uses the browser’s WebSocket and timers', () => {
    const opened: string[] = []
    const timers: string[] = []
    const win = {
      WebSocket: class {
        constructor(url: string) {
          opened.push(url)
        }
      },
      setTimeout: (_run: () => void, ms: number) => {
        timers.push(`set ${ms}`)
        return 7
      },
      clearTimeout: (id: number) => timers.push(`clear ${id}`),
    } as unknown as Window
    const live = browserLiveWindow(win)
    live.open('wss://mason.test/live')
    assert.equal(
      live.setTimeout(() => undefined, 5),
      7,
    )
    live.clearTimeout(7)
    assert.deepEqual(opened, ['wss://mason.test/live'])
    assert.deepEqual(timers, ['set 5', 'clear 7'])
  })
})
