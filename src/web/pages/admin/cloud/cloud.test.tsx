import assert from 'node:assert/strict'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import type { CloudAccountView } from '../../../../shared/api/cloud.js'
import {
  crumbs,
  doAccount,
  heading,
  held,
  nomacAccount,
  NOW,
  openAdmin,
  recorder,
  requested,
  sessionWithout,
  text,
} from '../../../test/admin.js'
import { until } from '../../../test/render.js'
import { checkStatus, checkWords, credit } from './Cloud.js'

afterEach(() => cleanup())

const ACCOUNTS = '/api/v2/cloud/accounts'

const failing = (
  id: string,
  state: 'refused' | 'timeout' | 'unavailable' | 'error',
  message: string,
): CloudAccountView =>
  doAccount({
    id,
    name: `Account ${id}`,
    adminKeyed: false,
    check: { state, checkedAt: NOW - 3 * 3_600_000, message },
  })

const card = (name: string): HTMLElement => screen.getByRole('region', { name })

describe('Cloud', () => {
  it('shows each account’s provider, id, keying and stored check, without asking the providers again', async () => {
    const app = openAdmin('/cloud', {
      [ACCOUNTS]: [
        doAccount(),
        nomacAccount(),
        doAccount({ id: 'do-new', name: 'Fresh', check: undefined }),
        failing('do-staging', 'refused', 'Unable to authenticate you.'),
        failing('do-slow', 'timeout', 'No answer in 10 s'),
        failing('do-down', 'unavailable', 'DigitalOcean answered 503'),
        failing('do-odd', 'error', 'Unexpected answer'),
      ],
    })
    await heading('Cloud')
    assert.equal(crumbs().at(-1), 'Cloud')
    screen.getByText('The provider accounts cloud pools and hosts are made in.')
    const main = await screen.findByRole('region', { name: 'DigitalOcean' })
    assert.match(text(main), /DigitalOcean · do-main/)
    within(main).getByText(
      'Its key was entered by an administrator, so a host may be made in it.',
    )
    within(main).getByText('OK')
    const facts = [...main.querySelectorAll('dt, dd')].map(text)
    assert.deepEqual(facts, [
      'Account',
      'ops@example.test',
      'Droplet limit',
      '10',
      'Status',
      'active',
    ])
    within(main).getByText(/Checked/)
    assert.match(text(within(main).getByText(/Checked/)), /Checked 5m ago/)
    const nomac = card('NoMac')
    assert.deepEqual([...nomac.querySelectorAll('dt, dd')].map(text), [
      'Credit',
      '$42.50 (12.3 hours)',
      'Macs at a time',
      '1',
      'Spending',
      'Paused for the account',
    ])
    // NoMac accounts carry no keying notice.
    assert.equal(within(nomac).queryByText(/administrator/), null)
    const fresh = card('Fresh')
    within(fresh).getByText('Not checked yet.')
    within(fresh).getByText('Not checked yet', { selector: '.m-status' })
    const refused = card('Account do-staging')
    within(refused).getByText(
      'No administrator entered this key, so no host is made in it until one replaces it.',
    )
    within(refused).getByText('Key refused', { selector: '.m-banner__title' })
    within(refused).getByText('Unable to authenticate you.')
    assert.match(text(refused), /Checked 3h ago/)
    within(card('Account do-slow')).getByText('No answer', {
      selector: '.m-banner__title',
    })
    within(card('Account do-slow')).getByText('No answer in 10 s')
    within(card('Account do-down')).getByText('Unavailable', {
      selector: '.m-banner__title',
    })
    within(card('Account do-odd')).getByText('Check failed', {
      selector: '.m-banner__title',
    })
    within(card('Account do-odd')).getByText('Unexpected answer')
    // A manager has every action.
    within(main).getByRole('button', { name: 'Check DigitalOcean' })
    within(main).getByRole('button', {
      name: 'Replace the key of DigitalOcean',
    })
    within(main).getByRole('button', { name: 'Remove DigitalOcean' })
    screen.getByRole('button', { name: 'Add account' })
    assert.ok(app.node.requests.every((request) => !request.includes('/check')))
  })

  it('names states and credit in words', () => {
    assert.equal(checkStatus(undefined), 'unchecked')
    assert.equal(checkStatus(doAccount().check), 'ok')
    assert.equal(checkStatus(failing('x', 'timeout', '').check), 'noanswer')
    assert.equal(checkWords(undefined), 'not checked')
    assert.equal(checkWords(doAccount().check), 'OK')
    assert.equal(checkWords(failing('x', 'error', '').check), 'Check failed')
    assert.equal(credit(3, 1800), '$3.00 (0.5 hours)')
  })

  it('says when there are no accounts', async () => {
    openAdmin('/cloud', { [ACCOUNTS]: [] })
    await screen.findByRole('heading', { name: 'No cloud accounts yet.' })
    screen.getByText(
      'Add a DigitalOcean or NoMac account to make pools and a host in.',
    )
  })

  it('shows a skeleton while loading, and a failed read with Retry', async () => {
    const slow = held(200, [doAccount()])
    const app = openAdmin('/cloud', { [ACCOUNTS]: slow.reply })
    await heading('Cloud')
    screen.getByLabelText('Loading the cloud accounts')
    slow.release()
    await screen.findByRole('region', { name: 'DigitalOcean' })
    cleanup()
    const failed = openAdmin('/cloud', {
      [ACCOUNTS]: { status: 500, body: { error: 'Database locked' } },
    })
    await screen.findByText('The cloud accounts could not be read')
    screen.getByText('Database locked')
    failed.node.set(ACCOUNTS, [doAccount()])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('region', { name: 'DigitalOcean' })
    assert.ok(app.node.requests.includes(`GET ${ACCOUNTS}`))
  })

  it('hides the key and remove actions without settings.change, keeping Check', async () => {
    openAdmin(
      '/cloud',
      { [ACCOUNTS]: [doAccount()] },
      'manager',
      sessionWithout('manager', ['settings.change']),
    )
    const main = await screen.findByRole('region', { name: 'DigitalOcean' })
    within(main).getByRole('button', { name: 'Check DigitalOcean' })
    assert.equal(within(main).queryByRole('button', { name: /Replace/ }), null)
    assert.equal(within(main).queryByRole('button', { name: /Remove/ }), null)
    assert.equal(screen.queryByRole('button', { name: 'Add account' }), null)
    cleanup()
    // Without settings.read there are no actions at all (and no page).
    openAdmin('/cloud', { [ACCOUNTS]: [doAccount()] }, 'developer')
    await screen.findByText(/Cloud is for/)
  })

  it('checks an account again and shows what the provider said; a failure stays in the card', async () => {
    const answer = held(200, failing('do-main', 'refused', 'Token revoked'))
    const app = openAdmin('/cloud', {
      [ACCOUNTS]: [doAccount()],
      'POST /api/v2/cloud/accounts/do-main/check': answer.reply,
    })
    const main = await screen.findByRole('region', { name: 'DigitalOcean' })
    const button = within(main).getByRole('button', {
      name: 'Check DigitalOcean',
    })
    fireEvent.click(button)
    await requested(app, 'POST /api/v2/cloud/accounts/do-main/check')
    assert.equal(button.getAttribute('aria-busy'), 'true')
    answer.release()
    const updated = await screen.findByRole('region', {
      name: 'Account do-main',
    })
    within(updated).getByText('Token revoked')
    await screen.findByText('Account do-main checked: Key refused')
    app.node.set('POST /api/v2/cloud/accounts/do-main/check', {
      status: 404,
      body: { error: 'No such cloud account' },
    })
    fireEvent.click(
      within(updated).getByRole('button', { name: 'Check Account do-main' }),
    )
    await within(updated).findByText('No such cloud account')
  })

  it('replaces a key in a form sheet: required, a refusal kept in the sheet, then the card updated', async () => {
    const put = recorder((_body, n) =>
      n === 1
        ? {
            status: 403,
            body: { error: 'Changing the host’s account needs hosts.change' },
          }
        : {
            status: 200,
            body: doAccount({
              id: 'do-staging',
              name: 'Staging',
              adminKeyed: true,
            }),
          },
    )
    openAdmin('/cloud', {
      [ACCOUNTS]: [
        doAccount({ id: 'do-staging', name: 'Staging', adminKeyed: false }),
      ],
      'PUT /api/v2/cloud/accounts/do-staging/key': put.reply,
    })
    const staging = await screen.findByRole('region', { name: 'Staging' })
    within(staging).getByText(/No administrator entered this key/)
    fireEvent.click(
      within(staging).getByRole('button', {
        name: 'Replace the key of Staging',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Replace the key of Staging',
    })
    within(sheet).getByText(/never shown again/)
    const field = within(sheet).getByLabelText(
      'New API key',
    ) as HTMLInputElement
    assert.equal(field.type, 'password')
    assert.equal(field.getAttribute('autocomplete'), 'off')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Replace key' }))
    await within(sheet).findByText('Enter the new API key.')
    assert.equal(put.bodies.length, 0)
    fireEvent.change(field, { target: { value: ' dop_v1_new ' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Replace key' }))
    await within(sheet).findByText(
      'Changing the host’s account needs hosts.change',
    )
    assert.deepEqual(put.bodies, [{ key: 'dop_v1_new' }])
    assert.equal(field.value, ' dop_v1_new ')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Replace key' }))
    await screen.findByText('The key of Staging is replaced')
    await until(() => screen.queryByRole('dialog') == null, 'the sheet closes')
    within(card('Staging')).getByText(
      'Its key was entered by an administrator, so a host may be made in it.',
    )
  })

  it('removes an account after a tier-2 confirm; Keep it backs out; a refusal shows in its card', async () => {
    const answer = held(200, null)
    const app = openAdmin('/cloud', {
      [ACCOUNTS]: [doAccount(), nomacAccount()],
      'DELETE /api/v2/cloud/accounts/do-main': answer.reply,
      'DELETE /api/v2/cloud/accounts/nomac-1': {
        status: 400,
        body: { error: 'The pool mac-pool uses this account' },
      },
    })
    const main = await screen.findByRole('region', { name: 'DigitalOcean' })
    fireEvent.click(
      within(main).getByRole('button', { name: 'Remove DigitalOcean' }),
    )
    let alert = await screen.findByRole('alertdialog', {
      name: 'Remove DigitalOcean?',
    })
    within(alert).getByText(/Mason forgets its key/)
    fireEvent.click(within(alert).getByRole('button', { name: 'Keep it' }))
    await until(() => screen.queryByRole('alertdialog') == null)
    assert.ok(
      !app.node.requests.includes('DELETE /api/v2/cloud/accounts/do-main'),
    )
    fireEvent.click(
      within(main).getByRole('button', { name: 'Remove DigitalOcean' }),
    )
    alert = await screen.findByRole('alertdialog', {
      name: 'Remove DigitalOcean?',
    })
    const confirm = within(alert).getByRole('button', { name: 'Remove' })
    assert.ok(confirm.className.includes('m-btn--danger-filled'))
    fireEvent.click(confirm)
    await requested(app, 'DELETE /api/v2/cloud/accounts/do-main')
    assert.equal(confirm.getAttribute('aria-busy'), 'true')
    answer.release()
    await screen.findByText('DigitalOcean removed')
    await until(
      () => screen.queryByRole('region', { name: 'DigitalOcean' }) == null,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove NoMac' }))
    alert = await screen.findByRole('alertdialog', { name: 'Remove NoMac?' })
    fireEvent.click(within(alert).getByRole('button', { name: 'Remove' }))
    await within(card('NoMac')).findByText(
      'The pool mac-pool uses this account',
    )
    // Asking again clears the old refusal.
    fireEvent.click(screen.getByRole('button', { name: 'Remove NoMac' }))
    await screen.findByRole('alertdialog', { name: 'Remove NoMac?' })
    assert.equal(
      within(card('NoMac')).queryByText('The pool mac-pool uses this account'),
      null,
    )
  })

  it('adds an account in a form sheet: provider, name and key, checked first; a refusal stays', async () => {
    const post = recorder((_body, n) =>
      n === 1
        ? { status: 400, body: { error: 'NoMac refused the key' } }
        : {
            status: 201,
            body: nomacAccount({
              id: 'mac-2',
              name: 'Mac farm',
              check: undefined,
            }),
          },
    )
    openAdmin('/cloud', {
      [ACCOUNTS]: [],
      'POST /api/v2/cloud/accounts': post.reply,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }))
    const sheet = await screen.findByRole('dialog', {
      name: 'Add a cloud account',
    })
    within(sheet).getByText(/nmk_…/)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add account' }))
    await within(sheet).findByText('Enter a name.')
    within(sheet).getByText('Enter the API key.')
    const provider = within(sheet).getByLabelText(
      'Provider',
    ) as HTMLSelectElement
    assert.deepEqual(
      [...provider.options].map((option) => option.text),
      ['DigitalOcean', 'NoMac'],
    )
    const name = within(sheet).getByLabelText('Name') as HTMLInputElement
    assert.equal(name.placeholder, 'DigitalOcean')
    fireEvent.change(provider, { target: { value: 'nomac' } })
    assert.equal(name.placeholder, 'NoMac')
    fireEvent.change(name, { target: { value: ' Mac farm ' } })
    const key = within(sheet).getByLabelText('API key') as HTMLInputElement
    assert.equal(key.type, 'password')
    fireEvent.change(key, { target: { value: 'nmk_secret' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add account' }))
    await within(sheet).findByText('NoMac refused the key')
    assert.deepEqual(post.bodies, [
      { provider: 'nomac', name: 'Mac farm', key: 'nmk_secret' },
    ])
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add account' }))
    await screen.findByText('Mac farm added')
    const added = await screen.findByRole('region', { name: 'Mac farm' })
    within(added).getByText('Not checked yet.')
    assert.equal(screen.queryByText('No cloud accounts yet.'), null)
  })

  it('asks before closing an add sheet with changes', async () => {
    openAdmin('/cloud', { [ACCOUNTS]: [] })
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }))
    const sheet = await screen.findByRole('dialog', {
      name: 'Add a cloud account',
    })
    fireEvent.change(within(sheet).getByLabelText('Name'), {
      target: { value: 'Half typed' },
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    const discard = await screen.findByRole('alertdialog', {
      name: 'Discard your changes?',
    })
    fireEvent.click(within(discard).getByRole('button', { name: 'Discard' }))
    await until(() => screen.queryByRole('dialog') == null)
    // Opened again, it starts empty.
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    const again = await screen.findByRole('dialog', {
      name: 'Add a cloud account',
    })
    assert.equal(
      (within(again).getByLabelText('Name') as HTMLInputElement).value,
      '',
    )
  })
})
