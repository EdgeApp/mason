// The run view and the actions on it: forms that call the API as JSON, the
// run's status, stages, steps and log lines live from the page's socket, the
// log's follow and its button to the end, its wrap toggle, the stage list's
// filters, the graph's zoom and its highlighted rails, and the dashboard's
// queue and run statuses, live from the same socket.
import {
  queueItems,
  runChip,
  statusDot,
  type QueueEntry,
} from '../view/dashboard.js'
import { escape, since, stamp } from '../view/html.js'
import { logLines } from '../view/log.js'
import {
  CHUNK,
  LogViewer,
  type FetchLines,
  type LinesAnswer,
  type LogStart,
} from './logViewer.js'
export { logLines }
import { stepItems, type StepRow } from '../view/steps.js'
import {
  LiveClient,
  liveUrl,
  type LiveFrame,
  type LiveSocket,
  type LiveState,
  type LiveWindow,
} from './live.js'

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

/** The page parts the script changes, so a test can supply them. */
export interface RunPage {
  /** Whether the page draws a stage; setup adds stages after a page may have loaded. */
  hasStage(name: string): boolean
  reload(): void
  setStageStatus(name: string, status: string): void
  setRunStatus(status: string): void
  /** Shows a stage the log panel follows under its name, its log emptied. */
  follow(stage: string): void
  setSteps(stage: string, steps: StepRow[]): void
  /** Lines that arrived, numbered from `first`. */
  appendLog(html: string[], first: number): void
  ended(): void
}

/**
 * A run page's live subscription: the stage its log panel shows and the
 * byte offset its log has reached, so a reconnect resumes after the last
 * line it has. With no stage selected the panel follows the running stage,
 * and switches when the next one starts.
 */
export class RunLive {
  private readonly following: boolean
  /** The start of a line longer than a frame, held until the rest of it arrives. */
  private carry: { text: string; first: number } | undefined
  constructor(
    private readonly page: RunPage,
    private readonly run: string,
    /** The stage the panel shows; none while it waits for one to follow. */
    private stage: string | undefined,
    /**
     * Where the shown log ends; `tail` when the page holds none of it (the
     * host's) and starts at its end; -1 when the panel shows a step's lines,
     * which take no more.
     */
    private offset: number | 'tail',
  ) {
    this.following = stage == null
  }

  /** The subscribe message, as of now. */
  message(): Record<string, unknown> {
    return {
      subscribe: 'run',
      run: this.run,
      ...(this.stage == null
        ? {}
        : this.offset === 'tail'
          ? { stage: this.stage, tail: true }
          : this.offset < 0
            ? { stage: this.stage, log: false }
            : { stage: this.stage, after: this.offset }),
      ...(this.following ? { follow: true } : {}),
    }
  }

  apply(frame: LiveFrame): void {
    const data = frame.data as Record<string, unknown> | undefined
    if (frame.event === 'run') this.page.setRunStatus(String(data!.status))
    else if (frame.event === 'stages') {
      const stages = frame.data as Array<{ name: string; status: string }>
      if (stages.some((stage) => !this.page.hasStage(stage.name))) {
        this.page.reload()
        return
      }
      for (const stage of stages)
        this.page.setStageStatus(stage.name, stage.status)
    } else if (frame.event === 'steps') {
      const stage = String(data!.stage)
      if (this.following && stage !== this.stage) {
        this.stage = stage
        this.offset = 0
        this.carry = undefined
        this.page.follow(stage)
      }
      if (stage === this.stage)
        this.page.setSteps(stage, data!.steps as StepRow[])
    } else if (frame.event === 'log') {
      if (data!.stage !== this.stage || this.offset === -1) return
      this.offset = Number(data!.offset)
      const text = (this.carry?.text ?? '') + String(data!.text)
      const first = this.carry?.first ?? Number(data!.first)
      if (data!.partial === true) {
        this.carry = { text, first }
        return
      }
      this.carry = undefined
      this.page.appendLog(logLines(text, first), first)
    } else if (frame.event === 'end' || frame.event === 'gone')
      this.page.ended()
  }
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
 * Sends an action form to its API path, then reloads, opens the new run or
 * group, returns to the groups, or (the wizard's first step) creates the
 * project it checked and continues.
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
    url?: string
    invitation?: { url?: string }
    error?: string
    slug?: string
    repository?: string
    defaultBranch?: string
  }
  if (!response.ok) return body.error ?? `Request failed (${response.status})`
  // A new API key's token or an invitation link, shown once in the form's command box.
  const shown =
    form.dataset.then === 'token'
      ? body.token
      : form.dataset.then === 'link'
        ? (body.url ?? body.invitation?.url)
        : undefined
  if (typeof shown === 'string') {
    const out = form.querySelector<HTMLElement>('[data-field="token"]')
    if (out != null) {
      out.hidden = false
      const pre = out.querySelector('pre')
      if (pre != null) pre.textContent = shown
      const copy = out.querySelector<HTMLElement>('button[data-copy]')
      if (copy != null) copy.dataset.copy = shown
    }
    return undefined
  }
  if (form.dataset.then === 'run' && body.id != null)
    go(`/runs/${encodeURIComponent(body.id)}`)
  // A new group opens its page; a removed one returns to the list.
  else if (form.dataset.then === 'group' && body.id != null)
    go(`/groups/${encodeURIComponent(body.id)}`)
  else if (form.dataset.then === 'groups') go('/groups')
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

/** How near the bottom a viewer must be for the log to keep following. */
export const FOLLOW_PX = 80

/** The log box's scrolling and its button to the end, shared by live and finished logs. */
export interface LogScroller {
  /** Lines were added below: a log at its end stays there, one scrolled up shows the button. */
  appended(): void
  /** The log was replaced (a stage to follow, a fetched log): `atEnd` opens it at its end. */
  reset(atEnd: boolean): void
}

/**
 * The log box's scrolling. The round button at its bottom right shows while
 * the log is not at its end and goes there; at the end, the log follows the
 * lines that arrive, until the viewer scrolls up. Any move up stops it, even
 * within 80px of the bottom, so lines arriving mid-scroll never pull the
 * viewer back down; back within 80px of the bottom, it follows again. A
 * live log opens at its end, a finished one at its start.
 */
export function logScroller(doc: Document, atEnd: boolean): LogScroller {
  const pre = (): HTMLElement | null =>
    doc.querySelector<HTMLElement>('[data-log] pre')
  const jump = doc.querySelector<HTMLElement>('[data-jump]')
  let following = true
  /** Where the log was scrolled to last, so a move up is told from new lines below. */
  let lastTop = 0
  const show = (): void => {
    if (jump != null) jump.hidden = following
  }
  const toEnd = (): void => {
    const log = pre()
    if (log == null) return
    log.scrollTop = log.scrollHeight
    lastTop = log.scrollTop
  }
  const scrolled = (): void => {
    const log = pre()
    if (log == null) return
    const distance = log.scrollHeight - log.scrollTop - log.clientHeight
    // At the very bottom it follows, though a taller log panel (a resized
    // window) moved it up; any other move up stops it.
    if (distance > 1 && log.scrollTop < lastTop) following = false
    else if (distance < FOLLOW_PX) following = true
    lastTop = log.scrollTop
    show()
  }
  let watched: HTMLElement | null = null
  const watch = (): void => {
    const log = pre()
    if (log == null || log === watched) return
    watched = log
    log.addEventListener('scroll', scrolled)
  }
  const reset = (end: boolean): void => {
    watch()
    const log = pre()
    if (end) {
      toEnd()
      following = true
    } else {
      lastTop = log?.scrollTop ?? 0
      following =
        log == null ||
        log.scrollHeight - log.scrollTop - log.clientHeight < FOLLOW_PX
    }
    show()
  }
  reset(atEnd)
  jump?.addEventListener('click', () => {
    toEnd()
    following = true
    show()
  })
  return {
    appended: (): void => {
      if (following) toEnd()
      else show()
    },
    reset,
  }
}

/** The real page's parts; its log scrolls as `logScroller` says, opening at its end. */
/** The log box's viewer, and how to make one for a stage the page starts to follow. */
export interface LogBox {
  viewer?: LogViewer
  make?: (stage: string) => LogViewer | undefined
}

export function domRunPage(
  doc: Document,
  reload: () => void = (): void => undefined,
  scroller: LogScroller = logScroller(doc, true),
  box: LogBox = {},
): RunPage {
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
      const title = doc.querySelector<HTMLElement>('[data-log-title]')
      if (title != null && title.dataset.following === name)
        title.innerHTML = followTitle(name, status)
    },
    setRunStatus: (status): void => {
      const node = doc.querySelector<HTMLElement>('[data-run-status]')
      if (node != null) {
        node.className = `state-${status}`
        node.innerHTML = `${statusDot(status)} ${escape(status.replace('_', ' '))}`
      }
    },
    follow: (stage): void => {
      const title = doc.querySelector<HTMLElement>('[data-log-title]')
      if (title != null) {
        title.dataset.following = stage
        title.innerHTML = followTitle(stage, 'running')
      }
      const list = doc.querySelector<HTMLElement>('[data-steps]')
      if (list != null) list.hidden = false
      const code = doc.querySelector('[data-log] code')
      if (code != null) code.innerHTML = ''
      else
        // A page without the run's log (the host's) gets a log to follow.
        doc
          .querySelector('[data-log]')
          ?.insertAdjacentHTML(
            'afterbegin',
            '<pre class="log"><code></code></pre>',
          )
      doc.querySelector<HTMLElement>('[data-log] .empty-state')?.remove()
      if (box.make != null) {
        box.viewer?.destroy()
        box.viewer = box.make(stage)
      }
      scroller.reset(true)
    },
    setSteps: (stage, steps): void => {
      const list = doc.querySelector('[data-steps]')
      if (list != null) list.innerHTML = stepItems(stage, steps)
    },
    appendLog: (html, first): void => {
      if (html.length === 0) return
      if (box.viewer != null) box.viewer.append(html, first)
      else {
        const code = doc.querySelector('[data-log] code')
        if (code == null) return
        code.insertAdjacentHTML('beforeend', html.join(''))
      }
      scroller.appended()
    },
    ended: (): void => {
      doc
        .querySelector<HTMLElement>('.run-head')
        ?.setAttribute('data-live', '0')
    },
  }
}

/** The log panel's title while it follows a stage. */
const followTitle = (stage: string, status: string): string =>
  `${statusDot(status)}${escape(stage)} <span class="follow-note">following the running stage</span>`

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
  location: {
    href: string
    protocol: string
    host: string
    assign: (href: string) => void
  }
  live: LiveWindow
}

/**
 * Writes each `<time data-format>` in the viewer's own zone: `since` as
 * `2:31 ago` within a day, else, like `date`, as `2026-11-01 1435 PT`.
 * Whether any is a `since` time, which the page keeps current.
 */
export function localTimes(
  doc: Document,
  now: number,
  timeZone?: string,
): boolean {
  let relative = false
  for (const node of doc.querySelectorAll<HTMLElement>(
    'time[data-at][data-format]',
  )) {
    const at = Number(node.dataset.at)
    if (!Number.isFinite(at)) continue
    if (node.dataset.format === 'since') {
      relative = true
      node.textContent = since(at, now, timeZone)
    } else node.textContent = stamp(at, timeZone)
  }
  return relative
}

/** Wires the run view, the action forms and the dashboard's queue on a page. */
export function start(doc: Document, win: RunWindow): void {
  /** The run log's box: drawn a window of lines at a time. */
  const logBox: LogBox = {}
  const times = (): void => {
    if (localTimes(doc, Date.now())) win.live.setTimeout(times, 30_000)
  }
  times()
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
  for (const toggle of doc.querySelectorAll<HTMLInputElement>('[data-wrap]'))
    toggle.addEventListener('change', () => {
      for (const log of doc.querySelectorAll('.log'))
        log.classList.toggle('wrap', toggle.checked)
      logBox.viewer?.wrap(toggle.checked)
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
  const head = doc.querySelector<HTMLElement>('.run-head')
  // The log box scrolls through every line of the log and draws those in
  // view, asking the server (on the host, through it) for the rest by
  // number. A live stage's log opens at its end; a finished one, or a
  // step's lines, at the start.
  const box = doc.querySelector<HTMLElement>('[data-log]')
  const atEnd = head?.dataset.live === '1' && box?.dataset.offset !== '-1'
  const fetcher =
    (src: string): FetchLines =>
    async (from) => {
      const response = await win.fetch(
        `${src}${src.includes('?') ? '&' : '?'}${from === 'last' ? 'last=1' : `from=${from}`}&count=${CHUNK}`,
        { credentials: 'same-origin' },
      )
      if (!response.ok) throw new Error(`Lines failed (${response.status})`)
      return (await response.json()) as LinesAnswer
    }
  const viewerAt = (src: string, begin: LogStart): LogViewer | undefined => {
    const pre = doc.querySelector<HTMLElement>('[data-log] pre')
    const code = pre?.querySelector<HTMLElement>('code')
    if (pre == null || code == null) return undefined
    const viewer = new LogViewer(pre, code, fetcher(src), begin)
    if (doc.querySelector<HTMLInputElement>('[data-wrap]')?.checked === true)
      viewer.wrap(true)
    return viewer
  }
  const src = box?.dataset.lines
  if (box != null && src != null) {
    const drawn = [...box.querySelectorAll<HTMLElement>('pre code .line')]
    logBox.viewer = viewerAt(src, {
      start: Number(box.dataset.start ?? 1),
      total: Number(box.dataset.total ?? 0),
      first: Number(drawn[0]?.dataset.line ?? box.dataset.start ?? 1),
      lines: drawn.map((line) => line.outerHTML),
    })
  }
  // A stage the page starts to follow gets a box of its own.
  const run = head?.dataset.run ?? ''
  logBox.make = (stage): LogViewer | undefined =>
    viewerAt(
      `/api/v2/runs/${encodeURIComponent(run)}/logs?stage=${encodeURIComponent(stage)}`,
      { start: 1, total: 0, first: 1, lines: [] },
    )
  const scroller = logScroller(doc, atEnd)
  // The host's page draws none of the log: it asks for its end or start.
  if (logBox.viewer != null && box?.dataset.total == null)
    void logBox.viewer
      .open(atEnd ? 'last' : 0)
      .then(() => scroller.reset(atEnd))
  // One socket for the page, opened when something subscribes.
  const state = doc.querySelector<HTMLElement>('[data-live-state]')
  let client: LiveClient | undefined
  const live = (): LiveClient =>
    (client ??= new LiveClient(
      liveUrl(win.location),
      win.live,
      (now: LiveState) => {
        if (state == null) return
        state.hidden = now !== 'reconnecting' && now !== 'unavailable'
        state.textContent =
          now === 'reconnecting'
            ? 'Reconnecting…'
            : now === 'unavailable'
              ? 'Live updates are unavailable here: reload for the latest'
              : ''
      },
    ))
  if (head?.dataset.live === '1') {
    const stage =
      doc.querySelector<HTMLElement>('.stage-panel')?.dataset.stage ?? ''
    const start = doc.querySelector<HTMLElement>('[data-log]')?.dataset.offset
    const offset = start === 'tail' ? 'tail' : Number(start ?? -1)
    const page = domRunPage(
      doc,
      () => win.location.assign(win.location.href),
      scroller,
      logBox,
    )
    const run = new RunLive(
      page,
      head.dataset.run ?? '',
      stage === '' ? undefined : stage,
      offset,
    )
    live().subscribe(
      'run',
      () => run.message(),
      (frame) => run.apply(frame),
    )
  }
  if (head == null) liveRuns(doc, live)
}

/** Runs whose status may still change. */
const ACTIVE = new Set(['queued', 'running'])

/** Draws a run's status on each of its chips and rows. */
export function markRun(doc: Document, id: string, status: string): void {
  for (const node of doc.querySelectorAll<HTMLElement>(
    `[data-run-id="${quoted(id)}"]`,
  )) {
    node.dataset.status = status
    const dot = node.querySelector('.dot')
    if (dot != null) dot.className = `dot ${status}`
    const text = node.querySelector('[data-status-text]')
    if (text != null) text.textContent = status
    const title = node.getAttribute('title')
    if (title != null) node.setAttribute('title', title.replace(/\S+$/, status))
  }
}

/**
 * The dashboard's and a project's Runs and builds tab's live parts: the
 * queue panel, redrawn from `queue` events, and each unfinished run's chip
 * or row, kept at its status by its `run` events. A run the queue names
 * that its project's card has no chip for gets one, in place of its
 * branch's last.
 */
export function liveRuns(doc: Document, live: () => LiveClient): void {
  const watched = new Set<string>()
  const watch = (id: string, status: string): void => {
    if (watched.has(id) || !ACTIVE.has(status)) return
    watched.add(id)
    live().subscribe(
      `status:${id}`,
      () => ({ subscribe: 'status', run: id }),
      (frame) => {
        if (frame.event === 'run')
          markRun(doc, id, String((frame.data as { status: unknown }).status))
      },
    )
  }
  for (const node of doc.querySelectorAll<HTMLElement>('[data-run-id]'))
    watch(node.dataset.runId ?? '', node.dataset.status ?? '')
  const list = doc.querySelector('[data-queue] ul')
  if (list == null) return
  live().subscribe(
    'queue',
    () => ({ subscribe: 'queue' }),
    (frame) => {
      if (frame.event !== 'queue') return
      const entries = frame.data as QueueEntry[]
      list.innerHTML = queueItems(entries)
      for (const entry of entries) {
        const runs = doc.querySelector(
          `[data-project-runs="${quoted(entry.project)}"]`,
        )
        // A build chip of the run, in an app ID's row, is not the header's run chip.
        if (
          runs == null ||
          runs.querySelector(`[data-run-id="${quoted(entry.job)}"]`) != null
        )
          continue
        runs.querySelector(`[data-branch="${quoted(entry.branch)}"]`)?.remove()
        const status = entry.status === 'queued' ? 'queued' : 'running'
        runs.insertAdjacentHTML(
          'afterbegin',
          runChip({
            id: entry.job,
            branch: entry.branch,
            number: entry.number,
            status,
            workflow: entry.workflow,
          }),
        )
        watch(entry.job, status)
      }
    },
  )
}

if (typeof document !== 'undefined' && typeof window !== 'undefined')
  start(document, {
    fetch: window.fetch.bind(window),
    location: window.location,
    live: {
      open: (url) => new WebSocket(url) as unknown as LiveSocket,
      setTimeout: (run, ms) => window.setTimeout(run, ms),
      clearTimeout: (timer) => window.clearTimeout(timer as number),
    },
  })
