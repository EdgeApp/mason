/**
 * Cron schedules for `{ schedule }` triggers, evaluated in the master's time
 * zone: five fields (minute, hour, day of month, month, day of week) with
 * `*`, lists, ranges and steps; day of week 0 or 7 is Sunday. As in cron,
 * when both day fields are restricted a time matches either of them.
 */

interface Field {
  values: Set<number>
  any: boolean
}

const bounds: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]
const monthNames = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]
const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function number(text: string, index: number): number {
  const lower = text.toLowerCase()
  if (index === 3 && monthNames.includes(lower))
    return monthNames.indexOf(lower) + 1
  if (index === 4 && dayNames.includes(lower)) return dayNames.indexOf(lower)
  if (!/^\d+$/.test(text)) throw new Error(`Invalid cron value ${text}`)
  return Number(text)
}

function field(text: string, index: number): Field {
  const [low, high] = bounds[index]!
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText == null ? 1 : Number(stepText)
    if (!Number.isSafeInteger(step) || step < 1)
      throw new Error(`Invalid cron step in ${text}`)
    let from: number
    let to: number
    if (range === '*') [from, to] = [low, high]
    else if (range!.includes('-')) {
      const [a, b] = range!.split('-')
      from = number(a!, index)
      to = number(b!, index)
    } else {
      from = number(range!, index)
      to = stepText == null ? from : high
    }
    if (from < low || to > high || from > to)
      throw new Error(`Cron value out of range in ${text}`)
    for (let value = from; value <= to; value += step)
      values.add(index === 4 && value === 7 ? 0 : value)
  }
  return { values, any: text === '*' }
}

export interface Cron {
  fields: Field[]
}

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('A schedule is a 5-field cron entry')
  return { fields: parts.map(field) }
}

/** The local minute, hour, day, month and weekday of an instant in a time zone. */
function local(at: number, timeZone: string): number[] {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  )
  return [
    Number(parts.minute),
    Number(parts.hour),
    Number(parts.day),
    Number(parts.month),
    dayNames.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
  ]
}

export function cronMatches(cron: Cron, at: number, timeZone: string): boolean {
  const [minute, hour, day, month, weekday] = local(at, timeZone)
  const [m, h, dom, mon, dow] = cron.fields as [
    Field,
    Field,
    Field,
    Field,
    Field,
  ]
  if (!m.values.has(minute!) || !h.values.has(hour!) || !mon.values.has(month!))
    return false
  const dayOk = dom.values.has(day!)
  const weekdayOk = dow.values.has(weekday!)
  if (!dom.any && !dow.any) return dayOk || weekdayOk
  return dayOk && weekdayOk
}

/** The master's time zone. */
export const masterTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone
