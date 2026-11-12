import type { JSX } from 'react'
import { Link } from 'react-router'
import { cx } from './cx.js'
import { Icon } from './Icon.js'
import { statusOf, type Tone } from './status.js'

export interface StatusPillProps {
  /** A key of the status table; an unknown one reads as a neutral status. */
  status: string
  /** Replaces the table's word, for a count ("2 / 3 workers idle"). */
  label?: string
  /** The dense-row form: no fill. */
  quiet?: boolean
  /** A pulsing dot in place of the glyph: only for "updating right now". */
  live?: boolean
  /** Opens a page; the pill becomes a link. */
  to?: string
  /** The accessible name, when the visible text is shorter than the meaning. */
  name?: string
  className?: string
}

/** The CSS classes of a status in a tone. */
export const statusClass = (tone: Tone, quiet = false): string =>
  cx('m-status', `m-status--${tone}`, quiet && 'm-status--quiet')

/** A state: its glyph and its word, toned. Never colour alone. */
export function StatusPill({
  status,
  label,
  quiet = false,
  live = false,
  to,
  name,
  className,
}: StatusPillProps): JSX.Element {
  const treatment = statusOf(status)
  const classes = cx(statusClass(treatment.tone, quiet), className)
  const content = (
    <>
      {live ? (
        <span
          className="m-dot m-dot--live"
          style={{ ['--solid' as string]: `var(--m-${treatment.tone}-solid)` }}
          aria-hidden="true"
        />
      ) : (
        <Icon name={treatment.icon} />
      )}
      {label ?? treatment.word}
    </>
  )
  return to == null ? (
    <span className={classes} aria-label={name}>
      {content}
    </span>
  ) : (
    <Link className={classes} to={to} aria-label={name}>
      {content}
    </Link>
  )
}
