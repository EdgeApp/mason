// The project's Secrets tab: inline value edits, the configs field, the
// text-file editor, Replace, Delete, and the two add forms. The page holds
// every control, hidden until needed; this script only shows, hides, fills
// and sends. Every change reloads the page, which re-reads the list and the
// audit. A fetch of a value or file's contents is audited as a view.

import { MAX_FILE, tooLarge } from '../pipeline/variants.js'

/** What the page needs from its window, so tests can supply it. */
export interface SecretsDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  confirm: (text: string) => boolean
  reload: () => void
}

/** The few element features the tab uses. */
export interface TabElement {
  dataset: Record<string, string | undefined>
  hidden: boolean
  value: string
  type?: string
  checked?: boolean
  disabled?: boolean
  required?: boolean
  textContent: string | null
  files?: ArrayLike<Blob & { name: string }> | null
  classList: { add: (name: string) => void; remove: (name: string) => void }
  querySelector: (selector: string) => TabElement | null
  querySelectorAll: (selector: string) => Iterable<TabElement>
  addEventListener: (
    type: string,
    listener: (event: SecretsEvent) => void,
  ) => void
  click: () => void
  focus: () => void
  reset?: () => void
}
export interface SecretsEvent {
  preventDefault: () => void
  key?: string
  dataTransfer?: { files: ArrayLike<Blob & { name: string }> } | null
  clipboardData?: { getData: (type: string) => string } | null
}
export interface SecretsDocument {
  querySelector: (selector: string) => TabElement | null
  querySelectorAll?: (selector: string) => Iterable<TabElement>
  addEventListener: (
    type: string,
    listener: (event: SecretsEvent) => void,
  ) => void
}

/** Bytes as base64, in chunks small enough for `String.fromCharCode`. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

/** A file's bytes as base64, refusing one over the master's limit. */
export async function fileContents(file: Blob): Promise<string> {
  if (file.size > MAX_FILE) throw new Error(tooLarge('The file'))
  return toBase64(new Uint8Array(await file.arrayBuffer()))
}

/** Text as UTF-8 bytes in base64, refusing more than the master takes. */
export function textContents(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > MAX_FILE) throw new Error(tooLarge('The text'))
  return toBase64(bytes)
}

/** Calls the secrets API with the page's CSRF token; an error carries the master's message. */
export function secretsClient(
  deps: SecretsDeps,
  base: string,
  csrf: string,
): (method: string, path: string, body?: unknown) => Promise<unknown> {
  return async (method, path, body) => {
    const response = await deps.fetch(base + path, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-mason-csrf': csrf,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let json: unknown
    try {
      json = text === '' ? null : JSON.parse(text)
    } catch {
      json = undefined
    }
    if (!response.ok)
      throw new Error(
        (json as { error?: string } | undefined)?.error ??
          `The master answered ${response.status}`,
      )
    return json
  }
}

/** The field of the master's answer a view expects, or why it is not there. */
function field(answer: unknown, key: 'value' | 'text'): string {
  const value = (answer as Record<string, unknown> | null)?.[key]
  if (typeof value !== 'string')
    throw new Error(`The master's answer has no ${key}`)
  return value
}

/** Disables a control while its request runs; a failed request enables it again. */
function busy(
  control: TabElement | null,
  request: Promise<unknown>,
): Promise<unknown> {
  if (control != null) control.disabled = true
  return request.catch((error: unknown) => {
    if (control != null) control.disabled = false
    throw error
  })
}

/** What the tab's parts share. */
interface Tab {
  doc: SecretsDocument
  panel: TabElement
  deps: SecretsDeps
  api: ReturnType<typeof secretsClient>
  fail: (output: TabElement | null) => (error: unknown) => void
  done: () => void
  /**
   * The variant the editor is open on, whether it is a file or a value with
   * line breaks, and whether its lines ended in CRLF.
   */
  editing?: { id: string; kind: 'value' | 'file'; crlf: boolean }
  /** Bumped by every open and close of the editor, so a late answer gives way. */
  editorTurn: number
  /** An editor open whose text has not arrived yet: Escape gives it up. */
  opening: boolean
  /** An editor save in flight: the editor stays open to show how it ends. */
  saving: boolean
}

/** Wires the tab's controls; a page without a `[data-secrets]` panel is left alone. */
export function startSecrets(doc: SecretsDocument, deps: SecretsDeps): void {
  const panel = doc.querySelector('[data-secrets]')
  if (panel == null) return
  // The audit's times, in the viewer's own time zone.
  for (const time of doc.querySelectorAll?.('time[data-at]') ?? [])
    time.textContent = new Date(Number(time.dataset.at)).toLocaleString()
  const csrf =
    (
      doc.querySelector('meta[name="mason-csrf"]') as {
        content?: string
      } | null
    )?.content ?? ''
  const tab: Tab = {
    doc,
    panel,
    deps,
    api: secretsClient(deps, panel.dataset.secrets!, csrf),
    fail: (output) => (error) => {
      if (output != null) output.textContent = (error as Error).message
    },
    done: () => deps.reload(),
    editorTurn: 0,
    opening: false,
    saving: false,
  }
  for (const row of panel.querySelectorAll('[data-secret-id]'))
    wireRow(tab, row)
  wireReplace(tab)
  wireEditor(tab)
  wireAdd(tab)
}

function wireRow(tab: Tab, row: TabElement): void {
  const { api, fail, done } = tab
  const id = row.dataset.secretId!
  const name = row.dataset.name ?? ''
  const configs = row.dataset.configs ?? ''
  const output = row.querySelector('[data-secret-output]')
  const view = row.querySelector('[data-secret-view]')
  const editing = row.querySelector('[data-secret-editing]')
  const valueInput = row.querySelector('[data-secret-value]')
  const pills = row.querySelector('[data-secret-pills]')
  const configsInput = row.querySelector('[data-secret-configs-input]')
  let mode: 'value' | 'configs' | undefined
  // Bumped by every change of mode, so a value that arrives late gives way.
  let turn = 0
  const show = (next: 'value' | 'configs' | undefined): void => {
    turn++
    mode = next
    if (view != null) view.hidden = next != null
    if (editing != null) editing.hidden = next == null
    if (valueInput != null) {
      valueInput.hidden = next !== 'value'
      if (next !== 'value') valueInput.value = ''
    }
    if (pills != null) pills.hidden = next === 'configs'
    if (configsInput != null) configsInput.hidden = next !== 'configs'
    if (output != null) output.textContent = ''
  }
  row.querySelector('[data-secret-edit]')?.addEventListener('click', () => {
    if (row.dataset.kind === 'file') {
      openEditor(tab, id, name, configs, output)
      return
    }
    const mine = ++turn
    api('GET', `/${id}`)
      .then((answer) => {
        if (mine !== turn) return
        const value = field(answer, 'value')
        // A one-line field would join its lines: the editor takes it.
        if (/[\r\n]/.test(value)) {
          tab.editorTurn++
          showEditor(tab, { id, name, configs, kind: 'value' }, value, output)
          return
        }
        show('value')
        valueInput!.value = value
        valueInput!.focus()
      })
      .catch(fail(output))
  })
  for (const pill of row.querySelectorAll('[data-secret-pill]'))
    pill.addEventListener('click', () => {
      show('configs')
      configsInput!.value = configs.split(',').filter(Boolean).join(', ')
      configsInput!.focus()
    })
  row.querySelector('[data-secret-cancel]')?.addEventListener('click', () => {
    show(undefined)
  })
  const save = row.querySelector('[data-secret-save]')
  save?.addEventListener('click', () => {
    const request =
      mode === 'configs'
        ? api('PUT', `/${id}/configs`, { configs: configsInput!.value })
        : api('PUT', `/${id}`, { value: valueInput!.value })
    busy(save, request).then(done, fail(output))
  })
  const remove = row.querySelector('[data-secret-delete]')
  remove?.addEventListener('click', () => {
    if (
      !tab.deps.confirm(`Delete ${name} (${configs === '' ? 'all' : configs})?`)
    )
      return
    busy(remove, api('DELETE', `/${id}`)).then(done, fail(output))
  })
  row.querySelector('[data-secret-replace]')?.addEventListener('click', () => {
    const picker = tab.panel.querySelector('[data-secret-file]')
    if (picker == null) return
    picker.dataset.target = id
    picker.click()
  })
}

/** The one file picker every Replace uses: the row that opened it gets the file. */
function wireReplace(tab: Tab): void {
  const picker = tab.panel.querySelector('[data-secret-file]')
  picker?.addEventListener('change', () => {
    const file = picker.files?.[0]
    const target = picker.dataset.target
    // Cleared, so choosing the same file again (after a refusal) is a change too.
    picker.value = ''
    if (file == null || target == null) return
    const row = tab.panel.querySelector(`[data-secret-id="${target}"]`)
    const output = row?.querySelector('[data-secret-output]') ?? null
    busy(
      row?.querySelector('[data-secret-replace]') ?? null,
      fileContents(file).then(
        async (contents) =>
          await tab.api('PUT', `/${target}/file`, { contents }),
      ),
    ).then(tab.done, tab.fail(output))
  })
}

/**
 * Text as the editor's textarea will hold it, which turns every CRLF into
 * LF: with `crlf` when every line ended in CRLF, so a save puts them back.
 * Undefined when the text mixes line endings or has a lone CR, which the
 * textarea would change in lines nobody edited.
 */
export function editableText(
  text: string,
): { text: string; crlf: boolean } | undefined {
  if (!text.includes('\r')) return { text, crlf: false }
  const lf = text.replace(/\r\n/g, '\n')
  if (lf.includes('\r') || /(^|[^\r])\n/.test(text)) return undefined
  return { text: lf, crlf: true }
}

/** Opens the editor on a text file, once its text arrives. */
function openEditor(
  tab: Tab,
  id: string,
  name: string,
  configs: string,
  rowOutput: TabElement | null,
): void {
  const mine = ++tab.editorTurn
  tab.opening = true
  tab
    .api('GET', `/${id}`)
    .then((answer) => {
      if (mine !== tab.editorTurn) return
      tab.opening = false
      showEditor(
        tab,
        { id, name, configs, kind: 'file' },
        field(answer, 'text'),
        rowOutput,
      )
    })
    .catch(tab.fail(rowOutput))
}

/** Shows the editor on a text file, or a value with line breaks, a one-line field would join. */
function showEditor(
  tab: Tab,
  variant: {
    id: string
    name: string
    configs: string
    kind: 'value' | 'file'
  },
  contents: string,
  rowOutput: TabElement | null,
): void {
  const editor = tab.doc.querySelector('[data-secret-editor]')
  if (editor == null) return
  const editable = editableText(contents)
  if (editable == null) {
    if (rowOutput != null)
      rowOutput.textContent =
        variant.kind === 'file'
          ? 'This file mixes line endings, which the editor would change: replace it instead'
          : 'This value mixes line endings, which the editor would change'
    return
  }
  const output = editor.querySelector('[data-secret-editor-output]')
  tab.editing = { id: variant.id, kind: variant.kind, crlf: editable.crlf }
  editor.querySelector('[data-secret-editor-title]')!.textContent = variant.name
  editor.querySelector('[data-secret-editor-configs]')!.textContent =
    variant.configs === '' ? 'all' : variant.configs.split(',').join(', ')
  const text = editor.querySelector('[data-secret-editor-text]')!
  text.value = editable.text
  if (output != null) output.textContent = ''
  editor.hidden = false
  text.focus()
}

function wireEditor(tab: Tab): void {
  const editor = tab.doc.querySelector('[data-secret-editor]')
  if (editor == null) return
  const text = editor.querySelector('[data-secret-editor-text]')!
  const output = editor.querySelector('[data-secret-editor-output]')
  const close = (): void => {
    // A save in flight keeps the editor open, so a refusal is seen.
    if (tab.saving) return
    tab.editorTurn++
    tab.opening = false
    editor.hidden = true
    text.value = ''
    tab.editing = undefined
  }
  editor
    .querySelector('[data-secret-editor-cancel]')
    ?.addEventListener('click', close)
  tab.doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (!editor.hidden || tab.opening)) close()
  })
  const save = editor.querySelector('[data-secret-editor-save]')
  save?.addEventListener('click', () => {
    if (tab.editing == null) return
    const { id, kind, crlf } = tab.editing
    const contents = crlf ? text.value.replace(/\n/g, '\r\n') : text.value
    tab.saving = true
    busy(
      save,
      tab.api(
        'PUT',
        `/${id}`,
        kind === 'file' ? { text: contents } : { value: contents },
      ),
    )
      .finally(() => {
        tab.saving = false
      })
      .then(tab.done, tab.fail(output))
  })
}

function wireAdd(tab: Tab): void {
  const { panel, api, fail, done } = tab
  const forms = {
    value: panel.querySelector('[data-secret-add-form="value"]'),
    file: panel.querySelector('[data-secret-add-form="file"]'),
  }
  for (const button of panel.querySelectorAll('[data-secret-add]'))
    button.addEventListener('click', () => {
      const kind = button.dataset.secretAdd as 'value' | 'file'
      for (const [which, form] of Object.entries(forms))
        if (form != null) form.hidden = which !== kind
      forms[kind]?.querySelector('[name="name"]')?.focus()
    })
  for (const [kind, form] of Object.entries(forms) as Array<
    ['value' | 'file', TabElement | null]
  >) {
    if (form == null) continue
    const output = form.querySelector('[data-secret-output]')
    const input = (name: string): TabElement | null =>
      form.querySelector(`[name="${name}"]`)
    // So a manager can check a typed or pasted value before it is saved.
    const reveal = form.querySelector('[data-secret-show]')
    reveal?.addEventListener('change', () => {
      const value = input('value')
      if (value != null)
        value.type = reveal.checked === true ? 'text' : 'password'
    })
    // A pasted value with line breaks, which the one-line field would join,
    // moves to a text area (which cannot hide what it shows).
    const single = input('value')
    const lines = form.querySelector('[data-secret-value-lines]')
    const revealLabel = form.querySelector('[data-secret-reveal]')
    const toSingle = (): void => {
      if (single == null || lines == null) return
      single.hidden = false
      single.required = true
      lines.hidden = true
      lines.required = false
      lines.value = ''
      if (revealLabel != null) revealLabel.hidden = false
    }
    single?.addEventListener('paste', (event) => {
      const pasted = event.clipboardData?.getData('text') ?? ''
      if (lines == null || !/[\r\n]/.test(pasted)) return
      event.preventDefault()
      lines.value = single.value + pasted
      single.value = ''
      single.hidden = true
      single.required = false
      lines.hidden = false
      lines.required = true
      if (revealLabel != null) revealLabel.hidden = true
      lines.focus()
    })
    let dropped: (Blob & { name: string }) | undefined
    const chosen = form.querySelector('[data-secret-chosen]')
    const choose = (file: (Blob & { name: string }) | undefined): void => {
      dropped = file
      if (file == null) return
      const nameField = input('name')
      if (nameField != null && nameField.value === '')
        nameField.value = file.name
      if (chosen != null) chosen.textContent = file.name
    }
    form
      .querySelector('[data-secret-add-cancel]')
      ?.addEventListener('click', () => {
        form.hidden = true
        form.reset?.()
        toSingle()
        dropped = undefined
        if (chosen != null) chosen.textContent = ''
        if (output != null) output.textContent = ''
      })
    const drop = form.querySelector('[data-secret-drop]')
    const picker = form.querySelector('[data-secret-add-file]')
    if (drop != null) {
      drop.addEventListener('dragover', (event) => {
        event.preventDefault()
        drop.classList.add('dragging')
      })
      drop.addEventListener('dragleave', () =>
        drop.classList.remove('dragging'),
      )
      drop.addEventListener('drop', (event) => {
        event.preventDefault()
        drop.classList.remove('dragging')
        choose(event.dataTransfer?.files[0])
      })
      drop.addEventListener('click', () => picker?.click())
    }
    picker?.addEventListener('change', () => choose(picker.files?.[0]))
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const body: Record<string, unknown> = {
        kind,
        name: input('name')?.value ?? '',
        configs: input('configs')?.value ?? '',
      }
      const masked = input('masked') as
        | (TabElement & { checked?: boolean })
        | null
      if (masked != null) body.masked = masked.checked === true
      const pathEnv = input('pathEnv')?.value ?? ''
      if (pathEnv !== '') body.pathEnv = pathEnv
      const contents: Promise<void> =
        kind === 'value'
          ? Promise.resolve().then(() => {
              body.value =
                lines != null && !lines.hidden
                  ? lines.value
                  : (single?.value ?? '')
            })
          : dropped != null
            ? fileContents(dropped).then((value) => {
                body.contents = value
              })
            : Promise.resolve().then(() => {
                const text = input('text')?.value ?? ''
                if (text === '')
                  throw new Error('Drop or choose a file, or paste its text')
                body.contents = textContents(text)
              })
      const submit = form.querySelector('button:not([type])')
      busy(
        submit,
        contents.then(() => api('POST', '', body)),
      ).then(done, fail(output))
    })
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined')
  startSecrets(document as unknown as SecretsDocument, {
    fetch: window.fetch.bind(window),
    confirm: (text) => window.confirm(text),
    reload: () => window.location.reload(),
  })
