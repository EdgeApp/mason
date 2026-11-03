import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import {
  groupClient,
  startGroup,
  type GroupsDeps,
  type GroupsDocument,
  type GroupsEvent,
} from './groups.js'

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
})
