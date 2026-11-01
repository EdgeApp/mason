import assert from 'node:assert/strict'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { WebSocket } from 'ws'
import type { QueueEntry } from '../view/dashboard.js'
import {
  followed,
  LiveSession,
  parseMessage,
  sameOrigin,
  serveLive,
  type LiveFrame,
  type LiveRun,
  type LiveSource,
  type LiveStage,
  type LiveStep,
} from './live.js'
import type { Actor } from './roles.js'
import type { FeedEvent } from './runFeed.js'

const developer: Actor = { role: 'developer', accountId: 2, label: 'account:2' }

/** A run's rows and stage logs the test changes, with the feed it announces them on. */
class FakeSource implements LiveSource {
  readonly listeners = new Set<(events: FeedEvent[]) => void>()
  runs = new Map<string, LiveRun>()
  stepsOf = new Map<string, LiveStep[]>()
  entries: QueueEntry[] = []
  constructor(readonly dir: string) {}
  subscribe(listener: (events: FeedEvent[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  run(id: string): LiveRun | undefined {
    return structuredClone(this.runs.get(id))
  }
  steps(id: string, stage: string): LiveStep[] {
    return this.stepsOf.get(`${id}/${stage}`) ?? []
  }
  logFile(id: string, stage: string): string {
    return path.join(this.dir, `${id}-${encodeURIComponent(stage)}.log`)
  }
  queue(): QueueEntry[] {
    return this.entries
  }
  notify(...events: FeedEvent[]): void {
    for (const listener of [...this.listeners]) listener(events)
  }
  /** Appends to a stage's log and announces it. */
  write(id: string, stage: string, text: string): void {
    appendFileSync(this.logFile(id, stage), text)
    this.notify({ kind: 'log', run: id, stage })
  }
  /** Changes a run's rows and announces it. */
  change(id: string, edit: (run: LiveRun) => void): void {
    edit(this.runs.get(id)!)
    this.notify({ kind: 'run', run: id })
  }
}

const stage = (name: string, status: string, started?: number): LiveStage => ({
  name,
  kind: 'stage',
  status,
  attempt: 1,
  ...(started == null ? {} : { started }),
})

const runOf = (id: string, stages: LiveStage[], project = 'app'): LiveRun => ({
  project,
  branch: 'master',
  finished: false,
  summary: {
    id,
    number: 1,
    workflow: 'build',
    branch: 'master',
    status: 'running',
    created: 1,
  },
  stages,
})

/** A session whose frames are collected. */
function open(
  source: LiveSource,
  viewer: () => Actor | undefined = () => developer,
): { session: LiveSession; frames: LiveFrame[]; closed: number[] } {
  const frames: LiveFrame[] = []
  const closed: number[] = []
  const session = new LiveSession(source, viewer, {
    send: (text): void => {
      frames.push(JSON.parse(text) as LiveFrame)
    },
    close: (code): void => {
      closed.push(code)
    },
  })
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
    const source = new FakeSource(mkdtempSync(path.join(root, 'a-')))
    source.runs.set('r', runOf('r', [stage('build', 'running', 5)]))
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
    const source = new FakeSource(mkdtempSync(path.join(root, 'b-')))
    source.runs.set('r', runOf('r', [stage('build', 'running', 5)]))
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
    const source = new FakeSource(mkdtempSync(path.join(root, 'c-')))
    source.runs.set(
      'r',
      runOf('r', [stage('test', 'running', 10), stage('build', 'queued')]),
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
    assert.equal(followed([stage('a', 'queued')], undefined), undefined)
  })

  it('says gone for a run that is deleted or never was, and refuses what the viewer may not read', () => {
    const source = new FakeSource(mkdtempSync(path.join(root, 'd-')))
    source.runs.set('r', runOf('r', [stage('build', 'queued')]))
    source.runs.set('other', runOf('other', [], 'secret'))
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
    const source = new FakeSource(mkdtempSync(path.join(root, 'e-')))
    for (let n = 0; n < 201; n++) source.runs.set(`r${n}`, runOf(`r${n}`, []))
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
    const broken = new FakeSource(source.dir)
    broken.runs.set('r', runOf('r', [stage('build', 'running', 1)]))
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

  it('splits a long stretch of log into frames at line ends', () => {
    const source = new FakeSource(mkdtempSync(path.join(root, 'f-')))
    source.runs.set('r', runOf('r', [stage('build', 'running', 1)]))
    const line = 'x'.repeat(1000) + '\n'
    const long = 'y'.repeat(300 * 1024) + '\n'
    writeFileSync(source.logFile('r', 'build'), line.repeat(600) + long)
    const { session, frames } = open(source)
    session.receive(
      JSON.stringify({ subscribe: 'run', run: 'r', stage: 'build' }),
    )
    const logs = frames
      .filter((frame) => frame.event === 'log')
      .map((frame) => frame.data as { text: string; first: number })
    assert.equal(logs.length, 4)
    assert(logs.every((entry) => entry.text.endsWith('\n')))
    assert.deepEqual(
      logs.map((entry) => entry.first),
      [1, 262, 523, 601],
    )
    assert.equal(
      logs.map((entry) => entry.text).join(''),
      line.repeat(600) + long,
    )
  })

  it('sends a followed stage’s last megabyte of log, numbered from the line it starts on', () => {
    const source = new FakeSource(mkdtempSync(path.join(root, 'g-')))
    source.runs.set('r', runOf('r', [stage('build', 'running', 1)]))
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
