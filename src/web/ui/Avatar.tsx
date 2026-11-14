import type { JSX } from 'react'
import { cx } from './cx.js'

/** A person's initial: the first letter of their name, or "?" without one. */
export const initial = (name: string): string =>
  name.trim().charAt(0).toUpperCase() || '?'

/** A person's avatar: their initial on the info tone. Decorative; the control around it is named. */
export function Avatar({
  name,
  size,
}: {
  name: string
  size?: 'sm'
}): JSX.Element {
  return (
    <span
      className={cx('m-avatar', size != null && `m-avatar--${size}`)}
      aria-hidden="true"
    >
      {initial(name)}
    </span>
  )
}
