// The run view and the actions on it: forms that call the API as JSON, the
// live stream of stages, steps and log lines, the log's wrap toggle, the
// stage list's filters, the graph's zoom and its highlighted rails, and the
// dashboard's queue, which reloads when the queue changes.
import { ansiLine, plainLog } from '../view/log.js'

/** The body an action form sends: known fields at the top, the rest as parameters. */
export function actionBody(
  fields: Record<string, string>,
): Record<string, unknown> {
  const top = new Set(['project', 'branch', 'workflow', 'stage', 'approve'])
  const body: Record<string, unknown> = {}
  const params: Record<string, string> = {}
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'approve') body.approve = value === 'true'
    else if (top.has(name)) body[name] = value
    else params[name] = value
  }
  if (Object.keys(params).length > 0) body.params = params
  return body
}

/** Lines of a log as HTML, numbered from `first`, as the server renders them. */
export function logLines(text: string, first: number): string[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
  if (text === '') return []
  let style = { bold: false, underline: false }
  return lines.map((line, index) => {
    const rendered = ansiLine(line, style)
    style = rendered.style
    return `<span class="line" data-line="${first + index}">${rendered.html}</span>`
  })
}

/** What the run view's live stream sends as `stages`. */
export interface Snapshot {
  status: string
  finished: boolean
  stages: Array<{ name: string; status: string }>
  steps: Array<{
    id: number
    kind: string
    title: string
    status: string
    ms: number | null
  }>
}

/** The page parts the script changes, so a test can supply them. */
export interface RunPage {
  /** Whether the page draws a stage; setup adds stages after a page may have loaded. */
  hasStage(name: string): boolean
  reload(): void
  setStageStatus(name: string, status: string): void
  setRunStatus(status: string): void
  setSteps(snapshot: Snapshot['steps']): void
  appendLog(html: string[]): void
  ended(): void
}

/** Applies one stream event to the page. */
export function applyEvent(page: RunPage, type: string, data: string): void {
  if (type === 'stages') {
    const snapshot = JSON.parse(data) as Snapshot
    if (snapshot.stages.some((stage) => !page.hasStage(stage.name))) {
      page.reload()
      return
    }
    page.setRunStatus(snapshot.status)
    for (const stage of snapshot.stages)
      page.setStageStatus(stage.name, stage.status)
    if (snapshot.steps.length > 0) page.setSteps(snapshot.steps)
  } else if (type === 'log') {
    const chunk = JSON.parse(data) as { text: string; first: number }
    page.appendLog(logLines(chunk.text, chunk.first))
  } else if (type === 'end' || type === 'gone') page.ended()
}

/** A form's named fields, by the names in its `data-fields`; checked boxes named `app` become `apps`. */
export function formFields(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of fieldNames(form)) {
    const element = form.elements.namedItem(name) as HTMLInputElement | null
    if (element != null) out[name] = element.value
  }
  const boxes = [
    ...form.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"][name="app"]',
    ),
  ]
  if (boxes.length > 0)
    out.apps = boxes
      .filter((box) => box.checked)
      .map((box) => box.value)
      .join(',')
  return out
}

const fieldNames = (form: HTMLFormElement): string[] =>
  (form.dataset.fields ?? '').split(',').filter((entry) => entry !== '')

/** Leaves a field out of the body. */
const omit = Symbol('omit')

/**
 * A field's value as its `data-kind` says: `number`, `list` (commas and new
 * lines), `checkbox`, or `secret` (empty keeps the stored one); otherwise
 * its text. An empty `number`, or an empty `data-optional` field, is left out.
 */
function typedValue(element: HTMLInputElement): unknown {
  const kind = element.dataset?.kind
  const text = element.value
  if (kind === 'checkbox') return element.checked
  if (kind === 'secret') return text === '' ? { keep: true } : text
  if (
    text.trim() === '' &&
    (kind === 'number' || element.dataset?.optional != null)
  )
    return omit
  if (kind === 'number') return Number(text)
  if (kind === 'list')
    return text
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter((item) => item !== '')
  return text
}

/** A form's fields, typed by each input's `data-kind`. */
export function typedFields(form: HTMLFormElement): Record<string, unknown> {
  const out: Record<string, unknown> = { ...formFields(form) }
  for (const name of fieldNames(form)) {
    const element = form.elements.namedItem(name) as HTMLInputElement | null
    if (element == null) continue
    const value = typedValue(element)
    if (value === omit) delete out[name]
    else out[name] = value
  }
  return out
}

/**
 * A JSON body from fields: dotted names nest, a numeric part is an array
 * index (gaps close up), and empty nested text is left out.
 */
export function nestedBody(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const arrays: unknown[][] = []
  for (const [name, value] of Object.entries(fields)) {
    const parts = name.split('.')
    if (parts.length > 1 && value === '') continue
    let target = body as Record<string, unknown>
    for (let i = 0; i < parts.length - 1; i++) {
      const next = /^\d+$/.test(parts[i + 1]!)
      let child = target[parts[i]!]
      if (child == null) {
        child = next ? [] : {}
        if (next) arrays.push(child as unknown[])
        target[parts[i]!] = child
      }
      target = child as Record<string, unknown>
    }
    target[parts[parts.length - 1]!] = value
  }
  for (const array of arrays) {
    const items = array.filter((item) => item !== undefined)
    array.splice(0, array.length, ...items)
  }
  return body
}

/** The JSON a form sends: a run action's fields and parameters, a JSON field as the whole body, or its typed fields nested. */
export function requestBody(form: HTMLFormElement): unknown {
  const json = form.dataset.json
  if (json != null && json !== '')
    return JSON.parse(
      formFields(form)[json] ??
        (form.elements.namedItem(json) as HTMLTextAreaElement | null)?.value ??
        '{}',
    ) as unknown
  return /^\/api\/v2\/runs(\/|$)/.test(form.dataset.path ?? '')
    ? actionBody(formFields(form))
    : nestedBody(typedFields(form))
}

/** The form's path, each `{name}` filled with that field's URL-encoded value. */
export function formPath(form: HTMLFormElement): string {
  return (form.dataset.path ?? '').replace(/\{([^}]+)\}/g, (_, name: string) =>
    encodeURIComponent(
      (form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '',
    ),
  )
}

/**
 * Sends an action form to its API path, then reloads, opens the new run, or
 * (the wizard's first step) creates the project it checked and continues.
 */
export async function submitAction(
  form: HTMLFormElement,
  csrf: string,
  fetcher: typeof fetch,
  go: (href: string) => void,
  here = '',
): Promise<string | undefined> {
  const method = form.dataset.method ?? 'POST'
  const send = async (
    path: string,
    verb: string,
    body?: unknown,
  ): Promise<Response> =>
    await fetcher(path, {
      method: verb,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-mason-csrf': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  // A DELETE sends a body only when the form names fields (a typed confirmation).
  const response = await send(
    formPath(form),
    method,
    method === 'DELETE' && fieldNames(form).length === 0
      ? undefined
      : requestBody(form),
  )
  const body = (await response.json().catch(() => ({}))) as {
    id?: string
    token?: string
    error?: string
    slug?: string
    repository?: string
    defaultBranch?: string
  }
  if (!response.ok) return body.error ?? `Request failed (${response.status})`
  // A new API key's token, shown once in the form's command box.
  if (form.dataset.then === 'token' && typeof body.token === 'string') {
    const out = form.querySelector<HTMLElement>('[data-field="token"]')
    if (out != null) {
      out.hidden = false
      const pre = out.querySelector('pre')
      if (pre != null) pre.textContent = body.token
      const copy = out.querySelector<HTMLElement>('button[data-copy]')
      if (copy != null) copy.dataset.copy = body.token
    }
    return undefined
  }
  if (form.dataset.then === 'run' && body.id != null)
    go(`/runs/${encodeURIComponent(body.id)}`)
  else if (form.dataset.then === 'wizard' && body.slug != null) {
    const created = await send(
      `/api/v2/projects/${encodeURIComponent(body.slug)}`,
      'PUT',
      {
        name: body.slug,
        repository: body.repository,
        defaultBranch: body.defaultBranch,
        format: 'pipeline',
      },
    )
    if (!created.ok)
      return (
        ((await created.json().catch(() => ({}))) as { error?: string })
          .error ?? `Request failed (${created.status})`
      )
    go(`/projects/new?slug=${encodeURIComponent(body.slug)}`)
  } else go(here)
  return undefined
}

/** The step list's items, as the server renders them. */
function stepHtml(stage: string, step: Snapshot['steps'][number]): string {
  const escape = (text: string): string =>
    text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const ms = step.ms == null ? '' : ` · ${Math.round(step.ms / 1000)}s`
  return `<li class="step"><a href="?stage=${encodeURIComponent(stage)}&amp;step=${step.id}"><span class="dot ${escape(step.status)}" aria-hidden="true"></span><span class="mono">${escape(plainLog(step.title))}</span><small>${escape(step.kind)}${ms}</small></a></li>`
}

/** The real page's parts. */
export function domRunPage(
  doc: Document,
  reload: () => void = (): void => undefined,
): RunPage {
  const stage =
    doc.querySelector<HTMLElement>('.stage-panel')?.dataset.stage ?? ''
  return {
    hasStage: (name): boolean =>
      doc.querySelector(`.stage-list li[data-name="${quoted(name)}"]`) != null,
    reload,
    setStageStatus: (name, status): void => {
      for (const node of doc.querySelectorAll<SVGElement>(
        `.bubble[data-stage="${quoted(name)}"]`,
      )) {
        node.setAttribute(
          'class',
          (node.getAttribute('class') ?? '').replace(
            /status-\S+/,
            `status-${status}`,
          ),
        )
      }
      for (const item of doc.querySelectorAll<HTMLElement>(
        `.stage-list li[data-name="${quoted(name)}"]`,
      )) {
        item.dataset.status = status
        const dot = item.querySelector('.dot')
        if (dot != null) dot.className = `dot ${status}`
      }
      // The selected stage's panel (its actions, node and times) is drawn
      // for one status; a new one redraws the page.
      const panel = doc.querySelector<HTMLElement>('.stage-panel')
      if (
        panel?.dataset.stage === name &&
        panel.dataset.status != null &&
        panel.dataset.status !== status
      ) {
        panel.dataset.status = status
        reload()
      }
    },
    setRunStatus: (status): void => {
      const node = doc.querySelector<HTMLElement>('[data-run-status]')
      if (node != null) {
        node.className = `state-${status}`
        node.innerHTML = `<span class="dot ${status}" aria-hidden="true"></span> ${status.replace('_', ' ')}`
      }
    },
    setSteps: (steps): void => {
      const list = doc.querySelector('[data-steps]')
      if (list != null)
        list.innerHTML = steps.map((step) => stepHtml(stage, step)).join('')
    },
    appendLog: (html): void => {
      const code = doc.querySelector('[data-log] code')
      if (code == null || html.length === 0) return
      code.insertAdjacentHTML('beforeend', html.join(''))
      const panel = doc.querySelector<HTMLElement>('[data-log] pre')
      if (
        panel != null &&
        panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80
      )
        panel.scrollTop = panel.scrollHeight
    },
    ended: (): void => {
      doc
        .querySelector<HTMLElement>('.run-head')
        ?.setAttribute('data-live', '0')
    },
  }
}

/** A value inside a double-quoted attribute selector. */
const quoted = (value: string): string => value.replace(/["\\]/g, '\\$&')

/** Highlights a bubble's inputs and dependents and the rails between them. */
export function highlight(svg: Element, name: string | undefined): void {
  svg.classList.toggle('focused', name != null)
  for (const node of svg.querySelectorAll('.bubble, .rail'))
    node.classList.remove('related')
  if (name == null) return
  const bubble = svg.querySelector(`.bubble[data-stage="${quoted(name)}"]`)
  if (bubble == null) return
  const near = new Set([
    name,
    ...(bubble.getAttribute('data-needs') ?? '').split(' '),
    ...(bubble.getAttribute('data-dependents') ?? '').split(' '),
  ])
  for (const node of svg.querySelectorAll('.bubble'))
    if (near.has(node.getAttribute('data-stage') ?? ''))
      node.classList.add('related')
  for (const rail of svg.querySelectorAll('.rail'))
    if (
      rail.getAttribute('data-from') === name ||
      rail.getAttribute('data-to') === name
    )
      rail.classList.add('related')
}

/** What the run view's script needs from the window, so a test can supply it. */
export interface RunWindow {
  fetch: typeof fetch
  location: { href: string; assign: (href: string) => void }
  EventSource: new (url: string) => {
    addEventListener: (
      type: string,
      listener: (event: { data: string }) => void,
    ) => void
    close: () => void
  }
  DOMParser: new () => {
    parseFromString: (html: string, type: 'text/html') => Document
  }
}

/** Wires the run view, the action forms and the dashboard's queue on a page. */
export function start(doc: Document, win: RunWindow): void {
  const csrf =
    doc.querySelector<HTMLMetaElement>('meta[name="mason-csrf"]')?.content ?? ''
  for (const form of doc.querySelectorAll<HTMLFormElement>(
    'form[data-mason="api"]',
  ))
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const status = form.querySelector<HTMLElement>('[data-field="status"]')
      if (status != null) {
        status.textContent = 'Working…'
        status.hidden = false
      }
      void submitAction(
        form,
        csrf,
        win.fetch,
        (href) => win.location.assign(href),
        win.location.href,
      ).then(
        (error) => {
          if (status != null) status.textContent = error ?? ''
        },
        (error: unknown) => {
          if (status != null) status.textContent = (error as Error).message
        },
      )
    })
  for (const box of doc.querySelectorAll<HTMLInputElement>('[data-wrap]'))
    box.addEventListener('change', () => {
      for (const log of doc.querySelectorAll('.log'))
        log.classList.toggle('wrap', box.checked)
    })
  const filter = doc.querySelector<HTMLInputElement>('[data-stage-filter]')
  const status = doc.querySelector<HTMLSelectElement>('[data-status-filter]')
  const refilter = (): void => {
    for (const item of doc.querySelectorAll<HTMLElement>(
      '.stage-list li[data-name]',
    ))
      item.hidden =
        !(item.dataset.name ?? '')
          .toLowerCase()
          .includes((filter?.value ?? '').toLowerCase()) ||
        (status?.value !== '' &&
          status?.value != null &&
          item.dataset.status !== status.value)
  }
  filter?.addEventListener('input', refilter)
  status?.addEventListener('change', refilter)
  const svg = doc.querySelector<SVGSVGElement>('.pipeline-graph')
  if (svg != null) {
    let scale = 1
    const width = Number(svg.getAttribute('width'))
    const height = Number(svg.getAttribute('height'))
    for (const button of doc.querySelectorAll<HTMLButtonElement>('[data-zoom]'))
      button.addEventListener('click', () => {
        const zoom = button.dataset.zoom
        if (zoom === 'full') {
          void doc.querySelector('.graph-panel')?.requestFullscreen()
          return
        }
        scale =
          zoom === 'in'
            ? Math.min(3, scale * 1.25)
            : zoom === 'out'
              ? Math.max(0.4, scale / 1.25)
              : 1
        svg.setAttribute('width', String(width * scale))
        svg.setAttribute('height', String(height * scale))
      })
    for (const bubble of svg.querySelectorAll<SVGElement>(
      '.bubble[data-stage]',
    )) {
      bubble.addEventListener('mouseenter', () =>
        highlight(svg, bubble.dataset.stage),
      )
      bubble.addEventListener('mouseleave', () =>
        highlight(
          svg,
          svg.querySelector('.bubble.selected')?.getAttribute('data-stage') ??
            undefined,
        ),
      )
    }
    highlight(
      svg,
      svg.querySelector('.bubble.selected')?.getAttribute('data-stage') ??
        undefined,
    )
  }
  // A log this node does not hold (a step's lines on the host) is fetched through it.
  const source = doc.querySelector<HTMLElement>('[data-log][data-src]')
  if (source != null)
    void win
      .fetch(source.dataset.src ?? '', { credentials: 'same-origin' })
      .then(async (response) => (response.ok ? await response.text() : ''))
      .then((text) => {
        const code = source.querySelector('code')
        if (code != null) code.innerHTML = logLines(text, 1).join('')
      })
  const head = doc.querySelector<HTMLElement>('.run-head')
  if (head?.dataset.live === '1') {
    const stage =
      doc.querySelector<HTMLElement>('.stage-panel')?.dataset.stage ?? ''
    const offset = Number(
      doc.querySelector<HTMLElement>('[data-log]')?.dataset.offset ?? -1,
    )
    const params = new URLSearchParams()
    if (stage !== '' && offset >= 0) {
      params.set('stage', stage)
      params.set('after', String(offset))
    }
    const events = new win.EventSource(
      `/api/v2/runs/${encodeURIComponent(head.dataset.run ?? '')}/events?${params}`,
    )
    const page = domRunPage(doc, () => win.location.assign(win.location.href))
    for (const type of ['stages', 'log', 'end', 'gone'])
      events.addEventListener(type, (event) => {
        applyEvent(page, type, event.data)
        if (type === 'end' || type === 'gone') events.close()
      })
  }
  const queue = doc.querySelector('[data-queue]')
  if (queue != null && head == null) {
    let first = true
    const events = new win.EventSource('/api/v2/queue/events')
    events.addEventListener('queue', () => {
      if (first) {
        first = false
        return
      }
      void win
        .fetch(win.location.href, { credentials: 'same-origin' })
        .then(async (response) => await response.text())
        .then((html) => {
          const fresh = new win.DOMParser()
            .parseFromString(html, 'text/html')
            .querySelector('[data-queue]')
          if (fresh != null) queue.innerHTML = fresh.innerHTML
        })
    })
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined')
  start(document, {
    fetch: window.fetch.bind(window),
    location: window.location,
    EventSource: window.EventSource,
    DOMParser: window.DOMParser,
  })
