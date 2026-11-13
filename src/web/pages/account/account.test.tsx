import assert from 'node:assert/strict'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { resetAppearance } from '../../hooks/useAppearance.js'
import { APPEARANCE_KEY } from '../../theme/theme-boot.js'
import { recording, sent, text } from '../../test/projects.js'
import { ACCOUNT, never, openAccount } from '../../test/people.js'
import { until } from '../../test/render.js'

afterEach(() => cleanup())
beforeEach(() => {
  sent.clear()
  localStorage.clear()
  resetAppearance()
})

const PUT = 'PUT /api/v2/people/1'

const type = (field: HTMLElement, value: string): void => {
  fireEvent.change(field, { target: { value } })
}

/** The profile's form, once the account is read. */
const profile = async (): Promise<HTMLElement> =>
  (await screen.findByLabelText('Full name')).closest('form')!

const button = (name: string | RegExp): HTMLButtonElement =>
  screen.getByRole('button', { name }) as HTMLButtonElement

const linesOf = (alert: HTMLElement): string[] =>
  [...alert.querySelectorAll('.m-people__change')].map(text)

describe('Your account', () => {
  it('shows the profile, Appearance and Sign-in on the master', async () => {
    openAccount()
    await screen.findByRole('heading', { level: 1, name: 'Your account' })
    screen.getByText(
      'Your name and email addresses, how you sign in, and how Mason looks.',
    )
    const form = await profile()
    assert.equal(
      (within(form).getByLabelText('Full name') as HTMLInputElement).value,
      'Paul Puey',
    )
    const username = within(form).getByLabelText('Username') as HTMLInputElement
    assert.equal(username.value, 'paul')
    assert.equal(username.readOnly, true)
    within(form).getByText('Admin')
    within(
      form.querySelector<HTMLElement>(
        'li[data-email="paul@other.example.test"]',
      )!,
    ).getByText('Unconfirmed')
    within(form).getByText(
      'An address you add signs you in once an administrator confirms it.',
    )
    within(form).getByText('Nothing changed yet')
    assert.equal(
      within(form)
        .getByRole('button', { name: 'Save' })
        .hasAttribute('disabled'),
      true,
    )
    screen.getByText('Password set. Changing it ends your other sessions.')
    button('Change password')
    button('Sign out')
    assert.equal(screen.queryByText('Your account is read-only here'), null)
  })

  it('saves a new name and addresses after the confirm lists them', async () => {
    const app = openAccount({}, 'master', 'admin', {
      [PUT]: recording(PUT, 200, {}),
    })
    const form = await profile()
    type(within(form).getByLabelText('Full name'), 'Paul P.')
    fireEvent.click(
      within(form).getByRole('button', {
        name: 'Remove paul@other.example.test',
      }),
    )
    fireEvent.click(
      within(form).getByRole('button', { name: 'Add an email address' }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Add an email address',
    })
    type(within(sheet).getByLabelText('Email address'), 'me@example.test')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    await until(() => screen.queryByRole('dialog') == null, 'added')
    within(
      form.querySelector<HTMLElement>('li[data-email="me@example.test"]')!,
    ).getByText('Unconfirmed')
    within(form).getByText('3 changes to save')
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alertdialog', {
      name: 'Save changes to Paul Puey?',
    })
    assert.deepEqual(linesOf(alert), [
      'Name: Paul Puey → Paul P.',
      'Email added: me@example.test',
      'Email removed: paul@other.example.test',
    ])
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }))
    await until(() => screen.queryByRole('alertdialog') == null, 'cancelled')
    assert.ok(!app.node.requests.includes(PUT))
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    app.node.set(ACCOUNT, {
      id: 1,
      name: 'Paul P.',
      role: 'admin',
      username: 'paul',
      password: true,
      emails: [
        { email: 'paul@example.test', confirmed: true },
        { email: 'me@example.test', confirmed: false },
      ],
      editable: true,
      passwordHere: true,
    })
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', {
          name: 'Save changes to Paul Puey?',
        }),
      ).getByRole('button', { name: 'Save' }),
    )
    await screen.findByText('Your account is saved')
    assert.deepEqual(sent.get(PUT), {
      name: 'Paul P.',
      emails: ['paul@example.test', 'me@example.test'],
    })
    await screen.findByDisplayValue('Paul P.')
    await screen.findByText('Nothing changed yet')
  })

  it('needs a name, and keeps the changes with the reason when the save is refused', async () => {
    openAccount({}, 'master', 'admin', {
      [PUT]: { status: 409, body: { error: 'That address is someone else’s' } },
    })
    const form = await profile()
    type(within(form).getByLabelText('Full name'), ' ')
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    within(form).getByText('Enter their name')
    assert.equal(screen.queryByRole('alertdialog'), null)
    type(within(form).getByLabelText('Full name'), 'Paul')
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Save',
      }),
    )
    const error = await within(form).findByText(
      'That address is someone else’s',
    )
    await until(() => document.activeElement === error.closest('p'), 'focus')
    assert.equal(
      (within(form).getByLabelText('Full name') as HTMLInputElement).value,
      'Paul',
    )
  })

  it('switches Appearance at once and keeps it in this browser', async () => {
    openAccount()
    const group = await screen.findByRole('group', { name: 'Appearance' })
    const pressed = (): string[] =>
      [...group.querySelectorAll('button[aria-pressed="true"]')].map(text)
    assert.deepEqual(pressed(), ['Dark'])
    fireEvent.click(within(group).getByRole('button', { name: 'Light' }))
    assert.deepEqual(pressed(), ['Light'])
    assert.equal(localStorage.getItem(APPEARANCE_KEY), 'light')
    assert.equal(document.documentElement.dataset.theme, 'light')
    fireEvent.click(within(group).getByRole('button', { name: 'Match system' }))
    assert.equal(localStorage.getItem(APPEARANCE_KEY), 'system')
    screen.getByText('Dark is Mason’s default. Saved in this browser.')
  })

  it('changes the password from its client hash, then loads the page again to sign in', async () => {
    const app = openAccount({}, 'master', 'admin', {
      [PUT]: recording(PUT, 200, {}),
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Change password' }),
    )
    const sheet = await screen.findByRole('dialog', { name: 'Your password' })
    within(sheet).getByText(
      'You sign in with it and your username or a confirmed email, on the host and the master. Your other sessions end, and you sign in again.',
    )
    type(within(sheet).getByLabelText('Password'), 'Correct horse 1')
    type(
      within(sheet).getByLabelText('Confirm the password'),
      'Correct horse 2',
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set password' }))
    within(sheet).getByText('The passwords do not match.')
    type(
      within(sheet).getByLabelText('Confirm the password'),
      'Correct horse 1',
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set password' }))
    await screen.findByText('Your password is set')
    assert.ok(app.left.includes('/account'))
    assert.equal(
      (sent.get(PUT) as { password: { clientHash: string } }).password
        .clientHash,
      'new:Correct horse 1',
    )
  })

  it('offers Set password to someone without one', async () => {
    openAccount({ password: false })
    await screen.findByText('No password set.')
    button('Set password')
  })

  it('signs out through the session on the master', async () => {
    const app = openAccount({}, 'master', 'admin', {
      'DELETE /api/v2/session': { status: 200, body: null },
    })
    await profile()
    fireEvent.click(button('Sign out'))
    await until(() => app.left.includes('/sign-in?signed_out=1'), 'sign-in')
    assert.ok(app.node.requests.includes('DELETE /api/v2/session'))
  })

  it('leaves for the host’s sign-in even when ending the session fails', async () => {
    const host = openAccount({}, 'host', 'tester', {
      'DELETE /api/v2/session': { status: 500, body: { error: 'Busy' } },
    })
    await profile()
    fireEvent.click(button('Sign out'))
    await until(
      () => host.left.includes('/auth/login?signed_out=1'),
      'the host’s sign-in',
    )
  })

  it('is read-only on a host that cannot reach its master', async () => {
    openAccount({ editable: false, role: 'tester' }, 'host', 'tester')
    await screen.findByText('Your account is read-only here')
    screen.getByText(
      'The host cannot reach the master right now, so your account cannot be changed. Try again shortly.',
    )
    const form = await profile()
    assert.equal(
      (within(form).getByLabelText('Full name') as HTMLInputElement).readOnly,
      true,
    )
    assert.equal(within(form).queryByRole('button', { name: /^Remove / }), null)
    assert.equal(
      (
        within(form).getByRole('button', {
          name: 'Add an email address',
        }) as HTMLButtonElement
      ).disabled,
      true,
    )
    assert.equal(
      (within(form).getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
      true,
    )
    within(form).getByText('Read-only while the master is unreachable')
    within(form).getByText('Tester')
    assert.equal(button('Change password').disabled, true)
    assert.equal(button('Sign out').disabled, false)
  })

  it('sends a host’s non-tester to the master for their password', async () => {
    openAccount(
      { passwordHere: false, role: 'developer', username: undefined },
      'host',
      'developer',
    )
    await screen.findByText('Change your password on the master.')
    assert.equal(screen.queryByRole('button', { name: /password/ }), null)
    const form = await profile()
    assert.equal(
      (within(form).getByLabelText('Username') as HTMLInputElement).value,
      '—',
    )
  })

  it('shows skeletons while loading, and Retry when the account cannot be read', async () => {
    openAccount({}, 'master', 'admin', { [ACCOUNT]: never })
    await screen.findByRole('status', { name: 'Loading your account' })
    screen.getByRole('status', { name: 'Loading your sign-in' })
    button('Sign out')
    cleanup()
    const app = openAccount({}, 'master', 'admin', {
      [ACCOUNT]: { status: 503, body: { error: 'The master is away' } },
    })
    await screen.findByRole('heading', {
      name: 'Your account could not be read',
    })
    screen.getByText('The master is away')
    screen.getByRole('group', { name: 'Appearance' })
    button('Sign out')
    app.node.set(ACCOUNT, {
      id: 1,
      name: 'Paul Puey',
      role: 'admin',
      password: true,
      emails: [],
      editable: true,
      passwordHere: true,
    })
    fireEvent.click(button('Retry'))
    await screen.findByText('No email addresses.')
  })
})
