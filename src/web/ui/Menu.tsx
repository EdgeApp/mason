import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router'
import { NARROW, useMedia } from '../hooks/useMedia.js'
import { cx } from './cx.js'
import { Dialog } from './Dialog.js'
import { Icon } from './Icon.js'
import type { IconName } from './icons.js'
import { useDismiss } from './useDismiss.js'

/** One entry of a menu. */
export type MenuEntry =
  | {
      kind: 'item'
      label: string
      icon?: IconName
      /** What it does; or `to`, where it goes. */
      run?: () => void
      to?: string
      danger?: boolean
      /** One of a set of choices: a radio item, checked when chosen. */
      checked?: boolean
    }
  | { kind: 'separator' }
  | { kind: 'label'; content: ReactNode }

export interface MenuProps {
  /** Names the menu ("Account"). */
  label: string
  entries: MenuEntry[]
  /** The trigger's content (an avatar, a ⋮ glyph) and its accessible name. */
  trigger: ReactNode
  triggerLabel: string
  triggerClassName?: string
}

/** How long typed letters accumulate into one jump. */
export const TYPEAHEAD_MS = 500

/**
 * A menu of actions on one thing, opened from a button: arrow keys move,
 * Home and End jump, typing jumps to a matching item, Esc closes and returns
 * focus to the button. On narrow it is an action sheet.
 */
export function Menu({
  label,
  entries,
  trigger,
  triggerLabel,
  triggerClassName,
}: MenuProps): JSX.Element {
  const narrow = useMedia(NARROW)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const id = useId()
  const area = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open && !narrow, area, close)

  const items = (): HTMLElement[] => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ??
      []),
  ]
  useEffect(() => {
    if (open && !narrow) items()[0]?.focus()
  }, [open, narrow])

  const choose = (entry: Extract<MenuEntry, { kind: 'item' }>): void => {
    setOpen(false)
    if (!narrow) button.current?.focus()
    if (entry.to != null) void navigate(entry.to)
    entry.run?.()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLElement)
    const move = (to: number): void => {
      event.preventDefault()
      list[(to + list.length) % list.length]?.focus()
    }
    if (event.key === 'ArrowDown') move(at + 1)
    else if (event.key === 'ArrowUp') move(at - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(list.length - 1)
    else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      button.current?.focus()
    } else if (event.key === 'Tab') setOpen(false)
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const now = Date.now()
      const text =
        (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : '') +
        event.key.toLowerCase()
      typed.current = { text, at: now }
      const order = [...list.slice(at + 1), ...list.slice(0, at + 1)]
      const match = order.find((item) =>
        (item.textContent ?? '').trim().toLowerCase().startsWith(text),
      )
      if (match != null) {
        event.preventDefault()
        match.focus()
      }
    }
  }

  const desktop = (
    <div
      className="m-menu"
      role="menu"
      id={id}
      aria-label={label}
      ref={menu}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, n) =>
        entry.kind === 'separator' ? (
          <div key={n} className="m-menu__sep" role="separator" />
        ) : entry.kind === 'label' ? (
          <div key={n} className="m-menu__label">
            {entry.content}
          </div>
        ) : (
          <button
            key={n}
            type="button"
            className={cx(
              'm-menu__item',
              entry.danger === true && 'm-menu__item--danger',
            )}
            role={entry.checked == null ? 'menuitem' : 'menuitemradio'}
            aria-checked={entry.checked}
            tabIndex={-1}
            onClick={() => choose(entry)}
          >
            {entry.icon != null && <Icon name={entry.icon} />}
            <span style={{ flex: 1 }}>{entry.label}</span>
            {entry.checked === true && <Icon name="check" />}
          </button>
        ),
      )}
    </div>
  )

  const sheet = (
    <Dialog open={open} onClose={close} label={label}>
      <div className="m-actionsheet">
        <div className="m-actionsheet__group">
          {entries.map((entry, n) =>
            entry.kind === 'separator' ? null : entry.kind === 'label' ? (
              <div key={n} className="m-actionsheet__title">
                {entry.content}
              </div>
            ) : (
              <button
                key={n}
                type="button"
                className={
                  entry.danger === true ? 'm-actionsheet__danger' : undefined
                }
                aria-pressed={entry.checked}
                onClick={() => choose(entry)}
              >
                {entry.label}
                {entry.checked === true && <Icon name="check" />}
              </button>
            ),
          )}
        </div>
        <div className="m-actionsheet__group">
          <button
            type="button"
            className="m-actionsheet__cancel"
            onClick={close}
          >
            Close
          </button>
        </div>
      </div>
    </Dialog>
  )

  return (
    <span className="m-anchor" ref={area}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup={narrow ? 'dialog' : 'menu'}
        aria-expanded={open}
        aria-controls={open && !narrow ? id : undefined}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !narrow) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {trigger}
      </button>
      {open && !narrow && desktop}
      {narrow && sheet}
    </span>
  )
}
