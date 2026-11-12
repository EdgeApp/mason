import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Request } from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { cookie } from '../auth/routes.js'
import type { Stream } from '../link/link.js'
import { queueEntries, type QueueEntry } from '../view/dashboard.js'
import { hostSessionActor } from './api.js'
import { MASTER_SESSION_COOKIE, sessionActor } from './auth.js'
import { allow, allowRole, covers } from './permissions.js'
import type { Actor } from './roles.js'
import type { FeedEvent } from './runFeed.js'
import type { Master } from './runtime.js'
import {
  LIVE_PATH,
  type LiveEvent,
  type LiveFrame,
  type LiveMessage,
  type LiveRun,
  type LiveStage,
  type LiveStep,
} from '../shared/live.js'

export { LIVE_PATH }
export type { LiveFrame, LiveRun, LiveStage, LiveStep }

/** How often the socket pings; a client that misses two is closed. */
const PING_MS = 25_000
/** The largest message a page may send. */
const MAX_MESSAGE = 4096
/** Log text per frame; a longer stretch goes in several, split at line ends, or within a line longer than this. */
export const MAX_LOG_TEXT = 256 * 1024
/** Log bytes sent to one page in one turn of the event loop. */
const TURN_BYTES = 1024 * 1024
/** Unsent bytes past which a page's log waits until its output drains to a quarter of this. */
const HIGH_WATER = 1024 * 1024
/** How much of a followed stage's log a page gets when it switches to it: its end, from a line's start. */
const FOLLOW_TAIL = 1024 * 1024
/** What a page that stops reading may hold unsent before it is dropped. */
const MAX_BUFFERED = 16 * 1024 * 1024
const MAX_SUBSCRIPTIONS = 200
/** Messages a page may send at once, and how many more it may send each second. */
const MESSAGE_BURST = 50
const MESSAGES_PER_SECOND = 20
/** Sockets one viewer may hold open at once on a node. */
export const MAX_SOCKETS_PER_VIEWER = 16
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

/** What the live socket reads: the master's runs, their stage logs and the queue. */
export interface LiveSource {
  subscribe(listener: (events: FeedEvent[]) => void): () => void
  run(id: string): LiveRun | undefined
  /** A stage's steps, of its latest attempt. */
  steps(id: string, stage: string): LiveStep[]
  logFile(id: string, stage: string): string
  queue(): QueueEntry[]
}

/** One end of a live connection, a WebSocket or a host's link stream. */
export interface LiveOutput {
  send(text: string): void
  close(code: number): void
  /** Bytes sent but not yet written; none when absent. */
  pending?(): number
  /** Resolves once the unsent bytes fall to a quarter of the high-water mark, or the output closes. */
  drained?(): Promise<void>
}

/**
 * Counts what an output has sent but not yet written, and wakes whoever
 * waits for it to drain.
 */
class Backlog {
  private bytes = 0
  private waiting: Array<() => void> = []
  get pending(): number {
    return this.bytes
  }
  add(bytes: number): void {
    this.bytes += bytes
  }
  written(bytes: number): void {
    this.bytes -= bytes
    if (this.bytes <= HIGH_WATER / 4) this.wake()
  }
  async drained(): Promise<void> {
    if (this.bytes <= HIGH_WATER / 4) return
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }
  wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve()
  }
}

/** Reads and checks one message a page sent. */
export function parseMessage(text: string): LiveMessage {
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
    ...(value.tail === true && after == null ? { tail: true } : {}),
    ...(value.log === false ? { log: false } : {}),
  }
}

/** Log bytes read, so a test can tell a partial line is not read again on each append. */
export const logReads = { bytes: 0 }

/** Bytes of a file from `start` to `end`. */
function read(file: string, start: number, end: number): Buffer {
  logReads.bytes += end - start
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

/** Bytes between a line index's marks, and the most read for it in one turn. */
const MARK = 1024 * 1024
/** Line indexes kept, the least recently used dropped first. */
const MAX_INDEXES = 256

/** A log's line number at every megabyte, and who waits for it to reach further. */
interface LineIndex {
  id: string
  marks: number[]
  /** The marks each waiting count needs, and how to answer it. */
  waiting: Set<{ target: number; done: (error?: unknown) => void }>
  /** Whether a count is extending the marks, a megabyte per turn. */
  counting: boolean
}

/** Each log's line index, so a resume deep into a log reads only the last part. */
const lineIndexes = new Map<string, LineIndex>()

/** The index of a log, kept while it is the same file. */
function lineIndex(file: string): LineIndex {
  const stat = statSync(file, { throwIfNoEntry: false })
  const id = stat == null ? '' : `${stat.dev}:${stat.ino}`
  let index = lineIndexes.get(file)
  if (index == null || index.id !== id)
    index = { id, marks: [1], waiting: new Set(), counting: false }
  lineIndexes.delete(file)
  lineIndexes.set(file, index)
  if (lineIndexes.size > MAX_INDEXES)
    lineIndexes.delete(lineIndexes.keys().next().value!)
  return index
}

/**
 * Extends a log's marks a megabyte per turn while anyone still waits, as
 * far as the furthest of them needs; one count per log serves them all.
 */
async function count(file: string, index: LineIndex): Promise<void> {
  index.counting = true
  try {
    for (;;) {
      const reached = index.marks.length - 1
      for (const waiter of [...index.waiting])
        if (waiter.target <= reached) {
          index.waiting.delete(waiter)
          waiter.done()
        }
      if (index.waiting.size === 0) return
      const at = reached
      index.marks.push(
        index.marks[at]! + newlines(read(file, at * MARK, (at + 1) * MARK)),
      )
      await new Promise((resolve) => setImmediate(resolve))
    }
  } catch (error) {
    for (const waiter of index.waiting) waiter.done(error)
    index.waiting.clear()
  } finally {
    index.counting = false
  }
}

/** A line count still under way, and how to stop waiting for it. */
export interface Counting {
  line: Promise<number>
  cancel(): void
}

/**
 * The number of the line that holds byte `offset` of a log: at once when
 * its index reaches near there, or a megabyte of the index per turn,
 * shared with every other count of the same log and stopped once no one
 * waits.
 */
export function lineAt(file: string, offset: number): number | Counting {
  const index = lineIndex(file)
  const marks = index.marks
  const target = Math.floor(offset / MARK)
  const finish = (): number =>
    marks[target]! + newlines(read(file, target * MARK, offset))
  if (marks.length - 1 >= target - 1) {
    while (marks.length - 1 < target) {
      const at = marks.length - 1
      marks.push(marks[at]! + newlines(read(file, at * MARK, (at + 1) * MARK)))
    }
    return finish()
  }
  let waiter: { target: number; done: (error?: unknown) => void }
  const line = new Promise<number>((resolve, reject) => {
    waiter = {
      target,
      done: (error): void => {
        if (error != null) reject(error as Error)
        else
          try {
            resolve(finish())
          } catch (failed) {
            reject(failed as Error)
          }
      },
    }
    index.waiting.add(waiter)
  })
  if (!index.counting) void count(file, index)
  return {
    line,
    cancel: (): void => {
      index.waiting.delete(waiter)
    },
  }
}

/** Where a piece of log may end at most `length` bytes in without splitting a UTF-8 character. */
function characterEnd(bytes: Buffer, length: number): number {
  let start = length - 1
  while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--
  const lead = bytes[start]!
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return start + size > length ? start : length
}

/** Where a followed stage's log is sent from: its last megabyte, from the start of a line. */
function tailStart(file: string): number {
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
  if (size <= FOLLOW_TAIL) return 0
  const from = size - FOLLOW_TAIL
  const end = read(file, from, size).indexOf(0x0a)
  return end < 0 ? size : from + end + 1
}

/** The most a page asks for at once, and the most text one answer carries. */
export const MAX_PAGE_LINES = 2000
const MAX_PAGE_BYTES = 4 * 1024 * 1024

/** A log's lines from number `first`, and where they end, in bytes. */
export interface FileLines {
  first: number
  text: string
  /** The byte after the last one returned. */
  end: number
}

/** The line number at a byte offset, waiting for the index when it must. */
export async function lineNumber(
  file: string,
  offset: number,
): Promise<number> {
  const found = lineAt(file, offset)
  return typeof found === 'number' ? found : await found.line
}

/** Whether the byte before `offset` of a log is a newline. */
export function newlineBefore(file: string, offset: number): boolean {
  return offset > 0 && read(file, offset - 1, offset)[0] === 0x0a
}

/** How many lines a log holds: one per newline, and a last one without. */
export async function lineCount(file: string, size?: number): Promise<number> {
  const length = size ?? statSync(file, { throwIfNoEntry: false })?.size ?? 0
  if (length === 0) return 0
  const line = await lineNumber(file, length)
  return newlineBefore(file, length) ? line - 1 : line
}

/**
 * Where line `n` of a log starts: from the index's last mark before it,
 * reading on to the newline that ends line `n - 1`. Past the end, the end.
 */
export async function lineStart(file: string, n: number): Promise<number> {
  if (n <= 1) return 0
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
  await lineNumber(file, size)
  const marks = lineIndex(file).marks
  // A mark is the line its byte falls on, so line n starts after the last mark below n.
  let k = Math.min(marks.length - 1, Math.floor(size / MARK))
  while (k > 0 && marks[k]! >= n) k--
  let at = k * MARK
  let line = marks[k]!
  while (at < size) {
    const chunk = read(file, at, Math.min(size, at + MARK))
    for (let i = chunk.indexOf(0x0a); i >= 0; i = chunk.indexOf(0x0a, i + 1)) {
      line++
      if (line === n) return at + i + 1
    }
    at += chunk.length
  }
  return size
}

/**
 * Lines `first` to `first + count - 1` of a log, within bytes `[from, to)`
 * (a step's part of its stage's log): no more than MAX_PAGE_BYTES of them.
 */
export async function fileLines(
  file: string,
  first: number,
  count: number,
  bounds: { from?: number; to?: number } = {},
): Promise<FileLines> {
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
  const floor = bounds.from ?? 0
  const ceiling = Math.min(bounds.to ?? size, size)
  const start = Math.min(Math.max(await lineStart(file, first), floor), ceiling)
  const end = Math.min(
    await lineStart(file, first + Math.min(count, MAX_PAGE_LINES)),
    ceiling,
    start + MAX_PAGE_BYTES,
  )
  return { first, text: read(file, start, end).toString('utf8'), end }
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
  /** Where the shown log has been read to with no line end after `offset`. */
  scanned: number
  /** Whether it sends the log at all. */
  logs: boolean
  /** False while the line `offset` falls on is still being counted. */
  ready: boolean
  /** Counts each move of `offset`, so a late count of an earlier one is ignored. */
  seek: number
  /** Whether its log is being sent, a turn at a time, and whether more arrived meanwhile. */
  pumping: boolean
  again: boolean
  /** The run has finished: `end` goes once the log has. */
  ending: boolean
  /** Stops waiting for a line count under way. */
  cancel?: () => void
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
  /** Messages it may still send now, refilled each second. */
  private allowance = MESSAGE_BURST
  private counted: number

  constructor(
    private readonly source: LiveSource,
    private readonly viewer: () => Actor | undefined,
    private readonly out: LiveOutput,
    private readonly now: () => number = Date.now,
  ) {
    this.counted = now()
    // Registered before any snapshot is read: nothing written after it is missed.
    this.stop = source.subscribe((events) => this.hear(events))
  }

  receive(text: string): void {
    if (this.ended) return
    const now = this.now()
    this.allowance = Math.min(
      MESSAGE_BURST,
      this.allowance + ((now - this.counted) / 1000) * MESSAGES_PER_SECOND,
    )
    this.counted = now
    if (this.allowance < 1) {
      this.send({
        event: 'error',
        data: { error: 'Too many messages: send fewer' },
      })
      return
    }
    this.allowance--
    let message: LiveMessage
    try {
      message = parseMessage(text)
    } catch (error) {
      this.send({ event: 'error', data: { error: (error as Error).message } })
      return
    }
    if ('unsubscribe' in message) {
      this.forget(message.unsubscribe)
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
        this.forget(key)
        this.send({ key, event: 'gone' })
        return
      }
      allow(actor, 'runs.read', { project: run.project, branch: run.branch })
      const watch = this.watch(message.subscribe, message.run!)
      this.watches.set(key, watch)
      if (message.subscribe === 'run') {
        watch.follow = message.stage == null || message.follow === true
        watch.shown = message.stage
        watch.logs = message.log !== false
        if (message.stage != null && watch.logs) {
          const file = this.source.logFile(watch.run, message.stage)
          if (message.tail === true) this.seek(key, watch, tailStart(file))
          else if (message.after != null) {
            const size =
              statSync(file, { throwIfNoEntry: false })?.size ?? message.after
            this.seek(key, watch, Math.min(message.after, size))
          }
        }
      }
      this.refresh(key, watch, run)
    } catch (error) {
      this.forget(key)
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
    for (const key of [...this.watches.keys()]) this.forget(key)
  }

  /** Ends one subscription, and any line count it waits for. */
  private forget(key: string): void {
    this.watches.get(key)?.cancel?.()
    this.watches.delete(key)
  }

  private watch(kind: Watch['kind'], run: string): Watch {
    return {
      kind,
      run,
      follow: false,
      shown: undefined,
      offset: 0,
      scanned: 0,
      logs: true,
      ready: true,
      seek: 0,
      pumping: false,
      again: false,
      ending: false,
      line: 1,
      settled: false,
      sent: new Map(),
    }
  }

  /** Moves a watch's log to `offset`, its line counted at once or over the next turns. */
  private seek(key: string, watch: Watch, offset: number): void {
    const seek = ++watch.seek
    watch.offset = offset
    watch.scanned = offset
    const file = this.source.logFile(watch.run, watch.shown!)
    watch.cancel?.()
    watch.cancel = undefined
    const line = offset === 0 ? 1 : lineAt(file, offset)
    if (typeof line === 'number') {
      watch.line = line
      watch.ready = true
      return
    }
    watch.ready = false
    watch.cancel = line.cancel
    void line.line.then(
      (counted) => {
        if (watch.seek !== seek || this.watches.get(key) !== watch) return
        watch.line = counted
        watch.ready = true
        this.pump(key, watch)
      },
      (error: unknown) => this.fail(key, error),
    )
  }

  private send(frame: LiveFrame): void {
    if (!this.ended) this.out.send(JSON.stringify(frame))
  }

  /** Ends one subscription with the error that stopped it. */
  private fail(key: string, error: unknown): void {
    this.forget(key)
    this.send({
      key,
      event: 'error',
      data: { error: (error as Error).message },
    })
  }

  /** Sends an event unless its data is what was sent last. */
  private changed(
    key: string,
    watch: Watch,
    event: LiveEvent,
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
        this.fail(key, error)
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
      this.forget(key)
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
          watch.sent.delete('steps')
          // A page switching to a stage starts at its log's end, as it opens.
          if (next != null && watch.logs)
            this.seek(
              key,
              watch,
              tailStart(this.source.logFile(watch.run, next)),
            )
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
      // A log still being sent sends `end` once it is done.
      if (watch.pumping || !watch.ready) watch.ending = true
      else this.finish(key)
    }
  }

  private finish(key: string): void {
    this.forget(key)
    this.send({ key, event: 'end' })
  }

  /**
   * Sends the shown stage's log past what was sent: whole lines, a line
   * longer than a frame in pieces marked `partial`, and the rest once the
   * stage has settled. A megabyte goes per turn of the event loop, and none
   * while the page has a megabyte unread.
   */
  private pump(key: string, watch: Watch): void {
    if (!watch.logs || watch.shown == null || !watch.ready) return
    if (watch.pumping) {
      watch.again = true
      return
    }
    watch.pumping = true
    const turn = (): void => {
      try {
        for (let sent = 0; ; ) {
          if (this.ended || this.watches.get(key) !== watch || !watch.ready) {
            watch.pumping = false
            return
          }
          // Every subscription waits while the page has a megabyte unread.
          if ((this.out.pending?.() ?? 0) > HIGH_WATER) {
            void (this.out.drained?.() ?? Promise.resolve()).then(turn)
            return
          }
          const piece = this.piece(key, watch)
          if (piece === 0 && watch.again) {
            watch.again = false
            continue
          }
          if (piece === 0) {
            watch.pumping = false
            if (watch.ending) this.finish(key)
            return
          }
          sent += piece
          if (sent >= TURN_BYTES) {
            setImmediate(turn)
            return
          }
        }
      } catch (error) {
        watch.pumping = false
        this.fail(key, error)
      }
    }
    turn()
  }

  /** Sends the next piece of the shown log, if there is one; returns its bytes. */
  private piece(key: string, watch: Watch): number {
    const stage = watch.shown!
    const file = this.source.logFile(watch.run, stage)
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
    const available = size - watch.offset
    if (available <= 0) return 0
    // A running stage's unfinished line waits for its end, read only where it grew.
    if (!watch.settled && available < MAX_LOG_TEXT) {
      const from = Math.max(watch.offset, watch.scanned)
      if (from >= size || !read(file, from, size).includes(0x0a)) {
        watch.scanned = size
        return 0
      }
    }
    const length = Math.min(available, MAX_LOG_TEXT)
    const chunk = read(file, watch.offset, watch.offset + length)
    let end: number
    let partial = false
    if (watch.settled && length === available) end = length
    else {
      end = chunk.lastIndexOf(0x0a) + 1
      if (end === 0) {
        // A line longer than a frame goes in pieces the page joins.
        end = characterEnd(chunk, length)
        partial = true
      }
    }
    const piece = chunk.subarray(0, end)
    watch.offset += end
    watch.scanned = watch.offset
    this.send({
      key,
      event: 'log',
      data: {
        stage,
        offset: watch.offset,
        first: watch.line,
        text: piece.toString('utf8'),
        ...(partial ? { partial: true } : {}),
      },
    })
    watch.line += newlines(piece)
    return end
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
  /** Who it is, so one viewer holds at most 16 sockets; none counts no one. */
  who?: string
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
  /** Open sockets by viewer. */
  const open = new Map<string, number>()
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
    if (
      accepted.who != null &&
      (open.get(accepted.who) ?? 0) >= MAX_SOCKETS_PER_VIEWER
    ) {
      refuse(socket, 429)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const entry = { missed: 0, viewer: accepted }
      sockets.set(ws, entry)
      const who = accepted.who
      if (who != null) open.set(who, (open.get(who) ?? 0) + 1)
      const backlog = new Backlog()
      const connection = accepted.open({
        send: (text) => {
          if (ws.readyState !== ws.OPEN) return
          if (backlog.pending > MAX_BUFFERED) {
            ws.terminate()
            return
          }
          const bytes = Buffer.byteLength(text)
          backlog.add(bytes)
          ws.send(text, () => backlog.written(bytes))
        },
        close: (code) => ws.close(code),
        pending: () => backlog.pending,
        drained: async () => await backlog.drained(),
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
        if (who != null) {
          const left = (open.get(who) ?? 1) - 1
          if (left > 0) open.set(who, left)
          else open.delete(who)
        }
        backlog.wake()
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

/** The token of an `Authorization: Bearer` header. */
const bearer = (header: string): string | undefined =>
  /^Bearer (\S+)$/.exec(header)?.[1]

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
      const token = bearer(header)
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
      who: viewer()!.label,
    }
  }
}

/** Whom a host's live stream serves: one of its sessions, or a script's key. */
export interface LiveStreamParams {
  /** A host session's account and the permission version it was made under. */
  account?: { id: number; permissionVersion: number }
  /** A script's `Authorization` header, which the master authenticates. */
  authorization?: string
}

export function asLiveStreamParams(value: unknown): LiveStreamParams {
  const input = (value ?? {}) as Record<string, unknown>
  const account = input.account as
    | { id?: unknown; permissionVersion?: unknown }
    | undefined
  const authorization = input.authorization
  if (
    (account == null) === (authorization == null) ||
    (account != null &&
      (!Number.isSafeInteger(account.id) ||
        !Number.isSafeInteger(account.permissionVersion))) ||
    (authorization != null &&
      (typeof authorization !== 'string' || authorization.length > 512))
  )
    throw new Error('Name one account or one key')
  return account != null
    ? {
        account: {
          id: Number(account.id),
          permissionVersion: Number(account.permissionVersion),
        },
      }
    : { authorization: String(authorization) }
}

/** Calls `line` with each line a stream carries; a line over `max` bytes aborts it. */
export function streamLines(
  stream: Stream,
  line: (text: string) => void,
  max: number,
): void {
  let partial = Buffer.alloc(0)
  stream.on('data', (chunk: Buffer) => {
    partial = Buffer.concat([partial, chunk])
    for (
      let end = partial.indexOf(0x0a);
      end >= 0;
      end = partial.indexOf(0x0a)
    ) {
      const text = partial.subarray(0, end).toString('utf8')
      partial = partial.subarray(end + 1)
      line(text)
    }
    if (partial.length > max) {
      partial = Buffer.alloc(0)
      stream.abort('A line is too long')
    }
  })
}

/** A frame that closes a relayed connection with a WebSocket close code. */
export const closeFrame = (code: number): string =>
  JSON.stringify({ close: code })

/**
 * A live connection's output over a link stream: one frame per line, in
 * order, waiting on the stream's credit; a close is a close frame and the
 * stream's end. A page that leaves more than 16 MB unread is dropped.
 */
export function streamOutput(stream: Stream): LiveOutput {
  let chain = Promise.resolve()
  const backlog = new Backlog()
  let closed = false
  stream.once('abort', () => backlog.wake())
  const write = (text: string): void => {
    const bytes = Buffer.from(text + '\n')
    if (backlog.pending + bytes.length > MAX_BUFFERED) {
      closed = true
      backlog.wake()
      stream.abort('The page stopped reading')
      return
    }
    backlog.add(bytes.length)
    chain = chain
      .then(async () => await stream.write(bytes))
      .then(
        () => backlog.written(bytes.length),
        () => backlog.wake(),
      )
  }
  return {
    send: (text): void => {
      if (!closed) write(text)
    },
    close: (code): void => {
      if (closed) return
      write(closeFrame(code))
      closed = true
      chain = chain.then(() => stream.end())
    },
    pending: () => backlog.pending,
    drained: async () => await backlog.drained(),
  }
}

/**
 * Serves one live connection over a link stream: the far end relays a
 * page's messages as lines, and the frames go back the same way. A viewer
 * who may no longer watch is closed with 1008.
 */
export function serveLiveStream(
  source: LiveSource,
  viewer: () => Actor | undefined,
  stream: Stream,
  options: { checkMs?: number } = {},
): void {
  const out = streamOutput(stream)
  if (viewer() == null) {
    out.close(1008)
    return
  }
  const session = new LiveSession(source, viewer, out)
  const timer = setInterval(() => {
    if (viewer() == null) out.close(1008)
  }, options.checkMs ?? PING_MS)
  timer.unref()
  const end = (): void => {
    clearInterval(timer)
    session.end()
  }
  streamLines(stream, (text) => session.receive(text), MAX_MESSAGE)
  stream.once('end', () => {
    end()
    stream.end()
  })
  stream.once('abort', end)
}

/**
 * One of a host's pages, over the host's link (`live`). The master trusts
 * the account a host names only on that host's link, and checks every
 * subscription against it as it would its own session's; a script's key
 * is authenticated here.
 */
export function masterLiveStream(
  master: Master,
  value: unknown,
  stream: Stream,
): void {
  let params: LiveStreamParams
  try {
    params = asLiveStreamParams(value)
  } catch (error) {
    stream.abort((error as Error).message)
    return
  }
  const account = params.account
  const token =
    params.authorization == null ? undefined : bearer(params.authorization)
  serveLiveStream(
    masterLiveSource(master),
    account != null
      ? (): Actor | undefined =>
          hostSessionActor(master.database, {
            accountId: account.id,
            permissionVersion: account.permissionVersion,
          })
      : token == null
        ? (): undefined => undefined
        : keyViewer(master, token),
    stream,
  )
}
