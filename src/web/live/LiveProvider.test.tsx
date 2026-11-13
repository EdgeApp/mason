import assert from 'node:assert/strict'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import type { JSX } from 'react'
import type { LiveFrame } from '../../shared/live.js'
import { FakeLiveWindow } from '../test/fakeLiveSocket.js'
import { LiveClient } from './LiveClient.js'
import {
  Invalidations,
  LiveProvider,
  useInvalidations,
  useLive,
  useLiveState,
  useLiveStatus,
} from './LiveProvider.js'
import { useRunStatuses } from './useRunStatuses.js'

afterEach(cleanup)

describe('Live updates in the app', () => {
  it('tells listeners when a topic is stale, until they stop listening', () => {
    const bus = new Invalidations()
    const heard: string[] = []
    const off = bus.on('status', () => heard.push('status'))
    bus.on('queue', () => heard.push('queue'))
    bus.invalidate('status')
    bus.invalidate('run')
    off()
    bus.invalidate('status')
    bus.invalidate('queue')
    assert.deepEqual(heard, ['status', 'queue'])
  })

  it('shows the socket’s state, the shell’s status, and invalidates the shell’s reads on each status', async () => {
    const win = new FakeLiveWindow()
    const live = new LiveClient('wss://mason.test/live', win)
    const bus = new Invalidations()
    let stale = 0
    bus.on('status', () => stale++)
    function Shell(): JSX.Element {
      const state = useLiveState()
      const status = useLiveStatus()
      return (
        <p>
          {state} {status?.cluster?.idle ?? '-'}
        </p>
      )
    }
    render(
      <LiveProvider client={live} invalidations={bus}>
        <Shell />
      </LiveProvider>,
    )
    screen.getByText('connecting -')
    await act(async () => win.socket.accept())
    screen.getByText('open -')
    assert.deepEqual(win.socket.sent, [
      { subscribe: 'status', key: 'shell-status' },
    ])
    await act(async () =>
      win.socket.frame({
        key: 'shell-status',
        event: 'status',
        data: {
          node: 'master',
          cluster: { idle: 2, total: 3, healthy: true },
          banners: [],
        },
      }),
    )
    screen.getByText('open 2')
    assert.equal(stale, 1)
    await act(async () =>
      win.socket.frame({
        key: 'shell-status',
        event: 'status',
        data: { node: 'nowhere' },
      }),
    )
    await act(async () =>
      win.socket.frame({ key: 'shell-status', event: 'queue', data: [] }),
    )
    screen.getByText('open 2')
    assert.equal(stale, 1)
    await act(async () => win.socket.drop(1006))
    screen.getByText('reconnecting 2')
  })

  it('subscribes while mounted and unsubscribes after, and does nothing without a client or a message', async () => {
    const win = new FakeLiveWindow()
    const live = new LiveClient('wss://mason.test/live', win)
    const frames: LiveFrame[] = []
    function Queue({ on }: { on: boolean }): JSX.Element {
      useLive('queue', on ? { subscribe: 'queue' } : undefined, (frame) =>
        frames.push(frame),
      )
      return <p>{useLiveState()}</p>
    }
    const { rerender } = render(
      <LiveProvider client={live}>
        <Queue on />
      </LiveProvider>,
    )
    await act(async () => win.socket.accept())
    await act(async () =>
      win.socket.frame({ key: 'queue', event: 'queue', data: [] }),
    )
    assert.equal(frames.length, 1)
    rerender(
      <LiveProvider client={live}>
        <Queue on={false} />
      </LiveProvider>,
    )
    assert.equal(win.socket.closed, true)
    cleanup()
    function Bare(): JSX.Element {
      useLive('queue', { subscribe: 'queue' }, () => undefined)
      useInvalidations().invalidate('queue')
      return <p>{useLiveState()}</p>
    }
    render(<Bare />)
    screen.getByText('closed')
    render(
      <LiveProvider>
        <Bare />
      </LiveProvider>,
    )
  })
})

describe('Run statuses on a list page', () => {
  it('subscribes only the runs a change adds and ends only those it drops', async () => {
    const win = new FakeLiveWindow()
    const live = new LiveClient('wss://mason.test/live', win)
    function Chips({ ids }: { ids: string[] }): JSX.Element {
      const statuses = useRunStatuses(
        ids.map((id) => ({ id, status: 'running' })),
      )
      return <p>{ids.map((id) => `${id}:${statuses[id] ?? '-'}`).join(' ')}</p>
    }
    const page = render(
      <LiveProvider client={live}>
        <Chips ids={['a', 'b']} />
      </LiveProvider>,
    )
    await act(async () => win.socket.accept())
    const sent = (): unknown[] => win.socket.sent.slice()
    assert.deepEqual(sent(), [
      { subscribe: 'status', run: 'a', key: 'run-status:a' },
      { subscribe: 'status', run: 'b', key: 'run-status:b' },
    ])
    // The queue moves on: c is added, a leaves, b stays subscribed.
    page.rerender(
      <LiveProvider client={live}>
        <Chips ids={['b', 'c']} />
      </LiveProvider>,
    )
    assert.deepEqual(sent().slice(2), [
      { unsubscribe: 'run-status:a' },
      { subscribe: 'status', run: 'c', key: 'run-status:c' },
    ])
    await act(async () =>
      win.socket.frame({
        key: 'run-status:b',
        event: 'run',
        data: { status: 'succeeded' },
      }),
    )
    screen.getByText('b:succeeded c:-')
    // Leaving the page ends what is left.
    page.unmount()
    assert.deepEqual(sent().slice(4), [
      { unsubscribe: 'run-status:b' },
      { unsubscribe: 'run-status:c' },
    ])
  })
})
