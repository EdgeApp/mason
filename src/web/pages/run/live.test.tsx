import assert from 'node:assert/strict'
import { act, cleanup, screen } from '@testing-library/react'
import { after, afterEach, before, describe, it } from 'mocha'
import type { RunPage } from '../../../shared/api/index.js'
import type { LiveFrame } from '../../../shared/live.js'
import { fakeLogLayout } from '../../test/layout.js'
import { until } from '../../test/render.js'
import { RunLive, type LiveRunState } from './runLive.js'
import {
  heading,
  logOf,
  open,
  RUN_PATH,
  runFixture,
  text,
} from '../../test/runs.js'

afterEach(() => cleanup())

const NOW = Date.now()

/** A run under way: checkout done, build/ios running, publish queued. */
const running = (fields: Partial<RunPage> = {}): RunPage => {
  const base = runFixture()
  return runFixture({
    status: 'running',
    finished: null,
    stages: [
      base.stages[0]!,
      { ...base.stages[1]!, status: 'running', finished: null, attempt: 1 },
      { ...base.stages[2]!, status: 'queued', started: null, finished: null },
    ],
    ...fields,
  })
}

const sent = (app: ReturnType<typeof open>): Array<Record<string, unknown>> =>
  app.live.sockets.flatMap(
    (socket) => socket.sent as Array<Record<string, unknown>>,
  )
const runMessages = (
  app: ReturnType<typeof open>,
): Array<Record<string, unknown>> =>
  sent(app).filter((message) => message.key === 'run:r1')
const frame = async (
  app: ReturnType<typeof open>,
  value: Omit<LiveFrame, 'key'>,
): Promise<void> => {
  await act(async () => app.live.socket.frame({ key: 'run:r1', ...value }))
}
const lines = (): string[] =>
  [...document.querySelectorAll('.m-log__line .m-log__t')].map(
    (line) => line.textContent ?? '',
  )

describe('Run page, live', () => {
  let restore: () => void
  before(() => {
    restore = fakeLogLayout()
  })
  after(() => restore())

  it('follows the running stage: its status, stages, steps and log update in place, a long line joins its pieces, and a new status reads the run again', async () => {
    const app = open('/runs/r1', {
      [RUN_PATH]: running(),
      '/api/v2/runs/r1/logs': logOf(40),
    })
    await heading('Build 26110902')
    await act(async () => app.live.socket.accept())
    assert.deepEqual(runMessages(app), [
      { subscribe: 'run', run: 'r1', key: 'run:r1' },
    ])
    const reads = (): number =>
      app.node.requests.filter((request) => request.endsWith(RUN_PATH)).length
    assert.equal(reads(), 1)
    await frame(app, {
      event: 'run',
      data: { ...running(), status: 'running', started: NOW - 60_000 },
    })
    await frame(app, {
      event: 'stages',
      data: running().stages.map((stage) => ({
        name: stage.name,
        kind: stage.kind,
        status: stage.status,
        attempt: stage.attempt,
        ...(stage.node == null ? {} : { node: stage.node }),
      })),
    })
    // The node follows build/ios: its steps, then its log from the end.
    await frame(app, {
      event: 'steps',
      data: {
        stage: 'build/ios',
        steps: [
          {
            id: 1,
            kind: 'xcode',
            title: 'xcodebuild archive',
            status: 'running',
            ms: null,
            parent: null,
          },
        ],
      },
    })
    await screen.findByRole('region', {
      name: '● build/ios following the running stage',
    })
    await until(
      () =>
        app.node.requests.includes(
          'GET /api/v2/runs/r1/logs?stage=build%2Fios&last=1&count=500',
        ),
      'the followed stage’s end',
    )
    await until(() => lines().includes('line 40'), 'the end of its log')
    assert.match(
      text(document.querySelector('.m-steps')!),
      /xcodebuild archive, Runningxcode · —/,
    )
    await frame(app, {
      event: 'log',
      data: { stage: 'build/ios', offset: 900, first: 41, text: 'line 41\n' },
    })
    await frame(app, {
      event: 'log',
      data: {
        stage: 'build/ios',
        offset: 950,
        first: 42,
        text: 'a very lo',
        partial: true,
      },
    })
    assert(!lines().some((line) => line.startsWith('a very')))
    await frame(app, {
      event: 'log',
      data: { stage: 'build/ios', offset: 960, first: 42, text: 'ng line\n' },
    })
    await until(
      () => lines().includes('a very long line'),
      'the joined long line',
    )
    assert(lines().includes('line 41'))
    // Another stage's log is not this one's.
    await frame(app, {
      event: 'log',
      data: { stage: 'checkout', offset: 10, first: 43, text: 'elsewhere\n' },
    })
    assert(!lines().includes('elsewhere'))
    // The stage finishes: the bubble and list change at once, the change is
    // said, and the run is read again.
    await frame(app, {
      event: 'stages',
      data: running().stages.map((stage) => ({
        name: stage.name,
        kind: stage.kind,
        status: stage.name === 'build/ios' ? 'succeeded' : stage.status,
        attempt: stage.attempt,
      })),
    })
    assert.equal(
      document
        .querySelector('.m-gbubble[data-stage="build/ios"]')!
        .getAttribute('data-status'),
      'succeeded',
    )
    await until(() => reads() === 2, 'the run read again')
    await until(
      () =>
        document.querySelector('.m-page > p[role="status"]')!.textContent ===
        'build/ios succeeded',
      'the announcement',
    )
    // A stage the page does not know reads it again too.
    await frame(app, {
      event: 'stages',
      data: [
        { name: 'surprise', kind: 'stage', status: 'running', attempt: 1 },
      ],
    })
    await until(() => reads() === 3, 'the run read for a new stage')
    // The run's own status moves.
    await frame(app, {
      event: 'run',
      data: { ...running(), status: 'failed', finished: NOW },
    })
    await until(() => reads() === 4, 'the run read for its status')
    // The end: the run is read once more, and the socket lets go of it.
    app.node.set(RUN_PATH, runFixture())
    await frame(app, { event: 'end' })
    await until(() => reads() === 5, 'the finished run')
    await screen.findByRole('region', { name: 'Whole run log' })
  })

  it('resumes a chosen stage after the last byte it received, takes no log for a step, and says when it reconnects or cannot follow', async () => {
    const app = open('/runs/r1?stage=build%2Fios', {
      [RUN_PATH]: running(),
      '/api/v2/runs/r1/logs': logOf(10),
    })
    await heading('Build 26110902')
    await act(async () => app.live.socket.accept())
    assert.deepEqual(runMessages(app).at(-1), {
      subscribe: 'run',
      run: 'r1',
      stage: 'build/ios',
      tail: true,
      key: 'run:r1',
    })
    await until(() => lines().includes('line 10'), 'the log’s end')
    await frame(app, {
      event: 'log',
      data: { stage: 'build/ios', offset: 512, first: 11, text: 'line 11\n' },
    })
    await until(() => lines().includes('line 11'), 'the live line')
    // A drop: Reconnecting… beside the status, then a resume after byte 512.
    await act(async () => app.live.socket.drop(1006))
    await until(
      () =>
        document
          .querySelector('.m-page__header')!
          .textContent!.includes('Reconnecting…'),
      'Reconnecting… beside the status',
    )
    await act(async () => {
      app.live.tick()
    })
    await act(async () => app.live.socket.accept())
    assert.deepEqual(runMessages(app).at(-1), {
      subscribe: 'run',
      run: 'r1',
      stage: 'build/ios',
      after: 512,
      key: 'run:r1',
    })
    // A node that serves no live updates: the header says so, and the
    // shell's banner offers Reload.
    await act(async () => app.live.socket.drop(4000))
    await screen.findByLabelText(
      'Live updates are unavailable here: reload for the latest',
    )
    cleanup()
    const step = open('/runs/r1?stage=build%2Fios&step=1', {
      [RUN_PATH]: running(),
    })
    await heading('Build 26110902')
    await act(async () => step.live.socket.accept())
    assert.deepEqual(runMessages(step).at(-1), {
      subscribe: 'run',
      run: 'r1',
      stage: 'build/ios',
      log: false,
      key: 'run:r1',
    })
  })

  it('resumes a followed stage after the last byte it received, so a long line cut by a drop joins once', async () => {
    const app = open('/runs/r1', {
      [RUN_PATH]: running(),
      '/api/v2/runs/r1/logs': logOf(40),
    })
    await heading('Build 26110902')
    await act(async () => app.live.socket.accept())
    const steps = {
      event: 'steps',
      data: { stage: 'build/ios', steps: [] },
    } as const
    await frame(app, steps)
    await until(() => lines().includes('line 40'), 'the followed stage’s end')
    await frame(app, {
      event: 'log',
      data: { stage: 'build/ios', offset: 900, first: 41, text: 'line 41\n' },
    })
    await frame(app, {
      event: 'log',
      data: {
        stage: 'build/ios',
        offset: 950,
        first: 42,
        text: 'a very lo',
        partial: true,
      },
    })
    // A drop mid-line: the resume names the followed stage and the byte
    // the page reached, still following.
    await act(async () => app.live.socket.drop(1006))
    await act(async () => {
      app.live.tick()
    })
    await act(async () => app.live.socket.accept())
    assert.deepEqual(runMessages(app).at(-1), {
      subscribe: 'run',
      run: 'r1',
      stage: 'build/ios',
      follow: true,
      after: 950,
      key: 'run:r1',
    })
    // The node sends the same stage's steps and the rest of the line.
    await frame(app, steps)
    await frame(app, {
      event: 'log',
      data: { stage: 'build/ios', offset: 960, first: 42, text: 'ng line\n' },
    })
    await frame(app, {
      event: 'log',
      data: { stage: 'build/ios', offset: 968, first: 43, text: 'line 43\n' },
    })
    await until(() => lines().includes('line 43'), 'the tail')
    assert.deepEqual(lines().slice(-4), [
      'line 40',
      'line 41',
      'a very long line',
      'line 43',
    ])
  })

  it('counts a running stage’s time up each second', async () => {
    // Started a minute ago now, not when the fixtures loaded: past an hour
    // the time reads in minutes and would not move each second.
    const run = running()
    run.stages[1] = { ...run.stages[1]!, started: Date.now() - 60_000 }
    open('/runs/r1?stage=build%2Fios', { [RUN_PATH]: run })
    await heading('Build 26110902')
    const facts = (): string => text(document.querySelector('.m-kv')!)
    assert.match(facts(), /Running/)
    const before = facts()
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await until(() => facts() !== before, 'the time to count up')
  })

  it('keeps its live state as a pure machine: the message as of now, and what each frame means', () => {
    const calls: string[] = []
    let state: LiveRunState | undefined
    const live = new RunLive(
      'r1',
      new Set(['a', 'b']),
      undefined,
      undefined,
      {
        log: (stage, body, first): number =>
          calls.push(`log ${stage} ${first} ${body}`),
        follow: (stage): number => calls.push(`follow ${stage}`),
        stale: (): number => calls.push('stale'),
      },
      (next) => {
        state = next
      },
    )
    assert.deepEqual(live.message(), { subscribe: 'run', run: 'r1' })
    live.apply({ event: 'steps', data: { stage: 'a', steps: [] } })
    live.apply({ event: 'steps', data: { stage: 'a', steps: [] } })
    live.apply({
      event: 'log',
      data: { stage: 'a', offset: 3, first: 1, text: 'x\n' },
    })
    live.apply({
      event: 'log',
      data: { stage: 'a', offset: 5, first: 2, text: 'y', partial: true },
    })
    // A resume follows on from the shown stage's last byte.
    assert.deepEqual(live.message(), {
      subscribe: 'run',
      run: 'r1',
      stage: 'a',
      follow: true,
      after: 5,
    })
    live.apply({
      event: 'log',
      data: { stage: 'a', offset: 7, first: 2, text: 'z\n' },
    })
    live.apply({ event: 'steps', data: { stage: 'b', steps: [] } })
    // A new stage followed has none of its log yet: no offset.
    assert.deepEqual(live.message(), { subscribe: 'run', run: 'r1' })
    live.apply({ event: 'error', data: { error: 'nope' } })
    live.apply({ event: 'gone' })
    assert.deepEqual(calls, [
      'follow a',
      'log a 1 x\n',
      'log a 2 yz\n',
      'follow b',
      'stale',
    ])
    assert.equal(state!.following, 'b')
    assert.equal(state!.ended, true)
  })
})
