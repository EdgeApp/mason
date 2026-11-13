import assert from 'node:assert/strict'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { nodeInfo, until } from '../../../test/render.js'
import { text } from '../../../test/projects.js'
import {
  cloudHost,
  doAccount,
  held,
  hostNode,
  isBusy,
  nomacAccount,
  openNodes,
  PATHS,
  pending,
  workerNode,
} from '../../../test/nodes.js'

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
})

/** The Host card. */
const hostCard = async (): Promise<HTMLElement> =>
  await screen.findByRole('region', { name: 'Host' })

const reads = (app: ReturnType<typeof openNodes>, path: string): number =>
  app.node.requests.filter((r) => r === `GET ${path}`).length

/** No host: no cloud host, no origin, no host node. */
const noHost = {
  [PATHS.hosts]: [],
  [PATHS.host]: {},
}

describe('The host', () => {
  it('shows a ready cloud host: where it is, what it serves, its certificate and Space', async () => {
    openNodes()
    const card = await hostCard()
    await within(card).findByText('builds')
    within(card).getByText('Ready', { selector: '.m-status' })
    within(card).getByText(
      'sfo3 · s-1vcpu-1gb · 203.0.113.5 · builds.example.com · Mason 0.6.0',
    )
    assert.equal(
      within(card)
        .getByRole('link', { name: 'https://builds.example.com' })
        .getAttribute('href'),
      'https://builds.example.com',
    )
    within(card).getByText('Certificate trusted')
    assert.equal(
      text(within(card).getByText(/Builds Space/)),
      'Builds Space mason-builds (sfo3)',
    )
    within(card).getByRole('button', { name: 'Reconcile' })
    within(card).getByRole('button', { name: 'Remove host' })
    assert.equal(
      within(card).queryByRole('button', {
        name: 'Store builds in a new DigitalOcean Space',
      }),
      null,
      'it has a Space',
    )
    // Where it stores builds, inside the host card.
    within(card).getByRole('region', { name: 'Storage' })
  })

  it('shows a manager an updating host waiting for its certificate, its error and the Space form, without Reconcile or Remove', async () => {
    openNodes(
      {
        [PATHS.hosts]: [
          cloudHost({
            state: 'updating',
            version: '0.6.1',
            certificate: 'waiting',
            dns_name: '@',
            space_bucket: undefined,
            space_region: undefined,
            origin: undefined,
            error: 'The droplet did not answer within 10 minutes.',
          }),
        ],
      },
      'manager',
    )
    const card = await hostCard()
    await within(card).findByText('Updating', { selector: '.m-status' })
    within(card).getByText('sfo3 · s-1vcpu-1gb · 203.0.113.5 · example.com')
    within(card).getByText(
      'Updating to Mason 0.6.1, as the master asked over its link; it reconnects on its own.',
    )
    within(card).getByText('Waiting for its certificate')
    within(card).getByText(
      'Caddy asks Let’s Encrypt once example.com resolves.',
    )
    within(card).getByText('The droplet did not answer within 10 minutes.')
    assert.equal(within(card).queryByText(/Serves/), null)
    assert.equal(
      within(card).queryByRole('button', { name: 'Reconcile' }),
      null,
    )
    assert.equal(
      within(card).queryByRole('button', { name: 'Remove host' }),
      null,
    )
    within(card).getByRole('button', {
      name: 'Store builds in a new DigitalOcean Space',
    })
    within(card).getByRole('region', { name: 'Storage' })
  })

  it('gives a manager’s host a Space made at its next check', async () => {
    const key = `POST ${PATHS.hosts}/builds/space`
    const space = held()
    const app = openNodes(
      {
        [PATHS.hosts]: [
          cloudHost({
            region: 'tor1',
            space_bucket: undefined,
            space_region: undefined,
            certificate: 'internal',
            dns_domain: undefined,
            dns_name: undefined,
          }),
        ],
        [key]: space.reply,
      },
      'manager',
    )
    const card = await hostCard()
    fireEvent.click(
      await within(card).findByRole('button', {
        name: 'Store builds in a new DigitalOcean Space',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Store builds in a new DigitalOcean Space',
    })
    within(sheet).getByText(/Yours is made at the host’s next check/)
    const bucket = within(sheet).getByLabelText(
      'Space name',
    ) as HTMLInputElement
    assert.equal(bucket.value, 'mason-builds')
    assert.equal(
      (within(sheet).getByLabelText('Space region') as HTMLSelectElement).value,
      'tor1',
    )
    fireEvent.change(bucket, { target: { value: 'X' } })
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Make the Space' }),
    )
    await within(sheet).findByText(
      '3 to 63 lowercase letters, digits and dashes.',
    )
    fireEvent.change(bucket, { target: { value: 'mason-store' } })
    fireEvent.change(within(sheet).getByLabelText('Space region'), {
      target: { value: 'ams3' },
    })
    const button = within(sheet).getByRole('button', { name: 'Make the Space' })
    fireEvent.click(button)
    await until(() => isBusy(button), 'the busy button')
    assert.deepEqual(space.body(), { bucket: 'mason-store', region: 'ams3' })
    const before = reads(app, PATHS.hosts)
    space.answer(
      200,
      cloudHost({ space_bucket: 'mason-store', space_pending: 1 }),
    )
    await screen.findByText(
      'The Space mason-store is made at the host’s next check',
    )
    await until(() => reads(app, PATHS.hosts) > before, 'the host read again')
  })

  it('makes an administrator’s Space at once, and keeps a refusal in the sheet', async () => {
    const key = `POST ${PATHS.hosts}/builds/space`
    const space = held()
    openNodes({
      [PATHS.hosts]: [
        cloudHost({
          region: 'xyz9',
          space_bucket: undefined,
          space_region: undefined,
        }),
      ],
      [key]: space.reply,
    })
    const card = await hostCard()
    fireEvent.click(
      await within(card).findByRole('button', {
        name: 'Store builds in a new DigitalOcean Space',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Store builds in a new DigitalOcean Space',
    })
    assert.equal(within(sheet).queryByText(/Yours is made/), null)
    assert.equal(
      (within(sheet).getByLabelText('Space region') as HTMLSelectElement).value,
      'sfo3',
    )
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Make the Space' }),
    )
    await until(() => space.body() != null, 'the request')
    space.answer(400, { error: 'The bucket name is taken' })
    await within(sheet).findByText('The bucket name is taken')
    fireEvent.change(within(sheet).getByLabelText('Space name'), {
      target: { value: 'mason-other' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    await screen.findByRole('alertdialog', { name: 'Discard your changes?' })
    cleanup()
    const again = held()
    openNodes({
      [PATHS.hosts]: [
        cloudHost({ space_bucket: undefined, space_region: undefined }),
      ],
      [key]: again.reply,
    })
    fireEvent.click(
      await within(await hostCard()).findByRole('button', {
        name: 'Store builds in a new DigitalOcean Space',
      }),
    )
    const second = await screen.findByRole('dialog', {
      name: 'Store builds in a new DigitalOcean Space',
    })
    fireEvent.click(
      within(second).getByRole('button', { name: 'Make the Space' }),
    )
    await until(() => again.body() != null, 'the request')
    again.answer(200, cloudHost({ space_bucket: 'mason-builds' }))
    await screen.findByText('builds stores new builds in mason-builds')
    await until(() => screen.queryByRole('dialog') == null, 'the sheet closed')
  })

  it('says when a Space waits to be made', async () => {
    openNodes({ [PATHS.hosts]: [cloudHost({ space_pending: 1 })] })
    const card = await hostCard()
    await within(card).findByText(/waiting to be made/)
  })

  it('reconciles the host, busy until it answers, and keeps a refusal inline', async () => {
    const reconcile = held()
    const app = openNodes({
      [`POST ${PATHS.hosts}/builds/reconcile`]: reconcile.reply,
    })
    const card = await hostCard()
    const button = await within(card).findByRole('button', {
      name: 'Reconcile',
    })
    fireEvent.click(button)
    await until(() => isBusy(button), 'the busy button')
    const before = reads(app, PATHS.hosts)
    reconcile.answer(200, cloudHost())
    await screen.findByText('builds checked again')
    await until(() => reads(app, PATHS.hosts) > before, 'the host read again')
    cleanup()
    openNodes({
      [`POST ${PATHS.hosts}/builds/reconcile`]: {
        status: 409,
        body: { error: 'An administrator must replace the key' },
      },
    })
    fireEvent.click(
      await within(await hostCard()).findByRole('button', {
        name: 'Reconcile',
      }),
    )
    await screen.findByText('An administrator must replace the key')
  })

  it('removes the host only once its name is typed, sending the Space choice (tier 3)', async () => {
    const remove = held()
    const app = openNodes({ [`DELETE ${PATHS.hosts}/builds`]: remove.reply })
    const card = await hostCard()
    fireEvent.click(
      await within(card).findByRole('button', { name: 'Remove host' }),
    )
    const alert = await screen.findByRole('alertdialog', {
      name: 'Remove the host builds?',
    })
    within(alert).getByText(
      'Its droplet is destroyed and it is unpaired. Testers cannot install until a new host exists.',
    )
    const confirm = within(alert).getByRole('button', { name: 'Remove host' })
    assert.equal((confirm as HTMLButtonElement).disabled, true)
    const keep = within(alert).getByRole('radio', {
      name: 'Keep the Space and its builds as a storage location',
    }) as HTMLInputElement
    assert.equal(keep.checked, true)
    fireEvent.click(
      within(alert).getByRole('radio', {
        name: 'Also delete the Space and every build in it',
      }),
    )
    const field = within(alert).getByLabelText(
      /to destroy its droplet and unpair it/,
    )
    fireEvent.change(field, { target: { value: 'build' } })
    assert.equal((confirm as HTMLButtonElement).disabled, true)
    fireEvent.change(field, { target: { value: 'builds' } })
    assert.equal((confirm as HTMLButtonElement).disabled, false)
    fireEvent.click(confirm)
    await until(() => remove.body() != null, 'the request')
    assert.deepEqual(remove.body(), { confirm: 'builds', deleteSpace: true })
    await until(() => isBusy(confirm), 'the busy button')
    const before = reads(app, PATHS.hosts)
    app.node.set(PATHS.hosts, [])
    app.node.set(PATHS.host, {})
    remove.answer(200, null)
    await screen.findByText('builds removed')
    await until(() => reads(app, PATHS.hosts) > before, 'the host read again')
    await within(card).findByText('No host yet')
  })

  it('backs out of removal, keeps the Space by default, and shows a refusal', async () => {
    const remove = held()
    openNodes({
      [PATHS.hosts]: [
        cloudHost({ space_bucket: undefined, space_region: undefined }),
      ],
      [`DELETE ${PATHS.hosts}/builds`]: remove.reply,
    })
    const card = await hostCard()
    fireEvent.click(
      await within(card).findByRole('button', { name: 'Remove host' }),
    )
    let alert = await screen.findByRole('alertdialog')
    assert.equal(within(alert).queryByRole('radio'), null, 'no Space to keep')
    fireEvent.change(within(alert).getByLabelText(/to destroy its droplet/), {
      target: { value: 'builds' },
    })
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }))
    await until(() => screen.queryByRole('alertdialog') == null, 'closed')
    fireEvent.click(within(card).getByRole('button', { name: 'Remove host' }))
    alert = await screen.findByRole('alertdialog')
    const field = within(alert).getByLabelText(
      /to destroy its droplet/,
    ) as HTMLInputElement
    assert.equal(field.value, '', 'typed again from nothing')
    fireEvent.change(field, { target: { value: 'builds' } })
    fireEvent.click(within(alert).getByRole('button', { name: 'Remove host' }))
    await until(() => remove.body() != null, 'the request')
    assert.deepEqual(remove.body(), { confirm: 'builds', deleteSpace: false })
    remove.answer(400, { error: 'DigitalOcean refused the request' })
    await within(card).findByText('DigitalOcean refused the request')
    await until(() => screen.queryByRole('alertdialog') == null, 'closed')
  })

  it('loads, and fails with Retry', async () => {
    const app = openNodes({ [PATHS.hosts]: pending })
    const card = await hostCard()
    await within(card).findByLabelText('Loading the host')
    cleanup()
    const failing = openNodes({
      [PATHS.host]: { status: 500, body: { error: 'Settings are locked' } },
    })
    const again = await hostCard()
    await within(again).findByText(
      /The host could not be read: Settings are locked/,
    )
    failing.node.set(PATHS.host, {})
    fireEvent.click(within(again).getByRole('button', { name: 'Retry' }))
    await within(again).findByText('builds')
    void app
  })

  it('shows a host installed and paired by hand', async () => {
    openNodes({
      [PATHS.hosts]: [],
      [PATHS.nodes]: [workerNode(), hostNode({ status: 'idle' })],
    })
    const card = await hostCard()
    await within(card).findByText('Installed and paired by hand.')
    within(card).getByText('Idle', { selector: '.m-status' })
    within(card).getByRole('link', { name: 'https://builds.example.com' })
    cleanup()
    openNodes({
      [PATHS.hosts]: [],
      [PATHS.nodes]: [hostNode()],
      [PATHS.host]: {},
    })
    const only = await hostCard()
    await within(only).findByText('Installed and paired by hand.')
    assert.equal(within(only).queryByText(/Serves/), null)
  })
})

describe('No host yet', () => {
  it('tells a manager only an administrator adds the host', async () => {
    openNodes(noHost, 'manager')
    const card = await hostCard()
    await within(card).findByText(
      'Only an administrator adds or removes the host.',
    )
    within(card).getByText('No host yet')
    within(card).getByText(/A Mason host holds the builds/)
    assert.equal(
      within(card).queryByRole('button', { name: /Create a host/ }),
      null,
    )
    assert.equal(
      within(card).queryByRole('button', { name: 'Install a host yourself' }),
      null,
    )
    assert.equal(
      within(card).queryByRole('region', { name: 'Storage' }),
      null,
      'no storage without a host',
    )
  })

  it('offers an administrator a host on each DigitalOcean account, or says to add one', async () => {
    openNodes({
      ...noHost,
      [PATHS.accounts]: [
        doAccount(),
        doAccount({ id: 'do-2', name: 'DO staging' }),
        nomacAccount(),
      ],
    })
    const card = await hostCard()
    await within(card).findByRole('button', {
      name: 'Create a host on DigitalOcean',
    })
    within(card).getByRole('button', { name: 'Create a host on DO staging' })
    assert.equal(
      within(card).queryByRole('button', { name: 'Create a host on NoMac' }),
      null,
    )
    within(card).getByRole('button', { name: 'Install a host yourself' })
    cleanup()
    openNodes({ ...noHost, [PATHS.accounts]: [nomacAccount()] })
    const none = await hostCard()
    await within(none).findByText(/to create a host there/)
    assert.equal(
      within(none).getByRole('link', { name: 'Cloud' }).getAttribute('href'),
      '/cloud',
    )
  })

  it('loads the accounts, and fails with Retry', async () => {
    openNodes({ ...noHost, [PATHS.accounts]: pending })
    const card = await hostCard()
    await within(card).findByLabelText('Loading the cloud accounts')
    cleanup()
    const app = openNodes({
      ...noHost,
      [PATHS.accounts]: { status: 500, body: { error: 'Down' } },
    })
    const again = await hostCard()
    await within(again).findByText(/The cloud accounts could not be read: Down/)
    app.node.set(PATHS.accounts, [doAccount()])
    fireEvent.click(within(again).getAllByRole('button', { name: 'Retry' })[0]!)
    await within(again).findByRole('button', {
      name: 'Create a host on DigitalOcean',
    })
  })

  it('creates a host from the catalog with a DNS name and a Space', async () => {
    const create = held()
    const app = openNodes({ ...noHost, [`POST ${PATHS.hosts}`]: create.reply })
    const card = await hostCard()
    fireEvent.click(
      await within(card).findByRole('button', {
        name: 'Create a host on DigitalOcean',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Create a host on DigitalOcean',
    })
    const region = (await within(sheet).findByRole('combobox', {
      name: 'Region',
    })) as HTMLSelectElement
    assert.deepEqual(
      [...region.options].map((option) => option.text),
      ['San Francisco 3 (sfo3)', 'New York 3 (nyc3)'],
    )
    const size = within(sheet).getByRole('combobox', {
      name: 'Size',
    }) as HTMLSelectElement
    assert.equal(size.value, 's-1vcpu-1gb')
    assert.deepEqual(
      [...size.options].map((option) => option.text),
      [
        's-1vcpu-1gb · 1 vCPU · 1 GB · $6/month',
        's-2vcpu-4gb · 2 vCPU · 4 GB · $24/month',
      ],
      'sizes the region offers',
    )
    fireEvent.change(region, { target: { value: 'nyc3' } })
    assert.equal(size.options.length, 3)
    fireEvent.change(size, { target: { value: 's-4vcpu-8gb' } })
    fireEvent.change(within(sheet).getByRole('combobox', { name: 'Image' }), {
      target: { value: 'debian-12-x64' },
    })
    const domain = (await within(sheet).findByRole('combobox', {
      name: 'DNS domain',
    })) as HTMLSelectElement
    await until(() => domain.options.length === 3, 'the domains')
    assert.equal(domain.options[0]!.text, 'No DNS: serve the droplet’s address')
    // Invalid fields say why.
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'Builds!' },
    })
    fireEvent.change(domain, { target: { value: 'example.com' } })
    fireEvent.change(within(sheet).getByLabelText(/^Space name/), {
      target: { value: 'X' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create host' }))
    await within(sheet).findByText(
      'Lowercase letters, digits and dashes, up to 40.',
    )
    within(sheet).getByText('A name in the domain, or @ for the domain itself.')
    within(sheet).getByText('3 to 63 lowercase letters, digits and dashes.')
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'builds' },
    })
    fireEvent.change(within(sheet).getByLabelText(/^Record name/), {
      target: { value: 'builds' },
    })
    fireEvent.change(within(sheet).getByLabelText(/^Space name/), {
      target: { value: 'mason-builds' },
    })
    fireEvent.change(within(sheet).getByLabelText('Space region'), {
      target: { value: 'nyc3' },
    })
    const button = within(sheet).getByRole('button', { name: 'Create host' })
    fireEvent.click(button)
    await until(() => isBusy(button), 'the busy button')
    assert.deepEqual(create.body(), {
      account: 'do-main',
      name: 'builds',
      region: 'nyc3',
      size: 's-4vcpu-8gb',
      image: 'debian-12-x64',
      dns: { domain: 'example.com', name: 'builds' },
      space: { bucket: 'mason-builds', region: 'nyc3' },
    })
    const before = reads(app, PATHS.hosts)
    app.node.set(PATHS.hosts, [cloudHost({ state: 'creating' })])
    create.answer(201, cloudHost({ state: 'creating' }))
    await screen.findByText('Making the host builds')
    await until(() => reads(app, PATHS.hosts) > before, 'the host read again')
    await within(card).findByText('Creating', { selector: '.m-status' })
  })

  it('keeps a draft of the host sheet, sends no DNS or Space when left empty, and keeps a refusal', async () => {
    const create = held()
    openNodes({ ...noHost, [`POST ${PATHS.hosts}`]: create.reply })
    const card = await hostCard()
    const open = async (): Promise<HTMLElement> => {
      fireEvent.click(
        await within(card).findByRole('button', {
          name: 'Create a host on DigitalOcean',
        }),
      )
      return await screen.findByRole('dialog', {
        name: 'Create a host on DigitalOcean',
      })
    }
    let sheet = await open()
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'builds' },
    })
    assert.ok(
      window.sessionStorage.getItem('mason-draft:host:do-main') != null,
      'a draft is kept',
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create host' }))
    await until(() => create.body() != null, 'the request')
    assert.deepEqual(create.body(), {
      account: 'do-main',
      name: 'builds',
      region: 'sfo3',
      size: 's-1vcpu-1gb',
      image: 'ubuntu-24-04-x64',
    })
    create.answer(400, { error: 'The master has no GitHub release' })
    await within(sheet).findByText('The master has no GitHub release')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', {
          name: 'Discard your changes?',
        }),
      ).getByRole('button', { name: 'Discard' }),
    )
    await until(() => screen.queryByRole('dialog') == null, 'closed')
    sheet = await open()
    assert.equal(
      (within(sheet).getByLabelText('Name') as HTMLInputElement).value,
      '',
      'discarded',
    )
  })

  it('shows the not-keyed notice instead of the form, and text fields when the catalog fails', async () => {
    openNodes({
      ...noHost,
      [PATHS.accounts]: [doAccount({ adminKeyed: false })],
    })
    const card = await hostCard()
    fireEvent.click(
      await within(card).findByRole('button', {
        name: 'Create a host on DigitalOcean',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Create a host on DigitalOcean',
    })
    within(sheet).getByText(/An administrator must replace this account’s key/)
    assert.equal(
      within(sheet)
        .getByRole('link', { name: 'Replace key' })
        .getAttribute('href'),
      '/cloud#account-do-main',
    )
    assert.equal(within(sheet).queryByLabelText('Name'), null)
    assert.equal(
      within(sheet).queryByRole('button', { name: 'Create host' }),
      null,
    )
    cleanup()
    const app = openNodes({
      ...noHost,
      [PATHS.catalog]: { status: 502, body: { error: 'DigitalOcean is down' } },
      [PATHS.domains]: { status: 502, body: { error: 'No DNS' } },
    })
    fireEvent.click(
      await within(await hostCard()).findByRole('button', {
        name: 'Create a host on DigitalOcean',
      }),
    )
    const failed = await screen.findByRole('dialog', {
      name: 'Create a host on DigitalOcean',
    })
    await within(failed).findByText(
      'Could not list DigitalOcean’s regions and sizes: DigitalOcean is down',
    )
    await within(failed).findByText('The domains could not be read: No DNS')
    const region = within(failed).getByLabelText('Region') as HTMLInputElement
    assert.equal(region.tagName, 'INPUT')
    assert.equal(region.value, 'sfo3')
    app.node.set(PATHS.catalog, {
      regions: [{ slug: 'sfo3', name: 'San Francisco 3' }],
      sizes: [],
      images: [],
    })
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }))
    await within(failed).findByRole('combobox', { name: 'Region' })
    const size = within(failed).getByRole('combobox', {
      name: 'Size',
    }) as HTMLSelectElement
    assert.deepEqual(
      [...size.options].map((option) => option.value),
      ['s-1vcpu-1gb'],
      'a value the catalog does not list stays selectable',
    )
  })

  it('installs a host by hand: the command, then the address and key', async () => {
    const pair = held()
    const app = openNodes({ ...noHost, [`POST ${PATHS.nodes}`]: pair.reply })
    const card = await hostCard()
    fireEvent.click(
      await within(card).findByRole('button', {
        name: 'Install a host yourself',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Install a host yourself',
    })
    await within(sheet).findByText(
      'curl -fsSL https://github.com/EdgeApp/mason/releases/download/v0.6.0/install.sh | bash -s -- --version 0.6.0 host',
    )
    within(sheet).getByText(/On a computer the internet can reach/)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pair host' }))
    await within(sheet).findByText('Enter the host’s address and port.')
    within(sheet).getByText('Enter the pairing key.')
    fireEvent.change(within(sheet).getByLabelText('Address and port'), {
      target: { value: 'builds.example.com:9310' },
    })
    fireEvent.change(within(sheet).getByLabelText('Pairing key'), {
      target: { value: 'mason1:host' },
    })
    const button = within(sheet).getByRole('button', { name: 'Pair host' })
    fireEvent.click(button)
    await until(() => isBusy(button), 'the busy button')
    assert.deepEqual(pair.body(), {
      address: 'builds.example.com:9310',
      key: 'mason1:host',
    })
    const before = reads(app, PATHS.nodes)
    pair.answer(201, { name: 'builds' })
    await screen.findByText('The host is paired')
    await until(() => reads(app, PATHS.nodes) > before, 'the nodes read again')
    cleanup()
    openNodes({
      ...noHost,
      [PATHS.node]: nodeInfo('master'),
      [`POST ${PATHS.nodes}`]: {
        status: 403,
        body: { error: 'Only an administrator pairs a host' },
      },
    })
    fireEvent.click(
      await within(await hostCard()).findByRole('button', {
        name: 'Install a host yourself',
      }),
    )
    const again = await screen.findByRole('dialog', {
      name: 'Install a host yourself',
    })
    await within(again).findByText(/This master runs no GitHub release/)
    fireEvent.change(within(again).getByLabelText('Address and port'), {
      target: { value: 'a:1' },
    })
    fireEvent.change(within(again).getByLabelText('Pairing key'), {
      target: { value: 'k' },
    })
    fireEvent.click(within(again).getByRole('button', { name: 'Pair host' }))
    await within(again).findByText('Only an administrator pairs a host')
    fireEvent.click(within(again).getByRole('button', { name: 'Close' }))
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', {
          name: 'Discard your changes?',
        }),
      ).getByRole('button', { name: 'Discard' }),
    )
    await until(() => screen.queryByRole('dialog') == null, 'closed')
  })
})
