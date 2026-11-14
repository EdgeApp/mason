import type { JSX } from 'react'
import { cx } from './cx.js'

export interface BadgeProps {
  count: number
  tone?: 'accent' | 'neutral' | 'danger'
  /** The count's meaning ("5 need you"); without it the badge is hidden from assistive tech, as its control names the count. */
  label?: string
  className?: string
}

/** A count on a control or a heading. */
export function Badge({
  count,
  tone = 'accent',
  label,
  className,
}: BadgeProps): JSX.Element {
  return (
    <span
      className={cx(
        'm-badge',
        tone !== 'accent' && `m-badge--${tone}`,
        className,
      )}
      aria-hidden={label == null ? 'true' : undefined}
      aria-label={label}
      role={label == null ? undefined : 'img'}
    >
      {count.toLocaleString('en-US')}
    </span>
  )
}

/** A quiet count beside a label, in tabular mono figures. */
export function Count({ count }: { count: number }): JSX.Element {
  return <span className="m-count">{count.toLocaleString('en-US')}</span>
}
