import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { draftKey } from '../../../ui/LargeSheet.js'
import { until } from '../../../test/render.js'
import {
  card,
  held,
  HOST,
  MASTER,
  methodFixture,
  openSettings,
  recorder,
  requested,
  SIGN_IN,
  text,
  toasted,
} from '../../../test/settings.js'
import { methodBody, methodDraft, methodErrors } from './signIn.js'

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

describe('Settings → Sign-in', () => {
  it('lists each method with its kind, state and callback URLs on the host and master', async () => {
    openSettings()
    const signIn = await card(/^Sign-in/)
    const rows = await within(signIn).findAllByRole('listitem')
    assert.equal(rows.length, 2)
    assert.match(text(rows[0]!), /TeamStationteamstation · OpenID Connect/)
    within(rows[0]!).getByText('Enabled')
    within(rows[0]!).getByText('Admits testers')
    within(rows[0]!).getByText(
      'https://builds.example.com/auth/callback/teamstation',
    )
    within(rows[0]!).getByText(
      'https://mason-admin.example.com:9300/auth/callback/teamstation',
    )
    within(rows[0]!).getByText('Callback URLs to register with the provider:')
    assert.match(text(rows[1]!), /GitHubgithub · OAuth 2 · disabled/)
    within(rows[1]!).getByText('Disabled')
    within(rows[1]!).getByRole('button', { name: 'Edit GitHub' })
    assert.equal(text(signIn.querySelector('.m-count')), '2')
    const master = within(signIn).getByRole('textbox', {
      name: /^Master address/,
    })
    assert.equal(
      (master as HTMLInputElement).value,
      'https://mason-admin.example.com:9300',
    )
  })

  it('says None yet. and hints at the addresses when neither is set', async () => {
    openSettings({ [SIGN_IN]: { methods: [] }, [MASTER]: {}, [HOST]: {} })
    const signIn = await card(/^Sign-in/)
    await within(signIn).findByText('None yet.')
    cleanup()
    openSettings({ [MASTER]: {}, [HOST]: {} })
    const again = await card(/^Sign-in/)
    const hints = await within(again).findAllByText(
      'Set the host or master address to see the callback URL to register.',
    )
    assert.equal(hints.length, 2)
  })

  it('a manager reads the master address, with no editors', async () => {
    openSettings({}, 'manager')
    const signIn = await card(/^Sign-in/)
    await within(signIn).findByText(/Only an administrator changes sign-in\./)
    within(signIn).getByText('https://mason-admin.example.com:9300', {
      selector: '.m-settings__readonly *',
    })
    assert.equal(within(signIn).queryByRole('button', { name: /Edit/ }), null)
    assert.equal(within(signIn).queryByRole('button', { name: /Add an/ }), null)
    cleanup()
    openSettings({ [MASTER]: {} }, 'manager')
    const unset = await card(/^Sign-in/)
    await within(unset).findByText(/Master address: not set\./)
  })

  it('saves the master address, empty or https, and keeps a refusal', async () => {
    const save = recorder((_body, n) =>
      n === 1
        ? { status: 400, body: { error: 'No' } }
        : { status: 200, body: {} },
    )
    const app = openSettings({ [`PUT ${MASTER}`]: save.reply })
    const signIn = await card(/^Sign-in/)
    await within(signIn).findByRole('textbox', { name: /^Master address/ })
    const form = within(signIn).getByRole('form', { name: 'Master address' })
    type(form, /^Master address\(/, 'http://x')
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    within(form).getByText('Enter an https address, or leave it empty.')
    type(form, /^Master address\(/, 'https://m.example.com')
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await within(form).findByText('No')
    type(form, /^Master address\(/, '')
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await toasted('Master address saved')
    assert.deepEqual(save.bodies, [{ origin: 'https://m.example.com' }, {}])
    await until(
      () => app.node.requests.filter((r) => r === `GET ${MASTER}`).length === 2,
      'the master address read again',
    )
  })

  it('edits an OpenID Connect method in a large sheet, keeping the stored secret, with a draft', async () => {
    const save = held(200, { methods: [methodFixture()] })
    const app = openSettings({
      'PUT /api/v2/settings/signIn/methods/teamstation': save.reply,
    })
    const signIn = await card(/^Sign-in/)
    fireEvent.click(
      await within(signIn).findByRole('button', { name: 'Edit TeamStation' }),
    )
    const editor = await sheet(/Sign-in method teamstation/)
    assert.ok(
      editor.closest('.m-largesheet') ?? editor.querySelector('.m-largesheet'),
    )
    assert.deepEqual(
      [...editor.querySelectorAll('legend')].map(
        (legend) => legend.textContent,
      ),
      ['Availability', 'Provider'],
    )
    within(editor).getByText('OpenID Connect', { selector: '.m-chip' })
    const secret = within(editor).getByLabelText('Client secret')
    assert.equal(
      secret.getAttribute('placeholder'),
      'Leave empty to keep the stored secret',
    )
    assert.equal(
      (within(editor).getByLabelText('Signing algorithm') as HTMLSelectElement)
        .value,
      'RS256',
    )
    assert.equal(within(editor).queryByLabelText('Token endpoint'), null)
    type(editor, 'Display name', 'TeamStation SSO')
    type(editor, 'Client secret', 'hunter2')
    // The draft keeps the change but never the secret.
    const stored = JSON.parse(
      window.sessionStorage.getItem(draftKey('signIn:teamstation'))!,
    ) as Record<string, unknown>
    assert.equal(stored.name, 'TeamStation SSO')
    assert.equal(stored.clientSecret, undefined)
    type(editor, 'Client secret', '')
    fireEvent.click(within(editor).getByLabelText('Admit as testers'))
    fireEvent.change(within(editor).getByLabelText('Signing algorithm'), {
      target: { value: 'ES256' },
    })
    fireEvent.change(within(editor).getByLabelText('Client authentication'), {
      target: { value: 'basic' },
    })
    const button = within(editor).getByRole('button', { name: 'Save' })
    fireEvent.click(button)
    await requested(app, 'PUT /api/v2/settings/signIn/methods/teamstation')
    assert.equal(button.getAttribute('aria-busy'), 'true')
    await act(async () => save.release())
    await toasted('TeamStation SSO saved')
    assert.deepEqual(save.bodies[0], {
      type: 'oidc',
      enabled: true,
      admitTesters: false,
      name: 'TeamStation SSO',
      issuer: 'https://auth.teamstation.app',
      clientId: 'mason-prod',
      clientSecret: { keep: true },
      authentication: 'basic',
      signingAlgorithm: 'ES256',
    })
    await until(
      () => screen.queryByRole('dialog') == null,
      'the sheet to close',
    )
    assert.equal(
      window.sessionStorage.getItem(draftKey('signIn:teamstation')),
      null,
    )
  })

  it('restores a draft after a reload, asks before discarding it, and keeps a refusal in the sheet', async () => {
    window.sessionStorage.setItem(
      draftKey('signIn:teamstation'),
      JSON.stringify({ name: 'Restored' }),
    )
    openSettings({
      'PUT /api/v2/settings/signIn/methods/teamstation': {
        status: 400,
        body: { error: 'The issuer did not answer' },
      },
    })
    const signIn = await card(/^Sign-in/)
    fireEvent.click(
      await within(signIn).findByRole('button', { name: 'Edit TeamStation' }),
    )
    const editor = await sheet(/Sign-in method teamstation/)
    assert.equal(
      (within(editor).getByLabelText('Display name') as HTMLInputElement).value,
      'Restored',
    )
    within(editor).getByText(/Your unsaved changes were restored/)
    type(editor, 'Issuer URL', 'nope')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    within(editor).getByText('Enter an https address.')
    type(editor, 'Issuer URL', 'https://auth.example.com')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    await within(editor).findByText('The issuer did not answer')
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))
    const discard = await screen.findByRole('alertdialog')
    fireEvent.click(within(discard).getByRole('button', { name: 'Discard' }))
    await until(() => screen.queryByRole('dialog') == null, 'closed')
    assert.equal(
      window.sessionStorage.getItem(draftKey('signIn:teamstation')),
      null,
    )
  })

  it('edits an OAuth 2 method: its endpoints, scopes and claims collapsed in a disclosure', async () => {
    const save = recorder(() => ({ status: 200, body: { methods: [] } }))
    openSettings({
      'PUT /api/v2/settings/signIn/methods/github': save.reply,
    })
    const signIn = await card(/^Sign-in/)
    fireEvent.click(
      await within(signIn).findByRole('button', { name: 'Edit GitHub' }),
    )
    const editor = await sheet(/Sign-in method github/)
    const details = editor.querySelector('details')!
    assert.equal(details.open, false)
    assert.equal(within(editor).queryByLabelText('Signing algorithm'), null)
    type(editor, 'Token endpoint', 'http://bad')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    await until(() => details.open, 'the disclosure to open on its error')
    type(
      editor,
      'Token endpoint',
      'https://github.com/login/oauth/access_token',
    )
    type(editor, /^Scopes/, 'read:user, user:email, repo')
    type(editor, /^Email claim/, '')
    fireEvent.click(within(editor).getByLabelText('Enabled'))
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    await toasted('GitHub saved')
    assert.deepEqual(save.bodies[0], {
      type: 'oauth2',
      enabled: true,
      admitTesters: false,
      name: 'GitHub',
      issuer: 'https://github.com',
      clientId: 'Iv1.abc',
      clientSecret: { keep: true },
      authentication: 'post',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      userinfoEndpoint: 'https://api.github.com/user',
      scopes: ['read:user', 'user:email', 'repo'],
      claims: { subject: 'id', name: 'name' },
    })
  })

  it('adds an OpenID Connect method with its ID and a required secret', async () => {
    const save = recorder((_body, n) =>
      n === 1
        ? {
            status: 400,
            body: { error: 'A sign-in method named google already exists' },
          }
        : { status: 200, body: { methods: [] } },
    )
    openSettings({
      'PUT /api/v2/settings/signIn/methods/google': save.reply,
    })
    const signIn = await card(/^Sign-in/)
    fireEvent.click(
      await within(signIn).findByRole('button', {
        name: 'Add an OpenID Connect method',
      }),
    )
    const editor = await sheet(/Add an OpenID Connect method/)
    fireEvent.click(within(editor).getByRole('button', { name: 'Add' }))
    within(editor).getByText(
      'Use lowercase letters, digits and dashes, starting with a letter.',
    )
    within(editor).getByText('Enter the display name.')
    within(editor).getByText('Enter the client ID.')
    within(editor).getByText('Enter the client secret.')
    assert.equal(
      within(editor).queryByRole('button', { name: 'Remove method' }),
      null,
    )
    type(editor, 'ID', 'google')
    type(editor, 'Display name', 'Google')
    type(editor, 'Issuer URL', 'https://accounts.google.com')
    type(editor, 'Client ID', 'cid')
    type(editor, 'Client secret', 's3cret')
    fireEvent.click(within(editor).getByRole('button', { name: 'Add' }))
    await within(editor).findByText(
      'A sign-in method named google already exists',
    )
    fireEvent.click(within(editor).getByRole('button', { name: 'Add' }))
    await toasted('Google added')
    assert.deepEqual(save.bodies[1], {
      type: 'oidc',
      enabled: true,
      admitTesters: false,
      name: 'Google',
      issuer: 'https://accounts.google.com',
      clientId: 'cid',
      clientSecret: 's3cret',
      authentication: 'post',
      signingAlgorithm: 'RS256',
      create: true,
    })
  })

  it('adds an OAuth 2 method with its endpoints open', async () => {
    openSettings()
    const signIn = await card(/^Sign-in/)
    fireEvent.click(
      await within(signIn).findByRole('button', {
        name: 'Add an OAuth 2 method',
      }),
    )
    const editor = await sheet(/Add an OAuth 2 method/)
    assert.equal(editor.querySelector('details')!.open, true)
    fireEvent.click(within(editor).getByRole('button', { name: 'Add' }))
    assert.equal(
      within(editor).getAllByText('Enter an https address.').length,
      4,
    )
    within(editor).getByText('Enter the subject claim.')
  })

  it('removes a method after a tier-2 confirm; a refusal stays in the sheet', async () => {
    const remove = recorder((_body, n) =>
      n === 1
        ? { status: 404, body: { error: 'No sign-in method teamstation' } }
        : { status: 200, body: { methods: [] } },
    )
    const app = openSettings({
      'DELETE /api/v2/settings/signIn/methods/teamstation': remove.reply,
    })
    const signIn = await card(/^Sign-in/)
    fireEvent.click(
      await within(signIn).findByRole('button', { name: 'Edit TeamStation' }),
    )
    const editor = await sheet(/Sign-in method teamstation/)
    fireEvent.click(
      within(editor).getByRole('button', { name: 'Remove method' }),
    )
    const alert = await screen.findByRole('alertdialog')
    within(alert).getByText('Remove the sign-in method TeamStation?')
    within(alert).getByText(
      'People who sign in with TeamStation then use another method.',
    )
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(
      within(editor).getByRole('button', { name: 'Remove method' }),
    )
    const confirm = within(await screen.findByRole('alertdialog')).getByRole(
      'button',
      { name: 'Remove' },
    )
    assert.match(confirm.className, /m-btn--danger-filled/)
    fireEvent.click(confirm)
    await within(editor).findByText('No sign-in method teamstation')
    fireEvent.click(
      within(editor).getByRole('button', { name: 'Remove method' }),
    )
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Remove',
      }),
    )
    await toasted('TeamStation removed')
    await until(
      () =>
        app.node.requests.filter((r) => r === `GET ${SIGN_IN}`).length === 2,
      'the methods read again',
    )
  })

  it('shows Retry when the methods could not be read', async () => {
    const app = openSettings({
      [SIGN_IN]: { status: 500, body: { error: 'Down' } },
    })
    const signIn = await card(/^Sign-in/)
    await within(signIn).findByText(
      /The sign-in methods could not be read: Down/,
    )
    app.node.set(SIGN_IN, { methods: [] })
    fireEvent.click(within(signIn).getByRole('button', { name: 'Retry' }))
    await within(signIn).findByText('None yet.')
  })

  it('turns fields into the route’s body and checks them', () => {
    const draft = methodDraft(undefined)
    assert.equal(draft.authentication, 'post')
    assert.equal(draft.signingAlgorithm, 'RS256')
    assert.deepEqual(Object.keys(methodErrors(draft, 'oidc', false)), [
      'name',
      'issuer',
      'clientId',
    ])
    assert.deepEqual(
      methodBody(
        { ...draft, claimVerified: 'ev', subject: 's' },
        'oauth2',
        false,
      ).claims,
      { subject: 's', emailVerified: 'ev' },
    )
  })
})
