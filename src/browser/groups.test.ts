import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import {
  choiceRow,
  groupClient,
  pickerChoices,
  startGroup,
  type GroupCatalog,
  type GroupsDeps,
  type GroupsDocument,
  type GroupsEvent,
} from './groups.js'
import type { GroupApp, GroupPerson } from '../view/groups.js'

/** An element whose queries answer from a table of selectors. */
class El {
  children = new Map<string, El[]>()
  listeners = new Map<string, Array<(event: GroupsEvent) => void>>()
  dataset: Record<string, string | undefined> = {}
  hidden = false
  value = ''
  checked = false
  disabled = false
  readOnly = false
  content?: string
  textContent: string | null = ''
  innerHTML = ''
  focused = 0
  set(selector: string, ...elements: El[]): this {
    this.children.set(selector, elements)
    return this
  }
  querySelector(selector: string): El | null {
    return this.children.get(selector)?.[0] ?? null
  }
  querySelectorAll(selector: string): El[] {
    return this.children.get(selector) ?? []
  }
  addEventListener(type: string, listener: (event: GroupsEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  fire(type: string, event: Partial<GroupsEvent> = {}): number {
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
  focus(): void {
    this.focused++
  }
}

class Doc extends El {
  title = 'Beta · Mason'
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setImmediate(resolve))
}
const reply = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    json: async () =>
      typeof body === 'string' ? JSON.parse(body) : (body ?? null),
  }) as unknown as Response

interface Call {
  url: string
  init: RequestInit
}

/** A group page with its name row, and a fetch that answers from a queue. */
function namePage(name = 'Beta'): {
  doc: Doc
  button: El
  input: El
  text: El
  error: El
  titles: El[]
  calls: Call[]
  answers: Response[]
  deps: GroupsDeps
} {
  const doc = new Doc()
  const page = new El()
  page.dataset.group = '5'
  const row = new El()
  const button = new El()
  const input = new El()
  input.hidden = true
  input.value = name
  const text = new El()
  text.textContent = name
  const error = new El()
  error.hidden = true
  row
    .set('[data-group-rename]', button)
    .set('[data-group-name-input]', input)
    .set('[data-group-name-text]', text)
    .set('[data-group-name-error]', error)
  page.set('[data-group-name]', row)
  const meta = new El()
  meta.content = 'proof'
  const titles = [new El(), new El()]
  doc
    .set('[data-group]', page)
    .set('meta[name="mason-csrf"]', meta)
    .set('[data-group-title]', ...titles)
  const calls: Call[] = []
  const answers: Response[] = []
  const deps: GroupsDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init })
      return answers.shift()!
    },
  }
  return { doc, button, input, text, error, titles, calls, answers, deps }
}

describe('Group page script', () => {
  it('U20.6 an unchanged name sends nothing, on Enter or on leaving the field', async () => {
    const page = namePage()
    startGroup(page.doc as unknown as GroupsDocument, page.deps)
    page.button.fire('click')
    assert.equal(page.button.hidden, true)
    assert.equal(page.input.hidden, false)
    assert.equal(page.input.focused, 1)
    page.input.value = ' Beta '
    assert.equal(page.input.fire('keydown', { key: 'Enter' }), 1)
    await settle()
    assert.equal(page.calls.length, 0)
    assert.equal(page.button.hidden, false)
    assert.equal(page.input.hidden, true)
    page.button.fire('click')
    page.input.fire('blur')
    await settle()
    assert.equal(page.calls.length, 0)
    assert.equal(page.input.hidden, true)
    // Leaving a field that is already closed sends nothing either.
    page.input.fire('blur')
    assert.equal(page.input.fire('keydown', { key: 'a' }), 0)
    assert.equal(page.calls.length, 0)
  })

  it('U20.7 Escape puts the name back and sends nothing', async () => {
    const page = namePage()
    startGroup(page.doc as unknown as GroupsDocument, page.deps)
    page.button.fire('click')
    page.input.value = 'Gamma'
    assert.equal(page.input.fire('keydown', { key: 'Escape' }), 1)
    page.input.fire('blur')
    await settle()
    assert.equal(page.calls.length, 0)
    assert.equal(page.input.value, 'Beta')
    assert.equal(page.input.hidden, true)
    assert.equal(page.button.hidden, false)
  })

  it('U20.8 a new name is PUT, and the row, the heading and the title show it', async () => {
    const page = namePage()
    startGroup(page.doc as unknown as GroupsDocument, page.deps)
    page.button.fire('click')
    page.input.value = '  Gamma testers '
    page.answers.push(
      reply(200, { id: 5, name: 'Gamma testers', apps: [], members: [] }),
    )
    page.input.fire('keydown', { key: 'Enter' })
    // The blur that follows while the save runs sends nothing more.
    page.input.fire('blur')
    await settle()
    assert.equal(page.calls.length, 1)
    assert.equal(page.calls[0]!.url, '/api/v2/groups/5')
    assert.equal(page.calls[0]!.init.method, 'PUT')
    assert.equal(
      (page.calls[0]!.init.headers as Record<string, string>)['x-mason-csrf'],
      'proof',
    )
    assert.deepEqual(JSON.parse(String(page.calls[0]!.init.body)), {
      name: 'Gamma testers',
    })
    assert.equal(page.text.textContent, 'Gamma testers')
    assert.deepEqual(
      page.titles.map((title) => title.textContent),
      ['Gamma testers', 'Gamma testers'],
    )
    assert.equal(page.doc.title, 'Gamma testers · Mason')
    assert.equal(page.button.hidden, false)
    assert.equal(page.input.hidden, true)
    // Opening it again starts from the saved name.
    page.button.fire('click')
    assert.equal(page.input.value, 'Gamma testers')
  })

  it('U20.9 a refused name keeps the field up with the master’s message', async () => {
    const page = namePage()
    startGroup(page.doc as unknown as GroupsDocument, page.deps)
    page.button.fire('click')
    page.input.value = 'Alpha'
    page.answers.push(reply(409, { error: 'A group with that name exists' }))
    page.input.fire('blur')
    await settle()
    assert.equal(page.calls.length, 1)
    assert.equal(page.input.hidden, false)
    assert.equal(page.button.hidden, true)
    assert.equal(page.error.hidden, false)
    assert.equal(page.error.textContent, 'A group with that name exists')
    assert.equal(page.text.textContent, 'Beta')
    // Leaving the field again does not resend the same name; Enter does.
    page.input.fire('blur')
    await settle()
    assert.equal(page.calls.length, 1)
    page.answers.push(reply(409, { error: 'A group with that name exists' }))
    page.input.fire('keydown', { key: 'Enter' })
    await settle()
    assert.equal(page.calls.length, 2)
    assert.deepEqual(JSON.parse(String(page.calls[1]!.init.body)), {
      name: 'Alpha',
    })
    page.input.value = ''
    page.answers.push(reply(400, { error: 'Invalid text' }))
    page.input.fire('keydown', { key: 'Enter' })
    await settle()
    assert.deepEqual(JSON.parse(String(page.calls[2]!.init.body)), {
      name: '',
    })
    assert.equal(page.error.textContent, 'Invalid text')
    // Escape clears the message and puts the name back.
    page.input.fire('keydown', { key: 'Escape' })
    assert.equal(page.error.hidden, true)
    assert.equal(page.error.textContent, '')
    assert.equal(page.input.value, 'Beta')
  })

  it('U20.16 opening the name clears an old message; while a save is on its way the field stays open, read-only', async () => {
    const page = namePage()
    startGroup(page.doc as unknown as GroupsDocument, page.deps)
    // A stale message left on the row is cleared when the field opens.
    page.error.hidden = false
    page.error.textContent = 'old message'
    page.button.fire('click')
    assert.equal(page.error.hidden, true)
    assert.equal(page.error.textContent, '')
    const answers: Array<(response: Response) => void> = []
    page.deps.fetch = async (url, init): Promise<Response> => {
      page.calls.push({ url, init })
      return await new Promise<Response>((resolve) => {
        answers.push(resolve)
      })
    }
    /** Enter "Alpha", then Escape, the button, "Gamma" and Enter before the answer. */
    const race = (): void => {
      page.input.value = 'Alpha'
      page.input.fire('keydown', { key: 'Enter' })
      assert.equal(page.input.readOnly, true)
      assert.equal(page.error.hidden, false)
      assert.equal(page.error.textContent, 'Saving…')
      assert.equal(page.input.fire('keydown', { key: 'Escape' }), 1)
      assert.equal(page.input.hidden, false)
      assert.equal(page.button.hidden, true)
      page.button.fire('click')
      assert.equal(page.input.value, 'Alpha')
      page.input.fire('keydown', { key: 'Enter' })
      page.input.fire('blur')
    }
    // Refused: the field stays open on the name it sent, editable, with the message.
    race()
    answers.shift()!(reply(409, { error: 'A group with that name exists' }))
    await settle()
    assert.equal(page.calls.length, 1)
    assert.equal(page.input.hidden, false)
    assert.equal(page.input.readOnly, false)
    assert.equal(page.input.value, 'Alpha')
    assert.equal(page.error.textContent, 'A group with that name exists')
    assert.equal(page.text.textContent, 'Beta')
    // Now Escape closes it, and "Gamma" is a save of its own.
    page.input.fire('keydown', { key: 'Escape' })
    assert.equal(page.input.hidden, true)
    page.button.fire('click')
    page.input.value = 'Gamma'
    page.input.fire('keydown', { key: 'Enter' })
    await settle()
    assert.deepEqual(JSON.parse(String(page.calls[1]!.init.body)), {
      name: 'Gamma',
    })
    answers.shift()!(reply(409, { error: 'A group with that name exists' }))
    await settle()
    page.input.fire('keydown', { key: 'Escape' })
    // Saved: the row shows the name sent, and the field closes then.
    page.button.fire('click')
    race()
    answers.shift()!(
      reply(200, { id: 5, name: 'Alpha', apps: [], members: [] }),
    )
    await settle()
    assert.equal(page.calls.length, 3)
    assert.equal(page.text.textContent, 'Alpha')
    assert.equal(page.input.hidden, true)
    assert.equal(page.input.readOnly, false)
    assert.equal(page.button.hidden, false)
    assert.equal(page.error.hidden, true)
    page.button.fire('click')
    assert.equal(page.input.value, 'Alpha')
  })

  it('U20.10 an answer without JSON names the status; other pages are left alone', async () => {
    const put = groupClient(
      { fetch: async () => reply(502, '') },
      '/api/v2/groups/5',
      '',
    )
    await assert.rejects(put({ name: 'x' }), /The master answered 502/)
    const broken = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('not JSON')
      },
    } as unknown as Response
    await assert.rejects(
      groupClient({ fetch: async () => broken }, '/x', '')({}),
      /The master answered 200/,
    )
    // A page with no group, and a group page without the name editor.
    const silent: GroupsDeps = {
      fetch: async (): Promise<Response> => {
        throw new Error('nothing is sent')
      },
    }
    startGroup(new Doc() as unknown as GroupsDocument, silent)
    const readOnly = new Doc().set('[data-group]', new El())
    startGroup(readOnly as unknown as GroupsDocument, silent)
  })

  const apps: GroupApp[] = [
    { id: 9, name: 'Old Harbor', slug: 'app.scratch.old', enabled: false },
    { id: 1, name: 'Harbor Wallet', slug: 'app.scratch.harbor', enabled: true },
    { id: 2, name: 'Lantern Maps', slug: 'app.scratch.lantern', enabled: true },
    {
      id: 3,
      name: 'Orchard Notes',
      slug: 'app.scratch.orchard',
      enabled: true,
    },
    { id: 4, name: 'Harbor Pilot', slug: 'app.scratch.pilot', enabled: true },
  ]
  const people: GroupPerson[] = [
    {
      id: 1,
      name: 'Quill Ravensworth',
      email: 'quill@groups.test',
      addresses: {},
    },
    {
      id: 2,
      name: 'Mirela Tondbury',
      email: 'mirela.tondbury@groups.test',
      addresses: { google: 'mt@gmail.example' },
    },
    { id: 5, name: 'Osric <P>', addresses: { github: 'osric@hub.example' } },
    { id: 6, name: 'No Address', addresses: {} },
  ]

  it('U20.13 the picker lists the first three, or every case-insensitive match', () => {
    const names = (items: Array<{ name: string }>): string[] =>
      items.map((item) => item.name)
    // An empty query: the first three enabled apps, or the first three people.
    assert.deepEqual(names(pickerChoices('apps', apps, '  ')), [
      'Harbor Wallet',
      'Lantern Maps',
      'Orchard Notes',
    ])
    assert.deepEqual(names(pickerChoices('members', people, '')), [
      'Quill Ravensworth',
      'Mirela Tondbury',
      'Osric <P>',
    ])
    assert.deepEqual(names(pickerChoices('members', people.slice(0, 2), '')), [
      'Quill Ravensworth',
      'Mirela Tondbury',
    ])
    // A query has no cap, keeps catalog order, and finds disabled apps too.
    assert.deepEqual(names(pickerChoices('apps', apps, ' HARBOR ')), [
      'Old Harbor',
      'Harbor Wallet',
      'Harbor Pilot',
    ])
    assert.deepEqual(names(pickerChoices('apps', apps, 'scratch.orch')), [
      'Orchard Notes',
    ])
    assert.equal(pickerChoices('apps', apps, 'a').length, 5)
    assert.deepEqual(pickerChoices('apps', apps, 'zzz'), [])
    // People match name, email and address values, not a method's ID.
    assert.deepEqual(names(pickerChoices('members', people, 'ravens')), [
      'Quill Ravensworth',
    ])
    assert.deepEqual(names(pickerChoices('members', people, 'TONDBURY@')), [
      'Mirela Tondbury',
    ])
    assert.deepEqual(names(pickerChoices('members', people, 'gmail')), [
      'Mirela Tondbury',
    ])
    assert.deepEqual(names(pickerChoices('members', people, 'hub.ex')), [
      'Osric <P>',
    ])
    assert.deepEqual(pickerChoices('members', people, 'google'), [])
    assert.deepEqual(pickerChoices('members', people, 'github'), [])
    // A choice: the label on the left, the checkbox on the right.
    assert.equal(
      choiceRow('apps', apps[4]!, true),
      '<label class="check"><span><strong>Harbor Pilot</strong><small class="mono">app.scratch.pilot</small></span><input type="checkbox" value="4" data-group-choice checked></label>',
    )
    assert.equal(
      choiceRow('members', people[2]!, false),
      '<label class="check"><span><strong>Osric &lt;P&gt;</strong><small>osric@hub.example</small></span><input type="checkbox" value="5" data-group-choice></label>',
    )
    assert.equal(
      choiceRow('members', people[3]!, false),
      '<label class="check"><span><strong>No Address</strong></span><input type="checkbox" value="6" data-group-choice></label>',
    )
  })

  /** A group page with both pickers over the catalog above. */
  function pickerPage(group: GroupCatalog['group']): {
    sections: Record<'apps' | 'members', Record<string, El>>
    calls: Call[]
    answers: Response[]
    deps: GroupsDeps
    doc: Doc
  } {
    const page = namePage()
    const pageEl = page.doc.querySelector('[data-group]')!
    const sections = {} as Record<'apps' | 'members', Record<string, El>>
    for (const kind of ['apps', 'members'] as const) {
      const parts: Record<string, El> = {}
      const section = new El()
      for (const name of [
        'add',
        'picker',
        'query',
        'done',
        'choices',
        'error',
        'rows',
      ]) {
        parts[name] = new El()
        section.set(`[data-group-${name}]`, parts[name])
      }
      parts.picker!.hidden = true
      parts.error!.hidden = true
      parts.section = section
      sections[kind] = parts
      pageEl.set(`[data-group-section="${kind}"]`, section)
    }
    const catalog = new El()
    catalog.textContent = JSON.stringify({ apps, people, group })
    page.doc.set('[data-group-catalog]', catalog)
    startGroup(page.doc as unknown as GroupsDocument, page.deps)
    return { ...page, sections }
  }
  const box = (id: number, checked: boolean): El => {
    const element = new El()
    element.dataset.groupChoice = ''
    element.value = String(id)
    element.checked = checked
    return element
  }
  const labels = (html: string): Array<[string, boolean]> =>
    [
      ...html.matchAll(
        /<strong>([^<]*)<\/strong>.*?value="\d+" data-group-choice( checked)?>/g,
      ),
    ].map((match) => [match[1]!, match[2] != null])

  it('U20.14 Add App opens the picker, filters it, and each checkbox PUTs the apps at once', async () => {
    const page = pickerPage({ apps: [9], members: [] })
    const app = page.sections.apps
    app.add!.fire('click')
    assert.equal(app.picker!.hidden, false)
    assert.equal(app.query!.focused, 1)
    assert.deepEqual(labels(app.choices!.innerHTML), [
      ['Harbor Wallet', false],
      ['Lantern Maps', false],
      ['Orchard Notes', false],
    ])
    // The disabled app in the group appears, checked, when the query matches it.
    app.query!.value = 'harbor'
    app.query!.fire('input')
    assert.deepEqual(labels(app.choices!.innerHTML), [
      ['Old Harbor', true],
      ['Harbor Wallet', false],
      ['Harbor Pilot', false],
    ])
    // Checking adds the app: the full list in catalog order, and its row.
    const pilot = box(4, true)
    page.answers.push(
      reply(200, {
        id: 5,
        name: 'Beta',
        apps: [{ id: 9 }, { id: 4 }],
        members: [],
      }),
    )
    app.choices!.fire('change', { target: pilot })
    await settle()
    assert.equal(page.calls.length, 1)
    assert.equal(page.calls[0]!.init.method, 'PUT')
    assert.deepEqual(JSON.parse(String(page.calls[0]!.init.body)), {
      apps: [9, 4],
    })
    assert.match(
      app.rows!.innerHTML,
      /<li data-id="9">.*<li data-id="4"><div><strong>Harbor Pilot<\/strong><small class="mono">app\.scratch\.pilot/,
    )
    assert.equal(app.picker!.hidden, false)
    assert.equal(app.query!.value, 'harbor')
    // Clearing removes it.
    pilot.checked = false
    page.answers.push(
      reply(200, { id: 5, name: 'Beta', apps: [{ id: 9 }], members: [] }),
    )
    app.choices!.fire('change', { target: pilot })
    await settle()
    assert.deepEqual(JSON.parse(String(page.calls[1]!.init.body)), {
      apps: [9],
    })
    assert.doesNotMatch(app.rows!.innerHTML, /Harbor Pilot/)
    // A refused change puts the checkbox back and shows the message.
    const wallet = box(1, true)
    app.choices!.set('input[data-group-choice]', wallet)
    page.answers.push(reply(400, { error: 'No app with ID 1' }))
    app.choices!.fire('change', { target: wallet })
    await settle()
    assert.equal(wallet.checked, false)
    assert.equal(app.error!.hidden, false)
    assert.equal(app.error!.textContent, 'No app with ID 1')
    assert.doesNotMatch(app.rows!.innerHTML, /Harbor Wallet/)
    // The next change that works clears the message.
    page.answers.push(
      reply(200, {
        id: 5,
        name: 'Beta',
        apps: [{ id: 9 }, { id: 1 }],
        members: [],
      }),
    )
    app.choices!.fire('change', { target: box(1, true) })
    await settle()
    assert.equal(app.error!.hidden, true)
    // A change from something that is not a choice is ignored.
    app.choices!.fire('change', { target: new El() })
    app.choices!.fire('change', {})
    await settle()
    assert.equal(page.calls.length, 4)
    // Nothing matches; then Done closes the picker and sends nothing.
    app.query!.value = 'nothing like it'
    app.query!.fire('input')
    assert.match(app.choices!.innerHTML, /Nothing matches\./)
    app.done!.fire('click')
    assert.equal(app.picker!.hidden, true)
    assert.equal(app.query!.value, '')
    assert.equal(app.choices!.innerHTML, '')
    assert.equal(page.calls.length, 4)
    // Opening it again starts from the saved apps.
    app.add!.fire('click')
    assert.deepEqual(labels(app.choices!.innerHTML), [
      ['Harbor Wallet', true],
      ['Lantern Maps', false],
      ['Orchard Notes', false],
    ])
  })

  it('U20.15 Add member filters on an email and adds the person; changes go one at a time', async () => {
    const page = pickerPage({ apps: [], members: [1] })
    const members = page.sections.members
    members.add!.fire('click')
    assert.deepEqual(labels(members.choices!.innerHTML), [
      ['Quill Ravensworth', true],
      ['Mirela Tondbury', false],
      ['Osric &lt;P&gt;', false],
    ])
    members.query!.value = 'tondbury@'
    members.query!.fire('input')
    assert.deepEqual(labels(members.choices!.innerHTML), [
      ['Mirela Tondbury', false],
    ])
    // Two quick checks: the second starts from the first's saved list.
    page.answers.push(
      reply(200, { id: 5, name: 'Beta', apps: [], members: [1, 2] }),
      reply(200, { id: 5, name: 'Beta', apps: [], members: [1, 2, 6] }),
    )
    members.choices!.fire('change', { target: box(2, true) })
    members.choices!.fire('change', { target: box(6, true) })
    await settle()
    assert.deepEqual(
      page.calls.map((call) => JSON.parse(String(call.init.body))),
      [{ members: [1, 2] }, { members: [1, 2, 6] }],
    )
    assert.match(
      members.rows!.innerHTML,
      /<li data-id="2"><div><strong>Mirela Tondbury<\/strong><small>mirela\.tondbury@groups\.test<\/small>/,
    )
    assert.match(
      members.rows!.innerHTML,
      /<li data-id="6"><div><strong>No Address<\/strong><\/div>/,
    )
    members.done!.fire('click')
    assert.equal(members.picker!.hidden, true)
    assert.match(members.rows!.innerHTML, /Mirela Tondbury/)
    // The apps section is untouched.
    assert.equal(page.sections.apps.rows!.innerHTML, '')
    // A section without its controls, and a page without one, are left alone.
    const bare = namePage()
    bare.doc
      .querySelector('[data-group]')!
      .set('[data-group-section="apps"]', new El())
    const catalog = new El()
    catalog.textContent = JSON.stringify({
      apps,
      people,
      group: { apps: [], members: [] },
    })
    bare.doc.set('[data-group-catalog]', catalog)
    startGroup(bare.doc as unknown as GroupsDocument, bare.deps)
    assert.equal(bare.calls.length, 0)
  })

  /** Answers to PUTs that the test settles one at a time. */
  const deferred = (
    page: ReturnType<typeof pickerPage>,
  ): Array<(response: Response) => void> => {
    const settles: Array<(response: Response) => void> = []
    page.deps.fetch = async (url, init): Promise<Response> => {
      page.calls.push({ url, init })
      return await new Promise<Response>((resolve) => {
        settles.push(resolve)
      })
    }
    return settles
  }

  it('U20.17 a query typed while a change is saving shows the membership the master holds', async () => {
    const page = pickerPage({ apps: [], members: [1] })
    const settles = deferred(page)
    const members = page.sections.members
    members.add!.fire('click')
    // Check Mirela, then type before the master answers: the redrawn list
    // shows the change asked for, and the box on screen matches the answer.
    members.choices!.fire('change', { target: box(2, true) })
    members.query!.value = 'mirela'
    members.query!.fire('input')
    assert.deepEqual(labels(members.choices!.innerHTML), [
      ['Mirela Tondbury', true],
    ])
    const visible = box(2, true)
    members.choices!.set('input[data-group-choice]', visible)
    await settle()
    settles.shift()!(
      reply(200, { id: 5, name: 'Beta', apps: [], members: [1, 2] }),
    )
    await settle()
    assert.equal(visible.checked, true)
    assert.match(members.rows!.innerHTML, /Mirela Tondbury/)
    members.query!.fire('input')
    assert.deepEqual(labels(members.choices!.innerHTML), [
      ['Mirela Tondbury', true],
    ])
    // Clear her, retype, and the master refuses: the box on screen is checked again.
    members.choices!.fire('change', { target: box(2, false) })
    members.query!.value = 'tondbury'
    members.query!.fire('input')
    assert.deepEqual(labels(members.choices!.innerHTML), [
      ['Mirela Tondbury', false],
    ])
    const redrawn = box(2, false)
    members.choices!.set('input[data-group-choice]', redrawn)
    await settle()
    settles.shift()!(reply(403, { error: 'Not allowed for the tester role' }))
    await settle()
    assert.equal(redrawn.checked, true)
    assert.equal(members.error!.textContent, 'Not allowed for the tester role')
    assert.match(members.rows!.innerHTML, /Mirela Tondbury/)
    members.query!.fire('input')
    assert.deepEqual(labels(members.choices!.innerHTML), [
      ['Mirela Tondbury', true],
    ])
    assert.equal(page.calls.length, 2)
  })

  it('U20.18 messages: cleared when a picker opens, shown under the section when a change fails after Done', async () => {
    const page = pickerPage({ apps: [], members: [1] })
    const settles = deferred(page)
    const members = page.sections.members
    members.error!.hidden = false
    members.error!.textContent = 'old message'
    members.add!.fire('click')
    assert.equal(members.error!.hidden, true)
    assert.equal(members.error!.textContent, '')
    members.choices!.fire('change', { target: box(5, true) })
    members.done!.fire('click')
    assert.equal(members.picker!.hidden, true)
    await settle()
    settles.shift()!(reply(400, { error: 'No person with ID 5' }))
    await settle()
    assert.equal(members.error!.hidden, false)
    assert.equal(members.error!.textContent, 'No person with ID 5')
    assert.doesNotMatch(members.rows!.innerHTML, /Osric/)
    // Opening the picker again clears it, and the box shows the saved state.
    members.add!.fire('click')
    assert.equal(members.error!.hidden, true)
    assert.deepEqual(labels(members.choices!.innerHTML), [
      ['Quill Ravensworth', true],
      ['Mirela Tondbury', false],
      ['Osric &lt;P&gt;', false],
    ])
  })

  it('U20.19 a change keeps members the page’s catalog does not list', async () => {
    const page = pickerPage({ apps: [], members: [1, 99] })
    const members = page.sections.members
    members.add!.fire('click')
    page.answers.push(
      reply(200, { id: 5, name: 'Beta', apps: [], members: [1, 2, 99] }),
      reply(200, { id: 5, name: 'Beta', apps: [], members: [2, 99] }),
    )
    members.choices!.fire('change', { target: box(2, true) })
    members.choices!.fire('change', { target: box(1, false) })
    await settle()
    assert.deepEqual(
      page.calls.map((call) => JSON.parse(String(call.init.body))),
      [{ members: [1, 99, 2] }, { members: [2, 99] }],
    )
    // Rows list only those the page knows.
    assert.match(members.rows!.innerHTML, /^<li data-id="2">[^]*<\/li>$/)
    assert.doesNotMatch(members.rows!.innerHTML, /data-id="99"/)
  })

  it('U20.20 a refused change’s message outlasts Done and a different item’s success', async () => {
    const page = pickerPage({ apps: [], members: [1] })
    const settles = deferred(page)
    const members = page.sections.members
    members.add!.fire('click')
    // P2 is refused, then P3 succeeds: P2's message stays.
    members.choices!.fire('change', { target: box(2, true) })
    members.choices!.fire('change', { target: box(5, true) })
    await settle()
    settles.shift()!(reply(400, { error: 'No person with ID 2' }))
    await settle()
    settles.shift()!(
      reply(200, { id: 5, name: 'Beta', apps: [], members: [1, 5] }),
    )
    await settle()
    assert.equal(members.error!.hidden, false)
    assert.equal(members.error!.textContent, 'No person with ID 2')
    assert.match(members.rows!.innerHTML, /Osric/)
    // Done keeps it.
    members.done!.fire('click')
    assert.equal(members.picker!.hidden, true)
    assert.equal(members.error!.hidden, false)
    assert.equal(members.error!.textContent, 'No person with ID 2')
    // Reopening clears it; a retry of P2 that succeeds would too.
    members.add!.fire('click')
    assert.equal(members.error!.hidden, true)
    members.choices!.fire('change', { target: box(2, true) })
    await settle()
    settles.shift()!(reply(400, { error: 'No person with ID 2' }))
    await settle()
    assert.equal(members.error!.textContent, 'No person with ID 2')
    members.choices!.fire('change', { target: box(2, true) })
    await settle()
    settles.shift()!(
      reply(200, { id: 5, name: 'Beta', apps: [], members: [1, 2, 5] }),
    )
    await settle()
    assert.equal(members.error!.hidden, true)
    assert.equal(members.error!.textContent, '')
  })
})
