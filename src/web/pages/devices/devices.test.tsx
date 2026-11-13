import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import type { DeviceInfo, DevicesData } from '../../../shared/api/index.js'
import { crumbs, heading, recorder, requested, text } from '../../test/admin.js'
import {
  nodeInfo,
  renderApp,
  shellReplies,
  until,
  where,
  type Reply,
} from '../../test/render.js'
import { REGISTERING_REFRESH_MS } from './Complete.js'
import { changes, deviceStatus, DEVICES_REFRESH_MS } from './Devices.js'

const NOW = Date.now()
const DEVICES = '/api/v2/devices'

afterEach(() => cleanup())

type Device = DeviceInfo & { name: string }

const device = (
  id: number,
  status: Device['status'],
  fields: Partial<Device> = {},
): Device => ({
  id,
  udid: `00008110-00000000000000${id}`,
  product: 'iPhone16,1',
  model: 'iPhone16,1',
  os_version: '18.1',
  status,
  message: status === 'registered' ? 'Builds are ready.' : '',
  created_at: NOW,
  updated_at: NOW,
  name: `iPhone ${id} of Tess`,
  ...fields,
})

const devices = (fields: Partial<DevicesData> = {}): DevicesData => ({
  devices: [],
  registration: true,
  all: [],
  ...fields,
})

/** Devices at an address, for a role on a node, with these answers. */
const open = (
  replies: Record<string, Reply>,
  node: 'master' | 'host' = 'host',
  role: 'tester' | 'admin' = 'tester',
  path = '/devices',
): ReturnType<typeof renderApp> =>
  renderApp({
    node: nodeInfo(node),
    path,
    replies: shellReplies(role, node, replies),
  })

/** Runs a test with setInterval recorded: each timer's period and callback. */
async function withTimers(
  run: (timers: Array<{ ms: number; tick: () => void }>) => Promise<void>,
): Promise<void> {
  const timers: Array<{ ms: number; tick: () => void }> = []
  const real = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = ((tick: () => void, ms: number) => {
    timers.push({ ms, tick })
    return timers.length as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = (() => undefined) as typeof clearInterval
  try {
    await run(timers)
  } finally {
    globalThis.setInterval = real
    globalThis.clearInterval = realClear
  }
}

describe('Devices', () => {
  it('shows how to register directly, the QR code, and downloads the registration profile once per press', async () => {
    const app = open({
      [DEVICES]: devices(),
      'POST /api/v2/devices/registrations': {
        url: '/devices/profiles/abc',
        expiresAt: NOW + 300_000,
      },
    })
    await heading('Devices')
    assert.deepEqual(crumbs(), ['Mason Host', 'Devices'])
    const card = await screen.findByRole('region', {
      name: 'Register an iPhone or iPad',
    })
    assert.deepEqual(
      [...card.querySelectorAll('.m-howto > li .m-t-headline')].map(text),
      [
        'Open this page in Safari on the device',
        'Install the registration profile',
        'Settings → Profile Downloaded → Install',
      ],
    )
    within(card).getByText(/It does not install a root certificate/)
    within(card).getByText(/Apple removes uninstalled downloads after eight/)
    within(card).getByText(/Android and desktop apps can be downloaded/)
    const qr = within(card).getByRole('img', {
      name: 'QR code to open Mason device registration',
    })
    assert.equal(qr.getAttribute('src'), '/devices/qr')
    await act(async () =>
      within(card)
        .getByRole('button', { name: 'Install registration profile' })
        .click(),
    )
    await until(() => app.left.length === 1, 'the profile download')
    assert.deepEqual(app.left, ['/devices/profiles/abc'])
    await screen.findByText(/Its link works once, for five minutes/)
    assert.equal(
      screen.getByRole('link', { name: /Browse apps/ }).getAttribute('href'),
      '/apps',
    )
  })

  it('says why a registration profile could not be made', async () => {
    open({
      [DEVICES]: devices(),
      'POST /api/v2/devices/registrations': {
        status: 403,
        body: { error: 'Tester access required' },
      },
    })
    const press = await screen.findByRole('button', {
      name: 'Install registration profile',
    })
    await act(async () => press.click())
    await screen.findByText('Tester access required')
  })

  it('sends registration to the host’s own page without a public master address, and says when it is not configured', async () => {
    open({ [DEVICES]: devices({ via: 'https://host.example.test' }) }, 'master')
    const link = await screen.findByRole('link', {
      name: /Register on the host/,
    })
    assert.equal(link.getAttribute('href'), 'https://host.example.test/devices')
    screen.getByText(/Installs on iPhone and iPad go through the host/)
    screen.getByRole('img', {
      name: 'QR code to open Mason device registration',
    })
    cleanup()
    open({ [DEVICES]: devices({ registration: false }) })
    await screen.findByRole('heading', {
      name: 'Device registration is being configured',
    })
    screen.getByText('Please try again shortly.')
    assert.equal(
      screen.queryByRole('button', { name: 'Install registration profile' }),
      null,
    )
  })

  it('draws each device with its state, the selected one marked, and every registered device for an administrator', async () => {
    open(
      {
        [DEVICES]: devices({
          devices: [
            device(1, 'registered'),
            device(2, 'processing'),
            device(3, 'error', { message: 'Apple refused the device.' }),
          ],
          selected: 1,
          all: [
            {
              name: 'iPhone 1 of Tess',
              model: 'iPhone16,1',
              status: 'registered',
            },
            { name: 'iPad of Ada', model: 'iPad13,16', status: 'pending' },
          ],
        }),
      },
      'master',
      'admin',
    )
    const first = await screen.findByRole('article', {
      name: 'iPhone 1 of Tess',
    })
    assert.match(first.className, /m-card--selected/)
    within(first).getByText('Selected')
    within(first).getByText('Registered with Apple')
    within(first).getByText('iPhone16,1 · iOS 18.1')
    within(first).getByText('Device identifier: 00008110-000000000000001')
    assert.equal(
      within(first).queryByRole('button', { name: 'Use this device' }),
      null,
    )
    const second = screen.getByRole('article', { name: 'iPhone 2 of Tess' })
    within(second).getByText('Apple registration is processing')
    within(second).getByRole('button', { name: 'Use this device' })
    assert.equal(
      within(second).queryByRole('button', { name: 'Retry preparation' }),
      null,
    )
    const third = screen.getByRole('article', { name: 'iPhone 3 of Tess' })
    within(third).getByText('Preparation needs attention')
    within(third).getByText('Apple refused the device.')
    within(third).getByRole('button', { name: 'Retry preparation' })
    // While one is with Apple, the page says it checks again.
    screen.getByText(/this page checks again every 15 seconds/)
    const all = screen.getByRole('region', { name: /All registered devices/ })
    assert.deepEqual(within(all).getAllByRole('listitem').map(text), [
      'iPhone 1 of TessiPhone16,1Registered with Apple',
      'iPad of AdaiPad13,16Waiting to register with Apple',
    ])
  })

  it('selects, renames, retries and removes a device, each answered with the devices', async () => {
    const select = recorder(() => ({
      status: 200,
      body: devices({
        devices: [device(1, 'registered'), device(3, 'error')],
        selected: 3,
      }),
    }))
    const rename = recorder((body) => ({
      status: 200,
      body: devices({
        devices: [
          device(1, 'registered'),
          device(3, 'error', { name: (body as { name: string }).name }),
        ],
        selected: 3,
      }),
    }))
    const retry = recorder(() => ({
      status: 200,
      body: devices({
        devices: [
          device(1, 'registered'),
          device(3, 'pending', { name: 'Work' }),
        ],
        selected: 3,
      }),
    }))
    const remove = recorder(() => ({
      status: 200,
      body: devices({ devices: [device(1, 'registered')] }),
    }))
    const app = open({
      [DEVICES]: devices({
        devices: [device(1, 'registered'), device(3, 'error')],
        selected: 1,
      }),
      'POST /api/v2/devices/3/select': select.reply,
      'POST /api/v2/devices/3/rename': rename.reply,
      'POST /api/v2/devices/3/retry': retry.reply,
      'POST /api/v2/devices/3/remove': remove.reply,
    })
    let card = await screen.findByRole('article', { name: 'iPhone 3 of Tess' })
    await act(async () =>
      within(card).getByRole('button', { name: 'Use this device' }).click(),
    )
    await screen.findByText('iPhone 3 of Tess selected')
    card = screen.getByRole('article', { name: 'iPhone 3 of Tess' })
    within(card).getByText('Selected')
    // Rename inline: an empty name is refused, Cancel puts it back.
    await act(async () =>
      within(card)
        .getByRole('button', { name: 'Rename iPhone 3 of Tess' })
        .click(),
    )
    const field = within(card).getByRole('textbox', { name: 'Device name' })
    fireEvent.change(field, { target: { value: '  ' } })
    await act(async () =>
      within(card).getByRole('button', { name: 'Save name' }).click(),
    )
    within(card).getByText('Enter a name.')
    assert.equal(rename.bodies.length, 0)
    await act(async () =>
      within(card).getByRole('button', { name: 'Cancel' }).click(),
    )
    assert.equal(within(card).queryByRole('textbox'), null)
    await act(async () =>
      within(card)
        .getByRole('button', { name: 'Rename iPhone 3 of Tess' })
        .click(),
    )
    fireEvent.change(
      within(card).getByRole('textbox', { name: 'Device name' }),
      { target: { value: 'Work' } },
    )
    await act(async () =>
      within(card).getByRole('button', { name: 'Save name' }).click(),
    )
    await screen.findByText('Renamed to Work')
    assert.deepEqual(rename.bodies, [{ name: 'Work' }])
    card = screen.getByRole('article', { name: 'Work' })
    await until(
      () =>
        document.activeElement ===
        within(card).getByRole('button', { name: 'Rename Work' }),
      'focus back on Rename',
    )
    await act(async () =>
      within(card).getByRole('button', { name: 'Retry preparation' }).click(),
    )
    await screen.findByText('Preparing Work again')
    // Remove asks first, in an alert.
    card = screen.getByRole('article', { name: 'Work' })
    await act(async () =>
      within(card).getByRole('button', { name: 'Remove Work' }).click(),
    )
    const alert = await screen.findByRole('alertdialog', {
      name: 'Remove Work?',
    })
    within(alert).getByText(/It leaves your account/)
    await act(async () =>
      within(alert).getByRole('button', { name: 'Cancel' }).click(),
    )
    assert.equal(remove.bodies.length, 0)
    await act(async () =>
      within(card).getByRole('button', { name: 'Remove Work' }).click(),
    )
    const confirm = within(
      await screen.findByRole('alertdialog', { name: 'Remove Work?' }),
    ).getByRole('button', { name: 'Remove' })
    await act(async () => confirm.click())
    await screen.findByText('Work removed')
    await until(
      () => screen.queryByRole('article', { name: 'Work' }) == null,
      'the device gone',
    )
    await requested(app, 'POST /api/v2/devices/3/remove')
  })

  it('says why a device action failed', async () => {
    open({
      [DEVICES]: devices({ devices: [device(3, 'registered')] }),
      'POST /api/v2/devices/3/select': {
        status: 404,
        body: { error: 'Device unavailable' },
      },
    })
    const card = await screen.findByRole('article', {
      name: 'iPhone 3 of Tess',
    })
    await act(async () =>
      within(card).getByRole('button', { name: 'Use this device' }).click(),
    )
    await screen.findByText('iPhone 3 of Tess: Device unavailable')
  })

  it('reads itself every 15 seconds while a device is with Apple, and says politely what changed', async () => {
    await withTimers(async (timers) => {
      const app = open({
        [DEVICES]: devices({ devices: [device(2, 'processing')] }),
      })
      await screen.findByRole('article', { name: 'iPhone 2 of Tess' })
      await until(
        () => timers.some((timer) => timer.ms === DEVICES_REFRESH_MS),
        'the refresh timer',
      )
      app.node.set(DEVICES, devices({ devices: [device(2, 'registered')] }))
      await act(async () => {
        timers.find((timer) => timer.ms === DEVICES_REFRESH_MS)!.tick()
      })
      const live = document.querySelector('main [role="status"].m-sr')!
      assert.equal(live.getAttribute('aria-live'), 'polite')
      await until(
        () => live.textContent === 'iPhone 2 of Tess: Registered with Apple',
        'the announcement',
      )
      assert.equal(
        app.node.requests.filter((request) => request === `GET ${DEVICES}`)
          .length,
        2,
      )
      assert.equal(screen.queryByText(/checks again every 15 seconds/), null)
    })
  })

  it('says when Devices cannot be read', async () => {
    open({
      [DEVICES]: { status: 503, body: { error: 'Mason is busy' } },
    })
    await screen.findByRole('heading', {
      name: 'The request could not be completed',
    })
  })

  it('names the states and what changed between two reads', () => {
    assert.equal(deviceStatus('error'), 'attention')
    assert.equal(deviceStatus('pending'), 'pending')
    assert.deepEqual(
      changes(
        devices({ devices: [device(1, 'pending'), device(2, 'processing')] }),
        devices({
          devices: [
            device(1, 'pending'),
            device(2, 'error'),
            device(3, 'registered'),
          ],
        }),
      ),
      ['iPhone 2 of Tess: Preparation needs attention'],
    )
  })
})

describe('A device’s registration link', () => {
  const COMPLETE = '/api/v2/devices/complete/tok'

  it('says the device is registered, with its model for people and what happens next', async () => {
    open(
      {
        [COMPLETE]: {
          state: 'registered',
          device: { id: 4, model: 'iPhone15Pro' },
        },
      },
      'host',
      'tester',
      '/devices/complete/tok',
    )
    await heading('Device registered')
    assert.deepEqual(crumbs(), ['Mason Host', 'Devices', 'Device registered'])
    await screen.findByRole('heading', {
      name: 'Your iPhone 15 Pro is registered',
    })
    screen.getByText(/30 to 60 minutes/)
    screen.getByText('iPhone 15 Pro')
    assert.equal(
      screen.getByRole('link', { name: /Browse apps/ }).getAttribute('href'),
      '/apps',
    )
    assert.equal(
      screen
        .getByRole('link', { name: 'View your devices' })
        .getAttribute('href'),
      '/devices',
    )
  })

  it('reads itself every five seconds while registering, then says it is registered', async () => {
    await withTimers(async (timers) => {
      const app = open(
        { [COMPLETE]: { state: 'registering' } },
        'host',
        'tester',
        '/devices/complete/tok',
      )
      await screen.findByRole('heading', { name: 'Registering your device' })
      screen.getByText(/This page updates by itself/)
      await until(
        () => timers.some((timer) => timer.ms === REGISTERING_REFRESH_MS),
        'the refresh timer',
      )
      app.node.set(COMPLETE, {
        state: 'registered',
        device: { id: 4, model: 'iPadPro11' },
      })
      await act(async () => {
        timers.find((timer) => timer.ms === REGISTERING_REFRESH_MS)!.tick()
      })
      await screen.findByRole('heading', {
        name: 'Your iPad Pro11 is registered',
      })
    })
  })

  it('says the link is unavailable, or why it cannot be read', async () => {
    open(
      { [COMPLETE]: { state: 'unavailable' } },
      'host',
      'tester',
      '/devices/complete/tok',
    )
    await screen.findByRole('heading', {
      name: 'The registration link is unavailable',
    })
    assert.equal(
      screen
        .getByRole('link', { name: /Register device/ })
        .getAttribute('href'),
      '/devices',
    )
    cleanup()
    open(
      {
        [COMPLETE]: { status: 403, body: { error: 'Tester access required' } },
      },
      'host',
      'tester',
      '/devices/complete/tok',
    )
    await screen.findByRole('heading', { name: 'Waiting for tester access' })
    assert.equal(where.path, '/devices/complete/tok')
  })
})
