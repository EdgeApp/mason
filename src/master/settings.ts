import type { MasterDatabase } from './database.js'
import { requireRole, type Actor } from './roles.js'

/** A setting value is a JSON object. */
export type SettingValue = Record<string, unknown>

export interface SettingsArea {
  /**
   * Validates a new value. `previous` is the stored value, so a write-only
   * field sent as `{ keep: true }` can reuse what is stored.
   */
  validate(
    input: unknown,
    previous: SettingValue | undefined,
    context: { actor: Actor; now: number },
  ): SettingValue | Promise<SettingValue>
  /** Top-level fields that are secrets: never returned, only set or unset. */
  secrets?: string[] | ((value: SettingValue | undefined) => string[])
  /** Called after a change commits, for areas published to the host or nodes. */
  changed?(value: SettingValue): void
}

export class UnknownArea extends Error {
  constructor(area: string) {
    super(`No settings area named ${area}`)
  }
}

/** Settings areas share one API; each area validates its own values. */
export class Settings {
  private areas = new Map<string, SettingsArea>()
  constructor(readonly master: MasterDatabase) {}

  register(name: string, area: SettingsArea): void {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error('Invalid area name')
    this.areas.set(name, area)
  }
  names(): string[] {
    return [...this.areas.keys()].sort()
  }
  private area(name: string): SettingsArea {
    const area = this.areas.get(name)
    if (area == null) throw new UnknownArea(name)
    return area
  }

  /** The stored value, for code on the master that uses it. */
  value(name: string): SettingValue | undefined {
    const row = this.master.db
      .prepare('SELECT value FROM settings WHERE area=?')
      .get(name) as { value: string } | undefined
    return row == null ? undefined : (JSON.parse(row.value) as SettingValue)
  }

  /** What an administrator sees: secret fields as `{ set: true }`. */
  get(actor: Actor, name: string): SettingValue {
    requireRole(actor, 'manager')
    const area = this.area(name)
    const value = this.value(name) ?? {}
    const out: SettingValue = { ...value }
    const secrets =
      typeof area.secrets === 'function'
        ? area.secrets(value)
        : (area.secrets ?? [])
    for (const field of secrets) out[field] = { set: value[field] != null }
    return out
  }

  async set(actor: Actor, name: string, input: unknown): Promise<SettingValue> {
    requireRole(actor, 'manager')
    const area = this.area(name)
    const previous = this.value(name)
    const value = await area.validate(input, previous, {
      actor,
      now: this.master.now(),
    })
    this.master.transaction(() => {
      this.master.db
        .prepare(
          'INSERT INTO settings(area,value,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(area) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
        )
        .run(name, JSON.stringify(value), this.master.now(), actor.label)
      this.master.audit(actor, 'settings.set', name)
    })
    area.changed?.(value)
    return this.get(actor, name)
  }
}

/** For a write-only field: `{ keep: true }` reuses the stored value. */
export function keepSecret(
  input: unknown,
  previous: unknown,
  clean: (value: unknown) => string,
): string | undefined {
  if (input == null) return undefined
  if (
    typeof input === 'object' &&
    (input as { keep?: unknown }).keep === true
  ) {
    if (typeof previous !== 'string') throw new Error('No stored value to keep')
    return previous
  }
  return clean(input)
}
