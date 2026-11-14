import assert from 'node:assert/strict'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { recording, sent, text } from '../../../test/projects.js'
import { DAY, NOW, openPeople, PEOPLE, person } from '../../../test/people.js'
import { until } from '../../../test/render.js'
import { draftKey } from '../../../ui/LargeSheet.js'
import {
  ADD_DRAFT,
  addProblems,
  NEEDS_SIGN_IN,
  type AddDraft,
} from './AddPerson.js'
import { COPY_NOW } from './InviteSheet.js'
import {
  changesOf,
  confirmingEmail,
  draftOf,
  emailProblem,
  usernameProblem,
  withEmail,
  withoutEmail,
} from './personDraft.js'

afterEach(() => cleanup())
beforeEach(() => {
  sent.clear()
  sessionStorage.clear()
})

const type = (field: HTMLElement, value: string): void => {
  fireEvent.change(field, { target: { value } })
}

const open = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Add a person' }))
  return await screen.findByRole('dialog', { name: 'Add a person' })
}

const added = (fields: Record<string, unknown> = {}): unknown => ({
  ...person(9, 'Grace Hopper', {
    role: 'developer',
    emails: [{ email: 'grace@example.test', confirmed: true }],
  }),
  ...fields,
})

describe('Add a person', () => {
  it('asks for a name and a way to sign in before sending anything', async () => {
    const app = openPeople()
    const sheet = await open()
    assert.equal(
      (within(sheet).getByLabelText('Role') as HTMLSelectElement).value,
      'tester',
    )
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    await until(() => sheet.querySelector('.m-errsummary') != null, 'summary')
    assert.equal(text(sheet.querySelector('.m-errsummary')), NEEDS_SIGN_IN)
    await until(
      () => document.activeElement === sheet.querySelector('.m-errsummary'),
      'focus on the summary',
    )
    within(sheet).getByText('Enter their name')
    type(within(sheet).getByLabelText('Full name'), 'Grace')
    type(within(sheet).getByLabelText(/^Email addresses/), 'not an address')
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Another address' }),
    )
    type(
      within(sheet).getByLabelText(/^Another email address/),
      'NOT an address',
    )
    type(within(sheet).getByLabelText(/^Username/), '.bad')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    assert.equal(within(sheet).getAllByText('Enter an email address').length, 2)
    within(sheet).getByText(
      'A username is 1–64 letters, digits, dots, dashes or underscores',
    )
    assert.ok(!app.node.requests.includes(`POST ${PEOPLE}`))
  })

  it('adds a person with addresses and a hashed password, then closes', async () => {
    const app = openPeople('admin', {
      [`POST ${PEOPLE}`]: recording(`POST ${PEOPLE}`, 201, added()),
    })
    const sheet = await open()
    type(within(sheet).getByLabelText('Full name'), ' Grace Hopper ')
    fireEvent.change(within(sheet).getByLabelText('Role'), {
      target: { value: 'developer' },
    })
    type(within(sheet).getByLabelText(/^Email addresses/), 'Grace@Example.test')
    fireEvent.click(
      within(sheet).getByRole('button', { name: 'Another address' }),
    )
    type(within(sheet).getByLabelText(/^Another email address/), '')
    type(within(sheet).getByLabelText(/^Username/), 'grace')
    type(within(sheet).getByLabelText('Password'), 'short')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    within(sheet).getByText(/Use at least 8 characters/)
    within(sheet).getByText('The passwords do not match.')
    type(within(sheet).getByLabelText('Password'), 'Correct horse 1')
    type(
      within(sheet).getByLabelText('Confirm the password'),
      'Correct horse 1',
    )
    // The draft keeps everything but the password.
    const stored = JSON.parse(
      sessionStorage.getItem(draftKey(ADD_DRAFT)) ?? '{}',
    ) as Partial<AddDraft>
    assert.equal(stored.name, ' Grace Hopper ')
    assert.equal(stored.password, undefined)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    await screen.findByText('Grace Hopper added')
    await until(() => screen.queryByRole('dialog') == null, 'closed')
    assert.deepEqual(app.hasher.calls, ['new Correct horse 1'])
    const body = sent.get(`POST ${PEOPLE}`) as Record<string, unknown>
    assert.deepEqual(
      {
        ...body,
        password: (body.password as { clientHash: string }).clientHash,
      },
      {
        name: 'Grace Hopper',
        role: 'developer',
        emails: ['grace@example.test'],
        invite: false,
        username: 'grace',
        password: 'new:Correct horse 1',
      },
    )
    assert.equal(sessionStorage.getItem(draftKey(ADD_DRAFT)), null)
    assert.equal(
      app.node.requests.filter((request) => request === `GET ${PEOPLE}`).length,
      2,
    )
  })

  it('shows the invitation link it made, to copy, then Done', async () => {
    openPeople('admin', {
      [`POST ${PEOPLE}`]: recording(
        `POST ${PEOPLE}`,
        201,
        added({
          invitation: {
            url: 'https://mason.example.test/auth/invite#abc',
            expiresAt: NOW + 7 * DAY,
          },
        }),
      ),
    })
    const sheet = await open()
    type(within(sheet).getByLabelText('Full name'), 'Grace Hopper')
    type(within(sheet).getByLabelText(/^Username/), 'grace')
    fireEvent.click(within(sheet).getByLabelText('Make an invitation link'))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    await within(sheet).findByText(COPY_NOW)
    assert.equal(
      text(sheet.querySelector('.m-copy code')),
      'https://mason.example.test/auth/invite#abc',
    )
    assert.deepEqual(sent.get(`POST ${PEOPLE}`), {
      name: 'Grace Hopper',
      role: 'tester',
      emails: [],
      invite: true,
      username: 'grace',
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }))
    await until(() => screen.queryByRole('dialog') == null, 'closed')
  })

  it('keeps the fields and says why when the master refuses, or the password cannot be hashed', async () => {
    const app = openPeople('admin', {
      [`POST ${PEOPLE}`]: {
        status: 409,
        body: { error: 'That address is someone else’s' },
      },
    })
    const sheet = await open()
    type(within(sheet).getByLabelText('Full name'), 'Grace Hopper')
    type(within(sheet).getByLabelText(/^Email addresses/), 'ada@example.test')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    const error = await within(sheet).findByText(
      'That address is someone else’s',
    )
    await until(() => document.activeElement === error.closest('p'), 'focus')
    type(within(sheet).getByLabelText('Password'), 'Correct horse 1')
    type(
      within(sheet).getByLabelText('Confirm the password'),
      'Correct horse 1',
    )
    app.hasher.fail = 'No WebAssembly'
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }))
    await within(sheet).findByText('No WebAssembly')
    assert.equal(
      (within(sheet).getByLabelText('Full name') as HTMLInputElement).value,
      'Grace Hopper',
    )
    // Closing with changes asks first; Discard forgets the draft.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', {
          name: 'Discard your changes?',
        }),
      ).getByRole('button', { name: 'Discard' }),
    )
    await until(() => screen.queryByRole('dialog') == null, 'closed')
    assert.equal(sessionStorage.getItem(draftKey(ADD_DRAFT)), null)
  })

  it('restores a draft after a reload', async () => {
    sessionStorage.setItem(
      draftKey(ADD_DRAFT),
      JSON.stringify({ name: 'Kept', emails: ['kept@example.test'] }),
    )
    openPeople()
    const sheet = await open()
    assert.equal(
      (within(sheet).getByLabelText('Full name') as HTMLInputElement).value,
      'Kept',
    )
  })

  it('finds every problem with the fields', () => {
    const base: AddDraft = {
      name: 'A',
      role: 'tester',
      emails: ['a@example.test', 'A@example.test', ''],
      username: '',
      password: '',
      confirm: 'x',
      invite: false,
    }
    assert.deepEqual(addProblems(base), {
      emails: { 1: 'They already have that address' },
      password:
        'Use at least 8 characters with uppercase, lowercase and a number, or use 17 or more characters',
      confirm: 'The passwords do not match.',
    })
    assert.deepEqual(
      addProblems({ ...base, emails: [''], confirm: '', username: 'ok' }),
      {},
    )
  })
})

describe('A person’s draft', () => {
  const original = {
    name: 'Ada',
    username: '',
    role: 'tester' as const,
    emails: [
      { email: 'a@example.test', confirmed: true },
      { email: 'b@example.test', confirmed: false },
    ],
  }

  it('lists nothing and sends nothing while unchanged', () => {
    assert.deepEqual(changesOf(original, draftOf(original)), {
      lines: [],
      body: {},
    })
  })

  it('adds, removes, restores and confirms addresses', () => {
    let draft = draftOf(original)
    assert.equal(emailProblem('nope', draft), 'Enter an email address')
    assert.equal(
      emailProblem(`${'x'.repeat(320)}@e.t`, draft),
      'Enter an email address',
    )
    assert.equal(
      emailProblem(' A@Example.test ', draft),
      'They already have that address',
    )
    assert.equal(emailProblem('c@example.test', draft), undefined)
    draft = withEmail(draft, 'C@example.test', false)
    assert.deepEqual(draft.emails[2], {
      email: 'c@example.test',
      confirmed: false,
      added: true,
    })
    draft = withoutEmail(draft, 'a@example.test')
    assert.equal(emailProblem('a@example.test', draft), undefined)
    draft = confirmingEmail(draft, 'b@example.test')
    assert.deepEqual(changesOf(original, draft), {
      lines: [
        'Email added: c@example.test',
        'Email removed: a@example.test',
        'Email confirmed: b@example.test',
      ],
      body: {
        emails: ['b@example.test', 'c@example.test'],
        confirmEmails: ['b@example.test'],
      },
    })
    // Removed then added back: kept as it was.
    draft = withEmail(draft, 'a@example.test', true)
    draft = confirmingEmail(draft, 'b@example.test')
    draft = withoutEmail(draft, 'c@example.test')
    assert.deepEqual(changesOf(original, draft).lines, [])
  })

  it('accepts usernames by the master’s rule, and empty to clear', () => {
    assert.equal(usernameProblem(''), undefined)
    assert.equal(usernameProblem('a.b-c_9'), undefined)
    assert.equal(
      usernameProblem('_a'),
      'A username is 1–64 letters, digits, dots, dashes or underscores',
    )
    assert.notEqual(usernameProblem('a'.repeat(65)), undefined)
  })
})
