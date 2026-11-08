// The People page's rows and the Your account page: the name and username
// cells turn into fields when tapped, each email line has a red × to take
// it away, and Add opens a modal. A row with any change shows Save instead
// of Remove; both ask in a modal that lists exactly what will happen, and
// nothing is stored until it is accepted.

/** A person as the row was drawn. */
export interface PersonState {
  name: string
  username: string
  role: string
  emails: Array<{ email: string; confirmed: boolean }>
}

/** One email line while it is edited. */
export interface DraftEmail {
  email: string
  confirmed: boolean
  /** Added here, not yet saved. */
  added?: boolean
  /** Marked for removal. */
  removed?: boolean
  /** Marked to be confirmed (administrators). */
  confirm?: boolean
}

export interface Draft {
  name: string
  username: string
  role: string
  emails: DraftEmail[]
}

export const draftOf = (original: PersonState): Draft => ({
  name: original.name,
  username: original.username,
  role: original.role,
  emails: original.emails.map((entry) => ({ ...entry })),
})

/** What Save would change: the lines the modal lists and the request body. */
export function changesOf(
  original: PersonState,
  draft: Draft,
): { lines: string[]; body: Record<string, unknown> } {
  const lines: string[] = []
  const body: Record<string, unknown> = {}
  const shown = (value: string): string => (value === '' ? '—' : value)
  if (draft.name !== original.name) {
    lines.push(`Name: ${shown(original.name)} → ${shown(draft.name)}`)
    body.name = draft.name
  }
  if (draft.username !== original.username) {
    lines.push(
      `Username: ${shown(original.username)} → ${shown(draft.username)}`,
    )
    body.username = draft.username === '' ? null : draft.username
  }
  if (draft.role !== original.role) {
    lines.push(`Role: ${original.role} → ${draft.role}`)
    body.role = draft.role
  }
  const added = draft.emails.filter((entry) => entry.added && !entry.removed)
  const removed = draft.emails.filter((entry) => entry.removed && !entry.added)
  const confirmed = draft.emails.filter(
    (entry) => entry.confirm === true && !entry.removed && !entry.confirmed,
  )
  for (const entry of added) lines.push(`Email added: ${entry.email}`)
  for (const entry of removed) lines.push(`Email removed: ${entry.email}`)
  for (const entry of confirmed) lines.push(`Email confirmed: ${entry.email}`)
  if (added.length > 0 || removed.length > 0)
    body.emails = draft.emails
      .filter((entry) => !entry.removed)
      .map((entry) => entry.email)
  if (confirmed.length > 0)
    body.confirmEmails = confirmed.map((entry) => entry.email)
  return { lines, body }
}

/** What removing a person does, for the Remove modal. */
export const removalLines = [
  'Their email addresses, password, group memberships and invitation link go.',
  'Every API key they created is revoked.',
  'The account is disabled and kept for the audit history.',
]

/** Why an address cannot be added to this row, or undefined when it can. */
export function emailProblem(value: string, draft: Draft): string | undefined {
  const email = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320)
    return 'Enter an email address'
  if (draft.emails.some((entry) => entry.email === email && !entry.removed))
    return 'They already have that address'
  return undefined
}

/** A username a person may have, or why not ('' clears it). */
export function usernameProblem(value: string): string | undefined {
  if (value === '' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
    return undefined
  return 'A username is 1–64 letters, digits, dots, dashes or underscores'
}

/** The few element features the editor uses, so tests can supply them. */
export interface EditorElement {
  dataset: Record<string, string | undefined>
  hidden: boolean
  value: string
  textContent: string | null
  className: string
  classList: {
    add: (name: string) => void
    remove: (name: string) => void
    toggle: (name: string, on?: boolean) => void
  }
  querySelector: (selector: string) => EditorElement | null
  querySelectorAll: (selector: string) => Iterable<EditorElement>
  addEventListener: (
    type: string,
    listener: (event: EditorEvent) => void,
  ) => void
  append: (...nodes: EditorElement[]) => void
  remove: () => void
  setAttribute: (name: string, value: string) => void
  focus: () => void
  closest: (selector: string) => EditorElement | null
  showModal?: () => void
  close?: () => void
}
export interface EditorEvent {
  key?: string
  preventDefault: () => void
}
export interface EditorDocument {
  querySelector: (selector: string) => EditorElement | null
  querySelectorAll: (selector: string) => Iterable<EditorElement>
  getElementById: (id: string) => EditorElement | null
  createElement: (tag: string) => EditorElement
}
export interface EditorDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  reload: () => void
}

/** A refusal's message. */
async function failure(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  return body.error ?? `Request failed (${response.status})`
}

/** Wires every person row on the page, the modals they open, and the pills that open them. */
export function startPeople(doc: EditorDocument, deps: EditorDeps): void {
  const csrf =
    (
      doc.querySelector('meta[name="mason-csrf"]') as {
        content?: string
      } | null
    )?.content ?? ''
  const send = async (
    method: string,
    url: string,
    body?: unknown,
  ): Promise<Response> =>
    await deps.fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(csrf === '' ? {} : { 'x-mason-csrf': csrf }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  // Pills open their modal; a close button closes the modal it is in.
  for (const opener of doc.querySelectorAll('[data-open]'))
    opener.addEventListener('click', () => {
      doc.getElementById(opener.dataset.open ?? '')?.showModal?.()
    })
  for (const closer of doc.querySelectorAll('[data-close]'))
    closer.addEventListener('click', () => {
      closer.closest('dialog')?.close?.()
    })

  const emailDialog = doc.querySelector('[data-email-dialog]')
  const confirmDialog = doc.querySelector('[data-confirm-dialog]')
  /** The row Add was pressed in, and what to do once accepted. */
  let adding: ((email: string) => string | undefined) | undefined
  let accepting: (() => Promise<void>) | undefined

  const emailForm = emailDialog?.querySelector('[data-email-form]')
  emailForm?.addEventListener('submit', (event) => {
    event.preventDefault()
    const field = emailForm.querySelector('input[name="email"]')
    const error = emailForm.querySelector('[data-email-error]')
    const problem = adding?.(field?.value ?? '')
    if (problem != null) {
      if (error != null) {
        error.textContent = problem
        error.hidden = false
      }
      return
    }
    if (error != null) error.hidden = true
    if (field != null) field.value = ''
    emailDialog?.close?.()
  })
  const accept = confirmDialog?.querySelector('[data-confirm-accept]')
  accept?.addEventListener('click', () => {
    const error = confirmDialog?.querySelector('[data-confirm-error]')
    if (error != null) error.hidden = true
    void accepting?.().catch((reason: unknown) => {
      if (error != null) {
        error.textContent = (reason as Error).message
        error.hidden = false
      }
    })
  })
  /** Opens the confirmation modal with its title, lines and accept button. */
  const ask = (
    title: string,
    lines: string[],
    verb: string,
    then: () => Promise<void>,
  ): void => {
    if (confirmDialog == null) return
    const heading = confirmDialog.querySelector('[data-confirm-title]')
    if (heading != null) heading.textContent = title
    const list = confirmDialog.querySelector('[data-confirm-list]')
    if (list != null) {
      for (const old of [...list.querySelectorAll('li')]) old.remove()
      for (const line of lines) {
        const item = doc.createElement('li')
        item.textContent = line
        list.append(item)
      }
    }
    if (accept != null) {
      accept.textContent = verb
      accept.className = verb === 'Remove' ? 'danger-fill' : ''
    }
    const error = confirmDialog.querySelector('[data-confirm-error]')
    if (error != null) error.hidden = true
    accepting = then
    confirmDialog.showModal?.()
  }

  for (const row of doc.querySelectorAll('tr[data-person], [data-person]'))
    wireRow(row)

  // The Add a person form: Add puts another email field under the last.
  const fields = doc.querySelector('[data-email-fields]')
  doc.querySelector('[data-add-email-field]')?.addEventListener('click', () => {
    const input = doc.createElement('input')
    input.setAttribute('name', 'email')
    input.setAttribute('type', 'email')
    input.setAttribute('aria-label', 'Another email address')
    fields?.append(input)
    input.focus()
  })

  function wireRow(row: EditorElement): void {
    const id = row.dataset.person ?? ''
    const original = JSON.parse(row.dataset.original ?? '{}') as PersonState
    const draft = draftOf(original)
    const admin = row.dataset.edit === 'all'
    const action = row.querySelector('[data-row-action]')
    const path = row.dataset.path ?? `/api/v2/people/${id}`

    const refresh = (): void => {
      if (action == null) return
      const changed = changesOf(original, draft).lines.length > 0
      action.textContent = changed ? 'Save' : 'Remove'
      action.className = changed ? 'primary' : 'danger'
      // Without people.change there is nothing to remove: Save only.
      action.hidden = !changed && !admin
    }

    // The name and username cells: a tap turns the text into a field.
    for (const button of row.querySelectorAll('[data-edit]')) {
      const field = button.dataset.edit as 'name' | 'username'
      const input = row.querySelector(`[data-input="${field}"]`)
      if (input == null) continue
      const show = (): void => {
        button.textContent = draft[field] === '' ? '—' : draft[field]
        button.hidden = false
        input.hidden = true
      }
      const keep = (): void => {
        if (input.hidden) return
        const value = input.value.trim()
        if (field === 'username' && usernameProblem(value) != null) {
          input.setAttribute('aria-invalid', 'true')
          return
        }
        if (field === 'name' && value === '') {
          input.value = draft.name
        } else draft[field] = value
        show()
        refresh()
      }
      button.addEventListener('click', () => {
        input.value = draft[field]
        button.hidden = true
        input.hidden = false
        input.focus()
      })
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          keep()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          input.value = draft[field]
          show()
        }
      })
      input.addEventListener('blur', keep)
    }

    // Each email line: × marks it (or drops a new one); Confirm marks it.
    const list = row.querySelector('[data-emails]')
    const wireLine = (line: EditorElement): void => {
      const entry = draft.emails.find(
        (candidate) => candidate.email === line.dataset.email,
      )
      if (entry == null) return
      line
        .querySelector('[data-remove-email]')
        ?.addEventListener('click', () => {
          if (entry.added === true) {
            draft.emails.splice(draft.emails.indexOf(entry), 1)
            line.remove()
          } else {
            entry.removed = entry.removed !== true
            line.classList.toggle('removed', entry.removed)
          }
          refresh()
        })
      line
        .querySelector('[data-confirm-email]')
        ?.addEventListener('click', () => {
          entry.confirm = entry.confirm !== true
          line.classList.toggle('confirming', entry.confirm)
          refresh()
        })
    }
    if (list != null)
      for (const line of list.querySelectorAll('li')) wireLine(line)
    row.querySelector('[data-add-email]')?.addEventListener('click', () => {
      adding = (value): string | undefined => {
        const problem = emailProblem(value, draft)
        if (problem != null) return problem
        const email = value.trim().toLowerCase()
        // An address removed here and added back is simply kept.
        const back = draft.emails.find((entry) => entry.email === email)
        if (back != null) {
          back.removed = false
          for (const line of list?.querySelectorAll('li') ?? [])
            if (line.dataset.email === email) line.classList.remove('removed')
          refresh()
          return undefined
        }
        draft.emails.push({ email, confirmed: admin, added: true })
        const line = doc.createElement('li')
        line.dataset.email = email
        line.classList.add('added')
        const text = doc.createElement('span')
        text.className = 'email'
        text.textContent = email
        const remove = doc.createElement('button')
        remove.setAttribute('type', 'button')
        remove.className = 'remove-email'
        remove.dataset.removeEmail = ''
        remove.setAttribute('aria-label', `Remove ${email}`)
        // The same glyph the page draws: Material Symbols' close.
        const glyph = doc.createElement('span')
        glyph.className = 'icon'
        glyph.setAttribute('aria-hidden', 'true')
        glyph.textContent = String.fromCodePoint(0xe14c)
        remove.append(glyph)
        line.append(text, remove)
        list?.append(line)
        wireLine(line)
        refresh()
        return undefined
      }
      emailDialog?.showModal?.()
    })

    row.querySelector('[data-role]')?.addEventListener('change', () => {
      draft.role = row.querySelector('[data-role]')?.value ?? draft.role
      refresh()
    })

    action?.addEventListener('click', () => {
      const { lines, body } = changesOf(original, draft)
      if (lines.length > 0)
        ask(`Save changes to ${original.name}?`, lines, 'Save', async () => {
          const saved = await send('PUT', path, body)
          if (!saved.ok) throw new Error(await failure(saved))
          deps.reload()
        })
      else
        ask(`Remove ${original.name}?`, removalLines, 'Remove', async () => {
          const removed = await send('DELETE', path)
          if (!removed.ok) throw new Error(await failure(removed))
          deps.reload()
        })
    })
    refresh()
  }
}

const page = globalThis as unknown as {
  document?: EditorDocument
  location?: { reload: () => void }
}
// Only in a browser page: a test importing this module calls `startPeople` itself.
if (page.document != null && page.location != null)
  startPeople(page.document, {
    fetch: async (url, init) => await fetch(url, init),
    reload: (): void => page.location!.reload(),
  })
