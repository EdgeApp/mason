import assert from 'node:assert/strict'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { absoluteTime } from '../../../../shared/format.js'
import { recording, sent, text } from '../../../test/projects.js'
import {
  DAY,
  never,
  NOW,
  openPeople,
  PEOPLE,
  peopleFixture,
  person,
} from '../../../test/people.js'
import { until } from '../../../test/render.js'
import { COPY_NOW, inviteText } from './InviteSheet.js'
import { matches } from './People.js'

afterEach(() => cleanup())
beforeEach(() => {
  sent.clear()
  sessionStorage.clear()
})

const row = (id: number): HTMLElement =>
  document.querySelector<HTMLElement>(`tr[data-person="${id}"]`)!

const cells = (id: number): string[] =>
  [...row(id).querySelectorAll('td')].map(text)

const table = async (): Promise<HTMLElement> => await screen.findByRole('table')

const type = (field: HTMLElement, value: string): void => {
  fireEvent.change(field, { target: { value } })
}

/** Opens a row's edit block. */
const edit = async (name: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${name}` }))
  return await screen.findByRole('form', { name: `Editing ${name}` })
}

/** Adds an address through the sheet. */
const addEmail = async (email: string): Promise<HTMLElement> => {
  fireEvent.click(screen.getByRole('button', { name: 'Add an email address' }))
  const sheet = await screen.findByRole('dialog', {
    name: 'Add an email address',
  })
  type(within(sheet).getByLabelText('Email address'), email)
  fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
  return sheet
}

const linesOf = (alert: HTMLElement): string[] =>
  [...alert.querySelectorAll('.m-people__change')].map(text)

describe('People', () => {
  it('lists everyone with their addresses, role, invitation and password to an administrator', async () => {
    openPeople()
    await screen.findByRole('heading', { level: 1, name: 'People' })
    screen.getByText(
      'Who signs in, with which email addresses, and what their role lets them do.',
    )
    screen.getByRole('button', { name: 'Add a person' })
    await table()
    assert.deepEqual(
      [
        ...screen
          .getByRole('group', { name: 'Role' })
          .querySelectorAll('button'),
      ].map(text),
      ['Everyone 4', 'Admins 1', 'Managers 1', 'Developers 1', 'Testers 1'],
    )
    assert.deepEqual(cells(1).slice(0, 4), [
      'PPaul Puey',
      'paul',
      'paul@example.test',
      'Admin',
    ])
    const ada = cells(2)
    assert.equal(ada[1], '—')
    assert.equal(ada[2], 'ada@example.testada.l@example.testUnconfirmed')
    assert.equal(
      ada[4],
      `InvitedInvite againExpires ${absoluteTime(NOW + 5 * DAY, Date.now())}`,
    )
    assert.equal(ada[5], 'No passwordSet password')
    within(row(2)).getByRole('button', { name: 'Invite Ada Lovelace again' })
    within(row(2)).getByRole('button', { name: 'Set Ada Lovelace’s password' })
    within(row(3)).getByRole('button', { name: 'Invite Sam Rivera' })
    within(row(3)).getByRole('button', {
      name: 'Change Sam Rivera’s password',
    })
    within(row(3)).getByRole('button', { name: 'Remove Sam Rivera' })
    within(row(3)).getByRole('button', { name: 'Edit Sam Rivera' })
    // A disabled person can be edited or removed, not invited or given a password.
    assert.match(cells(4)[0]!, /Olive OldDisabled/)
    assert.equal(within(row(4)).queryByRole('button', { name: /Invite/ }), null)
    assert.equal(
      within(row(4)).queryByRole('button', { name: /password/ }),
      null,
    )
    within(row(4)).getByRole('button', { name: 'Remove Olive Old' })
  })

  it('shows a manager a read-only table, with Edit on their own row only', async () => {
    openPeople('manager')
    await table()
    assert.equal(screen.queryByRole('button', { name: 'Add a person' }), null)
    within(row(1)).getByRole('button', { name: 'Edit Paul Puey' })
    for (const id of [2, 3, 4])
      assert.equal(within(row(id)).queryAllByRole('button').length, 0)
    assert.equal(cells(2)[4]!.startsWith('Invited'), true)
    assert.equal(cells(3)[5], 'Password set')
  })

  it('shows a skeleton while loading, then the table', async () => {
    openPeople('admin', { [PEOPLE]: never })
    await screen.findByRole('status', { name: 'Loading people' })
    assert.equal(screen.queryByRole('table'), null)
  })

  it('says when nobody is there yet', async () => {
    openPeople('admin', { [PEOPLE]: [] })
    await screen.findByRole('heading', { name: 'Nobody yet.' })
  })

  it('offers Retry when the list cannot be read', async () => {
    const app = openPeople('admin', {
      [PEOPLE]: { status: 500, body: { error: 'Database busy' } },
    })
    await screen.findByRole('heading', { name: 'People could not be read' })
    screen.getByText('Database busy')
    app.node.set(PEOPLE, peopleFixture())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await table()
  })

  it('narrows by role and by a search of names, usernames and addresses', async () => {
    openPeople()
    await table()
    const pills = screen.getByRole('group', { name: 'Role' })
    fireEvent.click(within(pills).getByRole('button', { name: /^Developers/ }))
    assert.deepEqual(
      [...document.querySelectorAll('tr[data-person]')].map((tr) =>
        tr.getAttribute('data-person'),
      ),
      ['2'],
    )
    fireEvent.click(within(pills).getByRole('button', { name: /^Everyone/ }))
    type(screen.getByRole('searchbox', { name: 'Find a person' }), 'SAM@')
    assert.deepEqual(
      [...document.querySelectorAll('tr[data-person]')].map((tr) =>
        tr.getAttribute('data-person'),
      ),
      ['3'],
    )
    type(screen.getByRole('searchbox', { name: 'Find a person' }), 'nobody')
    await screen.findByRole('heading', { name: 'Nothing matches.' })
    fireEvent.click(screen.getByRole('button', { name: 'Show everyone' }))
    await until(
      () => document.querySelectorAll('tr[data-person]').length === 4,
      'everyone',
    )
    assert.equal(
      (
        screen.getByRole('searchbox', {
          name: 'Find a person',
        }) as HTMLInputElement
      ).value,
      '',
    )
  })

  it('matches a person by name, username or address, ignoring case', () => {
    const sam = peopleFixture()[2]!
    assert.equal(matches(sam, ''), true)
    assert.equal(matches(sam, ' rivera '), true)
    assert.equal(matches(sam, 'SAM'), true)
    assert.equal(matches(sam, 'example.test'), true)
    assert.equal(matches(sam, 'ada'), false)
    assert.equal(matches(person(9, 'No Name'), 'name'), true)
  })
})

describe('People’s edit block', () => {
  it('lets an administrator change everything, listing each change before saving', async () => {
    const app = openPeople('admin', {
      [`PUT ${PEOPLE}/2`]: recording(`PUT ${PEOPLE}/2`, 200, {}),
    })
    const block = await edit('Ada Lovelace')
    // Other rows wait while one is edited.
    assert.equal(
      (
        within(row(3)).getByRole('button', {
          name: 'Edit Sam Rivera',
        }) as HTMLButtonElement
      ).disabled,
      true,
    )
    within(block).getByText('Nothing changed yet')
    const save = within(block).getByRole('button', { name: 'Save changes' })
    assert.equal((save as HTMLButtonElement).disabled, true)
    type(within(block).getByLabelText('Full name'), 'Ada L.')
    type(within(block).getByLabelText(/^Username/), 'ada')
    fireEvent.change(within(block).getByLabelText('Role'), {
      target: { value: 'manager' },
    })
    // Confirm, then remove one address; Undo brings one back.
    fireEvent.click(
      within(block).getByRole('button', { name: 'Confirm ada.l@example.test' }),
    )
    within(block).getByText('Confirmed on Save')
    fireEvent.click(
      within(block).getByRole('button', { name: 'Remove ada@example.test' }),
    )
    const removed = block.querySelector('li[data-email="ada@example.test"]')!
    assert.ok(removed.classList.contains('m-people__email--removed'))
    within(removed as HTMLElement).getByText('removed on Save')
    fireEvent.click(
      within(block).getByRole('button', { name: 'Keep ada@example.test' }),
    )
    assert.ok(!removed.classList.contains('m-people__email--removed'))
    fireEvent.click(
      within(block).getByRole('button', { name: 'Remove ada@example.test' }),
    )
    await addEmail('Ada@New.example.test')
    const added = block.querySelector('li[data-email="ada@new.example.test"]')!
    assert.ok(added.classList.contains('m-people__email--added'))
    within(added as HTMLElement).getByText('added on Save')
    // An administrator's address is confirmed: no tag.
    assert.equal(within(added as HTMLElement).queryByText('Unconfirmed'), null)

    fireEvent.click(within(block).getByRole('button', { name: 'Save changes' }))
    const alert = await screen.findByRole('alertdialog', {
      name: 'Save changes to Ada Lovelace?',
    })
    assert.deepEqual(linesOf(alert), [
      'Name: Ada Lovelace → Ada L.',
      'Username: — → ada',
      'Role: developer → manager',
      'Email added: ada@new.example.test',
      'Email removed: ada@example.test',
      'Email confirmed: ada.l@example.test',
    ])
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }))
    await until(() => screen.queryByRole('alertdialog') == null, 'cancelled')
    assert.ok(!app.node.requests.includes(`PUT ${PEOPLE}/2`))
    fireEvent.click(within(block).getByRole('button', { name: 'Save changes' }))
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', {
          name: 'Save changes to Ada Lovelace?',
        }),
      ).getByRole('button', { name: 'Save' }),
    )
    await screen.findByText('Ada L. saved')
    assert.deepEqual(sent.get(`PUT ${PEOPLE}/2`), {
      name: 'Ada L.',
      username: 'ada',
      role: 'manager',
      emails: ['ada.l@example.test', 'ada@new.example.test'],
      confirmEmails: ['ada.l@example.test'],
    })
    await until(
      () =>
        screen.queryByRole('form', { name: 'Editing Ada Lovelace' }) == null,
      'the row back',
    )
    assert.equal(
      app.node.requests.filter((request) => request === `GET ${PEOPLE}`).length,
      2,
    )
  })

  it('clears a username, drops a new address with ×, and re-adds a removed one', async () => {
    openPeople('admin', {
      [`PUT ${PEOPLE}/3`]: recording(`PUT ${PEOPLE}/3`, 200, {}),
    })
    const block = await edit('Sam Rivera')
    type(within(block).getByLabelText(/^Username/), '')
    await addEmail('extra@example.test')
    fireEvent.click(
      within(block).getByRole('button', { name: 'Remove extra@example.test' }),
    )
    assert.equal(
      block.querySelector('li[data-email="extra@example.test"]'),
      null,
    )
    fireEvent.click(
      within(block).getByRole('button', { name: 'Remove sam@example.test' }),
    )
    await addEmail('sam@example.test')
    assert.ok(
      !block
        .querySelector('li[data-email="sam@example.test"]')!
        .classList.contains('m-people__email--removed'),
    )
    fireEvent.click(within(block).getByRole('button', { name: 'Save changes' }))
    const alert = await screen.findByRole('alertdialog', {
      name: 'Save changes to Sam Rivera?',
    })
    assert.deepEqual(linesOf(alert), ['Username: sam → —'])
    fireEvent.click(within(alert).getByRole('button', { name: 'Save' }))
    await screen.findByText('Sam Rivera saved')
    assert.deepEqual(sent.get(`PUT ${PEOPLE}/3`), { username: null })
  })

  it('refuses an address that is not one or is already theirs, in the sheet', async () => {
    openPeople()
    const block = await edit('Ada Lovelace')
    const sheet = await addEmail('')
    within(sheet).getByText('Enter an email address')
    type(within(sheet).getByLabelText('Email address'), 'ADA@example.test')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    within(sheet).getByText('They already have that address')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    const discard = await screen.findByRole('alertdialog', {
      name: 'Discard your changes?',
    })
    fireEvent.click(within(discard).getByRole('button', { name: 'Discard' }))
    await until(() => screen.queryByRole('dialog') == null, 'closed')
    assert.equal(block.querySelectorAll('li[data-email]').length, 2)
  })

  it('checks the name and username before asking', async () => {
    openPeople()
    const block = await edit('Sam Rivera')
    type(within(block).getByLabelText('Full name'), '  ')
    type(within(block).getByLabelText(/^Username/), '-bad name')
    fireEvent.click(within(block).getByRole('button', { name: 'Save changes' }))
    within(block).getByText('Enter their name')
    within(block).getByText(
      'A username is 1–64 letters, digits, dots, dashes or underscores',
    )
    assert.equal(screen.queryByRole('alertdialog'), null)
  })

  it('keeps the changes and says why when the save is refused', async () => {
    openPeople('admin', {
      [`PUT ${PEOPLE}/3`]: {
        status: 409,
        body: { error: 'That username is taken' },
      },
    })
    const block = await edit('Sam Rivera')
    type(within(block).getByLabelText(/^Username/), 'ada')
    fireEvent.click(within(block).getByRole('button', { name: 'Save changes' }))
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', {
          name: 'Save changes to Sam Rivera?',
        }),
      ).getByRole('button', { name: 'Save' }),
    )
    const error = await within(block).findByText('That username is taken')
    await until(
      () => document.activeElement === error.closest('p'),
      'focus on the error',
    )
    assert.equal(
      (within(block).getByLabelText(/^Username/) as HTMLInputElement).value,
      'ada',
    )
    assert.equal(screen.queryByRole('alertdialog'), null)
  })

  it('cancels with Escape or Cancel, keeping nothing', async () => {
    openPeople()
    let block = await edit('Sam Rivera')
    type(within(block).getByLabelText('Full name'), 'Changed')
    fireEvent.keyDown(within(block).getByLabelText('Full name'), {
      key: 'Escape',
    })
    await until(() => row(3) != null, 'the row back')
    assert.equal(cells(3)[0], 'SSam Rivera')
    block = await edit('Sam Rivera')
    fireEvent.keyDown(block, { key: 'Enter' })
    fireEvent.click(within(block).getByRole('button', { name: 'Cancel' }))
    await until(() => row(3) != null, 'the row back again')
  })

  it('lets a person change only their own name and addresses, which wait for an administrator', async () => {
    openPeople('developer', {
      [`PUT ${PEOPLE}/1`]: recording(`PUT ${PEOPLE}/1`, 200, {}),
    })
    // A developer reaches People only by its 403; a manager reads it.
    await screen.findByRole('heading', { level: 1 })
    cleanup()
    openPeople('manager', {
      [`PUT ${PEOPLE}/1`]: recording(`PUT ${PEOPLE}/1`, 200, {}),
    })
    const block = await edit('Paul Puey')
    assert.equal(within(block).queryByLabelText(/^Username/), null)
    assert.equal(within(block).queryByLabelText('Role'), null)
    within(block).getByText(
      'An address you add signs you in once an administrator confirms it.',
    )
    await addEmail('me@example.test')
    const added = block.querySelector('li[data-email="me@example.test"]')!
    within(added as HTMLElement).getByText('Unconfirmed')
    assert.equal(
      within(added as HTMLElement).queryByRole('button', { name: /Confirm/ }),
      null,
    )
    fireEvent.click(within(block).getByRole('button', { name: 'Save changes' }))
    const alert = await screen.findByRole('alertdialog', {
      name: 'Save changes to Paul Puey?',
    })
    assert.deepEqual(linesOf(alert), ['Email added: me@example.test'])
    fireEvent.click(within(alert).getByRole('button', { name: 'Save' }))
    await screen.findByText('Paul Puey saved')
    assert.deepEqual(sent.get(`PUT ${PEOPLE}/1`), {
      emails: ['paul@example.test', 'me@example.test'],
    })
  })
})

describe('People’s overlays', () => {
  it('removes a person only after the confirm says what goes', async () => {
    const app = openPeople('admin', {
      [`DELETE ${PEOPLE}/3`]: { status: 200, body: null },
      [`DELETE ${PEOPLE}/1`]: {
        status: 409,
        body: { error: 'Mason needs one enabled administrator' },
      },
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove Sam Rivera' }),
    )
    const alert = await screen.findByRole('alertdialog', {
      name: 'Remove Sam Rivera?',
    })
    assert.deepEqual(linesOf(alert), [
      'Their email addresses, password, group memberships and invitation link go.',
      'Every API key they created is revoked.',
      'The account is disabled and kept for the audit history.',
    ])
    assert.ok(
      within(alert)
        .getByRole('button', { name: 'Remove' })
        .classList.contains('m-btn--danger-filled'),
    )
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }))
    await until(() => screen.queryByRole('alertdialog') == null, 'kept')
    assert.ok(!app.node.requests.includes(`DELETE ${PEOPLE}/3`))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sam Rivera' }))
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Remove Sam Rivera?' }),
      ).getByRole('button', { name: 'Remove' }),
    )
    await screen.findByText('Sam Rivera removed')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Paul Puey' }))
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Remove Paul Puey?' }),
      ).getByRole('button', { name: 'Remove' }),
    )
    const error = await screen.findByText(
      'Mason needs one enabled administrator',
    )
    assert.equal(error.closest('tr')!.previousElementSibling, row(1))
    // Editing the row clears its error.
    await edit('Paul Puey')
    assert.equal(
      screen.queryByText('Mason needs one enabled administrator'),
      null,
    )
  })

  it('makes an invitation link and shows it once, to copy', async () => {
    openPeople('admin', {
      [`POST ${PEOPLE}/3/invitation`]: recording(
        `POST ${PEOPLE}/3/invitation`,
        201,
        {
          url: 'https://mason.example.test/auth/invite#token',
          expiresAt: NOW + 7 * DAY,
        },
      ),
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Invite Sam Rivera' }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Invite Sam Rivera',
    })
    within(sheet).getByText(
      'A link, valid for a week, where Sam Rivera chooses a password. Mason sends no email: copy the link to them.',
    )
    assert.equal(
      within(sheet).queryByRole('button', { name: 'Revoke invitation' }),
      null,
    )
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Make the link' }),
    )
    await within(sheet).findByText(COPY_NOW)
    assert.equal(
      text(sheet.querySelector('.m-copy code')),
      'https://mason.example.test/auth/invite#token',
    )
    assert.deepEqual(sent.get(`POST ${PEOPLE}/3/invitation`), { days: 7 })
    await screen.findByText('Invitation link for Sam Rivera made')
    within(sheet).getByRole('button', { name: 'Revoke invitation' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }))
    await until(() => screen.queryByRole('dialog') == null, 'closed')
  })

  it('invites again, revokes, and says why either is refused', async () => {
    const app = openPeople('admin', {
      [`POST ${PEOPLE}/2/invitation`]: {
        status: 409,
        body: { error: 'A disabled person cannot be invited' },
      },
      [`DELETE ${PEOPLE}/2/invitation`]: {
        status: 500,
        body: { error: 'Busy' },
      },
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Invite Ada Lovelace again' }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Invite Ada Lovelace',
    })
    within(sheet).getByText(/The earlier link stops working\./)
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Make the link' }),
    )
    await within(sheet).findByText('A disabled person cannot be invited')
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Revoke invitation' }),
    )
    await within(sheet).findByText('Busy')
    app.node.set(`DELETE ${PEOPLE}/2/invitation`, { status: 200, body: null })
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Revoke invitation' }),
    )
    await screen.findByText('Ada Lovelace’s invitation revoked')
    await until(() => screen.queryByRole('dialog') == null, 'closed')
    fireEvent.click(screen.getByRole('button', { name: 'Invite Sam Rivera' }))
    fireEvent.click(
      within(
        await screen.findByRole('dialog', { name: 'Invite Sam Rivera' }),
      ).getByRole('button', { name: 'Cancel' }),
    )
    await until(() => screen.queryByRole('dialog') == null, 'cancelled')
  })

  it('words the invitation for someone with or without a username', () => {
    assert.equal(
      inviteText(person(5, 'Neo')),
      'A link, valid for a week, where Neo chooses a password (and a username if they have no confirmed email). Mason sends no email: copy the link to them.',
    )
  })

  it('sets a password from its client hash, after checking it in the browser', async () => {
    const app = openPeople('admin', {
      [`PUT ${PEOPLE}/2`]: recording(`PUT ${PEOPLE}/2`, 200, {}),
    })
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Set Ada Lovelace’s password',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Set Ada Lovelace’s password',
    })
    within(sheet).getByText(
      'Ada Lovelace signs in with it and their username or a confirmed email, on the host and the master. Their sessions end.',
    )
    within(sheet).getByText(
      'At least 8 characters with uppercase, lowercase and a number, or 17 characters or more. The browser hashes it; Mason never sees it.',
    )
    type(within(sheet).getByLabelText('Password'), 'short')
    type(within(sheet).getByLabelText('Confirm the password'), 'other')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set password' }))
    within(sheet).getByText(/Use at least 8 characters/)
    within(sheet).getByText('The passwords do not match.')
    type(within(sheet).getByLabelText('Password'), 'Correct horse 1')
    type(
      within(sheet).getByLabelText('Confirm the password'),
      'Correct horse 1',
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set password' }))
    await screen.findByText('Ada Lovelace’s password is set')
    assert.deepEqual(app.hasher.calls, ['new Correct horse 1'])
    const body = sent.get(`PUT ${PEOPLE}/2`) as {
      password: { clientHash: string; clientParameters: { memoryKiB: number } }
    }
    assert.equal(body.password.clientHash, 'new:Correct horse 1')
    assert.equal(body.password.clientParameters.memoryKiB, 32768)
    assert.deepEqual(Object.keys(body), ['password'])
  })

  it('keeps the password sheet open with the reason when hashing or saving fails', async () => {
    const app = openPeople('admin', {
      [`PUT ${PEOPLE}/3`]: { status: 400, body: { error: 'Weak parameters' } },
    })
    app.hasher.fail = 'This browser could not prepare the password'
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Change Sam Rivera’s password',
      }),
    )
    const sheet = await screen.findByRole('dialog', {
      name: 'Change Sam Rivera’s password',
    })
    type(within(sheet).getByLabelText('Password'), 'Correct horse 1')
    type(
      within(sheet).getByLabelText('Confirm the password'),
      'Correct horse 1',
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set password' }))
    await within(sheet).findByText(
      'This browser could not prepare the password',
    )
    delete app.hasher.fail
    fireEvent.click(within(sheet).getByRole('button', { name: 'Set password' }))
    await within(sheet).findByText('Weak parameters')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
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
