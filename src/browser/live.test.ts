import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { FakeLiveWindow } from '../test/fakeLiveSocket.js'
import {
  backoff,
  LiveClient,
  liveUrl,
  type LiveFrame,
  type LiveState,
} from './live.js'

describe('A page’s live socket', () => {
  it('opens /live on the page’s own origin', () => {
    assert.equal(
      liveUrl({ protocol: 'https:', host: 'mason.example:9300' }),
      'wss://mason.example:9300/live',
    )
    assert.equal(
      liveUrl({ protocol: 'http:', host: '127.0.0.1:1' }),
      'ws://127.0.0.1:1/live',
    )
  })

  it('waits 1, 2, 4… up to 30 seconds between reconnects', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 20].map(backoff),
      [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
    )
  })

  it('sends each subscription once open, routes frames by key, and resubscribes from where it left off after a drop', () => {
    const win = new FakeLiveWindow()
    const states: LiveState[] = []
    const client = new LiveClient('wss://m/live', win, (state) =>
      states.push(state),
    )
    let after = 0
    const heard: LiveFrame[] = []
    client.subscribe(
      'run',
      () => ({ subscribe: 'run', run: 'r', after }),
      (frame) => {
        heard.push(frame)
        after = (frame.data as { offset?: number } | undefined)?.offset ?? after
      },
    )
    const first = win.socket
    // Nothing is sent before the socket opens.
    client.subscribe(
      'queue',
      () => ({ subscribe: 'queue' }),
      () => undefined,
    )
    assert.deepEqual(first.sent, [])
    first.accept()
    assert.deepEqual(first.sent, [
      { subscribe: 'run', run: 'r', after: 0, key: 'run' },
      { subscribe: 'queue', key: 'queue' },
    ])
    first.frame({ key: 'run', event: 'log', data: { offset: 40 } })
    first.frame({ key: 'other', event: 'log' })
    first.onmessage?.({ data: 'not json' })
    assert.equal(heard.length, 1)
    // Each drop waits longer, until a frame shows the node is serving again.
    first.drop(1006)
    assert.equal(win.tick(), 1000)
    win.socket.drop(1006)
    assert.equal(win.tick(), 2000)
    win.socket.drop(1012)
    assert.equal(win.tick(), 4000)
    const back = win.socket
    back.accept()
    assert.deepEqual(back.sent[0], {
      subscribe: 'run',
      run: 'r',
      after: 40,
      key: 'run',
    })
    back.frame({ key: 'queue', event: 'queue', data: [] })
    back.drop(1006)
    assert.equal(win.tick(), 1000)
    assert.deepEqual(states, [
      'open',
      'reconnecting',
      'reconnecting',
      'reconnecting',
      'open',
      'reconnecting',
    ])
    // A stale socket's events are ignored.
    first.accept()
    first.frame({ key: 'run', event: 'log', data: { offset: 99 } })
    first.drop(1006)
    assert.equal(after, 40)
    client.close()
    assert(win.socket.closed)
  })

  it('finishes a subscription on end or gone, closes with the last, and stops for good on 1008', () => {
    const win = new FakeLiveWindow()
    const client = new LiveClient('wss://m/live', win)
    const events: string[] = []
    const stop = client.subscribe(
      'a',
      () => ({ subscribe: 'status', run: 'a' }),
      (frame) => events.push(`a ${frame.event}`),
    )
    client.subscribe(
      'b',
      () => ({ subscribe: 'status', run: 'b' }),
      (frame) => events.push(`b ${frame.event}`),
    )
    const socket = win.socket
    socket.accept()
    // A subscription made while open is sent at once.
    client.subscribe(
      'c',
      () => ({ subscribe: 'status', run: 'c' }),
      (frame) => events.push(`c ${frame.event}`),
    )
    assert.equal(socket.sent.length, 3)
    socket.frame({ key: 'a', event: 'gone' })
    // Unsubscribing one already finished sends nothing more.
    stop()
    assert.equal(socket.sent.length, 3)
    socket.frame({ key: 'b', event: 'end' })
    assert(!socket.closed)
    socket.frame({ key: 'c', event: 'end' })
    assert(socket.closed)
    assert.deepEqual(events, ['a gone', 'b end', 'c end'])
    // A new subscription opens a new socket; a policy close ends it.
    const unsubscribe = client.subscribe(
      'd',
      () => ({ subscribe: 'queue' }),
      () => undefined,
    )
    win.socket.accept()
    win.socket.drop(1008)
    assert.equal(win.timers.filter((timer) => !timer.cleared).length, 0)
    unsubscribe()
    // Unsubscribing the last closes the socket.
    const last = client.subscribe(
      'e',
      () => ({ subscribe: 'queue' }),
      () => undefined,
    )
    win.socket.accept()
    last()
    assert.deepEqual(win.socket.sent.at(-1), { unsubscribe: 'e' })
    assert(win.socket.closed)
    // A node whose master serves no live updates closes with 4000: final, and said so.
    const states: LiveState[] = []
    const old = new LiveClient('wss://m/live', win, (state) =>
      states.push(state),
    )
    old.subscribe(
      'f',
      () => ({ subscribe: 'queue' }),
      () => undefined,
    )
    win.socket.accept()
    win.socket.drop(4000)
    assert.deepEqual(states, ['open', 'unavailable'])
    assert.equal(win.timers.filter((timer) => !timer.cleared).length, 0)
    // A drop after the client closed waits for nothing.
    win.socket.drop(1006)
    assert.equal(win.timers.filter((timer) => !timer.cleared).length, 0)
  })
})
