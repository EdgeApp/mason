// A run log's lines, held a window at a time for the log viewer: lines are
// asked for by number, a chunk of 500 at once, as they come into view, those
// far from view are let go once 20,000 are held, and live lines extend the
// log at its end. The LogViewer component draws it.
import type { RunLogPage } from '../../shared/api/index.js'
import { ansiLines, type AnsiPiece } from '../../shared/ansi.js'

/** The lines one request asks for. */
export const CHUNK = 500
/** The lines kept in memory before those far from view are let go. */
export const KEEP_LINES = 20_000

/** Asks for a chunk from line `from`, or the last chunk. */
export type FetchLog = (
  page: { from: number } | { last: true },
) => Promise<RunLogPage>

/** Where a log opens: its start (a finished log, a step's lines) or its end (a live one). */
export type LogOpen = 'start' | 'end'

/** A log being drawn: its lines by number, and what is still being asked for. */
export class LogStore {
  /** The number of the log's first line (a step's lines start mid-stage). */
  start = 1
  /** The lines the log holds. */
  total = 0
  /** Whether its first chunk has arrived (or it has none to ask for). */
  loaded: boolean
  /** Why its first chunk could not be read, with the node's status. */
  failure: { status: number; message: string } | undefined
  /** Bumped on every change, for the viewer to draw again. */
  version = 0
  private readonly lines = new Map<number, AnsiPiece[]>()
  /** Chunks asked for and not yet answered, by their first line (-1: the last). */
  private readonly asking = new Set<number>()
  private readonly listeners = new Set<() => void>()
  private closed = false

  constructor(private readonly fetchLog: FetchLog | undefined) {
    this.loaded = fetchLog == null
  }

  /** The number of the log's last line, or one before its first when it is empty. */
  get end(): number {
    return this.start + this.total - 1
  }

  /** A line's pieces, if held. */
  line(number: number): AnsiPiece[] | undefined {
    return this.lines.get(number)
  }

  /** How many lines are held. */
  get held(): number {
    return this.lines.size
  }

  /** Calls `listener` on every change; returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Stops asking: the viewer moved to another log. */
  close(): void {
    this.closed = true
    this.listeners.clear()
  }

  /** Asks for its first chunk: its start, or its end. */
  async open(at: LogOpen): Promise<void> {
    await this.load(at === 'end' ? 'last' : 0, true)
  }

  /** Asks again for its first chunk after a failure. */
  async retry(at: LogOpen): Promise<void> {
    this.failure = undefined
    this.changed()
    await this.open(at)
  }

  /** Lines that arrived live, numbered from `first`: the log grows to hold them. */
  append(text: string, first: number): void {
    const lines = ansiLines(text)
    if (lines.length === 0) return
    lines.forEach((pieces, index) => this.lines.set(first + index, pieces))
    const last = first + lines.length - 1
    if (last > this.end) this.total = last - this.start + 1
    this.loaded = true
    this.changed()
  }

  /**
   * The lines from `first` to `last` are in view: asks for the chunks that
   * hold any it lacks, and lets go of the furthest once too many are held.
   */
  ensure(first: number, last: number): void {
    if (this.fetchLog == null || this.closed) return
    for (let number = first; number <= Math.min(last, this.end); number++) {
      if (this.lines.has(number)) continue
      void this.load(
        this.start + Math.floor((number - this.start) / CHUNK) * CHUNK,
      )
      number =
        this.start + (Math.floor((number - this.start) / CHUNK) + 1) * CHUNK - 1
    }
    this.forget(Math.floor((first + last) / 2))
  }

  private async load(from: number | 'last', first = false): Promise<void> {
    const key = from === 'last' ? -1 : from
    if (this.fetchLog == null || this.asking.has(key) || this.closed) return
    this.asking.add(key)
    try {
      const page = await this.fetchLog(
        from === 'last' ? { last: true } : { from },
      )
      if (this.closed) return
      ansiLines(page.text).forEach((pieces, index) =>
        this.lines.set(page.first + index, pieces),
      )
      if (page.start !== this.start || page.total > this.total) {
        this.start = page.start
        this.total = Math.max(page.total, this.total)
      }
      this.loaded = true
      this.changed()
    } catch (error) {
      if (this.closed) return
      // Lines in view are asked for again when they come back into view.
      if (first) {
        this.failure = {
          status: (error as { status?: number }).status ?? 0,
          message: (error as Error).message,
        }
        this.loaded = true
        this.changed()
      }
    } finally {
      this.asking.delete(key)
    }
  }

  /** Lets go of the lines furthest from `center` once more than KEEP_LINES are held. */
  private forget(center: number): void {
    if (this.lines.size <= KEEP_LINES) return
    const far = [...this.lines.keys()].sort(
      (a, b) => Math.abs(b - center) - Math.abs(a - center),
    )
    for (const number of far.slice(0, this.lines.size - KEEP_LINES))
      this.lines.delete(number)
  }

  private changed(): void {
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }
}
