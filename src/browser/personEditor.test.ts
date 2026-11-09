import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import {
  changesOf,
  draftOf,
  emailProblem,
  removalLines,
  startPeople,
  usernameProblem,
  type EditorDocument,
  type EditorEvent,
  type PersonState,
} from './personEditor.js'

/** An element whose queries answer from what the test put in it. */
class El {
  tag: string
  dataset: Record<string, string | undefined> = {}
  hidden = false
  value = ''
  textContent: string | null = ''
  className = ''
  classes = new Set<string>()
  attributes = new Map<string, string>()
  kids: El[] = []
  named = new Map<string, El[]>()
  listeners = new Map<string, Array<(event: EditorEvent) => void>>()
  parent: El | null = null
  open = false
  focused = 0
  constructor(tag = 'div') {
    this.tag = tag
  }
  get classList(): {
    add: (name: string) => void
    remove: (name: string) => void
    toggle: (name: string, on?: boolean) => void
  } {
    return {
      add: (name): void => {
        this.classes.add(name)
      },
      remove: (name): void => {
        this.classes.delete(name)
      },
      toggle: (name, on): void => {
        if (on ?? !this.classes.has(name)) this.classes.add(name)
        else this.classes.delete(name)
      },
    }
  }
  /** Answers `selector` with these elements (and adopts them). */
  set(selector: string, ...elements: El[]): this {
    this.named.set(selector, elements)
    for (const element of elements) element.parent = this
    return this
  }
  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  querySelectorAll(selector: string): El[] {
    if (selector === 'li') return this.kids.filter((kid) => kid.tag === 'li')
    const named = this.named.get(selector)
    if (named != null) return named
    // `[data-name]` also finds appended children carrying that data key.
    const data = /^\[data-([a-z-]+)\]$/.exec(selector)?.[1]
    if (data == null) return []
    const key = data.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    )
    return this.kids.flatMap((kid) => [
      ...(kid.dataset[key] === undefined ? [] : [kid]),
      ...kid.querySelectorAll(selector),
    ])
  }
  addEventListener(type: string, listener: (event: EditorEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  fire(type: string, event: Partial<EditorEvent> = {}): number {
    let prevented = 0
    for (const listener of this.listeners.get(type) ?? [])
      listener({
        preventDefault: () => {
          prevented++
        },
        ...event,
      })
    return prevented
  }
  append(...nodes: El[]): void {
    for (const node of nodes) {
      node.parent = this
      this.kids.push(node)
    }
  }
  remove(): void {
    if (this.parent == null) return
    this.parent.kids = this.parent.kids.filter((kid) => kid !== this)
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  focus(): void {
    this.focused++
  }
  closest(selector: string): El | null {
    let node: El | null = this.parent
    while (node != null && !(selector === 'dialog' && node.tag === 'dialog'))
      node = node.parent
    return node
  }
  showModal(): void {
    this.open = true
  }
  close(): void {
    this.open = false
  }
}

const ada: PersonState = {
  name: 'Ada',
  username: 'ada',
  role: 'tester',
  emails: [
    { email: 'ada@example.test', confirmed: true },
    { email: 'ada@claimed.test', confirmed: false },
  ],
}

/** A line of an email list, as the page draws it. */
function line(email: string, confirm: boolean): El {
  const item = new El('li')
  item.dataset.email = email
  item.set('[data-remove-email]', new El('button'))
  if (confirm) item.set('[data-confirm-email]', new El('button'))
  return item
}

/** A page with one person's row, the email modal and the confirmation modal. */
function pageWith(
  person: PersonState,
  edit: 'all' | 'self',
  answers: Array<{ status: number; body: unknown }> = [],
): {
  doc: {
    querySelector: (selector: string) => El | null
    querySelectorAll: (selector: string) => El[]
    getElementById: (id: string) => El | null
    createElement: (tag: string) => El
  }
  row: El
  cells: Record<string, El>
  list: El
  emailDialog: El
  confirmDialog: El
  calls: Array<{ url: string; init: RequestInit }>
  reloads: () => number
} {
  const cells: Record<string, El> = {
    name: new El('button'),
    nameInput: new El('input'),
    username: new El('button'),
    usernameInput: new El('input'),
    add: new El('button'),
    role: new El('select'),
    action: new El('button'),
  }
  cells.nameInput!.hidden = cells.usernameInput!.hidden = true
  cells.name!.dataset.edit = 'name'
  cells.username!.dataset.edit = 'username'
  cells.role!.value = person.role
  const list = new El('ul')
  list.append(
    ...person.emails.map((entry) => line(entry.email, !entry.confirmed)),
  )
  const row = new El('tr')
  row.dataset.person = '7'
  row.dataset.edit = edit
  row.dataset.original = JSON.stringify(person)
  row
    .set(
      '[data-edit]',
      cells.name!,
      ...(edit === 'all' ? [cells.username!] : []),
    )
    .set('[data-input="name"]', cells.nameInput!)
    .set('[data-input="username"]', cells.usernameInput!)
    .set('[data-emails]', list)
    .set('[data-add-email]', cells.add!)
    .set('[data-row-action]', cells.action!)
  if (edit === 'all') row.set('[data-role]', cells.role!)
  const emailField = new El('input')
  const emailError = new El('p')
  emailError.hidden = true
  const emailForm = new El('form')
    .set('input[name="email"]', emailField)
    .set('[data-email-error]', emailError)
  const emailClose = new El('button')
  const emailDialog = new El('dialog')
    .set('[data-email-form]', emailForm)
    .set('[data-close]', emailClose)
  const confirmList = new El('ul')
  const confirmDialog = new El('dialog')
    .set('[data-confirm-title]', new El('h2'))
    .set('[data-confirm-list]', confirmList)
    .set('[data-confirm-error]', new El('p'))
    .set('[data-confirm-accept]', new El('button'))
  const cancel = new El('button')
  confirmDialog.set('[data-close]', cancel)
  const meta = { content: 'proof' } as unknown as El
  const pill = new El('button')
  pill.dataset.open = 'invite-7'
  const invite = new El('dialog')
  const inviteClose = new El('button')
  invite.set('[data-close]', inviteClose)
  const doc = {
    querySelector: (selector: string): El | null =>
      selector === '[data-email-dialog]'
        ? emailDialog
        : selector === '[data-confirm-dialog]'
          ? confirmDialog
          : selector === 'meta[name="mason-csrf"]'
            ? meta
            : null,
    querySelectorAll: (selector: string): El[] =>
      selector === '[data-open]'
        ? [pill]
        : selector === '[data-close]'
          ? [emailClose, cancel, inviteClose]
          : selector === 'tr[data-person], [data-person]'
            ? [row]
            : [],
    getElementById: (id: string): El | null =>
      id === 'invite-7' ? invite : null,
    createElement: (tag: string): El => new El(tag),
  }
  const calls: Array<{ url: string; init: RequestInit }> = []
  let reloads = 0
  startPeople(doc as unknown as EditorDocument, {
    fetch: async (url, init) => {
      calls.push({ url, init })
      const answer = answers.shift() ?? { status: 200, body: {} }
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
      })
    },
    reload: () => {
      reloads++
    },
  })
  // The pills and close buttons, wired by the same start.
  pill.fire('click')
  assert.equal(invite.open, true)
  inviteClose.fire('click')
  assert.equal(invite.open, false)
  return {
    doc,
    row,
    cells,
    list,
    emailDialog,
    confirmDialog,
    calls,
    reloads: () => reloads,
  }
}

const settle = async (): Promise<void> => {
  for (let n = 0; n < 5; n++)
    await new Promise((resolve) => setImmediate(resolve))
}

describe('Person editor', () => {
  it('M3.1 lists exactly what Save changes and sends only that', () => {
    const draft = draftOf(ada)
    assert.deepEqual(changesOf(ada, draft), { lines: [], body: {} })
    draft.name = 'Ada Lovelace'
    draft.username = ''
    draft.role = 'developer'
    draft.emails[0]!.removed = true
    draft.emails[1]!.confirm = true
    draft.emails.push({ email: 'ada@new.test', confirmed: true, added: true })
    assert.deepEqual(changesOf(ada, draft), {
      lines: [
        'Name: Ada → Ada Lovelace',
        'Username: ada → —',
        'Role: tester → developer',
        'Email added: ada@new.test',
        'Email removed: ada@example.test',
        'Email confirmed: ada@claimed.test',
      ],
      body: {
        name: 'Ada Lovelace',
        username: null,
        role: 'developer',
        emails: ['ada@claimed.test', 'ada@new.test'],
        confirmEmails: ['ada@claimed.test'],
      },
    })
    // A confirmed address marked to confirm, or one also removed, is no change.
    const quiet = draftOf(ada)
    quiet.emails[0]!.confirm = true
    quiet.emails[1]!.confirm = quiet.emails[1]!.removed = true
    assert.deepEqual(changesOf(ada, quiet).lines, [
      'Email removed: ada@claimed.test',
    ])
    assert.deepEqual(
      changesOf(
        { ...ada, username: '' },
        { ...draftOf(ada), username: 'ada2' },
      ).lines.slice(0, 1),
      ['Username: — → ada2'],
    )
    assert.equal(removalLines.length, 3)
  })

  it('M3.2 checks a new address and a username before the row takes them', () => {
    const draft = draftOf(ada)
    assert.equal(
      emailProblem('not an address', draft),
      'Enter an email address',
    )
    assert.equal(
      emailProblem(`${'a'.repeat(320)}@x.test`, draft),
      'Enter an email address',
    )
    assert.equal(
      emailProblem(' ADA@example.test ', draft),
      'They already have that address',
    )
    draft.emails[0]!.removed = true
    assert.equal(emailProblem('ada@example.test', draft), undefined)
    assert.equal(emailProblem('new@example.test', draft), undefined)
    assert.equal(usernameProblem(''), undefined)
    assert.equal(usernameProblem('ada.l-2'), undefined)
    assert.match(usernameProblem('-ada')!, /1–64 letters/)
  })

  it('M3.3 a tapped name turns into a field: Escape restores it, Enter keeps it, and Remove becomes Save until undone', () => {
    const { cells } = pageWith(ada, 'all')
    const action = cells.action!
    assert.equal(action.textContent, 'Remove')
    assert.equal(action.className, 'danger')
    cells.name!.fire('click')
    assert.equal(cells.name!.hidden, true)
    assert.equal(cells.nameInput!.hidden, false)
    assert.equal(cells.nameInput!.focused, 1)
    cells.nameInput!.value = 'Typed'
    assert.equal(cells.nameInput!.fire('keydown', { key: 'Escape' }), 1)
    assert.equal(cells.nameInput!.hidden, true)
    assert.equal(cells.name!.textContent, 'Ada')
    assert.equal(action.textContent, 'Remove')
    cells.name!.fire('click')
    cells.nameInput!.value = '  Ada L  '
    cells.nameInput!.fire('keydown', { key: 'Enter' })
    assert.equal(cells.name!.textContent, 'Ada L')
    assert.equal(action.textContent, 'Save')
    assert.equal(action.className, 'primary')
    // Other keys do nothing; a blank name is not taken.
    cells.name!.fire('click')
    cells.nameInput!.fire('keydown', { key: 'a' })
    cells.nameInput!.value = ' '
    cells.nameInput!.fire('blur')
    assert.equal(cells.name!.textContent, 'Ada L')
    // Back to the original: Remove again.
    cells.name!.fire('click')
    cells.nameInput!.value = 'Ada'
    cells.nameInput!.fire('blur')
    assert.equal(action.textContent, 'Remove')
    // A blur after the field closed changes nothing.
    cells.nameInput!.fire('blur')
    // A username that is not one stays in its field, marked.
    cells.username!.fire('click')
    cells.usernameInput!.value = '-bad'
    cells.usernameInput!.fire('blur')
    assert.equal(cells.usernameInput!.hidden, false)
    assert.equal(cells.usernameInput!.attributes.get('aria-invalid'), 'true')
    cells.usernameInput!.value = ''
    cells.usernameInput!.fire('blur')
    assert.equal(cells.username!.textContent, '—')
    assert.equal(action.textContent, 'Save')
  })

  it('M3.4 × marks an address, Confirm marks one to confirm, and Add opens a modal that appends a checked line', () => {
    const { cells, list, emailDialog } = pageWith(ada, 'all')
    const [first, second] = list.querySelectorAll('li')
    first!.querySelector('[data-remove-email]')!.fire('click')
    assert(first!.classes.has('removed'))
    assert.equal(cells.action!.textContent, 'Save')
    first!.querySelector('[data-remove-email]')!.fire('click')
    assert(!first!.classes.has('removed'))
    assert.equal(cells.action!.textContent, 'Remove')
    second!.querySelector('[data-confirm-email]')!.fire('click')
    assert(second!.classes.has('confirming'))
    assert.equal(cells.action!.textContent, 'Save')
    second!.querySelector('[data-confirm-email]')!.fire('click')
    // Add: the modal opens; a bad address stays with a message.
    cells.add!.fire('click')
    assert.equal(emailDialog.open, true)
    const form = emailDialog.querySelector('[data-email-form]')!
    const field = form.querySelector('input[name="email"]')!
    const error = form.querySelector('[data-email-error]')!
    field.value = 'ada@example.test'
    assert.equal(form.fire('submit'), 1)
    assert.equal(error.textContent, 'They already have that address')
    assert.equal(error.hidden, false)
    assert.equal(emailDialog.open, true)
    field.value = 'Ada@New.test'
    form.fire('submit')
    assert.equal(emailDialog.open, false)
    assert.equal(error.hidden, true)
    assert.equal(field.value, '')
    const added = list.querySelectorAll('li').at(-1)!
    assert.equal(added.dataset.email, 'ada@new.test')
    assert(added.classes.has('added'))
    assert.equal(cells.action!.textContent, 'Save')
    // × on a line added here drops it.
    added.querySelector('[data-remove-email]')!.fire('click')
    assert.equal(list.querySelectorAll('li').length, 2)
    assert.equal(cells.action!.textContent, 'Remove')
    // Removed, then added back: the old line comes back.
    first!.querySelector('[data-remove-email]')!.fire('click')
    cells.add!.fire('click')
    field.value = 'ada@example.test'
    form.fire('submit')
    assert(!first!.classes.has('removed'))
    assert.equal(list.querySelectorAll('li').length, 2)
    assert.equal(cells.action!.textContent, 'Remove')
    // The modal's Cancel closes it.
    cells.add!.fire('click')
    emailDialog.querySelector('[data-close]')!.fire('click')
    assert.equal(emailDialog.open, false)
  })

  it('M3.5 Save asks with every change and sends only the changed fields; a refusal stays in the modal', async () => {
    const { cells, confirmDialog, calls, reloads } = pageWith(ada, 'all', [
      {
        status: 409,
        body: { error: 'That email address belongs to someone else' },
      },
      { status: 200, body: {} },
    ])
    cells.role!.value = 'manager'
    cells.role!.fire('change')
    cells.name!.fire('click')
    cells.nameInput!.value = 'Ada Lovelace'
    cells.nameInput!.fire('keydown', { key: 'Enter' })
    cells.action!.fire('click')
    assert.equal(confirmDialog.open, true)
    assert.equal(
      confirmDialog.querySelector('[data-confirm-title]')!.textContent,
      'Save changes to Ada?',
    )
    assert.deepEqual(
      confirmDialog
        .querySelector('[data-confirm-list]')!
        .querySelectorAll('li')
        .map((item) => item.textContent),
      ['Name: Ada → Ada Lovelace', 'Role: tester → manager'],
    )
    const accept = confirmDialog.querySelector('[data-confirm-accept]')!
    assert.equal(accept.textContent, 'Save')
    accept.fire('click')
    await settle()
    const error = confirmDialog.querySelector('[data-confirm-error]')!
    assert.equal(
      error.textContent,
      'That email address belongs to someone else',
    )
    assert.equal(error.hidden, false)
    assert.equal(reloads(), 0)
    accept.fire('click')
    await settle()
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.url, '/api/v2/people/7')
    assert.equal(calls[1]!.init.method, 'PUT')
    assert.deepEqual(
      (calls[1]!.init.headers as Record<string, string>)['x-mason-csrf'],
      'proof',
    )
    assert.deepEqual(JSON.parse(calls[1]!.init.body as string), {
      name: 'Ada Lovelace',
      role: 'manager',
    })
    assert.equal(reloads(), 1)
    // Asking again clears the old lines.
    cells.action!.fire('click')
    assert.equal(
      confirmDialog.querySelector('[data-confirm-list]')!.querySelectorAll('li')
        .length,
      2,
    )
  })

  it('M3.6 Remove asks what removal does, then deletes; a refusal without a message says its status', async () => {
    const { cells, confirmDialog, calls, reloads } = pageWith(ada, 'all', [
      { status: 500, body: {} },
      { status: 200, body: null },
    ])
    cells.action!.fire('click')
    assert.equal(
      confirmDialog.querySelector('[data-confirm-title]')!.textContent,
      'Remove Ada?',
    )
    const accept = confirmDialog.querySelector('[data-confirm-accept]')!
    assert.equal(accept.textContent, 'Remove')
    assert.equal(accept.className, 'danger-fill')
    assert.deepEqual(
      confirmDialog
        .querySelector('[data-confirm-list]')!
        .querySelectorAll('li')
        .map((item) => item.textContent),
      removalLines,
    )
    accept.fire('click')
    await settle()
    assert.equal(
      confirmDialog.querySelector('[data-confirm-error]')!.textContent,
      'Request failed (500)',
    )
    accept.fire('click')
    await settle()
    assert.equal(calls[1]!.init.method, 'DELETE')
    assert.equal(calls[1]!.init.body, undefined)
    assert.equal(reloads(), 1)
    // Cancel closes it.
    confirmDialog.querySelector('[data-close]')!.fire('click')
    assert.equal(confirmDialog.open, false)
  })

  it('M3.7 a person editing their own row sees Save only once something changed, and adds unconfirmed addresses', async () => {
    const { cells, list, emailDialog, confirmDialog, calls } = pageWith(
      ada,
      'self',
    )
    assert.equal(cells.action!.hidden, true)
    cells.add!.fire('click')
    const form = emailDialog.querySelector('[data-email-form]')!
    form.querySelector('input[name="email"]')!.value = 'ada@mine.test'
    form.fire('submit')
    assert.equal(cells.action!.hidden, false)
    assert.equal(cells.action!.textContent, 'Save')
    assert.equal(list.querySelectorAll('li').length, 3)
    cells.action!.fire('click')
    confirmDialog.querySelector('[data-confirm-accept]')!.fire('click')
    await settle()
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
      emails: ['ada@example.test', 'ada@claimed.test', 'ada@mine.test'],
    })
    // Undone: Save hides again, as there is nothing to remove.
    list
      .querySelectorAll('li')
      .at(-1)!
      .querySelector('[data-remove-email]')!
      .fire('click')
    assert.equal(cells.action!.hidden, true)
  })

  it('M3.8 Add on the Add a person form puts another email field under the last', () => {
    const fields = new El('div')
    const add = new El('button')
    startPeople(
      {
        querySelector: (selector: string): El | null =>
          selector === '[data-email-fields]'
            ? fields
            : selector === '[data-add-email-field]'
              ? add
              : null,
        querySelectorAll: (): El[] => [],
        getElementById: (): El | null => null,
        createElement: (tag: string): El => new El(tag),
      } as unknown as EditorDocument,
      { fetch: async () => new Response('{}'), reload: () => undefined },
    )
    add.fire('click')
    add.fire('click')
    assert.equal(fields.kids.length, 2)
    assert.equal(fields.kids[1]!.attributes.get('name'), 'email')
    assert.equal(fields.kids[1]!.attributes.get('type'), 'email')
    assert.equal(fields.kids[1]!.focused, 1)
  })
})
