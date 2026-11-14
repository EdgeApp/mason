import type { CSSProperties, JSX, ReactNode } from 'react'
import { cx } from './cx.js'
import { Icon } from './Icon.js'
import type { IconName } from './icons.js'

export interface StatTileProps {
  label: string
  icon?: IconName
  value: ReactNode
  /** A unit after the value (`GB`), smaller and secondary. */
  unit?: string
  /** The line under the value. */
  foot?: ReactNode
  /** A gauge on the right, for a value with a range. */
  gauge?: ReactNode
  /** A bar under the value (a meter). */
  children?: ReactNode
}

/** One number, with its label, an optional unit, a meter or gauge, and a note. */
export function StatTile({
  label,
  icon,
  value,
  unit,
  foot,
  gauge,
  children,
}: StatTileProps): JSX.Element {
  const number = (
    <div className="m-stat__value">
      <span className="m-t-metric">{value}</span>
      {unit != null && <span className="m-stat__unit">{unit}</span>}
    </div>
  )
  const footer = foot != null && <div className="m-stat__foot">{foot}</div>
  if (gauge != null)
    return (
      <div className="m-card m-stat m-stat--gauge">
        <div>
          <p className="m-t-eyebrow">{label}</p>
          {number}
          {footer}
        </div>
        {gauge}
      </div>
    )
  return (
    <div className="m-card m-stat">
      <div className="m-stat__head">
        <p className="m-t-eyebrow">{label}</p>
        {icon != null && <Icon name={icon} />}
      </div>
      {number}
      {children}
      {footer}
    </div>
  )
}

export type GaugeTone = 'success' | 'warning' | 'danger'

/** A gauge's tone by threshold: 90 % and up succeeds, 70 % warns, below that is danger. */
export function gaugeTone(percent: number): GaugeTone {
  if (percent >= 90) return 'success'
  if (percent >= 70) return 'warning'
  return 'danger'
}

/** A ring filled to a percentage, toned by threshold, with the value inside. */
export function Gauge({
  percent,
  label,
}: {
  percent: number
  /** What the value means, for assistive tech. */
  label: string
}): JSX.Element {
  const value = Math.max(0, Math.min(100, percent))
  return (
    <div
      className={cx('m-gauge', `m-gauge--${gaugeTone(value)}`)}
      style={
        {
          ['--v' as string]: String(Math.round(value * 10) / 10),
        } as CSSProperties
      }
      role="img"
      aria-label={label}
    >
      <span aria-hidden="true">{Math.round(value)}%</span>
    </div>
  )
}

/** One share of a meter, in a categorical colour. */
export interface MeterPart {
  label: string
  value: number
  series: number
}

/** Shares of a whole as one bar, named in words for assistive tech. */
export function Meter({ parts }: { parts: MeterPart[] }): JSX.Element | null {
  const shown = parts.filter((part) => part.value > 0)
  if (shown.length === 0) return null
  return (
    <div
      className="m-meter"
      role="img"
      aria-label={shown.map((part) => `${part.label} ${part.value}`).join(', ')}
    >
      {shown.map((part) => (
        <span
          key={part.label}
          title={`${part.label} ${part.value}`}
          style={
            {
              flex: part.value,
              ['--c' as string]: `var(--m-cat-${part.series})`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}
