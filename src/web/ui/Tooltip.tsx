import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Icon } from './Icon.js'

/**
 * Extra detail about a control: shown 500 ms after the pointer rests on it
 * and at once on keyboard focus, closed by Esc, and the pointer can move onto
 * it. Nothing required lives only here. The child gets `aria-describedby`.
 */
export function Tooltip({
  content,
  children,
}: {
  content: ReactNode
  children: ReactElement<{ 'aria-describedby'?: string }>
}): JSX.Element {
  const id = useId()
  const [dismissed, setDismissed] = useState(false)
  return (
    <span
      className="m-tip"
      data-dismissed={dismissed ? '' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setDismissed(true)
      }}
      onMouseLeave={() => setDismissed(false)}
      onBlur={() => setDismissed(false)}
    >
      {cloneElement(children, { 'aria-describedby': id })}
      <span className="m-tip__bubble m-tooltip" role="tooltip" id={id}>
        {content}
      </span>
    </span>
  )
}

/**
 * A 44 px info button on touch that shows its detail in a polite region
 * when pressed, and hides it on a second press, Esc or a press elsewhere.
 */
export function Toggletip({
  label,
  children,
}: {
  /** Names the button: "About build numbers". */
  label: string
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const area = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const onPress = (event: MouseEvent): void => {
      if (!area.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPress)
    return (): void => document.removeEventListener('mousedown', onPress)
  }, [open])
  return (
    <span
      className="m-tip"
      ref={area}
      data-open={open ? '' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      <button
        type="button"
        className="m-toggletip"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="info" size="sm" />
      </button>
      <span className="m-tip__bubble m-tooltip" role="status">
        {open ? children : null}
      </span>
    </span>
  )
}
