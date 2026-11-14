import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router'
import {
  asSearchResults,
  SEARCH_PATH,
  type SearchResult,
} from '../../shared/api/index.js'
import { useApi } from '../api/context.js'
import { ApiError } from '../api/client.js'
import { Button } from '../ui/Button.js'
import { cx } from '../ui/cx.js'
import { Dialog } from '../ui/Dialog.js'
import { Icon } from '../ui/Icon.js'
import type { IconName } from '../ui/icons.js'
import { Kbd } from '../ui/Kbd.js'
import { Spinner } from '../ui/Spinner.js'

/** How long typing rests before the palette searches. */
export const SEARCH_DEBOUNCE_MS = 150

/** The five kinds, in the order the palette groups them, with their glyph and heading. */
export const KINDS: ReadonlyArray<{
  kind: SearchResult['kind']
  heading: string
  icon: IconName
}> = [
  { kind: 'run', heading: 'Runs', icon: 'history' },
  { kind: 'commit', heading: 'Commits', icon: 'commit' },
  { kind: 'branch', heading: 'Branches', icon: 'fork_right' },
  { kind: 'project', heading: 'Projects', icon: 'folder' },
  { kind: 'app', heading: 'App IDs', icon: 'mobile' },
]

/** The empty palette's words (DESIGN-LANGUAGE.md §14.1). */
export const EMPTY_TEXT =
  'Type to search projects, app IDs, runs, commits and branches.'
/** What the palette says when nothing matches. */
export const noMatchText = (query: string): string =>
  `No projects, app IDs, runs, commits or branches match "${query}".`

/** Whether a key press belongs to an input method composing text, not to the palette. */
export const composing = (event: KeyboardEvent): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

/** The label with the query's first match marked. */
export function highlight(label: string, query: string): ReactNode {
  const q = query.trim().replace(/^#/, '')
  const at = q === '' ? -1 : label.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return label
  return (
    <>
      {label.slice(0, at)}
      <mark>{label.slice(at, at + q.length)}</mark>
      {label.slice(at + q.length)}
    </>
  )
}

type Answer =
  | { state: 'idle' }
  | { state: 'loading'; query: string }
  | { state: 'done'; query: string; results: SearchResult[] }
  | { state: 'failed'; query: string; error: string }

/**
 * ⌘K: one field searching projects, app IDs, runs, commits and branches
 * (`GET /api/v2/search`), results grouped by kind. ↑ and ↓ move, Enter opens,
 * Esc closes; keys an input method is composing with are left alone.
 */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const client = useApi()
  const navigate = useNavigate()
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState<Answer>({ state: 'idle' })
  const [selected, setSelected] = useState(0)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setAnswer({ state: 'idle' })
      setSelected(0)
    }
  }, [open])

  useEffect(() => {
    const q = query.trim()
    if (!open || q === '') {
      setAnswer({ state: 'idle' })
      return undefined
    }
    const abort = new AbortController()
    const timer = setTimeout(() => {
      setAnswer({ state: 'loading', query: q })
      client
        .get(`${SEARCH_PATH}?q=${encodeURIComponent(q)}`, asSearchResults, {
          signal: abort.signal,
        })
        .then(
          (results) => {
            setAnswer({ state: 'done', query: q, results })
            setSelected(0)
          },
          (error: unknown) => {
            if (abort.signal.aborted) return
            setAnswer({
              state: 'failed',
              query: q,
              error: error instanceof ApiError ? error.message : String(error),
            })
          },
        )
    }, SEARCH_DEBOUNCE_MS)
    return (): void => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [client, open, query, attempt])

  const results = answer.state === 'done' ? answer.results : []
  // In the groups' order, so ↑ and ↓ follow what the viewer sees.
  const ordered = useMemo(
    () =>
      KINDS.flatMap(({ kind }) =>
        results.filter((result) => result.kind === kind),
      ),
    [results],
  )
  const optionId = (n: number): string => `${listId}-${n}`

  const go = (result: SearchResult): void => {
    onClose()
    void navigate(result.href)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (composing(event)) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (ordered.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setSelected((at) => (at + step + ordered.length) % ordered.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const result = ordered[selected]
      if (result != null) go(result)
    }
  }

  let body: ReactNode
  if (answer.state === 'idle')
    body = (
      <div className="m-empty">
        <p>
          {EMPTY_TEXT}{' '}
          <span className="m-tertiary">
            A run number (#182), a commit (4–40 hex characters) or a branch name
            all work.
          </span>
        </p>
      </div>
    )
  else if (answer.state === 'loading')
    body = (
      <div className="m-row m-palette__status">
        <Spinner size="sm" label="Searching" />
        <span className="m-secondary m-t-callout">Searching…</span>
      </div>
    )
  else if (answer.state === 'failed')
    body = (
      <div className="m-empty">
        <div
          className="m-empty__glyph"
          style={{ color: 'var(--m-danger-solid)' }}
        >
          <Icon name="error" />
        </div>
        <p>{answer.error}</p>
        <Button
          variant="secondary"
          size="sm"
          icon="refresh"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Try again
        </Button>
      </div>
    )
  else if (ordered.length === 0)
    body = (
      <div className="m-empty">
        <div className="m-empty__glyph">
          <Icon name="search" />
        </div>
        <p>{noMatchText(answer.query)}</p>
      </div>
    )
  else
    body = (
      <div
        role="listbox"
        id={listId}
        aria-label="Results"
        className="m-palette__results"
      >
        {KINDS.map(({ kind, heading, icon }) => {
          const group = ordered
            .map((result, n) => ({ result, n }))
            .filter(({ result }) => result.kind === kind)
          if (group.length === 0) return null
          return (
            <div
              key={kind}
              className="m-palette__group"
              role="group"
              aria-label={heading}
            >
              <p
                className="m-t-eyebrow"
                style={{ padding: 'var(--m-space-1) var(--m-space-3)' }}
                aria-hidden="true"
              >
                {heading}
              </p>
              {group.map(({ result, n }) => (
                <div
                  key={n}
                  id={optionId(n)}
                  className="m-palette__item"
                  role="option"
                  aria-selected={n === selected}
                  onMouseMove={() => setSelected(n)}
                  onClick={() => go(result)}
                >
                  <Icon name={icon} />
                  <span className="m-list__main">
                    <span
                      className={cx(
                        (kind === 'commit' ||
                          kind === 'branch' ||
                          kind === 'app') &&
                          'm-t-mono',
                      )}
                    >
                      {highlight(result.label, answer.query)}
                    </span>
                    <span className="m-t-subhead m-secondary">
                      {result.detail}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="Search"
      scrimClassName="m-scrim--top"
      initialFocus={input}
    >
      <div className="m-palette">
        <div className="m-palette__input">
          <Icon name="search" />
          <input
            ref={input}
            type="text"
            enterKeyHint="go"
            role="combobox"
            aria-label="Search projects, app IDs, runs, commits and branches"
            aria-expanded={ordered.length > 0}
            aria-controls={ordered.length > 0 ? listId : undefined}
            aria-activedescendant={
              ordered.length > 0 ? optionId(selected) : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <Kbd>esc</Kbd>
        </div>
        <div aria-live="polite" className="m-sr">
          {answer.state === 'done'
            ? ordered.length === 0
              ? noMatchText(answer.query)
              : `${ordered.length} ${ordered.length === 1 ? 'result' : 'results'}`
            : ''}
        </div>
        {body}
        <div className="m-palette__foot" aria-hidden="true">
          <span>
            <Kbd>↑↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </Dialog>
  )
}
