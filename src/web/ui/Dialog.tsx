// The one overlay primitive: a <dialog> shown with showModal(), so the page
// behind it is inert. Focus moves into it when it opens (the first field, or
// its title when it has none) and back to whatever opened it when it closes;
// Tab stays inside it; Esc closes it.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { cx } from './cx.js'

/** What can take focus inside an overlay, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The fields an overlay focuses first. */
const FIELDS =
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'

export interface DialogProps {
  open: boolean
  /** Esc, the scrim (unless `dismissOnScrim` is false) or a close button asks this. */
  onClose: () => void
  /** The id of the element that names the overlay (its title). */
  labelledBy?: string
  /** The overlay's name, when it has no visible title. */
  label?: string
  /** `alertdialog` for an Alert. */
  role?: 'dialog' | 'alertdialog'
  /** Whether a press on the dim area closes it; never for alerts. */
  dismissOnScrim?: boolean
  /** Where focus goes on open, instead of the first field or the title. */
  initialFocus?: RefObject<HTMLElement | null>
  /** Extra classes on the scrim: `m-scrim--top` for the palette. */
  scrimClassName?: string
  children: ReactNode
}

/** A modal overlay: a form sheet, an alert, the palette, an action sheet. */
export function Dialog({
  open,
  onClose,
  labelledBy,
  label,
  role,
  dismissOnScrim = true,
  initialFocus,
  scrimClassName,
  children,
}: DialogProps): JSX.Element | null {
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const close = useRef(onClose)
  close.current = onClose

  // The element that had focus opens the overlay; it gets focus back.
  useLayoutEffect(() => {
    if (!open) return undefined
    trigger.current = document.activeElement as HTMLElement | null
    return (): void => {
      const back = trigger.current
      trigger.current = null
      if (back?.isConnected === true) back.focus()
    }
  }, [open])

  useEffect(() => {
    const element = dialog.current
    if (!open || element == null) return undefined
    if (!element.open) element.showModal()
    const first =
      initialFocus?.current ??
      element.querySelector<HTMLElement>(FIELDS) ??
      element.querySelector<HTMLElement>('[data-dialog-title]') ??
      element.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return (): void => {
      if (element.open) element.close()
    }
  }, [open, initialFocus])

  if (!open) return null

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close.current()
      return
    }
    if (event.key !== 'Tab') return
    // showModal() already keeps focus in the page's top layer; this wraps it.
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE),
    ]
    if (items.length === 0) return
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement
    if (
      event.shiftKey &&
      (active === first || !items.includes(active as HTMLElement))
    ) {
      event.preventDefault()
      last.focus()
    } else if (
      !event.shiftKey &&
      (active === last || !items.includes(active as HTMLElement))
    ) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <dialog
      ref={dialog}
      className="m-dialog"
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={label}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        // The browser's own Esc handling: the overlay closes through its owner.
        event.preventDefault()
        close.current()
      }}
    >
      <div
        className={cx('m-scrim', scrimClassName)}
        onMouseDown={(event) => {
          if (dismissOnScrim && event.target === event.currentTarget)
            close.current()
        }}
      >
        {children}
      </div>
    </dialog>
  )
}
