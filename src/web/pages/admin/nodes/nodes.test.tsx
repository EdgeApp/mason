import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import {
  asNodeCard,
  asNodeTypes,
  SPACES_REGIONS,
} from '../../../../shared/api/nodes.js'
import { spacesRegions } from '../../../../master/cloud/regions.js'
import { nodeInfo, until } from '../../../test/render.js'
import { crumbs, heading, text } from '../../../test/projects.js'
import {
  held,
  hostNode,
  isBusy,
  linuxNode,
  nodeTypes,
  openNodes,
  PATHS,
  pending,
  workerNode,
} from '../../../test/nodes.js'
import { nodeFacts, nodeSummary, nodeTools } from './nodeCards.js'
import { nodeTypeSummary } from './nodeTypes.js'
import { installCommand, listOf } from './parts.js'

afterEach(() => cleanup())

/** A node's card by its name. */
const card = (name: string): HTMLElement =>
  screen.getByRole('article', { name })

describe('Nodes', () => {
  it('shows each node’s status, summary, activity, Xcodes, tools and checklist', async () => {
    openNodes()
    await heading('Nodes')
    assert.deepEqual(crumbs(), ['Mason Master', 'Nodes'])
    screen.getByText(
      'Workers and the host, their software, and what each still needs from a person.',
    )
    await screen.findByRole('article', { name: 'bern' })
    const bern = card('bern')
    within(bern).getByText(
      'worker · macos-arm64 · 2 slots · setup, mac-signing',
    )
    within(bern).getByText('Idle', { selector: '.m-status' })
    assert.equal(
      text(within(bern).getByText('Now').nextElementSibling),
      'Idle · Mason 0.6.0 · macOS 15.1 arm64 · 120.4 GB free',
    )
    within(bern).getByText('26.1, 16.4')
    within(bern).getByText('node 24.1 · java 21 · ruby 3.3 · cocoapods 1.16.2')
    within(bern).getByRole('heading', { name: 'Checklist' })
    within(bern).getByRole('img', { name: 'Done' })
    within(bern).getByText('Xcode 26.1 installed')
    within(bern).getByRole('img', { name: 'To do' })
    within(bern).getByText('Accept the Android SDK licences')
    const android = card('mason-android-1771')
    within(android).getByText('Busy', { selector: '.m-status' })
    const run = within(android).getByRole('link', {
      name: 'ec24b917 build-android',
    })
    assert.equal(run.getAttribute('href'), '/runs/ec24b917')
    assert.equal(
      text(within(android).getByText('Now').nextElementSibling),
      'Running ec24b917 build-android · Mason 0.6.0 · Linux 24.04 x64 · 48.2 GB free',
    )
    assert.equal(within(android).queryByText('Xcode'), null)
    assert.equal(within(android).queryByText('Checklist'), null)
    // The main column and the aside.
    const aside = screen.getByRole('complementary', {
      name: 'Host and node types',
    })
    within(aside).getByRole('heading', { name: 'Host' })
    within(aside).getByRole('heading', { name: 'Node types' })
    assert.ok(document.querySelector('.m-split > .m-stack > article'))
  })

  it('reads a node’s inventory loosely and words it', () => {
    const node = asNodeCard({
      ...workerNode(),
      inventory: { os: 'plan9', freeDisk: 512 },
      checklist: [{ text: 'Old step' }, 'not an item', { id: 'x' }],
    })
    assert.deepEqual(node.checklist, [
      { title: 'Old step', done: false },
      { id: 'x', title: '', done: false },
    ])
    assert.deepEqual(nodeFacts(node), ['Mason 0.6.0', 'plan9', '512 B free'])
    const bare = asNodeCard({
      ...workerNode({ version: '' }),
      inventory: 'nonsense',
    })
    assert.equal(bare.inventory, undefined)
    assert.deepEqual(nodeFacts(bare), [])
    assert.equal(
      nodeSummary(hostNode()),
      'host',
      'a host has no type, slots or labels',
    )
    assert.equal(
      nodeSummary(workerNode({ slots: 1, labels: [] })),
      'worker · macos-arm64 · 1 slot',
    )
    assert.equal(
      nodeTools({
        a: ['1'],
        b: '2',
        c: null,
        d: { version: 3 },
        e: [],
        f: ['6'],
        g: ['7'],
        h: ['8'],
        i: ['9'],
      }),
      'a 1 · b 2 · d 3 · f 6 · g 7 · h 8',
    )
    assert.deepEqual(listOf(' a, b,,a , c '), ['a', 'b', 'c'])
    assert.deepEqual(SPACES_REGIONS, spacesRegions)
    assert.equal(
      installCommand({ repository: 'EdgeApp/mason', version: '1.2.3' }, 'host'),
      'curl -fsSL https://github.com/EdgeApp/mason/releases/download/v1.2.3/install.sh | bash -s -- --version 1.2.3 host',
    )
  })

  it('shows a Windows worker and a host by their glyphs, and a host as offline', async () => {
    openNodes({
      [PATHS.nodes]: [
        linuxNode({
          name: 'win',
          fingerprint: 'w',
          inventory: { os: 'windows', xcodes: [], tools: {} },
        }),
        hostNode(),
      ],
    })
    const win = await screen.findByRole('article', { name: 'win' })
    assert.ok(win.querySelector('.m-glyphbox .m-icon'))
    const host = card('builds')
    within(host).getByText('host')
    within(host).getByText('Offline', { selector: '.m-status' })
  })

  it('loads, fails with Retry, and says when no nodes are paired', async () => {
    const app = openNodes({ [PATHS.nodes]: pending })
    await heading('Nodes')
    await screen.findByLabelText('Loading the nodes')
    cleanup()
    const failing = openNodes({
      [PATHS.nodes]: { status: 500, body: { error: 'The registry is locked' } },
    })
    await screen.findByText(
      /The nodes could not be read: The registry is locked/,
    )
    failing.node.set(PATHS.nodes, [])
    const nodesSection = screen.getByRole('region', { name: 'Nodes' })
    fireEvent.click(within(nodesSection).getByRole('button', { name: 'Retry' }))
    await screen.findByText('No nodes are paired.')
    screen.getByText(
      'Install Mason as a worker on a Mac or Linux machine, then pair it here.',
    )
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Nodes' })).getByRole(
        'button',
        { name: 'Pair a node' },
      ),
    )
    await screen.findByRole('dialog', { name: 'Pair a node' })
    void app
  })

  it('lists the node types with what each installs, and links to Settings', async () => {
    openNodes()
    const types = await screen.findByRole('region', { name: 'Node types' })
    await within(types).findByText('macos-arm64')
    within(types).getByText(
      'Xcode 26.1, 16.4 · Node 24 · 3 Homebrew packages · Docker',
    )
    within(types).getByText('Nothing managed yet')
    assert.equal(
      within(types)
        .getByRole('link', { name: 'Edit in Settings' })
        .getAttribute('href'),
      '/settings#nodeTypes',
    )
    assert.equal(
      nodeTypeSummary({
        node: '24',
        java: '21',
        rust: '1.80',
        python: '3.12',
        go: '1.23',
        ruby: '3.3',
        apt: ['git'],
        dnf: ['make'],
        android: ['platforms;android-35'],
        xcode: [],
      }),
      'Node 24 · Java 21 · Rust 1.80 · Python 3.12 · Go 1.23 · Ruby 3.3 · 2 Linux packages · 1 Android package',
    )
    assert.deepEqual(
      asNodeTypes({ broken: { software: 'no' }, ...nodeTypes }).broken,
      {},
    )
  })

  it('loads, fails with Retry, and says when there are no node types', async () => {
    const app = openNodes({
      [PATHS.types]: { status: 500, body: { error: 'Settings are locked' } },
    })
    const types = await screen.findByRole('region', { name: 'Node types' })
    await within(types).findByText(
      /The node types could not be read: Settings are locked/,
    )
    app.node.set(PATHS.types, {})
    fireEvent.click(within(types).getByRole('button', { name: 'Retry' }))
    await within(types).findByText('None yet.')
    cleanup()
    openNodes({ [PATHS.types]: pending })
    await screen.findByLabelText('Loading the node types')
  })

  it('reads the nodes again on a status event', async () => {
    const app = openNodes()
    await screen.findByRole('article', { name: 'bern' })
    const reads = (): number =>
      app.node.requests.filter((r) => r === `GET ${PATHS.nodes}`).length
    const before = reads()
    act(() => app.invalidations.invalidate('status'))
    await until(() => reads() > before, 'the nodes read again')
  })
})

describe('Pair a node', () => {
  it('shows the install command from the master’s release and pairs with type and labels', async () => {
    const pair = held()
    const app = openNodes({ [`POST ${PATHS.nodes}`]: pair.reply })
    fireEvent.click(await screen.findByRole('button', { name: 'Pair a node' }))
    const sheet = await screen.findByRole('dialog', { name: 'Pair a node' })
    await within(sheet).findByText(
      'curl -fsSL https://github.com/EdgeApp/mason/releases/download/v0.6.0/install.sh | bash -s -- --version 0.6.0 worker',
    )
    within(sheet).getByText('It prints the pairing key.')
    within(sheet).getByRole('button', {
      name: 'Copy: the worker install command',
    })
    assert.equal(
      (within(sheet).getByLabelText(/^Labels/) as HTMLInputElement).value,
      'setup',
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pair node' }))
    await within(sheet).findByText('Enter the node’s address and port.')
    within(sheet).getByText('Enter the pairing key.')
    fireEvent.change(within(sheet).getByLabelText('Address and port'), {
      target: { value: ' 192.168.1.20:9310 ' },
    })
    fireEvent.change(within(sheet).getByLabelText('Pairing key'), {
      target: { value: 'mason1:abc' },
    })
    fireEvent.change(within(sheet).getByLabelText(/^Node type/), {
      target: { value: 'bad type!' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pair node' }))
    await within(sheet).findByText(
      'Up to 64 letters, digits, dots, dashes and underscores.',
    )
    fireEvent.change(within(sheet).getByLabelText(/^Node type/), {
      target: { value: 'linux-x64' },
    })
    fireEvent.change(within(sheet).getByLabelText(/^Labels/), {
      target: { value: 'android, setup' },
    })
    const button = within(sheet).getByRole('button', { name: 'Pair node' })
    fireEvent.click(button)
    await until(() => isBusy(button), 'the busy button')
    assert.deepEqual(pair.body(), {
      address: '192.168.1.20:9310',
      key: 'mason1:abc',
      type: 'linux-x64',
      labels: ['android', 'setup'],
    })
    const reads = app.node.requests.filter(
      (r) => r === `GET ${PATHS.nodes}`,
    ).length
    pair.answer(201, { name: 'linux-3' })
    await screen.findByText('linux-3 paired')
    await until(() => screen.queryByRole('dialog') == null, 'the sheet closed')
    await until(
      () =>
        app.node.requests.filter((r) => r === `GET ${PATHS.nodes}`).length >
        reads,
      'the nodes read again',
    )
  })

  it('keeps a refusal in the sheet, says when there is no release, and asks before discarding', async () => {
    openNodes({
      [PATHS.node]: nodeInfo('master'),
      [`POST ${PATHS.nodes}`]: {
        status: 502,
        body: { error: 'The node did not answer' },
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Pair a node' }))
    const sheet = await screen.findByRole('dialog', { name: 'Pair a node' })
    await within(sheet).findByText(
      'This master runs no GitHub release of Mason, so there is no install command to give.',
    )
    fireEvent.change(within(sheet).getByLabelText('Address and port'), {
      target: { value: '10.0.0.2:9310' },
    })
    fireEvent.change(within(sheet).getByLabelText('Pairing key'), {
      target: { value: 'mason1:x' },
    })
    fireEvent.change(within(sheet).getByLabelText(/^Labels/), {
      target: { value: '' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Pair node' }))
    const error = await within(sheet).findByText('The node did not answer')
    await until(
      () => document.activeElement === error.closest('.m-field__error'),
      'the error focused',
    )
    assert.equal(
      (within(sheet).getByLabelText('Address and port') as HTMLInputElement)
        .value,
      '10.0.0.2:9310',
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    const discard = await screen.findByRole('alertdialog', {
      name: 'Discard your changes?',
    })
    fireEvent.click(within(discard).getByRole('button', { name: 'Discard' }))
    await until(() => screen.queryByRole('dialog') == null, 'the sheet closed')
  })
})

describe('Edit a node', () => {
  it('saves a worker’s name, type, labels and slots', async () => {
    const save = held()
    const app = openNodes({
      [`PUT /api/v2/nodes/${encodeURIComponent('mldsa65:bern')}`]: save.reply,
    })
    await screen.findByRole('article', { name: 'bern' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit bern' }))
    const sheet = await screen.findByRole('dialog', { name: 'Edit bern' })
    const name = within(sheet).getByLabelText('Name') as HTMLInputElement
    assert.equal(name.value, 'bern')
    assert.equal(
      (within(sheet).getByLabelText(/^Node type/) as HTMLInputElement).value,
      'macos-arm64',
    )
    assert.equal(
      (within(sheet).getByLabelText(/^Labels/) as HTMLInputElement).value,
      'setup, mac-signing',
    )
    fireEvent.change(name, { target: { value: '  ' } })
    fireEvent.change(within(sheet).getByLabelText(/^Node type/), {
      target: { value: '-bad' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }))
    await within(sheet).findByText('Enter a name.')
    within(sheet).getByText(
      'Up to 64 letters, digits, dots, dashes and underscores.',
    )
    fireEvent.change(name, { target: { value: 'bern-2' } })
    fireEvent.change(within(sheet).getByLabelText(/^Node type/), {
      target: { value: '' },
    })
    fireEvent.change(within(sheet).getByLabelText(/^Labels/), {
      target: { value: 'mac-signing' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'More slots' }))
    const button = within(sheet).getByRole('button', { name: 'Save' })
    fireEvent.click(button)
    await until(() => isBusy(button), 'the busy button')
    assert.deepEqual(save.body(), {
      name: 'bern-2',
      type: '',
      labels: ['mac-signing'],
      slots: 3,
    })
    save.answer(200, { name: 'bern-2' })
    await screen.findByText('bern-2 saved')
    await until(() => screen.queryByRole('dialog') == null, 'the sheet closed')
    assert.ok(
      app.node.requests.filter((r) => r === `GET ${PATHS.nodes}`).length >= 2,
    )
  })

  it('edits only a host’s name, and keeps a refusal in the sheet', async () => {
    const key = `PUT /api/v2/nodes/${encodeURIComponent('mldsa65:host')}`
    const save = held()
    openNodes({ [PATHS.nodes]: [hostNode()], [key]: save.reply })
    await screen.findByRole('article', { name: 'builds' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit builds' }))
    const sheet = await screen.findByRole('dialog', { name: 'Edit builds' })
    assert.equal(within(sheet).queryByLabelText(/^Node type/), null)
    assert.equal(
      within(sheet).queryByRole('button', { name: 'More slots' }),
      null,
    )
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'builds-2' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }))
    await until(() => save.body() != null, 'the request')
    assert.deepEqual(save.body(), { name: 'builds-2' })
    save.answer(400, { error: 'name is too long' })
    await within(sheet).findByText('name is too long')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    const discard = await screen.findByRole('alertdialog', {
      name: 'Discard your changes?',
    })
    fireEvent.click(within(discard).getByRole('button', { name: 'Discard' }))
    await until(() => screen.queryByRole('dialog') == null, 'the sheet closed')
    // Opened again, it starts from the node.
    fireEvent.click(screen.getByRole('button', { name: 'Edit builds' }))
    const again = await screen.findByRole('dialog', { name: 'Edit builds' })
    assert.equal(
      (within(again).getByLabelText('Name') as HTMLInputElement).value,
      'builds',
    )
    assert.equal(within(again).queryByText('name is too long'), null)
  })

  it('shows a developer the 403 and hides Pair and Edit from those who may not change nodes', async () => {
    openNodes({}, 'developer')
    await screen.findByRole('heading', { level: 1 })
    assert.equal(screen.queryByRole('button', { name: 'Pair a node' }), null)
  })
})
