import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { after, afterEach, before, describe, it } from 'mocha'
import {
  nodeInfo,
  renderApp,
  sessionFor,
  shellReplies,
  until,
  where,
} from '../../test/render.js'
import { fakeLogLayout } from '../../test/layout.js'
import {
  heading,
  logOf,
  open,
  RUN_PATH,
  runFixture,
  text,
} from '../../test/runs.js'
import { HOST_WHOLE_RUN } from './RunPage.js'

afterEach(() => cleanup())

describe('Run page', () => {
  let restore: () => void
  before(() => {
    restore = fakeLogLayout()
  })
  after(() => restore())

  it('draws a finished run: build and run, status, when, where, commit, trigger and requester, description, parameters, crumbs and history', async () => {
    open('/runs/r1', { [RUN_PATH]: runFixture() })
    await heading('Build 26110902')
    assert.equal(document.title, 'Build 26110902 · Run 182 · Mason')
    assert.deepEqual([...document.querySelectorAll('.m-crumbs li')].map(text), [
      'Mason Master',
      'Projects & apps',
      'Fixture',
      'Runs and builds',
      'paul/offlineCache',
      'Run 182',
    ])
    assert.equal(
      screen
        .getByRole('link', { name: 'paul/offlineCache' })
        .getAttribute('href'),
      '/projects/fixture/runs?branch=paul%2FofflineCache',
    )
    const header = document.querySelector<HTMLElement>('.m-page__header')!
    within(header).getByText('Run 182')
    within(header).getByText('Succeeded')
    const meta = text(header.querySelector('.m-run__meta')!)
    assert.match(meta, /queued 12s/)
    assert.match(meta, /took 6m 37s/)
    assert.match(meta, /on bern, mason-android-1771/)
    assert.match(meta, /Push by Paul Puey/)
    assert.equal(
      header.querySelector('.m-commit__sha')!.textContent,
      'ec24b917',
    )
    within(header).getByText('Fix player socket rehydration on device resume')
    const params = header.querySelector('details.m-run__params')!
    assert.match(params.textContent!, /Parameters \(2\)/)
    assert.match(
      params.textContent!,
      /channel = "testflight"\nnotes = "Offline cache"/,
    )
    // Finished: no Cancel; Request run for whoever may request.
    assert.equal(screen.queryByRole('button', { name: /Cancel run/ }), null)
    screen.getByRole('button', { name: /Request run/ })
    // History: this run marked, each stage dot named.
    const history = screen
      .getByRole('heading', { name: /History of/ })
      .closest('section')!
    const rows = within(history).getAllByRole('row').slice(1)
    assert.equal(rows[0]!.getAttribute('aria-selected'), 'true')
    within(rows[0]!).getByRole('img', { name: 'build/ios: succeeded' })
    assert.equal(
      within(rows[1]!)
        .getByRole('link', { name: 'Run 176' })
        .getAttribute('href'),
      '/runs/r0',
    )
    // The whole run's log, from its start.
    await screen.findByText('line 1')
    screen.getByRole('region', { name: 'Whole run log' })
    assert.equal(
      screen.getByRole('link', { name: /Raw/ }).getAttribute('href'),
      '/api/v2/runs/r1/logs',
    )
    assert.equal(
      screen.getByRole('link', { name: /Plain text/ }).getAttribute('href'),
      '/api/v2/runs/r1/logs?plain=1',
    )
  })

  it('names a run without a build number by its run and workflow, a reason in its tone, and a requester by key', async () => {
    open('/runs/r1', {
      [RUN_PATH]: runFixture({
        workflow: 'nightly',
        status: 'failed',
        reason: 'build-ios failed: xcodebuild exited with code 65',
        details: {
          trigger: 'request',
          requestedBy: 'Paul Puey · key "TeamStation CI" (830f19)',
          buildNumber: null,
          params: {},
          nodes: [],
        },
        description: null,
        commit: null,
      }),
    })
    await heading('Run 182 · nightly')
    const header = document.querySelector<HTMLElement>('.m-page__header')!
    const reason = header.querySelector('.m-run__reason')!
    assert(reason.classList.contains('m-danger-text'))
    assert.match(
      text(header),
      /Requested by Paul Puey · key "TeamStation CI" \(830f19\)/,
    )
    assert.equal(header.querySelector('details'), null)
    assert.equal(header.querySelector('.m-commit__sha'), null)
    cleanup()
    open('/runs/r1', {
      [RUN_PATH]: runFixture({
        status: 'cancelled',
        reason: 'Not built: main is not in the push trigger’s branches',
        details: undefined,
      }),
    })
    await heading('Run 182')
    const cancelled = document.querySelector('.m-run__reason')!
    assert(cancelled.classList.contains('m-secondary'))
  })

  it('says a run does not exist, and offers to retry one that could not be read', async () => {
    open('/runs/none', {
      '/api/v2/runs/none?include=graph,steps,history,details': {
        status: 404,
        body: { error: 'Run not found' },
      },
    })
    await heading('Run unavailable')
    screen.getByRole('heading', { name: 'There is no such run' })
    assert.equal(
      within(document.querySelector<HTMLElement>('.m-empty')!)
        .getByRole('link', { name: 'Projects & apps' })
        .getAttribute('href'),
      '/projects',
    )
    cleanup()
    const app = open('/runs/r1', {
      [RUN_PATH]: { status: 500, body: { error: 'Disk full' } },
    })
    await screen.findByRole('heading', { name: 'The run could not be read' })
    screen.getByText('Disk full')
    app.node.set(RUN_PATH, runFixture())
    await act(async () => screen.getByRole('button', { name: 'Retry' }).click())
    await heading('Build 26110902')
    cleanup()
    open('/runs/r1', {
      [RUN_PATH]: () => new Promise<Response>(() => undefined),
    })
    await screen.findByRole('status', { name: 'Loading the run' })
  })

  it('selects a stage from its bubble: facts, nested steps of its attempt, artifacts, and a step’s own lines', async () => {
    const app = open('/runs/r1', { [RUN_PATH]: runFixture() })
    await heading('Build 26110902')
    const bubble = document.querySelector<SVGElement>(
      '.m-gbubble[data-stage="build/ios"]',
    )!
    assert.match(
      bubble.getAttribute('aria-label')!,
      /^build\/ios · succeeded · on mason-android-1771 · 4m 12s$/,
    )
    await act(async () => fireEvent.click(bubble))
    assert.equal(where.path, '/runs/r1?stage=build%2Fios')
    const panel = document.querySelector<HTMLElement>('.m-stagepanel')!
    await until(() => text(panel).includes('Attempt'), 'the facts')
    assert.match(text(panel.querySelector('.m-kv')!), /Took4m 12s/)
    assert.match(text(panel.querySelector('.m-kv')!), /Nodemason-android-1771/)
    assert.match(text(panel.querySelector('.m-kv')!), /Attempt2/)
    // The attempt's steps, each section followed by its own, indented.
    const steps = [...panel.querySelectorAll<HTMLElement>('.m-steps li')]
    assert.deepEqual(
      steps.map((li) => [li.dataset.step, li.dataset.depth]),
      [
        ['1', '0'],
        ['2', '0'],
        ['3', '1'],
      ],
    )
    assert.match(text(steps[0]!), /^npm ci, Succeededsh · 1:12$/)
    assert(steps[1]!.classList.contains('m-steps__section'))
    // Its artifacts link to where they download.
    assert.equal(
      within(panel)
        .getByRole('link', { name: 'TeamStation.ipa' })
        .getAttribute('href'),
      'https://host.test/runs/r1/artifacts/TeamStation.ipa',
    )
    within(panel).getByText('build · 84.1 MB')
    await until(
      () =>
        app.node.requests.includes(
          'GET /api/v2/runs/r1/logs?stage=build%2Fios&from=0&count=500',
        ),
      'the stage’s log from its start',
    )
    screen.getByRole('region', { name: 'Log of build/ios' })
    // A step shows only its lines, and links back to the whole log.
    await act(async () =>
      steps[2]!.querySelector('a')!.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      ),
    )
    assert.equal(where.path, '/runs/r1?stage=build%2Fios&step=3')
    await screen.findByRole('region', { name: 'Lines of this step' })
    await until(
      () =>
        app.node.requests.includes(
          'GET /api/v2/runs/r1/logs?stage=build%2Fios&step=3&from=0&count=500',
        ),
      'the step’s lines',
    )
    assert.equal(
      panel
        .querySelector('.m-steps li[data-step="3"] a')!
        .getAttribute('aria-current'),
      'true',
    )
    screen.getByRole('link', { name: 'The whole log of build/ios' })
  })

  it('says when a step does not exist, a run has no log, and retries a log that failed', async () => {
    const app = open('/runs/r1?stage=publish&step=9', {
      [RUN_PATH]: runFixture(),
      '/api/v2/runs/r1/logs': { status: 404, body: { error: 'No such step' } },
    })
    await screen.findByText('There is no such step.')
    cleanup()
    open('/runs/r1', {
      [RUN_PATH]: runFixture(),
      '/api/v2/runs/r1/logs': { status: 404, body: { error: 'Run not found' } },
    })
    await screen.findByText('This run has no log.')
    cleanup()
    const failing = open('/runs/r1', {
      [RUN_PATH]: runFixture(),
      '/api/v2/runs/r1/logs': {
        status: 502,
        body: { error: 'The link dropped' },
      },
    })
    await screen.findByText('The link dropped')
    failing.node.set('/api/v2/runs/r1/logs', logOf(3))
    await act(async () =>
      within(document.querySelector('.m-log')!)
        .getByRole('button', { name: /Retry/ })
        .click(),
    )
    await screen.findByText('line 3')
    void app
  })

  it('switches to the Timeline and back, keeping the stage, with the critical path outlined', async () => {
    open('/runs/r1?stage=publish', { [RUN_PATH]: runFixture() })
    await heading('Build 26110902')
    const timeline = screen.getByRole('button', { name: /Timeline/ })
    assert.equal(timeline.getAttribute('aria-pressed'), 'false')
    await act(async () => timeline.click())
    assert.equal(where.path, '/runs/r1?stage=publish&tab=timeline')
    const rows = [...document.querySelectorAll<HTMLElement>('.m-timeline__row')]
    assert.deepEqual(
      rows.map((row) => [row.dataset.stage, row.dataset.critical]),
      [
        ['checkout', ''],
        ['build/ios', ''],
        ['publish', ''],
      ],
    )
    assert.match(
      rows[1]!.querySelector('.m-sr')!.textContent!,
      /^build\/ios · 4m 12s · succeeded · critical path$/,
    )
    screen.getByText('Critical path')
    await act(async () => screen.getByRole('button', { name: /Graph/ }).click())
    assert.equal(where.path, '/runs/r1?stage=publish')
  })

  it('finds a stage in the list and narrows it by status; on narrow content a picker opens the list as a sheet', async () => {
    open('/runs/r1?stage=checkout', {
      [RUN_PATH]: runFixture({
        stages: [
          ...runFixture().stages,
          {
            name: 'notify',
            kind: 'stage',
            status: 'skipped',
            attempt: 1,
            started: null,
            finished: null,
          },
        ],
      }),
    })
    await heading('Build 26110902')
    const list = screen.getByRole('complementary', { name: 'Stages' })
    const names = (): string[] =>
      [...list.querySelectorAll<HTMLElement>('li[data-stage]')].map(
        (li) => li.dataset.stage!,
      )
    assert.deepEqual(names(), ['checkout', 'build/ios', 'publish', 'notify'])
    assert.equal(
      within(list)
        .getByRole('link', { name: /Whole run/ })
        .getAttribute('href'),
      '/runs/r1',
    )
    const ios = list.querySelector<HTMLElement>('li[data-stage="build/ios"] a')!
    assert.equal(ios.style.paddingLeft, 'calc(1rem + var(--m-space-4))')
    assert.match(text(ios), /^ios, Succeeded4:12$/)
    assert.match(text(list.querySelector('li[data-stage="notify"]')!), /—$/)
    assert.equal(
      list
        .querySelector('li[data-stage="checkout"] a')!
        .getAttribute('aria-current'),
      'true',
    )
    fireEvent.change(
      within(list).getByRole('searchbox', { name: 'Find a stage' }),
      {
        target: { value: 'IOS' },
      },
    )
    assert.deepEqual(names(), ['build/ios'])
    fireEvent.change(
      within(list).getByRole('searchbox', { name: 'Find a stage' }),
      {
        target: { value: '' },
      },
    )
    fireEvent.change(within(list).getByRole('combobox', { name: 'Status' }), {
      target: { value: 'skipped' },
    })
    assert.deepEqual(names(), ['notify'])
    fireEvent.change(within(list).getByRole('combobox', { name: 'Status' }), {
      target: { value: 'failed' },
    })
    within(list).getByText('No stage matches.')
    // The narrow picker names the stage and opens the same list.
    const picker = document.querySelector<HTMLButtonElement>('.m-stagepicker')!
    assert.match(text(picker), /Stagecheckout · Succeeded/)
    await act(async () => picker.click())
    const sheet = screen.getByRole('dialog', { name: 'Stages' })
    await act(async () =>
      within(sheet)
        .getByRole('link', { name: /publish/ })
        .dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        ),
    )
    assert.equal(where.path, '/runs/r1?stage=publish')
    assert.equal(screen.queryByRole('dialog', { name: 'Stages' }), null)
  })

  it('opens the log full screen, the same lines in a sheet', async () => {
    open('/runs/r1', { [RUN_PATH]: runFixture() })
    await screen.findByText('line 1')
    await act(async () =>
      screen.getByRole('button', { name: /Open the log full screen/ }).click(),
    )
    const sheet = screen.getByRole('dialog', { name: 'Whole run log' })
    within(sheet).getByText('line 1')
    assert(sheet.querySelector('.m-log--tall') != null)
    await act(async () =>
      within(sheet).getByRole('button', { name: 'Close' }).click(),
    )
    await screen.findByText('line 1')
  })

  it('restarts a finished run from a stage and opens the new run; a live run’s restart waits', async () => {
    const app = open('/runs/r1?stage=build%2Fios', {
      [RUN_PATH]: runFixture(),
      'POST /api/v2/runs/r1/restart': {
        status: 201,
        body: { id: 'r2', number: 183 },
      },
      '/api/v2/runs/r2?include=graph,steps,history,details': runFixture({
        id: 'r2',
        number: 183,
      }),
    })
    await heading('Build 26110902')
    await act(async () =>
      screen.getByRole('button', { name: /Restart from ios/ }).click(),
    )
    await until(() => where.path === '/runs/r2', 'the new run')
    // The route change focused the title while the run loaded; the run's
    // own title keeps it.
    await until(
      () =>
        document.activeElement?.id === 'page-title' &&
        document.activeElement.textContent === 'Build 26110902',
      'the new run’s title focused',
    )
    assert(app.node.requests.includes('POST /api/v2/runs/r1/restart'))
    await screen.findByText('Run 183 restarts from build/ios')
    cleanup()
    open('/runs/r1?stage=publish', {
      [RUN_PATH]: runFixture({ finished: null, status: 'running' }),
      '/api/v2/runs/r1/logs': logOf(2),
    })
    await heading('Build 26110902')
    const restart = screen.getByRole('button', { name: /Restart from publish/ })
    assert.equal(restart.hasAttribute('disabled'), true)
    screen.getByText('Available when the run has finished')
  })

  it('hides the actions a developer’s role never has on the run, and a tester reads the 403', async () => {
    const replies = shellReplies('developer', 'master', {
      [RUN_PATH]: runFixture(),
      '/api/v2/runs/r1/logs': logOf(1),
      '/api/v2/session': {
        ...sessionFor('developer'),
        permissions: sessionFor('developer').permissions.filter(
          (permission) => permission !== 'runs.request',
        ),
      },
    })
    renderApp({ path: '/runs/r1?stage=publish', replies })
    await heading('Build 26110902')
    assert.equal(screen.queryByRole('button', { name: /Request run/ }), null)
    assert.equal(screen.queryByRole('button', { name: /Restart/ }), null)
    cleanup()
    renderApp({ path: '/runs/r1', replies: shellReplies('tester') })
    await heading('Run')
    screen.getByRole('heading', {
      level: 2,
      name: 'Run is for developers, managers and administrators',
    })
  })

  it('draws a run whose graph is no longer kept as its stages one after another', async () => {
    open('/runs/r1', {
      [RUN_PATH]: runFixture({ graph: undefined, layout: undefined }),
    })
    await heading('Build 26110902')
    const rails = [
      ...document.querySelectorAll<SVGPathElement>('.m-grail'),
    ].map((rail) => `${rail.dataset.from}>${rail.dataset.to}`)
    assert.deepEqual(rails, [
      '@start>checkout',
      'checkout>build/ios',
      'build/ios>publish',
      'publish>@end',
    ])
    assert.equal(screen.queryByRole('combobox', { name: 'Workflow' }), null)
  })

  it('on the host, waits for the end of a live run to show its whole log, and disables what needs the master while it is unreachable', async () => {
    const live = runFixture({ finished: null, status: 'running' })
    open('/runs/r1', { [RUN_PATH]: live }, { node: 'host', role: 'developer' })
    await heading('Build 26110902')
    await screen.findByText(HOST_WHOLE_RUN)
    cleanup()
    renderApp({
      node: nodeInfo('host'),
      path: '/runs/r1',
      replies: shellReplies('developer', 'host', {
        [RUN_PATH]: live,
        '/api/v2/status': {
          node: 'host',
          link: { online: false, maintenance: false },
          banners: [],
        },
      }),
    })
    await heading('Build 26110902')
    await until(
      () =>
        screen
          .getByRole('button', { name: /Request run/ })
          .hasAttribute('disabled'),
      'Request run disabled',
    )
    const cancel = screen.getByRole('button', { name: /Cancel run/ })
    assert.equal(cancel.hasAttribute('disabled'), true)
    assert.match(cancel.getAttribute('title')!, /master is unreachable/)
  })
})
