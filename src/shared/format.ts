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
