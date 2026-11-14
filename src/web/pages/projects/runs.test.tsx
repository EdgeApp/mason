import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { until, where } from '../../test/render.js'
import {
  ALPHA,
  appFixture,
  BETA,
  bodyOf,
  crumbs,
  heading,
  openProject,
  overviewFixture,
  recording,
  runRow,
  runsFixture,
  tabs,
  text,
} from '../../test/projects.js'
import { runsPath } from './Runs.js'

afterEach(() => cleanup())

const OVERVIEW = '/api/v2/projects/fixture/overview'
const RUNS = '/api/v2/projects/fixture/runs'

const branchLinks = (): string[] =>
  [
    ...screen
      .getByRole('navigation', { name: 'Branches' })
      .querySelectorAll('a'),
  ].map(text)

describe('A project’s Runs and builds', () => {
  it('lists All branches, those built on push, then the rest, beside every branch’s latest runs', async () => {
    openProject('/projects/fixture/runs', {
      [OVERVIEW]: overviewFixture(),
      [RUNS]: runsFixture(),
    })
    await heading('Fixture')
    assert.equal(tabs('Fixture').current, 'Runs and builds')
    screen.getByText('The latest runs on every branch.')
    const list = await screen.findByRole('navigation', { name: 'Branches' })
    assert.deepEqual(branchLinks(), [
      'All branches',
      'master1h ago',
      'release/4.18No runs yet',
      'develop2h ago',
    ])
    within(list).getByText('Build on push')
    assert.equal(list.querySelectorAll('hr').length, 1)
    assert.equal(
      within(list)
        .getByRole('link', { name: /All branches/ })
        .getAttribute('aria-current'),
      'page',
    )
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    assert.deepEqual(
      rows.map((row) => [...row.querySelectorAll('td')].map(text)),
      [
        ['RunningRun 182paul/offline', '—', '—', '2h ago'],
        ['SucceededRun 181develop', '4.18.2', '26110803', '2h ago'],
        ['UnstableRun 179 · nightlymaster', '4.18.2', '26110803', '2h ago'],
      ],
    )
    assert.equal(
      within(rows[0]!).getByRole('link').getAttribute('href'),
      '/runs/run-182',
    )
    screen.getByText('3 latest')
    assert.equal(screen.queryByRole('button', { name: 'Show more' }), null)
    assert.equal(document.title, 'Fixture · Runs and builds · Mason')
  })

  it('opens a branch: its runs without the branch column, and its crumb', async () => {
    const app = openProject('/projects/fixture/runs', {
      [OVERVIEW]: overviewFixture(),
      [RUNS]: runsFixture(),
      [`${RUNS}?branch=develop`]: runsFixture({
        branch: 'develop',
        runs: [runRow(181, 'succeeded')],
      }),
    })
    fireEvent.click(await screen.findByRole('link', { name: /^develop/ }))
    assert.equal(where.path, '/projects/fixture/runs?branch=develop')
    await screen.findByText('The latest runs on develop.')
    await until(() => screen.queryByText('Run 182') == null, 'the develop runs')
    const row = screen.getAllByRole('row')[1]!
    assert.equal(text(row.querySelector('td')), 'SucceededRun 181')
    assert.equal(
      screen.getByRole('heading', { level: 2, name: 'develop' }).className,
      'm-t-title3 m-t-mono',
    )
    assert.deepEqual(crumbs(), [
      'Mason Master',
      'Projects & apps',
      'Fixture',
      'Runs and builds',
      'develop',
    ])
    assert.ok(app.node.requests.includes(`GET ${RUNS}?branch=develop`))
  })

  it('shows more: the next fifty, keeping the list while they load', async () => {
    let release: () => void = () => undefined
    const app = openProject('/projects/fixture/runs', {
      [OVERVIEW]: overviewFixture(),
      [RUNS]: runsFixture({ more: true }),
      [`${RUNS}?limit=100`]: () =>
        new Promise<Response>((resolve) => {
          release = (): void =>
            resolve(
              new Response(
                JSON.stringify(
                  runsFixture({
                    runs: [...runsFixture().runs, runRow(120, 'failed')],
                  }),
                ),
              ),
            )
        }),
    })
    const more = await screen.findByRole('button', { name: 'Show more' })
    screen.getByText('Showing the 3 latest')
    fireEvent.click(more)
    await until(
      () => app.node.requests.includes(`GET ${RUNS}?limit=100`),
      'the longer list',
    )
    // The shorter list stays while the longer one loads.
    screen.getByText('Run 182')
    await act(async () => release())
    await screen.findByText('Run 120')
    assert.equal(screen.queryByRole('button', { name: 'Show more' }), null)
  })

  it('keeps an unfinished run’s status from /live, and reads the runs again when the queue moves', async () => {
    const app = openProject('/projects/fixture/runs', {
      [OVERVIEW]: overviewFixture(),
      [RUNS]: runsFixture(),
    })
    await screen.findByText('Run 182')
    await act(async () => app.live.socket.accept())
    await act(async () =>
      app.live.socket.frame({
        key: 'run-status:run-182',
        event: 'run',
        data: { status: 'failed' },
      }),
    )
    within(screen.getByText('Run 182').closest('tr')!).getByText('Failed')
    app.node.set(RUNS, runsFixture({ runs: [runRow(183, 'queued')] }))
    await act(async () => app.invalidations.invalidate('queue'))
    await screen.findByText('Run 183')
  })

  it('says when there are no runs, and retries a list that could not be read', async () => {
    openProject('/projects/fixture/runs', {
      [OVERVIEW]: overviewFixture(),
      [RUNS]: runsFixture({ runs: [], branches: [] }),
    })
    await screen.findByRole('heading', { name: 'No runs yet.' })
    assert.deepEqual(branchLinks(), ['All branches'])
    cleanup()
    const app = openProject('/projects/fixture/runs', {
      [OVERVIEW]: overviewFixture(),
      [RUNS]: { status: 500, body: { error: 'Disk full' } },
    })
    await screen.findByRole('heading', { name: 'The runs could not be read' })
    app.node.set(RUNS, runsFixture())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Run 181')
  })

  it('builds the runs read for a branch, an app ID and a longer list', () => {
    assert.equal(runsPath('fixture', { limit: 50 }), RUNS)
    assert.equal(
      runsPath('fixture', { branch: 'release/1', app: ALPHA, limit: 150 }),
      `${RUNS}?branch=release%2F1&app=${ALPHA}&limit=150`,
    )
  })
})

describe('An app ID’s pages', () => {
  const APP_RUNS = `${RUNS}?app=${ALPHA}`
  const appRuns = runsFixture({
    app: {
      id: 3,
      bundleId: ALPHA,
      name: 'Alpha',
      platforms: ['ios', 'android'],
    },
    branches: [{ branch: 'develop', pinned: false, at: Date.now() }],
    runs: [runRow(181, 'succeeded', { workflow: 'build-alpha' })],
  })

  it('heads Runs and builds with the app ID, its name and platforms, and lists only its runs', async () => {
    openProject(`/projects/fixture/apps/${ALPHA}`, { [APP_RUNS]: appRuns })
    await heading(ALPHA)
    await screen.findByText('Alpha')
    screen.getByText('iOS')
    assert.deepEqual(tabs(ALPHA), {
      labels: ['Runs and builds', 'Build numbers'],
      current: 'Runs and builds',
    })
    assert.deepEqual(branchLinks(), ['All branches', 'developnow'])
    screen.getByText('Run 181 · build-alpha')
    assert.deepEqual(crumbs(), [
      'Mason Master',
      'Projects & apps',
      'Fixture',
      ALPHA,
      'Runs and builds',
    ])
  })

  it('opens a branch of the app ID', async () => {
    const app = openProject(`/projects/fixture/apps/${ALPHA}`, {
      [APP_RUNS]: appRuns,
      [`${RUNS}?branch=develop&app=${ALPHA}`]: {
        ...appRuns,
        branch: 'develop',
      },
    })
    fireEvent.click(await screen.findByRole('link', { name: /^developnow/ }))
    assert.equal(where.path, `/projects/fixture/apps/${ALPHA}?branch=develop`)
    await until(
      () =>
        app.node.requests.includes(`GET ${RUNS}?branch=develop&app=${ALPHA}`),
      'the branch',
    )
    await until(() => crumbs().at(-1) === 'develop', 'the branch crumb')
  })

  it('says an app ID the project does not have is unavailable', async () => {
    openProject(`/projects/fixture/apps/nope`, {
      [`${RUNS}?app=nope`]: { status: 404, body: { error: 'No app ID nope' } },
    })
    await heading('App ID unavailable')
    screen.getByRole('heading', {
      name: 'There is no such app ID in this project.',
    })
  })

  it('shows its sequence’s facts, where it stands per branch, and the app IDs sharing it', async () => {
    openProject(`/projects/fixture/apps/${ALPHA}/build-numbers`, {
      [`/api/v2/projects/fixture/apps/${ALPHA}`]: appFixture(),
    })
    await heading(ALPHA)
    const card = await screen.findByRole('region', { name: 'Build numbers' })
    assert.equal(
      text(card.querySelector('dl')),
      'SequencemobileFormatYYMMDDCCScopePer branchLast issuedmaster26110803develop26110413',
    )
    assert.equal(
      text(card.querySelector('[data-shared]')),
      `Shared with${BETA}`,
    )
    assert.equal(tabs(ALPHA).current, 'Build numbers')
    assert.deepEqual(crumbs(), [
      'Mason Master',
      'Projects & apps',
      'Fixture',
      ALPHA,
      'Build numbers',
    ])
  })

  it('sets where its sequence stands, on its branch, from the sheet', async () => {
    const app = openProject(`/projects/fixture/apps/${ALPHA}/build-numbers`, {
      [`/api/v2/projects/fixture/apps/${ALPHA}`]: appFixture(),
      'POST /api/v2/build-numbers/seed': recording(
        'POST /api/v2/build-numbers/seed',
        200,
        {},
      ),
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Set where it stands' }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Set where mobile stands',
    })
    // The sequence is fixed here.
    assert.equal(within(sheet).queryByLabelText('Sequence'), null)
    fireEvent.change(within(sheet).getByLabelText('Branch'), {
      target: { value: 'master' },
    })
    fireEvent.change(within(sheet).getByLabelText('Last number issued'), {
      target: { value: '26110890' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set' }))
    assert.deepEqual(await bodyOf(app, 'POST /api/v2/build-numbers/seed'), {
      project: 'fixture',
      key: 'mobile',
      branch: 'master',
      last: '26110890',
    })
  })

  it('names the default scheme when no sequence names it; nothing yet, read only on the host', async () => {
    openProject(
      `/projects/fixture/apps/${BETA}/build-numbers`,
      {
        [`/api/v2/projects/fixture/apps/${BETA}`]: appFixture({
          app: { id: 4, bundleId: BETA, name: 'Beta', platforms: ['macos'] },
          sequence: undefined,
          shared: [],
          canSeed: false,
        }),
      },
      'developer',
      'host',
    )
    await screen.findByText(/so it takes the default scheme/)
    assert.match(
      text(screen.getByRole('region', { name: 'Build numbers' })),
      new RegExp(
        `No sequence in the Masonfile names ${BETA.replaceAll('.', '\\.')}, so it takes the default scheme: N, across branches\\.`,
      ),
    )
    assert.equal(screen.queryByRole('button', { name: /Set where/ }), null)
    cleanup()
    openProject(
      `/projects/fixture/apps/${ALPHA}/build-numbers`,
      {
        [`/api/v2/projects/fixture/apps/${ALPHA}`]: appFixture({
          sequence: { ...appFixture().sequence!, last: [], scope: 'app' },
          shared: [],
          canSeed: false,
        }),
      },
      'developer',
      'host',
    )
    const card = await screen.findByRole('region', { name: 'Build numbers' })
    assert.match(
      text(card.querySelector('dl')),
      /Across branchesLast issuedNone yet$/,
    )
    assert.equal(card.querySelector('[data-shared]'), null)
    assert.equal(screen.queryByRole('button', { name: /Set where/ }), null)
  })

  it('says an unknown app ID is unavailable, and retries a failed read', async () => {
    openProject(`/projects/fixture/apps/nope/build-numbers`, {
      '/api/v2/projects/fixture/apps/nope': { status: 404, body: {} },
    })
    await heading('App ID unavailable')
    cleanup()
    const app = openProject(`/projects/fixture/apps/${ALPHA}/build-numbers`, {
      [`/api/v2/projects/fixture/apps/${ALPHA}`]: {
        status: 503,
        body: { error: 'The master is unreachable' },
      },
    })
    await screen.findByRole('heading', { name: 'The app ID could not be read' })
    app.node.set(`/api/v2/projects/fixture/apps/${ALPHA}`, appFixture())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('region', { name: 'Build numbers' })
  })
})
