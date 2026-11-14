// The pieces every Settings card shares (screen-10-settings): the card with
// its icon, title and header actions; its read's loading and error states
// inside the card, with Retry; an action's busy state and its inline error,
// which takes focus; and the day a thing happened.
import {
  useCallback,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react'
import { absoluteTime } from '../../../../shared/format.js'
import type { Resource } from '../../../hooks/useResource.js'
import { Button } from '../../../ui/Button.js'
import { FormError } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import type { IconName } from '../../../ui/icons.js'
import { SkeletonText } from '../../../ui/Skeleton.js'

/** A day without its clock: `Today`, `Nov 1`, or `2025-11-01` in another year. */
export const day = (at: number, now = Date.now()): string =>
  absoluteTime(at, now).replace(/ \d{4} \S+$/, '')

/** A Settings card: a titled section the index links to by its id. */
export function SettingsCard({
  id,
  icon,
  title,
  count,
  actions,
  heading = 'h2',
  className,
  children,
}: {
  id?: string
  icon: IconName
  title: ReactNode
  /** Beside the title: how many it lists. */
  count?: ReactNode
  /** The header's end: an add button, a state, a note. */
  actions?: ReactNode
  heading?: 'h2' | 'h3'
  className?: string
  children: ReactNode
}): JSX.Element {
  const Title = heading
  const titleId = `${id ?? String(title)}-title`
  return (
    <section
      className={['m-card', 'm-settings__card', className]
        .filter(Boolean)
        .join(' ')}
      id={id}
      aria-labelledby={titleId}
    >
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name={icon} />
          <Title className="m-t-title3" id={titleId} tabIndex={-1}>
            {title}
          </Title>
          {count}
        </div>
        {actions}
      </header>
      {children}
    </section>
  )
}

/**
 * A card's read: a skeleton while it loads, the error with Retry when it
 * failed, else its content.
 */
export function Read<T>({
  read,
  what,
  children,
}: {
  read: Resource<T>
  /** What could not be read: "The API keys". */
  what: string
  children: (data: T) => ReactNode
}): JSX.Element {
  if (read.data != null) return <>{children(read.data)}</>
  if (read.error != null)
    return (
      <div className="m-card__body m-stack m-settings__failed">
        <FormError>
          {what} could not be read: {read.error.message}
        </FormError>
        <Button
          variant="secondary"
          size="sm"
          icon="refresh"
          onClick={read.reload}
        >
          Retry
        </Button>
      </div>
    )
  return (
    <div className="m-card__body">
      <SkeletonText
        lines={3}
        label={`Loading ${what.charAt(0).toLowerCase()}${what.slice(1)}`}
      />
    </div>
  )
}

export interface Actions {
  /** The action under way, by its key. */
  busy: string | undefined
  /** Why the action with this key failed, if it did. */
  failed: (key: string) => string | undefined
  /** Runs an action: busy while it runs; a failure is kept and its error focused. */
  run: (key: string, work: () => Promise<void>) => Promise<boolean>
  /** Forgets a failure. */
  clear: () => void
  /** The failure's element, which takes focus. */
  error: RefObject<HTMLParagraphElement | null>
}

/** A card's actions: one at a time, each busy while it runs, each failure inline. */
export function useActions(): Actions {
  const [busy, setBusy] = useState<string | undefined>()
  const [failure, setFailure] = useState<
    { key: string; message: string } | undefined
  >()
  const error = useRef<HTMLParagraphElement>(null)
  const run = useCallback(
    async (key: string, work: () => Promise<void>): Promise<boolean> => {
      setBusy(key)
      setFailure(undefined)
      try {
        await work()
        return true
      } catch (reason) {
        setFailure({ key, message: (reason as Error).message })
        setTimeout(() => error.current?.focus(), 0)
        return false
      } finally {
        setBusy(undefined)
      }
    },
    [],
  )
  return {
    busy,
    failed: (key) => (failure?.key === key ? failure.message : undefined),
    run,
    clear: () => setFailure(undefined),
    error,
  }
}

/** An action's inline error, when it failed. */
export function Failure({
  actions,
  name,
}: {
  actions: Actions
  name: string
}): JSX.Element | null {
  const message = actions.failed(name)
  return message == null ? null : (
    <FormError ref={actions.error}>{message}</FormError>
  )
}

/** A comma-separated list as names. */
export const listOf = (text: string): string[] =>
  text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

/** Whether a value is an https address. */
export const isHttps = (value: string): boolean =>
  /^https:\/\/[^\s/]+/.test(value.trim())
