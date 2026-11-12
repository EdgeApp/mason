// What the signed-out pages share (DESIGN-LANGUAGE.md §14, screen-18):
// the bare shell with a centred title, a card naming a state, and how a
// refusal reads (a throttle says when to try again, §6).
import { useEffect, type JSX, type ReactNode } from 'react'
import { tryAgainAt } from '../../../shared/format.js'
import { ApiError } from '../../api/client.js'
import { BareShell } from '../../layout/BareShell.js'
import { cx } from '../../ui/cx.js'
import { Icon } from '../../ui/Icon.js'
import type { IconName } from '../../ui/icons.js'
import { PAGE_TITLE_ID } from '../../ui/PageHeader.js'

/** A signed-out page: the bare shell, its one `h1` and description, then its cards. */
export function SignedOut({
  title,
  description,
  mark = false,
  children,
}: {
  title: string
  description?: ReactNode
  /** Mason's mark over the title, as on sign-in. */
  mark?: boolean
  children: ReactNode
}): JSX.Element {
  useEffect(() => {
    document.title = `${title} · Mason`
  }, [title])
  return (
    <BareShell>
      <header className="m-signin__head">
        {mark && (
          <img
            className="m-signin__mark"
            src="/assets/logo/mason-logo-128.png"
            alt=""
            width="64"
            height="64"
          />
        )}
        <h1 className="m-t-title1" id={PAGE_TITLE_ID} tabIndex={-1}>
          {title}
        </h1>
        {description != null && <p className="m-page__desc">{description}</p>}
      </header>
      {children}
    </BareShell>
  )
}

export type StateTone = 'success' | 'warning' | 'danger' | 'neutral'

/** A card naming a state: its glyph, a headline, a line about it, and the way on. */
export function StateCard({
  tone = 'neutral',
  icon,
  title,
  children,
  actions,
}: {
  tone?: StateTone
  icon: IconName
  title: string
  children?: ReactNode
  actions?: ReactNode
}): JSX.Element {
  return (
    <section className="m-card" aria-label={title}>
      <div className="m-card__body m-stack">
        <div className="m-statecard__row">
          <span
            className={cx(
              'm-glyphbox',
              tone !== 'neutral' && `m-glyphbox--${tone}`,
            )}
          >
            <Icon name={icon} />
          </span>
          <span className="m-list__main">
            <span className="m-t-headline">{title}</span>
            {children != null && (
              <span className="m-t-callout m-secondary">{children}</span>
            )}
          </span>
        </div>
        {actions != null && <div className="m-form__actions">{actions}</div>}
      </div>
    </section>
  )
}

/**
 * What a refused request says on the page: the node's message, and for a
 * lock or a throttle when to try again (`… Try again at 1435 PT.`).
 */
export function refusal(error: unknown, now: number = Date.now()): string {
  const message = (error as Error).message.replace(/[.\s]+$/, '')
  if (!(error instanceof ApiError) || error.retryAt == null) return message
  return `${message}. ${tryAgainAt(error.retryAt, now)}.`
}

/** Whether a refusal means the node could not do it now (unreachable, or its master is): a warning, not the person's mistake. */
export const unavailable = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 0 || error.status === 503)

/**
 * After a submit the page refused, focus moves to the first field with an
 * error (DESIGN-LANGUAGE.md §12): `fields` names each field's control id in
 * the form's order. Returns whether any field had one.
 */
export function focusFirstInvalid(
  errors: Partial<Record<string, string>>,
  fields: ReadonlyArray<readonly [string, string]>,
): boolean {
  const first = fields.find(([name]) => errors[name] != null)
  if (first == null) return false
  document.getElementById(first[1])?.focus()
  return true
}
