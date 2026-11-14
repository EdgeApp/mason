import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { until } from '../../../test/render.js'
import {
  apiKey,
  card,
  held,
  KEYS,
  keysFixture,
  openSettings,
  recorder,
  requested,
  sessionWithout,
  SIGNING,
  signedOut,
  signingFixture,
  text,
  toasted,
} from '../../../test/settings.js'
import { keyPrefix, keyRoles, roleWord } from './keys.js'
import { day, listOf, isHttps } from './parts.js'

afterEach(() => cleanup())

const type = (
  label: string | RegExp,
  value: string,
  within_?: HTMLElement,
): void => {
  const field = (within_ == null ? screen : within(within_)).getByLabelText(
    label,
  )
  fireEvent.change(field, { target: { value } })
}

describe('Settings', () => {
  it('draws the header, related links, the section index and every card for an administrator', async () => {
    openSettings()
    await screen.findByRole('heading', { level: 1, name: 'Settings' })
    screen.getByText(
      'How this master signs people in, reaches GitHub and Apple, keeps its builds and runs its nodes.',
    )
    const related = screen.getByRole('navigation', { name: 'Related pages' })
    assert.deepEqual(
      within(related)
        .getAllByRole('link')
        .map((link) => [text(link), link.getAttribute('href')]),
      [
        ['People', '/people'],
        ['Groups', '/groups'],
        ['Backups', '/backups'],
        ['Nodes', '/nodes'],
      ],
    )
    const index = screen.getByRole('navigation', { name: 'Settings sections' })
    const links = within(index).getAllByRole('link')
    assert.deepEqual(
      links.map((link) => link.getAttribute('href')),
      [
        '#apple-session',
        '#keys',
        '#github',
        '#host',
        '#storage',
        '#signIn',
        '#cloud',
        '#nodeTypes',
      ],
    )
    assert.equal(links[0]!.getAttribute('aria-current'), 'true')
    for (const id of [
      'apple-session',
      'keys',
      'github',
      'host',
      'storage',
      'signIn',
      'cloud',
      'nodeTypes',
    ])
      assert.ok(document.getElementById(id), id)
    fireEvent.click(links[2]!)
    assert.equal(links[2]!.getAttribute('aria-current'), 'true')
    assert.equal(links[0]!.getAttribute('aria-current'), null)
  })

  it('is refused to developers by the route', async () => {
    const app = openSettings({}, 'developer')
    await until(() => document.querySelector('.m-empty') != null, 'the refusal')
    assert.equal(screen.queryByText('Apple ID for Xcode downloads'), null)
    assert.ok(!app.node.requests.includes(`GET ${SIGNING}`))
  })

  it('shows a viewer without settings.change only the Apple ID and the keys', async () => {
    openSettings(
      {
        '/api/v2/session': sessionWithout('manager', [
          'settings.change',
          'apple.change',
          'keys.revoke',
          'keys.create',
        ]),
      },
      'manager',
    )
    const apple = await card('Apple ID for Xcode downloads')
    await within(apple).findByText(/Signed in as/)
    assert.equal(
      within(apple).queryByRole('button', { name: 'Sign in again' }),
      null,
    )
    assert.equal(within(apple).queryByRole('button', { name: /Set up/ }), null)
    assert.equal(
      within(apple).queryByRole('button', { name: 'Check signing again' }),
      null,
    )
    const keys = await card(/API keys/)
    await within(keys).findByText('ci-uploads')
    assert.equal(within(keys).queryByRole('button', { name: /Revoke/ }), null)
    assert.equal(
      within(keys).queryByRole('button', { name: 'Create key' }),
      null,
    )
    assert.equal(document.getElementById('github'), null)
    assert.equal(document.getElementById('storage'), null)
    const index = screen.getByRole('navigation', { name: 'Settings sections' })
    assert.equal(within(index).getAllByRole('link').length, 2)
  })
})

describe('Settings → Apple ID', () => {
  it('signed in: the state, the teams’ signing in each state, and the form behind Sign in again', async () => {
    openSettings()
    const apple = await card('Apple ID for Xcode downloads')
    await within(apple).findByText('builds@teamstation.app')
    within(apple).getByText('Signed in', { selector: '.m-status *, .m-status' })
    const rows = within(apple).getAllByRole('listitem')
    assert.deepEqual(
      rows.map((row) => row.getAttribute('data-team')),
      ['V4AK4X7A2V', 'G5LQ7MERPK', 'ABCDE12345', 'ZZZZZ99999', 'OLDTEAM000'],
    )
    assert.match(
      text(rows[0]!),
      /Signing is set up for TeamStation Inc \(V4AK4X7A2V\): App Store Connect API key Mason \(ABC123\), Apple Distribution: TeamStation Inc, expires (Jan 1|2027-01-01)\./,
    )
    assert.match(text(rows[1]!), /Failed.*reached its limit/)
    within(rows[1]!).getByRole('button', { name: 'Set up Edge Labs' })
    assert.match(
      text(rows[2]!),
      /Setting up.*Setting signing up for Side Project \(ABCDE12345\)…/,
    )
    assert.equal(within(rows[2]!).queryByRole('button'), null)
    assert.match(
      text(rows[3]!),
      /Not set up.*Signing is not set up for New Team/,
    )
    within(rows[3]!).getByRole('button', { name: 'Set up New Team' })
    assert.match(text(rows[4]!), /no distribution certificate yet/)
    // The form waits behind Sign in again, the Apple ID filled in.
    assert.equal(within(apple).queryByLabelText('Password'), null)
    const again = within(apple).getByRole('button', { name: 'Sign in again' })
    assert.equal(again.getAttribute('aria-expanded'), 'false')
    fireEvent.click(again)
    assert.equal(again.getAttribute('aria-expanded'), 'true')
    assert.equal(
      (within(apple).getByLabelText('Apple ID') as HTMLInputElement).value,
      'builds@teamstation.app',
    )
  })

  it('signs in again, and a failure stays in the form', async () => {
    const signIn = recorder((_body, n) =>
      n === 1
        ? { status: 400, body: { error: 'Apple refused the password' } }
        : n === 2
          ? {
              status: 200,
              body: { state: 'failed', error: 'Apple is unavailable' },
            }
          : {
              status: 200,
              body: { state: 'signedIn', appleId: 'ada@example.test' },
            },
    )
    const app = openSettings({ 'POST /api/v2/apple/session': signIn.reply })
    const apple = await card('Apple ID for Xcode downloads')
    fireEvent.click(
      await within(apple).findByRole('button', { name: 'Sign in again' }),
    )
    // Checked before sending.
    type('Apple ID', 'not-an-email', apple)
    fireEvent.click(within(apple).getByRole('button', { name: 'Sign in' }))
    within(apple).getByText('Enter the Apple ID’s email address.')
    within(apple).getByText('Enter the password.')
    type('Apple ID', 'ada@example.test', apple)
    type('Password', 'hunter2', apple)
    fireEvent.click(within(apple).getByRole('button', { name: 'Sign in' }))
    await within(apple).findByText('Apple refused the password')
    fireEvent.click(within(apple).getByRole('button', { name: 'Sign in' }))
    await within(apple).findByText('Apple is unavailable')
    fireEvent.click(within(apple).getByRole('button', { name: 'Sign in' }))
    await toasted('Signed in as ada@example.test')
    assert.deepEqual(signIn.bodies[2], {
      appleId: 'ada@example.test',
      password: 'hunter2',
    })
    // The form closes and the state is read again.
    await until(
      () => within(apple).queryByLabelText('Password') == null,
      'the form to close',
    )
    assert.equal(
      app.node.requests.filter((request) => request === `GET ${SIGNING}`)
        .length,
      2,
    )
  })

  it('signed out: Apple ID and password, a busy Sign in, then Apple asks for a code', async () => {
    const answer = held(200, {
      state: 'needsCode',
      appleId: 'ada@example.test',
    })
    const app = openSettings({
      [SIGNING]: signedOut({
        notice: 'The Apple ID session expired: sign in again.',
        failures: { G5LQ7MERPK: 'Edge Labs: the Apple ID is not an Admin.' },
      }),
      'POST /api/v2/apple/session': answer.reply,
    })
    const apple = await card('Apple ID for Xcode downloads')
    await within(apple).findByText('Not signed in.')
    within(apple).getByText('Not signed in', {
      selector: '.m-status *, .m-status',
    })
    within(apple).getByText('The Apple ID session expired: sign in again.')
    within(apple).getByText('Edge Labs: the Apple ID is not an Admin.')
    const id = within(apple).getByLabelText('Apple ID')
    assert.equal(id.getAttribute('autocomplete'), 'username')
    assert.equal(
      within(apple).getByLabelText('Password').getAttribute('autocomplete'),
      'current-password',
    )
    type('Apple ID', 'ada@example.test', apple)
    type('Password', 'hunter2', apple)
    const button = within(apple).getByRole('button', { name: 'Sign in' })
    fireEvent.click(button)
    await requested(app, 'POST /api/v2/apple/session')
    assert.equal(button.getAttribute('aria-busy'), 'true')
    answer.release()
    await toasted('Apple sent a code')
  })

  it('needs a code: the six-digit field sends the code to the master', async () => {
    const code = recorder((_body, n) =>
      n === 1
        ? { status: 400, body: { error: 'No sign-in waits for a code' } }
        : n === 2
          ? { status: 200, body: { state: 'expired', notice: 'Expired' } }
          : {
              status: 200,
              body: { state: 'signedIn', appleId: 'ada@example.test' },
            },
    )
    openSettings({
      [SIGNING]: signedOut({ needsCode: true, appleId: 'ada@example.test' }),
      'POST /api/v2/apple/session/code': code.reply,
    })
    const apple = await card('Apple ID for Xcode downloads')
    await within(apple).findByText(/Apple sent a six-digit code/)
    within(apple).getByText('Needs a code', {
      selector: '.m-status *, .m-status',
    })
    const field = within(apple).getByLabelText('Two-factor code')
    assert.equal(field.getAttribute('autocomplete'), 'one-time-code')
    assert.equal(field.getAttribute('inputmode'), 'numeric')
    const send = within(apple).getByRole('button', {
      name: 'Send code to the master',
    })
    type('Two-factor code', '12', apple)
    fireEvent.click(send)
    within(apple).getByText('Enter the six-digit code.')
    type('Two-factor code', '123456', apple)
    fireEvent.click(send)
    await within(apple).findByText('No sign-in waits for a code')
    fireEvent.click(send)
    await within(apple).findByText('Expired')
    fireEvent.click(send)
    await toasted('Signed in as ada@example.test')
    assert.deepEqual(code.bodies[2], { code: '123456' })
  })

  it('sets a team up, checks signing again for a chosen team, and keeps a refusal in the card', async () => {
    const setup = recorder((body, n) =>
      n === 2
        ? { status: 400, body: { error: 'Apple allows no more certificates' } }
        : {
            status: 200,
            body: {
              team: {
                id: (body as { team: string }).team,
                name: 'Edge Labs',
              },
              key: 'kept',
              keyId: 'K1',
              certificate: 'created',
            },
          },
    )
    const app = openSettings({ 'POST /api/v2/apple/setup': setup.reply })
    const apple = await card('Apple ID for Xcode downloads')
    fireEvent.click(
      await within(apple).findByRole('button', { name: 'Set up Edge Labs' }),
    )
    await toasted('Signing checked for Edge Labs')
    assert.deepEqual(setup.bodies[0], { team: 'G5LQ7MERPK' })
    fireEvent.change(within(apple).getByLabelText('Team'), {
      target: { value: 'ZZZZZ99999' },
    })
    fireEvent.click(
      within(apple).getByRole('button', { name: 'Check signing again' }),
    )
    await within(apple).findByText('Apple allows no more certificates')
    assert.deepEqual(setup.bodies[1], { team: 'ZZZZZ99999' })
    assert.ok(app.node.requests.includes('POST /api/v2/apple/setup'))
  })

  it('says when the Apple ID belongs to no team, or its teams could not be read, or the read failed', async () => {
    openSettings({
      [SIGNING]: signingFixture({
        setup: { keyName: 'Mason', teams: [], configured: [] },
        failures: { '': 'Apple did not list the teams.' },
        settingUp: [],
      }),
    })
    const apple = await card('Apple ID for Xcode downloads')
    await within(apple).findByText(
      'This Apple ID belongs to no developer team.',
    )
    within(apple).getByText('Apple did not list the teams.')
    assert.equal(within(apple).queryByLabelText('Team'), null)
    cleanup()
    openSettings({
      [SIGNING]: signingFixture({
        setup: {
          keyName: 'Mason',
          teams: [],
          configured: [],
          error: 'Apple answered 503',
        },
      }),
    })
    const again = await card('Apple ID for Xcode downloads')
    await within(again).findByText('Apple answered 503')
    cleanup()
    const app = openSettings({
      [SIGNING]: { status: 500, body: { error: 'Broken' } },
    })
    const failed = await card('Apple ID for Xcode downloads')
    await within(failed).findByText(/The Apple ID could not be read: Broken/)
    app.node.set(SIGNING, signedOut())
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }))
    await within(failed).findByText('Not signed in.')
  })

  it('shows a skeleton while the Apple ID loads', async () => {
    const answer = held(200, signedOut())
    openSettings({ [SIGNING]: answer.reply })
    const apple = await card('Apple ID for Xcode downloads')
    within(apple).getByRole('status', { name: 'Loading the Apple ID' })
    answer.release()
    await within(apple).findByText('Not signed in.')
  })
})

describe('Settings → API keys', () => {
  it('lists each key with its role, day, state and prefix; Revoke only on active keys', async () => {
    openSettings()
    const keys = await card(/API keys/)
    const table = await within(keys).findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    assert.equal(rows.length, 3)
    assert.match(
      text(rows[0]!),
      /ci-uploads.*Developer.*Active.*mason_v1_ab12c…/,
    )
    within(rows[0]!).getByRole('button', { name: 'Revoke ci-uploads' })
    assert.match(text(rows[1]!), /eddy-agent.*Tester.*Revoked/)
    assert.equal(within(rows[1]!).queryByRole('button'), null)
    assert.match(text(rows[2]!), /old-builder.*builder key/)
    within(keys).getByText(
      'Create API keys to access Mason from other apps and agents.',
    )
    assert.equal(text(keys.querySelector('.m-count')), '3')
  })

  it('says No keys. when there are none, and Retry after a failed read', async () => {
    const app = openSettings({ [KEYS]: [] })
    const keys = await card(/API keys/)
    await within(keys).findByText('No keys.')
    cleanup()
    const again = openSettings({
      [KEYS]: { status: 500, body: { error: 'Down' } },
    })
    const failed = await card(/API keys/)
    await within(failed).findByText(/The API keys could not be read: Down/)
    again.node.set(KEYS, [])
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }))
    await within(failed).findByText('No keys.')
    assert.ok(app)
  })

  it('creates a key in a sheet with roles up to the viewer’s, and shows its token once with Done', async () => {
    const create = recorder((_body, n) =>
      n === 1
        ? { status: 400, body: { error: 'A name is too long' } }
        : {
            status: 201,
            body: apiKey({
              id: 'ffff0000ffff0000ffff0000ffff0000',
              name: 'deploys',
              role: 'manager',
              token: 'mason_v1_ffff0000.s3cret',
            }),
          },
    )
    const app = openSettings({ 'POST /api/v2/keys': create.reply }, 'manager')
    const keys = await card(/API keys/)
    await within(keys).findByText('ci-uploads')
    fireEvent.click(within(keys).getByRole('button', { name: 'Create key' }))
    const sheet = await screen.findByRole('dialog', {
      name: 'Create an API key',
    })
    assert.deepEqual(
      within(sheet)
        .getAllByRole('option')
        .map((option) => option.textContent),
      ['Developer', 'Tester', 'Manager'],
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create key' }))
    within(sheet).getByText('Enter a name.')
    type('Name', 'deploys', sheet)
    fireEvent.change(within(sheet).getByLabelText('Role'), {
      target: { value: 'manager' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create key' }))
    await within(sheet).findByText('A name is too long')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create key' }))
    await until(
      () => screen.queryByRole('dialog', { name: 'Create an API key' }) == null,
      'the sheet to close',
    )
    assert.deepEqual(create.bodies[1], { name: 'deploys', role: 'manager' })
    within(keys).getByText('Copy the new key deploys now')
    within(keys).getByText('mason_v1_ffff0000.s3cret')
    assert.equal(document.querySelectorAll('.m-toast').length, 0)
    await until(
      () => app.node.requests.filter((r) => r === `GET ${KEYS}`).length === 2,
      'the keys read again',
    )
    fireEvent.click(within(keys).getByRole('button', { name: 'Done' }))
    assert.equal(within(keys).queryByText('mason_v1_ffff0000.s3cret'), null)
  })

  it('revokes a key after a tier-2 confirm, busy while it runs; a refusal stays in the card', async () => {
    const revoke = held(200, null)
    const app = openSettings({
      'DELETE /api/v2/keys/ab12cd34ef56ab12cd34ef56ab12cd34': revoke.reply,
    })
    const keys = await card(/API keys/)
    fireEvent.click(
      await within(keys).findByRole('button', { name: 'Revoke ci-uploads' }),
    )
    const alert = await screen.findByRole('alertdialog')
    within(alert).getByText('Revoke the key ci-uploads?')
    // Cancel backs out.
    fireEvent.click(within(alert).getByRole('button', { name: 'Keep it' }))
    await until(
      () => screen.queryByRole('alertdialog') == null,
      'the alert to close',
    )
    fireEvent.click(
      within(keys).getByRole('button', { name: 'Revoke ci-uploads' }),
    )
    const again = await screen.findByRole('alertdialog')
    const confirm = within(again).getByRole('button', { name: 'Revoke' })
    assert.match(confirm.className, /m-btn--danger-filled/)
    fireEvent.click(confirm)
    await requested(app, 'DELETE /api/v2/keys/ab12cd34ef56ab12cd34ef56ab12cd34')
    assert.equal(confirm.getAttribute('aria-busy'), 'true')
    await act(async () => revoke.release())
    await toasted('ci-uploads revoked')
    cleanup()
    openSettings({
      'DELETE /api/v2/keys/ab12cd34ef56ab12cd34ef56ab12cd34': {
        status: 403,
        body: { error: 'That key’s role is higher than yours' },
      },
    })
    const refused = await card(/API keys/)
    fireEvent.click(
      await within(refused).findByRole('button', { name: 'Revoke ci-uploads' }),
    )
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Revoke',
      }),
    )
    await within(refused).findByText('That key’s role is higher than yours')
  })

  it('names roles, prefixes and days', () => {
    assert.deepEqual(keyRoles('admin'), [
      'developer',
      'tester',
      'manager',
      'admin',
    ])
    assert.deepEqual(keyRoles('tester'), ['tester'])
    assert.equal(roleWord('manager'), 'Manager')
    assert.equal(keyPrefix(keysFixture()[2]!), undefined)
    assert.equal(day(Date.now()), 'Today')
    assert.equal(day(Date.UTC(2020, 0, 2, 12)), '2020-01-02')
    assert.deepEqual(listOf(' a, ,b '), ['a', 'b'])
    assert.equal(isHttps('https://x.test'), true)
    assert.equal(isHttps('http://x.test'), false)
  })
})
