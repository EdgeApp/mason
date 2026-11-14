import type { JSX } from 'react'
import { cx } from './cx.js'

/** An inline spinner for a value refreshing; named for assistive tech. */
export function Spinner({
  label = 'Loading',
  size,
}: {
  label?: string
  size?: 'sm'
}): JSX.Element {
  return (
    <span
      className={cx('m-spinner', size != null && `m-spinner--${size}`)}
      role="status"
      aria-label={label}
    />
  )
}
