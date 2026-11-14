// The log viewer (DESIGN-LANGUAGE.md §10, screen-04-run): an always-dark
// terminal that scrolls through every line of a log while only the lines in
// view (and a margin) are in the page, drawn by TanStack's virtualizer from a
// LogStore. A log that opens at its end follows the lines that arrive while
// the viewer stays within 80 px of the bottom; any move up stops it, and a
// round button goes back to the end. Wrap, and Raw and Plain text downloads,
// sit in its bar.
import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
} from '@tanstack/virtual-core'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react'
import type { AnsiPiece } from '../../shared/ansi.js'
import { cx } from './cx.js'
import { Icon } from './Icon.js'
import type { LogOpen, LogStore } from './logStore.js'

/** How near the bottom a viewer must be for the log to keep following. */
export const FOLLOW_PX = 80
/** A line's height at the default text size, as the stylesheet draws it (13/20 mono). */
export const LINE_PX = 20
/** The body's padding above its first line and below its last. */
const PADDING = 8

export interface LogViewerProps {
  store: LogStore
  /** The bar's title: which log, and which lines. */
  title: ReactNode
  /** The region's name: "Log of build-ios". */
  label: string
  /** Where it opens: a live log at its end, a finished one at its start. */
  openAt: LogOpen
  /** The whole log, to save: as written, and without escape sequences. */
  downloads?: { raw: string; plain: string }
  /** Shown in place of the lines: why there are none to show. */
  unavailable?: ReactNode
  /** What a failed first read means here; the node's message otherwise. */
  describeFailure?: (failure: { status: number; message: string }) => ReactNode
  /** Fills its container (the full-screen sheet) rather than 60 % of the window. */
  tall?: boolean
}

/** The class names of a piece's style. */
const pieceClass = (piece: AnsiPiece): string | undefined =>
  cx(
    piece.style.colour != null &&
      piece.style.colour !== 'white' &&
      `a-${piece.style.colour}`,
    piece.style.bold && 'a-bold',
    piece.style.underline && 'a-underline',
  ) || undefined

/** One line's text, its colours as classes. */
function LineText({ pieces }: { pieces: AnsiPiece[] }): JSX.Element {
  return (
    <span className="m-log__t">
      {pieces.map((piece, index) => {
        const name = pieceClass(piece)
        return name == null ? (
          piece.text
        ) : (
          <span key={index} className={name}>
            {piece.text}
          </span>
        )
      })}
    </span>
  )
}

/** The line height the stylesheet gives the body, in pixels. */
function lineHeight(element: HTMLElement | null): number {
  if (element == null) return LINE_PX
  const value = parseFloat(getComputedStyle(element).lineHeight)
  return Number.isFinite(value) && value > 0 ? value : LINE_PX
}

/** A windowed, following log. */
export function LogViewer({
  store,
  title,
  label,
  openAt,
  downloads,
  unavailable,
  describeFailure,
  tall = false,
}: LogViewerProps): JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useSyncExternalStore(store.subscribe, () => store.version)
  const [wrapped, setWrapped] = useState(false)
  const wrap = useRef(wrapped)
  wrap.current = wrapped
  const height = useRef(LINE_PX)
  /** Whether the log follows the lines that arrive. */
  const following = useRef(openAt === 'end')
  const [atEnd, setAtEnd] = useState(true)
  /** Where it was scrolled to last, so a move up is told from new lines below. */
  const lastTop = useRef(0)

  const [virtualizer] = useState(
    () =>
      new Virtualizer<HTMLDivElement, HTMLDivElement>({
        count: 0,
        getScrollElement: (): HTMLDivElement | null => body.current,
        estimateSize: (): number => height.current,
        overscan: 40,
        paddingStart: PADDING,
        paddingEnd: PADDING,
        scrollToFn: elementScroll,
        observeElementRect,
        observeElementOffset,
        indexAttribute: 'data-index',
        measureElement: (element): number =>
          wrap.current
            ? element.getBoundingClientRect().height
            : height.current,
        onChange: (): void => redraw(),
      }),
  )
  virtualizer.setOptions({ ...virtualizer.options, count: store.total })

  useLayoutEffect(() => {
    height.current = lineHeight(body.current)
    const cleanup = virtualizer._didMount()
    return cleanup
  }, [virtualizer])
  useLayoutEffect(() => {
    virtualizer._willUpdate()
  })

  /** Scrolls to the log's last line. */
  const toEnd = useCallback((): void => {
    const element = body.current
    if (element == null) return
    element.scrollTop = element.scrollHeight
    lastTop.current = element.scrollTop
  }, [])

  // A new log (another stage, a step) opens where it should.
  useLayoutEffect(() => {
    following.current = openAt === 'end'
    const element = body.current
    if (element != null && openAt === 'start') {
      element.scrollTop = 0
      lastTop.current = 0
    }
  }, [store, openAt])

  // New lines: a log that follows stays at its end; one scrolled up shows
  // the button, unless all of it is in view.
  useLayoutEffect(() => {
    const element = body.current
    if (element != null && store.loaded && store.total > 0) {
      if (following.current) toEnd()
      else if (
        element.scrollHeight - element.scrollTop - element.clientHeight <=
        1
      )
        following.current = true
    }
    setAtEnd(following.current)
  }, [store, store.loaded, store.total, store.version, toEnd])

  const onScroll = (): void => {
    const element = body.current
    if (element == null) return
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight
    // At the very bottom it follows, though a taller panel moved it up; any
    // other move up stops it, so lines arriving mid-scroll never pull the
    // viewer back down; back within 80 px of the bottom, it follows again.
    if (distance > 1 && element.scrollTop < lastTop.current)
      following.current = false
    else if (distance < FOLLOW_PX) following.current = true
    lastTop.current = element.scrollTop
    setAtEnd(following.current)
  }

  const items = virtualizer.getVirtualItems()
  const firstLine = items.length === 0 ? 0 : store.start + items[0]!.index
  const lastLine =
    items.length === 0 ? -1 : store.start + items[items.length - 1]!.index
  // The lines in view that are not held are asked for.
  useEffect(() => {
    if (lastLine >= firstLine) store.ensure(firstLine, lastLine)
  }, [store, firstLine, lastLine, store.version])

  const showing = unavailable == null && store.failure == null
  const first = items[0]?.start ?? PADDING
  return (
    <div
      className={cx('m-log', wrapped && 'm-log--wrap', tall && 'm-log--tall')}
      role="region"
      aria-label={label}
    >
      <div className="m-log__bar">
        <span className="m-log__title">{title}</span>
        <button
          className="m-log__tool"
          type="button"
          aria-pressed={wrapped}
          data-wrap=""
          onClick={() => {
            setWrapped(!wrapped)
            wrap.current = !wrapped
            virtualizer.measure()
          }}
        >
          Wrap lines
        </button>
        {downloads != null && (
          <>
            <a className="m-log__tool" href={downloads.raw} download>
              <Icon name="download" size="sm" />
              Raw
            </a>
            <a className="m-log__tool" href={downloads.plain} download>
              <Icon name="description" size="sm" />
              Plain text
            </a>
          </>
        )}
      </div>
      <div className="m-log__frame">
        <div
          className="m-log__body"
          ref={body}
          onScroll={onScroll}
          tabIndex={0}
          aria-label={`${label}: lines`}
        >
          {unavailable != null ? (
            <div className="m-log__gap">{unavailable}</div>
          ) : store.failure != null ? (
            <div className="m-log__gap">
              {describeFailure?.(store.failure) ?? store.failure.message}
              {store.failure.status !== 404 && (
                <button
                  className="m-log__tool"
                  type="button"
                  onClick={() => void store.retry(openAt)}
                >
                  <Icon name="refresh" size="sm" />
                  Retry
                </button>
              )}
            </div>
          ) : !store.loaded ? (
            <div className="m-log__gap">Loading the log…</div>
          ) : store.total === 0 ? (
            <div className="m-log__gap">No lines yet.</div>
          ) : (
            <div
              className="m-log__rows"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              <div
                className="m-log__window"
                style={{ transform: `translateY(${first}px)` }}
              >
                {items.map((item) => {
                  const number = store.start + item.index
                  const pieces = store.line(number)
                  return (
                    <div
                      key={item.key}
                      className="m-log__line"
                      data-index={item.index}
                      data-line={number}
                      ref={wrapped ? virtualizer.measureElement : undefined}
                    >
                      <span className="m-log__n" aria-hidden="true">
                        {number}
                      </span>
                      {pieces == null ? (
                        <span className="m-log__t m-log__pending">…</span>
                      ) : (
                        <LineText pieces={pieces} />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        <button
          className="m-log__end"
          type="button"
          aria-label="Go to the end of the log"
          title="Go to the end of the log"
          hidden={atEnd || !showing || store.total === 0}
          onClick={() => {
            following.current = true
            virtualizer.scrollToIndex(Math.max(0, store.total - 1), {
              align: 'end',
            })
            toEnd()
            setAtEnd(true)
          }}
        >
          <Icon name="expand_more" />
        </button>
      </div>
    </div>
  )
}
