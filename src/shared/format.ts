// The design language's formats (DESIGN-LANGUAGE.md §6), one function each,
// for the server and the web app. Times are in the viewer's zone unless a
// zone is given, 24-hour, with the zone's short name.

/** A zone's short name: the generic one where it is short (`PT`, `ET`), else the specific one (`UTC`, `GMT+1`). */
function zoneName(at: Date, timeZone: string | undefined): string {
  const name = (style: 'shortGeneric' | 'short'): string =>
    new Intl.DateTimeFormat('en-US', {
      ...(timeZone == null ? {} : { timeZone }),
      timeZoneName: style,
    })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? ''
  const generic = name('shortGeneric')
  return /\s|^GMT/.test(generic) || generic === '' ? name('short') : generic
}

/** A moment's calendar fields in a zone. */
function fields(
  at: number,
  timeZone: string | undefined,
): Record<'year' | 'month' | 'day' | 'hour' | 'minute', string> {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      ...(timeZone == null ? {} : { timeZone }),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  )
  return parts as Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/**
 * An absolute time: `Today 1422 PT`, `Yesterday 1435 PT`, `Nov 7 0912 PT`,
 * or `2025-11-07 0912 PT` in another year.
 */
export function absoluteTime(
  at: number,
  now: number,
  timeZone?: string,
): string {
  const when = fields(at, timeZone)
  const today = fields(now, timeZone)
  const yesterday = fields(now - 86_400_000, timeZone)
  const clock = `${when.hour}${when.minute} ${zoneName(new Date(at), timeZone)}`
  const same = (other: typeof when): boolean =>
    other.year === when.year &&
    other.month === when.month &&
    other.day === when.day
  if (same(today)) return `Today ${clock}`
  if (same(yesterday)) return `Yesterday ${clock}`
  if (when.year === today.year)
    return `${MONTHS[Number(when.month) - 1]} ${Number(when.day)} ${clock}`
  return `${when.year}-${when.month}-${when.day} ${clock}`
}

/** A relative time for lists: `now`, `5m ago`, `3h ago` within a day, then the absolute form. */
export function relativeTime(
  at: number,
  now: number,
  timeZone?: string,
): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return absoluteTime(at, now, timeZone)
}

/** A count with thousands separators: `1,284`. */
export const count = (value: number): string => value.toLocaleString('en-US')

/**
 * When a throttled sign-in may try again: `Try again at 1435 PT` the same
 * day, else with the absolute form's day (`Try again at Nov 8 0912 PT`).
 */
export function tryAgainAt(at: number, now: number, timeZone?: string): string {
  const when = absoluteTime(at, now, timeZone)
  return `Try again at ${when.replace(/^Today /, '')}`
}

/** A duration such as `4m 12s`: seconds under a minute, hours past an hour. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Bytes in powers of a thousand: `312.8 GB`, `512 B`. */
export function bytes(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** A build chip's age, as short as it can be: `now`, `5m`, `3h`, `6d`, `2w`, `1mo`, `2y`. */
export function shortAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  if (days < 60) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

/** A duration as a clock, for stage lists and step rows: `0:21`, `4:12`, `1:05:09`. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const two = (value: number): string => String(value).padStart(2, '0')
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(seconds % 60)}`
    : `${minutes}:${two(seconds % 60)}`
}
