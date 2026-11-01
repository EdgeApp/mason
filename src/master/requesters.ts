import type { DatabaseSync } from 'node:sqlite'

/** The most of a key's id a page shows. */
export const KEY_ID_SHOWN = 6

/** A key's name with any longer stretch of its id cut to what a page shows (default names carry eight). */
const keyName = (name: string, id: string): string =>
  name.replace(
    new RegExp(`${id.slice(0, KEY_ID_SHOWN)}[0-9a-f]+`, 'g'),
    id.slice(0, KEY_ID_SHOWN),
  )

/** An actor label as a page may show it with nothing to resolve it by: a key by the start of its id. */
export function shownLabel(label: string): string {
  const key = /^key:(.+)$/.exec(label)
  return key == null ? label : `key ${key[1]!.slice(0, KEY_ID_SHOWN)}`
}

/**
 * Who an actor label (`account:<id>`, `host:<account id>`, `key:<id>`,
 * `local operator`, or a trigger's own name) names, as a page shows it: an
 * account by its name; a key by the one who made it, its name and the first
 * six characters of its id, `Paul Puey · key "TeamStation CI" (830f19)`;
 * anything else as it is.
 */
export function requesterName(
  db: DatabaseSync,
  label: string,
  depth = 0,
): string {
  const account = /^(?:account|host):(\d+)$/.exec(label)
  if (account != null) {
    const row = db
      .prepare('SELECT name,username FROM accounts WHERE id=?')
      .get(Number(account[1])) as
      | { name: string | null; username: string | null }
      | undefined
    return row?.name || row?.username || `account ${account[1]}`
  }
  const key = /^key:(.+)$/.exec(label)
  if (key == null) return label
  const id = key[1]!
  const row = db
    .prepare('SELECT name,created_by,creator FROM api_keys WHERE id=?')
    .get(id) as
    | { name: string; created_by: string | null; creator: number | null }
    | undefined
  if (row == null) return shownLabel(label)
  const by =
    row.created_by ??
    (row.creator == null ? undefined : `account:${row.creator}`)
  // A key made by a key names that key's maker, a few keys deep at most.
  const maker =
    by == null || depth >= 3 ? undefined : requesterName(db, by, depth + 1)
  return `${maker == null ? '' : `${maker} · `}key "${keyName(row.name, id)}" (${id.slice(0, KEY_ID_SHOWN)})`
}
