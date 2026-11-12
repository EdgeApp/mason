import type { JSX, ReactNode } from 'react'
import { cx } from './cx.js'
import { Icon } from './Icon.js'
import type { IconName } from './icons.js'

export interface ChipProps {
  /** `mono` for machine values, `accent` for a highlight, `platform` with its series colour. */
  kind?: 'plain' | 'mono' | 'accent' | 'platform'
  /** The platform's categorical colour, 1–6. */
  series?: number
  icon?: IconName
  children: ReactNode
  className?: string
  title?: string
}

/** A label or attribute: a platform, a role, a version. Not a status. */
export function Chip({
  kind = 'plain',
  series,
  icon,
  children,
  className,
  title,
}: ChipProps): JSX.Element {
  return (
    <span
      className={cx('m-chip', kind !== 'plain' && `m-chip--${kind}`, className)}
      style={
        series == null
          ? undefined
          : { ['--c' as string]: `var(--m-cat-${series})` }
      }
      title={title}
    >
      {icon != null && <Icon name={icon} />}
      {children}
    </span>
  )
}
