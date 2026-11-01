import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { FakeLiveWindow } from '../test/fakeLiveSocket.js'
import {
  actionBody,
  domRunPage,
  formFields,
  formPath,
  highlight,
  logLines,
  nestedBody,
  requestBody,
  RunLive,
  start,
  submitAction,
  type RunPage,
  type RunWindow,
} from './run.js'

/** An element whose queries answer from a table of selectors. */
class El {
  children = new Map<string, El[]>()
  listeners = new Map<string, Array<(event: unknown) => void>>()
  attributes = new Map<string, string>()
  dataset: Record<string, string | undefined> = {}
  classes = new Set<string>()
  textContent = ''
  innerHTML = ''
  hidden = true
  value = ''
  checked = false
  childElementCount = 0
  scrollHeight = 100
  scrollTop = 0
  clientHeight = 50
  fullscreen = false
  named = new Map<string, El>()
  constructor(attributes: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(attributes))
      this.setAttribute(name, value)
  }
  get className(): string {
    return this.getAttribute('class') ?? ''
  }
  set className(value: string) {
    this.setAttribute('class', value)
  }
  get classList(): {
    toggle: (name: string, on?: boolean) => void
    add: (name: string) => void
    remove: (name: string) => void
  } {
    return {
      toggle: (name, on): void => {
        if (on ?? !this.classes.has(name)) this.classes.add(name)
        else this.classes.delete(name)
      },
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
    }
  }
  get elements(): { namedItem: (name: string) => El | null } {
    return { namedItem: (name) => this.named.get(name) ?? null }
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
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
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  fire(
    type: string,
    event: unknown = { preventDefault: () => undefined },
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  insertAdjacentHTML(_where: string, html: string): void {
    this.innerHTML += html
    this.childElementCount++
  }
  async requestFullscreen(): Promise<void> {
    this.fullscreen = true
  }
  removed = false
  remove(): void {
    this.removed = true
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve))
}
const reply = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => String(body),
  }) as unknown as Response

function form(
  path: string,
  fields: Record<string, string>,
  data: Record<string, string> = {},
): El {
  const element = new El()
  element.dataset = {
    mason: 'api',
    path,
    fields: Object.keys(fields).join(','),
    ...data,
  }
  for (const [name, value] of Object.entries(fields)) {
    const input = new El()
    input.value = value
    element.named.set(name, input)
  }
  element.set('[data-field="status"]', new El())
  return element
}

describe('Run view script', () => {
  it('builds request bodies: run actions with parameters, nested fields, JSON fields and checked app IDs', () => {
    assert.deepEqual(
      actionBody({ project: 'p', branch: 'b', workflow: 'w', seat: '1' }),
      { project: 'p', branch: 'b', workflow: 'w', params: { seat: '1' } },
    )
    assert.deepEqual(actionBody({ stage: 's', approve: 'false' }), {
      stage: 's',
      approve: false,
    })
    assert.deepEqual(
      nestedBody({
        name: 'Ada',
        'addresses.google': 'a@example.test',
        'addresses.work': '',
      }),
      { name: 'Ada', addresses: { google: 'a@example.test' } },
    )
    const people = form('/api/v2/people', { name: 'Ada' })
    assert.deepEqual(requestBody(people as unknown as HTMLFormElement), {
      name: 'Ada',
    })
    const approve = form('/api/v2/runs/r/approve', {
      stage: 's',
      approve: 'true',
      notes: 'ok',
    })
    assert.deepEqual(requestBody(approve as unknown as HTMLFormElement), {
      stage: 's',
      approve: true,
      params: { notes: 'ok' },
    })
    const settings = form('/api/v2/settings/host', {}, { json: 'value' })
    const textarea = new El()
    textarea.value = '{"origin":"https://b.example.test"}'
    settings.named.set('value', textarea)
    assert.deepEqual(requestBody(settings as unknown as HTMLFormElement), {
      origin: 'https://b.example.test',
    })
    const wizard = form('/api/v2/projects/p/wizard/apps', {
      team: 'TEAM000000',
    })
    const on = new El({ value: 'a.b' })
    on.value = 'a.b'
    on.checked = true
    const off = new El()
    off.value = 'c.d'
    wizard.set('input[type="checkbox"][name="app"]', on, off)
    assert.deepEqual(formFields(wizard as unknown as HTMLFormElement), {
      team: 'TEAM000000',
      apps: 'a.b',
    })
    assert.deepEqual(logLines('', 1), [])
    assert.deepEqual(logLines('\x1b[32mok\x1b[0m\nnext\n', 4), [
      '<span class="line" data-line="4"><span class="ansi-green">ok</span></span>',
      '<span class="line" data-line="5">next</span>',
    ])
  })

  it('sends actions with the CSRF proof, then opens the new run, reloads, or continues the wizard', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const answers: Response[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return answers.shift()!
    }) as typeof fetch
    const visits: string[] = []
    const go = (href: string): void => {
      visits.push(href)
    }
    answers.push(reply(202, { id: 'r9' }))
    assert.equal(
      await submitAction(
        form(
          '/api/v2/runs',
          { project: 'p', branch: 'b' },
          { then: 'run' },
        ) as unknown as HTMLFormElement,
        'proof',
        fetcher,
        go,
        '/here',
      ),
      undefined,
    )
    assert.equal(
      (calls[0]!.init.headers as Record<string, string>)['x-mason-csrf'],
      'proof',
    )
    assert.equal(calls[0]!.init.body, '{"project":"p","branch":"b"}')
    answers.push(reply(200, {}))
    await submitAction(
      form(
        '/api/v2/keys/k',
        {},
        { method: 'DELETE', then: 'reload' },
      ) as unknown as HTMLFormElement,
      'proof',
      fetcher,
      go,
      '/here',
    )
    assert.equal(calls[1]!.init.method, 'DELETE')
    assert.equal(calls[1]!.init.body, undefined)
    answers.push(reply(403, { error: 'Not allowed for the developer role' }))
    assert.equal(
      await submitAction(
        form('/api/v2/runs/r/cancel', {}) as unknown as HTMLFormElement,
        'proof',
        fetcher,
        go,
      ),
      'Not allowed for the developer role',
    )
    answers.push(reply(500, 'not json'))
    assert.equal(
      await submitAction(
        form('/x', {}) as unknown as HTMLFormElement,
        '',
        fetcher,
        go,
      ),
      'Request failed (500)',
    )
    answers.push(
      reply(200, {
        slug: 'repo',
        repository: 'git@github.com:o/repo.git',
        defaultBranch: 'main',
      }),
      reply(200, {}),
    )
    await submitAction(
      form(
        '/api/v2/projects/check',
        { repository: 'git@github.com:o/repo.git' },
        { then: 'wizard' },
      ) as unknown as HTMLFormElement,
      'proof',
      fetcher,
      go,
    )
    assert.equal(calls.at(-1)!.url, '/api/v2/projects/repo')
    assert.equal(calls.at(-1)!.init.method, 'PUT')
    assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), {
      name: 'repo',
      repository: 'git@github.com:o/repo.git',
      defaultBranch: 'main',
      format: 'pipeline',
    })
    answers.push(reply(200, { slug: 'repo' }), reply(400, { error: 'taken' }))
    assert.equal(
      await submitAction(
        form(
          '/api/v2/projects/check',
          {},
          { then: 'wizard' },
        ) as unknown as HTMLFormElement,
        '',
        fetcher,
        go,
      ),
      'taken',
    )
    answers.push(reply(200, { slug: 'repo' }), reply(400, 'x'))
    assert.equal(
      await submitAction(
        form(
          '/api/v2/projects/check',
          {},
          { then: 'wizard' },
        ) as unknown as HTMLFormElement,
        '',
        fetcher,
        go,
      ),
      'Request failed (400)',
    )
    assert.deepEqual(visits, ['/runs/r9', '/here', '/projects/new?slug=repo'])
  })

  it('applies live frames to the page: run status, stages, the shown stage’s steps and its log, following the running stage', () => {
    const recorded: string[] = []
    const page: RunPage = {
      hasStage: (name) => name !== 'new',
      reload: () => recorded.push('reload'),
      setStageStatus: (name, status) => recorded.push(`${name}=${status}`),
      setRunStatus: (status) => recorded.push(`run=${status}`),
      follow: (stage) => recorded.push(`follow=${stage}`),
      setSteps: (stage, steps) =>
        recorded.push(`steps ${stage}=${steps.length}`),
      appendLog: (html) => recorded.push(`log=${html.length}`),
      ended: () => recorded.push('ended'),
    }
    const step = {
      id: 1,
      kind: 'exec',
      title: 'x',
      status: 'running',
      ms: null,
    }
    // A page with a stage selected resumes its log after the offset it has.
    const selected = new RunLive(page, 'r', 'a', 12)
    assert.deepEqual(selected.message(), {
      subscribe: 'run',
      run: 'r',
      stage: 'a',
      after: 12,
    })
    selected.apply({ event: 'run', data: { status: 'running' } })
    selected.apply({
      event: 'stages',
      data: [{ name: 'a', status: 'running' }],
    })
    selected.apply({ event: 'steps', data: { stage: 'a', steps: [step] } })
    selected.apply({ event: 'steps', data: { stage: 'b', steps: [step] } })
    selected.apply({
      event: 'log',
      data: { stage: 'a', offset: 16, first: 3, text: 'a\nb\n' },
    })
    selected.apply({
      event: 'log',
      data: { stage: 'b', offset: 99, first: 1, text: 'other\n' },
    })
    assert.equal(selected.message().after, 16)
    // A stage the page does not draw yet (setup just made it) reloads the page.
    selected.apply({
      event: 'stages',
      data: [{ name: 'new', status: 'queued' }],
    })
    selected.apply({ event: 'end' })
    selected.apply({ event: 'other' })
    assert.deepEqual(recorded.splice(0), [
      'run=running',
      'a=running',
      'steps a=1',
      'log=2',
      'reload',
      'ended',
    ])
    // With none selected the panel follows the running stage, and switches.
    const following = new RunLive(page, 'r', undefined, 0)
    assert.deepEqual(following.message(), {
      subscribe: 'run',
      run: 'r',
      follow: true,
    })
    following.apply({ event: 'steps', data: { stage: 'a', steps: [] } })
    following.apply({
      event: 'log',
      data: { stage: 'a', offset: 4, first: 7, text: 'x\n' },
    })
    assert.deepEqual(following.message(), {
      subscribe: 'run',
      run: 'r',
      stage: 'a',
      after: 4,
      follow: true,
    })
    following.apply({ event: 'steps', data: { stage: 'a', steps: [step] } })
    following.apply({ event: 'steps', data: { stage: 'b', steps: [] } })
    following.apply({ event: 'gone' })
    assert.deepEqual(recorded.splice(0), [
      'follow=a',
      'steps a=0',
      'log=1',
      'steps a=1',
      'follow=b',
      'steps b=0',
      'ended',
    ])
    assert.equal(following.message().after, 0)
    // A step's lines take no more: the page asks for no log at all.
    const step2 = new RunLive(page, 'r', 'a', -1)
    assert.deepEqual(step2.message(), {
      subscribe: 'run',
      run: 'r',
      stage: 'a',
      log: false,
    })
    step2.apply({
      event: 'log',
      data: { stage: 'a', offset: 4, first: 1, text: 'x\n' },
    })
    assert.deepEqual(recorded, [])
    // A page with none of the log (the host's) starts at its end, then resumes by offset.
    const tail = new RunLive(page, 'r', 'a', 'tail')
    assert.deepEqual(tail.message(), {
      subscribe: 'run',
      run: 'r',
      stage: 'a',
      tail: true,
    })
    // A line longer than a frame comes in pieces, drawn once it is whole.
    tail.apply({
      event: 'log',
      data: {
        stage: 'a',
        offset: 90,
        first: 40,
        text: 'x\nlong',
        partial: true,
      },
    })
    assert.deepEqual(recorded, [])
    assert.equal(tail.message().after, 90)
    tail.apply({
      event: 'log',
      data: { stage: 'a', offset: 99, first: 41, text: ' line\n' },
    })
    assert.deepEqual(recorded.splice(0), ['log=2'])

    const bubble = new El({ class: 'bubble stage status-queued' })
    const item = new El()
    const dot = new El({ class: 'dot queued' })
    item.set('.dot', dot)
    const status = new El()
    const steps = new El()
    const code = new El()
    const pre = new El()
    pre.scrollTop = 40
    const jump = new El()
    const title = new El()
    const head = new El()
    const panel = new El()
    panel.dataset.stage = 'build/ios'
    const doc = new El()
      .set('.stage-panel', panel)
      .set('.bubble[data-stage="build/ios"]', bubble)
      .set('.stage-list li[data-name="build/ios"]', item)
      .set('[data-run-status]', status)
      .set('[data-steps]', steps)
      .set('[data-log] code', code)
      .set('[data-log] pre', pre)
      .set('.run-head', head)
      .set('[data-jump]', jump)
      .set('[data-log-title]', title)
    let reloaded = 0
    const real = domRunPage(doc as unknown as Document, () => {
      reloaded++
    })
    assert(real.hasStage('build/ios'))
    assert(!real.hasStage('other'))
    real.reload()
    assert.equal(reloaded, 1)
    // The selected stage's panel was drawn while it was queued.
    panel.dataset.status = 'queued'
    real.setStageStatus('build/ios', 'succeeded')
    assert.equal(reloaded, 2)
    assert.equal(panel.dataset.status, 'succeeded')
    real.setStageStatus('build/ios', 'succeeded')
    assert.equal(reloaded, 2)
    assert.equal(bubble.getAttribute('class'), 'bubble stage status-succeeded')
    assert.equal(item.dataset.status, 'succeeded')
    assert.equal(dot.className, 'dot succeeded')
    real.setRunStatus('awaiting_approval')
    assert.equal(status.className, 'state-awaiting_approval')
    assert.match(status.innerHTML, /awaiting approval/)
    real.setRunStatus('<b>x')
    assert.match(status.innerHTML, /&lt;b&gt;x/)
    assert.doesNotMatch(status.innerHTML, /<b>/)
    real.setSteps('build/ios', [
      {
        id: 2,
        kind: 'exec',
        title: 'npm <test> \x1b[32mok\x1b[0m',
        status: 'succeeded',
        ms: 4000,
      },
      { id: 3, kind: 'section', title: 'x', status: 'running', ms: null },
    ])
    assert.match(steps.innerHTML, /href="\?stage=build%2Fios&amp;step=2"/)
    assert.match(steps.innerHTML, /npm &lt;test&gt; ok</)
    assert.match(steps.innerHTML, /exec · 4s/)
    // The log opened at its end, and follows new lines there.
    assert.equal(pre.scrollTop, 100)
    real.appendLog([])
    pre.scrollHeight = 300
    real.appendLog(['<span>one</span>'])
    real.appendLog(['<span>two</span>'])
    assert.equal(code.innerHTML, '<span>one</span><span>two</span>')
    assert.equal(pre.scrollTop, 300)
    // Scrolled up, it holds still and offers Jump to latest.
    pre.scrollHeight = 1000
    pre.scrollTop = 100
    pre.fire('scroll')
    assert.equal(jump.hidden, false)
    real.appendLog(['<span>three</span>'])
    assert.equal(pre.scrollTop, 100)
    // A small move up stops it too, though still near the bottom.
    pre.scrollTop = 900
    pre.fire('scroll')
    pre.scrollTop = 880
    pre.fire('scroll')
    assert.equal(jump.hidden, false)
    real.appendLog(['<span>late</span>'])
    assert.equal(pre.scrollTop, 880)
    pre.scrollTop = 100
    pre.fire('scroll')
    // A taller window moves the log up but leaves it at the bottom: it follows on.
    pre.scrollTop = 950
    pre.fire('scroll')
    pre.clientHeight = 100
    pre.scrollTop = 900
    pre.fire('scroll')
    assert.equal(jump.hidden, true)
    pre.clientHeight = 50
    pre.scrollTop = 100
    pre.fire('scroll')
    // Back within 80px of the bottom, it follows again.
    pre.scrollTop = 900
    pre.fire('scroll')
    assert.equal(jump.hidden, true)
    pre.scrollHeight = 1200
    real.appendLog(['<span>four</span>'])
    assert.equal(pre.scrollTop, 1200)
    pre.scrollTop = 0
    pre.fire('scroll')
    jump.fire('click')
    assert.deepEqual([pre.scrollTop, jump.hidden], [1200, true])
    pre.scrollHeight = 1300
    real.appendLog(['<span>five</span>'])
    assert.equal(pre.scrollTop, 1300)
    // Following a stage relabels the panel and starts its log afresh.
    pre.scrollTop = 0
    pre.fire('scroll')
    steps.hidden = true
    real.follow('deploy')
    assert.match(
      title.innerHTML,
      /dot running.*deploy.*following the running stage/,
    )
    assert.deepEqual(
      [title.dataset.following, steps.hidden, code.innerHTML, jump.hidden],
      ['deploy', false, '', true],
    )
    real.setStageStatus('deploy', 'failed')
    assert.match(title.innerHTML, /dot failed/)
    real.ended()
    assert.equal(head.getAttribute('data-live'), '0')
    // The host's page has no run log; following a stage gives it one.
    const box = new El()
    const notice = new El()
    const hosted = domRunPage(
      new El()
        .set('[data-log]', box)
        .set('[data-log] .empty-state', notice) as unknown as Document,
    )
    hosted.follow('deploy')
    assert.equal(box.innerHTML, '<pre class="log"><code></code></pre>')
    assert(notice.removed)
    const empty = domRunPage(new El() as unknown as Document)
    empty.setRunStatus('x')
    empty.setSteps('x', [])
    empty.follow('x')
    empty.appendLog(['x'])
    empty.ended()
  })

  it('highlights a bubble’s inputs, dependents and rails', () => {
    const a = new El({
      'data-stage': 'a',
      'data-needs': '',
      'data-dependents': 'b',
    })
    const b = new El({
      'data-stage': 'b',
      'data-needs': 'a',
      'data-dependents': '',
    })
    const c = new El({
      'data-stage': 'c',
      'data-needs': '',
      'data-dependents': '',
    })
    const rail = new El({ 'data-from': 'a', 'data-to': 'b' })
    const other = new El({ 'data-from': 'c', 'data-to': '@end' })
    const svg = new El()
      .set('.bubble[data-stage="b"]', b)
      .set('.bubble, .rail', a, b, c, rail, other)
      .set('.bubble', a, b, c)
      .set('.rail', rail, other)
    highlight(svg as unknown as Element, 'b')
    assert(svg.classes.has('focused'))
    assert.deepEqual(
      [a, b, c, rail, other].map((node) => node.classes.has('related')),
      [true, true, false, true, false],
    )
    highlight(svg as unknown as Element, 'missing')
    highlight(svg as unknown as Element, undefined)
    assert(!svg.classes.has('focused'))
    assert(!a.classes.has('related'))
  })

  it('wires forms, the log wrap, the stage filters, zoom, hover, a fetched log, the live stream and the queue', async () => {
    const action = form('/api/v2/runs/r/cancel', {}, { then: 'reload' })
    const failing = form('/x', {})
    const wrap = new El()
    const log = new El()
    const filter = new El()
    const status = new El()
    const first = new El()
    first.dataset = { name: 'build/ios', status: 'running' }
    const second = new El()
    second.dataset = { name: 'test', status: 'succeeded' }
    const svg = new El({ width: '200', height: '100' })
    const bubble = new El({
      'data-stage': 'test',
      'data-needs': '',
      'data-dependents': '',
    })
    bubble.dataset.stage = 'test'
    svg
      .set('.bubble[data-stage]', bubble)
      .set('.bubble.selected', bubble)
      .set('.bubble', bubble)
      .set('.bubble, .rail', bubble)
      .set('.bubble[data-stage="test"]', bubble)
    const zoom = (kind: string): El => {
      const button = new El()
      button.dataset.zoom = kind
      return button
    }
    const buttons = ['in', 'out', 'reset', 'full'].map(zoom)
    const graphPanel = new El()
    const sourceCode = new El()
    const source = new El().set('code', sourceCode)
    source.dataset.src = '/api/v2/runs/r/logs?stage=test&step=1'
    const head = new El()
    head.dataset = { live: '1', run: 'r' }
    const panel = new El()
    panel.dataset.stage = 'test'
    const logBox = new El()
    logBox.dataset.offset = '12'
    const runStatus = new El()
    const liveState = new El()
    const csrf = new El()
    ;(csrf as unknown as { content: string }).content = 'proof'
    const doc = new El()
      .set('meta[name="mason-csrf"]', csrf)
      .set('form[data-mason="api"]', action, failing)
      .set('[data-wrap]', wrap)
      .set('.log', log)
      .set('[data-stage-filter]', filter)
      .set('[data-status-filter]', status)
      .set('.stage-list li[data-name]', first, second)
      .set('.pipeline-graph', svg)
      .set('[data-zoom]', ...buttons)
      .set('.graph-panel', graphPanel)
      .set('[data-log][data-src]', source)
      .set('.run-head', head)
      .set('.stage-panel', panel)
      .set('[data-log]', logBox)
      .set('[data-run-status]', runStatus)
      .set('[data-live-state]', liveState)
    const streams: Array<{
      url: string
      listeners: Map<string, (event: { data: string }) => void>
      closed: boolean
    }> = []
    const fetched: string[] = []
    const visits: string[] = []
    const live = new FakeLiveWindow()
    const win: RunWindow = {
      fetch: (async (url: string) => {
        fetched.push(url)
        if (url === '/x') throw new Error('offline')
        if (url.includes('/logs')) return reply(200, 'line one\nline two\n')
        return reply(200, {})
      }) as typeof fetch,
      location: {
        href: '/runs/r?stage=test',
        protocol: 'https:',
        host: 'mason.example',
        assign: (href) => visits.push(href),
      },
      live,
      EventSource: class {
        listeners = new Map<string, (event: { data: string }) => void>()
        closed = false
        constructor(readonly url: string) {
          streams.push(this as unknown as (typeof streams)[number])
        }
        addEventListener(
          type: string,
          listener: (event: { data: string }) => void,
        ): void {
          this.listeners.set(type, listener)
        }
        close(): void {
          this.closed = true
        }
      },
      DOMParser: class {
        parseFromString(): Document {
          return new El() as unknown as Document
        }
      },
    }
    start(doc as unknown as Document, win)
    action.fire('submit')
    failing.fire('submit')
    await settle()
    assert.deepEqual(visits, ['/runs/r?stage=test'])
    assert.equal(action.querySelector('[data-field="status"]')!.textContent, '')
    assert.equal(
      failing.querySelector('[data-field="status"]')!.textContent,
      'offline',
    )
    wrap.checked = true
    wrap.fire('change')
    assert(log.classes.has('wrap'))
    filter.value = 'IOS'
    filter.fire('input')
    assert.deepEqual([first.hidden, second.hidden], [false, true])
    status.value = 'succeeded'
    status.fire('change')
    assert.deepEqual([first.hidden, second.hidden], [true, true])
    for (const button of buttons) button.fire('click')
    assert.equal(svg.getAttribute('width'), '200')
    buttons[0]!.fire('click')
    assert.equal(svg.getAttribute('width'), '250')
    assert(graphPanel.fullscreen)
    bubble.fire('mouseenter')
    bubble.fire('mouseleave')
    assert(bubble.classes.has('related'))
    assert.equal(
      sourceCode.innerHTML,
      '<span class="line" data-line="1">line one</span><span class="line" data-line="2">line two</span>',
    )
    // The run's socket resumes the log after the offset the page has.
    const socket = live.socket
    assert.equal(socket.url, 'wss://mason.example/live')
    socket.accept()
    assert.deepEqual(socket.sent, [
      { subscribe: 'run', run: 'r', stage: 'test', after: 12, key: 'run' },
    ])
    socket.frame({ key: 'run', event: 'run', data: { status: 'failed' } })
    assert.equal(runStatus.className, 'state-failed')
    // A dropped socket says so, and resubscribes once it is back.
    socket.drop(1012)
    assert.deepEqual(
      [liveState.hidden, liveState.textContent],
      [false, 'Reconnecting…'],
    )
    assert.equal(live.tick(), 1000)
    live.socket.accept()
    assert.equal(liveState.hidden, true)
    assert.equal(live.sockets.length, 2)
    live.socket.frame({ key: 'run', event: 'end' })
    assert(live.socket.closed)

    // The dashboard: the queue panel reloads after the first snapshot.
    const queue = new El()
    queue.innerHTML = 'old'
    const fresh = new El()
    fresh.innerHTML = 'new'
    const dashboard = new El().set('[data-queue]', queue)
    start(dashboard as unknown as Document, {
      ...win,
      fetch: (async () =>
        reply(200, '<html></html>')) as unknown as typeof fetch,
      DOMParser: class {
        parseFromString(): Document {
          return new El().set('[data-queue]', fresh) as unknown as Document
        }
      },
    })
    const queueStream = streams[0]!
    assert.equal(queueStream.url, '/api/v2/queue/events')
    queueStream.listeners.get('queue')!({ data: '[]' })
    await settle()
    assert.equal(queue.innerHTML, 'old')
    queueStream.listeners.get('queue')!({ data: '[1]' })
    await settle()
    assert.equal(queue.innerHTML, 'new')
    // A run page without a selected stage follows the running one.
    const plain = new El().set('.run-head', head)
    start(plain as unknown as Document, win)
    live.socket.accept()
    assert.deepEqual(live.socket.sent, [
      { subscribe: 'run', run: 'r', follow: true, key: 'run' },
    ])
    // A finished run's page opens no socket.
    const sockets = live.sockets.length
    head.dataset.live = '0'
    start(plain as unknown as Document, win)
    assert.equal(live.sockets.length, sockets)
  })
})

describe('Typed form fields', () => {
  /** A form whose inputs carry `data-kind`, `data-optional` and `checked`. */
  const typed = (
    path: string,
    inputs: Record<
      string,
      { value?: string; kind?: string; optional?: boolean; checked?: boolean }
    >,
    data: Record<string, string> = {},
  ): HTMLFormElement => {
    const element = form(
      path,
      Object.fromEntries(
        Object.entries(inputs).map(([name, input]) => [
          name,
          input.value ?? '',
        ]),
      ),
      data,
    )
    for (const [name, input] of Object.entries(inputs)) {
      const el = element.named.get(name)!
      el.dataset = {
        ...(input.kind == null ? {} : { kind: input.kind }),
        ...(input.optional === true ? { optional: '' } : {}),
      }
      el.checked = input.checked ?? false
    }
    return element as unknown as HTMLFormElement
  }

  it('U1.1 a number field sends a number, and an empty one is left out', () => {
    assert.deepEqual(
      requestBody(
        typed('/api/v2/x', {
          hours: { value: ' 12 ', kind: 'number' },
          disk: { value: '', kind: 'number' },
          'a.size': { value: '2.5', kind: 'number' },
        }),
      ),
      { hours: 12, a: { size: 2.5 } },
    )
  })

  it('U1.2 a list field splits commas and new lines, trims and drops empties', () => {
    assert.deepEqual(
      requestBody(
        typed('/api/v2/x', {
          apt: { value: 'jq, curl\n git ,,\n', kind: 'list' },
          brew: { value: '', kind: 'list' },
        }),
      ),
      { apt: ['jq', 'curl', 'git'], brew: [] },
    )
  })

  it('U1.3 a checkbox sends true or false, and untyped fields stay text', () => {
    assert.deepEqual(
      requestBody(
        typed('/api/v2/x', {
          on: { kind: 'checkbox', checked: true },
          off: { kind: 'checkbox' },
          name: { value: 'n' },
          empty: { value: '' },
          'nested.empty': { value: '' },
        }),
      ),
      { on: true, off: false, name: 'n', empty: '' },
    )
  })

  it('U1.4 numeric path parts build arrays, and gaps close up', () => {
    assert.deepEqual(
      requestBody(
        typed('/api/v2/x', {
          'methods.0.id': { value: 'a' },
          'methods.2.id': { value: 'c' },
          'methods.2.on': { kind: 'checkbox', checked: true },
        }),
      ),
      { methods: [{ id: 'a' }, { id: 'c', on: true }] },
    )
  })

  it('U1.5 an empty secret keeps the stored one, and typed text replaces it', () => {
    assert.deepEqual(
      requestBody(
        typed('/api/v2/x', {
          token: { value: '', kind: 'secret' },
          'claims.secret': { value: '', kind: 'secret' },
          other: { value: 's3cret', kind: 'secret' },
        }),
      ),
      {
        token: { keep: true },
        claims: { secret: { keep: true } },
        other: 's3cret',
      },
    )
  })

  it('U1.6 an empty optional field is left out at any depth', () => {
    assert.deepEqual(
      requestBody(
        typed('/api/v2/x', {
          workerOrigin: { value: '', optional: true },
          origin: { value: 'https://a.example' },
          'claims.email': { value: ' ', optional: true },
          'claims.subject': { value: 'sub', optional: true },
          plain: { value: '' },
        }),
      ),
      { origin: 'https://a.example', claims: { subject: 'sub' }, plain: '' },
    )
  })

  it('U1.7 braces in the path are filled from fields, URL-encoded', async () => {
    const named = typed('/api/v2/settings/nodeTypes/{name}', {
      name: { value: 'mac arm/1' },
      'software.node': { value: '24' },
    })
    assert.equal(formPath(named), '/api/v2/settings/nodeTypes/mac%20arm%2F1')
    assert.equal(
      formPath(typed('/api/v2/plain', { a: { value: 'x' } })),
      '/api/v2/plain',
    )
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return reply(200, {})
    }) as typeof fetch
    await submitAction(named, 'proof', fetcher, () => undefined)
    assert.equal(calls[0]!.url, '/api/v2/settings/nodeTypes/mac%20arm%2F1')
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      name: 'mac arm/1',
      software: { node: '24' },
    })
  })

  it('U1.8 a DELETE sends its fields as the body, and a fieldless DELETE sends none', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return reply(200, {})
    }) as typeof fetch
    await submitAction(
      typed(
        '/api/v2/cloud/hosts/h',
        { confirm: { value: 'h' }, deleteSpace: { value: 'keep' } },
        { method: 'DELETE' },
      ),
      'proof',
      fetcher,
      () => undefined,
    )
    await submitAction(
      typed('/api/v2/keys/k', {}, { method: 'DELETE' }),
      'proof',
      fetcher,
      () => undefined,
    )
    assert.equal(calls[0]!.init.method, 'DELETE')
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      confirm: 'h',
      deleteSpace: 'keep',
    })
    assert.equal(calls[1]!.init.body, undefined)
  })

  it('U5.3 a created key’s token is shown once in the form, with Copy', async () => {
    const created = typed(
      '/api/v2/keys',
      { name: { value: 'ci' }, role: { value: 'developer' } },
      { then: 'token' },
    ) as unknown as El
    const box = new El()
    const pre = new El()
    const copy = new El()
    box.set('pre', pre).set('button[data-copy]', copy)
    created.set('[data-field="token"]', box)
    const visits: string[] = []
    const fetcher = (async () =>
      reply(201, {
        id: 'k1',
        token: 'mason_v1_abc.secret',
      })) as unknown as typeof fetch
    assert.equal(
      await submitAction(
        created as unknown as HTMLFormElement,
        'proof',
        fetcher,
        (href) => visits.push(href),
      ),
      undefined,
    )
    assert.equal(box.hidden, false)
    assert.equal(pre.textContent, 'mason_v1_abc.secret')
    assert.equal(copy.dataset.copy, 'mason_v1_abc.secret')
    assert.deepEqual(visits, [], 'the page stays, so the token can be copied')
  })
})
