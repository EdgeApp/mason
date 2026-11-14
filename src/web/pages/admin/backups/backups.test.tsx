import assert from 'node:assert/strict'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, it } from 'mocha'
import {
  backupFixture,
  crumbs,
  heading,
  held,
  NOW,
  openAdmin,
  requested,
  sessionWithout,
  text,
} from '../../../test/admin.js'
import { until, where } from '../../../test/render.js'
import { backupStatus } from './Backups.js'
import { backupsLater, BACKUPS_LATER_KEY, setBackupsLater } from './later.js'

const SETTING = '/api/v2/settings/backup'
const CONFIRM = '/api/v2/settings/backup/confirm'

beforeEach(() => sessionStorage.clear())
afterEach(() => cleanup())

const main = (): HTMLElement =>
  screen.getByRole('region', { name: 'Hourly backup' })
const keyCard = (): HTMLElement | null =>
  screen.queryByRole('region', { name: 'Backup key' })
const stateLine = (): string => text(main().querySelector('.m-backups__state'))

/** A manager's view: no backup key. */
const managerView = backupFixture({
  backupKey: undefined,
  keyConfirmed: undefined,
})

describe('Backups', () => {
  it('shows the last backup in the design language’s time and SHA, the form, the deploy key and an unconfirmed key', async () => {
    openAdmin('/backups', { [SETTING]: backupFixture() }, 'admin')
    await heading('Backups')
    assert.equal(crumbs().at(-1), 'Backups')
    screen.getByText(
      'Encrypted copies of this master, kept in a git repository.',
    )
    await screen.findByRole('region', { name: 'Hourly backup' })
    within(main()).getByText(/^Every hour the master encrypts a snapshot/)
    assert.match(
      stateLine(),
      /^Last backup (Today|Yesterday) \d{4} \S+ \(3d9e1a7c\), pushed with the deploy key\.$/,
    )
    assert.doesNotMatch(text(main()), /\d{4}-\d{2}-\d{2}T/)
    within(main()).getByText('Backed up')
    assert.equal(
      (within(main()).getByLabelText('Repository') as HTMLInputElement).value,
      'git@github.com:example/mason-backup.git',
    )
    assert.equal(
      (within(main()).getByLabelText('Branch') as HTMLInputElement).value,
      'master',
    )
    within(main()).getByText(
      'Deploy key — add it to the repository with write access',
    )
    within(main()).getByText(/^ssh-ed25519 /)
    within(main()).getByRole('button', { name: 'Copy: the deploy key' })
    // The key card waits for the administrator; Skip for now goes with it.
    const key = keyCard()!
    within(key).getByText(
      'Store this key somewhere safe outside this master. Without it no backup can be restored.',
    )
    within(key).getByText(/^mason-backup-key-v1:/)
    within(key).getByText('Not confirmed')
    within(key).getByRole('button', { name: 'I have stored the backup key' })
    within(key).getByRole('button', { name: 'Skip for now' })
    assert.equal(
      within(main()).queryByRole('button', { name: 'Skip for now' }),
      null,
    )
  })

  it('says what pushed the last backup, or that it failed, or that none has run', async () => {
    const lines: Array<[Parameters<typeof backupFixture>[0], RegExp]> = [
      [
        {
          auth: 'github',
          deployKey: undefined,
          lastSuccess: {
            at: NOW - 60_000,
            commit: 'abcdef1234567890',
            kind: 'commit',
            auth: 'github',
          },
        },
        /^Last backup .+ \(abcdef12\), pushed with the GitHub connection\.$/,
      ],
      [
        {
          lastSuccess: {
            at: NOW - 60_000,
            commit: 'abcdef1234567890',
            kind: 'commit',
          },
        },
        /^Last backup .+ \(abcdef12\)\.$/,
      ],
      [
        {
          backedUp: false,
          lastFailure: {
            at: NOW - 60_000,
            error: 'Permission denied (publickey)',
          },
        },
        /^The last backup failed: Permission denied \(publickey\)$/,
      ],
      [
        { backedUp: false, lastSuccess: undefined },
        /^No backup has run yet\.$/,
      ],
    ]
    for (const [fields, line] of lines) {
      openAdmin('/backups', { [SETTING]: backupFixture(fields) }, 'admin')
      await screen.findByRole('region', { name: 'Hourly backup' })
      assert.match(stateLine(), line)
      cleanup()
    }
    // GitHub pushes need no deploy key.
    openAdmin(
      '/backups',
      { [SETTING]: backupFixture({ auth: 'github', deployKey: undefined }) },
      'admin',
    )
    await screen.findByRole('region', { name: 'Hourly backup' })
    assert.equal(within(main()).queryByText(/Deploy key/), null)
  })

  it('names the state in its pill', () => {
    assert.deepEqual(backupStatus(backupFixture()), { status: 'backed_up' })
    assert.deepEqual(
      backupStatus(
        backupFixture({
          backedUp: false,
          lastFailure: { at: NOW, error: 'x' },
        }),
      ),
      { status: 'failed', label: 'Backup failed' },
    )
    assert.deepEqual(backupStatus({ configured: false, backedUp: false }), {
      status: 'not_set_up',
    })
    assert.deepEqual(
      backupStatus(backupFixture({ backedUp: false, lastSuccess: undefined })),
      { status: 'no_backup' },
    )
  })

  it('starts unconfigured with an empty repository, master, and Skip for now in the main card', async () => {
    openAdmin(
      '/backups',
      { [SETTING]: { configured: false, backedUp: false } },
      'admin',
    )
    await screen.findByRole('region', { name: 'Hourly backup' })
    assert.equal(stateLine(), 'No backup has run yet.')
    within(main()).getByText('Not set up')
    const repository = within(main()).getByLabelText(
      'Repository',
    ) as HTMLInputElement
    assert.equal(repository.value, '')
    assert.equal(
      repository.placeholder,
      'git@github.com:owner/mason-backup.git',
    )
    assert.equal(
      (within(main()).getByLabelText('Branch') as HTMLInputElement).value,
      'master',
    )
    assert.equal(keyCard(), null)
    within(main()).getByRole('button', { name: 'Skip for now' })
  })

  it('saves the repository and branch, checked first; a refusal keeps the input; the backup key appears after the first save', async () => {
    const answer = held(
      200,
      backupFixture({
        backedUp: false,
        lastSuccess: undefined,
        repository: 'git@github.com:example/new.git',
        branch: 'backups',
      }),
    )
    const put = { bodies: [] as unknown[] }
    const app = openAdmin(
      '/backups',
      {
        [SETTING]: { configured: false, backedUp: false },
        [`PUT ${SETTING}`]: async (_url: string, init: RequestInit) => {
          put.bodies.push(JSON.parse(String(init.body)))
          return put.bodies.length === 1
            ? new Response(
                JSON.stringify({ error: 'backup.repository is a git URL' }),
                { status: 400 },
              )
            : await answer.reply()
        },
      },
      'admin',
    )
    await screen.findByRole('region', { name: 'Hourly backup' })
    const repository = within(main()).getByLabelText('Repository')
    const branch = within(main()).getByLabelText('Branch')
    fireEvent.change(branch, { target: { value: ' ' } })
    fireEvent.click(within(main()).getByRole('button', { name: 'Save' }))
    await within(main()).findByText('Enter the repository’s git URL.')
    within(main()).getByText('Enter a branch.')
    assert.equal(put.bodies.length, 0)
    fireEvent.change(repository, { target: { value: 'nope' } })
    fireEvent.change(branch, { target: { value: 'backups' } })
    fireEvent.click(within(main()).getByRole('button', { name: 'Save' }))
    await within(main()).findByText('backup.repository is a git URL')
    assert.deepEqual(put.bodies, [{ repository: 'nope', branch: 'backups' }])
    assert.equal((repository as HTMLInputElement).value, 'nope')
    fireEvent.change(repository, {
      target: { value: ' git@github.com:example/new.git ' },
    })
    const save = within(main()).getByRole('button', { name: 'Save' })
    fireEvent.click(save)
    await requested(app, `PUT ${SETTING}`)
    await until(() => save.getAttribute('aria-busy') === 'true', 'busy Save')
    answer.release()
    await screen.findByText('Backups saved')
    assert.deepEqual(put.bodies.at(-1), {
      repository: 'git@github.com:example/new.git',
      branch: 'backups',
    })
    await until(() => keyCard() != null, 'the key card')
    within(keyCard()!).getByText(/^mason-backup-key-v1:/)
    within(main()).getByText(/^ssh-ed25519 /)
    within(main()).getByText('No backup yet')
  })

  it('confirms the backup key: busy, then said; a refusal stays in the card', async () => {
    const answer = held(200, { keyConfirmed: true })
    const app = openAdmin(
      '/backups',
      {
        [SETTING]: backupFixture(),
        [`POST ${CONFIRM}`]: {
          status: 400,
          body: { error: 'Backups are not configured' },
        },
      },
      'admin',
    )
    await screen.findByRole('region', { name: 'Backup key' })
    fireEvent.click(
      within(keyCard()!).getByRole('button', {
        name: 'I have stored the backup key',
      }),
    )
    await within(keyCard()!).findByText('Backups are not configured')
    app.node.set(`POST ${CONFIRM}`, answer.reply)
    const button = within(keyCard()!).getByRole('button', {
      name: 'I have stored the backup key',
    })
    fireEvent.click(button)
    await until(
      () => button.getAttribute('aria-busy') === 'true',
      'busy confirm',
    )
    answer.release()
    await screen.findByText('Backup key confirmed')
    within(keyCard()!).getByText('You confirmed you stored this key.')
    within(keyCard()!).getByText('Confirmed')
    assert.equal(
      within(keyCard()!).queryByRole('button', { name: /stored/ }),
      null,
    )
    // Nothing waits now, so Skip for now moves back to the main card.
    within(main()).getByRole('button', { name: 'Skip for now' })
  })

  it('shows a confirmed key as confirmed, and nothing to confirm for a key with no creator', async () => {
    openAdmin(
      '/backups',
      { [SETTING]: backupFixture({ keyConfirmed: true }) },
      'admin',
    )
    await screen.findByRole('region', { name: 'Backup key' })
    within(keyCard()!).getByText('You confirmed you stored this key.')
    cleanup()
    openAdmin(
      '/backups',
      { [SETTING]: backupFixture({ keyConfirmed: undefined }) },
      'admin',
    )
    await screen.findByRole('region', { name: 'Backup key' })
    assert.equal(
      within(keyCard()!).queryByRole('button', { name: /stored/ }),
      null,
    )
    assert.equal(within(keyCard()!).queryByText(/You confirmed/), null)
    assert.equal(within(keyCard()!).queryByText(/onfirmed/), null)
  })

  it('gives a manager no key card, and a viewer without settings.change read-only fields', async () => {
    openAdmin('/backups', { [SETTING]: managerView }, 'manager')
    await screen.findByRole('region', { name: 'Hourly backup' })
    assert.equal(keyCard(), null)
    within(main()).getByRole('button', { name: 'Save' })
    cleanup()
    openAdmin(
      '/backups',
      { [SETTING]: managerView },
      'manager',
      sessionWithout('manager', ['settings.change']),
    )
    await screen.findByRole('region', { name: 'Hourly backup' })
    assert.equal(within(main()).queryByRole('button', { name: 'Save' }), null)
    assert.equal(
      (within(main()).getByLabelText('Repository') as HTMLInputElement)
        .readOnly,
      true,
    )
    cleanup()
    openAdmin('/backups', { [SETTING]: managerView }, 'developer')
    await screen.findByText(/Backups is for/)
  })

  it('shows a skeleton while loading, and a failed read with Retry', async () => {
    const slow = held(200, backupFixture())
    openAdmin('/backups', { [SETTING]: slow.reply }, 'admin')
    await heading('Backups')
    screen.getByLabelText('Loading the backup setting')
    slow.release()
    await screen.findByRole('region', { name: 'Hourly backup' })
    cleanup()
    const app = openAdmin(
      '/backups',
      { [SETTING]: { status: 500, body: { error: 'Database locked' } } },
      'admin',
    )
    await screen.findByText('The backup setting could not be read')
    app.node.set(SETTING, backupFixture())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('region', { name: 'Hourly backup' })
  })
})

describe('Backups first', () => {
  it('sends an administrator with an unconfirmed key from the home to Backups once per browser session', async () => {
    const app = openAdmin('/', { [SETTING]: backupFixture() }, 'admin')
    await until(() => where.path === '/backups', 'the redirect')
    await heading('Backups')
    assert.equal(sessionStorage.getItem(BACKUPS_LATER_KEY), '1')
    assert.equal(
      app.node.requests.filter((request) => request === `GET ${SETTING}`)
        .length >= 1,
      true,
    )
    cleanup()
    // The same session: the home opens.
    const again = openAdmin('/', { [SETTING]: backupFixture() }, 'admin')
    await heading('Projects & apps')
    assert.equal(again.node.requests.includes(`GET ${SETTING}`), false)
  })

  it('leaves for the home on Skip for now, which keeps it there for the session', async () => {
    openAdmin('/backups', { [SETTING]: backupFixture() }, 'admin')
    fireEvent.click(
      await within(
        await screen.findByRole('region', { name: 'Backup key' }),
      ).findByRole('button', { name: 'Skip for now' }),
    )
    await until(() => where.path === '/', 'home')
    await heading('Projects & apps')
    assert.equal(backupsLater(), true)
  })

  it('opens the home at once for anyone else, a confirmed key, unconfigured backups or a failed read', async () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['manager', { [SETTING]: backupFixture() }, false],
      ['admin', { [SETTING]: backupFixture({ keyConfirmed: true }) }, true],
      ['admin', { [SETTING]: { configured: false, backedUp: false } }, true],
      [
        'admin',
        { [SETTING]: { status: 500, body: { error: 'Locked' } } },
        true,
      ],
    ]
    for (const [role, replies, asks] of cases) {
      const app = openAdmin('/', replies, role as 'admin')
      await heading('Projects & apps')
      assert.equal(where.path, '/')
      assert.equal(app.node.requests.includes(`GET ${SETTING}`), asks, role)
      assert.equal(backupsLater(), false)
      cleanup()
    }
  })

  it('waits on a skeleton while it reads the setting', async () => {
    const slow = held(200, backupFixture({ keyConfirmed: true }))
    openAdmin('/', { [SETTING]: slow.reply }, 'admin')
    await screen.findByLabelText('Opening the page')
    slow.release()
    await heading('Projects & apps')
  })

  it('carries on when session storage is off', () => {
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      'sessionStorage',
    )
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError')
      },
    })
    try {
      assert.equal(backupsLater(), false)
      setBackupsLater()
      assert.equal(backupsLater(), false)
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', original!)
    }
    setBackupsLater()
    assert.equal(backupsLater(), true)
  })
})
