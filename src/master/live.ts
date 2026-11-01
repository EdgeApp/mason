import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Request } from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { cookie } from '../auth/routes.js'
import { queueEntries, type QueueEntry } from '../view/dashboard.js'
import { MASTER_SESSION_COOKIE, sessionActor } from './auth.js'
import { allow, allowRole, covers } from './permissions.js'
import type { Actor } from './roles.js'
import type { FeedEvent } from './runFeed.js'
import type { Master } from './runtime.js'

/** Where the master and the host accept the live pages' socket. */
export const LIVE_PATH = '/live'
/** How often the socket pings; a client that misses two is closed. */
const PING_MS = 25_000
/** The largest message a page may send. */
const MAX_MESSAGE = 4096
/** Log text per frame; a longer stretch goes in several, split at line ends. */
const MAX_LOG_TEXT = 256 * 1024
/** How much of a followed stage's log a page gets when it switches to it: its end, from a line's start. */
const FOLLOW_TAIL = 1024 * 1024
/** What a page that stops reading may hold unsent before it is dropped. */
const MAX_BUFFERED = 16 * 1024 * 1024
const MAX_SUBSCRIPTIONS = 200
/** A stage in these states writes no more lines. */
const SETTLED = new Set([
  'succeeded',
  'failed',
  'unstable',
  'cancelled',
  'skipped',
  'timed_out',
  'interrupted',
])

/** One stage of a run, as the run page draws it. */
export interface LiveStage {
  name: string
  kind: string
  status: string
  attempt: number
  node?: string
  started?: number
  finished?: number
  reason?: string
  disconnected?: true
}

/** A run's state, as the live pages show it. */
export interface LiveRun {
  project: string
  branch: string
  finished: boolean
  /** The run's status line: what the `run` event carries. */
  summary: {
    id: string
    number: number
    workflow: string
    branch: string
    status: string
    created: number
    started?: number
    finished?: number
    description?: string
    reason?: string
  }
  stages: LiveStage[]
}

export interface LiveStep {
  id: number
  kind: string
  title: string
  status: string
  ms: number | null
  parent: number | null
}

/** What the live socket reads: the master's runs, their stage logs and the queue. */
export interface LiveSource {
  subscribe(listener: (events: FeedEvent[]) => void): () => void
  run(id: string): LiveRun | undefined
  /** A stage's steps, of its latest attempt. */
  steps(id: string, stage: string): LiveStep[]
  logFile(id: string, stage: string): string
  queue(): QueueEntry[]
}

/** A frame the server sends: an event of one subscription, or an error. */
export interface LiveFrame {
  key?: string
  event: string
  data?: unknown
}

/** One end of a live connection, a WebSocket or a host's link stream. */
export interface LiveOutput {
  send(text: string): void
  close(code: number): void
}

type Message =
  | { unsubscribe: string }
  | {
      subscribe: 'run' | 'status' | 'queue'
      key: string
      run?: string
      stage?: string
      after?: number
      follow?: boolean
    }

/** Reads and checks one message a page sent. */
export function parseMessage(text: string): Message {
  if (text.length > MAX_MESSAGE) throw new Error('The message is too large')
  let value: Record<string, unknown>
  try {
    value = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('A message is one JSON object')
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('A message is one JSON object')
  const text100 = (field: string, max: number): string | undefined => {
    const out = value[field]
    if (out == null) return undefined
    if (typeof out !== 'string' || out === '' || out.length > max)
      throw new Error(`Invalid ${field}`)
    return out
  }
  if (value.unsubscribe != null)
    return { unsubscribe: text100('unsubscribe', 200)! }
  const kind = value.subscribe
  if (kind !== 'run' && kind !== 'status' && kind !== 'queue')
    throw new Error('Subscribe to a run, a run’s status or the queue')
  const key = text100('key', 200)
  if (kind === 'queue') return { subscribe: kind, key: key ?? 'queue' }
  const run = text100('run', 64)
  if (run == null) throw new Error('Name the run')
  const stage = text100('stage', 500)
  const after = value.after
  if (after != null && (!Number.isSafeInteger(after) || Number(after) < 0))
    throw new Error('Invalid after')
  return {
    subscribe: kind,
    key: key ?? `${kind}:${run}`,
    run,
    ...(stage == null || kind === 'status' ? {} : { stage }),
    ...(after == null ? {} : { after: Number(after) }),
    ...(value.follow === true ? { follow: true } : {}),
  }
}

/** Bytes of a file from `start` to `end`. */
function read(file: string, start: number, end: number): Buffer {
  const out = Buffer.alloc(end - start)
  const fd = openSync(file, 'r')
  try {
    let at = 0
    while (at < out.length) {
      const got = readSync(fd, out, at, out.length - at, start + at)
      if (got === 0) break
      at += got
    }
    return out.subarray(0, at)
  } finally {
    closeSync(fd)
  }
}

const newlines = (bytes: Buffer): number => {
  let count = 0
  for (let at = bytes.indexOf(0x0a); at >= 0; at = bytes.indexOf(0x0a, at + 1))
    count++
  return count
}

/** The number of the line that starts `offset` bytes into a file, read a megabyte at a time. */
function lineAt(file: string, offset: number): number {
  let line = 1
  for (let at = 0; at < offset; at += FOLLOW_TAIL)
    line += newlines(read(file, at, Math.min(offset, at + FOLLOW_TAIL)))
  return line
}

/** Where a followed stage's log is sent from: its last megabyte, from the start of a line. */
function tailStart(file: string): number {
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
  if (size <= FOLLOW_TAIL) return 0
  const from = size - FOLLOW_TAIL
  const end = read(file, from, size).indexOf(0x0a)
  return end < 0 ? size : from + end + 1
}

/** The stage a run's page follows: the running one that started last, else the one it shows. */
export function followed(
  stages: readonly LiveStage[],
  current: string | undefined,
): string | undefined {
  const latest = (list: LiveStage[]): string | undefined =>
    list.reduce<LiveStage | undefined>(
      (best, stage) =>
        best == null || (stage.started ?? 0) >= (best.started ?? 0)
          ? stage
          : best,
      undefined,
    )?.name
  const running = stages.filter((stage) => stage.status === 'running')
  if (running.length > 0) return latest(running)
  if (current != null) return current
  return latest(stages.filter((stage) => stage.started != null))
}

interface Watch {
  kind: 'run' | 'status' | 'queue'
  run: string
  /** Whether the stage follows the running one. */
  follow: boolean
  /** The stage whose steps and log it sends. */
  shown: string | undefined
  /** Bytes of the shown stage's log already sent. */
  offset: number
  /** The number of the next line sent. */
  line: number
  /** Whether the shown stage has finished, so its last partial line goes too. */
  settled: boolean
  /** Each event's last data, so an unchanged one is not sent again. */
  sent: Map<string, string>
}

/**
 * One page's live subscriptions. A `run` subscription sends the run's
 * `run`, `stages` and `steps` events whenever they change and its stage's
 * log as it grows, each `log` event carrying the byte offset it ends at and
 * its first line's number, so a page resubscribing `after` that offset
 * gets every later line once. Without a stage it follows the running one,
 * sending that stage's steps and the last megabyte of its log, from a
 * line's start, whenever it changes.
 * `status` sends only `run`; `queue`, the queue panel's entries. Every
 * subscription is checked as the HTTP routes check the same read; a run's
 * subscription ends with `end` once it has finished and its log is
 * drained, or `gone` when it is deleted.
 */
export class LiveSession {
  private readonly watches = new Map<string, Watch>()
  private readonly stop: () => void
  private ended = false

  constructor(
    private readonly source: LiveSource,
    private readonly viewer: () => Actor | undefined,
    private readonly out: LiveOutput,
  ) {
    // Registered before any snapshot is read: nothing written after it is missed.
    this.stop = source.subscribe((events) => this.hear(events))
  }

  receive(text: string): void {
    if (this.ended) return
    let message: Message
    try {
      message = parseMessage(text)
    } catch (error) {
      this.send({ event: 'error', data: { error: (error as Error).message } })
      return
    }
    if ('unsubscribe' in message) {
      this.watches.delete(message.unsubscribe)
      return
    }
    const actor = this.viewer()
    if (actor == null) {
      // The session or key has ended since the socket opened.
      this.out.close(1008)
      return
    }
    const key = message.key
    try {
      if (!this.watches.has(key) && this.watches.size >= MAX_SUBSCRIPTIONS)
        throw new Error('Too many subscriptions')
      allowRole(actor, 'runs.read')
      if (message.subscribe === 'queue') {
        const watch = this.watch('queue', '')
        this.watches.set(key, watch)
        this.queue(key, watch, actor)
        return
      }
      const run = this.source.run(message.run!)
      if (run == null) {
        this.watches.delete(key)
        this.send({ key, event: 'gone' })
        return
      }
      allow(actor, 'runs.read', { project: run.project, branch: run.branch })
      const watch = this.watch(message.subscribe, message.run!)
      if (message.subscribe === 'run') {
        watch.follow = message.stage == null || message.follow === true
        watch.shown = message.stage
        if (message.stage != null && message.after != null) {
          const file = this.source.logFile(watch.run, message.stage)
          const size =
            statSync(file, { throwIfNoEntry: false })?.size ?? message.after
          watch.offset = Math.min(message.after, size)
          watch.line = lineAt(file, watch.offset)
        }
      }
      this.watches.set(key, watch)
      this.refresh(key, watch, run)
    } catch (error) {
      this.watches.delete(key)
      this.send({
        key,
        event: 'error',
        data: { error: (error as Error).message },
      })
    }
  }

  /** Stops every subscription: the socket closed. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.stop()
    this.watches.clear()
  }

  private watch(kind: Watch['kind'], run: string): Watch {
    return {
      kind,
      run,
      follow: false,
      shown: undefined,
      offset: 0,
      line: 1,
      settled: false,
      sent: new Map(),
    }
  }

  private send(frame: LiveFrame): void {
    if (!this.ended) this.out.send(JSON.stringify(frame))
  }

  /** Sends an event unless its data is what was sent last. */
  private changed(
    key: string,
    watch: Watch,
    event: string,
    data: unknown,
  ): void {
    const text = JSON.stringify(data)
    if (watch.sent.get(event) === text) return
    watch.sent.set(event, text)
    this.send({ key, event, data })
  }

  private hear(events: FeedEvent[]): void {
    if (this.ended) return
    const runs = new Set<string>()
    const logs = new Set<string>()
    for (const event of events)
      if (event.kind === 'run') runs.add(event.run)
      else logs.add(`${event.run}\n${event.stage}`)
    for (const [key, watch] of [...this.watches]) {
      if (this.watches.get(key) !== watch) continue
      try {
        if (watch.kind === 'queue') {
          if (runs.size === 0) continue
          const actor = this.viewer()
          if (actor == null) {
            this.out.close(1008)
            return
          }
          this.queue(key, watch, actor)
        } else if (runs.has(watch.run)) this.refresh(key, watch)
        else if (
          watch.shown != null &&
          logs.has(`${watch.run}\n${watch.shown}`)
        )
          this.pump(key, watch)
      } catch (error) {
        this.watches.delete(key)
        this.send({
          key,
          event: 'error',
          data: { error: (error as Error).message },
        })
      }
    }
  }

  private queue(key: string, watch: Watch, actor: Actor): void {
    const entries = this.source
      .queue()
      .filter((entry) =>
        covers(actor, { project: entry.project, branch: entry.branch }),
      )
    // Elapsed times change on every read; the entries are what is compared.
    const same = JSON.stringify(
      entries.map(
        ({ elapsed: _elapsed, progress: _progress, ...rest }) => rest,
      ),
    )
    if (watch.sent.get('queue') === same) return
    watch.sent.set('queue', same)
    this.send({ key, event: 'queue', data: entries })
  }

  private refresh(key: string, watch: Watch, found?: LiveRun): void {
    const run = found ?? this.source.run(watch.run)
    if (run == null) {
      this.watches.delete(key)
      this.send({ key, event: 'gone' })
      return
    }
    this.changed(key, watch, 'run', run.summary)
    if (watch.kind === 'run') {
      this.changed(key, watch, 'stages', run.stages)
      if (watch.follow) {
        const next = followed(run.stages, watch.shown)
        if (next !== watch.shown) {
          watch.shown = next
          // A page switching to a stage starts at its log's end, as it opens.
          const file =
            next == null ? undefined : this.source.logFile(watch.run, next)
          watch.offset = file == null ? 0 : tailStart(file)
          watch.line = file == null ? 1 : lineAt(file, watch.offset)
          watch.sent.delete('steps')
        }
      }
      if (watch.shown != null) {
        const stage = run.stages.find((entry) => entry.name === watch.shown)
        watch.settled =
          run.finished || (stage != null && SETTLED.has(stage.status))
        this.changed(key, watch, 'steps', {
          stage: watch.shown,
          steps: this.source.steps(watch.run, watch.shown),
        })
        this.pump(key, watch)
      }
    }
    if (run.finished) {
      this.watches.delete(key)
      this.send({ key, event: 'end' })
    }
  }

  /** Sends the shown stage's log past what was sent: whole lines, and the rest once it has settled. */
  private pump(key: string, watch: Watch): void {
    const stage = watch.shown!
    const file = this.source.logFile(watch.run, stage)
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
    if (size <= watch.offset) return
    const chunk = read(file, watch.offset, size)
    const end = watch.settled ? chunk.length : chunk.lastIndexOf(0x0a) + 1
    for (let at = 0; at < end; ) {
      let stop = Math.min(end, at + MAX_LOG_TEXT)
      if (stop < end) {
        const before = chunk.lastIndexOf(0x0a, stop - 1)
        stop = before >= at ? before + 1 : chunk.indexOf(0x0a, stop) + 1 || end
      }
      const piece = chunk.subarray(at, stop)
      this.send({
        key,
        event: 'log',
        data: {
          stage,
          offset: watch.offset + stop,
          first: watch.line,
          text: piece.toString('utf8'),
        },
      })
      watch.line += newlines(piece)
      at = stop
    }
    watch.offset += end
  }
}

/** Whether an upgrade came from a page of the node it was sent to; undefined without an Origin. */
export function sameOrigin(req: IncomingMessage): boolean | undefined {
  const origin = req.headers.origin
  if (origin == null) return undefined
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** An accepted upgrade: how to start its connection, and whether its viewer may still watch. */
export interface LiveViewer {
  open(out: LiveOutput): { receive(text: string): void; end(): void }
  valid(): boolean
}

/**
 * Accepts `/live` WebSocket upgrades on a web listener. `accept` names the
 * viewer of an upgrade, or the HTTP status that refuses it before the
 * upgrade. The socket pings every 25 seconds and closes a client that has
 * not answered two, or whose viewer may no longer watch; closing the server
 * closes every socket with 1012, so pages reconnect to its successor.
 */
export function serveLive(
  server: Server,
  accept: (req: IncomingMessage) => LiveViewer | number,
  options: { pingMs?: number } = {},
): { close(): void } {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE,
    perMessageDeflate: false,
  })
  const sockets = new Map<WebSocket, { missed: number; viewer: LiveViewer }>()
  const refuse = (socket: Duplex, status: number): void => {
    socket.on('error', () => undefined)
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    )
  }
  const upgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (new URL(req.url ?? '/', 'http://node').pathname !== LIVE_PATH) {
      refuse(socket, 404)
      return
    }
    let viewer: LiveViewer | number
    try {
      viewer = accept(req)
    } catch {
      viewer = 500
    }
    if (typeof viewer === 'number') {
      refuse(socket, viewer)
      return
    }
    const accepted = viewer
    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry = { missed: 0, viewer: accepted }
      sockets.set(ws, entry)
      const connection = accepted.open({
        send: (text) => {
          if (ws.readyState !== ws.OPEN) return
          if (ws.bufferedAmount > MAX_BUFFERED) ws.terminate()
          else ws.send(text)
        },
        close: (code) => ws.close(code),
      })
      ws.on('pong', () => {
        entry.missed = 0
      })
      ws.on('message', (data, binary) => {
        if (binary) ws.close(1003)
        else connection.receive(String(data))
      })
      ws.on('close', () => {
        sockets.delete(ws)
        connection.end()
      })
      ws.on('error', () => undefined)
    })
  }
  server.on('upgrade', upgrade)
  const timer = setInterval(() => {
    for (const [ws, entry] of sockets) {
      if (entry.missed >= 2) ws.terminate()
      else if (!entry.viewer.valid()) ws.close(1008)
      else {
        entry.missed++
        ws.ping()
      }
    }
  }, options.pingMs ?? PING_MS)
  timer.unref()
  return {
    close: (): void => {
      clearInterval(timer)
      server.off('upgrade', upgrade)
      for (const ws of sockets.keys()) {
        ws.close(1012)
        setTimeout(() => ws.terminate(), 1000).unref()
      }
      wss.close()
    },
  }
}

/** The master's runs, stage logs and queue, for the live socket. */
export function masterLiveSource(master: Master): LiveSource {
  const db = master.database.db
  return {
    subscribe: (listener) => master.feed.subscribe(listener),
    run: (id): LiveRun | undefined => {
      const job = db
        .prepare(
          'SELECT j.id,j.number,j.workflow,j.branch,j.status,j.description,j.reason,j.created,j.started,j.finished,p.slug FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=?',
        )
        .get(id) as Record<string, string | number | null> | undefined
      if (job == null) return undefined
      const optional = <T>(name: string, value: T | null): Record<string, T> =>
        value == null ? {} : { [name]: value }
      const stages = (
        db
          .prepare(
            "SELECT name,kind,status,attempt,worker,started,finished,reason,disconnected FROM job_stages WHERE job_id=? AND name NOT LIKE '@%' ORDER BY position",
          )
          .all(id) as Array<Record<string, string | number | null>>
      ).map((row): LiveStage => {
        const worker = row.worker == null ? undefined : String(row.worker)
        return {
          name: String(row.name),
          kind: String(row.kind),
          status: String(row.status),
          attempt: Number(row.attempt),
          ...(worker == null
            ? {}
            : {
                node: master.registry.get(worker)?.name ?? worker.slice(0, 12),
              }),
          ...optional(
            'started',
            row.started == null ? null : Number(row.started),
          ),
          ...optional(
            'finished',
            row.finished == null ? null : Number(row.finished),
          ),
          ...optional('reason', row.reason == null ? null : String(row.reason)),
          ...(row.status === 'running' && Number(row.disconnected) === 1
            ? { disconnected: true as const }
            : {}),
        }
      })
      return {
        project: String(job.slug),
        branch: String(job.branch),
        finished: job.finished != null,
        summary: {
          id: String(job.id),
          number: Number(job.number),
          workflow: String(job.workflow),
          branch: String(job.branch),
          status: String(job.status),
          created: Number(job.created),
          ...optional(
            'started',
            job.started == null ? null : Number(job.started),
          ),
          ...optional(
            'finished',
            job.finished == null ? null : Number(job.finished),
          ),
          ...optional(
            'description',
            job.description == null ? null : String(job.description),
          ),
          ...optional('reason', job.reason == null ? null : String(job.reason)),
        },
        stages,
      }
    },
    steps: (id, stage): LiveStep[] =>
      (
        db
          .prepare(
            'SELECT id,kind,title,status,ms,parent FROM job_steps WHERE job_id=? AND stage=? AND attempt=(SELECT MAX(attempt) FROM job_steps WHERE job_id=? AND stage=?) ORDER BY id',
          )
          .all(id, stage, id, stage) as unknown as LiveStep[]
      ).map((step) => ({
        id: Number(step.id),
        kind: String(step.kind),
        title: String(step.title),
        status: String(step.status),
        ms: step.ms == null ? null : Number(step.ms),
        parent: step.parent == null ? null : Number(step.parent),
      })),
    logFile: (id, stage) => master.scheduler.logFile(id, stage),
    queue: () => queueEntries(db, master.database.now()),
  }
}

/** A key's actor while its key is valid. */
function keyViewer(master: Master, token: string): () => Actor | undefined {
  return () => {
    const key = master.keys.authenticate(token)
    if (key == null) return undefined
    try {
      return master.keys.actor(key)
    } catch {
      return undefined
    }
  }
}

/**
 * The master's `/live`: a master session from its own pages (the Origin
 * must be the master's), or an API key from a script, which may send no
 * Origin but never a foreign one.
 */
export function masterLive(
  master: Master,
  source: LiveSource = masterLiveSource(master),
): (req: IncomingMessage) => LiveViewer | number {
  return (req) => {
    const origin = sameOrigin(req)
    if (origin === false) return 403
    let viewer: () => Actor | undefined
    const header = req.headers.authorization
    if (header != null) {
      const token = /^Bearer (\S+)$/.exec(header)?.[1]
      if (token == null || master.keys.authenticate(token) == null) return 401
      viewer = keyViewer(master, token)
      if (viewer() == null) return 403
    } else {
      if (origin !== true) return 403
      const token = cookie(req as Request, MASTER_SESSION_COOKIE)
      viewer = (): Actor | undefined => {
        const session = master.auth.session(token)
        return session == null ? undefined : sessionActor(session)
      }
      if (viewer() == null) return 401
    }
    return {
      open: (out) => new LiveSession(source, viewer, out),
      valid: () => viewer() != null,
    }
  }
}
