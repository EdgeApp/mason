import assert from 'node:assert/strict'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { until } from '../../../test/render.js'
import { text } from '../../../test/projects.js'
import {
  cloudNode,
  doAccount,
  held,
  isBusy,
  macPool,
  nomacAccount,
  openNodes,
  openNodesWithout,
  PATHS,
  pending,
  pool,
} from '../../../test/nodes.js'
import { poolSummary } from './pools.js'

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
})

const reads = (app: ReturnType<typeof openNodes>, path: string): number =>
  app.node.requests.filter((r) => r === `GET ${path}`).length

const cloudCard = async (): Promise<HTMLElement> =>
  await screen.findByRole('region', { name: 'Cloud nodes' })

const poolsCard = async (): Promise<HTMLElement> =>
  await screen.findByRole('region', { name: /Cloud pools/ })

/** A pool's or a cloud node's row by its name. */
const row = (scope: HTMLElement, name: string): HTMLElement =>
  within(scope).getByText(name, { selector: '.m-nodes__name' }).closest('li')!

const discard = async (): Promise<void> => {
  fireEvent.click(
    within(
      await screen.findByRole('alertdialog', { name: 'Discard your changes?' }),
    ).getByRole('button', { name: 'Discard' }),
  )
  await until(() => screen.queryByRole('dialog') == null, 'the sheet closed')
}

describe('Cloud nodes', () => {
  it('lists each cloud node with its state, type, labels and place', async () => {
    openNodes({
      [PATHS.cloudNodes]: [
        cloudNode(),
        cloudNode({
          name: 'mac-builder',
          state: 'updating',
          version: '0.6.1',
          node_type: undefined,
          labels: [],
          address: undefined,
          error: 'The droplet did not answer within 10 minutes.',
        }),
      ],
    })
    const card = await cloudCard()
    await within(card).findByText('android-builder')
    const android = row(card, 'android-builder')
    within(android).getByText('Ready', { selector: '.m-status' })
    within(android).getByText(
      'linux-x64 · android · sfo3 · s-4vcpu-8gb · 164.92.4.77 · Mason 0.6.0',
    )
    const mac = row(card, 'mac-builder')
    within(mac).getByText('sfo3 · s-4vcpu-8gb')
    within(mac).getByText(
      'Updating to Mason 0.6.1, as the master asked over its link; it reconnects on its own.',
    )
    within(mac).getByText('The droplet did not answer within 10 minutes.')
    within(card).getByRole('button', { name: 'Create a node on DigitalOcean' })
    assert.equal(
      within(card).queryByRole('button', { name: 'Create a node on NoMac' }),
      null,
    )
  })

  it('reconciles a node, busy until it answers, and keeps a refusal inline', async () => {
    const reconcile = held()
    const app = openNodes({
      [`POST ${PATHS.cloudNodes}/android-builder/reconcile`]: reconcile.reply,
    })
    const card = await cloudCard()
    const button = await within(card).findByRole('button', {
      name: 'Reconcile android-builder',
    })
    fireEvent.click(button)
    await until(() => isBusy(button), 'the busy button')
    const before = reads(app, PATHS.cloudNodes)
    reconcile.answer(200, cloudNode())
    await screen.findByText('android-builder checked again')
    await until(() => reads(app, PATHS.cloudNodes) > before, 'read again')
    cleanup()
    openNodes({
      [`POST ${PATHS.cloudNodes}/android-builder/reconcile`]: {
        status: 404,
        body: { error: 'No node named android-builder' },
      },
    })
    fireEvent.click(
      await within(await cloudCard()).findByRole('button', {
        name: 'Reconcile android-builder',
      }),
    )
    await screen.findByText('No node named android-builder')
  })

  it('removes a node only once its name is typed (tier 3)', async () => {
    const remove = held()
    const app = openNodes({
      [`DELETE ${PATHS.cloudNodes}/android-builder`]: remove.reply,
    })
    const card = await cloudCard()
    fireEvent.click(
      await within(card).findByRole('button', {
        name: 'Remove android-builder',
      }),
    )
    const alert = await screen.findByRole('alertdialog', {
      name: 'Remove the node android-builder?',
    })
    within(alert).getByText(/Its droplet is destroyed and it is unpaired/)
    const confirm = within(alert).getByRole('button', {
      name: 'Remove node',
    }) as HTMLButtonElement
    assert.equal(confirm.disabled, true)
    assert.ok(confirm.className.includes('m-btn--danger-filled'))
    fireEvent.change(within(alert).getByLabelText(/to confirm/), {
      target: { value: 'android-builder' },
    })
    assert.equal(confirm.disabled, false)
    fireEvent.click(confirm)
    await until(() => remove.body() != null, 'the request')
    assert.deepEqual(remove.body(), { confirm: 'android-builder' })
    await until(() => isBusy(confirm), 'the busy button')
    const before = reads(app, PATHS.cloudNodes)
    app.node.set(PATHS.cloudNodes, [])
    remove.answer(200, null)
    await screen.findByText('android-builder removed')
    await until(() => reads(app, PATHS.cloudNodes) > before, 'read again')
    await within(card).findByText('None yet.')
    cleanup()
    openNodes({
      [`DELETE ${PATHS.cloudNodes}/android-builder`]: {
        status: 400,
        body: { error: 'DigitalOcean refused' },
      },
    })
    const again = await cloudCard()
    fireEvent.click(
      await within(again).findByRole('button', {
        name: 'Remove android-builder',
      }),
    )
    const second = await screen.findByRole('alertdialog')
    fireEvent.change(within(second).getByLabelText(/to confirm/), {
      target: { value: 'android-builder' },
    })
    fireEvent.click(within(second).getByRole('button', { name: 'Remove node' }))
    await within(again).findByText('DigitalOcean refused')
    await until(() => screen.queryByRole('alertdialog') == null, 'closed')
    fireEvent.click(
      within(again).getByRole('button', { name: 'Remove android-builder' }),
    )
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cancel',
      }),
    )
    await until(() => screen.queryByRole('alertdialog') == null, 'cancelled')
  })

  it('creates a node on an account from its catalog', async () => {
    const create = held()
    const app = openNodes({ [`POST ${PATHS.cloudNodes}`]: create.reply })
    const card = await cloudCard()
    fireEvent.click(
      await within(card).findByRole('button', {
        name: 'Create a node on DigitalOcean',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Create a node on DigitalOcean',
    })
    within(sheet).getByText(/stays a worker until you remove it/)
    await within(sheet).findByRole('combobox', { name: 'Region' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create node' }))
    assert.equal(
      (
        await within(sheet).findAllByText(
          'Lowercase letters, digits and dashes, up to 40.',
        )
      ).length,
      2,
    )
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'linux-2' },
    })
    fireEvent.change(within(sheet).getByLabelText('Node type'), {
      target: { value: 'linux-x64' },
    })
    fireEvent.change(within(sheet).getByLabelText(/^Labels/), {
      target: { value: 'android' },
    })
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Size' }), {
      target: { value: 's-2vcpu-4gb' },
    })
    const button = within(sheet).getByRole('button', { name: 'Create node' })
    fireEvent.click(button)
    await until(() => isBusy(button), 'the busy button')
    assert.deepEqual(create.body(), {
      account: 'do-main',
      name: 'linux-2',
      type: 'linux-x64',
      labels: ['android'],
      region: 'sfo3',
      size: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
    })
    const before = reads(app, PATHS.cloudNodes)
    create.answer(201, cloudNode({ name: 'linux-2' }))
    await screen.findByText('Making the node linux-2')
    await until(() => reads(app, PATHS.cloudNodes) > before, 'read again')
    await until(() => screen.queryByRole('dialog') == null, 'closed')
  })

  it('keeps a refusal in the create sheet and asks before discarding', async () => {
    openNodes({
      [`POST ${PATHS.cloudNodes}`]: {
        status: 400,
        body: { error: 'The name is taken' },
      },
    })
    fireEvent.click(
      await within(await cloudCard()).findByRole('button', {
        name: 'Create a node on DigitalOcean',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Create a node on DigitalOcean',
    })
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'android-builder' },
    })
    fireEvent.change(within(sheet).getByLabelText('Node type'), {
      target: { value: 'linux-x64' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create node' }))
    await within(sheet).findByText('The name is taken')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    await discard()
  })

  it('loads, fails with Retry, says none yet, and hides when none may be made', async () => {
    openNodes({ [PATHS.cloudNodes]: pending })
    await within(await cloudCard()).findByLabelText('Loading the cloud nodes')
    cleanup()
    const app = openNodes({
      [PATHS.cloudNodes]: { status: 500, body: { error: 'Down' } },
    })
    const card = await cloudCard()
    await within(card).findByText(/The cloud nodes could not be read: Down/)
    app.node.set(PATHS.cloudNodes, [])
    fireEvent.click(within(card).getByRole('button', { name: 'Retry' }))
    await within(card).findByText('None yet.')
    cleanup()
    openNodes({ [PATHS.cloudNodes]: [], [PATHS.accounts]: [nomacAccount()] })
    await screen.findByRole('article', { name: 'bern' })
    await until(
      () => screen.queryByRole('region', { name: 'Cloud nodes' }) == null,
      'no card',
    )
  })

  it('is read-only without settings.change', async () => {
    openNodesWithout(['settings.change'])
    const card = await cloudCard()
    await within(card).findByText('android-builder')
    assert.equal(within(card).queryAllByRole('button').length, 0)
    const pools = await poolsCard()
    await within(pools).findByText('linux-cloud')
    assert.equal(within(pools).queryAllByRole('button').length, 0)
    assert.equal(
      screen.queryByRole('button', {
        name: 'Store builds in a new DigitalOcean Space',
      }),
      null,
    )
    assert.equal(screen.queryByRole('region', { name: 'Storage' }), null)
    cleanup()
    openNodesWithout(['settings.change', 'nodes.change'], {
      [PATHS.cloudNodes]: [],
    })
    await screen.findByRole('article', { name: 'bern' })
    assert.equal(screen.queryByRole('button', { name: 'Pair a node' }), null)
    assert.equal(screen.queryByRole('button', { name: 'Edit bern' }), null)
    await until(
      () => screen.queryByRole('region', { name: 'Cloud nodes' }) == null,
      'no card',
    )
  })
})

describe('Cloud pools', () => {
  it('lists each pool, its capacity and machines, and the budget', async () => {
    openNodes()
    const card = await poolsCard()
    await within(card).findByText('linux-cloud')
    within(card).getByText('Budget $200 / month')
    within(card).getByText(/Monthly budget: \$200\./)
    const linux = row(card, 'linux-cloud')
    within(linux).getByText(
      'linux-x86 · DigitalOcean · sfo3 · s-2vcpu-4gb · setup',
    )
    within(linux).getByText(
      '1 of at most 3 machines · 1 stage at a time · retire after 60 idle minutes or 24 hours',
    )
    const machines = within(linux).getByRole('list', {
      name: 'linux-cloud’s machines',
    })
    assert.equal(text(machines.querySelector('li')), '48213Ready164.92.1.18')
    const mac = row(card, 'macos-cloud')
    within(mac).getByText('macos-arm64 · NoMac · setup')
    within(mac).getByText(
      '1 of at most 1 machine · 1 stage at a time · retire after 60 idle minutes or 8 hours',
    )
    within(mac).getByText('Pairing', { selector: '.m-status' })
    within(card).getByRole('button', { name: 'Add a pool on DigitalOcean' })
    within(card).getByRole('button', { name: 'Add a pool on NoMac' })
    assert.equal(
      poolSummary(pool({ labels: [], provider: 'nomac' }), undefined),
      'linux-x86 · do-main',
    )
  })

  it('shows the budget notice, and a pool whose account is gone', async () => {
    openNodes({
      [PATHS.budget]: {
        monthly: 200,
        notice: 'Cloud spend this month is $172.40 of the $200 budget.',
      },
      [PATHS.pools]: [pool({ account: 'gone', machines: [] })],
    })
    const card = await poolsCard()
    await within(card).findByText(
      'Cloud spend this month is $172.40 of the $200 budget.',
    )
    const gone = row(card, 'linux-cloud')
    within(gone).getByText('linux-x86 · gone · sfo3 · s-2vcpu-4gb · setup')
    const edit = within(gone).getByRole('button', {
      name: 'Edit linux-cloud',
    }) as HTMLButtonElement
    assert.equal(edit.disabled, true)
    assert.equal(edit.title, 'Its cloud account is gone')
    fireEvent.click(
      within(card).getByRole('button', { name: 'Add a pool on DigitalOcean' }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Add a pool on DigitalOcean',
    })
    within(sheet).getByText(
      'Cloud spend this month is $172.40 of the $200 budget.',
    )
  })

  it('adds a DigitalOcean pool from the large sheet', async () => {
    const add = held()
    const app = openNodes({ [`POST ${PATHS.pools}`]: add.reply })
    const card = await poolsCard()
    fireEvent.click(
      await within(card).findByRole('button', {
        name: 'Add a pool on DigitalOcean',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Add a pool on DigitalOcean',
    })
    within(sheet).getByText('Monthly budget across all pools: $200.')
    assert.deepEqual([...sheet.querySelectorAll('legend')].map(text), [
      'Machine',
      'Capacity and retirement',
    ])
    await within(sheet).findByRole('combobox', { name: 'Base image' })
    assert.equal(
      (
        within(sheet).getByRole('combobox', {
          name: 'Size',
        }) as HTMLSelectElement
      ).value,
      's-2vcpu-4gb',
    )
    fireEvent.change(
      within(sheet).getByLabelText('Retire after idle minutes'),
      {
        target: { value: '0' },
      },
    )
    fireEvent.change(within(sheet).getByLabelText('Retire after hours up'), {
      target: { value: '721' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add pool' }))
    assert.equal(
      (
        await within(sheet).findAllByText(
          'Lowercase letters, digits and dashes, up to 40.',
        )
      ).length,
      2,
    )
    within(sheet).getByText('A whole number from 1 to 1440.')
    within(sheet).getByText('A whole number from 1 to 720.')
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'linux-big' },
    })
    fireEvent.change(within(sheet).getByLabelText('Node type'), {
      target: { value: 'linux-x86' },
    })
    fireEvent.change(within(sheet).getByLabelText(/^Labels/), {
      target: { value: 'setup, big' },
    })
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'More machines' }),
    )
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'More machines' }),
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'More stages' }))
    fireEvent.change(
      within(sheet).getByLabelText('Retire after idle minutes'),
      {
        target: { value: '30' },
      },
    )
    fireEvent.change(within(sheet).getByLabelText('Retire after hours up'), {
      target: { value: '48' },
    })
    assert.ok(
      window.sessionStorage.getItem('mason-draft:pool:do-main:') != null,
      'a draft is kept',
    )
    const button = within(sheet).getByRole('button', { name: 'Add pool' })
    fireEvent.click(button)
    await until(() => isBusy(button), 'the busy button')
    assert.deepEqual(add.body(), {
      account: 'do-main',
      name: 'linux-big',
      type: 'linux-x86',
      region: 'sfo3',
      size: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      labels: ['setup', 'big'],
      maxNodes: 3,
      slots: 2,
      ttlMinutes: 30,
      maxHoursPerNode: 48,
    })
    const before = reads(app, PATHS.pools)
    add.answer(201, pool({ name: 'linux-big' }))
    await screen.findByText('linux-big added')
    await until(() => reads(app, PATHS.pools) > before, 'read again')
    await until(() => screen.queryByRole('dialog') == null, 'closed')
    assert.equal(
      window.sessionStorage.getItem('mason-draft:pool:do-main:'),
      null,
      'the draft is forgotten',
    )
  })

  it('adds a NoMac pool: up to two Macs for up to eight hours, no region, size or image', async () => {
    const add = held()
    openNodes({ [`POST ${PATHS.pools}`]: add.reply })
    fireEvent.click(
      await within(await poolsCard()).findByRole('button', {
        name: 'Add a pool on NoMac',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Add a pool on NoMac',
    })
    within(sheet).getByText(
      'NoMac runs an Apple silicon Mac with Xcode for up to eight hours, and two at once when the account has bought credit and NoMac has a Mac to spare.',
    )
    assert.equal(within(sheet).queryByLabelText('Region'), null)
    assert.equal(within(sheet).queryByLabelText('Size'), null)
    assert.equal(within(sheet).queryByLabelText('Base image'), null)
    assert.equal(
      (within(sheet).getByLabelText('Name') as HTMLInputElement).value,
      'macos-cloud',
    )
    assert.equal(
      (within(sheet).getByLabelText('Node type') as HTMLInputElement).value,
      'macos-arm64',
    )
    const max = within(sheet).getByLabelText('Max machines') as HTMLInputElement
    assert.equal(max.value, '1')
    const more = within(sheet).getByRole('button', { name: 'More machines' })
    fireEvent.click(more)
    assert.equal(max.value, '2')
    // Two at most: NoMac runs the second beside the first, and no third.
    assert.equal((more as HTMLButtonElement).disabled, true)
    const hours = within(sheet).getByLabelText(
      'Retire after hours up',
    ) as HTMLInputElement
    assert.equal(hours.value, '8')
    fireEvent.change(hours, { target: { value: '9' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add pool' }))
    await within(sheet).findByText('A whole number from 1 to 8.')
    fireEvent.change(hours, { target: { value: '6' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add pool' }))
    await until(() => add.body() != null, 'the request')
    assert.deepEqual(add.body(), {
      account: 'nomac',
      name: 'macos-cloud',
      type: 'macos-arm64',
      labels: ['setup'],
      maxNodes: 2,
      slots: 1,
      ttlMinutes: 60,
      maxHoursPerNode: 6,
    })
    add.answer(409, { error: 'A pool named macos-cloud already exists' })
    await within(sheet).findByText('A pool named macos-cloud already exists')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    await discard()
  })

  it('edits a pool, which keeps its name', async () => {
    const save = held()
    const app = openNodes({ [`PUT ${PATHS.pools}/linux-cloud`]: save.reply })
    const card = await poolsCard()
    fireEvent.click(
      await within(card).findByRole('button', { name: 'Edit linux-cloud' }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Edit linux-cloud',
    })
    assert.equal(within(sheet).queryByLabelText('Name'), null)
    assert.equal(
      (within(sheet).getByLabelText('Max machines') as HTMLInputElement).value,
      '3',
    )
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Fewer machines' }),
    )
    const button = within(sheet).getByRole('button', { name: 'Save' })
    fireEvent.click(button)
    await until(() => isBusy(button), 'the busy button')
    assert.deepEqual(save.body(), {
      account: 'do-main',
      name: 'linux-cloud',
      type: 'linux-x86',
      region: 'sfo3',
      size: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      labels: ['setup'],
      maxNodes: 2,
      slots: 1,
      ttlMinutes: 60,
      maxHoursPerNode: 24,
    })
    const before = reads(app, PATHS.pools)
    save.answer(200, pool({ maxNodes: 2 }))
    await screen.findByText('linux-cloud saved')
    await until(() => reads(app, PATHS.pools) > before, 'read again')
  })

  it('removes a pool after a tier-2 confirm, and keeps a refusal inline', async () => {
    const remove = held()
    const app = openNodes({
      [`DELETE ${PATHS.pools}/linux-cloud`]: remove.reply,
    })
    const card = await poolsCard()
    fireEvent.click(
      await within(card).findByRole('button', { name: 'Remove linux-cloud' }),
    )
    const alert = await screen.findByRole('alertdialog', {
      name: 'Remove the pool linux-cloud?',
    })
    within(alert).getByText(
      'Its 1 machine retire: each finishes its current stage and is destroyed. Stages that ask for linux-x86 wait for another node.',
    )
    assert.equal(within(alert).queryByRole('textbox'), null, 'no typing')
    const confirm = within(alert).getByRole('button', { name: 'Remove' })
    assert.ok(confirm.className.includes('m-btn--danger-filled'))
    fireEvent.click(confirm)
    await until(
      () => app.node.requests.includes(`DELETE ${PATHS.pools}/linux-cloud`),
      'the request',
    )
    const before = reads(app, PATHS.pools)
    remove.answer(200, null)
    await screen.findByText('linux-cloud removed')
    await until(() => reads(app, PATHS.pools) > before, 'read again')
    cleanup()
    openNodes({
      [`DELETE ${PATHS.pools}/linux-cloud`]: {
        status: 404,
        body: { error: 'No pool named linux-cloud' },
      },
    })
    const again = await poolsCard()
    fireEvent.click(
      await within(again).findByRole('button', { name: 'Remove linux-cloud' }),
    )
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Remove',
      }),
    )
    await within(again).findByText('No pool named linux-cloud')
    fireEvent.click(
      within(again).getByRole('button', { name: 'Remove linux-cloud' }),
    )
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cancel',
      }),
    )
    await until(() => screen.queryByRole('alertdialog') == null, 'cancelled')
  })

  it('says none yet, says to add an account, loads and fails with Retry', async () => {
    openNodes({ [PATHS.pools]: [], [PATHS.accounts]: [] })
    const card = await poolsCard()
    await within(card).findByText('None yet.')
    await within(card).findByText(/to make pools\./)
    assert.equal(
      within(card).getByRole('link', { name: 'Cloud' }).getAttribute('href'),
      '/cloud',
    )
    cleanup()
    openNodes({ [PATHS.pools]: pending })
    await within(await poolsCard()).findByLabelText('Loading the pools')
    cleanup()
    const app = openNodes({
      [PATHS.pools]: { status: 500, body: { error: 'Down' } },
      [PATHS.budget]: { status: 500, body: { error: 'No budget' } },
      [PATHS.accounts]: { status: 500, body: { error: 'No accounts' } },
    })
    const failed = await poolsCard()
    await within(failed).findByText(/The pools could not be read: Down/)
    await within(failed).findByText(/The budget could not be read: No budget/)
    await within(failed).findByText(
      /The cloud accounts could not be read: No accounts/,
    )
    app.node.set(PATHS.pools, [pool()])
    app.node.set(PATHS.budget, { monthly: 300 })
    app.node.set(PATHS.accounts, [doAccount()])
    for (const retry of within(failed).getAllByRole('button', {
      name: 'Retry',
    }))
      fireEvent.click(retry)
    await within(failed).findByText('linux-cloud')
    await within(failed).findByText('Budget $300 / month')
    await within(failed).findByRole('button', {
      name: 'Add a pool on DigitalOcean',
    })
  })

  it('keeps a stored pool value the catalog no longer lists', async () => {
    openNodes({ [PATHS.pools]: [pool({ size: 's-old' }), macPool()] })
    fireEvent.click(
      await within(await poolsCard()).findByRole('button', {
        name: 'Edit linux-cloud',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Edit linux-cloud',
    })
    const size = (await within(sheet).findByRole('combobox', {
      name: 'Size',
    })) as HTMLSelectElement
    assert.equal(size.value, 's-old')
    assert.equal(size.options[0]!.text, 's-old')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    await until(() => screen.queryByRole('dialog') == null, 'closed')
  })
})
