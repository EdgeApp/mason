import type { CSSProperties, JSX } from 'react'
import { cx } from './cx.js'

export interface SkeletonProps {
  /** A CSS length; the full width by default. */
  width?: string
  /** A CSS length; one line of body text by default. */
  height?: string
  /** Rounded like a pill (a chip, a button). */
  pill?: boolean
  className?: string
}

/** A placeholder shaped like the content it stands for, while that loads. */
export function Skeleton({
  width = '100%',
  height = '1rem',
  pill = false,
  className,
}: SkeletonProps): JSX.Element {
  const style: CSSProperties = { width, height }
  if (pill) style.borderRadius = 'var(--m-radius-pill)'
  return (
    <span
      className={cx('m-skel', className)}
      style={{ display: 'block', ...style }}
      aria-hidden="true"
    />
  )
}

/** Lines of text loading: the last one shorter, as a paragraph ends. */
export function SkeletonText({
  lines = 3,
  label = 'Loading',
}: {
  lines?: number
  label?: string
}): JSX.Element {
  return (
    <div
      className="m-stack"
      style={{ gap: 'var(--m-space-3)' }}
      role="status"
      aria-label={label}
    >
      {Array.from({ length: lines }, (_, n) => (
        <Skeleton
          key={n}
          width={n === lines - 1 && lines > 1 ? '60%' : '100%'}
        />
      ))}
    </div>
  )
}
