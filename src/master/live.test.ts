import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { WebSocket } from 'ws'
import { Link, type Stream } from '../link/link.js'
import { memoryPair } from '../link/wire.js'
import type { QueueEntry } from '../view/dashboard.js'
import { FakeLiveSource, liveRun, liveStage } from '../test/fakeLiveSource.js'
import {
  asLiveStreamParams,
  fileLines,
  followed,
  lineCount,
  lineStart,
  LiveSession,
  parseMessage,
  sameOrigin,
  serveLive,
  serveLiveStream,
  type LiveFrame,
  type LiveOutput,
  type LiveRun,
  type LiveSource,
  logReads,
  MAX_LOG_TEXT,
  MAX_SOCKETS_PER_VIEWER,
} from './live.js'
import type { Actor } from './roles.js'

const developer: Actor = { role: 'developer', accountId: 2, label: 'account:2' }

/** A session whose frames are collected. */
function open(
  source: LiveSource,
  viewer: () => Actor | undefined = () => developer,
  options: { now?: () => number; output?: Partial<LiveOutput> } = {},
): { session: LiveSession; frames: LiveFrame[]; closed: number[] } {
  const frames: LiveFrame[] = []
  const closed: number[] = []
  const session = new LiveSession(
    source,
    viewer,
    {
      send: (text): void => {
        frames.push(JSON.parse(text) as LiveFrame)
      },
      close: (code): void => {
        closed.push(code)
      },
      ...options.output,
    },
    // A clock a second on per message, so no test page sends too fast.
    options.now ??
      ((): (() => number) => {
        let now = 0
        return () => (now += 1000)
      })(),
  )
  return { session, frames, closed }
}

const logText = (frames: LiveFrame[]): string =>
  frames
    .filter((frame) => frame.event === 'log')
    .map((frame) => (frame.data as { text: string }).text)
    .join('')

describe('Live socket sessions', () => {
  let root: string
  before(() => {
    root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'live-'),
    )
  })

  it('sends a run’s snapshot, then only the lines after the offset it was given, numbered on', () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'a-')))
    source.runs.set('r', liveRun('r', [liveStage('build', 'running', 5)]))
    source.stepsOf.set('r/build', [
      {
        id: 1,
        kind: 'sh',
        title: 'make',
        status: 'running',
        ms: null,
        parent: null,
      },
    ])
    writeFileSync(source.logFile('r', 'build'), 'one\ntwo\n')
    const { session, frames } = open(source)
    session.receive(
      JSON.stringify({
        subscribe: 'run',
        run: 'r',
        stage: 'build',
        after: Buffer.byteLength('one\n'),
      }),
    )
    assert.deepEqual(
      frames.map((frame) => [frame.key, frame.event]),
      [
        ['run:r', 'run'],
        ['run:r', 'stages'],
        ['run:r', 'steps'],
        ['run:r', 'log'],
      ],
    )
    assert.deepEqual(frames[3]!.data, {
      stage: 'build',
      offset: 8,
      first: 2,
      text: 'two\n',
    })
    frames.length = 0
    // A partial line waits for its end.
    source.write('r', 'build', 'thr')
    assert.equal(frames.length, 0)
    source.write('r', 'build', 'ee\nfou')
    assert.deepEqual(frames.at(-1)!.data, {
      stage: 'build',
      offset: 14,
      first: 3,
      text: 'three\n',
    })
    // An unchanged run sends nothing; a changed stage sends only what changed.
    frames.length = 0
    source.notify({ kind: 'run', run: 'r' })
    assert.equal(frames.length, 0)
    source.change('r', (run) => {
      run.stages[0]!.status = 'succeeded'
      run.stages[0]!.finished = 9
    })
    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['stages', 'log'],
    )
    // The settled stage's last partial line goes too.
    assert.deepEqual(frames.at(-1)!.data, {
      stage: 'build',
      offset: 17,
      first: 4,
      text: 'fou',
    })
    frames.length = 0
    source.change('r', (run) => {
      run.finished = true
      run.summary.status = 'succeeded'
    })
    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['run', 'end'],
    )
    frames.length = 0
    source.write('r', 'build', 'late\n')
    assert.equal(frames.length, 0)
    session.end()
    session.end()
    assert.equal(source.listeners.size, 0)
    session.receive(JSON.stringify({ subscribe: 'queue' }))
    assert.equal(frames.length, 0)
  })

  it('resumes by offset with no line lost or repeated across 1,000 lines written while pages reconnect', () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'b-')))
    source.runs.set('r', liveRun('r', [liveStage('build', 'running', 5)]))
    let received = ''
    let offset = 0
    let line = 1
    let page = open(source)
    const subscribe = (): void =>
      page.session.receive(
        JSON.stringify({
          subscribe: 'run',
          run: 'r',
          stage: 'build',
          after: offset,
        }),
      )
    subscribe()
    for (let n = 1; n <= 1000; n++) {
      // Lines arrive in uneven pieces, some split across writes.
      const text = `line ${n}\n`
      if (n % 7 === 0) {
        source.write('r', 'build', text.slice(0, 3))
        source.write('r', 'build', text.slice(3))
      } else source.write('r', 'build', text)
      for (const frame of page.frames.splice(0))
        if (frame.event === 'log') {
          const data = frame.data as {
            text: string
            offset: number
            first: number
          }
          assert.equal(data.first, line)
          received += data.text
          offset = data.offset
          line += data.text.split('\n').length - 1
        }
      if (n % 97 === 0) {
        // The page reconnects; lines written while it was away are not lost.
        page.session.end()
        source.write('r', 'build', `away ${n}\n`)
        page = open(source)
        subscribe()
      }
    }
    for (const frame of page.frames.splice(0))
      if (frame.event === 'log')
        received += (frame.data as { text: string }).text
    assert.equal(received, readFileSync(source.logFile('r', 'build'), 'utf8'))
    assert.equal(received.split('\n').length - 1, 1010)
  })

  it('follows the running stage when none is named, and switches to the next one from its start', () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'c-')))
    source.runs.set(
      'r',
      liveRun('r', [
        liveStage('test', 'running', 10),
        liveStage('build', 'queued'),
      ]),
    )
    writeFileSync(source.logFile('r', 'test'), 'testing\n')
    const { session, frames } = open(source)
    session.receive(JSON.stringify({ subscribe: 'run', run: 'r' }))
    assert.deepEqual(frames.at(-2)!.data, { stage: 'test', steps: [] })
    assert.deepEqual(frames.at(-1)!.data, {
      stage: 'test',
      offset: 8,
      first: 1,
      text: 'testing\n',
    })
    frames.length = 0
    source.change('r', (run) => {
      run.stages[0]!.status = 'succeeded'
    })
    // A finished stage stays on screen until another starts.
    assert.deepEqual(
      frames.map((frame) => frame.event),
      ['stages'],
    )
    frames.length = 0
    writeFileSync(source.logFile('r', 'build'), 'building\n')
    source.change('r', (run) => {
      run.stages[1]!.status = 'running'
      run.stages[1]!.started = 20
    })
    assert.deepEqual(
      frames.slice(1).map((frame) => frame.data),
      [
        { stage: 'build', steps: [] },
        { stage: 'build', offset: 9, first: 1, text: 'building\n' },
      ],
    )
    // A page resuming the stage it follows names it and keeps following.
    const resumed = open(source)
    resumed.session.receive(
      JSON.stringify({
        subscribe: 'run',
        run: 'r',
        stage: 'build',
        after: 9,
        follow: true,
      }),
    )
    assert.equal(logText(resumed.frames), '')
    source.write('r', 'build', 'more\n')
    assert.equal(logText(resumed.frames), 'more\n')
    // With nothing running, a page opens on the stage that started last.
    source.change('r', (run) => {
      run.stages[1]!.status = 'failed'
    })
    const late = open(source)
    late.session.receive(JSON.stringify({ subscribe: 'run', run: 'r' }))
    assert.equal(logText(late.frames), 'building\nmore\n')
    assert.equal(followed([liveStage('a', 'queued')], undefined), undefined)
  })

  it('says gone for a run that is deleted or never was, and refuses what the viewer may not read', () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'd-')))
    source.runs.set('r', liveRun('r', [liveStage('build', 'queued')]))
    source.runs.set('other', liveRun('other', [], 'secret'))
    const { session, frames } = open(source)
    session.receive(JSON.stringify({ subscribe: 'run', run: 'none' }))
    assert.deepEqual(frames.splice(0), [{ key: 'run:none', event: 'gone' }])
    session.receive(
      JSON.stringify({ subscribe: 'status', run: 'r', key: 'chip' }),
    )
    assert.deepEqual(
      frames.splice(0).map((frame) => [frame.key, frame.event]),
      [['chip', 'run']],
    )
    source.runs.delete('r')
    source.notify({ kind: 'run', run: 'r' })
    assert.deepEqual(frames.splice(0), [{ key: 'chip', event: 'gone' }])
    const tester = open(source, () => ({ role: 'tester', label: 'account:9' }))
    tester.session.receive(JSON.stringify({ subscribe: 'run', run: 'other' }))
    assert.equal(tester.frames[0]!.event, 'error')
    assert.match(
      (tester.frames[0]!.data as { error: string }).error,
      /tester role/,
    )
    const scoped = open(source, () => ({
      role: 'developer',
      keyId: 'k',
      label: 'key:k',
      scopes: { projects: ['app'], branches: [] },
    }))
    scoped.session.receive(JSON.stringify({ subscribe: 'run', run: 'other' }))
    assert.match(
      (scoped.frames[0]!.data as { error: string }).error,
      /does not cover/,
    )
    // The queue shows only the runs a key covers, and only when they change.
    source.entries = [
      {
        job: 'a',
        project: 'app',
        workflow: 'build',
        number: 1,
        branch: 'master',
        stage: 'build',
        status: 'running',
        elapsed: 5,
      },
      {
        job: 'b',
        project: 'secret',
        workflow: 'build',
        number: 2,
        branch: 'master',
        stage: 'build',
        status: 'queued',
      },
    ]
    scoped.frames.length = 0
    scoped.session.receive(JSON.stringify({ subscribe: 'queue' }))
    assert.deepEqual(
      (scoped.frames[0]!.data as QueueEntry[]).map((entry) => entry.job),
      ['a'],
    )
    source.entries[0]!.elapsed = 6
    source.notify({ kind: 'run', run: 'a' })
    source.notify({ kind: 'log', run: 'a', stage: 'build' })
    assert.equal(scoped.frames.length, 1)
    source.entries[0]!.status = 'queued'
    source.notify({ kind: 'run', run: 'a' })
    assert.equal(scoped.frames.length, 2)
    scoped.session.receive(JSON.stringify({ unsubscribe: 'queue' }))
    source.entries[0]!.status = 'running'
    source.notify({ kind: 'run', run: 'a' })
    assert.equal(scoped.frames.length, 2)
  })

  it('closes a session whose viewer has gone, answers bad messages with an error, and limits subscriptions', () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'e-')))
    for (let n = 0; n < 201; n++) source.runs.set(`r${n}`, liveRun(`r${n}`, []))
    let actor: Actor | undefined = developer
    const page = open(source, () => actor)
    for (const text of [
      'not json',
      '[1]',
      '{"subscribe":"everything"}',
      '{"subscribe":"run"}',
      '{"subscribe":"run","run":"r0","after":-1}',
      '{"unsubscribe":5}',
      JSON.stringify({ subscribe: 'queue', key: 'k'.repeat(5000) }),
    ])
      page.session.receive(text)
    assert.deepEqual(
      page.frames.map((frame) => (frame.data as { error: string }).error),
      [
        'A message is one JSON object',
        'A message is one JSON object',
        'Subscribe to a run, a run’s status or the queue',
        'Name the run',
        'Invalid after',
        'Invalid unsubscribe',
        'The message is too large',
      ],
    )
    page.frames.length = 0
    for (let n = 0; n < 201; n++)
      page.session.receive(
        JSON.stringify({ subscribe: 'status', run: `r${n}` }),
      )
    assert.deepEqual(page.frames.at(-1), {
      key: 'status:r200',
      event: 'error',
      data: { error: 'Too many subscriptions' },
    })
    // A failing read ends only its own subscription.
    const broken = new FakeLiveSource(source.dir)
    broken.runs.set('r', liveRun('r', [liveStage('build', 'running', 1)]))
    const reading = open(broken)
    reading.session.receive(JSON.stringify({ subscribe: 'run', run: 'r' }))
    broken.run = (): LiveRun => {
      throw new Error('The database is locked')
    }
    broken.notify({ kind: 'run', run: 'r' })
    assert.deepEqual(reading.frames.at(-1), {
      key: 'run:r',
      event: 'error',
      data: { error: 'The database is locked' },
    })
    const watching = open(source, () => actor)
    watching.session.receive(JSON.stringify({ subscribe: 'queue' }))
    actor = undefined
    source.notify({ kind: 'run', run: 'r0' })
    assert.deepEqual(watching.closed, [1008])
    watching.session.receive(JSON.stringify({ subscribe: 'status', run: 'r0' }))
    assert.deepEqual(watching.closed, [1008, 1008])
  })

  it('splits a long stretch of log into frames at line ends, and a line longer than a frame into pieces marked partial', () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'f-')))
    source.runs.set('r', liveRun('r', [liveStage('build', 'running', 1)]))
    const line = 'x'.repeat(1000) + '\n'
    // Three-byte characters: a piece never ends inside one.
    const long = '€'.repeat(100 * 1024) + '\n'
    writeFileSync(source.logFile('r', 'build'), line.repeat(600) + long)
    const { session, frames } = open(source)
    session.receive(
      JSON.stringify({ subscribe: 'run', run: 'r', stage: 'build' }),
    )
    const logs = frames
      .filter((frame) => frame.event === 'log')
      .map(
        (frame) =>
          frame.data as { text: string; first: number; partial?: true },
      )
    assert.deepEqual(
      logs.map((entry) => [entry.first, entry.partial ?? false]),
      [
        [1, false],
        [262, false],
        [523, false],
        [601, true],
        [601, false],
      ],
    )
    assert(!logs[3]!.text.includes('\ufffd'))
    assert(Buffer.byteLength(logs[3]!.text) <= MAX_LOG_TEXT)
    assert.equal(
      logs.map((entry) => entry.text).join(''),
      line.repeat(600) + long,
    )
  })

  it('reads a running stage’s unfinished line only where it grew, and sends one longer than a frame in pieces', () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'p-')))
    source.runs.set('r', liveRun('r', [liveStage('build', 'running', 1)]))
    writeFileSync(source.logFile('r', 'build'), '')
    const { session, frames } = open(source)
    session.receive(
      JSON.stringify({ subscribe: 'run', run: 'r', stage: 'build' }),
    )
    source.write('r', 'build', 'p'.repeat(200 * 1024))
    const before = logReads.bytes
    // Progress drawn with carriage returns: no line end for a long while.
    for (let n = 0; n < 50; n++) source.write('r', 'build', '\r')
    assert(logReads.bytes - before < 1024, String(logReads.bytes - before))
    assert.equal(logText(frames), '')
    source.write('r', 'build', 'q'.repeat(100 * 1024))
    const pieces = frames.filter((frame) => frame.event === 'log')
    assert.equal(pieces.length, 1)
    assert.equal((pieces[0]!.data as { partial?: true }).partial, true)
    source.write('r', 'build', 'done\n')
    assert.equal(
      logText(frames),
      readFileSync(source.logFile('r', 'build'), 'utf8'),
    )
  })

  it('sends a megabyte of log a turn, and waits while the page has a megabyte unread', async () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'q-')))
    source.runs.set('r', liveRun('r', [liveStage('build', 'running', 1)]))
    const line = 'w'.repeat(1023) + '\n'
    writeFileSync(source.logFile('r', 'build'), line.repeat(5 * 1024))
    let pending = 0
    let drain: (() => void) | undefined
    const page = open(source, undefined, {
      output: {
        pending: () => pending,
        drained: async () => {
          await new Promise<void>((resolve) => (drain = resolve))
        },
      },
    })
    page.session.receive(
      JSON.stringify({ subscribe: 'run', run: 'r', stage: 'build' }),
    )
    const sent = (): number =>
      page.frames
        .filter((frame) => frame.event === 'log')
        .reduce(
          (sum, frame) => sum + (frame.data as { text: string }).text.length,
          0,
        )
    assert.equal(sent(), 1024 * 1024)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sent(), 2 * 1024 * 1024)
    // The page falls behind: nothing more until its output drains.
    pending = 2 * 1024 * 1024
    for (let n = 0; n < 5; n++)
      await new Promise((resolve) => setImmediate(resolve))
    const held = sent()
    assert(held <= 3 * 1024 * 1024)
    for (let n = 0; n < 5; n++)
      await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sent(), held)
    // The run finishes meanwhile: its end waits for the log.
    source.change('r', (run) => {
      run.finished = true
      run.stages[0]!.status = 'succeeded'
    })
    assert(!page.frames.some((frame) => frame.event === 'end'))
    pending = 0
    drain!()
    for (let n = 0; n < 10 && sent() < 5 * 1024 * 1024; n++)
      await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sent(), 5 * 1024 * 1024)
    assert.equal(page.frames.at(-1)!.event, 'end')
    // A page that leaves stops the rest.
    const leaving = open(source)
    leaving.session.receive(
      JSON.stringify({ subscribe: 'run', run: 'r', stage: 'build' }),
    )
    leaving.session.end()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(logText(leaving.frames).length, 1024 * 1024)
  })

  it('numbers a resume deep in a long log over several turns, then at once from its index; tail starts at the end; a step view takes no log', async () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'i-')))
    source.runs.set('r', liveRun('r', [liveStage('build', 'running', 1)]))
    const line = 'v'.repeat(99) + '\n'
    writeFileSync(source.logFile('r', 'build'), line.repeat(60_000))
    const subscribe = (extra: Record<string, unknown>): LiveFrame[] => {
      const page = open(source)
      page.session.receive(
        JSON.stringify({
          subscribe: 'run',
          run: 'r',
          stage: 'build',
          ...extra,
        }),
      )
      return page.frames
    }
    const deep = subscribe({ after: 5_000_000 })
    assert.equal(logText(deep), '')
    for (let n = 0; n < 20 && logText(deep) === ''; n++)
      await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      (deep.find((frame) => frame.event === 'log')!.data as { first: number })
        .first,
      50_001,
    )
    const again = subscribe({ after: 5_500_000 })
    assert.equal(
      (again.find((frame) => frame.event === 'log')!.data as { first: number })
        .first,
      55_001,
    )
    const tail = subscribe({ tail: true })
    const first = tail.find((frame) => frame.event === 'log')!.data as {
      first: number
      text: string
    }
    assert.equal(first.first, 60_000 - Math.floor((1024 * 1024) / 100) + 1)
    const step = subscribe({ log: false })
    assert.deepEqual(
      step.map((frame) => frame.event),
      ['run', 'stages', 'steps'],
    )
    source.write('r', 'build', 'more\n')
    assert.deepEqual(
      step.map((frame) => frame.event),
      ['run', 'stages', 'steps'],
    )
  })

  it('holds every subscription of a page that has a megabyte unread, not just the one that filled it', async () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'm-')))
    const stages = Array.from({ length: 8 }, (_, n) =>
      liveStage(`s${n}`, 'running', 1),
    )
    source.runs.set('r', liveRun('r', stages))
    for (const stage of stages)
      writeFileSync(
        source.logFile('r', stage.name),
        ('m'.repeat(1023) + '\n').repeat(1024),
      )
    let pending = 0
    let most = 0
    let drain: (() => void) | undefined
    const page = open(source, undefined, {
      output: {
        send: (text): void => {
          pending += text.length
          most = Math.max(most, pending)
        },
        pending: () => pending,
        drained: async () => {
          await new Promise<void>((resolve) => (drain = resolve))
        },
      },
    })
    for (const stage of stages)
      page.session.receive(
        JSON.stringify({
          subscribe: 'run',
          run: 'r',
          stage: stage.name,
          key: stage.name,
        }),
      )
    for (let n = 0; n < 5; n++)
      await new Promise((resolve) => setImmediate(resolve))
    assert(most <= 1024 * 1024 + 64 * 1024, String(most))
    pending = 0
    drain!()
    page.session.end()
  })

  it('counts a long log’s lines once for every page that waits on it, and stops when they leave', async () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'c-')))
    source.runs.set('r', liveRun('r', [liveStage('build', 'running', 1)]))
    const line = 'c'.repeat(99) + '\n'
    writeFileSync(source.logFile('r', 'build'), line.repeat(60_000))
    const deep = (): ReturnType<typeof open> => {
      const page = open(source)
      page.session.receive(
        JSON.stringify({
          subscribe: 'run',
          run: 'r',
          stage: 'build',
          after: 5_000_000,
        }),
      )
      return page
    }
    const before = logReads.bytes
    const pages = [deep(), deep()]
    for (
      let n = 0;
      n < 40 && pages.some((page) => logText(page.frames) === '');
      n++
    )
      await new Promise((resolve) => setImmediate(resolve))
    assert(pages.every((page) => logText(page.frames) !== ''))
    assert(logReads.bytes - before < 9_000_000, String(logReads.bytes - before))
    // A page that leaves mid-count stops it.
    writeFileSync(source.logFile('r', 'build'), line.repeat(200_000))
    const leaving = open(source)
    const start = logReads.bytes
    leaving.session.receive(
      JSON.stringify({
        subscribe: 'run',
        run: 'r',
        stage: 'build',
        after: 19_000_000,
      }),
    )
    leaving.session.end()
    for (let n = 0; n < 30; n++)
      await new Promise((resolve) => setImmediate(resolve))
    assert(logReads.bytes - start < 3_000_000, String(logReads.bytes - start))
  })

  it('answers a page that sends too fast with an error, until its allowance refills', () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 't-')))
    source.runs.set('r', liveRun('r', []))
    let now = 0
    const page = open(source, undefined, { now: () => now })
    for (let n = 0; n < 60; n++)
      page.session.receive(JSON.stringify({ subscribe: 'status', run: 'r' }))
    const refused = (): number =>
      page.frames.filter(
        (frame) =>
          (frame.data as { error?: string } | undefined)?.error ===
          'Too many messages: send fewer',
      ).length
    assert.equal(refused(), 10)
    now += 1000
    for (let n = 0; n < 21; n++)
      page.session.receive(JSON.stringify({ subscribe: 'status', run: 'r' }))
    assert.equal(refused(), 11)
  })

  it('sends a followed stage’s last megabyte of log, numbered from the line it starts on', () => {
    const source = new FakeLiveSource(mkdtempSync(path.join(root, 'g-')))
    source.runs.set('r', liveRun('r', [liveStage('build', 'running', 1)]))
    const line = 'z'.repeat(99) + '\n'
    writeFileSync(source.logFile('r', 'build'), line.repeat(20_000))
    const { session, frames } = open(source)
    session.receive(JSON.stringify({ subscribe: 'run', run: 'r' }))
    const logs = frames
      .filter((frame) => frame.event === 'log')
      .map((frame) => frame.data as { text: string; first: number })
    const sent = logs.map((entry) => entry.text).join('')
    assert.equal(sent.length, Math.floor((1024 * 1024) / 100) * 100)
    assert.equal(logs[0]!.first, 20_000 - sent.length / 100 + 1)
    // A page resuming deep into a long log is numbered on from there.
    const resumed = open(source)
    resumed.session.receive(
      JSON.stringify({
        subscribe: 'run',
        run: 'r',
        stage: 'build',
        after: 1_500_000,
      }),
    )
    const resumedLogs = resumed.frames
      .filter((frame) => frame.event === 'log')
      .map((frame) => frame.data as { first: number })
    assert.deepEqual(
      resumedLogs.map((entry) => entry.first),
      [15_001, 15_001 + 2621],
    )
  })

  it('reads whom a host’s live stream serves strictly', () => {
    assert.deepEqual(
      asLiveStreamParams({ account: { id: 1, permissionVersion: 2 } }),
      { account: { id: 1, permissionVersion: 2 } },
    )
    assert.deepEqual(asLiveStreamParams({ authorization: 'Bearer k' }), {
      authorization: 'Bearer k',
    })
    for (const value of [
      undefined,
      {},
      { account: { id: 1, permissionVersion: 2 }, authorization: 'Bearer k' },
      { account: { id: 'one', permissionVersion: 2 } },
      { authorization: 5 },
      { authorization: 'x'.repeat(600) },
    ])
      assert.throws(() => asLiveStreamParams(value), /one account or one key/)
  })

  it('reads messages strictly', () => {
    assert.deepEqual(parseMessage('{"subscribe":"queue"}'), {
      subscribe: 'queue',
      key: 'queue',
    })
    assert.deepEqual(
      parseMessage('{"subscribe":"status","run":"r","stage":"x","after":3}'),
      { subscribe: 'status', key: 'status:r', run: 'r', after: 3 },
    )
    assert.throws(() => parseMessage('null'), /one JSON object/)
  })
})

describe('A log read by line number', () => {
  it('finds any line of a log past its index marks, as reading the whole log would', async () => {
    const root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'lines-'),
    )
    // 3.4 MB of lines of every length, so lines cross each 1 MB mark.
    const lines = Array.from(
      { length: 60_000 },
      (_, index) => `line ${index + 1} ${'x'.repeat(index % 97)}`,
    )
    const file = path.join(root, 'stage.log')
    writeFileSync(file, lines.join('\n') + '\n')
    const whole = readFileSync(file)
    assert(whole.length > 3 * 1024 * 1024)
    assert.equal(await lineCount(file), lines.length)
    let offset = 0
    const starts = lines.map((line) => {
      const at = offset
      offset += Buffer.byteLength(line) + 1
      return at
    })
    for (const n of [1, 2, 9_999, 17_321, 30_000, 45_123, 59_999, 60_000])
      assert.equal(await lineStart(file, n), starts[n - 1], `line ${n}`)
    assert.equal(await lineStart(file, 60_001), whole.length)
    const page = await fileLines(file, 45_000, 500)
    assert.equal(page.first, 45_000)
    assert.deepEqual(
      page.text.split('\n').slice(0, -1),
      lines.slice(44_999, 45_499),
    )
    assert.equal(page.end, starts[45_499])
    // At the end: what is left. Within a step's bytes: only those.
    assert.equal(
      (await fileLines(file, 59_999, 500)).text,
      lines.slice(59_998).join('\n') + '\n',
    )
    const step = await fileLines(file, 100, 500, {
      from: starts[99],
      to: starts[102],
    })
    assert.equal(step.text, lines.slice(99, 102).join('\n') + '\n')
    // A last line with no newline yet is a line.
    const open = path.join(root, 'open.log')
    writeFileSync(open, 'one\ntwo')
    assert.equal(await lineCount(open), 2)
    assert.equal((await fileLines(open, 2, 10)).text, 'two')
    assert.equal(await lineCount(path.join(root, 'none.log')), 0)
  })
})

describe('Live socket server', () => {
  let server: Server
  let url: string
  let live: { close(): void }
  const opened: string[] = []
  let valid = true
  before(async () => {
    server = createServer((_req, res) => res.end('page'))
    live = serveLive(
      server,
      (req: IncomingMessage) => {
        if (req.headers.authorization === 'Bearer broken')
          throw new Error('broken')
        if (sameOrigin(req) === false) return 403
        if (req.headers.authorization !== 'Bearer good') return 401
        return {
          open: (out): { receive(text: string): void; end(): void } => ({
            receive: (text): void => {
              opened.push(text)
              if (text === 'close') out.close(4000)
              else out.send(`echo ${text}`)
            },
            end: (): void => {
              opened.push('end')
            },
          }),
          valid: (): boolean => valid,
          ...(req.headers['x-who'] == null
            ? {}
            : { who: String(req.headers['x-who']) }),
        }
      },
      { pingMs: 50 },
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    url = `ws://127.0.0.1:${address.port}`
  })
  after(async () => {
    live.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const connect = async (
    target: string,
    headers: Record<string, string>,
    options: { autoPong?: boolean } = {},
  ): Promise<WebSocket | number> => {
    const ws = new WebSocket(target, { headers, ...options })
    return await new Promise((resolve) => {
      ws.once('open', () => resolve(ws))
      ws.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0)
        ws.terminate()
      })
      ws.once('error', () => resolve(0))
    })
  }
  const closed = async (ws: WebSocket): Promise<number> =>
    await new Promise((resolve) => ws.once('close', (code) => resolve(code)))

  it('refuses an upgrade before it happens: another path, no viewer, a foreign origin or a failure', async () => {
    assert.equal(
      await connect(`${url}/link`, { authorization: 'Bearer good' }),
      404,
    )
    assert.equal(await connect(`${url}/live`, {}), 401)
    assert.equal(
      await connect(`${url}/live`, {
        authorization: 'Bearer good',
        origin: 'https://elsewhere.example',
      }),
      403,
    )
    assert.equal(
      await connect(`${url}/live`, { authorization: 'Bearer broken' }),
      500,
    )
    assert.equal(
      await (await fetch(`${url.replace('ws:', 'http:')}/live`)).text(),
      'page',
    )
  })

  it('relays text both ways, refuses binary, and closes a viewer who may no longer watch', async () => {
    const ws = (await connect(`${url}/live?x=1`, {
      authorization: 'Bearer good',
      origin: url.replace('ws:', 'http:'),
    })) as WebSocket
    const echoed = new Promise((resolve) =>
      ws.once('message', (data) => resolve(String(data))),
    )
    ws.send('hello')
    assert.equal(await echoed, 'echo hello')
    const done = closed(ws)
    ws.send(Buffer.from('binary'))
    assert.equal(await done, 1003)
    const again = (await connect(`${url}/live`, {
      authorization: 'Bearer good',
    })) as WebSocket
    const asked = closed(again)
    again.send('close')
    assert.equal(await asked, 4000)
    const watching = (await connect(`${url}/live`, {
      authorization: 'Bearer good',
    })) as WebSocket
    valid = false
    assert.equal(await closed(watching), 1008)
    valid = true
    assert(opened.includes('end'))
  })

  it('holds one viewer to 16 sockets at once', async () => {
    const headers = { authorization: 'Bearer good', 'x-who': 'dana' }
    const sockets = await Promise.all(
      Array.from(
        { length: MAX_SOCKETS_PER_VIEWER },
        async () => await connect(`${url}/live`, headers),
      ),
    )
    assert(sockets.every((ws) => typeof ws !== 'number'))
    assert.equal(await connect(`${url}/live`, headers), 429)
    assert.notEqual(
      typeof (await connect(`${url}/live`, { ...headers, 'x-who': 'eli' })),
      'number',
    )
    const one = sockets[0] as WebSocket
    const gone = closed(one)
    one.close()
    await gone
    const again = await connect(`${url}/live`, headers)
    assert.notEqual(typeof again, 'number')
  })

  it('closes a client that misses two pings, and every socket with 1012 when it closes', async () => {
    const silent = (await connect(
      `${url}/live`,
      { authorization: 'Bearer good' },
      { autoPong: false },
    )) as WebSocket
    const answering = (await connect(`${url}/live`, {
      authorization: 'Bearer good',
    })) as WebSocket
    assert.equal(await closed(silent), 1006)
    assert.equal(answering.readyState, WebSocket.OPEN)
    const restarting = closed(answering)
    live.close()
    assert.equal(await restarting, 1012)
  })
})

describe('Live streams over a link', () => {
  /** A host's end of a `live` stream the master serves from `source`. */
  const opened = (source: FakeLiveSource): Stream => {
    const [a, b] = memoryPair()
    new Link(a, {
      localRole: 'master',
      peerRole: 'host',
      dialer: true,
      heartbeatMs: 0,
      methods: {
        streams: {
          live: (stream): void => {
            serveLiveStream(source, () => developer, stream)
          },
        },
      },
    })
    return new Link(b, {
      localRole: 'host',
      peerRole: 'master',
      dialer: false,
      heartbeatMs: 0,
      methods: {},
    }).openStream('live', {})
  }

  it('sends a log far larger than a page may leave unread, paced by the stream’s credit', async () => {
    const source = new FakeLiveSource(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'paced-'),
      ),
    )
    source.runs.set('r', liveRun('r', [liveStage('build', 'running', 1)]))
    const size = 24 * 1024 * 1024
    writeFileSync(
      source.logFile('r', 'build'),
      ('u'.repeat(1023) + '\n').repeat(size / 1024),
    )
    const stream = opened(source)
    let reached = 0
    let aborted: string | undefined
    stream.once('abort', (reason: string) => (aborted = reason))
    let partial = ''
    stream.on('data', (chunk: Buffer) => {
      partial += String(chunk)
      for (
        let end = partial.indexOf('\n');
        end >= 0;
        end = partial.indexOf('\n')
      ) {
        const frame = JSON.parse(partial.slice(0, end)) as LiveFrame
        partial = partial.slice(end + 1)
        if (frame.event === 'log')
          reached = (frame.data as { offset: number }).offset
      }
    })
    await stream.write(
      Buffer.from(
        JSON.stringify({ subscribe: 'run', run: 'r', stage: 'build' }) + '\n',
      ),
    )
    for (let n = 0; n < 3000 && reached < size && aborted == null; n++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(aborted, undefined)
    assert.equal(reached, size)
    stream.abort()
  })

  it('sends one frame per line, and aborts a stream whose line is too long', async () => {
    const source = new FakeLiveSource(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'stream-'),
      ),
    )
    source.runs.set('r', liveRun('r', []))
    const stream = opened(source)
    const lines: string[] = []
    stream.on('data', (chunk: Buffer) => lines.push(String(chunk)))
    await stream.write(
      Buffer.from(
        JSON.stringify({ subscribe: 'status', run: 'r' }) +
          '\n' +
          JSON.stringify({ subscribe: 'queue' }) +
          '\n',
      ),
    )
    for (let n = 0; n < 100 && !lines.join('').includes('queue'); n++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual(
      lines
        .join('')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => (JSON.parse(line) as LiveFrame).event),
      ['run', 'queue'],
    )
    const aborted = new Promise((resolve) => stream.once('abort', resolve))
    await stream.write(Buffer.alloc(5000, 0x61))
    assert.equal(await aborted, 'A line is too long')
    for (let n = 0; n < 100 && source.listeners.size > 0; n++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(source.listeners.size, 0)
  })
})
