import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import {
  editableText,
  fileContents,
  secretsClient,
  startSecrets,
  textContents,
  toBase64,
  type SecretsEvent,
} from './secrets.js'
import { MAX_FILE } from '../pipeline/variants.js'

/** An element whose queries answer from a table of selectors. */
class El {
  children = new Map<string, El[]>()
  listeners = new Map<string, Array<(event: SecretsEvent) => void>>()
  dataset: Record<string, string | undefined> = {}
  classes = new Set<string>()
  hidden = true
  value = ''
  type = ''
  disabled = false
  required = false
  checked = false
  textContent: string | null = ''
  files: Array<Blob & { name: string }> | null = null
  content?: string
  clicked = 0
  focused = 0
  resets = 0
  get classList(): {
    add: (name: string) => void
    remove: (name: string) => void
  } {
    return {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
    }
  }
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
  addEventListener(
    type: string,
    listener: (event: SecretsEvent) => void,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  fire(type: string, event: Partial<SecretsEvent> = {}): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ preventDefault: () => undefined, ...event })
  }
  click(): void {
    this.clicked++
  }
  focus(): void {
    this.focused++
  }
  reset(): void {
    this.resets++
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setImmediate(resolve))
}
const reply = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }) as unknown as Response
const file = (
  name: string,
  bytes: Uint8Array<ArrayBuffer> | number,
): Blob & { name: string } =>
  Object.assign(
    typeof bytes === 'number'
      ? ({ size: bytes, arrayBuffer: async () => new ArrayBuffer(0) } as Blob)
      : new Blob([bytes]),
    { name },
  )

/** A Secrets tab: a value row, a text-file row, a binary row, the add forms and the editor. */
function page(): {
  doc: El
  panel: El
  rows: Record<'value' | 'text' | 'binary', Record<string, El>>
  editor: Record<string, El>
  forms: Record<'value' | 'file', Record<string, El>>
  picker: El
  calls: Array<{ url: string; init: RequestInit }>
  answers: Response[]
  reloads: () => number
  confirms: string[]
  confirmAnswer: { value: boolean }
  start: () => void
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const answers: Response[] = []
  let reloads = 0
  const confirms: string[] = []
  const confirmAnswer = { value: true }
  const row = (
    id: string,
    kind: string,
    text: string,
    name: string,
    configs: string,
  ): Record<string, El> => {
    const parts: Record<string, El> = {}
    for (const key of [
      'output',
      'view',
      'editing',
      'value',
      'pills',
      'configs',
      'edit',
      'replace',
      'save',
      'cancel',
      'delete',
      'pill',
    ])
      parts[key] = new El()
    parts.view!.hidden = false
    parts.pills!.hidden = false
    const element = new El()
      .set('[data-secret-output]', parts.output!)
      .set('[data-secret-view]', parts.view!)
      .set('[data-secret-editing]', parts.editing!)
      .set('[data-secret-value]', parts.value!)
      .set('[data-secret-pills]', parts.pills!)
      .set('[data-secret-configs-input]', parts.configs!)
      .set('[data-secret-pill]', parts.pill!)
      .set('[data-secret-save]', parts.save!)
      .set('[data-secret-cancel]', parts.cancel!)
      .set('[data-secret-delete]', parts.delete!)
    if (kind === 'file' && text === '0')
      element.set('[data-secret-replace]', parts.replace!)
    else element.set('[data-secret-edit]', parts.edit!)
    element.dataset = { secretId: id, kind, text, name, configs }
    parts.row = element
    return parts
  }
  const rows = {
    value: row('1', 'value', '1', 'API_TOKEN', 'develop'),
    text: row('2', 'file', '1', 'config.json', ''),
    binary: row('3', 'file', '0', 'release.jks', ''),
  }
  const editor: Record<string, El> = {}
  for (const key of [
    'root',
    'title',
    'configs',
    'text',
    'save',
    'cancel',
    'output',
  ])
    editor[key] = new El()
  editor
    .root!.set('[data-secret-editor-title]', editor.title!)
    .set('[data-secret-editor-configs]', editor.configs!)
    .set('[data-secret-editor-text]', editor.text!)
    .set('[data-secret-editor-save]', editor.save!)
    .set('[data-secret-editor-cancel]', editor.cancel!)
    .set('[data-secret-editor-output]', editor.output!)
  const forms = {} as Record<'value' | 'file', Record<string, El>>
  for (const kind of ['value', 'file'] as const) {
    const parts: Record<string, El> = {}
    for (const key of [
      'form',
      'name',
      'configs',
      'value',
      'text',
      'masked',
      'pathEnv',
      'output',
      'cancel',
      'submit',
      'drop',
      'picker',
      'chosen',
      'button',
    ])
      parts[key] = new El()
    parts.button!.dataset.secretAdd = kind
    parts
      .form!.set('[name="name"]', parts.name!)
      .set('[name="configs"]', parts.configs!)
      .set('[data-secret-output]', parts.output!)
      .set('[data-secret-add-cancel]', parts.cancel!)
      .set('button:not([type])', parts.submit!)
    if (kind === 'value') {
      parts.show = new El()
      parts.lines = new El()
      parts.reveal = new El()
      parts.value!.type = 'password'
      parts.value!.hidden = false
      parts.value!.required = true
      parts.reveal.hidden = false
      parts
        .form!.set('[name="value"]', parts.value!)
        .set('[name="masked"]', parts.masked!)
        .set('[data-secret-show]', parts.show)
        .set('[data-secret-value-lines]', parts.lines)
        .set('[data-secret-reveal]', parts.reveal)
    } else
      parts
        .form!.set('[name="text"]', parts.text!)
        .set('[name="pathEnv"]', parts.pathEnv!)
        .set('[data-secret-drop]', parts.drop!)
        .set('[data-secret-add-file]', parts.picker!)
        .set('[data-secret-chosen]', parts.chosen!)
    forms[kind] = parts
  }
  const picker = new El()
  const panel = new El()
    .set('[data-secret-id]', rows.value.row!, rows.text.row!, rows.binary.row!)
    .set('[data-secret-id="1"]', rows.value.row!)
    .set('[data-secret-id="3"]', rows.binary.row!)
    .set('[data-secret-file]', picker)
    .set('[data-secret-add-form="value"]', forms.value.form!)
    .set('[data-secret-add-form="file"]', forms.file.form!)
    .set('[data-secret-add]', forms.value.button!, forms.file.button!)
  panel.dataset.secrets = '/api/v2/projects/demo/secrets'
  const csrf = new El()
  csrf.content = 'proof'
  const doc = new El()
    .set('[data-secrets]', panel)
    .set('meta[name="mason-csrf"]', csrf)
    .set('[data-secret-editor]', editor.root!)
    .set('[data-secret-id="2"] [data-secret-output]', rows.text.output!)
  return {
    doc,
    panel,
    rows,
    editor,
    forms,
    picker,
    calls,
    answers,
    reloads: () => reloads,
    confirms,
    confirmAnswer,
    start: () =>
      startSecrets(doc, {
        fetch: async (url, init) => {
          calls.push({ url, init })
          return answers.shift() ?? reply(200, null)
        },
        confirm: (text) => {
          confirms.push(text)
          return confirmAnswer.value
        },
        reload: () => {
          reloads++
        },
      }),
  }
}

describe('Secrets tab script', () => {
  it('U18.13 encodes bytes and text as base64 and refuses more than 5 MiB', async () => {
    assert.equal(toBase64(new Uint8Array([0, 255, 1])), 'AP8B')
    const big = new Uint8Array(0x8000 * 2 + 3).fill(65)
    assert.equal(toBase64(big), Buffer.from(big).toString('base64'))
    assert.equal(
      textContents('{"é":1}'),
      Buffer.from('{"é":1}').toString('base64'),
    )
    assert.throws(() => textContents('x'.repeat(MAX_FILE + 1)), /over 5 MiB/)
    assert.equal(await fileContents(new Blob([new Uint8Array([1, 2])])), 'AQI=')
    await assert.rejects(fileContents(file('big', MAX_FILE + 1)), /over 5 MiB/)
  })

  it('U18.13 the client sends the CSRF proof and surfaces the master’s error', async () => {
    const calls: RequestInit[] = []
    const answers = [
      reply(200, { ok: 1 }),
      reply(409, { error: 'No' }),
      reply(500, undefined),
      {
        ok: false,
        status: 502,
        text: async () => 'not json',
      } as unknown as Response,
    ]
    const api = secretsClient(
      {
        fetch: async (_url, init) => {
          calls.push(init)
          return answers.shift()!
        },
        confirm: () => true,
        reload: () => undefined,
      },
      '/base',
      'proof',
    )
    assert.deepEqual(await api('PUT', '/1', { value: 'v' }), { ok: 1 })
    assert.deepEqual(calls[0]!.headers, {
      'x-mason-csrf': 'proof',
      'content-type': 'application/json',
    })
    assert.equal(calls[0]!.body, '{"value":"v"}')
    await assert.rejects(api('GET', '/1'), /^Error: No$/)
    await assert.rejects(api('GET', '/1'), /answered 500/)
    await assert.rejects(api('GET', '/1'), /answered 502/)
    assert.deepEqual(calls[1]!.headers, { 'x-mason-csrf': 'proof' })
  })

  it('U18.13 a value edits inline: Edit fetches it, Save sends it, Cancel restores the row', async () => {
    const p = page()
    p.start()
    const r = p.rows.value
    p.answers.push(reply(200, { value: 'v-1' }))
    r.edit!.fire('click')
    await settle()
    assert.equal(p.calls[0]!.url, '/api/v2/projects/demo/secrets/1')
    assert.equal(p.calls[0]!.init.method, 'GET')
    assert.equal(r.value!.value, 'v-1')
    assert.deepEqual(
      [r.value!.hidden, r.view!.hidden, r.editing!.hidden],
      [false, true, false],
    )
    // Cancel: the row comes back, with nothing sent.
    r.cancel!.fire('click')
    assert.deepEqual(
      [r.value!.hidden, r.view!.hidden, r.editing!.hidden, r.value!.value],
      [true, false, true, ''],
    )
    assert.equal(p.calls.length, 1)
    p.answers.push(reply(200, { value: 'v-1' }), reply(200, {}))
    r.edit!.fire('click')
    await settle()
    r.value!.value = 'v-2'
    r.save!.fire('click')
    await settle()
    assert.equal(p.calls[2]!.init.method, 'PUT')
    assert.equal(p.calls[2]!.init.body, '{"value":"v-2"}')
    assert.equal(p.reloads(), 1)
    // A refused save shows why in the row.
    p.answers.push(
      reply(502, { error: 'Not saved: the backup could not be pushed (x)' }),
    )
    r.save!.fire('click')
    await settle()
    assert.match(r.output!.textContent!, /^Not saved/)
    // A refused view, too.
    p.answers.push(reply(403, { error: 'Not allowed for the developer role' }))
    r.edit!.fire('click')
    await settle()
    assert.match(r.output!.textContent!, /Not allowed/)
  })

  it('U18.13 the pills edit as one comma-separated field', async () => {
    const p = page()
    p.start()
    const r = p.rows.value
    r.pill!.fire('click')
    assert.equal(r.configs!.value, 'develop')
    assert.deepEqual([r.configs!.hidden, r.pills!.hidden], [false, true])
    r.configs!.value = 'develop, maestro'
    r.save!.fire('click')
    await settle()
    assert.equal(p.calls[0]!.url, '/api/v2/projects/demo/secrets/1/configs')
    assert.equal(p.calls[0]!.init.body, '{"configs":"develop, maestro"}')
    assert.equal(p.reloads(), 1)
  })

  it('U18.13 a text file opens the editor; Save sends the text; Cancel and Escape close it', async () => {
    const p = page()
    p.start()
    p.answers.push(reply(200, { text: '{"a":1}\n' }))
    p.rows.text.edit!.fire('click')
    await settle()
    assert.equal(p.editor.root!.hidden, false)
    assert.equal(p.editor.title!.textContent, 'config.json')
    assert.equal(p.editor.configs!.textContent, 'all')
    assert.equal(p.editor.text!.value, '{"a":1}\n')
    p.editor.text!.value = '{"a":2}\n'
    p.editor.save!.fire('click')
    await settle()
    assert.equal(p.calls[1]!.url, '/api/v2/projects/demo/secrets/2')
    assert.equal(p.calls[1]!.init.body, '{"text":"{\\"a\\":2}\\n"}')
    assert.equal(p.reloads(), 1)
    p.doc.fire('keydown', { key: 'Escape' })
    assert.deepEqual([p.editor.root!.hidden, p.editor.text!.value], [true, ''])
    p.editor.save!.fire('click')
    p.doc.fire('keydown', { key: 'Escape' })
    p.answers.push(reply(200, { text: 'x' }))
    p.rows.text.edit!.fire('click')
    await settle()
    p.editor.cancel!.fire('click')
    assert.equal(p.editor.root!.hidden, true)
    assert.equal(p.calls.length, 3)
    // A refused view shows in the row.
    p.answers.push(reply(403, { error: 'Not allowed' }))
    p.rows.text.edit!.fire('click')
    await settle()
    assert.equal(p.rows.text.output!.textContent, 'Not allowed')
  })

  it('U18.13 a binary file is replaced with a chosen file; Delete asks first', async () => {
    const p = page()
    p.start()
    p.rows.binary.replace!.fire('click')
    assert.equal(p.picker.clicked, 1)
    p.picker.files = [file('new.jks', new Uint8Array([1, 2, 3]))]
    p.picker.fire('change')
    await settle()
    assert.equal(p.calls[0]!.url, '/api/v2/projects/demo/secrets/3/file')
    assert.equal(p.calls[0]!.init.body, '{"contents":"AQID"}')
    p.picker.files = [file('big.jks', MAX_FILE + 1)]
    p.picker.fire('change')
    await settle()
    assert.match(p.rows.binary.output!.textContent!, /over 5 MiB/)
    assert.equal(p.calls.length, 1)
    p.picker.files = []
    p.picker.fire('change')
    p.confirmAnswer.value = false
    p.rows.binary.delete!.fire('click')
    assert.deepEqual(p.confirms, ['Delete release.jks (all)?'])
    assert.equal(p.calls.length, 1)
    p.confirmAnswer.value = true
    p.rows.value.delete!.fire('click')
    await settle()
    assert.equal(p.confirms[1], 'Delete API_TOKEN (develop)?')
    assert.equal(p.calls[1]!.init.method, 'DELETE')
    assert.equal(p.calls[1]!.url, '/api/v2/projects/demo/secrets/1')
  })

  it('U18.13 adds a value, and a file dropped, chosen or pasted', async () => {
    const p = page()
    p.start()
    const value = p.forms.value
    const fileForm = p.forms.file
    value.button!.fire('click')
    assert.deepEqual([value.form!.hidden, fileForm.form!.hidden], [false, true])
    value.name!.value = 'API_TOKEN'
    value.configs!.value = 'beta'
    value.value!.value = 's3'
    value.masked!.checked = true
    value.form!.fire('submit')
    await settle()
    assert.equal(p.calls[0]!.init.method, 'POST')
    assert.equal(p.calls[0]!.url, '/api/v2/projects/demo/secrets')
    assert.deepEqual(JSON.parse(String(p.calls[0]!.init.body)), {
      kind: 'value',
      name: 'API_TOKEN',
      configs: 'beta',
      masked: true,
      value: 's3',
    })
    value.cancel!.fire('click')
    assert.equal(value.form!.hidden, true)
    assert.equal(value.form!.resets, 1)
    fileForm.button!.fire('click')
    assert.deepEqual([value.form!.hidden, fileForm.form!.hidden], [true, false])
    // Nothing to send.
    fileForm.form!.fire('submit')
    await settle()
    assert.match(fileForm.output!.textContent!, /Drop or choose a file/)
    // Pasted text, with a path variable.
    fileForm.text!.value = '{"k":1}'
    fileForm.name!.value = 'keys.json'
    fileForm.pathEnv!.value = 'KEYS_FILE'
    fileForm.form!.fire('submit')
    await settle()
    assert.deepEqual(JSON.parse(String(p.calls[1]!.init.body)), {
      kind: 'file',
      name: 'keys.json',
      configs: '',
      pathEnv: 'KEYS_FILE',
      contents: Buffer.from('{"k":1}').toString('base64'),
    })
    // A dropped file wins over the text, and names itself when the name is empty.
    fileForm.name!.value = ''
    fileForm.pathEnv!.value = ''
    fileForm.drop!.fire('dragover')
    assert(fileForm.drop!.classes.has('dragging'))
    fileForm.drop!.fire('dragleave')
    assert(!fileForm.drop!.classes.has('dragging'))
    fileForm.drop!.fire('drop', {
      dataTransfer: {
        files: [file('google-services.json', new Uint8Array([123, 125]))],
      },
    })
    assert.equal(fileForm.name!.value, 'google-services.json')
    assert.equal(fileForm.chosen!.textContent, 'google-services.json')
    fileForm.form!.fire('submit')
    await settle()
    assert.deepEqual(JSON.parse(String(p.calls[2]!.init.body)).contents, 'e30=')
    // Clicking the drop zone opens the picker; a chosen file keeps a typed name.
    fileForm.drop!.fire('click')
    assert.equal(fileForm.picker!.clicked, 1)
    fileForm.name!.value = 'typed.json'
    fileForm.picker!.files = [file('chosen.json', new Uint8Array([1]))]
    fileForm.picker!.fire('change')
    assert.equal(fileForm.name!.value, 'typed.json')
    fileForm.drop!.fire('drop', { dataTransfer: null })
    // Too big: refused before sending.
    fileForm.picker!.files = [file('huge.bin', MAX_FILE + 1)]
    fileForm.picker!.fire('change')
    fileForm.form!.fire('submit')
    await settle()
    assert.match(fileForm.output!.textContent!, /over 5 MiB/)
    assert.equal(p.calls.length, 3)
    fileForm.cancel!.fire('click')
    assert.equal(fileForm.chosen!.textContent, '')
    assert.equal(p.reloads(), 3)
  })

  it('U18.13 a late answer gives way to what was done meanwhile; a save disables its button until it fails; an answer of the wrong shape is reported', async () => {
    const p = page()
    p.start()
    const r = p.rows.value
    // Edit, then the pills (the controls still showing) before the value arrives: configs win.
    let answer = (_: Response): void => undefined
    const pending = new Promise<Response>((resolve) => {
      answer = resolve
    })
    p.answers.push(pending as unknown as Response)
    r.edit!.fire('click')
    r.pill!.fire('click')
    answer(reply(200, { value: 'late' }))
    await settle()
    assert.deepEqual(
      [r.value!.hidden, r.value!.value, r.configs!.hidden],
      [true, '', false],
    )
    r.cancel!.fire('click')
    // Save: disabled while it runs, enabled again when it fails.
    p.answers.push(reply(200, { value: 'v' }))
    r.edit!.fire('click')
    await settle()
    let release = (_: Response): void => undefined
    p.answers.push(
      new Promise<Response>((resolve) => {
        release = resolve
      }) as unknown as Response,
    )
    r.save!.fire('click')
    await settle()
    assert.equal(r.save!.disabled, true)
    release(reply(502, { error: 'Not saved' }))
    await settle()
    assert.equal(r.save!.disabled, false)
    // A view whose answer lacks the field it needs says so.
    p.answers.push(reply(200, { contents: 'AQI=' }))
    r.edit!.fire('click')
    await settle()
    assert.equal(r.output!.textContent, "The master's answer has no value")
    p.answers.push(reply(200, { value: 'x' }))
    p.rows.text.edit!.fire('click')
    await settle()
    assert.equal(
      p.rows.text.output!.textContent,
      "The master's answer has no text",
    )
    // The editor: given up with Escape before its text arrives, it stays closed.
    let late = (_: Response): void => undefined
    p.answers.push(
      new Promise<Response>((resolve) => {
        late = resolve
      }) as unknown as Response,
    )
    p.rows.text.edit!.fire('click')
    p.doc.fire('keydown', { key: 'Escape' })
    late(reply(200, { text: 'late' }))
    await settle()
    assert.equal(p.editor.root!.hidden, true)
  })

  it('U18.13 a save keeps the editor open until it ends, and every change disables its control while it runs', async () => {
    const p = page()
    p.start()
    const held = (): { response: Response; release: (r: Response) => void } => {
      let release = (_: Response): void => undefined
      const response = new Promise<Response>((resolve) => {
        release = resolve
      }) as unknown as Response
      return { response, release: (r) => release(r) }
    }
    // The editor's Save: Escape and Cancel wait for it; its refusal is shown.
    p.answers.push(reply(200, { text: '{}' }))
    p.rows.text.edit!.fire('click')
    await settle()
    const save = held()
    p.answers.push(save.response)
    p.editor.save!.fire('click')
    await settle()
    assert.equal(p.editor.save!.disabled, true)
    p.doc.fire('keydown', { key: 'Escape' })
    p.editor.cancel!.fire('click')
    assert.equal(p.editor.root!.hidden, false)
    save.release(
      reply(502, { error: 'Not saved: the backup could not be pushed' }),
    )
    await settle()
    assert.equal(p.editor.save!.disabled, false)
    assert.match(p.editor.output!.textContent!, /^Not saved/)
    p.editor.cancel!.fire('click')
    assert.equal(p.editor.root!.hidden, true)
    // Delete.
    const remove = held()
    p.answers.push(remove.response)
    p.rows.value.delete!.fire('click')
    await settle()
    assert.equal(p.rows.value.delete!.disabled, true)
    remove.release(reply(502, { error: 'no' }))
    await settle()
    assert.equal(p.rows.value.delete!.disabled, false)
    // Replace: its button while the file goes, and the picker cleared for a retry.
    const replace = held()
    p.answers.push(replace.response)
    p.picker.dataset.target = '3'
    p.picker.value = 'C:\\fakepath\\new.jks'
    p.picker.files = [file('new.jks', new Uint8Array([1]))]
    p.picker.fire('change')
    assert.equal(p.picker.value, '')
    await settle()
    assert.equal(p.rows.binary.replace!.disabled, true)
    replace.release(reply(502, { error: 'no' }))
    await settle()
    assert.equal(p.rows.binary.replace!.disabled, false)
    // An add form's submit.
    const add = held()
    p.answers.push(add.response)
    p.forms.value.name!.value = 'X'
    p.forms.value.value!.value = 'v'
    p.forms.value.form!.fire('submit')
    await settle()
    assert.equal(p.forms.value.submit!.disabled, true)
    add.release(reply(400, { error: 'bad' }))
    await settle()
    assert.equal(p.forms.value.submit!.disabled, false)
  })

  it('U18.13 a value with line breaks edits in the editor, and CRLF lines are saved as they came', async () => {
    const p = page()
    p.start()
    const pem = '-----BEGIN KEY-----\nabc\n-----END KEY-----\n'
    p.answers.push(reply(200, { value: pem }))
    p.rows.value.edit!.fire('click')
    await settle()
    // Not the one-line field, which would join the lines.
    assert.equal(p.rows.value.value!.hidden, true)
    assert.equal(p.editor.root!.hidden, false)
    assert.equal(p.editor.title!.textContent, 'API_TOKEN')
    assert.equal(p.editor.configs!.textContent, 'develop')
    assert.equal(p.editor.text!.value, pem)
    p.editor.save!.fire('click')
    await settle()
    assert.equal(p.calls[1]!.url, '/api/v2/projects/demo/secrets/1')
    assert.deepEqual(JSON.parse(String(p.calls[1]!.init.body)), { value: pem })
    p.editor.cancel!.fire('click')
    // A CRLF value: the textarea shows LF; the save puts the CRs back.
    p.answers.push(reply(200, { value: 'a\r\nb' }))
    p.rows.value.edit!.fire('click')
    await settle()
    assert.equal(p.editor.text!.value, 'a\nb')
    p.editor.save!.fire('click')
    await settle()
    assert.deepEqual(JSON.parse(String(p.calls[3]!.init.body)), {
      value: 'a\r\nb',
    })
    p.editor.cancel!.fire('click')
    // A CRLF file, edited in one line: only that line changes.
    p.answers.push(reply(200, { text: 'k=1\r\nv=2\r\n' }))
    p.rows.text.edit!.fire('click')
    await settle()
    assert.equal(p.editor.text!.value, 'k=1\nv=2\n')
    p.editor.text!.value = 'k=1\nv=3\n'
    p.editor.save!.fire('click')
    await settle()
    assert.deepEqual(JSON.parse(String(p.calls[5]!.init.body)), {
      text: 'k=1\r\nv=3\r\n',
    })
    p.editor.cancel!.fire('click')
    // Mixed line endings: the editor would change lines nobody edited.
    p.answers.push(reply(200, { text: 'a\r\nb\n' }))
    p.rows.text.edit!.fire('click')
    await settle()
    assert.equal(p.editor.root!.hidden, true)
    assert.match(
      p.rows.text.output!.textContent!,
      /mixes line endings, which the editor would change: replace it instead/,
    )
    p.answers.push(reply(200, { value: 'a\rb\nc' }))
    p.rows.value.edit!.fire('click')
    await settle()
    assert.equal(p.editor.root!.hidden, true)
    assert.match(
      p.rows.value.output!.textContent!,
      /This value mixes line endings/,
    )
    assert.deepEqual(editableText('plain'), { text: 'plain', crlf: false })
    assert.equal(editableText('a\rb'), undefined)
    assert.equal(editableText('\nb\r\n'), undefined)
  })

  it('U18.13 a pasted value with line breaks moves to a text area, and is sent whole', async () => {
    const p = page()
    p.start()
    const value = p.forms.value
    value.button!.fire('click')
    value.name!.value = 'PEM'
    value.value!.value = 'ab'
    // One line: the field takes it as usual.
    let prevented = 0
    value.value!.fire('paste', {
      clipboardData: { getData: () => 'cd' },
      preventDefault: () => prevented++,
    })
    assert.deepEqual([prevented, value.lines!.hidden], [0, true])
    value.value!.fire('paste', {
      clipboardData: { getData: () => '\nline two\n' },
      preventDefault: () => prevented++,
    })
    assert.equal(prevented, 1)
    assert.deepEqual(
      [value.value!.hidden, value.value!.required, value.value!.value],
      [true, false, ''],
    )
    assert.deepEqual(
      [value.lines!.hidden, value.lines!.required, value.lines!.value],
      [false, true, 'ab\nline two\n'],
    )
    assert.equal(value.reveal!.hidden, true)
    value.form!.fire('submit')
    await settle()
    assert.equal(
      JSON.parse(String(p.calls[0]!.init.body)).value,
      'ab\nline two\n',
    )
    // Cancel puts the one-line field back.
    value.cancel!.fire('click')
    assert.deepEqual(
      [value.value!.hidden, value.value!.required, value.lines!.hidden],
      [false, true, true],
    )
    assert.equal(value.reveal!.hidden, false)
  })

  it('U18.13 the value field can be shown while it is typed', () => {
    const p = page()
    p.start()
    const value = p.forms.value
    value.show!.checked = true
    value.show!.fire('change')
    assert.equal(value.value!.type, 'text')
    value.show!.checked = false
    value.show!.fire('change')
    assert.equal(value.value!.type, 'password')
  })

  it('U18.13 shows the audit’s times in the viewer’s time zone', () => {
    const p = page()
    const time = new El()
    time.dataset.at = String(Date.UTC(2026, 9, 30, 4, 34, 6))
    p.doc.set('time[data-at]', time)
    p.start()
    assert.equal(
      time.textContent,
      new Date(Date.UTC(2026, 9, 30, 4, 34, 6)).toLocaleString(),
    )
  })

  it('U18.13 a page without the panel is left alone', () => {
    startSecrets(new El(), {
      fetch: async () => reply(200, null),
      confirm: () => true,
      reload: () => undefined,
    })
  })
})
