import type { JSX } from 'react'
import { Link } from 'react-router'
import { cx } from './cx.js'
import { Icon } from './Icon.js'
import { platformLook } from './platform.js'
import { Chip } from './Chip.js'
import { statusOf } from './status.js'

export interface RunChipProps {
  branch: string
  /** A run's number, or a build's number when `build` is set. */
  number: string | number
  /** The run's status; a build whose run is unknown has none. */
  status?: string
  /** A build's age (`6d`). */
  age?: string
  /** A build chip: the number is the build's, shown in text colour. */
  build?: boolean
  /** Where it opens; without one it is a plain chip. */
  to?: string
}

/**
 * A run or a build: the status glyph, the branch and the number (and a
 * build's age). The status word is in the accessible name.
 */
export function RunChip({
  branch,
  number,
  status,
  age,
  build = false,
  to,
}: RunChipProps): JSX.Element {
  const treatment = status == null ? undefined : statusOf(status)
  const name = [
    branch,
    build ? `build ${number}` : `Run ${number}`,
    treatment?.word,
    age,
  ]
    .filter((part) => part != null)
    .join(', ')
  const className = cx(
    'm-runchip',
    treatment != null && `m-runchip--${treatment.tone}`,
  )
  const content = (
    <>
      {treatment != null && <Icon name={treatment.icon} />}
      <span className="m-runchip__branch">{branch}</span>
      <span className={cx('m-runchip__num', build && 'm-runchip__num--build')}>
        {build ? number : `Run ${number}`}
      </span>
      {age != null && <span className="m-runchip__num">{age}</span>}
    </>
  )
  return to == null ? (
    <span className={className} aria-label={name} role="img">
      {content}
    </span>
  ) : (
    <Link className={className} to={to} aria-label={name}>
      {content}
    </Link>
  )
}

/** The last chip of a capped collection, opening the full list. */
export function MoreChip({
  count,
  to,
  name,
}: {
  count: number
  to: string
  /** What the full list is, for the accessible name. */
  name: string
}): JSX.Element {
  return (
    <Link className="m-runchip m-runchip--more" to={to} aria-label={name}>
      +{count} more
    </Link>
  )
}

/** A platform's chip in its series colour. */
export function PlatformChip({ platform }: { platform: string }): JSX.Element {
  const look = platformLook(platform)
  return (
    <Chip kind="platform" series={look.series}>
      {look.name}
    </Chip>
  )
}
