import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { ShellContext } from '../../layout/ShellContext.js'
import {
  nodeInfo,
  renderApp,
  sessionFor,
  shellReplies,
  until,
} from '../../test/render.js'
import {
  ACCOUNTS,
  card,
  diskLocation,
  held,
  openSettings,
  recorder,
  requested,
  sessionWithout,
  settingsReplies,
  spaceLocation,
  STORAGE,
  text,
  toasted,
} from '../../test/settings.js'
import { locationName, originText, StorageCard } from './storage.js'

afterEach(() => cleanup())

const type = (
  scope: HTMLElement,
  label: string | RegExp,
  value: string,
): void => {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } })
}

const rows = async (storage: HTMLElement): Promise<HTMLElement[]> =>
  within(await within(storage).findByRole('table'))
    .getAllByRole('row')
    .slice(1)

describe('Storage', () => {
  it('lists every location with where new builds go, files and size, and Delete or Forget for Spaces', async () => {
    openSettings()
    const storage = await card('Storage')
    within(storage).getByText(/Every place builds are stored/)
    const list = await rows(storage)
    assert.deepEqual(
      list.map((row) => row.getAttribute('data-location')),
      ['sp1', 'disk', 'sp2', 'sp3'],
    )
    assert.match(
      text(list[0]!),
      /mason-builds.*sfo3 · made by Mason.*New builds go here.*1,284.*212\.4 GB/,
    )
    // The location new builds go to cannot be removed.
    assert.equal(
      within(list[0]!).queryByRole('button', { name: /Delete|Forget/ }),
      null,
    )
    assert.match(text(list[1]!), /Host’s disk.*312.*100\.4 GB/)
    within(list[1]!).getByRole('button', {
      name: 'Use Host’s disk for new builds',
    })
    assert.match(text(list[2]!), /old-builds.*nyc3 · added.*—.*—/)
    within(list[2]!).getByRole('button', {
      name: 'Forget the Space old-builds',
    })
    assert.match(
      text(list[3]!),
      /host-builds.*made for host builds\.example\.com/,
    )
    within(list[3]!).getByRole('button', {
      name: 'Delete the Space host-builds',
    })
    within(storage).getByRole('button', { name: 'Make a new Space' })
    within(storage).getByRole('button', { name: 'Add an existing Space' })
  })

  it('switches where new builds go, busy while it runs; a refusal stays in the card', async () => {
    const use = held(200, { driver: 'disk' })
    const app = openSettings({
      'POST /api/v2/storage/disk': use.reply,
      'POST /api/v2/storage/locations/sp2/use': {
        status: 502,
        body: { error: 'The host did not answer' },
      },
    })
    const storage = await card('Storage')
    const list = await rows(storage)
    const button = within(list[1]!).getByRole('button', {
      name: 'Use Host’s disk for new builds',
    })
    fireEvent.click(button)
    await requested(app, 'POST /api/v2/storage/disk')
    assert.equal(button.getAttribute('aria-busy'), 'true')
    await act(async () => use.release())
    await toasted('New builds go to Host’s disk')
    await until(
      () =>
        app.node.requests.filter((r) => r === `GET ${STORAGE}`).length === 2,
      'storage read again',
    )
    fireEvent.click(
      within(list[2]!).getByRole('button', {
        name: 'Use old-builds for new builds',
      }),
    )
    await within(storage).findByText('The host did not answer')
  })

  it('deletes a Space Mason made after typing its name (tier 3), and forgets an added one', async () => {
    const remove = recorder((body) =>
      (body as { confirm: string }).confirm === 'host-builds'
        ? { status: 200, body: { files: 1, bucketDeleted: true } }
        : { status: 400, body: { error: 'The host does not answer' } },
    )
    openSettings({
      'DELETE /api/v2/storage/locations/sp3': remove.reply,
      'DELETE /api/v2/storage/locations/sp2': remove.reply,
    })
    const storage = await card('Storage')
    const list = await rows(storage)
    fireEvent.click(
      within(list[3]!).getByRole('button', {
        name: 'Delete the Space host-builds',
      }),
    )
    const alert = await screen.findByRole('alertdialog')
    within(alert).getByText('Delete the Space host-builds?')
    within(alert).getByText(/DigitalOcean deletes the Space host-builds/)
    within(alert).getByText(/1 \(512 B\) builds/)
    const confirm = within(alert).getByRole('button', {
      name: 'Delete the Space',
    })
    assert.equal((confirm as HTMLButtonElement).disabled, true)
    fireEvent.change(within(alert).getByRole('textbox'), {
      target: { value: 'host-builds' },
    })
    assert.equal((confirm as HTMLButtonElement).disabled, false)
    fireEvent.click(confirm)
    await toasted('host-builds deleted')
    assert.deepEqual(remove.bodies[0], { confirm: 'host-builds' })
    // Forget: the Space stays in DigitalOcean; a refusal stays in the card.
    fireEvent.click(
      within(list[2]!).getByRole('button', {
        name: 'Forget the Space old-builds',
      }),
    )
    const forget = await screen.findByRole('alertdialog')
    within(forget).getByText(/the Space and its files stay in DigitalOcean/)
    within(forget).getByText(/its stored builds/)
    fireEvent.change(within(forget).getByRole('textbox'), {
      target: { value: 'old-builds' },
    })
    fireEvent.click(
      within(forget).getByRole('button', { name: 'Forget the Space' }),
    )
    await within(storage).findByText('The host does not answer')
    // Keep it backs out.
    fireEvent.click(
      within(list[2]!).getByRole('button', {
        name: 'Forget the Space old-builds',
      }),
    )
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Keep it',
      }),
    )
    await until(() => screen.queryByRole('alertdialog') == null, 'closed')
  })

  it('makes a new Space in a DigitalOcean account, checked first; a refusal stays in the sheet', async () => {
    const make = recorder((_body, n) =>
      n === 1
        ? { status: 400, body: { error: 'Nothing was saved: name taken' } }
        : { status: 200, body: { driver: 's3' } },
    )
    openSettings({ 'POST /api/v2/storage/space/new': make.reply })
    const storage = await card('Storage')
    fireEvent.click(
      await within(storage).findByRole('button', { name: 'Make a new Space' }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Make a new Space',
    })
    within(sheet).getByText(/billed by use from \$5 a month/)
    assert.deepEqual(
      within(within(sheet).getByLabelText('DigitalOcean account'))
        .getAllByRole('option')
        .map((option) => option.textContent),
      ['DigitalOcean'],
    )
    const regions = within(within(sheet).getByLabelText('Region'))
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
    assert.deepEqual(regions, [
      'sfo3',
      'nyc3',
      'ams3',
      'fra1',
      'lon1',
      'sgp1',
      'syd1',
      'blr1',
      'tor1',
      'atl1',
    ])
    type(sheet, 'Space name', 'X')
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Make the Space' }),
    )
    within(sheet).getByText('Use 3 to 63 lowercase letters, digits and dashes.')
    type(sheet, 'Space name', 'team-builds')
    fireEvent.change(within(sheet).getByLabelText('Region'), {
      target: { value: 'ams3' },
    })
    fireEvent.click(within(sheet).getByLabelText('Use it for new builds'))
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Make the Space' }),
    )
    await within(sheet).findByText('Nothing was saved: name taken')
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Make the Space' }),
    )
    await toasted('Space team-builds made')
    assert.deepEqual(make.bodies[1], {
      account: 'do-main',
      bucket: 'team-builds',
      region: 'ams3',
      use: false,
    })
    await until(() => screen.queryByRole('dialog') == null, 'closed')
  })

  it('adds an existing Space after its check, every field required', async () => {
    const add = held(200, { driver: 's3' })
    const app = openSettings({
      'POST /api/v2/storage/space': add.reply,
      [ACCOUNTS]: [],
    })
    const storage = await card('Storage')
    await rows(storage)
    assert.equal(
      within(storage).queryByRole('button', { name: 'Make a new Space' }),
      null,
    )
    fireEvent.click(
      within(storage).getByRole('button', { name: 'Add an existing Space' }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Add an existing Space',
    })
    within(sheet).getByText(/Mason writes, reads and deletes a check object/)
    const check = within(sheet).getByRole('button', { name: 'Check and add' })
    fireEvent.click(check)
    within(sheet).getByText('Enter the Space’s https address.')
    within(sheet).getByText('Enter the access key.')
    within(sheet).getByText('Enter the secret.')
    type(sheet, 'Space URL', 'https://team.sfo3.digitaloceanspaces.com')
    type(sheet, 'Access key', 'DO00ABC')
    type(sheet, 'Secret', 'shh')
    assert.equal(
      within(sheet).getByLabelText('Secret').getAttribute('type'),
      'password',
    )
    fireEvent.click(check)
    await requested(app, 'POST /api/v2/storage/space')
    assert.equal(check.getAttribute('aria-busy'), 'true')
    await act(async () => add.release())
    await toasted('Space added')
    assert.deepEqual(add.bodies[0], {
      url: 'https://team.sfo3.digitaloceanspaces.com',
      accessKeyId: 'DO00ABC',
      secretAccessKey: 'shh',
      use: true,
    })
  })

  it('asks before closing a sheet with changes, and keeps the refusal of an existing Space', async () => {
    openSettings({
      'POST /api/v2/storage/space': {
        status: 400,
        body: { error: 'Nothing was saved: the key cannot write' },
      },
    })
    const storage = await card('Storage')
    fireEvent.click(
      await within(storage).findByRole('button', {
        name: 'Add an existing Space',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Add an existing Space',
    })
    type(sheet, 'Space URL', 'https://team.sfo3.digitaloceanspaces.com')
    type(sheet, 'Access key', 'DO00ABC')
    type(sheet, 'Secret', 'shh')
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Check and add' }),
    )
    await within(sheet).findByText('Nothing was saved: the key cannot write')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    const discard = await screen.findByRole('alertdialog')
    fireEvent.click(within(discard).getByRole('button', { name: 'Discard' }))
    await until(() => screen.queryByRole('dialog') == null, 'closed')
    // The Make sheet asks too.
    fireEvent.click(
      within(storage).getByRole('button', { name: 'Make a new Space' }),
    )
    const make = await screen.findByRole('dialog', { name: 'Make a new Space' })
    type(make, 'Space name', 'other')
    fireEvent.click(within(make).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Discard',
      }),
    )
    await until(() => screen.queryByRole('dialog') == null, 'closed')
  })

  it('shows its loading, error with Retry, and empty states', async () => {
    const slow = held(200, { locations: [] })
    const app = openSettings({ [STORAGE]: slow.reply })
    const storage = await card('Storage')
    within(storage).getByRole('status', { name: 'Loading storage' })
    await act(async () => slow.release())
    await within(storage).findByText('No storage locations.')
    cleanup()
    const failing = openSettings({
      [STORAGE]: { status: 500, body: { error: 'Broken' } },
    })
    const failed = await card('Storage')
    await within(failed).findByText(/Storage could not be read: Broken/)
    failing.node.set(STORAGE, { locations: [diskLocation({ active: true })] })
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }))
    await within(failed).findByText('New builds go here')
    assert.ok(app)
  })

  it('without settings.change: no actions, and no accounts read', async () => {
    const session = sessionWithout('manager', ['settings.change'])
    const app = renderApp({
      node: nodeInfo('master'),
      path: '/',
      element: (
        <ShellContext.Provider
          value={{
            session,
            status: undefined,
            reloadStatus: () => undefined,
            nav: [],
            openPalette: () => undefined,
            setMeta: () => undefined,
          }}
        >
          <StorageCard />
        </ShellContext.Provider>
      ),
      replies: shellReplies('manager', 'master', settingsReplies()),
    })
    const storage = await card('Storage')
    const list = await rows(storage)
    assert.equal(within(storage).queryAllByRole('button').length, 0)
    assert.match(text(list[1]!), /Host’s disk—/)
    assert.ok(!app.node.requests.includes(`GET ${ACCOUNTS}`))
  })

  it('compact, in the Nodes page’s host panel: a titled part with the same table and actions', async () => {
    renderApp({
      node: nodeInfo('master'),
      path: '/',
      element: (
        <ShellContext.Provider
          value={{
            session: sessionFor('admin'),
            status: undefined,
            reloadStatus: () => undefined,
            nav: [],
            openPalette: () => undefined,
            setMeta: () => undefined,
          }}
        >
          <StorageCard compact />
        </ShellContext.Provider>
      ),
      replies: shellReplies('admin', 'master', settingsReplies()),
    })
    const storage = await screen.findByRole('region', { name: /Storage/ })
    assert.ok(storage.classList.contains('m-storage--compact'))
    assert.ok(!storage.classList.contains('m-card'))
    screen.getByRole('heading', { level: 3, name: /Storage/ })
    assert.equal(
      within(storage).queryByText(/Every place builds are stored/),
      null,
    )
    assert.equal((await rows(storage)).length, 4)
    within(storage).getByRole('button', { name: 'Add an existing Space' })
  })

  it('names locations and their origins', () => {
    assert.equal(
      originText(spaceLocation({ origin: 'host', host: undefined })),
      'made for a host',
    )
    assert.equal(originText(spaceLocation({ origin: undefined })), 'added')
    assert.equal(locationName(spaceLocation({ bucket: undefined })), 'sp1')
    assert.equal(locationName(diskLocation()), 'Host’s disk')
  })
})
