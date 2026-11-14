import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { after, afterEach, before, describe, it } from 'mocha'
import type { RunPage } from '../../../shared/api/index.js'
import { fakeLogLayout } from '../../test/layout.js'
import { until, where } from '../../test/render.js'
import { heading, open, RUN_PATH, runFixture } from '../../test/runs.js'
import { paramDefaults, typedParams } from './params.js'

afterEach(() => cleanup())

/** A release waiting for a manager's approval, with parameters. */
const waiting = (fields: Partial<RunPage> = {}): RunPage => {
  const base = runFixture()
  return runFixture({
    status: 'running',
    finished: null,
    stages: [
      base.stages[0]!,
      {
        name: 'approve',
        kind: 'approval',
        status: 'awaiting_approval',
        attempt: 0,
        started: null,
        finished: null,
      },
    ],
    graph: {
      ...base.graph!,
      approvals: {
        approve: {
          roles: ['manager'],
          message: 'Ship Alpha to the testers?',
          params: {
            notes: { type: 'text', description: 'What changed.' },
            rollout: { type: 'number', min: 1, max: 100, default: 10 },
          },
        },
      },
    },
    layout: undefined,
    ...fields,
  })
}

/** Whatever the node was sent last for a request. */
const bodyOf = async (
  app: ReturnType<typeof open>,
  key: string,
): Promise<unknown> => {
  await until(() => app.node.requests.includes(key), key)
  return sentBodies.get(key)
}
const sentBodies = new Map<string, unknown>()
/** A reply that records its request's body. */
const recording =
  (key: string, status: number, body: unknown) =>
  (_url: string, init: RequestInit): Response => {
    sentBodies.set(key, JSON.parse(String(init.body ?? 'null')))
    return new Response(JSON.stringify(body), { status })
  }

/** A field by its label. */
const field = (scope: HTMLElement, label: string): HTMLInputElement =>
  within(scope).getByLabelText(label) as HTMLInputElement

describe('Run page actions', () => {
  let restore: () => void
  before(() => {
    restore = fakeLogLayout()
  })
  after(() => restore())

  it('lets whoever may decide approve with typed parameters, checked first, or reject', async () => {
    const app = open(
      '/runs/r1',
      {
        [RUN_PATH]: waiting(),
        'POST /api/v2/runs/r1/approve': recording(
          'POST /api/v2/runs/r1/approve',
          200,
          { id: 'r1', number: 182 },
        ),
      },
      { role: 'manager' },
    )
    await heading('Build 26110902')
    const box = screen.getByRole('region', {
      name: 'approve waits for your approval',
    })
    within(box).getByText('Ship Alpha to the testers?')
    within(box).getByText('What changed.')
    within(box).getByText('From 1 to 100.')
    const rollout = field(box, 'rollout')
    assert.equal(rollout.value, '10')
    fireEvent.change(rollout, { target: { value: '500' } })
    fireEvent.change(field(box, 'notes'), {
      target: { value: 'Offline cache' },
    })
    await act(async () =>
      within(box)
        .getByRole('button', { name: /Approve/ })
        .click(),
    )
    within(box).getByText('Enter at most 100.')
    assert(!app.node.requests.includes('POST /api/v2/runs/r1/approve'))
    fireEvent.change(rollout, { target: { value: '50' } })
    await act(async () =>
      within(box)
        .getByRole('button', { name: /Approve/ })
        .click(),
    )
    assert.deepEqual(await bodyOf(app, 'POST /api/v2/runs/r1/approve'), {
      stage: 'approve',
      approve: true,
      params: { notes: 'Offline cache', rollout: 50 },
    })
    await screen.findByText('approve approved')
    // A refusal stays beside the buttons.
    app.node.set('POST /api/v2/runs/r1/approve', {
      status: 409,
      body: { error: 'approve is not waiting for approval' },
    })
    await act(async () =>
      within(box)
        .getByRole('button', { name: /Reject/ })
        .click(),
    )
    await within(box).findByText('approve is not waiting for approval')
    app.node.set(
      'POST /api/v2/runs/r1/approve',
      recording('POST /api/v2/runs/r1/approve', 200, { id: 'r1', number: 182 }),
    )
    await act(async () =>
      within(box)
        .getByRole('button', { name: /Reject/ })
        .click(),
    )
    await screen.findByText('approve rejected')
    assert.deepEqual(sentBodies.get('POST /api/v2/runs/r1/approve'), {
      stage: 'approve',
      approve: false,
    })
  })

  it('tells a viewer who cannot decide whom the approval waits for, also in the stage panel', async () => {
    open('/runs/r1', { [RUN_PATH]: waiting() }, { role: 'developer' })
    await heading('Build 26110902')
    const box = screen.getByRole('region', { name: 'Approval of approve' })
    within(box).getByText('Waiting for manager to approve.')
    assert.equal(within(box).queryByRole('button'), null)
    cleanup()
    open(
      '/runs/r1?stage=approve',
      {
        [RUN_PATH]: waiting({
          graph: {
            ...waiting().graph!,
            approvals: {
              approve: { roles: ['admin', 'manager'], params: {} },
            },
          },
        }),
      },
      { role: 'developer' },
    )
    await heading('Build 26110902')
    const panel = document.querySelector<HTMLElement>('.m-stagepanel')!
    within(panel).getByText('Waiting for admin or manager to approve.')
    // Chosen, the approval is the panel's, not also above the graph.
    assert.equal(document.querySelectorAll('.m-approval').length, 1)
    cleanup()
    // An administrator decides any approval.
    open('/runs/r1?stage=approve', { [RUN_PATH]: waiting() }, { role: 'admin' })
    await heading('Build 26110902')
    within(document.querySelector<HTMLElement>('.m-stagepanel')!).getByRole(
      'button',
      { name: /Approve/ },
    )
  })

  it('requests a run from the sheet: branch, a workflow chosen from the Masonfile and its typed parameters', async () => {
    const release = {
      channel: {
        type: 'choice',
        choices: ['testflight', 'app-store'],
        description: 'Where publish sends the build.',
      },
      skipTests: { type: 'boolean', default: false },
      rollout: { type: 'number', min: 1, max: 100, default: 10 },
      notes: { type: 'text' },
      tag: { type: 'string', pattern: '^v\\d+$' },
    }
    const app = open('/runs/r1', {
      [RUN_PATH]: runFixture({
        graph: {
          ...runFixture().graph!,
          workflows: [
            { name: 'build', params: {} },
            { name: 'release', params: release },
          ],
        },
      }),
      'POST /api/v2/runs': recording('POST /api/v2/runs', 202, {
        id: 'r9',
        number: 9,
      }),
      '/api/v2/runs/r9?include=graph,steps,history,details': runFixture({
        id: 'r9',
        number: 9,
        workflow: 'release',
      }),
    })
    await heading('Build 26110902')
    await act(async () =>
      screen.getByRole('button', { name: /Request run/ }).click(),
    )
    const sheet = screen.getByRole('dialog', { name: 'Request a run' })
    const branch = field(sheet, 'Branch')
    assert.equal(branch.value, 'paul/offlineCache')
    assert.equal(document.activeElement, branch)
    const workflow = within(sheet).getByRole('combobox', { name: 'Workflow' })
    assert.equal((workflow as HTMLSelectElement).value, 'build')
    assert.equal(within(sheet).queryByRole('group'), null)
    fireEvent.change(workflow, { target: { value: 'release' } })
    within(sheet).getByText('Parameters of release')
    within(sheet).getByText('Where publish sends the build.')
    within(sheet).getByText('Matches ^v\\d+$.')
    assert.equal(
      (
        within(sheet).getByRole('combobox', {
          name: 'skipTests',
        }) as HTMLSelectElement
      ).value,
      'false',
    )
    fireEvent.change(
      within(sheet).getByRole('combobox', { name: 'skipTests' }),
      {
        target: { value: 'true' },
      },
    )
    fireEvent.change(field(sheet, 'rollout'), { target: { value: 'ten' } })
    fireEvent.change(field(sheet, 'tag'), { target: { value: 'two' } })
    fireEvent.change(branch, { target: { value: ' ' } })
    await act(async () =>
      within(sheet)
        .getByRole('button', { name: /^Request$/ })
        .click(),
    )
    within(sheet).getByText('Enter a branch.')
    within(sheet).getByText('Enter a number.')
    within(sheet).getByText('Enter text that matches ^v\\d+$.')
    assert(!app.node.requests.includes('POST /api/v2/runs'))
    fireEvent.change(branch, { target: { value: 'develop' } })
    fireEvent.change(field(sheet, 'rollout'), { target: { value: '20' } })
    fireEvent.change(field(sheet, 'tag'), { target: { value: 'v2' } })
    fireEvent.change(field(sheet, 'notes'), {
      target: { value: 'two\nlines' },
    })
    await act(async () =>
      within(sheet)
        .getByRole('button', { name: /^Request$/ })
        .click(),
    )
    assert.deepEqual(await bodyOf(app, 'POST /api/v2/runs'), {
      project: 'fixture',
      branch: 'develop',
      workflow: 'release',
      params: {
        channel: 'testflight',
        skipTests: true,
        rollout: 20,
        notes: 'two\nlines',
        tag: 'v2',
      },
    })
    await until(() => where.path === '/runs/r9', 'the new run')
    await screen.findByText('Run 9 · release requested')
  })

  it('keeps a refused request in the sheet, and asks before closing it with changes', async () => {
    const app = open('/runs/r1', {
      [RUN_PATH]: runFixture({ graph: undefined, layout: undefined }),
      'POST /api/v2/runs': {
        status: 403,
        body: { error: 'Your key may not request runs of develop' },
      },
    })
    await heading('Build 26110902')
    await act(async () =>
      screen.getByRole('button', { name: /Request run/ }).click(),
    )
    let sheet = screen.getByRole('dialog', { name: 'Request a run' })
    // Without the Masonfile's workflows, the workflow is typed.
    const workflow = field(sheet, 'Workflow')
    fireEvent.change(workflow, { target: { value: 'nightly' } })
    await act(async () =>
      within(sheet)
        .getByRole('button', { name: /^Request$/ })
        .click(),
    )
    await within(sheet).findByText('Your key may not request runs of develop')
    assert.deepEqual(
      app.node.requests.filter((r) => r.startsWith('POST')),
      ['POST /api/v2/runs'],
    )
    await act(async () =>
      within(sheet).getByRole('button', { name: 'Cancel' }).click(),
    )
    const confirm = screen.getByRole('alertdialog', {
      name: 'Discard your changes?',
    })
    await act(async () =>
      within(confirm).getByRole('button', { name: 'Discard' }).click(),
    )
    assert.equal(screen.queryByRole('dialog', { name: 'Request a run' }), null)
    // Opened again, it starts from the run.
    await act(async () =>
      screen.getByRole('button', { name: /Request run/ }).click(),
    )
    sheet = screen.getByRole('dialog', { name: 'Request a run' })
    assert.equal(field(sheet, 'Workflow').value, 'build')
  })

  it('cancels a running run after asking, and a queued one at once', async () => {
    const app = open('/runs/r1', {
      [RUN_PATH]: runFixture({ status: 'running', finished: null }),
      'POST /api/v2/runs/r1/cancel': { cancelled: true },
    })
    await heading('Build 26110902')
    await act(async () =>
      screen.getByRole('button', { name: /Cancel run/ }).click(),
    )
    const alert = screen.getByRole('alertdialog', { name: 'Cancel Run 182?' })
    within(alert).getByText(
      'Run 182 of Fixture on paul/offlineCache stops: its running stages are stopped and the rest never start.',
    )
    await act(async () =>
      within(alert).getByRole('button', { name: 'Keep running' }).click(),
    )
    assert(!app.node.requests.includes('POST /api/v2/runs/r1/cancel'))
    await act(async () =>
      screen.getByRole('button', { name: /Cancel run/ }).click(),
    )
    await act(async () =>
      within(screen.getByRole('alertdialog', { name: 'Cancel Run 182?' }))
        .getByRole('button', { name: 'Cancel run' })
        .click(),
    )
    await screen.findByText('Run 182 cancelled')
    assert(app.node.requests.includes('POST /api/v2/runs/r1/cancel'))
    cleanup()
    const queued = open('/runs/r1', {
      [RUN_PATH]: runFixture({
        status: 'queued',
        finished: null,
        started: null,
      }),
      'POST /api/v2/runs/r1/cancel': { cancelled: false },
    })
    await heading('Build 26110902')
    await act(async () =>
      screen.getByRole('button', { name: /Cancel run/ }).click(),
    )
    assert.equal(screen.queryByRole('alertdialog'), null)
    await screen.findByText('Run 182 had already ended')
    assert(queued.node.requests.includes('POST /api/v2/runs/r1/cancel'))
    queued.node.set('POST /api/v2/runs/r1/cancel', {
      status: 503,
      body: { error: 'The master is unreachable' },
    })
    await act(async () =>
      screen.getByRole('button', { name: /Cancel run/ }).click(),
    )
    await screen.findByText('The master is unreachable')
  })

  it('types parameters as the Masonfile declares them', () => {
    const specs = {
      choice: { type: 'choice', choices: ['a', 'b'] },
      flag: { type: 'boolean' },
      count: { type: 'number', min: 2 },
      most: { type: 'number', max: 5 },
      text: { type: 'text', default: 'kept' },
      line: { type: 'string', default: 'x' },
      bad: { type: 'string', pattern: '(' },
      free: { type: 'string' },
    }
    assert.deepEqual(paramDefaults(specs), {
      choice: 'a',
      flag: 'false',
      count: '',
      most: '',
      text: 'kept',
      line: 'x',
      bad: '',
      free: '',
    })
    assert.deepEqual(
      typedParams(specs, {
        choice: 'c',
        flag: '',
        count: '1',
        most: '9',
        text: '',
        line: 'a\nb',
        bad: 'anything',
        free: '',
      }),
      {
        params: { bad: 'anything', free: '' },
        errors: {
          choice: 'Choose one of a, b.',
          flag: 'Enter a value.',
          count: 'Enter at least 2.',
          most: 'Enter at most 5.',
          line: 'Enter one line.',
        },
      },
    )
  })
})
