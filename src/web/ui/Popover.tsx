import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type JSX,
  type ReactNode,
} from 'react'
import { NARROW, useMedia } from '../hooks/useMedia.js'
import { Sheet } from './Sheet.js'
import { useDismiss } from './useDismiss.js'

export interface PopoverProps {
  open: boolean
  onClose: () => void
  title: string
  /** Beside the title: a count. */
  aside?: ReactNode
  /** The control that opens it, rendered in place; the popover hangs below it. */
  trigger: ReactNode
  children: ReactNode
}

/**
 * A small panel from the top bar (notifications): below its trigger on
 * medium and wide, a sheet on narrow. Focus moves to its title; Esc, a press
 * outside or focus leaving it closes it, and focus returns to the trigger.
 */
export function Popover({
  open,
  onClose,
  title,
  aside,
  trigger,
  children,
}: PopoverProps): JSX.Element {
  const narrow = useMedia(NARROW)
  const titleId = useId()
  const area = useRef<HTMLSpanElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const close = useCallback(() => onClose(), [onClose])
  useDismiss(open && !narrow, area, close)
  useEffect(() => {
    if (open && !narrow) heading.current?.focus()
  }, [open, narrow])
  const closeToTrigger = (): void => {
    area.current?.querySelector<HTMLElement>('[aria-expanded]')?.focus()
    onClose()
  }
  return (
    <span className="m-anchor" ref={area}>
      {trigger}
      {open && !narrow && (
        <div
          className="m-popover"
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            closeToTrigger()
          }}
        >
          <div className="m-popover__head">
            <h2
              className="m-t-headline"
              id={titleId}
              ref={heading}
              tabIndex={-1}
            >
              {title}
            </h2>
            {aside}
          </div>
          {children}
        </div>
      )}
      {narrow && (
        <Sheet open={open} onClose={onClose} title={title}>
          {children}
        </Sheet>
      )}
    </span>
  )
}
