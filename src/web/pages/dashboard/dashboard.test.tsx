import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import type { DashboardData, QueueEntry } from '../../../shared/api/index.js'
import {
  nodeInfo,
  renderApp,
  shellReplies,
  until,
  where,
  type Reply,
} from '../../test/render.js'
import { gaugeTone } from '../../ui/StatTile.js'
import { dashboardPath, filterApps, withQueued } from './Dashboard.js'

afterEach(() => cleanup())

const NOW = Date.now()
const MINUTE = 60_000
const DAY = 86_400_000

/** Fixture's card: a webhook, a commit, two runs and two app IDs. */
const fixture = (): DashboardData['projects'][number] => ({
  id: 1,
  slug: 'fixture',
  name: 'Fixture',
  defaultBranch: 'master',
  repository: 'git@github.com:example/fixture.git',
  webhook: true,
  latest: {
    commit: 'ec24b917a3c1ec24b917a3c1ec24b917a3c1ec24',
    description: 'Fix player socket rehydration',
    at: NOW - 5 * MINUTE,
  },
  runs: [
    {
      id: 'run-182',
      branch: 'paul/offline',
      number: 182,
      status: 'running',
      workflow: 'build',
    },
    {
      id: 'run-181',
      branch: 'develop',
      number: 181,
      status: 'succeeded',
      workflow: 'build',
    },
  ],
  apps: [
    {
      id: 11,
      slug: 'com.example.alpha',
      name: 'Alpha',
      platforms: ['ios', 'android'],
      builds: Array.from({ length: 7 }, (_, n) => ({
        branch: n === 0 ? 'master' : `feature-${n}`,
        buildNumber: `2611080${n}`,
        at: NOW - (n + 1) * DAY,
        run: `build-run-${n}`,
        status: n === 0 ? 'running' : 'succeeded',
      })),
      branches: 9,
    },
    {
      id: 12,
      slug: 'com.example.beta',
      name: 'Beta',
      platforms: ['macos'],
      builds: [],
      branches: 0,
    },
  ],
})

/** Website: no webhook, no commit, no runs, no app IDs. */
const website = (): DashboardData['projects'][number] => ({
  id: 2,
  slug: 'website',
  name: 'Website',
  defaultBranch: null,
  webhook: false,
  runs: [],
  apps: [],
})

const queued: QueueEntry[] = [
  {
    job: 'run-182',
    project: 'fixture',
    workflow: 'build',
    number: 182,
    branch: 'paul/offline',
    stage: 'build-ios',
    status: 'running',
    elapsed: 252_000,
    progress: 0.64,
  },
  {
    job: 'run-182',
    project: 'fixture',
    workflow: 'build',
    number: 182,
    branch: 'paul/offline',
    stage: 'build-android',
    status: 'queued',
  },
]

/** A dashboard answer: two projects, a queue, workers and builds. */
function answer(fields: Partial<DashboardData> = {}): DashboardData {
  return {
    tiles: {
      projects: 2,
      apps: 2,
      successRate: 0.923,
      finished: 37,
      storage: 312_800_000_000,
    },
    counts: { all: 2, ios: 1, android: 1, macos: 1, windows: 0, tvos: 0 },
    filter: {},
    projects: [fixture(), website()],
    queue: queued,
    builds: [
      {
        id: 7,
        app: 'Alpha',
        platform: 'ios',
        buildNumber: '26110803',
        version: '4.18.2',
        branch: 'master',
        at: NOW - DAY,
        size: 84_100_000,
      },
    ],
    nodes: [
      { name: 'bern', status: 'idle', detail: 'macos-arm64 · 2 slots' },
      { name: 'mason-android-1', status: 'busy', detail: 'linux-x64' },
    ],
    ...fields,
  }
}

const dashboardFor = (
  role: 'admin' | 'developer' | 'manager' = 'admin',
  node: 'master' | 'host' = 'master',
  reply: Reply = answer(),
  extra: Record<string, Reply> = {},
): ReturnType<typeof renderApp> =>
  renderApp({
    node: nodeInfo(node),
    path: '/projects',
    replies: shellReplies(role, node, {
      '/api/v2/dashboard': reply,
      ...extra,
    }),
  })

const page = async (): Promise<HTMLElement> =>
  await screen.findByRole('heading', { level: 1, name: 'Projects & apps' })
const loaded = async (): Promise<void> => {
  await page()
  await screen.findByRole('region', { name: 'Summary' })
}
const card = (name: string): HTMLElement =>
  screen.getByRole('heading', { level: 2, name }).closest('article')!
const panel = (name: string): HTMLElement =>
  screen.getByRole('region', { name })
const dashboardReads = (app: ReturnType<typeof renderApp>): string[] =>
  app.node.requests.filter((request) => request.includes('/api/v2/dashboard'))

describe('Projects & apps', () => {
  it('draws the four tiles: counts, the platform meter, the success gauge toned by threshold and storage', async () => {
    dashboardFor()
    await loaded()
    const tiles = screen.getByRole('region', { name: 'Summary' })
    const values = [...tiles.querySelectorAll('.m-t-metric')].map(
      (node) => node.textContent,
    )
    assert.deepEqual(values, ['2', '2', '92.3%', '312.8'])
    assert.match(tiles.textContent!, /fixture, website/)
    within(tiles).getByRole('img', { name: 'iOS 1, Android 1, macOS 1' })
    const gauge = within(tiles).getByRole('img', {
      name: '92.3 percent of finished runs succeeded',
    })
    assert(gauge.classList.contains('m-gauge--success'))
    assert.equal(gauge.style.getPropertyValue('--v'), '92.3')
    assert.match(tiles.textContent!, /37 runs in 30 days/)
    assert.equal(tiles.querySelector('.m-stat__unit')!.textContent, 'GB')
    assert.match(tiles.textContent!, /Builds and run artifacts/)
  })

  it('tones the gauge by threshold and says when no run finished', async () => {
    assert.equal(gaugeTone(100), 'success')
    assert.equal(gaugeTone(90), 'success')
    assert.equal(gaugeTone(89.9), 'warning')
    assert.equal(gaugeTone(70), 'warning')
    assert.equal(gaugeTone(69.9), 'danger')
    dashboardFor(
      'admin',
      'master',
      answer({
        tiles: {
          projects: 1,
          apps: 0,
          successRate: 0.5,
          finished: 1,
          storage: 0,
        },
        filter: { platform: 'ios' },
      }),
    )
    await loaded()
    const gauge = screen.getByRole('img', { name: /percent of finished/ })
    assert(gauge.classList.contains('m-gauge--danger'))
    assert.match(
      screen.getByRole('region', { name: 'Summary' }).textContent!,
      /1 run in 30 days/,
    )
    cleanup()
    dashboardFor(
      'admin',
      'master',
      answer({
        tiles: { projects: 0, apps: 0, finished: 0, storage: 512 },
        counts: { all: 0, ios: 0, android: 0, macos: 0, windows: 0, tvos: 0 },
        projects: [],
      }),
    )
    await loaded()
    const tiles = screen.getByRole('region', { name: 'Summary' })
    assert.equal(within(tiles).queryByRole('img'), null)
    assert.match(tiles.textContent!, /—/)
    assert.match(tiles.textContent!, /No finished runs in 30 days/)
    assert.equal(tiles.querySelector('.m-stat__unit')!.textContent, 'B')
  })

  it('offers platform pills with counts for the platforms that have apps, and reads the dashboard for the pressed one', async () => {
    const app = dashboardFor()
    await loaded()
    const pills = screen.getByRole('group', { name: 'Platform' })
    assert.deepEqual(
      within(pills)
        .getAllByRole('button')
        .map((button) => button.textContent),
      ['All 2', 'iOS 1', 'Android 1', 'macOS 1'],
    )
    assert.equal(
      within(pills).getByRole('button', { name: 'All 2' }).ariaPressed,
      'true',
    )
    await act(async () =>
      within(pills).getByRole('button', { name: 'iOS 1' }).click(),
    )
    assert.equal(where.path, '/projects?platform=ios')
    await until(
      () => dashboardReads(app).includes('GET /api/v2/dashboard?platform=ios'),
      'the iOS read',
    )
    assert.equal(
      dashboardPath(new URLSearchParams('platform=ios&project=fixture')),
      '/api/v2/dashboard?project=fixture&platform=ios',
    )
    assert.equal(
      dashboardPath(new URLSearchParams('platform=&project=')),
      '/api/v2/dashboard',
    )
  })

  it('shows the project filter as a chip that clears it, keeping the platform', async () => {
    const app = renderApp({
      path: '/projects?project=fixture&platform=android',
      replies: shellReplies('admin', 'master', {
        '/api/v2/dashboard': answer({
          filter: { project: 'fixture', platform: 'android' },
          projects: [fixture()],
        }),
      }),
    })
    await loaded()
    assert(
      app.node.requests.includes(
        'GET /api/v2/dashboard?project=fixture&platform=android',
      ),
    )
    // Filtered, the Projects tile names none.
    assert.doesNotMatch(
      screen.getByRole('region', { name: 'Summary' }).textContent!,
      /fixture,/,
    )
    await act(async () =>
      screen
        .getByRole('button', { name: 'Show every project, not only fixture' })
        .click(),
    )
    assert.equal(where.path, '/projects?platform=android')
  })

  it('narrows the app IDs by the filter field, and says when nothing matches', async () => {
    dashboardFor()
    await loaded()
    const field = screen.getByRole('searchbox', { name: 'Filter app IDs' })
    fireEvent.change(field, { target: { value: 'BETA' } })
    assert.deepEqual(
      [...card('Fixture').querySelectorAll('.m-approw__id')].map(
        (node) => node.textContent,
      ),
      ['com.example.beta'],
    )
    assert.equal(screen.queryByRole('heading', { name: 'Website' }), null)
    // A project's name keeps all its app IDs.
    fireEvent.change(field, { target: { value: 'website' } })
    screen.getByRole('heading', { name: 'Website' })
    assert.equal(screen.queryByRole('heading', { name: 'Fixture' }), null)
    fireEvent.change(field, { target: { value: 'nothing-like-it' } })
    screen.getByRole('heading', { name: 'No projects match.' })
    screen.getByText('Clear the filter or choose another platform.')
    assert.equal(filterApps(fixture(), '  ')!.length, 2)
    assert.equal(filterApps(fixture(), 'alpha')!.length, 1)
    assert.equal(filterApps(fixture(), 'zzz'), undefined)
  })

  it('draws a project’s card: its link, default branch, repository, webhook, latest commit, runs and app IDs with build chips and +N more', async () => {
    dashboardFor()
    await loaded()
    const fixtureCard = card('Fixture')
    const link = within(fixtureCard).getByRole('link', {
      name: 'Fixture Default branch master',
    })
    assert.equal(link.getAttribute('href'), '/projects/fixture')
    within(fixtureCard).getByText('git@github.com:example/fixture.git')
    within(fixtureCard).getByText('Webhook active')
    assert.equal(
      fixtureCard.querySelector('.m-commit__sha')!.textContent,
      'ec24b917',
    )
    within(fixtureCard).getByText('Fix player socket rehydration')
    within(fixtureCard).getByText('5m ago')
    assert.equal(
      within(fixtureCard)
        .getByRole('link', { name: 'Runs and builds' })
        .getAttribute('href'),
      '/projects/fixture/runs',
    )
    const run = within(fixtureCard).getByRole('link', {
      name: 'paul/offline, Run 182, Running',
    })
    assert.equal(run.getAttribute('href'), '/runs/run-182')
    assert(run.classList.contains('m-runchip--running'))
    within(fixtureCard).getByRole('link', {
      name: 'develop, Run 181, Succeeded',
    })
    // App IDs: the count, each one's link, name and platforms.
    assert.match(
      fixtureCard.querySelector('.m-card__section')!.textContent!,
      /App IDs\s*2/,
    )
    const alpha = within(fixtureCard)
      .getByRole('link', { name: 'com.example.alpha' })
      .closest('li')!
    assert.equal(
      within(alpha)
        .getByRole('link', { name: 'com.example.alpha' })
        .getAttribute('href'),
      '/projects/fixture/apps/com.example.alpha',
    )
    within(alpha).getByText('Alpha')
    assert.deepEqual(
      [...alpha.querySelectorAll('.m-chip--platform')].map(
        (chip) => chip.textContent,
      ),
      ['iOS', 'Android'],
    )
    // Six builds, then +N more for the branches beyond them.
    const builds = alpha.querySelectorAll('a.m-runchip:not(.m-runchip--more)')
    assert.equal(builds.length, 6)
    const master = within(alpha).getByRole('link', {
      name: 'master, build 26110800, Running, 1d',
    })
    assert.equal(master.getAttribute('href'), '/runs/build-run-0')
    const more = within(alpha).getByRole('link', {
      name: '3 more branches of com.example.alpha',
    })
    assert.equal(more.textContent, '+3 more')
    assert.equal(
      more.getAttribute('href'),
      '/projects/fixture/apps/com.example.alpha',
    )
    const beta = within(fixtureCard)
      .getByRole('link', { name: 'com.example.beta' })
      .closest('li')!
    within(beta).getByText('No builds yet')
  })

  it('says what an empty project, a build without its run and an empty dashboard have', async () => {
    const lone = fixture()
    lone.apps = [
      {
        id: 13,
        slug: 'com.example.gamma',
        name: 'Gamma',
        platforms: [],
        builds: [{ branch: 'old', buildNumber: '7', at: NOW - 3 * DAY }],
        branches: 1,
      },
    ]
    lone.latest = { commit: 'abcdef1234', description: '', at: NOW }
    dashboardFor(
      'admin',
      'master',
      answer({ projects: [lone, website()], queue: [], nodes: [], builds: [] }),
    )
    await loaded()
    const empty = card('Website')
    within(empty).getByText('Webhook not set up')
    within(empty).getByText('No runs yet.')
    within(empty).getByText('No app IDs.')
    assert.equal(empty.querySelector('.m-commit'), null)
    within(card('Fixture')).getByText('No description')
    // A build whose run is gone is a plain chip.
    within(card('Fixture')).getByRole('img', { name: 'old, build 7, 3d' })
    within(panel('Queue')).getByText('Nothing is running.')
    within(panel('Worker nodes')).getByText('No nodes are linked.')
    within(panel('Recent builds')).getByText('No builds yet.')
    cleanup()
    dashboardFor('admin', 'master', answer({ projects: [] }))
    await loaded()
    screen.getByRole('heading', { name: 'No projects match.' })
    assert.equal(
      screen.queryByText('Clear the filter or choose another platform.'),
      null,
    )
  })

  it('lists the queue with progress, the master’s workers and the latest builds in the aside', async () => {
    dashboardFor()
    await loaded()
    const queue = panel('Queue')
    within(queue).getByText('1 running')
    within(queue).getByText('fixture · build-ios')
    assert.match(queue.textContent!, /Run 182 · paul\/offline · 4m 12s/)
    const bar = within(queue).getByRole('progressbar', {
      name: 'build-ios, about 64% of its usual time',
    })
    assert.equal(bar.getAttribute('aria-valuenow'), '64')
    within(queue).getByText('Queued')
    assert.equal(within(queue).getAllByRole('progressbar').length, 1)
    const workers = panel('Worker nodes')
    within(workers).getByText('bern')
    within(workers).getByText('Idle')
    within(workers).getByText('Busy')
    assert.equal(
      within(workers).getByRole('link', { name: 'Nodes' }).getAttribute('href'),
      '/nodes',
    )
    const builds = panel('Recent builds')
    assert.match(builds.textContent!, /Alpha 4\.18\.2 \(26110803\)/)
    assert.match(builds.textContent!, /84\.1 MB/)
  })

  it('updates the queue, inserts a new run’s chip and announces it from /live, then reads the dashboard again', async () => {
    const app = dashboardFor()
    await loaded()
    await act(async () => app.live.socket.accept())
    const sent = app.live.socket.sent as Array<Record<string, unknown>>
    assert(
      sent.some(
        (message) =>
          message.subscribe === 'queue' && message.key === 'dashboard-queue',
      ),
    )
    // The queue as it subscribed: drawn, not read again.
    const before = dashboardReads(app).length
    await act(async () =>
      app.live.socket.frame({
        key: 'dashboard-queue',
        event: 'queue',
        data: queued,
      }),
    )
    assert.equal(dashboardReads(app).length, before)
    const next: QueueEntry[] = [
      {
        job: 'run-183',
        project: 'fixture',
        workflow: 'build',
        number: 183,
        branch: 'develop',
        stage: 'checkout',
        status: 'queued',
      },
    ]
    app.node.set('/api/v2/dashboard', () => new Promise(() => undefined))
    await act(async () =>
      app.live.socket.frame({
        key: 'dashboard-queue',
        event: 'queue',
        data: next,
      }),
    )
    within(panel('Queue')).getByText('fixture · checkout')
    within(panel('Queue')).getByText('0 running')
    screen.getByText('0 running, 1 queued')
    // Run 183 takes develop's place at the front of Fixture's runs.
    const chips = card('Fixture').querySelectorAll(
      '.m-card__body .m-runchips a',
    )
    assert.deepEqual(
      [...chips].map((chip) => chip.getAttribute('aria-label')),
      ['develop, Run 183, Queued', 'paul/offline, Run 182, Running'],
    )
    await until(
      () => dashboardReads(app).length > before,
      'the dashboard read again',
    )
    // A frame that is not the queue, or not a queue, changes nothing.
    await act(async () => {
      app.live.socket.frame({ key: 'dashboard-queue', event: 'status' })
      app.live.socket.frame({
        key: 'dashboard-queue',
        event: 'queue',
        data: 'nonsense',
      })
    })
    within(panel('Queue')).getByText('fixture · checkout')
    await act(async () =>
      app.live.socket.frame({
        key: 'dashboard-queue',
        event: 'queue',
        data: [],
      }),
    )
    screen.getByText('Nothing is running', { selector: '[role=status]' })
  })

  it('keeps unfinished runs’ chips at their status from /live', async () => {
    const app = dashboardFor()
    await loaded()
    await act(async () => app.live.socket.accept())
    const sent = app.live.socket.sent as Array<Record<string, unknown>>
    const watched = sent
      .filter(
        (message) => message.subscribe === 'status' && message.run != null,
      )
      .map((message) => message.run)
      .sort()
    // The running run and the running build's run; finished ones are not watched.
    assert.deepEqual(watched, ['build-run-0', 'run-182'])
    await act(async () => {
      app.live.socket.frame({
        key: 'run-status:run-182',
        event: 'run',
        data: { status: 'failed' },
      })
      app.live.socket.frame({
        key: 'run-status:build-run-0',
        event: 'run',
        data: { status: 'succeeded' },
      })
      // Not a status, or not its run's line: ignored.
      app.live.socket.frame({ key: 'run-status:run-182', event: 'stages' })
      app.live.socket.frame({
        key: 'run-status:run-182',
        event: 'run',
        data: {},
      })
    })
    within(card('Fixture')).getByRole('link', {
      name: 'paul/offline, Run 182, Failed',
    })
    within(card('Fixture')).getByRole('link', {
      name: 'master, build 26110800, Succeeded, 1d',
    })
  })

  it('offers Add project to managers and administrators on the master only', async () => {
    dashboardFor('manager')
    await loaded()
    assert.equal(
      screen.getByRole('link', { name: 'Add project' }).getAttribute('href'),
      '/projects/new',
    )
    cleanup()
    dashboardFor('developer')
    await loaded()
    assert.equal(screen.queryByRole('link', { name: 'Add project' }), null)
    // A developer sees the workers, without the Nodes link.
    assert.equal(
      within(panel('Worker nodes')).queryByRole('link', { name: 'Nodes' }),
      null,
    )
  })

  it('draws the host’s copy: no workers and no Add project', async () => {
    const app = dashboardFor(
      'admin',
      'host',
      answer({ nodes: undefined as never }),
    )
    await loaded()
    assert(app.node.requests.includes('GET /api/v2/dashboard'))
    assert.equal(screen.queryByRole('region', { name: 'Worker nodes' }), null)
    assert.equal(screen.queryByRole('link', { name: 'Add project' }), null)
    panel('Queue')
    panel('Recent builds')
  })

  it('shows the page’s shape while it loads, and a failed read with Retry', async () => {
    const app = dashboardFor(
      'admin',
      'master',
      () => new Promise<Response>(() => undefined),
    )
    await page()
    screen.getByRole('status', { name: 'Loading projects' })
    cleanup()
    const failing = dashboardFor('admin', 'master', {
      status: 500,
      body: { error: 'The database is locked' },
    })
    await screen.findByRole('heading', {
      name: 'Projects & apps could not be read',
    })
    screen.getByText('The database is locked')
    failing.node.set('/api/v2/dashboard', answer())
    await act(async () => screen.getByRole('button', { name: 'Retry' }).click())
    await screen.findByRole('region', { name: 'Summary' })
    void app
  })

  it('is the master’s home for developers and up, at /', async () => {
    renderApp({
      path: '/',
      replies: shellReplies('developer', 'master', {
        '/api/v2/dashboard': answer(),
      }),
    })
    await loaded()
    assert.equal(where.path, '/')
    // The sidebar marks Projects & apps current there.
    assert.equal(
      document
        .querySelector('.m-sidebar nav [aria-current="page"]')
        ?.textContent?.slice(1),
      'Projects & apps',
    )
  })

  it('answers a tester the 403 inside the shell', async () => {
    renderApp({ path: '/projects', replies: shellReplies('tester') })
    await screen.findByText(
      'Projects & apps is for developers, managers and administrators',
    )
  })

  it('puts a queued run first among its project’s chips, in place of its branch’s', () => {
    const card = fixture()
    assert.deepEqual(
      withQueued(card, [
        { ...queued[0]!, job: 'run-190', number: 190, branch: 'develop' },
        { ...queued[0]!, project: 'website' },
      ]).map((run) => `${run.number} ${run.status}`),
      ['190 running', '182 running'],
    )
    assert.equal(withQueued(card, queued).length, 2)
  })
})
