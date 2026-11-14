import assert from 'node:assert/strict'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { until, where } from '../../test/render.js'
import {
  ALPHA,
  BETA,
  bodyOf,
  crumbs,
  heading,
  openProject,
  overviewFixture,
  recording,
  tabs,
  text,
} from '../../test/projects.js'
import { appHref, projectHref } from './project.js'

afterEach(() => cleanup())

const OVERVIEW = '/api/v2/projects/fixture/overview'

describe('A project’s Overview', () => {
  it('heads the project with its Masonfile, repository and tabs, Secrets on the master', async () => {
    openProject('/projects/fixture', { [OVERVIEW]: overviewFixture() })
    await heading('Fixture')
    screen.getByText('Pipeline Masonfile')
    screen.getByText('git@github.com:example/fixture.git')
    assert.deepEqual(tabs('Fixture'), {
      labels: ['Overview', 'Runs and builds', 'Masonfile', 'Secrets'],
      current: 'Overview',
    })
    assert.deepEqual(crumbs(), ['Mason Master', 'Projects & apps', 'Fixture'])
    assert.equal(document.title, 'Fixture · Mason')
  })

  it('lists the app IDs with their names, platforms, Apple team and pages', async () => {
    openProject('/projects/fixture', { [OVERVIEW]: overviewFixture() })
    const card = await screen.findByRole('region', { name: /App IDs/ })
    assert.match(text(card.querySelector('header')), /App IDs\s*2/)
    const rows = within(card).getAllByRole('row').slice(1)
    assert.deepEqual(
      [...rows[0]!.querySelectorAll('td')].slice(0, 3).map(text),
      [`${ALPHA}Alpha`, 'iOSAndroid', 'V4AK4X7A2V'],
    )
    assert.equal(text(rows[1]!.querySelectorAll('td')[2]!), '—')
    assert.equal(
      within(rows[0]!).getByRole('link', { name: ALPHA }).getAttribute('href'),
      appHref('fixture', ALPHA),
    )
    assert.equal(
      within(rows[1]!)
        .getByRole('link', { name: `Build numbers of ${BETA}` })
        .getAttribute('href'),
      `/projects/fixture/apps/${BETA}/build-numbers`,
    )
    fireEvent.click(within(rows[0]!).getByRole('link', { name: ALPHA }))
    assert.equal(where.path, `/projects/fixture/apps/${ALPHA}`)
  })

  it('shows the branch rules, the default branch, the webhook and the signing label', async () => {
    openProject('/projects/fixture', { [OVERVIEW]: overviewFixture() })
    const card = await screen.findByRole('region', { name: 'Branch rules' })
    assert.deepEqual(
      within(card)
        .getAllByRole('row')
        .slice(1)
        .map((row) => text(row)),
      ['masterAutomatic', 'release/*Automatic', '*On request'],
    )
    const facts = text(card.querySelector('dl'))
    assert.match(facts, /Default branchmaster/)
    assert.match(facts, /MasonfilePipeline/)
    assert.match(facts, /WebhookSet up/)
    assert.match(facts, /Signs onnodes labelled mac-signing/)
  })

  it('says what is missing: no app IDs, no rules, no sequences, no webhook, a script project', async () => {
    openProject('/projects/fixture', {
      [OVERVIEW]: overviewFixture({
        apps: [],
        rules: [{ pattern: 'odd', mode: 'manual' }],
        buildNumbers: [],
        webhook: false,
        format: 'script',
        signingLabel: undefined,
        canSeed: true,
      }),
    })
    await screen.findByRole('heading', { name: 'None.' })
    screen.getByText('Script project')
    screen.getByText('manual')
    screen.getByText(
      'The Masonfile declares no build numbers yet, or setup has not run.',
    )
    screen.getByText('Not set up')
    assert.equal(screen.queryByText('Signs on'), null)
    // Nothing to set.
    assert.equal(screen.queryByRole('button', { name: /Set where/ }), null)
    cleanup()
    openProject('/projects/fixture', {
      [OVERVIEW]: overviewFixture({ rules: [] }),
    })
    await screen.findByRole('heading', { name: 'No rules: nothing builds.' })
  })

  it('lists the sequences with their scope and where each stands', async () => {
    openProject('/projects/fixture', { [OVERVIEW]: overviewFixture() })
    const card = await screen.findByRole('region', { name: /Build numbers/ })
    assert.deepEqual(
      within(card)
        .getAllByRole('row')
        .slice(1)
        .map((row) => [...row.querySelectorAll('td')].map(text)),
      [
        ['mobile', 'YYMMDDCC', 'Across branches', '26110803'],
        ['tv', 'N', 'Per branch', 'develop290staging212'],
      ],
    )
  })

  it('sets where a sequence stands from a form sheet: the sequence, its branch, the last number', async () => {
    const app = openProject('/projects/fixture', {
      [OVERVIEW]: overviewFixture(),
      'POST /api/v2/build-numbers/seed': recording(
        'POST /api/v2/build-numbers/seed',
        200,
        { key: 'tv' },
      ),
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Set where it stands' }),
    )
    const sheet = await screen.findByRole('dialog', { name: /Set where/ })
    const sequence = within(sheet).getByLabelText('Sequence')
    assert.deepEqual(
      [...sequence.querySelectorAll('option')].map((option) => option.text),
      ['mobile', 'tv'],
    )
    // Across branches: no branch to name.
    assert.equal(within(sheet).queryByLabelText('Branch'), null)
    within(sheet).getByText(
      'The next build of that sequence gets the number after it. Nothing is lowered.',
    )
    fireEvent.change(sequence, { target: { value: 'tv' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set' }))
    await within(sheet).findByText('Enter the branch this sequence numbers.')
    within(sheet).getByText('Enter the last number issued.')
    fireEvent.change(within(sheet).getByLabelText('Branch'), {
      target: { value: 'develop' },
    })
    const last = within(sheet).getByLabelText('Last number issued')
    assert.equal(last.getAttribute('placeholder'), 'N')
    fireEvent.change(last, { target: { value: '300' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set' }))
    assert.deepEqual(await bodyOf(app, 'POST /api/v2/build-numbers/seed'), {
      project: 'fixture',
      key: 'tv',
      branch: 'develop',
      last: '300',
    })
    await screen.findByText('tv stands at 300')
    await until(
      () => screen.queryByRole('dialog', { name: /Set where/ }) == null,
      'the sheet to close',
    )
    await until(
      () =>
        app.node.requests.filter((request) => request === `GET ${OVERVIEW}`)
          .length >= 2,
      'the overview read again',
    )
  })

  it('keeps a refused number in the sheet, and asks before discarding what was typed', async () => {
    openProject('/projects/fixture', {
      [OVERVIEW]: overviewFixture(),
      'POST /api/v2/build-numbers/seed': {
        status: 400,
        body: { error: '7 is below where mobile stands' },
      },
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Set where it stands' }),
    )
    const sheet = await screen.findByRole('dialog', { name: /Set where/ })
    fireEvent.change(within(sheet).getByLabelText('Last number issued'), {
      target: { value: '7' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set' }))
    await within(sheet).findByText('7 is below where mobile stands')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    const discard = await screen.findByRole('alertdialog', {
      name: 'Discard your changes?',
    })
    fireEvent.click(within(discard).getByRole('button', { name: 'Discard' }))
    await until(
      () => screen.queryByRole('dialog', { name: /Set where/ }) == null,
      'the sheet to close',
    )
  })

  it('hides Set where it stands from a developer, and on the host also Secrets', async () => {
    openProject(
      '/projects/fixture',
      { [OVERVIEW]: overviewFixture({ canSeed: false }) },
      'developer',
    )
    await screen.findByRole('region', { name: /Build numbers/ })
    assert.equal(screen.queryByRole('button', { name: /Set where/ }), null)
    assert.ok(tabs('Fixture').labels.includes('Secrets'))
    cleanup()
    openProject(
      '/projects/fixture',
      { [OVERVIEW]: overviewFixture({ canSeed: false, secrets: false }) },
      'developer',
      'host',
    )
    await screen.findByRole('region', { name: /Build numbers/ })
    assert.deepEqual(tabs('Fixture').labels, [
      'Overview',
      'Runs and builds',
      'Masonfile',
    ])
    assert.deepEqual(crumbs(), ['Mason Host', 'Projects & apps', 'Fixture'])
  })

  it('requests a run on the default branch, of a workflow its Masonfile declares', async () => {
    const app = openProject('/projects/fixture', {
      [OVERVIEW]: overviewFixture(),
      'POST /api/v2/runs': recording('POST /api/v2/runs', 202, {
        id: 'run-190',
        number: 190,
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Request run' }))
    const sheet = await screen.findByRole('dialog', { name: 'Request a run' })
    assert.equal(
      (within(sheet).getByLabelText('Branch') as HTMLInputElement).value,
      'master',
    )
    const workflow = within(sheet).getByLabelText('Workflow')
    assert.equal((workflow as HTMLSelectElement).value, 'build')
    fireEvent.change(workflow, { target: { value: 'release' } })
    fireEvent.change(within(sheet).getByLabelText('notes'), {
      target: { value: 'New player' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Request' }))
    assert.deepEqual(await bodyOf(app, 'POST /api/v2/runs'), {
      project: 'fixture',
      branch: 'master',
      workflow: 'release',
      params: { notes: 'New player' },
    })
    await until(() => where.path === '/runs/run-190', 'the new run')
  })

  it('types the workflow when no recorded Masonfile names one, and starts with the first without a build workflow', async () => {
    openProject('/projects/fixture', {
      [OVERVIEW]: overviewFixture({ workflows: undefined }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Request run' }))
    const sheet = await screen.findByRole('dialog', { name: 'Request a run' })
    assert.equal(
      (within(sheet).getByLabelText('Workflow') as HTMLInputElement).value,
      'build',
    )
    cleanup()
    openProject(
      '/projects/fixture',
      {
        [OVERVIEW]: overviewFixture({
          workflows: [{ name: 'deploy', params: {} }],
        }),
      },
      'developer',
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Request run' }))
    const other = await screen.findByRole('dialog', { name: 'Request a run' })
    assert.equal(
      (within(other).getByLabelText('Workflow') as HTMLSelectElement).value,
      'deploy',
    )
  })

  it('disables Request run on a host whose master is unreachable, saying why', async () => {
    openProject(
      '/projects/fixture',
      { [OVERVIEW]: overviewFixture({ canSeed: false, secrets: false }) },
      'developer',
      'host',
      {
        node: 'host',
        link: { online: false, maintenance: false },
        banners: [],
      },
    )
    const request = await screen.findByRole('button', { name: 'Request run' })
    await until(() => (request as HTMLButtonElement).disabled, 'disabled')
    assert.equal(
      request.getAttribute('title'),
      'The master is unreachable: try again once it is back.',
    )
  })

  it('says a project the node does not hold is unavailable, and retries a failed read', async () => {
    openProject('/projects/nope', {
      '/api/v2/projects/nope/overview': {
        status: 404,
        body: { error: 'No project named nope' },
      },
    })
    await heading('Project unavailable')
    screen.getByRole('heading', { name: 'There is no such project.' })
    cleanup()
    let calls = 0
    openProject('/projects/fixture', {
      [OVERVIEW]: () =>
        ++calls === 1
          ? new Response('{"error":"The database is busy"}', { status: 500 })
          : new Response(JSON.stringify(overviewFixture()), { status: 200 }),
    })
    await screen.findByText('The database is busy')
    screen.getByRole('heading', { name: 'The project could not be read' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('region', { name: /App IDs/ })
  })

  it('builds the project’s and app IDs’ addresses', () => {
    assert.equal(projectHref('my app'), '/projects/my%20app')
    assert.equal(
      projectHref('fixture', 'runs', { branch: 'release/1', other: undefined }),
      '/projects/fixture/runs?branch=release%2F1',
    )
    assert.equal(
      appHref('fixture', 'a&b', 'build-numbers'),
      '/projects/fixture/apps/a%26b/build-numbers',
    )
  })
})
