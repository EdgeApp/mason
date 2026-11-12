import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react'
import { Button } from './Button.js'
import { Icon } from './Icon.js'
import type { IconName } from './icons.js'

/** How long a toast without an action stays. */
export const TOAST_MS = 4_000
/** How long a toast with an action (Undo, Open) stays, at least. */
export const TOAST_ACTION_MS = 10_000

/** A toast's tone, from its icon: success unless it is `error` or `warning`. */
export const toneOf = (icon: IconName | undefined): ToastTone =>
  icon === 'error' ? 'danger' : icon === 'warning' ? 'warning' : 'success'

export type ToastTone = 'success' | 'warning' | 'danger'

export interface ToastOptions {
  text: string
  icon?: IconName
  /** Undo, Open: keeps the toast at least 10 s and reachable by keyboard. */
  action?: { label: string; run: () => void }
}

interface Shown extends ToastOptions {
  id: number
}

type Show = (toast: ToastOptions) => void

const ToastContext = createContext<Show>(() => undefined)

/** Shows a toast: an action finished. It never takes focus. */
export const useToast = (): Show => useContext(ToastContext)

/**
 * The page's toasts, in a polite live region that exists before any toast
 * does, so each is announced. A toast pauses while hovered or focused.
 */
export function ToastProvider({
  children,
}: {
  children: ReactNode
}): JSX.Element {
  const [toast, setToast] = useState<Shown | undefined>()
  const next = useRef(0)
  const show = useCallback<Show>((options) => {
    next.current += 1
    setToast({ ...options, id: next.current })
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="m-toasts" role="status" aria-live="polite">
        {toast != null && (
          <Toast
            key={toast.id}
            toast={toast}
            onDone={() => setToast(undefined)}
          />
        )}
      </div>
    </ToastContext.Provider>
  )
}

function Toast({
  toast,
  onDone,
}: {
  toast: Shown
  onDone: () => void
}): JSX.Element {
  const remaining = useRef(toast.action == null ? TOAST_MS : TOAST_ACTION_MS)
  const started = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const done = useRef(onDone)
  done.current = onDone
  const resume = useCallback(() => {
    clearTimeout(timer.current)
    started.current = Date.now()
    timer.current = setTimeout(() => done.current(), remaining.current)
  }, [])
  const pause = (): void => {
    if (timer.current == null) return
    clearTimeout(timer.current)
    timer.current = undefined
    remaining.current = Math.max(
      0,
      remaining.current - (Date.now() - started.current),
    )
  }
  useEffect(() => {
    resume()
    return (): void => clearTimeout(timer.current)
  }, [resume])
  return (
    <div
      className="m-toast"
      data-tone={toneOf(toast.icon)}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          resume()
      }}
    >
      <Icon name={toast.icon ?? 'check_circle'} />
      <span className="m-toast__text">{toast.text}</span>
      {toast.action != null && (
        <Button
          variant="plain"
          size="sm"
          onClick={() => {
            toast.action!.run()
            onDone()
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <Button
        variant="plain"
        size="sm"
        iconOnly
        icon="close"
        label="Dismiss"
        onClick={onDone}
      />
    </div>
  )
}
