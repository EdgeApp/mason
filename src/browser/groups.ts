// The master's group page. The name row becomes a text field when tapped:
// Enter or leaving the field saves a new name, Escape puts the row back, and
// an unchanged name sends nothing. A failed save keeps the field up with the
// master's message.

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

/** Wires a group page; any other page is left alone. */
export function startGroup(doc: GroupsDocument, deps: GroupsDeps): void {
  const page = doc.querySelector('[data-group]')
  if (page == null) return
  const csrf = doc.querySelector('meta[name="mason-csrf"]')?.content ?? ''
  const put = groupClient(deps, `/api/v2/groups/${page.dataset.group}`, csrf)
  wireName(doc, page, put)
}

if (typeof document !== 'undefined' && typeof window !== 'undefined')
  startGroup(document as unknown as GroupsDocument, {
    fetch: window.fetch.bind(window),
  })
