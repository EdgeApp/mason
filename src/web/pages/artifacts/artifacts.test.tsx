import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import type {
  ArtifactRunDetail,
  ArtifactsList,
} from '../../../shared/api/index.js'
import {
  nodeInfo,
  renderApp,
  shellReplies,
  until,
  where,
  type Reply,
} from '../../test/render.js'
import { artifactsHref, listPath, runName } from './Artifacts.js'

afterEach(() => cleanup())

const NOW = Date.now()
const project = { slug: 'fixture', name: 'Fixture' }

const run = (
  id: string,
  number: number,
  status: string,
  fields: Partial<ArtifactsList['runs'][number]> = {},
): ArtifactsList['runs'][number] => ({
  id,
  number,
  workflow: 'build',
  branch: 'develop',
  status,
  project,
  commit: 'c3a1f00dc3a1f00dc3a1f00d',
  description: null,
  created: NOW - 2 * 3_600_000,
  started: NOW - 2 * 3_600_000,
  finished: null,
  buildNumbers: [],
  builds: 0,
  artifacts: { count: 0, size: 0 },
  ...fields,
})

/** The list: a published run, a failed one and a running one. */
const list = (fields: Partial<ArtifactsList> = {}): ArtifactsList => ({
  runs: [
    run('run-181', 181, 'succeeded', {
      buildNumbers: ['26110803'],
      builds: 3,
      artifacts: { count: 4, size: 12_300_000 },
    }),
    run('run-180', 180, 'failed', {
      workflow: 'deploy',
      artifacts: { count: 1, size: 1_100_000 },
      buildNumbers: ['7'],
      builds: 1,
    }),
    run('run-182', 182, 'running', { branch: 'paul/offline' }),
  ],
  projects: [project, { slug: 'website', name: 'Website' }],
  branches: [],
  ...fields,
})

/** Run 181's detail. */
const detail = (
  fields: Partial<ArtifactRunDetail> = {},
): ArtifactRunDetail => ({
  run: {
    id: 'run-181',
    number: 181,
    workflow: 'build',
    branch: 'develop',
    status: 'succeeded',
    project,
    commit: '9f31c2ab9f31c2ab9f31c2ab',
    description: 'Bump the player SDK',
    created: NOW - 3_600_000,
    started: NOW - 3_600_000,
    finished: NOW - 3_600_000 + 761_000,
  },
  stages: [
    {
      name: 'checkout',
      status: 'succeeded',
      kind: 'stage',
      started: NOW - 3_600_000,
      finished: NOW - 3_600_000 + 21_000,
    },
    {
      name: 'publish',
      status: 'skipped',
      kind: 'stage',
      started: null,
      finished: null,
    },
  ],
  tests: [
    { stage: 'unit', passed: 200, failed: 0, skipped: 3 },
    { stage: 'e2e', passed: 12, failed: 2, skipped: 0 },
  ],
  builds: [
    {
      id: 88,
      appId: 3,
      app: 'Alpha',
      platform: 'ios',
      version: '4.18.2',
      buildNumber: '26110803',
      size: 84_100_000,
      variant: 'staging',
      format: 'ipa',
    },
    {
      id: 89,
      appId: 3,
      app: 'Alpha',
      platform: 'ios',
      version: '4.18.2',
      buildNumber: '26110803',
      size: 92_000_000,
      variant: '',
      format: 'zip',
      downloadOnly: 'iPhone Simulator',
    },
  ],
  artifacts: [
    {
      name: 'junit-report.html',
      stage: 'test',
      kind: 'report',
      size: 1_200_000,
      created: NOW,
      url: 'https://host.test/runs/run-181/artifacts/junit-report.html',
      viewUrl:
        'https://host.test/runs/run-181/artifacts/junit-report.html/view',
    },
    {
      name: 'App.xcarchive.zip',
      stage: 'build-ios',
      kind: 'file',
      size: 10_400_000,
      created: NOW,
      url: 'https://host.test/runs/run-181/artifacts/App.xcarchive.zip',
    },
  ],
  artifactOrigin: 'https://host.test',
  ...fields,
})

const open = (
  path: string,
  replies: Record<string, Reply>,
  node: 'master' | 'host' = 'master',
  role: 'admin' | 'developer' | 'tester' = 'developer',
): ReturnType<typeof renderApp> =>
  renderApp({
    node: nodeInfo(node),
    path,
    replies: shellReplies(role, node, replies),
  })

const heading = async (name: string | RegExp): Promise<HTMLElement> =>
  await screen.findByRole('heading', { level: 1, name })
/** An element's text without its icons' glyphs. */
const text = (node: Element): string =>
  (node.textContent ?? '').replace(/[\uE000-\uF8FF]/g, '')
const crumbs = (): string[] =>
  [...document.querySelectorAll('.m-crumbs li')].map(text)
const card = (name: string): HTMLElement => screen.getByRole('region', { name })

describe('Artifacts', () => {
  it('lists the latest runs: each one’s link, branch, status, build numbers and files, artifacts and start', async () => {
    open('/artifacts', { '/api/v2/artifacts': list() })
    await heading('Artifacts')
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    assert.equal(rows.length, 3)
    const first = rows[0]!
    assert.equal(
      within(first)
        .getByRole('link', { name: 'fixture Run 181' })
        .getAttribute('href'),
      '/artifacts?run=run-181',
    )
    assert.deepEqual([...first.querySelectorAll('td')].map(text), [
      'fixture Run 181',
      'develop',
      'Succeeded',
      '26110803 · 3 files',
      '4 · 12.3 MB',
      '2h ago',
    ])
    within(rows[1]!).getByRole('link', { name: 'fixture Run 180 · deploy' })
    assert.match(rows[1]!.textContent!, /7 · 1 file/)
    assert.deepEqual(
      [...rows[2]!.querySelectorAll('td')]
        .slice(3, 5)
        .map((cell) => cell.textContent),
      ['—', '—'],
    )
    // Stacked rows label their cells.
    assert.equal(first.querySelector('td')!.dataset.label, 'Run')
    screen.getByText('50 most recent runs')
    assert.deepEqual(crumbs(), ['Mason Master', 'Artifacts'])
    screen.getByText(
      'Each run’s saved artifacts, test results and published builds.',
    )
  })

  it('narrows the list by project, then by branch, and back', async () => {
    const app = open('/artifacts', {
      '/api/v2/artifacts': list(),
      '/api/v2/artifacts?project=fixture': list({
        project,
        branches: ['develop', 'master'],
      }),
      '/api/v2/artifacts?project=fixture&branch=master': list({
        project,
        branch: 'master',
        branches: ['develop', 'master'],
        runs: [],
      }),
    })
    await screen.findByRole('table')
    // Without a project there is no branch to pick.
    assert.equal(screen.queryByRole('combobox', { name: 'Branch' }), null)
    const projects = screen.getByRole('combobox', { name: 'Project' })
    assert.deepEqual(
      [...projects.querySelectorAll('option')].map((option) => option.text),
      ['All projects', 'Fixture', 'Website'],
    )
    fireEvent.change(projects, { target: { value: 'fixture' } })
    assert.equal(where.path, '/artifacts?project=fixture')
    const branches = await screen.findByRole('combobox', { name: 'Branch' })
    await until(
      () => branches.querySelectorAll('option').length === 3,
      'the branches',
    )
    fireEvent.change(branches, { target: { value: 'master' } })
    assert.equal(where.path, '/artifacts?project=fixture&branch=master')
    await screen.findByRole('heading', { name: 'No runs yet.' })
    assert.deepEqual(crumbs(), [
      'Mason Master',
      'Artifacts',
      'Fixture',
      'master',
    ])
    assert(
      app.node.requests.includes(
        'GET /api/v2/artifacts?project=fixture&branch=master',
      ),
    )
    fireEvent.change(screen.getByRole('combobox', { name: 'Branch' }), {
      target: { value: '' },
    })
    assert.equal(where.path, '/artifacts?project=fixture')
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), {
      target: { value: '' },
    })
    assert.equal(where.path, '/artifacts')
  })

  it('keeps a branch or project the options do not name, as search opens them', async () => {
    open('/artifacts?project=gone&branch=feature%2Flogin', {
      '/api/v2/artifacts': list({
        project: { slug: 'gone', name: 'gone' },
        branch: 'feature/login',
        branches: ['master'],
      }),
    })
    const branches = await screen.findByRole('combobox', { name: 'Branch' })
    assert.equal((branches as HTMLSelectElement).value, 'feature/login')
    assert.equal(
      (screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement)
        .value,
      'gone',
    )
  })

  it('keeps an unfinished run’s status current from /live', async () => {
    const app = open('/artifacts', { '/api/v2/artifacts': list() })
    await screen.findByRole('table')
    await act(async () => app.live.socket.accept())
    assert(
      (app.live.socket.sent as Array<Record<string, unknown>>).some(
        (message) =>
          message.subscribe === 'status' && message.run === 'run-182',
      ),
    )
    await act(async () =>
      app.live.socket.frame({
        key: 'run-status:run-182',
        event: 'run',
        data: { status: 'succeeded' },
      }),
    )
    const row = screen
      .getByRole('link', { name: 'fixture Run 182' })
      .closest('tr')!
    within(row).getByText('Succeeded')
  })

  it('says when there are no runs, and when the list cannot be read', async () => {
    open('/artifacts', { '/api/v2/artifacts': list({ runs: [] }) })
    await screen.findByRole('heading', { name: 'No runs yet.' })
    cleanup()
    const app = open('/artifacts', {
      '/api/v2/artifacts': { status: 500, body: { error: 'Disk full' } },
    })
    await screen.findByRole('heading', { name: 'The runs could not be read' })
    screen.getByText('Disk full')
    app.node.set('/api/v2/artifacts', list())
    await act(async () => screen.getByRole('button', { name: 'Retry' }).click())
    await screen.findByRole('table')
    cleanup()
    open('/artifacts', {
      '/api/v2/artifacts': () => new Promise<Response>(() => undefined),
    })
    await screen.findByRole('status', { name: 'Loading the runs' })
  })

  it('opens a run’s detail: status, branch, commit, times, description, stages, tests, builds and saved artifacts', async () => {
    open('/artifacts?run=run-181', {
      '/api/v2/artifacts/runs/run-181': detail(),
    })
    await heading('Run 181')
    assert.deepEqual(crumbs(), [
      'Mason Master',
      'Artifacts',
      'Fixture',
      'Run 181',
    ])
    assert.equal(
      screen.getByRole('link', { name: 'Fixture' }).getAttribute('href'),
      '/artifacts?project=fixture',
    )
    const header = document.querySelector('.m-page__header')!
    within(header as HTMLElement).getByText('Succeeded')
    assert.equal(
      header.querySelector('.m-commit__sha')!.textContent,
      '9f31c2ab9f31',
    )
    assert.match(header.textContent!, /took 12m 41s/)
    assert.equal(
      screen.getByRole('link', { name: 'Open the run' }).getAttribute('href'),
      '/runs/run-181',
    )
    screen.getByText('Bump the player SDK')
    const stages = card('Stages')
    within(stages).getByText('Succeeded · 21s')
    within(stages).getByText('Skipped')
    const tests = card('Tests')
    assert.match(tests.textContent!, /212 passed/)
    assert.match(tests.textContent!, /2 failed/)
    assert(tests.querySelector('.m-t-metric.m-danger-text') != null)
    assert.match(tests.textContent!, /e2e12 passed · 2 failed · 0 skipped/)
    const builds = card('Published builds')
    assert.match(builds.textContent!, /Alpha 4\.18\.2 \(26110803\) staging/)
    within(builds).getByText('iPhone Simulator')
    // The master offers no install: the host does.
    assert.equal(within(builds).queryByRole('link'), null)
    const saved = card('Saved artifacts')
    assert.equal(
      within(saved).getByRole('link', { name: 'View' }).getAttribute('href'),
      'https://host.test/runs/run-181/artifacts/junit-report.html/view',
    )
    assert.equal(
      within(saved)
        .getByRole('link', { name: 'Download App.xcarchive.zip' })
        .getAttribute('href'),
      'https://host.test/runs/run-181/artifacts/App.xcarchive.zip',
    )
    within(saved).getByText('Report')
    within(saved).getByText('10.4 MB')
  })

  it('offers Install and Download on the host, and says what a run without builds, tests, stages or artifacts has', async () => {
    open(
      '/artifacts?run=run-181',
      { '/api/v2/artifacts/runs/run-181': detail() },
      'host',
    )
    await heading('Run 181')
    const builds = card('Published builds')
    const install = within(builds).getByRole('link', { name: 'Install' })
    assert.equal(install.getAttribute('href'), '/apps/3')
    within(builds).getByRole('link', { name: 'Download' })
    cleanup()
    const bare = detail({ stages: [], tests: [], builds: [], artifacts: [] })
    bare.run.description = null
    bare.run.commit = null
    bare.run.started = null
    bare.run.workflow = 'deploy'
    open('/artifacts?run=run-181', { '/api/v2/artifacts/runs/run-181': bare })
    await heading('Run 181 · deploy')
    within(card('Stages')).getByText('No stage has started yet.')
    assert.equal(screen.queryByRole('region', { name: 'Tests' }), null)
    within(card('Published builds')).getByText('None.')
    within(card('Saved artifacts')).getByText('This run saved no artifacts.')
    assert.doesNotMatch(
      document.querySelector('.m-page__header')!.textContent!,
      /took/,
    )
  })

  it('reads a run again when /live reports its status', async () => {
    const running = detail()
    running.run.status = 'running'
    running.run.finished = null
    const app = open('/artifacts?run=run-181', {
      '/api/v2/artifacts/runs/run-181': running,
    })
    await heading('Run 181')
    await act(async () => app.live.socket.accept())
    const reads = (): number =>
      app.node.requests.filter((r) => r.includes('/artifacts/runs/run-181'))
        .length
    const before = reads()
    app.node.set('/api/v2/artifacts/runs/run-181', detail())
    await act(async () =>
      app.live.socket.frame({
        key: 'run-status:run-181',
        event: 'run',
        data: { status: 'succeeded' },
      }),
    )
    await until(() => reads() > before, 'the run read again')
  })

  it('says a run is unavailable, a read failed, or it is loading', async () => {
    open('/artifacts?run=none', {
      '/api/v2/artifacts/runs/none': {
        status: 404,
        body: { error: 'No such run' },
      },
    })
    await heading('Run unavailable')
    screen.getByRole('heading', { name: 'There is no such run.' })
    assert.equal(
      screen.getByRole('link', { name: 'All runs' }).getAttribute('href'),
      '/artifacts',
    )
    cleanup()
    open('/artifacts?run=bad', {
      '/api/v2/artifacts/runs/bad': { status: 500, body: { error: 'Broken' } },
    })
    await screen.findByRole('heading', { name: 'The run could not be read' })
    cleanup()
    open('/artifacts?run=slow', {
      '/api/v2/artifacts/runs/slow': () =>
        new Promise<Response>(() => undefined),
    })
    await screen.findByRole('status', { name: 'Loading the run' })
  })

  it('answers a tester the 403 inside the shell', async () => {
    open('/artifacts', {}, 'host', 'tester')
    await screen.findByText(
      'Artifacts is for developers, managers and administrators',
    )
  })

  it('writes its addresses and reads', () => {
    assert.equal(artifactsHref({}), '/artifacts')
    assert.equal(
      artifactsHref({ project: 'a b', branch: 'x/y' }),
      '/artifacts?project=a+b&branch=x%2Fy',
    )
    assert.equal(listPath(), '/api/v2/artifacts')
    assert.equal(listPath('p', 'b'), '/api/v2/artifacts?project=p&branch=b')
    assert.equal(runName('build', 3), 'Run 3')
    assert.equal(runName('deploy', 3), 'Run 3 · deploy')
  })
})
