import type { MasterDatabase } from './database.js'

/** A build-number scheme as `setup` declares it. */
export interface BuildNumberScheme {
  scope: 'app' | 'branch'
  format: string
  start: number
  timeZone: string
  check?: 'apple' | 'android'
  /** App IDs whose stages take their numbers from this sequence (the graph keeps it; counters ignore it). */
  apps?: string[]
}

type Token =
  | { kind: 'date'; part: 'YYYY' | 'YY' | 'MM' | 'DD' | 'HH' }
  | { kind: 'count'; width: number }
  | { kind: 'plain' }
  | { kind: 'literal'; text: string }

const ANDROID_MAX = 2_100_000_000

export function parseFormat(format: string): Token[] {
  const tokens: Token[] = []
  for (let i = 0; i < format.length; ) {
    const rest = format.slice(i)
    const date = /^(YYYY|YY|MM|DD|HH)/.exec(rest)
    if (date != null) {
      tokens.push({ kind: 'date', part: date[1] as 'YYYY' })
      i += date[1]!.length
    } else if (rest.startsWith('C')) {
      const width = /^C+/.exec(rest)![0].length
      tokens.push({ kind: 'count', width })
      i += width
    } else if (rest.startsWith('N')) {
      tokens.push({ kind: 'plain' })
      i++
    } else {
      tokens.push({ kind: 'literal', text: format[i]! })
      i++
    }
  }
  return tokens
}

/** Validates a scheme, filling defaults; the format must be able to keep its `check`. */
export function asScheme(value: unknown): BuildNumberScheme {
  const input = (value ?? {}) as Partial<BuildNumberScheme>
  const format = input.format ?? 'N'
  if (typeof format !== 'string' || format.length === 0 || format.length > 40)
    throw new Error('A build-number format is 1–40 characters')
  const tokens = parseFormat(format)
  const counts = tokens.filter(
    (token) => token.kind === 'count' || token.kind === 'plain',
  )
  if (counts.length !== 1)
    throw new Error('A build-number format has exactly one C… or N count')
  const plain = counts[0]!.kind === 'plain'
  const scope = input.scope ?? 'app'
  if (scope !== 'app' && scope !== 'branch')
    throw new Error('scope is app or branch')
  const start = input.start ?? 1
  if (!Number.isSafeInteger(start) || start < 0)
    throw new Error('start is a whole number')
  if (start !== 1 && !plain) throw new Error('start applies to N formats only')
  const timeZone = input.timeZone ?? 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    throw new Error(`Unknown time zone ${timeZone}`)
  }
  const check = input.check
  if (check != null && check !== 'apple' && check !== 'android')
    throw new Error('check is apple or android')
  const literals = tokens
    .filter((token) => token.kind === 'literal')
    .map((token) => (token as { text: string }).text)
  if (check === 'apple') {
    if (
      literals.some((text) => text !== '.' && !/\d/.test(text)) ||
      literals.filter((text) => text === '.').length > 2
    )
      throw new Error(
        'An apple build number is at most three dot-separated integers',
      )
    if (format.startsWith('.') || format.endsWith('.') || format.includes('..'))
      throw new Error(
        'An apple build number is at most three dot-separated integers',
      )
  }
  if (check === 'android') {
    if (literals.some((text) => !/\d/.test(text)))
      throw new Error('An android build number is a single integer')
    if (!plain) {
      const widest = tokens
        .map((token) =>
          token.kind === 'date'
            ? '9'.repeat(token.part.length)
            : token.kind === 'count'
              ? '9'.repeat(token.width)
              : token.kind === 'literal'
                ? token.text
                : '',
        )
        .join('')
      if (Number(widest.replace(/^9999/, '2099')) > ANDROID_MAX)
        throw new Error(
          'This format can exceed the android limit of 2,100,000,000',
        )
    }
  }
  return { scope, format, start, timeZone, ...(check == null ? {} : { check }) }
}

function dateParts(
  at: number,
  timeZone: string,
): Record<'YYYY' | 'YY' | 'MM' | 'DD' | 'HH', string> {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  )
  return {
    YYYY: parts.year!,
    YY: parts.year!.slice(-2),
    MM: parts.month!,
    DD: parts.day!,
    HH: parts.hour!,
  }
}

/** The rendered date part: the format with its count left out. */
export function datePart(scheme: BuildNumberScheme, at: number): string {
  const parts = dateParts(at, scheme.timeZone)
  return parseFormat(scheme.format)
    .map((token) =>
      token.kind === 'date'
        ? parts[token.part]
        : token.kind === 'literal'
          ? token.text
          : '#',
    )
    .join('')
}

export function render(
  scheme: BuildNumberScheme,
  at: number,
  count: number,
): string {
  const parts = dateParts(at, scheme.timeZone)
  return parseFormat(scheme.format)
    .map((token) => {
      if (token.kind === 'date') return parts[token.part]
      if (token.kind === 'literal') return token.text
      if (token.kind === 'plain') return String(count)
      const text = String(count)
      if (text.length > token.width)
        throw new Error(
          `The build-number count ${count} outgrew ${'C'.repeat(token.width)}; widen the format`,
        )
      return text.padStart(token.width, '0')
    })
    .join('')
}

/** Compares build numbers as numbers, component by component. */
export function compareNumbers(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The master's build-number counters, by project, key, branch (for branch
 * scope) and rendered date part. Every value handed out is higher than the
 * last one for that key and scope, and none is handed out twice.
 */
export class BuildNumbers {
  constructor(
    readonly master: MasterDatabase,
    /** Offsets every count: C… starts at countBase+1, N at countBase+start. */
    readonly countBase: () => number = () => 0,
  ) {}

  /** Records the scheme a project's setup declared for a key. */
  declare(projectId: number, key: string, value: unknown): BuildNumberScheme {
    const scheme = asScheme(value)
    this.master.db
      .prepare(
        'INSERT INTO build_number_schemes(project_id,key,scheme) VALUES(?,?,?) ON CONFLICT(project_id,key) DO UPDATE SET scheme=excluded.scheme',
      )
      .run(projectId, key, JSON.stringify(scheme))
    return scheme
  }
  scheme(projectId: number, key: string): BuildNumberScheme | undefined {
    const row = this.master.db
      .prepare(
        'SELECT scheme FROM build_number_schemes WHERE project_id=? AND key=?',
      )
      .get(projectId, key) as { scheme: string } | undefined
    return row == null
      ? undefined
      : (JSON.parse(row.scheme) as BuildNumberScheme)
  }

  /** Fails when the scheme would render a value lower than one already issued. */
  checkScheme(
    projectId: number,
    key: string,
    branch: string,
    value: unknown,
    at = this.master.now(),
  ): void {
    const scheme = asScheme(value)
    const scopeBranch = scheme.scope === 'branch' ? branch : ''
    const last = this.last(projectId, key, scopeBranch)
    if (last == null) return
    const next = this.preview(projectId, key, scopeBranch, scheme, at)
    if (compareNumbers(next, last) <= 0)
      throw new Error(
        `The ${key} scheme would render ${next}, not above ${last} already issued; raise start or change the format`,
      )
  }

  private last(
    projectId: number,
    key: string,
    branch: string,
  ): string | undefined {
    const row = this.master.db
      .prepare(
        'SELECT value FROM build_number_last WHERE project_id=? AND key=? AND branch=?',
      )
      .get(projectId, key, branch) as { value: string } | undefined
    return row?.value
  }
  private count(
    projectId: number,
    key: string,
    branch: string,
    part: string,
  ): number {
    const row = this.master.db
      .prepare(
        'SELECT count FROM build_numbers WHERE project_id=? AND key=? AND branch=? AND date_part=?',
      )
      .get(projectId, key, branch, part) as { count: number } | undefined
    return row?.count ?? 0
  }
  private nextCount(
    projectId: number,
    key: string,
    branch: string,
    scheme: BuildNumberScheme,
    part: string,
  ): number {
    const plain = parseFormat(scheme.format).some(
      (token) => token.kind === 'plain',
    )
    const base = this.countBase()
    const floor = plain ? base + scheme.start - 1 : base
    return Math.max(this.count(projectId, key, branch, part), floor) + 1
  }
  private preview(
    projectId: number,
    key: string,
    branch: string,
    scheme: BuildNumberScheme,
    at: number,
  ): string {
    const plain = parseFormat(scheme.format).some(
      (token) => token.kind === 'plain',
    )
    const part = plain ? '' : datePart(scheme, at)
    return render(
      scheme,
      at,
      this.nextCount(projectId, key, branch, scheme, part),
    )
  }

  /**
   * Reserves the next number for a key. The same `reservation` (a stage
   * attempt) always gets the same number; a new reservation never reuses one.
   */
  reserve(
    projectId: number,
    key: string,
    branch: string,
    value: unknown,
    reservation: string,
    at = this.master.now(),
  ): string {
    const scheme = asScheme(value)
    return this.master.transaction(() => {
      const existing = this.master.db
        .prepare(
          'SELECT value FROM build_number_reservations WHERE project_id=? AND key=? AND reservation=?',
        )
        .get(projectId, key, reservation) as { value: string } | undefined
      if (existing != null) return existing.value
      const scopeBranch = scheme.scope === 'branch' ? branch : ''
      const plain = parseFormat(scheme.format).some(
        (token) => token.kind === 'plain',
      )
      const part = plain ? '' : datePart(scheme, at)
      const count = this.nextCount(projectId, key, scopeBranch, scheme, part)
      const rendered = render(scheme, at, count)
      if (scheme.check === 'android' && Number(rendered) > ANDROID_MAX)
        throw new Error(
          `${rendered} exceeds the android limit of 2,100,000,000`,
        )
      const last = this.last(projectId, key, scopeBranch)
      if (last != null && compareNumbers(rendered, last) <= 0)
        throw new Error(
          `The ${key} scheme would render ${rendered}, not above ${last}; raise start or change the format`,
        )
      this.master.db
        .prepare(
          'INSERT INTO build_numbers(project_id,key,branch,date_part,count) VALUES(?,?,?,?,?) ON CONFLICT(project_id,key,branch,date_part) DO UPDATE SET count=excluded.count',
        )
        .run(projectId, key, scopeBranch, part, count)
      this.master.db
        .prepare(
          'INSERT INTO build_number_last(project_id,key,branch,value) VALUES(?,?,?,?) ON CONFLICT(project_id,key,branch) DO UPDATE SET value=excluded.value',
        )
        .run(projectId, key, scopeBranch, rendered)
      this.master.db
        .prepare(
          'INSERT INTO build_number_reservations(project_id,key,reservation,value,created_at) VALUES(?,?,?,?,?)',
        )
        .run(projectId, key, reservation, rendered, this.master.now())
      return rendered
    })
  }

  /**
   * Seeds counters from a copy of an earlier Mason's `files/buildNum.json`: an
   * array of `{ branch, lastBuildDate, buildNumber }` with `YYMMDDCC`
   * numbers. Each branch's counter for that date part rises to at least the
   * entry's count plus `countBase`; nothing is lowered.
   */
  seed(projectId: number, key: string, entries: unknown): { branches: number } {
    const scheme = this.scheme(projectId, key)
    if (
      scheme != null &&
      (scheme.scope !== 'branch' || scheme.format !== 'YYMMDDCC')
    )
      throw new Error(`${key} is not a branch-scoped YYMMDDCC scheme`)
    if (!Array.isArray(entries))
      throw new Error('Expected the buildNum.json array')
    const seen = new Set<string>()
    const rows = entries.map((entry: unknown) => {
      const row = entry as {
        branch?: unknown
        buildNumber?: unknown
        lastBuildDate?: unknown
      }
      if (
        row == null ||
        typeof row.branch !== 'string' ||
        row.branch === '' ||
        !Number.isSafeInteger(row.buildNumber) ||
        !/^\d{8}$/.test(String(row.buildNumber))
      )
        throw new Error(
          'Each entry is {branch, lastBuildDate, buildNumber} with a YYMMDDCC number',
        )
      if (seen.has(row.branch))
        throw new Error(`Duplicate branch ${row.branch}`)
      seen.add(row.branch)
      const text = String(row.buildNumber)
      return {
        branch: row.branch,
        // The date part as a YYMMDDCC scheme renders it, without its count.
        part: text.slice(0, 6) + '#',
        count: Number(text.slice(6)),
        value: text,
      }
    })
    const base = this.countBase()
    this.master.transaction(() => {
      for (const row of rows) {
        const count = row.count + base
        this.master.db
          .prepare(
            'INSERT INTO build_numbers(project_id,key,branch,date_part,count) VALUES(?,?,?,?,?) ON CONFLICT(project_id,key,branch,date_part) DO UPDATE SET count=MAX(count,excluded.count)',
          )
          .run(projectId, key, row.branch, row.part, count)
        const seeded = row.part.slice(0, 6) + String(count).padStart(2, '0')
        const last = this.last(projectId, key, row.branch)
        if (last == null || compareNumbers(seeded, last) > 0)
          this.master.db
            .prepare(
              'INSERT INTO build_number_last(project_id,key,branch,value) VALUES(?,?,?,?) ON CONFLICT(project_id,key,branch) DO UPDATE SET value=excluded.value',
            )
            .run(projectId, key, row.branch, seeded)
      }
      this.master.audit(
        { role: 'admin', label: 'local operator' },
        'build-numbers.seed',
        `${projectId}:${key}`,
      )
    })
    return { branches: rows.length }
  }
}
