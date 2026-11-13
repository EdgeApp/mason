import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { draftKey } from '../../../ui/LargeSheet.js'
import { until } from '../../../test/render.js'
import {
  card,
  held,
  linuxType,
  NODE_TYPES,
  nodeType,
  openSettings,
  recorder,
  requested,
  text,
  toasted,
} from '../../../test/settings.js'
import { typeBody, typeDraft, typeErrors, typeSummary } from './nodeTypes.js'

beforeEach(() => window.sessionStorage.clear())
afterEach(() => cleanup())

const type = (
  scope: HTMLElement,
  label: string | RegExp,
  value: string,
): void => {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } })
}

const sheet = async (name: RegExp | string): Promise<HTMLElement> =>
  await screen.findByRole('dialog', { name })

describe('Settings → Node types', () => {
  it('lists each type with what it installs and its Android licence acceptance', async () => {
    openSettings()
    const types = await card(/^Node types/)
    const rows = await within(types).findAllByRole('listitem')
    assert.deepEqual(
      rows.map((row) => row.getAttribute('data-type')),
      ['macos-arm64', 'linux-x64'],
    )
    assert.match(
      text(rows[0]!),
      /macos-arm64Xcode 26\.1, 16\.4 · Node 24 · 3 Homebrew packages · Disk threshold 40 GB/,
    )
    assert.match(
      text(rows[1]!),
      /Java 21 · Rust stable · Python 3\.12 · Go 1\.23 · Ruby 3\.3 · 1 apt package · 2 dnf packages · Docker · 1 Android SDK package · Disk threshold 60 GB/,
    )
    assert.match(
      text(rows[1]!),
      /Android SDK licences accepted by Ada on Oct 1\./,
    )
    assert.equal(text(types.querySelector('.m-count')), '2')
  })

  it('says None yet. without types, and Retry after a failed read', async () => {
    openSettings({ [NODE_TYPES]: {} })
    const types = await card(/^Node types/)
    await within(types).findByText('None yet.')
    cleanup()
    const app = openSettings({
      [NODE_TYPES]: { status: 500, body: { error: 'Down' } },
    })
    const failed = await card(/^Node types/)
    await within(failed).findByText(/The node types could not be read: Down/)
    app.node.set(NODE_TYPES, {})
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }))
    await within(failed).findByText('None yet.')
  })

  it('edits a type in a large sheet with sections, keeps a draft, and saves it busy', async () => {
    const save = held(200, {})
    const app = openSettings({
      'PUT /api/v2/settings/nodeTypes/macos-arm64': save.reply,
    })
    const types = await card(/^Node types/)
    fireEvent.click(
      await within(types).findByRole('button', { name: 'Edit macos-arm64' }),
    )
    const editor = await sheet(/Node type macos-arm64/)
    assert.deepEqual(
      [...editor.querySelectorAll('legend')].map(
        (legend) => legend.textContent,
      ),
      ['Software: Xcode', 'Software: packages', 'Software: runtimes'],
    )
    assert.equal(editor.querySelector('details')!.open, false)
    assert.equal(
      (within(editor).getByLabelText(/^Xcode versions/) as HTMLInputElement)
        .value,
      '26.1, 16.4',
    )
    assert.equal(
      (within(editor).getByLabelText('Keep awake') as HTMLInputElement).checked,
      true,
    )
    type(editor, /^Xcode versions/, '26.1')
    type(editor, /^Python version/, '3.13')
    fireEvent.click(within(editor).getByLabelText('Docker'))
    fireEvent.click(within(editor).getByLabelText('Keep awake'))
    type(editor, /^apt packages/, 'jq, zip')
    const stored = JSON.parse(
      window.sessionStorage.getItem(draftKey('nodeType:macos-arm64'))!,
    ) as Record<string, unknown>
    assert.equal(stored.xcode, '26.1')
    const button = within(editor).getByRole('button', { name: 'Save' })
    fireEvent.click(button)
    await requested(app, 'PUT /api/v2/settings/nodeTypes/macos-arm64')
    assert.equal(button.getAttribute('aria-busy'), 'true')
    await act(async () => save.release())
    await toasted('macos-arm64 saved')
    assert.deepEqual(save.bodies[0], {
      software: {
        xcode: ['26.1'],
        xcodeDefault: '26.1',
        allowBeta: false,
        simulators: ['iOS 26.1'],
        commandLineTools: true,
        rosetta: true,
        brew: { formulae: ['cocoapods', 'fastlane', 'jq'], casks: [] },
        apt: ['jq', 'zip'],
        dnf: [],
        docker: true,
        node: '24',
        python: '3.13',
        android: [],
      },
      settings: {
        noSleep: false,
        devToolsSecurity: true,
        automationMode: true,
      },
      diskThresholdGb: 40,
    })
    await until(() => screen.queryByRole('dialog') == null, 'closed')
    assert.equal(
      window.sessionStorage.getItem(draftKey('nodeType:macos-arm64')),
      null,
    )
  })

  it('checks versions and the disk threshold, opening the settings on its error; a refusal stays', async () => {
    openSettings({
      'PUT /api/v2/settings/nodeTypes/linux-x64': {
        status: 400,
        body: { error: 'xcodeDefault is not listed' },
      },
    })
    const types = await card(/^Node types/)
    fireEvent.click(
      await within(types).findByRole('button', { name: 'Edit linux-x64' }),
    )
    const editor = await sheet(/Node type linux-x64/)
    type(editor, /^Node\.js version/, 'not a version!')
    type(editor, 'Disk threshold (GB)', 'lots')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    within(editor).getByText(
      'Enter a version such as 24 or 3.12, or leave it empty.',
    )
    within(editor).getByText('Enter whole gigabytes, 0 or more.')
    await until(
      () => editor.querySelector('details')!.open,
      'the settings to open',
    )
    type(editor, /^Node\.js version/, '')
    type(editor, 'Disk threshold (GB)', '50')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    await within(editor).findByText('xcodeDefault is not listed')
  })

  it('adds a type with its name, settings open, and refuses a bad name', async () => {
    const save = recorder(() => ({ status: 200, body: {} }))
    openSettings({ 'PUT /api/v2/settings/nodeTypes/windows-x64': save.reply })
    const types = await card(/^Node types/)
    fireEvent.click(
      await within(types).findByRole('button', { name: 'Add a node type' }),
    )
    const editor = await sheet('Add a node type')
    assert.equal(editor.querySelector('details')!.open, true)
    assert.equal(
      within(editor).queryByRole('button', { name: 'Remove type' }),
      null,
    )
    type(editor, 'Name', 'Windows!')
    fireEvent.click(within(editor).getByRole('button', { name: 'Add' }))
    within(editor).getByText(
      'Use 1 to 40 lowercase letters, digits and dashes.',
    )
    type(editor, 'Name', 'windows-x64')
    fireEvent.click(within(editor).getByRole('button', { name: 'Add' }))
    await toasted('windows-x64 added')
    assert.deepEqual(save.bodies[0], {
      software: {
        xcode: [],
        allowBeta: false,
        simulators: [],
        commandLineTools: false,
        rosetta: false,
        brew: { formulae: [], casks: [] },
        apt: [],
        dnf: [],
        docker: false,
        android: [],
      },
      settings: {
        noSleep: false,
        devToolsSecurity: false,
        automationMode: false,
      },
      diskThresholdGb: 40,
      create: true,
    })
  })

  it('removes a type after a tier-2 confirm; a refusal stays in the sheet', async () => {
    const remove = recorder((_body, n) =>
      n === 1
        ? { status: 404, body: { error: 'No node type linux-x64' } }
        : { status: 200, body: {} },
    )
    const app = openSettings({
      'DELETE /api/v2/settings/nodeTypes/linux-x64': remove.reply,
    })
    const types = await card(/^Node types/)
    fireEvent.click(
      await within(types).findByRole('button', { name: 'Edit linux-x64' }),
    )
    const editor = await sheet(/Node type linux-x64/)
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove type' }))
    const alert = await screen.findByRole('alertdialog')
    within(alert).getByText('Remove the node type linux-x64?')
    within(alert).getByText(
      'Nodes of type linux-x64 keep their software; Mason stops managing it.',
    )
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove type' }))
    const confirm = within(await screen.findByRole('alertdialog')).getByRole(
      'button',
      { name: 'Remove' },
    )
    assert.match(confirm.className, /m-btn--danger-filled/)
    fireEvent.click(confirm)
    await within(editor).findByText('No node type linux-x64')
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove type' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Remove',
      }),
    )
    await toasted('linux-x64 removed')
    await until(
      () =>
        app.node.requests.filter((r) => r === `GET ${NODE_TYPES}`).length === 2,
      'the types read again',
    )
  })

  it('turns a type into fields and back', () => {
    const linux = linuxType()
    const draft = typeDraft('linux-x64', linux)
    assert.equal(draft.dnf, 'zip, git')
    assert.deepEqual(typeErrors(draft, false), {})
    const body = typeBody(draft, false) as {
      software: Record<string, unknown>
    }
    assert.equal(body.software.ruby, '3.3')
    assert.equal(typeDraft(undefined, undefined).diskThresholdGb, '40')
    assert.equal(
      typeSummary(nodeType({ diskThresholdGb: 10 })),
      'Xcode 26.1, 16.4 · Node 24 · 3 Homebrew packages · Disk threshold 10 GB',
    )
  })
})
