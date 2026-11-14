// A picker (DESIGN-LANGUAGE.md §10): choose many from a long list with a
// search field and a checkbox per entry, where each toggle saves at once.
// `usePicker` holds what the node saved and the changes on their way to it:
// each change waits for the one before, so it starts from the saved list,
// and a checkbox shows the latest change asked for until its answer lands.
// A refused change keeps its message until the picker opens again or that
// item's own change succeeds, so the page shows it under its section even
// after Done.
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react'
import { Button } from './Button.js'
import { Icon } from './Icon.js'

/** With an empty query, how many entries the picker offers. */
export const PICKER_FIRST = 3

/** One entry the picker can choose. */
export interface PickerItem<Id> {
  id: Id
  label: string
  /** A second line: an app's slug, a person's email. */
  detail?: string
  /** The second line is a machine value, in the mono face. */
  mono?: boolean
  /** Every text a query may match (the label is always one). */
  search?: string[]
  /** Offered with an empty query; `false` keeps a disabled app out of the first entries. */
  offered?: boolean
}

/**
 * The entries shown for a query, in the list's order: with an empty query
 * the first few that are offered, else each whose text contains the trimmed
 * query, ignoring case.
 */
export function pickerChoices<Id>(
  items: ReadonlyArray<PickerItem<Id>>,
  query: string,
  first = PICKER_FIRST,
): Array<PickerItem<Id>> {
  const wanted = query.trim().toLowerCase()
  if (wanted === '')
    return items.filter((item) => item.offered !== false).slice(0, first)
  return items.filter((item) =>
    [item.label, ...(item.search ?? [])].some((text) =>
      text.toLowerCase().includes(wanted),
    ),
  )
}

export interface PickerState<Id> {
  /** The picker is open. */
  open: boolean
  /** Opens it, forgetting the last refusal. */
  show: () => void
  /** Closes it (Done), keeping a refusal: that change did not happen. */
  close: () => void
  /** What a checkbox shows: the latest change asked for, else what is saved. */
  checked: (id: Id) => boolean
  /** Asks for a change; it is sent once the changes before it are answered. */
  toggle: (id: Id, checked: boolean) => void
  /** The latest refusal's message, while it stands. */
  error: string | undefined
  /** What the node holds, as its latest answer said. */
  saved: readonly Id[]
}

export interface PickerOptions<Id> {
  /** What the node holds now. */
  saved: readonly Id[]
  /** Sends the whole list; answers what the node then holds. */
  save: (ids: Id[]) => Promise<Id[]>
  /** A change was saved (for a toast). */
  onSaved?: (id: Id, checked: boolean) => void
}

/** The picker's saved list, its queue of changes and its refusal. */
export function usePicker<Id>({
  saved,
  save,
  onSaved,
}: PickerOptions<Id>): PickerState<Id> {
  const [open, setOpen] = useState(false)
  const [, setTick] = useState(0)
  const rerender = useCallback(() => setTick((n) => n + 1), [])
  const chosen = useRef<Id[]>([...saved])
  const pending = useRef(new Map<Id, { count: number; checked: boolean }>())
  const queue = useRef<Promise<void>>(Promise.resolve())
  const failed = useRef<{ id: Id; message: string } | undefined>(undefined)
  const latest = useRef({ save, onSaved })
  latest.current = { save, onSaved }
  // A new answer from elsewhere (a reload) counts while nothing is on its way.
  const key = JSON.stringify(saved)
  useEffect(() => {
    if (pending.current.size === 0) {
      chosen.current = JSON.parse(key) as Id[]
      rerender()
    }
  }, [key, rerender])
  const toggle = useCallback(
    (id: Id, checked: boolean): void => {
      const entry = pending.current.get(id) ?? { count: 0, checked }
      entry.count++
      entry.checked = checked
      pending.current.set(id, entry)
      rerender()
      queue.current = queue.current.then(async () => {
        // The saved list with this one change: ids the page does not list stay.
        const ids = chosen.current.filter((other) => other !== id)
        if (checked) ids.push(id)
        try {
          chosen.current = await latest.current.save(ids)
          // Only this item's own success answers its refusal; another's stays.
          if (failed.current?.id === id) failed.current = undefined
          latest.current.onSaved?.(id, checked)
        } catch (reason) {
          failed.current = { id, message: (reason as Error).message }
        }
        if (--entry.count === 0) pending.current.delete(id)
        rerender()
      })
    },
    [rerender],
  )
  return {
    open,
    show: (): void => {
      failed.current = undefined
      setOpen(true)
    },
    close: () => setOpen(false),
    checked: (id) =>
      pending.current.get(id)?.checked ?? chosen.current.includes(id),
    toggle,
    error: failed.current?.message,
    saved: chosen.current,
  }
}

export interface PickerProps<Id> {
  picker: PickerState<Id>
  items: ReadonlyArray<PickerItem<Id>>
  /** The search field's accessible name: "Find an app". */
  label: string
  /** Its placeholder: "App name or ID". */
  placeholder: string
  /** A checkbox's accessible name: "TeamStation in Testers". */
  choiceLabel?: (item: PickerItem<Id>) => string
  /** After Done or Escape, where focus goes back to (the Add button). */
  onDone?: () => void
}

/** The open picker: the search field with Done, then the choices. */
export function Picker<Id extends string | number>({
  picker,
  items,
  label,
  placeholder,
  choiceLabel,
  onDone,
}: PickerProps<Id>): JSX.Element | null {
  const [query, setQuery] = useState('')
  const id = useId()
  if (!picker.open) return null
  const done = (): void => {
    setQuery('')
    picker.close()
    onDone?.()
  }
  const keys = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      done()
    }
  }
  const choices = pickerChoices(items, query)
  return (
    <div className="m-picker" role="group" aria-label={label} onKeyDown={keys}>
      <div className="m-picker__search">
        <div className="m-affix m-picker__field">
          <Icon name="search" />
          <input
            className="m-input"
            type="search"
            value={query}
            aria-label={label}
            aria-controls={`${id}-choices`}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Enter in the field never submits anything around it.
              if (event.key === 'Enter') event.preventDefault()
            }}
          />
        </div>
        <Button variant="secondary" onClick={done}>
          Done
        </Button>
      </div>
      <div id={`${id}-choices`}>
        {choices.length === 0 ? (
          <p className="m-picker__empty m-t-subhead m-secondary">
            Nothing matches.
          </p>
        ) : (
          choices.map((item) => (
            <label key={String(item.id)} data-choice={String(item.id)}>
              <span>
                <span className="m-t-headline">{item.label}</span>
                {item.detail != null && (
                  <>
                    <br />
                    <span
                      className={
                        item.mono === true
                          ? 'm-t-mono-sm m-secondary'
                          : 'm-t-subhead m-secondary'
                      }
                    >
                      {item.detail}
                    </span>
                  </>
                )}
              </span>
              <span className="m-check">
                <input
                  type="checkbox"
                  checked={picker.checked(item.id)}
                  aria-label={choiceLabel?.(item)}
                  onChange={(event) =>
                    picker.toggle(item.id, event.currentTarget.checked)
                  }
                />
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  )
}
