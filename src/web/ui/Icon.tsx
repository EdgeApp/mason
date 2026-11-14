import type { JSX } from 'react'
import { cx } from './cx.js'
import { glyph, type IconName } from './icons.js'

export interface IconProps {
  name: IconName
  /** 16 px (`sm`) in chips, 24 px (`lg`) in glyph boxes and empty states; 20 px by default. */
  size?: 'sm' | 'lg'
  /** Names a meaningful icon; without it the icon is decorative and hidden. */
  label?: string
  className?: string
}

/** One Material Symbols glyph from Mason's subset. */
export function Icon({ name, size, label, className }: IconProps): JSX.Element {
  const classes = cx('m-icon', size != null && `m-icon--${size}`, className)
  return label == null ? (
    <span className={classes} aria-hidden="true">
      {glyph(name)}
    </span>
  ) : (
    <span className={classes} role="img" aria-label={label}>
      {glyph(name)}
    </span>
  )
}
