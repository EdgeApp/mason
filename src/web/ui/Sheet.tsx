import {
  useId,
  useRef,
  useState,
  type JSX,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { NARROW, useMedia } from '../hooks/useMedia.js'
import { Alert } from './Alert.js'
import { Button } from './Button.js'
import { cx } from './cx.js'
import { Dialog } from './Dialog.js'

/** How far a bottom sheet must be dragged down to close. */
export const DRAG_TO_CLOSE = 80

export interface SheetProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** The sheet's content: fields, a list. */
  children: ReactNode
  /**
   * The actions: Cancel and the one primary, right-aligned. As a function it
   * is handed the sheet's own close, which asks first when there are changes.
   */
  footer?: ReactNode | ((close: () => void) => ReactNode)
  /** `large` for more than eight fields in sections. */
  size?: 'form' | 'large'
  /** Unsaved changes: closing asks first. */
  dirty?: boolean
  /** Where focus goes on open, instead of the first field or the title. */
  initialFocus?: RefObject<HTMLElement | null>
}

/**
 * A form sheet: centred on medium and wide, a bottom sheet with a grabber on
 * narrow, which a drag down closes. It always has a visible Close.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'form',
  dirty = false,
  initialFocus,
}: SheetProps): JSX.Element {
  const titleId = useId()
  const narrow = useMedia(NARROW)
  const [confirming, setConfirming] = useState(false)
  const [drag, setDrag] = useState(0)
  const start = useRef<number | null>(null)
  const requestClose = (): void => {
    if (dirty) setConfirming(true)
    else onClose()
  }
  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (!narrow) return
    start.current = event.clientY
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    if (start.current == null) return
    setDrag(Math.max(0, event.clientY - start.current))
  }
  const onPointerUp = (): void => {
    if (start.current == null) return
    start.current = null
    const far = drag > DRAG_TO_CLOSE
    setDrag(0)
    if (far) requestClose()
  }
  return (
    <>
      <Dialog
        open={open}
        onClose={requestClose}
        labelledBy={titleId}
        {...(initialFocus == null ? {} : { initialFocus })}
      >
        <div
          className={cx(size === 'large' ? 'm-largesheet' : 'm-formsheet')}
          style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
        >
          <header
            className="m-formsheet__head"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <h2
              className="m-t-title3"
              id={titleId}
              tabIndex={-1}
              data-dialog-title=""
            >
              {title}
            </h2>
            <Button
              variant="plain"
              iconOnly
              icon="close"
              label="Close"
              onClick={requestClose}
            />
          </header>
          <div className="m-formsheet__body">{children}</div>
          {footer != null && (
            <footer className="m-formsheet__foot">
              {typeof footer === 'function' ? footer(requestClose) : footer}
            </footer>
          )}
        </div>
      </Dialog>
      <Alert
        open={open && confirming}
        title="Discard your changes?"
        message="What you entered in this sheet is not saved."
        cancel="Keep editing"
        confirm="Discard"
        tone="danger"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          onClose()
        }}
      />
    </>
  )
}
