// The rows a group page lists, shared by the master's page and the script
// that edits it, so a row the script adds matches one the page rendered.
import { escape } from './html.js'

/** An app as a group page knows it: every row of the apps table. */
export interface GroupApp {
  id: number
  name: string
  slug: string
  enabled: boolean
}

/** A person as a group page knows them: everyone not removed. */
export interface GroupPerson {
  id: number
  name: string
  email?: string
  addresses: Record<string, string>
}

/** One of the group's apps: its name, and its slug in smaller text. */
export function appRow(app: GroupApp): string {
  return `<li data-id="${app.id}"><div><strong>${escape(app.name)}</strong><small class="mono">${escape(app.slug)}</small></div></li>`
}

/** One of the group's members: their name, and their email in smaller text. */
export function memberRow(person: GroupPerson): string {
  const address = person.email ?? Object.values(person.addresses)[0]
  return `<li data-id="${person.id}"><div><strong>${escape(person.name)}</strong>${address == null ? '' : `<small>${escape(address)}</small>`}</div></li>`
}

/** The rows of a section: the catalog's entries that are in `ids`, in catalog order. */
export function sectionRows<T extends { id: number }>(
  catalog: T[],
  ids: Iterable<number>,
  row: (item: T) => string,
): string {
  const chosen = new Set(ids)
  return catalog
    .filter((item) => chosen.has(item.id))
    .map(row)
    .join('')
}
