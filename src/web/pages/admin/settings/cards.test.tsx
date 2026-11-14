import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { until } from '../../../test/render.js'
import {
  card,
  CLOUD,
  GITHUB,
  held,
  HOST,
  openSettings,
  recorder,
  requested,
  text,
  toasted,
} from '../../../test/settings.js'
import { nowText } from './github.js'
import { hostSentence } from './host.js'

afterEach(() => cleanup())

const type = (
  scope: HTMLElement,
  label: string | RegExp,
  value: string,
): void => {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } })
}

describe('Settings → GitHub', () => {
  it('opens on the connection in use and saves a GitHub App, keeping the stored key when left empty', async () => {
    const save = recorder((_body, n) =>
      n === 1
        ? {
            status: 400,
            body: { error: 'GitHub refused the app installation' },
          }
        : { status: 200, body: { kind: 'app', appId: 7, installationId: 9 } },
    )
    const app = openSettings({ [`PUT ${GITHUB}`]: save.reply })
    const github = await card('GitHub')
    await within(github).findByLabelText('App ID')
    assert.equal(
      text(github.querySelector('.m-card__header')),
      'GitHubNow: a GitHub App.',
    )
    const radios = within(github).getAllByRole('radio') as HTMLInputElement[]
    assert.deepEqual(
      radios.map((radio) => radio.checked),
      [false, true, false],
    )
    assert.equal(
      (within(github).getByLabelText('App ID') as HTMLInputElement).value,
      '1048213',
    )
    assert.equal(
      within(github).getByLabelText('Private key').getAttribute('placeholder'),
      'Leave empty to keep the stored key',
    )
    type(github, 'App ID', 'x')
    fireEvent.click(within(github).getByRole('button', { name: 'Save' }))
    within(github).getByText('Enter the App ID.')
    type(github, 'App ID', '7')
    type(github, 'Installation ID', '9')
    fireEvent.click(within(github).getByRole('button', { name: 'Save' }))
    await within(github).findByText('GitHub refused the app installation')
    type(github, 'Private key', '-----BEGIN KEY-----')
    fireEvent.click(within(github).getByRole('button', { name: 'Save' }))
    await toasted('GitHub App saved')
    assert.deepEqual(save.bodies, [
      { kind: 'app', appId: 7, installationId: 9, privateKey: { keep: true } },
      {
        kind: 'app',
        appId: 7,
        installationId: 9,
        privateKey: '-----BEGIN KEY-----',
      },
    ])
    await until(
      () => app.node.requests.filter((r) => r === `GET ${GITHUB}`).length === 2,
      'GitHub read again',
    )
  })

  it('needs a token, an App’s ids and key when none is stored; a token is write-only', async () => {
    const save = held(200, { kind: 'token', token: { set: true } })
    const app = openSettings({ [GITHUB]: {}, [`PUT ${GITHUB}`]: save.reply })
    const github = await card('GitHub')
    await within(github).findByText(/Not set up yet\./, {
      selector: '.m-card__body p',
    })
    const token = within(github).getByLabelText('Token')
    assert.equal(token.getAttribute('type'), 'password')
    assert.equal(token.getAttribute('autocomplete'), 'off')
    assert.ok(!token.getAttribute('placeholder'))
    const saveButton = within(github).getByRole('button', { name: 'Save' })
    fireEvent.click(saveButton)
    within(github).getByText('Enter the token.')
    type(github, 'Token', 'ghp_abc')
    fireEvent.click(saveButton)
    await requested(app, `PUT ${GITHUB}`)
    assert.equal(saveButton.getAttribute('aria-busy'), 'true')
    await act(async () => save.release())
    await toasted('GitHub token saved')
    assert.deepEqual(save.bodies[0], { kind: 'token', token: 'ghp_abc' })
    // A GitHub App without a stored key asks for every field.
    fireEvent.click(within(github).getByRole('radio', { name: /GitHub App/ }))
    fireEvent.click(within(github).getByRole('button', { name: 'Save' }))
    within(github).getByText('Enter the App ID.')
    within(github).getByText('Enter the installation ID.')
    within(github).getByText('Paste the private key.')
  })

  it('keeps a stored token when left empty', async () => {
    const save = recorder(() => ({ status: 200, body: { kind: 'token' } }))
    openSettings({
      [GITHUB]: { kind: 'token', token: { set: true } },
      [`PUT ${GITHUB}`]: save.reply,
    })
    const github = await card('GitHub')
    const token = await within(github).findByLabelText('Token')
    assert.equal(
      token.getAttribute('placeholder'),
      'Leave empty to keep the stored token',
    )
    fireEvent.click(within(github).getByRole('button', { name: 'Save' }))
    await toasted('GitHub token saved')
    assert.deepEqual(save.bodies[0], { kind: 'token', token: { keep: true } })
  })

  it('uses a deploy key, then shows it to copy and makes a new one after a confirm', async () => {
    const save = recorder((_body, n) =>
      n === 3
        ? { status: 400, body: { error: 'Could not make a key' } }
        : { status: 200, body: { kind: 'ssh' } },
    )
    const app = openSettings({ [`PUT ${GITHUB}`]: save.reply })
    const github = await card('GitHub')
    await within(github).findByLabelText('App ID')
    fireEvent.click(
      within(github).getByRole('radio', { name: /SSH deploy key/ }),
    )
    within(github).getByText(/Mason makes a key pair/)
    app.node.set(GITHUB, {
      kind: 'ssh',
      privateKey: { set: true },
      publicKey: 'ssh-ed25519 AAAAC3Nza mason@bern',
    })
    fireEvent.click(
      within(github).getByRole('button', { name: 'Use a deploy key' }),
    )
    await toasted('Mason uses a deploy key now')
    assert.deepEqual(save.bodies[0], { kind: 'ssh' })
    await within(github).findByText('ssh-ed25519 AAAAC3Nza mason@bern')
    within(github).getByText(/· in use/)
    fireEvent.click(within(github).getByRole('button', { name: 'Save' }))
    await toasted('Deploy key saved')
    assert.deepEqual(save.bodies[1], {
      kind: 'ssh',
      privateKey: { keep: true },
    })
    fireEvent.click(
      within(github).getByRole('button', { name: 'Make a new deploy key' }),
    )
    const alert = await screen.findByRole('alertdialog')
    within(alert).getByText('Make a new deploy key?')
    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }))
    await until(() => screen.queryByRole('alertdialog') == null, 'closed')
    fireEvent.click(
      within(github).getByRole('button', { name: 'Make a new deploy key' }),
    )
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Make a new deploy key',
      }),
    )
    await within(github).findByText('Could not make a key')
    assert.deepEqual(save.bodies[2], { kind: 'ssh' })
  })

  it('shows Retry when GitHub could not be read', async () => {
    const app = openSettings({
      [GITHUB]: { status: 500, body: { error: 'Nope' } },
    })
    const github = await card('GitHub')
    await within(github).findByText(
      /The GitHub connection could not be read: Nope/,
    )
    app.node.set(GITHUB, {})
    fireEvent.click(within(github).getByRole('button', { name: 'Retry' }))
    await within(github).findByLabelText('Token')
    assert.equal(nowText('ssh'), 'Now: an SSH deploy key.')
    assert.equal(nowText('token'), 'Now: a personal access token.')
  })
})

describe('Settings → Host', () => {
  it('an administrator saves the addresses and grace hours, each checked first', async () => {
    const save = recorder((_body, n) =>
      n === 1
        ? { status: 400, body: { error: 'The host address is not https' } }
        : { status: 200, body: { origin: 'https://b.example.com' } },
    )
    openSettings({ [`PUT ${HOST}`]: save.reply })
    const host = await card('Host')
    const origin = await within(host).findByLabelText('Host address')
    assert.equal(
      (origin as HTMLInputElement).value,
      'https://builds.example.com',
    )
    assert.equal(
      (within(host).getByLabelText(/Offline grace hours/) as HTMLInputElement)
        .value,
      '72',
    )
    within(host).getByText(
      'How long the host keeps serving installs while it cannot reach the master. 1–720.',
    )
    type(host, 'Host address', 'http://nope')
    type(host, /Worker address/, 'ftp://x')
    type(host, /Offline grace hours/, '900')
    fireEvent.click(within(host).getByRole('button', { name: 'Save' }))
    within(host).getByText('Enter an https address.')
    within(host).getByText('Enter an https address, or leave it empty.')
    within(host).getByText('Enter whole hours from 1 to 720.')
    type(host, 'Host address', 'https://b.example.com')
    type(host, /Worker address/, '')
    type(host, /Offline grace hours/, '24')
    fireEvent.click(within(host).getByRole('button', { name: 'Save' }))
    await within(host).findByText('The host address is not https')
    type(host, /Worker address/, 'https://10.0.0.5:9310')
    fireEvent.click(within(host).getByRole('button', { name: 'Save' }))
    await toasted('Host saved')
    assert.deepEqual(save.bodies, [
      { origin: 'https://b.example.com', offlineGraceHours: 24 },
      {
        origin: 'https://b.example.com',
        workerOrigin: 'https://10.0.0.5:9310',
        offlineGraceHours: 24,
      },
    ])
  })

  it('a manager reads the host as a sentence, without a form', async () => {
    openSettings(
      {
        [HOST]: {
          origin: 'https://b.example.com',
          workerOrigin: 'https://w.example.com',
        },
      },
      'manager',
    )
    const host = await card('Host')
    await within(host).findByText(
      'Host address: https://b.example.com; workers reach it at https://w.example.com; it serves from its cache for 72 hours without the master. Invitation links open there, so only an administrator changes it.',
    )
    within(host).getByText('Administrators change this')
    assert.equal(within(host).queryByRole('button', { name: 'Save' }), null)
    assert.equal(
      hostSentence({}),
      'Host address: not set; it serves from its cache for 72 hours without the master. Invitation links open there, so only an administrator changes it.',
    )
  })

  it('shows Retry when the host could not be read', async () => {
    const app = openSettings({
      [HOST]: { status: 500, body: { error: 'Gone' } },
    })
    const host = await card('Host')
    await within(host).findByText(/The host could not be read: Gone/)
    app.node.set(HOST, {})
    fireEvent.click(within(host).getByRole('button', { name: 'Retry' }))
    const origin = await within(host).findByLabelText('Host address')
    assert.equal((origin as HTMLInputElement).value, '')
  })
})

describe('Settings → Cloud budget', () => {
  it('saves the monthly budget, checked first, busy while it saves', async () => {
    const save = held(200, { monthlyBudget: 300 })
    const app = openSettings({
      'PUT /api/v2/settings/cloud/budget': save.reply,
    })
    const budget = await card('Cloud budget')
    const field = await within(budget).findByLabelText(
      'Monthly budget (dollars)',
    )
    assert.equal((field as HTMLInputElement).value, '200')
    within(budget).getByRole('link', { name: 'Nodes' })
    within(budget).getByRole('link', { name: 'Cloud' })
    type(budget, 'Monthly budget (dollars)', '-1')
    fireEvent.click(within(budget).getByRole('button', { name: 'Save' }))
    within(budget).getByText('Enter dollars, 0 or more.')
    type(budget, 'Monthly budget (dollars)', '300')
    const button = within(budget).getByRole('button', { name: 'Save' })
    fireEvent.click(button)
    await requested(app, 'PUT /api/v2/settings/cloud/budget')
    assert.equal(button.getAttribute('aria-busy'), 'true')
    await act(async () => save.release())
    await toasted('Monthly budget is $300')
    assert.deepEqual(save.bodies[0], { monthlyBudget: 300 })
  })

  it('defaults to 200, keeps a refusal in the card, and shows Retry after a failed read', async () => {
    openSettings({
      [CLOUD]: {},
      'PUT /api/v2/settings/cloud/budget': {
        status: 400,
        body: { error: 'monthlyBudget is a number of dollars' },
      },
    })
    const budget = await card('Cloud budget')
    const field = await within(budget).findByLabelText(
      'Monthly budget (dollars)',
    )
    assert.equal((field as HTMLInputElement).value, '200')
    fireEvent.click(within(budget).getByRole('button', { name: 'Save' }))
    await within(budget).findByText('monthlyBudget is a number of dollars')
    cleanup()
    const app = openSettings({ [CLOUD]: { status: 500, body: { error: 'X' } } })
    const failed = await card('Cloud budget')
    await within(failed).findByText(/The cloud budget could not be read: X/)
    app.node.set(CLOUD, { monthlyBudget: 50 })
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }))
    const again = await within(failed).findByLabelText(
      'Monthly budget (dollars)',
    )
    assert.equal((again as HTMLInputElement).value, '50')
  })
})
