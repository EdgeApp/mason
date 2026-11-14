import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import {
  HOST_UNREACHABLE_ERROR,
  NO_HOST_ERROR,
  type AppData,
  type BranchData,
  type CatalogBuild,
} from '../../../shared/api/index.js'
import { branchKey } from '../../../shared/catalog.js'
import { ApiError } from '../../api/client.js'
import {
  crumbs,
  heading,
  held,
  recorder,
  requested,
  text,
} from '../../test/admin.js'
import {
  nodeInfo,
  renderApp,
  shellReplies,
  until,
  where,
  type Reply,
} from '../../test/render.js'
import { initials } from './Apps.js'
import { actionFor, NO_IOS_ADDRESS } from './Branch.js'
import { platformPreference, refusalOf, rememberPlatform } from './catalog.js'

const NOW = Date.now()
const APPS = '/api/v2/catalog/apps'
const KEY = branchKey('paul/offline')
const APP = '/api/v2/catalog/apps/7'
const BRANCH = `/api/v2/catalog/apps/7/branches/${KEY}`
const alpha = { id: 7, name: 'Team Station', slug: 'app.teamstation' }

afterEach(() => {
  cleanup()
  document.cookie = 'mason-platform=; Path=/; Max-Age=0'
})

/** The catalog at an address, for a role on a node, with these answers. */
const open = (
  path: string,
  replies: Record<string, Reply>,
  node: 'master' | 'host' = 'host',
  role: 'tester' | 'admin' = 'tester',
): ReturnType<typeof renderApp> =>
  renderApp({
    node: nodeInfo(node),
    path,
    replies: shellReplies(role, node, replies),
  })

const build = (fields: Partial<CatalogBuild> = {}): CatalogBuild => ({
  id: 100,
  platform: 'ios',
  format: 'ipa',
  version: '4.18.3',
  buildNumber: '26110902',
  commit: 'ec24b917a1b2c3d4e5f60718293a4b5c6d7e8f90',
  publishedAt: NOW - 60_000,
  size: 84_100_000,
  variant: '',
  run: null,
  eligible: true,
  ...fields,
})

const branch = (fields: Partial<BranchData> = {}): BranchData => ({
  app: alpha,
  platforms: ['android', 'ios'],
  branch: 'paul/offline',
  builds: [],
  device: false,
  ios: { via: 'here' },
  ...fields,
})

const appData = (fields: Partial<AppData> = {}): AppData => ({
  app: alpha,
  platforms: ['ios', 'android'],
  branches: [
    { name: 'master', time: NOW - 3_600_000 },
    { name: 'paul/offline', time: NOW - 60_000 },
  ],
  latest: { ios: NOW - 60_000, android: NOW - 3_600_000 },
  ...fields,
})

describe('Install apps', () => {
  it('lists the viewer’s apps for the chosen platform, each opening its branches', async () => {
    open('/apps?platform=android', {
      [APPS]: {
        apps: [alpha, { id: 8, name: 'tv', slug: 'app.teamstation.tv' }],
        platforms: ['ios', 'tvos', 'android'],
      },
    })
    await heading('Install apps')
    screen.getByText('Choose an app to browse recent builds.')
    const nav = await screen.findByRole('navigation', {
      name: 'Build platform',
    })
    // The switch lists the apps' platforms in Mason's order.
    assert.deepEqual(
      within(nav)
        .getAllByRole('link')
        .map((link) => text(link)),
      ['iOS', 'Android', 'tvOS'],
    )
    assert.equal(
      within(nav)
        .getByRole('link', { name: /Android/ })
        .getAttribute('aria-current'),
      'true',
    )
    const list = screen.getByRole('region', { name: /^Apps/ })
    const rows = within(list).getAllByRole('link')
    assert.deepEqual(rows.map(text), [
      'TSTeam Stationapp.teamstation',
      'Ttvapp.teamstation.tv',
    ])
    assert.equal(rows[0]!.getAttribute('href'), '/apps/7?platform=android')
    // Choosing a platform keeps the page and remembers the choice.
    await act(async () =>
      within(nav).getByRole('link', { name: /tvOS/ }).click(),
    )
    await until(() => where.path === '/apps?platform=tvos', 'tvOS')
    assert.equal(platformPreference(), 'tvos')
    assert.equal(
      screen
        .getAllByRole('link', { name: /Team Station/ })[0]!
        .getAttribute('href'),
      '/apps/7?platform=tvos',
    )
  })

  it('names the platform in the address from the remembered choice, and says when there are no apps', async () => {
    rememberPlatform('macos')
    open('/apps', { [APPS]: { apps: [], platforms: [] } })
    await screen.findByText('No apps have been configured yet.')
    await until(() => where.path === '/apps?platform=macos', 'macOS')
    assert.equal(
      screen.queryByRole('navigation', { name: 'Build platform' }),
      null,
    )
    assert.deepEqual(crumbs(), ['Mason Host', 'Install apps'])
  })

  it('makes initials for an app’s tile', () => {
    assert.equal(initials('Team Station'), 'TS')
    assert.equal(initials('app.teamstation.tv'), 'AT')
    assert.equal(initials('   '), '?')
  })

  it('says why the catalog cannot be read: tester access, the master’s host missing or away, a host catching up', async () => {
    open('/apps', {
      [APPS]: { status: 403, body: { error: 'Tester access required' } },
    })
    await screen.findByRole('heading', { name: 'Waiting for tester access' })
    screen.getByText(/A Mason administrator needs to grant you tester access/)
    cleanup()
    open(
      '/apps',
      { [APPS]: { status: 503, body: { error: NO_HOST_ERROR } } },
      'master',
      'admin',
    )
    await screen.findByRole('heading', { name: 'No host is linked yet' })
    assert.equal(
      within(document.querySelector('main')!)
        .getByRole('link', { name: /Nodes/ })
        .getAttribute('href'),
      '/nodes',
    )
    cleanup()
    // A tester cannot read Nodes: no link to it.
    open(
      '/apps',
      { [APPS]: { status: 503, body: { error: NO_HOST_ERROR } } },
      'master',
    )
    await screen.findByRole('heading', { name: 'No host is linked yet' })
    assert.equal(
      within(document.querySelector('main')!).queryByRole('link', {
        name: 'Nodes',
      }),
      null,
    )
    cleanup()
    const app = open(
      '/apps',
      { [APPS]: { status: 503, body: { error: HOST_UNREACHABLE_ERROR } } },
      'master',
    )
    await screen.findByRole('heading', { name: 'The host is unreachable' })
    app.node.set(APPS, { apps: [alpha], platforms: ['ios'] })
    await act(async () =>
      screen.getByRole('button', { name: 'Try again' }).click(),
    )
    await screen.findByRole('link', { name: /Team Station/ })
    assert.equal(
      app.node.requests.filter((request) => request === `GET ${APPS}`).length,
      2,
    )
  })

  it('has words for every refusal', () => {
    const words = (status: number, message: string): string =>
      refusalOf(new ApiError(status, message)).title
    assert.equal(
      words(503, 'The host is catching up with the master; try again shortly'),
      'The host is catching up with the master',
    )
    assert.equal(
      words(403, 'This account is not on the host yet'),
      'This account is not on the host yet',
    )
    assert.equal(words(404, 'Build unavailable'), 'Build unavailable')
    assert.equal(words(404, 'Device unavailable'), 'Device unavailable')
    assert.equal(words(404, 'App unavailable'), 'This app is unavailable')
    assert.equal(
      words(410, 'Registration link is unavailable'),
      'The registration link is unavailable',
    )
    assert.equal(
      words(0, 'Mason could not be reached'),
      'The request could not be completed',
    )
  })
})

describe('An app on Install apps', () => {
  it('lists its branches with when each was last built, master first', async () => {
    open('/apps/7?platform=ios', { [`${APP}?platform=ios`]: appData() })
    await heading('Team Station')
    screen.getByText('Branches with builds for iOS.')
    assert.deepEqual(crumbs(), ['Mason Host', 'Install apps', 'Team Station'])
    const list = screen.getByRole('region', { name: 'Branches' })
    const rows = within(list).getAllByRole('link')
    assert.match(text(rows[0]!), /^masterLast built /)
    assert.equal(
      rows[1]!.getAttribute('href'),
      `/apps/7/branches/${KEY}?platform=ios`,
    )
    assert.ok(rows[1]!.querySelector('time[datetime]'))
  })

  it('offers the platforms that have builds when the chosen one has none', async () => {
    open('/apps/7?platform=macos', { [`${APP}?platform=macos`]: appData() })
    await screen.findByText(/There are currently no builds for macOS/)
    const other = screen.getByRole('region', {
      name: 'No builds for this platform',
    })
    const links = within(other).getAllByRole('link')
    assert.deepEqual(
      links.map((link) => text(link).replace(/Last built.*/, '')),
      ['iOS', 'Android'],
    )
    await act(async () => links[1]!.click())
    await until(() => where.path === '/apps/7?platform=android', 'Android')
    assert.equal(platformPreference(), 'android')
  })

  it('says when the app has no retained builds, and when it is unavailable', async () => {
    open('/apps/7?platform=ios', {
      [`${APP}?platform=ios`]: appData({ branches: [], latest: {} }),
    })
    await screen.findByRole('heading', { name: 'No retained builds yet.' })
    cleanup()
    open('/apps/7?platform=ios', {
      [`${APP}?platform=ios`]: {
        status: 404,
        body: { error: 'App unavailable' },
      },
    })
    await screen.findByRole('heading', { name: 'This app is unavailable' })
    assert.equal(
      screen.getByRole('link', { name: 'Browse apps' }).getAttribute('href'),
      '/apps',
    )
    await heading('App unavailable')
    assert.equal(screen.queryByText(/Branches with builds/), null)
    cleanup()
    const app = open('/apps/nope?platform=ios', {})
    await screen.findByRole('heading', { name: 'This app is unavailable' })
    assert.equal(
      app.node.requests.some((request) => request.includes('/catalog/apps/')),
      false,
    )
  })
})

describe('A branch on Install apps', () => {
  const at = `${BRANCH}?platform=ios`
  const path = `/apps/7/branches/${KEY}?platform=ios`

  it('draws each build with its version, time, size and commit, and every action label', async () => {
    const data = branch({
      device: true,
      builds: [
        build({
          id: 1,
          installUrl: 'itms-services://?action=download-manifest&url=x',
          token: 't',
        }),
        build({ id: 2, eligible: false, version: '4.18.2' }),
        build({
          id: 3,
          download: 'iPhone Simulator',
          format: 'zip',
          size: 92_000_000,
        }),
        build({ id: 4, eligible: true, format: 'ipa' }),
      ],
    })
    open(path, { [at]: data })
    await heading('paul/offline')
    screen.getByText(/iOS builds · newest first/)
    screen.getByText(/Installation links last up to one hour/)
    const install = screen.getByRole('link', {
      name: 'Install 4.18.3 build 26110902',
    })
    // A plain link to the installer: Safari keeps the tap's gesture.
    assert.equal(
      install.getAttribute('href'),
      'itms-services://?action=download-manifest&url=x',
    )
    assert.match(install.className, /m-btn--primary/)
    screen.getByRole('button', {
      name: 'Prepare for this device 4.18.2 build 26110902',
    })
    screen.getByRole('button', {
      name: 'Download 4.18.3 build 26110902 for the iPhone Simulator',
    })
    screen.getByRole('button', { name: 'Install 4.18.3 build 26110902' })
    const row = document.getElementById('build-3')!
    assert.match(text(row), /iPhone Simulator · 92\.0 MB/)
    const sha = row.querySelector('.m-commit__sha')!
    assert.equal(sha.textContent, 'ec24b917a1b2')
    assert.equal(sha.getAttribute('title'), data.builds[2]!.commit)
    assert.deepEqual(crumbs(), [
      'Mason Host',
      'Install apps',
      'Team Station',
      'paul/offline',
    ])
  })

  it('groups a run’s variants as one build, Default first', async () => {
    open(path, {
      [at]: branch({
        builds: [
          build({ id: 5, run: 'r1', variant: 'staging', token: 'a' }),
          build({ id: 6, run: 'r1', variant: '', token: 'b' }),
          build({ id: 7, version: '4.18.0', buildNumber: '26110101' }),
        ],
      }),
    })
    const group = await screen.findByRole('region', { name: /^4\.18\.3/ })
    assert.match(text(group), /2 variants/)
    assert.deepEqual(
      within(group)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
      [
        'Install 4.18.3 build 26110902 (Default)',
        'Install 4.18.3 build 26110902 (staging)',
      ],
    )
    screen.getByRole('region', { name: 'Builds' })
  })

  it('links iOS installs to the host’s own page without a public master address, and disables them with none', async () => {
    open(
      path,
      {
        [at]: branch({
          ios: { via: 'host', host: 'https://host.example.test' },
          builds: [build()],
        }),
      },
      'master',
    )
    const link = await screen.findByRole('link', {
      name: 'Install on the host 4.18.3 build 26110902',
    })
    assert.equal(
      link.getAttribute('href'),
      `https://host.example.test/apps/7/branches/${KEY}?platform=ios`,
    )
    screen.getByText(/Installs on iPhone and iPad go through the host/)
    cleanup()
    open(
      path,
      { [at]: branch({ ios: { via: 'none' }, builds: [build()] }) },
      'master',
    )
    await screen.findByText(NO_IOS_ADDRESS)
    const row = document.getElementById('build-100')!
    assert.equal(row.getAttribute('aria-disabled'), 'true')
    assert.equal(
      (within(row).getByRole('button') as HTMLButtonElement).disabled,
      true,
    )
    assert.equal(screen.queryByText(/Installation links last/), null)
  })

  it('asks the viewer to register a device, and to prepare a build for theirs', async () => {
    const prepare = recorder(() => ({ status: 200, body: { prepared: true } }))
    const app = open(path, {
      [at]: branch({ builds: [build({ eligible: false })] }),
      'POST /api/v2/catalog/builds/100/install': { kind: 'register' },
      'POST /api/v2/catalog/builds/100/prepare': prepare.reply,
    })
    {
      const target = await screen.findByRole('button', {
        name: 'Register Device for 4.18.3 build 26110902',
      })
      await act(async () => target.click())
    }
    const title = await screen.findByRole('heading', {
      name: 'Prepare your device',
    })
    await until(() => document.activeElement === title, 'focus on the answer')
    screen.getByText(
      'Register or select your iPhone or iPad before installing this build.',
    )
    assert.equal(
      screen
        .getByRole('link', { name: /Register device/ })
        .getAttribute('href'),
      '/devices',
    )
    await act(async () =>
      screen.getByRole('button', { name: 'Back to builds' }).click(),
    )
    assert.equal(
      screen.queryByRole('heading', { name: 'Prepare your device' }),
      null,
    )
    // With a device selected, the build is prepared for it.
    app.node.set('POST /api/v2/catalog/builds/100/install', {
      kind: 'prepare',
      buildId: 100,
    })
    await act(async () =>
      screen
        .getByRole('button', {
          name: 'Register Device for 4.18.3 build 26110902',
        })
        .click(),
    )
    await screen.findByText(/This build does not yet include your device/)
    await act(async () =>
      screen.getByRole('button', { name: 'Prepare for this device' }).click(),
    )
    await screen.findByRole('heading', { name: 'Preparing build' })
    screen.getByText(/This can take several minutes/)
    assert.equal(prepare.bodies.length, 1)
    assert.equal(
      screen.getByRole('link', { name: 'Browse apps' }).getAttribute('href'),
      '/apps',
    )
  })

  it('goes to Devices when there is no device of the viewer’s to prepare for', async () => {
    open(path, {
      [at]: branch({ device: true, builds: [build({ eligible: false })] }),
      'POST /api/v2/catalog/builds/100/install': {
        kind: 'prepare',
        buildId: 100,
      },
      'POST /api/v2/catalog/builds/100/prepare': { prepared: false },
      '/api/v2/devices': {
        devices: [],
        registration: true,
        all: [],
      },
    })
    {
      const target = await screen.findByRole('button', {
        name: 'Prepare for this device 4.18.3 build 26110902',
      })
      await act(async () => target.click())
    }
    {
      const target = await screen.findByRole('button', {
        name: 'Prepare for this device',
      })
      await act(async () => target.click())
    }
    await until(() => where.path === '/devices', 'Devices')
  })

  it('downloads a build that only downloads, and shows the installer link Install answers', async () => {
    const pending = held(200, {
      kind: 'download',
      url: '/install/abc/artifact',
    })
    const app = open(`/apps/7/branches/${KEY}?platform=android`, {
      [`${BRANCH}?platform=android`]: branch({
        builds: [build({ platform: 'android', format: 'apk' })],
      }),
      'POST /api/v2/catalog/builds/100/install': pending.reply,
    })
    const button = await screen.findByRole('button', {
      name: 'Install 4.18.3 build 26110902',
    })
    await act(async () => button.click())
    assert.equal(button.getAttribute('aria-busy'), 'true')
    pending.release()
    await until(() => app.left.length === 1, 'the download')
    assert.deepEqual(app.left, ['/install/abc/artifact'])
    await screen.findByText('Downloading 4.18.3')
    assert.equal(screen.queryByText(/Installation links last/), null)
    cleanup()
    // An install that answers the iOS installer's link.
    const expires = NOW + 3_600_000
    open(path, {
      [at]: branch({ builds: [build()] }),
      'POST /api/v2/catalog/builds/100/install': {
        kind: 'itms',
        url: 'itms-services://?action=download-manifest&url=y',
        expiresAt: expires,
      },
    })
    {
      const target = await screen.findByRole('button', {
        name: 'Install 4.18.3 build 26110902',
      })
      await act(async () => target.click())
    }
    await screen.findByRole('heading', { name: 'Install app' })
    screen.getByText(/Tap Install on iOS, then confirm the installation/)
    screen.getByText(/This installation link expires at /)
    assert.equal(
      screen
        .getByRole('link', { name: 'Install Team Station 4.18.3 on iOS' })
        .getAttribute('href'),
      'itms-services://?action=download-manifest&url=y',
    )
    cleanup()
    open(path, {
      [at]: branch({ builds: [build()] }),
      'POST /api/v2/catalog/builds/100/install': { kind: 'itms' },
    })
    {
      const target = await screen.findByRole('button', {
        name: 'Install 4.18.3 build 26110902',
      })
      await act(async () => target.click())
    }
    await screen.findByRole('heading', { name: 'Install app' })
    screen.getByText(NO_IOS_ADDRESS)
  })

  it('says why Install and Prepare were refused', async () => {
    const app = open(path, {
      [at]: branch({ builds: [build()] }),
      'POST /api/v2/catalog/builds/100/install': {
        status: 404,
        body: { error: 'Build unavailable' },
      },
    })
    {
      const target = await screen.findByRole('button', {
        name: 'Install 4.18.3 build 26110902',
      })
      await act(async () => target.click())
    }
    await screen.findByRole('heading', { name: 'Build unavailable' })
    app.node.set('POST /api/v2/catalog/builds/100/install', {
      kind: 'prepare',
    })
    await act(async () =>
      screen
        .getByRole('button', { name: 'Install 4.18.3 build 26110902' })
        .click(),
    )
    app.node.set('POST /api/v2/catalog/builds/100/prepare', {
      status: 403,
      body: { error: 'Tester access required' },
    })
    {
      const target = await screen.findByRole('button', {
        name: 'Prepare for this device',
      })
      await act(async () => target.click())
    }
    await screen.findByRole('heading', { name: 'Waiting for tester access' })
    await requested(app, 'POST /api/v2/catalog/builds/100/prepare')
  })

  it('says when the branch has no builds for the platform, or cannot be read', async () => {
    open(path, { [at]: branch() })
    await screen.findByRole('heading', { name: 'No iOS builds' })
    screen.getByText(/This branch has no retained builds/)
    cleanup()
    open(path, {
      [at]: { status: 404, body: { error: 'App unavailable' } },
    })
    await screen.findByRole('heading', { name: 'This app is unavailable' })
    cleanup()
    open('/apps/0/branches/x?platform=ios', {})
    await screen.findByRole('heading', { name: 'This app is unavailable' })
  })

  it('chooses each row’s control from the build, the device and the node', () => {
    const data = branch()
    assert.equal(actionFor(data, build(), KEY).kind, 'install')
    assert.deepEqual(
      actionFor(
        branch({ ios: { via: 'host', host: 'https://h' } }),
        build({ platform: 'android', format: 'apk' }),
        KEY,
      ),
      {
        kind: 'install',
        verb: 'Install',
        long: 'Install',
        icon: 'mobile_arrow_down',
      },
    )
    assert.equal(
      actionFor(branch({ ios: { via: 'none' } }), build(), KEY).kind,
      'disabled',
    )
  })

  it('keeps the result for its platform only', async () => {
    open(path, {
      [at]: branch({ builds: [build({ eligible: false })] }),
      [`${BRANCH}?platform=android`]: branch(),
      'POST /api/v2/catalog/builds/100/install': { kind: 'register' },
    })
    {
      const target = await screen.findByRole('button', {
        name: 'Register Device for 4.18.3 build 26110902',
      })
      await act(async () => target.click())
    }
    await screen.findByRole('heading', { name: 'Prepare your device' })
    fireEvent.click(screen.getByRole('link', { name: /Android/ }))
    await screen.findByRole('heading', { name: 'No Android builds' })
    assert.equal(
      screen.queryByRole('heading', { name: 'Prepare your device' }),
      null,
    )
  })
})
