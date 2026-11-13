import assert from 'node:assert/strict'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import type {
  SecretAuditEntry,
  SecretVariant,
} from '../../../shared/api/index.js'
import { MAX_FILE } from '../../../pipeline/variants.js'
import { until } from '../../test/render.js'
import {
  bodyOf,
  heading,
  NOW,
  openProject,
  overviewFixture,
  recording,
  tabs,
  text,
} from '../../test/projects.js'
import {
  editableText,
  fileContents,
  fileRefusal,
  textContents,
  toBase64,
} from './secretFiles.js'
import { secretNotes } from './Secrets.js'

afterEach(() => cleanup())

const OVERVIEW = '/api/v2/projects/fixture/overview'
const SECRETS = '/api/v2/projects/fixture/secrets'
const BACKUPS = `${SECRETS}/backups`
const AUDIT = `${SECRETS}/audit`

const variant = (
  id: number,
  name: string,
  fields: Partial<SecretVariant> = {},
): SecretVariant => ({
  id,
  name,
  kind: 'value',
  configs: [],
  text: true,
  masked: true,
  bytes: 12,
  updatedAt: NOW,
  ...fields,
})

const variants = (): SecretVariant[] => [
  variant(1, 'API_TOKEN'),
  variant(2, 'SENTRY_DSN', { configs: ['release', 'staging'], masked: false }),
  variant(3, 'google-services.json', {
    kind: 'file',
    bytes: 12_300,
    text: true,
  }),
  variant(4, 'distribution.p12', {
    kind: 'file',
    bytes: 3_100,
    text: false,
    configs: ['release'],
  }),
]

const audit: SecretAuditEntry[] = [
  {
    id: 9,
    name: 'SENTRY_DSN',
    configs: ['release'],
    action: 'configs changed',
    who: 'Paul Puey',
    address: '198.51.100.42',
    at: NOW - 60_000,
    detail: 'all → release',
  },
  {
    id: 8,
    name: 'API_TOKEN',
    configs: [],
    action: 'refused',
    who: 'Sam Rivera',
    address: '73.12.4.9',
    at: NOW - 86_400_000,
  },
]

/** The Secrets tab for a role, with backups configured unless said. */
const openSecrets = (
  extra: Record<string, unknown> = {},
  role: 'manager' | 'developer' = 'manager',
  configured = true,
  overview = overviewFixture(),
): ReturnType<typeof openProject> =>
  openProject(
    '/projects/fixture/secrets',
    {
      [OVERVIEW]: overview,
      [SECRETS]: variants(),
      [BACKUPS]: { backupsConfigured: configured },
      [AUDIT]: audit,
      ...extra,
    },
    role,
  )

/** The secrets' own table (the audit has another). */
const secretsTable = async (): Promise<HTMLElement> =>
  within(await screen.findByRole('region', { name: 'Secrets' })).getByRole(
    'table',
  )

const row = (name: string): HTMLElement =>
  screen.getByText(name, { selector: '.m-secrets__title' }).closest('tr')!

const pick = (input: HTMLInputElement, file: File): void => {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  fireEvent.change(input)
}

describe('A project’s Secrets', () => {
  it('lists each variant’s name, notes and build configs to a developer, with no actions or audit', async () => {
    openSecrets({}, 'developer')
    await heading('Fixture')
    assert.equal(tabs('Fixture').current, 'Secrets')
    screen.getByText(
      'Values and files the project’s stages may read, each limited to build configs.',
    )
    const table = await screen.findByRole('table')
    assert.deepEqual(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((tr) => [...tr.querySelectorAll('td')].map(text)),
      [
        ['API_TOKEN', 'all', ''],
        ['SENTRY_DSNNot masked in logs', 'release, staging', ''],
        ['google-services.json12.3 KB · text', 'all', ''],
        ['distribution.p123.1 KB · binary', 'release', ''],
      ],
    )
    assert.equal(within(table).queryAllByRole('button').length, 0)
    assert.equal(screen.queryByRole('button', { name: 'Add value' }), null)
    assert.equal(screen.queryByRole('region', { name: 'Audit' }), null)
    screen.getByText(/ctx\.secret\(name\)/)
  })

  it('gives a manager the add buttons, each row’s actions, and the audit', async () => {
    openSecrets()
    const table = await secretsTable()
    assert.match(
      text(
        screen
          .getByRole('region', { name: /^Secrets/ })
          .querySelector('header'),
      ),
      /Secrets\s*4/,
    )
    screen.getByRole('button', { name: 'Add value' })
    screen.getByRole('button', { name: 'Add file' })
    within(row('API_TOKEN')).getByRole('button', { name: 'Edit API_TOKEN' })
    within(row('distribution.p12')).getByRole('button', {
      name: 'Replace distribution.p12',
    })
    within(row('SENTRY_DSN')).getByRole('button', {
      name: 'Build configs of SENTRY_DSN: release, staging. Change',
    })
    assert.equal(
      within(table).getAllByRole('button', { name: /^Delete / }).length,
      4,
    )
    const audited = await screen.findByRole('region', { name: 'Audit' })
    within(audited).getByText('Values are never recorded')
    const rows = within(audited).getAllByRole('row').slice(1)
    assert.deepEqual([...rows[0]!.querySelectorAll('td')].slice(1).map(text), [
      'Paul Puey',
      'SENTRY_DSNrelease',
      'Configs changedall → release',
      '198.51.100.42',
    ])
    within(rows[1]!).getByText('Refused')
    assert.match(text(rows[1]!.querySelector('td')), /^Yesterday /)
  })

  it('says when there are no secrets and nothing audited', async () => {
    openSecrets({ [SECRETS]: [], [AUDIT]: [] })
    await screen.findByRole('heading', { name: 'No secrets yet.' })
    await screen.findByRole('heading', { name: 'Nothing yet.' })
  })

  it('turns changes off until backups are configured, saying so with the way to Backups', async () => {
    openSecrets({}, 'manager', false)
    await screen.findByText('Configure backups before changing secrets')
    screen.getByText(
      /Until then, adding, editing and deleting secrets is off\./,
    )
    assert.equal(
      screen.getByRole('link', { name: 'Open Backups' }).getAttribute('href'),
      '/backups',
    )
    await secretsTable()
    for (const name of [
      'Add value',
      'Add file',
      'Edit API_TOKEN',
      'Delete API_TOKEN',
    ]) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement
      assert.equal(button.disabled, true, name)
      assert.equal(button.title, 'Configure backups first', name)
    }
    screen.getByText('Configure backups first', { selector: 'span' })
    // A developer is not told: changing is not theirs.
    cleanup()
    openSecrets({}, 'developer', false)
    await screen.findByRole('table')
    assert.equal(
      screen.queryByText('Configure backups before changing secrets'),
      null,
    )
  })

  it('adds a value: its name and configs, shown or hidden, checked first; a refusal stays in the sheet', async () => {
    const app = openSecrets({
      [`POST ${SECRETS}`]: recording(
        `POST ${SECRETS}`,
        201,
        variant(5, 'NEW_TOKEN', { configs: ['beta'] }),
      ),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Add value' }))
    const sheet = await screen.findByRole('dialog', {
      name: 'Add a secret value',
    })
    within(sheet).getByText(
      'Saving pushes a backup first. If the backup fails, nothing changes.',
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save value' }))
    await within(sheet).findByText('Enter a name.')
    within(sheet).getByText('Enter the value.')
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'NEW_TOKEN' },
    })
    fireEvent.change(within(sheet).getByLabelText(/Build configs/), {
      target: { value: 'beta' },
    })
    const value = within(sheet).getByLabelText('Value') as HTMLInputElement
    assert.equal(value.type, 'password')
    fireEvent.change(value, { target: { value: 's3cret' } })
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Show the value' }),
    )
    assert.equal(value.type, 'text')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save value' }))
    assert.deepEqual(await bodyOf(app, `POST ${SECRETS}`), {
      kind: 'value',
      name: 'NEW_TOKEN',
      configs: 'beta',
      value: 's3cret',
    })
    await screen.findByText('NEW_TOKEN added (beta)')
    await until(
      () => app.node.requests.filter((r) => r === `GET ${AUDIT}`).length >= 2,
      'the audit read again',
    )
    assert.ok(
      app.node.requests.filter((r) => r === `GET ${SECRETS}`).length >= 2,
    )
    cleanup()
    openSecrets({
      [`POST ${SECRETS}`]: {
        status: 409,
        body: { error: 'NEW_TOKEN already has a variant for all configs' },
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Add value' }))
    const again = await screen.findByRole('dialog', {
      name: 'Add a secret value',
    })
    fireEvent.change(within(again).getByLabelText('Name'), {
      target: { value: 'NEW_TOKEN' },
    })
    fireEvent.change(within(again).getByLabelText('Value'), {
      target: { value: 'x' },
    })
    fireEvent.click(within(again).getByRole('button', { name: 'Save value' }))
    await within(again).findByText(
      'NEW_TOKEN already has a variant for all configs',
    )
  })

  it('moves a pasted value with line breaks into a text area; a script project masks in logs and has no configs', async () => {
    const app = openSecrets(
      {
        [`POST ${SECRETS}`]: recording(
          `POST ${SECRETS}`,
          201,
          variant(6, 'PEM'),
        ),
      },
      'manager',
      true,
      overviewFixture({ format: 'script' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Add value' }))
    const sheet = await screen.findByRole('dialog', {
      name: 'Add a secret value',
    })
    assert.equal(within(sheet).queryByLabelText(/Build configs/), null)
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'PEM' },
    })
    const single = within(sheet).getByLabelText('Value')
    fireEvent.paste(single, {
      clipboardData: { getData: () => 'line one\nline two' },
    })
    const area = (await within(sheet).findByLabelText(
      'Value',
    )) as HTMLTextAreaElement
    assert.equal(area.tagName, 'TEXTAREA')
    assert.equal(area.value, 'line one\nline two')
    within(sheet).getByText('It has line breaks, so it is shown as it is.')
    fireEvent.change(area, { target: { value: 'line one\nline two\n' } })
    const mask = within(sheet).getByRole('checkbox', { name: 'Mask in logs' })
    assert.equal((mask as HTMLInputElement).checked, true)
    fireEvent.click(mask)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save value' }))
    assert.deepEqual(await bodyOf(app, `POST ${SECRETS}`), {
      kind: 'value',
      name: 'PEM',
      configs: '',
      value: 'line one\nline two\n',
      masked: false,
    })
    await screen.findByText(/This is a script project/)
  })

  it('pastes into the value without line breaks as typed text', async () => {
    openSecrets()
    fireEvent.click(await screen.findByRole('button', { name: 'Add value' }))
    const sheet = await screen.findByRole('dialog', {
      name: 'Add a secret value',
    })
    const single = within(sheet).getByLabelText('Value')
    fireEvent.paste(single, { clipboardData: { getData: () => 'one line' } })
    assert.equal(within(sheet).getByLabelText('Value').tagName, 'INPUT')
    // A changed sheet asks before it goes.
    fireEvent.change(single, { target: { value: 'x' } })
    fireEvent.keyDown(sheet, { key: 'Escape' })
    const discard = await screen.findByRole('alertdialog', {
      name: 'Discard your changes?',
    })
    fireEvent.click(within(discard).getByRole('button', { name: 'Discard' }))
    await until(
      () =>
        screen.queryByRole('dialog', { name: 'Add a secret value' }) == null,
      'the sheet to close',
    )
  })

  it('adds a file: chosen or dropped, its name taken from it, refused over 5 MiB, or its text pasted', async () => {
    const app = openSecrets({
      [`POST ${SECRETS}`]: recording(
        `POST ${SECRETS}`,
        201,
        variant(7, 'config.json', { kind: 'file' }),
      ),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Add file' }))
    const sheet = await screen.findByRole('dialog', {
      name: 'Add a secret file',
    })
    within(sheet).getByText('Up to 5 MiB.')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save file' }))
    await within(sheet).findByText('Drop or choose a file, or paste its text')
    within(sheet).getByText('Enter its name.')
    const input = sheet.querySelector('input[type="file"]') as HTMLInputElement
    pick(input, new File([new Uint8Array(MAX_FILE + 1)], 'huge.bin'))
    await within(sheet).findByText(
      'The file is over 5 MiB. Choose a smaller file.',
    )
    const zone = sheet.querySelector('.m-dropzone')!
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(['{"a":1}\n'], 'config.json')] },
    })
    await within(sheet).findByText('config.json')
    within(sheet).getByText(/· 8 B/)
    assert.equal(
      (within(sheet).getByLabelText('File name') as HTMLInputElement).value,
      'config.json',
    )
    fireEvent.change(within(sheet).getByLabelText(/Build configs/), {
      target: { value: 'release' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save file' }))
    assert.deepEqual(await bodyOf(app, `POST ${SECRETS}`), {
      kind: 'file',
      name: 'config.json',
      configs: 'release',
      contents: Buffer.from('{"a":1}\n').toString('base64'),
    })
    await screen.findByText('config.json added (all)')
  })

  it('adds a file from pasted text at a path in a script project, with its path variable', async () => {
    const app = openSecrets(
      {
        [`POST ${SECRETS}`]: recording(
          `POST ${SECRETS}`,
          201,
          variant(8, 'android/app/google-services.json', { kind: 'file' }),
        ),
      },
      'manager',
      true,
      overviewFixture({ format: 'script' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Add file' }))
    const sheet = await screen.findByRole('dialog', {
      name: 'Add a secret file',
    })
    fireEvent.change(within(sheet).getByLabelText('File text'), {
      target: { value: '{ }' },
    })
    fireEvent.change(within(sheet).getByLabelText('Path in the checkout'), {
      target: { value: 'android/app/google-services.json' },
    })
    fireEvent.change(within(sheet).getByLabelText(/Path variable/), {
      target: { value: 'GOOGLE_SERVICES_PATH' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save file' }))
    assert.deepEqual(await bodyOf(app, `POST ${SECRETS}`), {
      kind: 'file',
      name: 'android/app/google-services.json',
      configs: '',
      contents: Buffer.from('{ }').toString('base64'),
      pathEnv: 'GOOGLE_SERVICES_PATH',
    })
  })

  it('edits a value in its row: the value read (and audited), saved, or given up with Esc', async () => {
    const app = openSecrets({
      [`${SECRETS}/1`]: { value: 'old-token' },
      [`PUT ${SECRETS}/1`]: recording(
        `PUT ${SECRETS}/1`,
        200,
        variant(1, 'API_TOKEN'),
      ),
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit API_TOKEN' }),
    )
    const block = await screen.findByRole('form', { name: 'Edit API_TOKEN' })
    const field = within(block).getByLabelText(
      'Value of API_TOKEN',
    ) as HTMLInputElement
    assert.equal(field.value, 'old-token')
    fireEvent.keyDown(block, { key: 'Escape' })
    await until(
      () => screen.queryByRole('form', { name: 'Edit API_TOKEN' }) == null,
      'the row back',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit API_TOKEN' }))
    const again = await screen.findByRole('form', { name: 'Edit API_TOKEN' })
    fireEvent.change(within(again).getByLabelText('Value of API_TOKEN'), {
      target: { value: 'new-token' },
    })
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }))
    assert.deepEqual(await bodyOf(app, `PUT ${SECRETS}/1`), {
      value: 'new-token',
    })
    await screen.findByText('API_TOKEN saved')
  })

  it('changes a variant’s build configs in its row, and keeps a refusal there', async () => {
    const app = openSecrets({
      [`PUT ${SECRETS}/2/configs`]: recording(
        `PUT ${SECRETS}/2/configs`,
        200,
        variant(2, 'SENTRY_DSN', { configs: ['release'] }),
      ),
      [`PUT ${SECRETS}/1/configs`]: {
        status: 400,
        body: { error: 'API_TOKEN already has a variant for release' },
      },
    })
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Build configs of SENTRY_DSN: release, staging. Change',
      }),
    )
    const block = await screen.findByRole('form', { name: 'Edit SENTRY_DSN' })
    const field = within(block).getByLabelText(
      'Build configs of SENTRY_DSN',
    ) as HTMLInputElement
    assert.equal(field.value, 'release, staging')
    fireEvent.change(field, { target: { value: 'release' } })
    fireEvent.click(within(block).getByRole('button', { name: 'Save' }))
    assert.deepEqual(await bodyOf(app, `PUT ${SECRETS}/2/configs`), {
      configs: 'release',
    })
    await screen.findByText('SENTRY_DSN now for release')
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Build configs of API_TOKEN: all. Change',
      }),
    )
    const other = await screen.findByRole('form', { name: 'Edit API_TOKEN' })
    fireEvent.change(
      within(other).getByLabelText('Build configs of API_TOKEN'),
      {
        target: { value: 'release' },
      },
    )
    fireEvent.click(within(other).getByRole('button', { name: 'Save' }))
    await within(other).findByText(
      'API_TOKEN already has a variant for release',
    )
    fireEvent.click(within(other).getByRole('button', { name: 'Cancel' }))
    await until(
      () => screen.queryByRole('form', { name: 'Edit API_TOKEN' }) == null,
      'the row back',
    )
  })

  it('edits a text file in the full-height editor, keeping its CRLF line endings', async () => {
    const app = openSecrets({
      [`${SECRETS}/3`]: { text: '{\r\n  "a": 1\r\n}\r\n' },
      [`PUT ${SECRETS}/3`]: recording(
        `PUT ${SECRETS}/3`,
        200,
        variant(3, 'google-services.json', { kind: 'file' }),
      ),
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit google-services.json' }),
    )
    const editor = await screen.findByRole('dialog', {
      name: 'google-services.json',
    })
    const area = within(editor).getByLabelText(
      'Contents of google-services.json',
    ) as HTMLTextAreaElement
    assert.equal(area.value, '{\n  "a": 1\n}\n')
    assert.equal(document.activeElement, area)
    within(editor).getByText('CRLF · UTF-8')
    within(editor).getByText(
      'Esc closes · Changes are backed up before they are saved',
    )
    within(editor).getByText('all')
    fireEvent.change(area, { target: { value: '{\n  "a": 2\n}\n' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    assert.deepEqual(await bodyOf(app, `PUT ${SECRETS}/3`), {
      text: '{\r\n  "a": 2\r\n}\r\n',
    })
    await screen.findByText('google-services.json saved')
    await until(
      () =>
        screen.queryByRole('dialog', { name: 'google-services.json' }) == null,
      'the editor to close',
    )
  })

  it('closes the editor with Esc, asking first when it changed; a refused save stays in it', async () => {
    openSecrets({
      [`${SECRETS}/1`]: { value: 'line one\nline two' },
      [`PUT ${SECRETS}/1`]: {
        status: 502,
        body: { error: 'Not saved: the backup could not be pushed' },
      },
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit API_TOKEN' }),
    )
    // A value with line breaks opens in the editor.
    const editor = await screen.findByRole('dialog', { name: 'API_TOKEN' })
    within(editor).getByText('LF · UTF-8')
    fireEvent.keyDown(editor, { key: 'Escape' })
    await until(
      () => screen.queryByRole('dialog', { name: 'API_TOKEN' }) == null,
      'closed unchanged',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit API_TOKEN' }))
    const again = await screen.findByRole('dialog', { name: 'API_TOKEN' })
    const area = within(again).getByLabelText('Contents of API_TOKEN')
    fireEvent.change(area, { target: { value: 'changed' } })
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }))
    await within(again).findByText('Not saved: the backup could not be pushed')
    fireEvent.keyDown(again, { key: 'Escape' })
    const discard = await screen.findByRole('alertdialog', {
      name: 'Discard your changes?',
    })
    within(discard).getByText('What you changed in API_TOKEN is not saved.')
    fireEvent.click(
      within(discard).getByRole('button', { name: 'Keep editing' }),
    )
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', {
          name: 'Discard your changes?',
        }),
      ).getByRole('button', { name: 'Discard' }),
    )
    await until(
      () => screen.queryByRole('dialog', { name: 'API_TOKEN' }) == null,
      'discarded',
    )
  })

  it('refuses to edit a file that mixes line endings, offering Replace', async () => {
    const app = openSecrets({
      [`${SECRETS}/3`]: { text: 'a\r\nb\nc' },
      [`${SECRETS}/1`]: { value: 'a\r\nb\n' },
      [`PUT ${SECRETS}/3/file`]: recording(
        `PUT ${SECRETS}/3/file`,
        200,
        variant(3, 'google-services.json', { kind: 'file' }),
      ),
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit google-services.json' }),
    )
    await screen.findByText('This file mixes line endings')
    screen.getByText(
      'The editor would change them in google-services.json. Replace the file instead.',
    )
    assert.equal(screen.queryByRole('dialog'), null)
    const input = document.querySelector(
      '.m-card input[type="file"]',
    ) as HTMLInputElement
    let clicked = 0
    input.addEventListener('click', (event) => {
      clicked++
      event.preventDefault()
    })
    fireEvent.click(
      within(
        screen.getByText('This file mixes line endings').closest('.m-banner')!,
      ).getByRole('button', { name: 'Replace' }),
    )
    assert.equal(clicked, 1)
    pick(input, new File(['a\nb\n'], 'google-services.json'))
    assert.deepEqual(await bodyOf(app, `PUT ${SECRETS}/3/file`), {
      contents: Buffer.from('a\nb\n').toString('base64'),
    })
    await screen.findByText('google-services.json replaced')
    // A value that mixes them is refused too, with no file to replace it by.
    fireEvent.click(screen.getByRole('button', { name: 'Edit API_TOKEN' }))
    await screen.findByText('This value mixes line endings')
    fireEvent.click(
      within(
        screen.getByText('This value mixes line endings').closest('.m-banner')!,
      ).getByRole('button', { name: 'Dismiss' }),
    )
    assert.equal(screen.queryByText('This value mixes line endings'), null)
  })

  it('replaces a binary file, refusing one over 5 MiB in its row', async () => {
    const app = openSecrets({
      [`PUT ${SECRETS}/4/file`]: {
        status: 400,
        body: { error: 'The file distribution.p12 needs base64 contents' },
      },
    })
    const replace = await screen.findByRole('button', {
      name: 'Replace distribution.p12',
    })
    const input = document.querySelector(
      '.m-card input[type="file"]',
    ) as HTMLInputElement
    input.addEventListener('click', (event) => event.preventDefault())
    fireEvent.click(replace)
    pick(input, new File([new Uint8Array(MAX_FILE + 1)], 'big.p12'))
    await screen.findByText('The file is over 5 MiB. Choose a smaller file.')
    fireEvent.click(replace)
    pick(input, new File([new Uint8Array([1, 2, 3])], 'small.p12'))
    await screen.findByText('The file distribution.p12 needs base64 contents')
    assert.ok(app.node.requests.includes(`PUT ${SECRETS}/4/file`))
  })

  it('says why a value or file could not be opened', async () => {
    openSecrets({
      [`${SECRETS}/1`]: {
        status: 403,
        body: { error: 'Viewing is for managers' },
      },
      [`${SECRETS}/3`]: { contents: 'AAEC' },
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit API_TOKEN' }),
    )
    await screen.findByText('Viewing is for managers')
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit google-services.json' }),
    )
    await screen.findByText(
      'google-services.json is binary: replace it instead',
    )
  })

  it('deletes a secret only after the confirm names it and its configs', async () => {
    const app = openSecrets({
      [`DELETE ${SECRETS}/2`]: { status: 200, body: null },
      [`DELETE ${SECRETS}/1`]: {
        status: 502,
        body: { error: 'Not saved: the backup could not be pushed' },
      },
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete SENTRY_DSN' }),
    )
    const alert = await screen.findByRole('alertdialog', {
      name: 'Delete SENTRY_DSN?',
    })
    within(alert).getByText(
      'Stages in release, staging build configs can no longer read it. The change is backed up first.',
    )
    fireEvent.click(within(alert).getByRole('button', { name: 'Keep it' }))
    await until(() => screen.queryByRole('alertdialog') == null, 'kept')
    assert.ok(!app.node.requests.includes(`DELETE ${SECRETS}/2`))
    fireEvent.click(screen.getByRole('button', { name: 'Delete SENTRY_DSN' }))
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Delete SENTRY_DSN?' }),
      ).getByRole('button', { name: 'Delete' }),
    )
    await screen.findByText('SENTRY_DSN (release, staging) deleted')
    fireEvent.click(screen.getByRole('button', { name: 'Delete API_TOKEN' }))
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Delete API_TOKEN?' }),
      ).getByRole('button', { name: 'Delete' }),
    )
    const error = await screen.findByText(
      'Not saved: the backup could not be pushed',
    )
    assert.equal(error.closest('tr')!.previousElementSibling, row('API_TOKEN'))
  })

  it('offers Retry when the list cannot be read, and says when the audit cannot', async () => {
    const app = openSecrets({
      [SECRETS]: { status: 500, body: { error: 'Database busy' } },
      [AUDIT]: { status: 500, body: { error: 'Audit busy' } },
    })
    await screen.findByRole('heading', {
      name: 'The secrets could not be read',
    })
    await screen.findByText('Audit busy')
    app.node.set(SECRETS, variants())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('table')
  })
})

describe('Secret files before they are sent', () => {
  it('encodes bytes as base64 in chunks, and text as UTF-8', async () => {
    const big = new Uint8Array(0x8000 * 2 + 5).fill(65)
    assert.equal(toBase64(big), Buffer.from(big).toString('base64'))
    assert.equal(textContents('é\n'), Buffer.from('é\n').toString('base64'))
    assert.equal(
      await fileContents(new Blob(['abc'])),
      Buffer.from('abc').toString('base64'),
    )
  })

  it('refuses a file or text over 5 MiB', async () => {
    const huge = new Blob([new Uint8Array(MAX_FILE + 1)])
    assert.equal(
      fileRefusal(huge),
      'The file is over 5 MiB. Choose a smaller file.',
    )
    assert.equal(fileRefusal(new Blob(['x'])), undefined)
    await assert.rejects(fileContents(huge), /over 5 MiB/)
    assert.throws(
      () => textContents('x'.repeat(MAX_FILE + 1)),
      /The text is over 5 MiB/,
    )
  })

  it('edits LF and all-CRLF text, and refuses mixed endings or a lone CR', () => {
    assert.deepEqual(editableText('a\nb\n'), { text: 'a\nb\n', crlf: false })
    assert.deepEqual(editableText('a\r\nb\r\n'), { text: 'a\nb\n', crlf: true })
    assert.equal(editableText('a\r\nb\n'), undefined)
    assert.equal(editableText('a\rb'), undefined)
    assert.equal(editableText('\na\r\n'), undefined)
  })

  it('notes a variant’s masking, path variable, destination and size', () => {
    assert.deepEqual(
      secretNotes(
        variant(1, 'f.json', {
          kind: 'file',
          bytes: 1_200,
          text: false,
          pathEnv: 'F_PATH',
          destination: 'app/f.json',
        }),
      ),
      ['→ $F_PATH', 'at app/f.json', '1.2 KB · binary'],
    )
    assert.deepEqual(secretNotes(variant(2, 'V', { masked: false })), [
      'Not masked in logs',
    ])
    assert.deepEqual(
      secretNotes(variant(3, 'same', { kind: 'file', destination: 'same' })),
      ['12 B · text'],
    )
  })
})
