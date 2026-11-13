import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import type { Discovery, ProjectRecordView } from '../../../shared/api/index.js'
import { until, where } from '../../test/render.js'
import {
  ALPHA,
  BETA,
  bodyOf,
  crumbs,
  heading,
  openProject,
  recording,
  text,
} from '../../test/projects.js'
import { DISCOVERY_POLL_MS } from './Wizard.js'

afterEach(() => cleanup())

const PROJECT = '/api/v2/projects/website'
const DISCOVER = '/api/v2/projects/website/discover'

const record = (
  fields: Partial<ProjectRecordView> = {},
): ProjectRecordView => ({
  slug: 'website',
  name: 'website',
  repository: 'git@github.com:example/website.git',
  defaultBranch: 'main',
  format: 'pipeline',
  webhookSecret: { set: false },
  apps: [],
  rules: [],
  ...fields,
})

const found = (fields: Partial<Discovery> = {}): Discovery => ({
  run: 'run-1',
  status: 'succeeded',
  reason: null,
  apps: [
    {
      bundleId: ALPHA,
      platforms: ['ios', 'android'],
      bundleIds: [`${ALPHA}.widget`],
    },
    { bundleId: BETA, platforms: ['macos'] },
  ],
  triggers: { build: [{ on: 'push' }], nightly: [] },
  ...fields,
})

const steps = (): { current: string; done: string[] } => {
  const list = screen.getByRole('list', { name: 'Steps' })
  const items = [...list.querySelectorAll('li')]
  return {
    current: text(
      items.find((item) => item.getAttribute('aria-current') === 'step') ??
        null,
    ),
    done: items.filter((item) => item.className === 'done').map(text),
  }
}

describe('Add a project', () => {
  it('checks the repository with the master’s credentials, makes the project and goes on to its apps', async () => {
    const app = openProject(
      '/projects/new',
      {
        'POST /api/v2/projects/check': recording(
          'POST /api/v2/projects/check',
          200,
          {
            repository: 'git@github.com:example/website.git',
            slug: 'website',
            defaultBranch: 'main',
          },
        ),
        [`PUT ${PROJECT}`]: recording(`PUT ${PROJECT}`, 201, record()),
        [PROJECT]: record(),
        [DISCOVER]: null,
      },
      'admin',
    )
    await heading('Add a project')
    screen.getByText('A GitHub repository with a Masonfile.')
    screen.getByText('Step 1 of 3')
    assert.deepEqual(steps(), { current: 'Repository', done: [] })
    assert.deepEqual(crumbs(), [
      'Mason Master',
      'Projects & apps',
      'Add a project',
    ])
    const check = screen.getByRole('button', {
      name: 'Check with the master’s GitHub credentials',
    })
    fireEvent.click(check)
    await screen.findByText('Enter the repository.')
    fireEvent.change(screen.getByLabelText('GitHub repository'), {
      target: { value: ' git@github.com:example/website.git ' },
    })
    fireEvent.click(check)
    assert.deepEqual(await bodyOf(app, 'POST /api/v2/projects/check'), {
      repository: 'git@github.com:example/website.git',
    })
    assert.deepEqual(await bodyOf(app, `PUT ${PROJECT}`), {
      name: 'website',
      repository: 'git@github.com:example/website.git',
      defaultBranch: 'main',
      format: 'pipeline',
    })
    await until(() => where.path === '/projects/new?slug=website', 'step 2')
    await screen.findByText('Step 2 of 3')
    assert.deepEqual(steps(), { current: 'Apps', done: ['Repository'] })
    screen.getByText('git@github.com:example/website.git')
  })

  it('keeps a refused repository in the form', async () => {
    openProject(
      '/projects/new',
      {
        'POST /api/v2/projects/check': {
          status: 400,
          body: { error: 'The master cannot read that repository' },
        },
      },
      'manager',
    )
    fireEvent.change(await screen.findByLabelText('GitHub repository'), {
      target: { value: 'git@github.com:example/secret.git' },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Check with the master’s GitHub credentials',
      }),
    )
    await screen.findByText('The master cannot read that repository')
    assert.equal(where.path, '/projects/new')
  })

  it('reads the Masonfile on a worker, says so while it reads, and shows what it declares', async () => {
    let state: Discovery | null = null
    const app = openProject(
      '/projects/new?slug=website',
      {
        [PROJECT]: record(),
        [DISCOVER]: () => new Response(JSON.stringify(state)),
        [`POST ${DISCOVER}`]: () => {
          state = found({ status: 'running', apps: undefined })
          return new Response('{"run":"run-1"}', { status: 202 })
        },
      },
      'manager',
    )
    await screen.findByText(
      'Mason reads the Masonfile on a worker to learn which app IDs it declares.',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Read the Masonfile on main' }),
    )
    await screen.findByText('Reading the Masonfile on a worker…')
    screen.getByText('This page updates when the worker answers.')
    assert.ok(app.node.requests.includes(`POST ${DISCOVER}`))
    state = found()
    await act(
      async () =>
        await new Promise((resolve) =>
          setTimeout(resolve, DISCOVERY_POLL_MS + 100),
        ),
    )
    await screen.findByText(
      'The Masonfile declares these app IDs. Choose the ones this project owns.',
    )
    const alpha = screen.getByRole('checkbox', { name: new RegExp(ALPHA) })
    assert.match(
      text(alpha.closest('label')),
      /iOSAndroidsigns com\.example\.alpha\.widget/,
    )
  })

  it('says a failed or cancelled read, and tries again', async () => {
    const app = openProject(
      '/projects/new?slug=website',
      {
        [PROJECT]: record(),
        [DISCOVER]: found({
          status: 'failed',
          reason: "Masonfile.ts:12 'format' must be a string",
          apps: undefined,
        }),
        [`POST ${DISCOVER}`]: {
          status: 409,
          body: { error: 'A read is under way' },
        },
      },
      'manager',
    )
    await screen.findByText('Reading the Masonfile failed')
    screen.getByText("Masonfile.ts:12 'format' must be a string")
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('A read is under way')
    assert.ok(app.node.requests.includes(`POST ${DISCOVER}`))
    cleanup()
    openProject(
      '/projects/new?slug=website',
      {
        [PROJECT]: record(),
        [DISCOVER]: found({
          status: 'cancelled',
          reason: null,
          apps: undefined,
        }),
      },
      'manager',
    )
    await screen.findByText('Reading the Masonfile was cancelled')
  })

  it('takes the app IDs the project owns and the Apple team, checked first, then goes to branches', async () => {
    const app = openProject(
      '/projects/new?slug=website',
      {
        [PROJECT]: record(),
        [DISCOVER]: found(),
        'POST /api/v2/projects/website/wizard/apps': recording(
          'POST /api/v2/projects/website/wizard/apps',
          200,
          record({ apps: [{ bundleId: ALPHA }] }),
        ),
      },
      'manager',
    )
    const alpha = await screen.findByRole('checkbox', {
      name: new RegExp(ALPHA),
    })
    const beta = screen.getByRole('checkbox', { name: new RegExp(BETA) })
    fireEvent.click(alpha)
    fireEvent.click(beta)
    fireEvent.click(beta)
    const team = screen.getByLabelText(/Apple team ID/)
    fireEvent.change(team, { target: { value: 'nope' } })
    const submit = screen.getByRole('button', {
      name: 'These app IDs are this project’s',
    })
    fireEvent.click(submit)
    await screen.findByText('Ten capital letters and digits.')
    fireEvent.change(team, { target: { value: 'V4AK4X7A2V' } })
    fireEvent.click(submit)
    assert.deepEqual(
      await bodyOf(app, 'POST /api/v2/projects/website/wizard/apps'),
      { apps: ALPHA, team: 'V4AK4X7A2V' },
    )
    await until(
      () => where.path === '/projects/new?slug=website&step=3',
      'step 3',
    )
    // Back to the repository from the apps.
    cleanup()
    openProject(
      '/projects/new?slug=website&step=2',
      {
        [PROJECT]: record({ apps: [{ bundleId: ALPHA }] }),
        [DISCOVER]: found({ apps: [] }),
        'POST /api/v2/projects/website/wizard/apps': {
          status: 400,
          body: { error: 'The Masonfile does not declare that' },
        },
      },
      'manager',
    )
    await screen.findByText('It declares none.')
    fireEvent.click(
      screen.getByRole('button', { name: 'These app IDs are this project’s' }),
    )
    await screen.findByText('The Masonfile does not declare that')
    fireEvent.click(screen.getByRole('link', { name: /Repository/ }))
    assert.equal(where.path, '/projects/new')
  })

  it('saves branch rules, creates the webhook, shows the triggers read only, and is done', async () => {
    const app = openProject(
      '/projects/new?slug=website',
      {
        [PROJECT]: record({ apps: [{ bundleId: ALPHA }] }),
        [DISCOVER]: found(),
        'POST /api/v2/projects/website/wizard/rules': recording(
          'POST /api/v2/projects/website/wizard/rules',
          200,
          record(),
        ),
        'POST /api/v2/projects/website/webhook': {
          status: 200,
          body: {
            created: true,
            url: 'https://host.test/api/webhooks/github/website',
          },
        },
      },
      'manager',
    )
    await screen.findByText('Step 3 of 3')
    assert.deepEqual(steps(), {
      current: 'Branches and triggers',
      done: ['Repository', 'Apps'],
    })
    const rules = screen.getByLabelText('Branch rules') as HTMLTextAreaElement
    assert.equal(rules.value, 'main automatic\n* request')
    fireEvent.change(rules, {
      target: { value: 'main automatic\nrelease/* request' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }))
    assert.deepEqual(
      await bodyOf(app, 'POST /api/v2/projects/website/wizard/rules'),
      { rules: 'main automatic\nrelease/* request' },
    )
    await screen.findByText('Branch rules saved')
    screen.getByText('No webhook yet. Pushes are not seen until it exists.')
    fireEvent.click(
      screen.getByRole('button', { name: 'Create the GitHub webhook' }),
    )
    await screen.findByText(
      'GitHub posts pushes to https://host.test/api/webhooks/github/website',
    )
    const triggers = screen.getByLabelText('Triggers')
    assert.deepEqual([...triggers.children].map(text), [
      'build [{"on":"push"}]',
      'nightly []',
    ])
    assert.equal(
      screen.getByRole('link', { name: /Done/ }).getAttribute('href'),
      '/projects?project=website',
    )
    fireEvent.click(screen.getByRole('link', { name: /Apps/ }))
    assert.equal(where.path, '/projects/new?slug=website&step=2')
  })

  it('keeps the rules a project has, and says what failed: rules, the webhook, an unread Masonfile', async () => {
    openProject(
      '/projects/new?slug=website&step=3',
      {
        [PROJECT]: record({
          rules: [{ pattern: 'trunk', mode: 'automatic' }],
          webhookSecret: { set: true },
        }),
        [DISCOVER]: null,
        'POST /api/v2/projects/website/wizard/rules': {
          status: 400,
          body: { error: 'mode is automatic or request' },
        },
        'POST /api/v2/projects/website/webhook': {
          status: 400,
          body: {
            error: 'Set the host’s origin first: GitHub posts to the host',
          },
        },
      },
      'manager',
    )
    const rules = (await screen.findByLabelText(
      'Branch rules',
    )) as HTMLTextAreaElement
    assert.equal(rules.value, 'trunk automatic')
    screen.getByText('The project has a webhook secret.')
    screen.getByText('Read the Masonfile first.')
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }))
    await screen.findByText('mode is automatic or request')
    fireEvent.click(
      screen.getByRole('button', { name: 'Create the GitHub webhook' }),
    )
    await screen.findByText(
      'Set the host’s origin first: GitHub posts to the host',
    )
  })

  it('offers Retry when the project or the Masonfile’s state cannot be read', async () => {
    const app = openProject(
      '/projects/new?slug=website',
      {
        [PROJECT]: { status: 500, body: { error: 'Database busy' } },
      },
      'manager',
    )
    await screen.findByRole('heading', {
      name: 'The project could not be read',
    })
    app.node.set(PROJECT, record())
    app.node.set(DISCOVER, { status: 500, body: { error: 'Still busy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('heading', {
      name: 'The Masonfile’s state could not be read',
    })
    app.node.set(DISCOVER, null)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('button', { name: 'Read the Masonfile on main' })
  })

  it('is for managers and administrators on the master: a developer reads the 403, the host has no such page', async () => {
    openProject('/projects/new', {}, 'developer')
    await heading('Add a project')
    await screen.findByText(/manager/)
    assert.equal(screen.queryByLabelText('GitHub repository'), null)
    cleanup()
    openProject('/projects/new', {}, 'admin', 'host')
    await screen.findByRole('heading', { level: 1 })
    assert.equal(screen.queryByLabelText('GitHub repository'), null)
    assert.notEqual(
      text(screen.getByRole('heading', { level: 1 })),
      'Add a project',
    )
    assert.equal(within(document.body).queryByText('Step 1 of 3'), null)
  })
})
