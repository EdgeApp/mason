// A large sheet (DESIGN-LANGUAGE.md §10, §12): create or edit more than
// eight fields, or grouped settings — a node type, a sign-in method, a pool,
// a host, a person. Fields come in titled sections; rarely used groups sit
// collapsed in a disclosure. It keeps a draft in session storage, so an
// accidental reload restores it; write-only secret fields are never stored.
// Closing it with unsaved changes asks first (the Sheet's discard confirm).
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react'
import { Sheet } from './Sheet.js'

export interface LargeSheetProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** A chip beside the title: the method's kind ("OpenID Connect"). */
  badge?: ReactNode
  children: ReactNode
  footer?: ReactNode | ((close: () => void) => ReactNode)
  dirty?: boolean
  initialFocus?: RefObject<HTMLElement | null>
}

/** A Sheet at its large size, with an optional chip beside the title. */
export function LargeSheet({
  badge,
  title,
  ...props
}: LargeSheetProps): JSX.Element {
  return (
    <Sheet
      {...props}
      size="large"
      title={
        badge == null ? (
          title
        ) : (
          <>
            {title} {badge}
          </>
        )
      }
    />
  )
}

/** A titled group of fields in a sheet: a fieldset with an eyebrow legend. */
export function FormSection({
  legend,
  children,
  grid = true,
}: {
  legend: ReactNode
  children: ReactNode
  /** Lay the fields out in the section's responsive grid (default). */
  grid?: boolean
}): JSX.Element {
  return (
    <fieldset className="m-formsection">
      <legend className="m-t-eyebrow">{legend}</legend>
      {grid ? <div className="m-formsection__grid">{children}</div> : children}
    </fieldset>
  )
}

/** A rarely used group of fields, collapsed until opened. */
export function FormDisclosure({
  summary,
  note,
  children,
  open = false,
}: {
  summary: ReactNode
  /** Small words after the summary ("OAuth 2 methods only"). */
  note?: ReactNode
  children: ReactNode
  open?: boolean
}): JSX.Element {
  return (
    <details className="m-disclosure m-disclosure--boxed" open={open}>
      <summary className="m-t-headline">
        {summary}
        {note != null && <span className="m-t-subhead m-tertiary">{note}</span>}
      </summary>
      <div className="m-disclosure__body">
        <div className="m-formsection__grid">{children}</div>
      </div>
    </details>
  )
}

/** Where a sheet's draft is kept: `mason-draft:<key>`. */
export const draftKey = (key: string): string => `mason-draft:${key}`

/** Reads a stored draft; none, or one storage refuses, is undefined. */
function readDraft<T>(key: string): T | undefined {
  try {
    const text = window.sessionStorage.getItem(draftKey(key))
    return text == null ? undefined : (JSON.parse(text) as T)
  } catch {
    return undefined
  }
}

export interface Draft<T> {
  value: T
  set: (next: T | ((was: T) => T)) => void
  /** Whether the value differs from where it started. */
  dirty: boolean
  /** Whether it came back from session storage. */
  restored: boolean
  /** Forgets the stored draft and returns to `initial` (after a save, or Discard). */
  clear: () => void
}

/**
 * A sheet's fields, kept in session storage under `key` while it is open.
 * `secrets` names fields that are never stored (write-only values); they
 * start empty again after a reload. A null key keeps nothing (the sheet
 * is closed). `initial` must be stable for one opening of the sheet.
 */
export function useDraft<T extends object>(
  key: string | null,
  initial: T,
  secrets: ReadonlyArray<keyof T> = [],
): Draft<T> {
  const start = useRef(initial)
  const [state, setState] = useState<{
    key: string | null
    value: T
    restored: boolean
  }>(() => {
    const stored = key == null ? undefined : readDraft<Partial<T>>(key)
    return {
      key,
      value: stored == null ? initial : { ...initial, ...stored },
      restored: stored != null,
    }
  })
  // A new key (another sheet, or the sheet opened again) starts over.
  if (state.key !== key) {
    start.current = initial
    const stored = key == null ? undefined : readDraft<Partial<T>>(key)
    setState({
      key,
      value: stored == null ? initial : { ...initial, ...stored },
      restored: stored != null,
    })
  }
  const secretList = secrets.join('\u0000')
  useEffect(() => {
    if (key == null) return
    const kept = { ...state.value } as Record<string, unknown>
    for (const field of secretList.split('\u0000'))
      if (field !== '') delete kept[field]
    try {
      // An untouched sheet keeps no draft.
      if (JSON.stringify(state.value) === JSON.stringify(start.current))
        window.sessionStorage.removeItem(draftKey(key))
      else window.sessionStorage.setItem(draftKey(key), JSON.stringify(kept))
    } catch {
      // Storage full or refused: the draft lives only in memory.
    }
  }, [key, state.value, secretList])
  const set = useCallback((next: T | ((was: T) => T)) => {
    setState((was) => ({
      ...was,
      value:
        typeof next === 'function' ? (next as (was: T) => T)(was.value) : next,
    }))
  }, [])
  const clear = useCallback(() => {
    if (key != null)
      try {
        window.sessionStorage.removeItem(draftKey(key))
      } catch {
        // Nothing stored.
      }
    setState({ key, value: start.current, restored: false })
  }, [key])
  return {
    value: state.value,
    set,
    dirty: JSON.stringify(state.value) !== JSON.stringify(start.current),
    restored: state.restored,
    clear,
  }
}
