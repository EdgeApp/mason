import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, it } from 'mocha'
import { clientParameters } from '../../../auth/passwordProtocol.js'
import { tryAgainAt } from '../../../shared/format.js'
import { safeReturn } from '../../../shared/routes.js'
import { FLOW_META, type SignInFlow } from '../../../shared/api/index.js'
import { ApiClient, ApiError } from '../../api/client.js'
import { App } from '../../main.js'
import {
  fakeHasher,
  fakeNode,
  nodeInfo,
  renderApp,
  until,
  where,
  type Reply,
} from '../../test/render.js'
import { workerHasher, type HashWorker } from '../../workers/hasher.js'
import type { HashRequest, HashResponse } from '../../workers/password.js'
import { FlowPage, readFlow } from './Flow.js'
import { welcome } from './Invite.js'
import { codeProblem } from './Setup.js'
import { refusal, unavailable } from './SignedOut.js'
import { providerHref, shortly } from './SignIn.js'

const PARAMETERS = clientParameters('ab'.repeat(16))

/** A reply that records the JSON body it was sent. */
function recording(
  bodies: unknown[],
  status: number,
  body: unknown,
): (url: string, init: RequestInit) => Response {
  return (_url, init) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify(body), { status })
  }
}

const heading = async (name: string): Promise<HTMLElement> =>
  await screen.findByRole('heading', { level: 1, name })

/** Types into a field found by its label. */
async function fill(label: string | RegExp, text: string): Promise<void> {
  const field = screen.getByLabelText(label)
  await userEvent.clear(field)
  if (text !== '') await userEvent.type(field, text)
}

const press = async (name: string | RegExp): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name }))
}

afterEach(() => {
  cleanup()
  document.head.innerHTML = ''
})

describe('Sign in', () => {
  it('hashes the password in the worker and signs in on the master, then leaves with a full load', async () => {
    const bodies: unknown[] = []
    // The real hasher, talking to a worker that answers as the bundle's does.
    const seen: HashRequest[] = []
    const worker: HashWorker = {
      onmessage: null,
      postMessage(message) {
        seen.push(message)
        const reply: HashResponse = { clientHash: 'cd'.repeat(32) }
        setTimeout(() => worker.onmessage?.({ data: reply }))
      },
    }
    const app = renderApp({
      path: '/sign-in',
      hasher: workerHasher(() => worker),
      replies: {
        'POST /api/v2/session/parameters': recording(bodies, 200, PARAMETERS),
        'POST /api/v2/session': recording(bodies, 200, {
          name: 'Paul Puey',
          role: 'admin',
          csrf: 'proof',
        }),
      },
    })
    await heading('Sign in')
    assert.equal(document.title, 'Sign in · Mason')
    // No providers: no divider, no provider buttons.
    assert.equal(screen.queryByText('or with a username or email'), null)
    screen.getByText(
      'Mason hashes your password in this browser before sending it.',
    )
    await fill('Username or email', ' paul ')
    await fill('Password', 'Correct-Horse-9')
    await press('Sign in')
    await until(() => app.left.length > 0, 'the sign-in')
    assert.deepEqual(app.left, ['/'])
    assert.deepEqual(bodies, [
      { identifier: 'paul' },
      { identifier: 'paul', clientHash: 'cd'.repeat(32) },
    ])
    assert.deepEqual(seen, [
      { kind: 'hash', password: 'Correct-Horse-9', parameters: PARAMETERS },
    ])
  })

  it('asks for what is missing before asking the node', async () => {
    const app = renderApp({ path: '/sign-in', replies: {} })
    await heading('Sign in')
    await press('Sign in')
    screen.getByText('Enter your username or email')
    screen.getByText('Enter your password')
    // Focus moves to the first field to fix.
    assert.equal(
      document.activeElement,
      screen.getByLabelText('Username or email'),
    )
    assert.equal(
      screen.getByLabelText('Password').getAttribute('aria-invalid'),
      'true',
    )
    assert.deepEqual(app.node.requests, [])
  })

  it('says when a locked sign-in may try again, in the design language’s time, and focuses it', async () => {
    const retryAt = Date.now() + 5 * 60_000
    const hasher = fakeHasher()
    renderApp({
      path: '/sign-in',
      hasher,
      replies: {
        'POST /api/v2/session/parameters': PARAMETERS,
        'POST /api/v2/session': {
          status: 429,
          body: { error: 'The username or password is wrong', retryAt },
        },
      },
    })
    await heading('Sign in')
    await fill('Username or email', 'paul')
    await fill('Password', 'Wrong-Horse-9')
    await press('Sign in')
    const alert = await screen.findByText(
      `The username or password is wrong. ${tryAgainAt(retryAt, Date.now())}.`,
    )
    await until(
      () => document.activeElement === alert.closest('p'),
      'focus on the error',
    )
    assert.deepEqual(hasher.calls, [`hash Wrong-Horse-9 ${'ab'.repeat(16)}`])
    // The button is pressable again, and the typed values stay.
    assert.equal(
      screen.getByRole('button', { name: 'Sign in' }).getAttribute('aria-busy'),
      null,
    )
    assert.equal(
      (screen.getByLabelText('Username or email') as HTMLInputElement).value,
      'paul',
    )
  })

  it('shows and hides the typed password', async () => {
    renderApp({ path: '/sign-in', replies: {} })
    await heading('Sign in')
    const field = screen.getByLabelText('Password')
    assert.equal(field.getAttribute('type'), 'password')
    assert.equal(field.getAttribute('autocomplete'), 'current-password')
    // One name, its pressed state saying whether the password shows.
    const reveal = screen.getByRole('button', { name: 'Show password' })
    assert.equal(reveal.getAttribute('aria-pressed'), 'false')
    await press('Show password')
    assert.equal(field.getAttribute('type'), 'text')
    assert.equal(reveal.getAttribute('aria-pressed'), 'true')
    assert.match(reveal.className, /m-reveal/)
    await press('Show password')
    assert.equal(field.getAttribute('type'), 'password')
    assert.equal(reveal.getAttribute('aria-pressed'), 'false')
  })

  it('offers the master’s providers at its public origin, then the password', async () => {
    renderApp({
      path: '/sign-in',
      node: nodeInfo('master', {
        masterOrigin: 'https://mason.example.test',
        signIn: {
          password: true,
          providers: [{ id: 'teamstation', name: 'TeamStation' }],
        },
      }),
      replies: {},
    })
    await heading('Sign in')
    assert.equal(
      screen
        .getByRole('link', { name: 'Sign in with TeamStation' })
        .getAttribute('href'),
      'https://mason.example.test/auth/start/teamstation?return=%2F',
    )
    screen.getByText('or with a username or email')
  })

  it('signs in on the host through its own session, back to the page that sent the browser', async () => {
    const app = renderApp({
      path: '/auth/login?return=%2Fapps%2F3',
      node: nodeInfo('host', {
        signIn: { password: true, providers: [{ id: 'gh', name: 'GitHub' }] },
      }),
      replies: {
        'POST /api/v2/session/parameters': PARAMETERS,
        'POST /api/v2/session': { name: 'Tess', role: 'tester', csrf: 'p' },
      },
    })
    await heading('Sign in')
    assert.equal(
      screen
        .getByRole('link', { name: 'Sign in with GitHub' })
        .getAttribute('href'),
      '/auth/start/gh?return=%2Fapps%2F3',
    )
    await fill('Username or email', 'tess')
    await fill('Password', 'Tess-Horse-9-long')
    await press('Sign in')
    await until(() => app.left.length > 0, 'the sign-in')
    assert.deepEqual(app.left, ['/apps/3'])
    assert.deepEqual(app.node.requests, [
      'POST /api/v2/session/parameters',
      'POST /api/v2/session',
    ])
  })

  it('never returns to another origin, and says the browser signed out', async () => {
    // A tab or newline is dropped by the URL parser: `/\t/evil.example` is `//evil.example`.
    for (const hostile of [
      '%2F%2Fevil.example',
      '%2F%09%2Fevil.example',
      '%2F%0A%2Fevil.example',
    ]) {
      const app = renderApp({
        path: `/auth/login?return=${hostile}&signed_out=1`,
        node: nodeInfo('host'),
        replies: {
          'POST /api/v2/session/parameters': PARAMETERS,
          'POST /api/v2/session': { name: 'Tess', role: 'tester', csrf: 'p' },
        },
      })
      await heading('Sign in')
      screen.getByText('You are signed out.')
      await fill('Username or email', 'tess')
      await fill('Password', 'Tess-Horse-9-long')
      await press('Sign in')
      await until(() => app.left.length > 0, 'the sign-in')
      assert.deepEqual(app.left, ['/'], hostile)
      cleanup()
    }
    for (const value of [
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\u007f/evil.example',
      '/x#fragment',
      '/auth/start/gh',
      'https://evil.example',
      '/' + 'x'.repeat(1024),
      null,
    ])
      assert.equal(safeReturn(value), '/', String(value))
    assert.equal(safeReturn('/apps/3?platform=ios'), '/apps/3?platform=ios')
  })

  it('says when password sign-in needs the master, and when the host has no copy of the account yet', async () => {
    const node = nodeInfo('host')
    const replies: Record<string, Reply> = {
      'POST /api/v2/session/parameters': {
        status: 503,
        body: { error: 'Password sign-in needs the master; try again shortly' },
      },
    }
    const app = renderApp({ path: '/auth/login', node, replies })
    await heading('Sign in')
    await fill('Username or email', 'tess')
    await fill('Password', 'Tess-Horse-9-long')
    await press('Sign in')
    const card = await screen.findByRole('region', {
      name: 'Password sign-in needs the master',
    })
    assert.match(card.textContent!, /Try again shortly\./)
    app.node.set('POST /api/v2/session/parameters', PARAMETERS)
    app.node.set('POST /api/v2/session', {
      status: 401,
      body: { error: 'This account is not on the host yet; try again shortly' },
    })
    await press('Sign in')
    await screen.findByRole('region', {
      name: 'This account is not on the host yet',
    })
    // Any other refusal is the form's own error.
    app.node.set('POST /api/v2/session', {
      status: 401,
      body: { error: 'The username or password is wrong.' },
    })
    await press('Sign in')
    await screen.findByText('The username or password is wrong')
  })

  it('names provider buttons by where they start', () => {
    assert.equal(
      providerHref(nodeInfo('master'), 'a b', '/'),
      '/auth/start/a%20b?return=%2F',
    )
    assert.equal(shortly('Done'), undefined)
    assert.deepEqual(
      shortly('Invitations need the master; try again shortly'),
      ['Invitations need the master', 'Try again shortly.'],
    )
  })
})

describe('A refusal on a signed-out page', () => {
  it('is the node’s message, with when to retry, and an outage is a warning', () => {
    assert.equal(refusal(new Error('Nope.')), 'Nope')
    const now = Date.parse('2026-11-12T22:30:00Z')
    assert.equal(
      refusal(new ApiError(429, 'Wait', now + 60_000), now),
      `Wait. ${tryAgainAt(now + 60_000, now)}.`,
    )
    assert.equal(unavailable(new ApiError(503, 'x')), true)
    assert.equal(unavailable(new ApiError(0, 'x')), true)
    assert.equal(unavailable(new ApiError(401, 'x')), false)
    assert.equal(unavailable(new Error('x')), false)
  })
})

describe('First-run setup', () => {
  const fresh = nodeInfo('master', { setupNeeded: true })

  it('checks the setup code, username and password before asking the master', async () => {
    assert.equal(codeProblem('123456'), undefined)
    for (const code of ['', '12345', '1234567', '12a456'])
      assert.equal(
        codeProblem(code),
        'Enter the six digits this master printed',
      )
    const app = renderApp({ path: '/', node: fresh, replies: {} })
    await heading('Set up this master')
    assert.equal(document.title, 'Set up this master · Mason')
    // Validated when a typed field loses focus.
    await fill('Setup code', '12a')
    await userEvent.tab()
    screen.getByText('Enter the six digits this master printed')
    await press('Create account')
    screen.getByText('Choose a username')
    screen.getByText('Use at least 12 characters')
    assert.deepEqual(app.node.requests, [])
    const code = screen.getByLabelText('Setup code')
    assert.equal(code.getAttribute('inputmode'), 'numeric')
    assert.equal(code.getAttribute('autocomplete'), 'one-time-code')
    assert.equal(
      screen.getByLabelText('Password').getAttribute('autocomplete'),
      'new-password',
    )
  })

  it('creates the first administrator from a calibrated hash, then opens Backups', async () => {
    const bodies: unknown[] = []
    const hasher = fakeHasher()
    const app = renderApp({
      path: '/',
      node: fresh,
      hasher,
      replies: {
        'POST /api/setup': recording(bodies, 201, {
          accountId: 1,
          username: 'owner',
        }),
      },
    })
    await heading('Set up this master')
    await fill('Setup code', '12 34 56')
    await fill('Username', 'owner')
    await fill('Password', 'Owner-Horse-9-long')
    await press('Create account')
    await until(() => app.left.length > 0, 'the setup')
    assert.deepEqual(app.left, ['/backups'])
    assert.deepEqual(hasher.calls, ['new Owner-Horse-9-long'])
    const sent = bodies[0] as Record<string, unknown>
    assert.equal(sent.code, '123456')
    assert.equal(sent.username, 'owner')
    assert.equal(sent.clientHash, 'new:Owner-Horse-9-long')
    assert.equal(
      (sent.clientParameters as { salt: string }).salt,
      '07'.repeat(16),
    )
    assert.equal('password' in sent, false)
  })

  it('says a wrong setup code’s wait, and keeps what was typed', async () => {
    const retryAt = Date.now() + 10_000
    const hasher = fakeHasher()
    renderApp({
      path: '/',
      node: fresh,
      hasher,
      replies: {
        'POST /api/setup': {
          status: 429,
          body: { error: 'That is not the setup code', retryAt },
        },
      },
    })
    await heading('Set up this master')
    await fill('Setup code', '000000')
    await fill('Username', 'owner')
    await fill('Password', 'Owner-Horse-9-long')
    await press('Create account')
    await screen.findByText(
      `That is not the setup code. ${tryAgainAt(retryAt, Date.now())}.`,
    )
    assert.equal(
      (screen.getByLabelText('Username') as HTMLInputElement).value,
      'owner',
    )
    // A worker that cannot hash says so the same way.
    hasher.fail = 'This browser could not prepare the password'
    await press('Create account')
    await screen.findByText('This browser could not prepare the password')
  })

  it('restores from a backup: the key file by picker or by drop, an optional date, then sign-in', async () => {
    const bodies: unknown[] = []
    const app = renderApp({
      path: '/',
      node: fresh,
      replies: {
        'POST /api/setup/restore': recording(bodies, 202, {
          restored: 12,
          restart: true,
        }),
      },
    })
    await heading('Set up this master')
    await press('Restore from a backup instead')
    await heading('Restore this master')
    assert.equal(where.path, '/?restore')
    // The swapped card is announced: focus is on its heading.
    await until(
      () => document.activeElement?.textContent === 'Restore this master',
      'focus on the new heading',
    )
    // It warns to stop the master the backup came from.
    screen.getByText(
      /It comes back as the same master, so its nodes reconnect: stop the master the backup came from first\./,
    )
    await press('Restore')
    screen.getByText('Enter the six digits this master printed')
    assert.equal(document.activeElement, screen.getByLabelText('Setup code'))
    screen.getByText('Enter the backup’s git repository')
    screen.getByText('Choose the backup key file')
    const input = screen.getByLabelText('Backup key file') as HTMLInputElement
    assert.equal(input.type, 'file')
    // Dropped on the zone.
    const zone = input.closest('label')!
    fireEvent.dragOver(zone)
    assert.match(zone.className, /m-dropzone--over/)
    fireEvent.dragLeave(zone)
    assert.doesNotMatch(zone.className, /m-dropzone--over/)
    const dropped = new File(['DROPPED\n'], 'dropped.key')
    fireEvent.drop(zone, { dataTransfer: { files: [dropped] } })
    screen.getByText('dropped.key')
    assert.equal(screen.queryByText('Choose the backup key file'), null)
    fireEvent.drop(zone, { dataTransfer: { files: [] } })
    screen.getByText('dropped.key')
    // Chosen with the picker instead.
    await userEvent.upload(
      input,
      new File(['  MASON-BACKUP-KEY\n'], 'mason-backup.key'),
    )
    screen.getByText('mason-backup.key')
    await fill('Setup code', '123456')
    await fill('Backup repository', 'git@github.com:owner/mason-backup.git')
    const date = screen.getByLabelText(/^Date/) as HTMLInputElement
    assert.equal(date.type, 'date')
    fireEvent.change(date, { target: { value: '2026-11-01' } })
    await press('Restore')
    await until(() => app.left.length > 0, 'the restore')
    assert.deepEqual(app.left, ['/sign-in'])
    assert.deepEqual(bodies, [
      {
        code: '123456',
        repository: 'git@github.com:owner/mason-backup.git',
        key: 'MASON-BACKUP-KEY',
        date: '2026-11-01',
      },
    ])
  })

  it('says why a restore failed, and goes back to creating an account', async () => {
    renderApp({
      path: '/?restore',
      node: fresh,
      replies: {
        'POST /api/setup/restore': {
          status: 404,
          body: { error: 'Restore is not available' },
        },
      },
    })
    await heading('Restore this master')
    await fill('Setup code', '123456')
    await fill('Backup repository', 'git@github.com:o/b.git')
    await userEvent.upload(
      screen.getByLabelText('Backup key file'),
      new File(['KEY'], 'k.key'),
    )
    await press('Restore')
    await screen.findByText('Restore is not available')
    await press('Create the first account instead')
    await heading('Set up this master')
    assert.equal(where.path, '/')
  })
})

describe('An invitation', () => {
  const lookup = (person: unknown, bodies: unknown[] = []): Reply =>
    recording(bodies, 200, person)

  it('reads the token from the fragment, drops it from the address, and welcomes the person', async () => {
    const bodies: unknown[] = []
    renderApp({
      path: '/auth/invite#tok-123',
      node: nodeInfo('host'),
      replies: {
        'POST /auth/invite/lookup': lookup(
          { name: 'Ada', usernameRequired: false },
          bodies,
        ),
      },
    })
    await screen.findByText(
      'Welcome, Ada. Choose a password (and a username, if you want one) to sign in to Mason.',
    )
    assert.deepEqual(bodies, [{ token: 'tok-123' }])
    assert.equal(where.hash, '')
    assert.equal(where.path, '/auth/invite')
    screen.getByText('(optional)')
    assert.equal(
      screen.getByLabelText(/^Username/).getAttribute('aria-required'),
      null,
    )
  })

  it('words the welcome for what the person already has', () => {
    assert.equal(
      welcome({ name: 'Bo', username: 'bo' }),
      'Welcome, Bo. Choose a password to sign in to Mason.',
    )
    assert.equal(
      welcome({ name: 'Cy', usernameRequired: true }),
      'Welcome, Cy. Choose a password and a username to sign in to Mason.',
    )
  })

  it('keeps a username the person has, checks the rules and the confirmation, then sets the password and signs in', async () => {
    const bodies: unknown[] = []
    const hasher = fakeHasher()
    const app = renderApp({
      path: '/auth/invite#tok',
      hasher,
      replies: {
        'POST /auth/invite/lookup': { name: 'Bo', username: 'bo' },
        'POST /auth/invite': recording(bodies, 200, { signedIn: true }),
      },
    })
    await screen.findByText(
      'Welcome, Bo. Choose a password to sign in to Mason.',
    )
    const name = screen.getByLabelText('Username') as HTMLInputElement
    assert.equal(name.value, 'bo')
    assert(name.readOnly)
    screen.getByText('Your username stays as it is.')
    await fill('Password', 'short')
    await userEvent.tab()
    screen.getByText(
      'Use at least 8 characters with uppercase, lowercase and a number, or use 17 or more characters',
    )
    await fill('Password', 'Bo-Horse-9-long')
    await fill('Confirm', 'Bo-Horse-9-lonG')
    await press('Set password and sign in')
    screen.getByText('The passwords do not match')
    assert.equal(document.activeElement, screen.getByLabelText('Confirm'))
    assert.deepEqual(hasher.calls, [])
    await fill('Confirm', 'Bo-Horse-9-long')
    await press('Set password and sign in')
    await until(() => app.left.length > 0, 'the acceptance')
    assert.deepEqual(app.left, ['/'])
    assert.deepEqual(bodies, [
      {
        token: 'tok',
        username: 'bo',
        clientHash: 'new:Bo-Horse-9-long',
        clientParameters: (await fakeHasher().create('x')).clientParameters,
      },
    ])
  })

  it('asks for a username when the person must choose one, by the master’s rule', async () => {
    renderApp({
      path: '/auth/invite#tok',
      replies: {
        'POST /auth/invite/lookup': { name: 'Cy', usernameRequired: true },
        'POST /auth/invite': {
          status: 409,
          body: { error: 'That username is taken' },
        },
      },
    })
    await screen.findByText(
      'Welcome, Cy. Choose a password and a username to sign in to Mason.',
    )
    await press('Set password and sign in')
    screen.getByText('Choose a username')
    await fill('Username', '.cy')
    await press('Set password and sign in')
    screen.getByText(
      'Use up to 64 letters, digits, dots, dashes and underscores, starting with a letter or digit',
    )
    await fill('Username', 'cy')
    await fill('Password', 'Cy-Horse-9-long')
    await fill('Confirm', 'Cy-Horse-9-long')
    await press('Set password and sign in')
    await screen.findByText('That username is taken')
  })

  it('says a link is incomplete without asking anyone', async () => {
    const app = renderApp({ path: '/auth/invite', replies: {} })
    await screen.findByRole('region', {
      name: 'This invitation link is incomplete',
    })
    screen.getByText('Copy all of it from the message you were sent.')
    assert.deepEqual(app.node.requests, [])
  })

  it('says an expired or used link cannot be used', async () => {
    renderApp({
      path: '/auth/invite#old',
      replies: {
        'POST /auth/invite/lookup': {
          status: 404,
          body: { error: 'This invitation link is not valid or has expired' },
        },
      },
    })
    const card = await screen.findByRole('region', {
      name: 'This invitation cannot be used',
    })
    assert.match(
      card.textContent!,
      /This invitation link is not valid or has expired\. Ask whoever invited you for a new link\./,
    )
  })

  it('asks to try again while the host cannot reach the master, and carries on when it can', async () => {
    const app = renderApp({
      path: '/auth/invite#tok',
      node: nodeInfo('host'),
      replies: {
        'POST /auth/invite/lookup': {
          status: 503,
          body: { error: 'Invitations need the master; try again shortly' },
        },
      },
    })
    await screen.findByRole('region', { name: 'Invitations need the master' })
    app.node.set('POST /auth/invite/lookup', { name: 'Ada' })
    await press('Try again')
    await screen.findByText(
      'Welcome, Ada. Choose a password and a username to sign in to Mason.',
    )
    // The acceptance needs the master too.
    app.node.set('POST /auth/invite', {
      status: 503,
      body: { error: 'Invitations need the master; try again shortly' },
    })
    await fill('Username', 'ada')
    await fill('Password', 'Ada-Horse-9-long')
    await fill('Confirm', 'Ada-Horse-9-long')
    await press('Set password and sign in')
    await screen.findByRole('region', { name: 'Invitations need the master' })
  })

  it('says the password is set when the host does not have the account yet', async () => {
    renderApp({
      path: '/auth/invite#tok',
      node: nodeInfo('host'),
      replies: {
        'POST /auth/invite/lookup': { name: 'Ada', username: 'ada' },
        'POST /auth/invite': {
          status: 400,
          body: { error: 'Your password is set; sign in with it in a moment' },
        },
      },
    })
    await screen.findByText(
      'Welcome, Ada. Choose a password to sign in to Mason.',
    )
    await fill('Password', 'Ada-Horse-9-long')
    await fill('Confirm', 'Ada-Horse-9-long')
    await press('Set password and sign in')
    await screen.findByRole('region', { name: 'Your password is set' })
    assert.equal(
      screen.getByRole('link', { name: 'Sign in' }).getAttribute('href'),
      '/auth/login?return=%2F',
    )
  })

  it('treats an unreachable node as a warning to try again', async () => {
    renderApp({
      path: '/auth/invite#tok',
      replies: {
        'POST /auth/invite/lookup': () =>
          Promise.reject(new TypeError('fetch failed')),
      },
    })
    const card = await screen.findByRole('region', {
      name: 'Mason could not be reached',
    })
    assert.match(card.textContent!, /Try again shortly\./)
  })
})

describe('A provider sign-in’s pages', () => {
  const draw = (
    flow: SignInFlow,
    replace = (_url: string): void => {},
  ): ReturnType<typeof render> =>
    render(<FlowPage flow={flow} replace={replace} />)

  it('reads the state the node put in the page, and nothing else', () => {
    assert.equal(readFlow(document), undefined)
    const meta = document.createElement('meta')
    meta.name = FLOW_META
    meta.content = '{not json'
    document.head.append(meta)
    assert.equal(readFlow(document), undefined)
    meta.content = JSON.stringify({ state: 'signedIn' })
    assert.equal(readFlow(document), undefined)
    meta.content = JSON.stringify({ state: 'signedIn', next: '/runs/1' })
    assert.deepEqual(readFlow(document), { state: 'signedIn', next: '/runs/1' })
  })

  it('moves on at once once signed in, from the node’s own origin, with Continue as a fallback', async () => {
    const replaced: string[] = []
    draw({ state: 'signedIn', next: '/projects' }, (url) => replaced.push(url))
    await heading('Signed in')
    screen.getByText('Continuing to Mason…')
    assert.deepEqual(replaced, ['/projects'])
    assert.equal(
      screen.getByRole('link', { name: 'Continue' }).getAttribute('href'),
      '/projects',
    )
  })

  it('says why a sign-in failed or is unavailable, with the way back to sign in', async () => {
    draw({ state: 'failed', message: 'No Mason account has a@b.test for gh' })
    await heading('Sign-in failed')
    screen.getByText('No Mason account has a@b.test for gh')
    assert.equal(
      screen.getByRole('link', { name: 'Sign in again' }).getAttribute('href'),
      '/sign-in',
    )
    cleanup()
    draw({ state: 'unavailable' })
    await heading('Sign-in unavailable')
    screen.getByText(
      'This master offers only its username and password sign-in.',
    )
    assert.equal(
      screen.getByRole('link', { name: 'Sign in' }).getAttribute('href'),
      '/sign-in',
    )
    cleanup()
    draw({
      state: 'invalid',
      message: 'The request is invalid or has expired.',
    })
    await heading('Request could not be completed')
    assert.equal(
      screen.getByRole('link', { name: 'Sign in' }).getAttribute('href'),
      '/auth/login',
    )
  })

  it('asks a signed-in visitor before switching accounts, by a form post with the session’s proof', async () => {
    draw({
      state: 'switch',
      name: 'Tess Tester',
      provider: { id: 'team station', name: 'TeamStation' },
      csrf: 'proof',
      return: '/apps',
    })
    await heading('Switch account')
    screen.getByText('You are signed in as Tess Tester')
    screen.getByText('Continue to choose an account with TeamStation.')
    const form = screen
      .getByRole('button', { name: 'Continue and switch account' })
      .closest('form')!
    assert.equal(form.getAttribute('method'), 'post')
    assert.equal(form.getAttribute('action'), '/auth/switch/team%20station')
    assert.equal(
      (form.elements.namedItem('csrf') as HTMLInputElement).value,
      'proof',
    )
    assert.equal(
      (form.elements.namedItem('return') as HTMLInputElement).value,
      '/apps',
    )
    cleanup()
    draw({ state: 'switchUnavailable' })
    await heading('Switch account unavailable')
    screen.getByText(/does not have an account switching method configured/)
    cleanup()
    draw({
      state: 'chooseAccount',
      provider: 'TeamStation',
      target: 'https://id.example.test/authorize?prompt=select_account',
    })
    await heading('Choose an account')
    assert.equal(
      screen
        .getByRole('link', { name: 'Continue to TeamStation' })
        .getAttribute('href'),
      'https://id.example.test/authorize?prompt=select_account',
    )
  })

  it('is what the app draws when the node answered with one', async () => {
    const node = fakeNode({})
    render(
      <App
        node={nodeInfo('master')}
        client={new ApiClient({ signIn: '/sign-in', fetch: node.fetch })}
        flow={{ state: 'unavailable' }}
      />,
    )
    await heading('Sign-in unavailable')
    assert.deepEqual(node.requests, [])
    await act(async () => undefined)
  })
})
