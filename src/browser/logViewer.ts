// A run log drawn a window at a time: the box scrolls through every line of
// the log, while only the lines in view (and a margin) are in the page. The
// rest are asked for by number as they come into view, a chunk at a time,
// and those far from view are let go. Live lines extend the log at its end.
import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
} from '@tanstack/virtual-core'
import { logLines } from '../view/log.js'

/** Each line's height without wrapping, as the stylesheet draws it. */
export const LINE_HEIGHT = 18
/** The lines one request asks for. */
export const CHUNK = 500
/** The lines kept in memory before those far from view are let go. */
export const KEEP_LINES = 20_000
/** The box's padding above its first line, as the stylesheet draws it. */
const PADDING = 12

/** A page's lines of a log, as the logs API answers `?from=` and `?last=1`. */
export interface LinesAnswer {
  /** The number of the log's first line (a step's start mid-stage). */
  start: number
  total: number
  first: number
  text: string
}

/** Asks for `CHUNK` lines from number `from`, or the last `CHUNK` with `'last'`. */
export type FetchLines = (from: number | 'last') => Promise<LinesAnswer>

/** What a log box starts with: the lines the server drew, if any. */
export interface LogStart {
  start: number
  total: number
  /** The drawn lines' HTML, numbered from `first`. */
  lines: string[]
  first: number
}

/**
 * The log in a box: `pre` scrolls, and `code` holds a block the height of
 * every line with only the lines in view drawn inside it.
 */
export class LogViewer {
  private start: number
  private total: number
  private readonly lines = new Map<number, string>()
  /** Chunks asked for and not yet answered, by their first line. */
  private readonly asking = new Set<number>()
  private readonly rows: HTMLElement
  private readonly virtualizer: Virtualizer<HTMLElement, HTMLElement>
  private wrapped = false
  private cleanup: () => void

  constructor(
    private readonly pre: HTMLElement,
    private readonly code: HTMLElement,
    private readonly fetchLines: FetchLines | undefined,
    begin: LogStart,
    /** Called once lines are drawn: the box's height or contents changed. */
    private readonly drawn: () => void = (): void => undefined,
  ) {
    this.start = begin.start
    this.total = begin.total
    this.keep(begin.lines, begin.first)
    const doc = pre.ownerDocument
    code.innerHTML = ''
    code.classList.add('virtual')
    this.rows = doc.createElement('div')
    this.rows.className = 'rows'
    code.append(this.rows)
    this.virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
      count: this.total,
      getScrollElement: (): HTMLElement => this.pre,
      estimateSize: (): number => LINE_HEIGHT,
      overscan: 60,
      scrollMargin: PADDING,
      scrollToFn: elementScroll,
      observeElementRect,
      observeElementOffset,
      indexAttribute: 'data-index',
      measureElement: (element): number =>
        this.wrapped ? element.getBoundingClientRect().height : LINE_HEIGHT,
      onChange: (): void => this.draw(),
    })
    this.cleanup = this.virtualizer._didMount()
    this.virtualizer._willUpdate()
    this.draw()
  }

  /** The number of the log's last line, or one before its first when it is empty. */
  get end(): number {
    return this.start + this.total - 1
  }

  /** Lines that arrived live, numbered from `first`: the log grows to hold them. */
  append(html: string[], first: number): void {
    this.keep(html, first)
    const last = first + html.length - 1
    if (last > this.end) this.resize(last - this.start + 1)
    else this.draw()
  }

  /** Lines wrap, each as tall as its text, or each keeps one line's height. */
  wrap(on: boolean): void {
    this.wrapped = on
    this.virtualizer.measure()
    this.draw()
  }

  /** Lets go of the box's observers. */
  destroy(): void {
    this.cleanup()
  }

  /**
   * Fetches the log's end or start when the server drew none of it (the
   * host's page). With `'last'`, the end, as a live log opens there.
   */
  async open(from: number | 'last'): Promise<void> {
    if (this.fetchLines == null) return
    await this.load(from)
  }

  private keep(html: string[], first: number): void {
    html.forEach((line, index) => this.lines.set(first + index, line))
  }

  private resize(total: number): void {
    this.total = total
    this.virtualizer.setOptions({ ...this.virtualizer.options, count: total })
    this.virtualizer._willUpdate()
    this.draw()
  }

  private async load(from: number | 'last'): Promise<void> {
    const key = from === 'last' ? -1 : from
    if (this.fetchLines == null || this.asking.has(key)) return
    this.asking.add(key)
    try {
      const answer = await this.fetchLines(from)
      this.keep(logLines(answer.text, answer.first), answer.first)
      if (answer.start !== this.start || answer.total > this.total) {
        this.start = answer.start
        this.resize(Math.max(answer.total, this.total))
      } else this.draw()
    } catch {
      // Asked again when the lines come back into view.
    } finally {
      this.asking.delete(key)
    }
  }

  /** Draws the lines in view, asking for those it does not hold. */
  private draw(): void {
    const items = this.virtualizer.getVirtualItems()
    this.code.style.height = `${this.virtualizer.getTotalSize()}px`
    const top = items[0]?.start ?? PADDING
    this.rows.style.transform = `translateY(${top - PADDING}px)`
    this.rows.innerHTML = items
      .map((item) => {
        const number = this.start + item.index
        const line = this.lines.get(number)
        return line == null
          ? `<span class="line pending" data-line="${number}" data-index="${item.index}"></span>`
          : line.replace(
              '<span class="line"',
              `<span class="line" data-index="${item.index}"`,
            )
      })
      .join('')
    if (this.wrapped)
      for (const row of this.rows.children)
        this.virtualizer.measureElement(row as HTMLElement)
    for (const item of items) {
      const number = this.start + item.index
      if (!this.lines.has(number))
        void this.load(this.start + Math.floor(item.index / CHUNK) * CHUNK)
    }
    this.forget(items[0]?.index ?? 0)
    this.drawn()
  }

  /** Lets go of the lines furthest from view once more than KEEP_LINES are held. */
  private forget(around: number): void {
    if (this.lines.size <= KEEP_LINES) return
    const center = this.start + around
    const far = [...this.lines.keys()].sort(
      (a, b) => Math.abs(b - center) - Math.abs(a - center),
    )
    for (const number of far.slice(0, this.lines.size - KEEP_LINES))
      this.lines.delete(number)
  }
}
