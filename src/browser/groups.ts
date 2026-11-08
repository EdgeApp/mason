// The master's group page. The name row becomes a text field when tapped:
// Enter or leaving the field saves a new name, Escape puts the row back, and
// an unchanged name sends nothing. A failed save keeps the field up with the
// master's message. Add App and Add member open a picker over the page's
// catalog: its checkboxes add and remove apps or members, each change PUT at
// once, and Done closes it. Filtering never calls the API.
import {
  appRow,
  memberRow,
  sectionRows,
  type GroupApp,
  type GroupPerson,
} from '../view/groups.js'
import { escape } from '../view/html.js'

/** An event as the page's listeners read it. */
export interface GroupsEvent {
  key?: string
  target?: unknown
  preventDefault: () => void
}

/** The few element features the page uses, so tests can supply them. */
export interface GroupsElement {
  dataset: Record<string, string | undefined>
  hidden: boolean
  value: string
  checked?: boolean
  disabled?: boolean
  readOnly?: boolean
  content?: string
  textContent: string | null
  innerHTML: string
  querySelector: (selector: string) => GroupsElement | null
  querySelectorAll: (selector: string) => Iterable<GroupsElement>
  addEventListener: (
    type: string,
    listener: (event: GroupsEvent) => void,
  ) => void
  focus: () => void
}

export interface GroupsDocument {
  title: string
  querySelector: (selector: string) => GroupsElement | null
  querySelectorAll: (selector: string) => Iterable<GroupsElement>
}

/** What the page needs from its window. */
export interface GroupsDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
}

/** A group as the groups API answers. */
export interface GroupAnswer {
  id: number
  name: string
  apps: Array<{ id: number }>
  members: number[]
}

/** PUTs a change to the group with the page's CSRF token; an error carries the master's message. */
export function groupClient(
  deps: GroupsDeps,
  path: string,
  csrf: string,
): (body: unknown) => Promise<GroupAnswer> {
  return async (body) => {
    const response = await deps.fetch(path, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-mason-csrf': csrf },
      body: JSON.stringify(body),
    })
    const answer = (await response.json().catch(() => null)) as
      | (GroupAnswer & { error?: string })
      | null
    if (!response.ok || answer == null)
      throw new Error(answer?.error ?? `The master answered ${response.status}`)
    return answer
  }
}

/**
 * The name row: a button that becomes a text field, and saves on Enter or
 * blur. While a save is on its way the field stays open and read-only,
 * saying so, and Escape waits for the answer, so no answer lands on newer
 * text. Leaving the field does not resend a name that just failed; Enter
 * does.
 */
function wireName(
  doc: GroupsDocument,
  page: GroupsElement,
  put: (body: unknown) => Promise<GroupAnswer>,
): void {
  const row = page.querySelector('[data-group-name]')
  const button = row?.querySelector('[data-group-rename]')
  const input = row?.querySelector('[data-group-name-input]')
  const text = row?.querySelector('[data-group-name-text]')
  const error = row?.querySelector('[data-group-name-error]')
  if (button == null || input == null || text == null || error == null) return
  let name = input.value
  let busy = false
  // The name that just failed, so leaving the field does not send it again.
  let failed: string | undefined
  const clear = (): void => {
    error.hidden = true
    error.textContent = ''
    failed = undefined
  }
  const close = (): void => {
    input.value = name
    input.hidden = true
    button.hidden = false
    clear()
  }
  button.addEventListener('click', () => {
    if (busy) return
    clear()
    button.hidden = true
    input.hidden = false
    input.value = name
    input.focus()
  })
  const save = (retry: boolean): void => {
    if (input.hidden || busy) return
    const next = input.value.trim()
    if (next === name) {
      close()
      return
    }
    if (next === failed && !retry) return
    busy = true
    input.readOnly = true
    error.textContent = 'Saving…'
    error.hidden = false
    put({ name: next }).then(
      (group) => {
        busy = false
        input.readOnly = false
        name = group.name
        text.textContent = name
        for (const title of doc.querySelectorAll('[data-group-title]'))
          title.textContent = name
        doc.title = `${name} · Mason`
        close()
      },
      (reason: unknown) => {
        busy = false
        input.readOnly = false
        failed = next
        error.textContent = (reason as Error).message
        error.hidden = false
      },
    )
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      save(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (!busy) close()
    }
  })
  input.addEventListener('blur', () => {
    save(false)
  })
}

export type GroupSection = 'apps' | 'members'

/** The text a query matches: an app's name and slug; a person's name, email and addresses. */
function searchable(
  kind: GroupSection,
  item: GroupApp | GroupPerson,
): string[] {
  if (kind === 'apps') {
    const app = item as GroupApp
    return [app.name, app.slug]
  }
  const person = item as GroupPerson
  return [person.name, ...person.emails]
}

/**
 * The picker's choices, in catalog order: with an empty query the first
 * three (enabled apps only), else every entry whose text contains the
 * trimmed query, ignoring case.
 */
export function pickerChoices<T extends GroupApp | GroupPerson>(
  kind: GroupSection,
  items: T[],
  query: string,
): T[] {
  const wanted = query.trim().toLowerCase()
  if (wanted === '')
    return items
      .filter((item) => kind !== 'apps' || (item as GroupApp).enabled)
      .slice(0, 3)
  return items.filter((item) =>
    searchable(kind, item).some((text) => text.toLowerCase().includes(wanted)),
  )
}

/** One choice: the label on the left, the membership checkbox on the right. */
export function choiceRow(
  kind: GroupSection,
  item: GroupApp | GroupPerson,
  checked: boolean,
): string {
  const person = item as GroupPerson
  const address = person.emails?.[0]
  const detail =
    kind === 'apps'
      ? `<small class="mono">${escape((item as GroupApp).slug)}</small>`
      : address == null
        ? ''
        : `<small>${escape(address)}</small>`
  return `<label class="check"><span><strong>${escape(item.name)}</strong>${detail}</span><input type="checkbox" value="${item.id}" data-group-choice${checked ? ' checked' : ''}></label>`
}

/** What the page's catalog element holds. */
export interface GroupCatalog {
  apps: GroupApp[]
  people: GroupPerson[]
  group: { apps: number[]; members: number[] }
}

/**
 * A section's picker: Add opens it, the query filters it, a checkbox PUTs,
 * Done closes it. A refused change shows its message under the section,
 * where it stays after Done until the picker opens again or that item's
 * change succeeds.
 */
function wirePicker(
  section: GroupsElement,
  kind: GroupSection,
  catalog: GroupCatalog,
  put: (body: unknown) => Promise<GroupAnswer>,
): void {
  const add = section.querySelector('[data-group-add]')
  const picker = section.querySelector('[data-group-picker]')
  const query = section.querySelector('[data-group-query]')
  const done = section.querySelector('[data-group-done]')
  const choices = section.querySelector('[data-group-choices]')
  const error = section.querySelector('[data-group-error]')
  const rows = section.querySelector('[data-group-rows]')
  if (
    add == null ||
    picker == null ||
    query == null ||
    done == null ||
    choices == null ||
    error == null ||
    rows == null
  )
    return
  const items: Array<GroupApp | GroupPerson> =
    kind === 'apps' ? catalog.apps : catalog.people
  // What the master holds, and the changes still on their way to it: a
  // checkbox shows the latest change asked for, else the saved membership.
  let chosen = new Set(catalog.group[kind])
  const pending = new Map<number, { count: number; checked: boolean }>()
  const shown = (id: number): boolean =>
    pending.get(id)?.checked ?? chosen.has(id)
  // Each change waits for the one before, so it starts from the saved list.
  let queue: Promise<void> = Promise.resolve()
  // The item the shown message is about.
  let failedId: number | undefined
  const clear = (): void => {
    error.hidden = true
    error.textContent = ''
  }
  const render = (): void => {
    choices.innerHTML =
      pickerChoices(kind, items, query.value)
        .map((item) => choiceRow(kind, item, shown(item.id)))
        .join('') || '<p><small>Nothing matches.</small></p>'
  }
  add.addEventListener('click', () => {
    clear()
    failedId = undefined
    picker.hidden = false
    render()
    query.focus()
  })
  query.addEventListener('input', render)
  // Done keeps a message already shown: the change it names did not happen.
  done.addEventListener('click', () => {
    picker.hidden = true
    query.value = ''
    choices.innerHTML = ''
  })
  choices.addEventListener('change', (event) => {
    const box = event.target as GroupsElement | null | undefined
    if (box?.dataset.groupChoice === undefined) return
    const id = Number(box.value)
    const checked = box.checked === true
    const entry = pending.get(id) ?? { count: 0, checked }
    entry.count++
    entry.checked = checked
    pending.set(id, entry)
    queue = queue.then(async () => {
      // The saved list, with this one change: ids this page does not list stay.
      const ids = [...chosen].filter((other) => other !== id)
      if (checked) ids.push(id)
      try {
        const group = await put({ [kind]: ids })
        chosen = new Set(
          kind === 'apps' ? group.apps.map((app) => app.id) : group.members,
        )
        rows.innerHTML =
          kind === 'apps'
            ? sectionRows(catalog.apps, chosen, appRow)
            : sectionRows(catalog.people, chosen, memberRow)
        // Only this item's own success answers its message; another's stays.
        if (failedId === id) {
          clear()
          failedId = undefined
        }
      } catch (reason) {
        // Shown under the section even after Done, since the change did not happen.
        failedId = id
        error.textContent = (reason as Error).message
        error.hidden = false
      }
      if (--entry.count === 0) pending.delete(id)
      // The boxes on screen now, which a new query may have drawn since.
      for (const shownBox of choices.querySelectorAll(
        'input[data-group-choice]',
      ))
        shownBox.checked = shown(Number(shownBox.value))
    })
  })
}

/** Wires a group page; any other page is left alone. */
export function startGroup(doc: GroupsDocument, deps: GroupsDeps): void {
  const page = doc.querySelector('[data-group]')
  if (page == null) return
  const csrf = doc.querySelector('meta[name="mason-csrf"]')?.content ?? ''
  const put = groupClient(deps, `/api/v2/groups/${page.dataset.group}`, csrf)
  wireName(doc, page, put)
  const source = doc.querySelector('[data-group-catalog]')?.textContent
  if (source == null) return
  const catalog = JSON.parse(source) as GroupCatalog
  for (const kind of ['apps', 'members'] as const) {
    const section = page.querySelector(`[data-group-section="${kind}"]`)
    if (section != null) wirePicker(section, kind, catalog, put)
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined')
  startGroup(document as unknown as GroupsDocument, {
    fetch: window.fetch.bind(window),
  })
