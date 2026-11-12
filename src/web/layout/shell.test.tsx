import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, it } from 'mocha'
import type { StatusInfo } from '../../shared/api/index.js'
import { resetAppearance } from '../hooks/useAppearance.js'
import {
  dashboard,
  masterStatus,
  matchMedia,
  narrow,
  nodeInfo,
  renderApp,
  sessionFor,
  shellReplies,
  until,
  where,
  type Harness,
} from '../test/render.js'
import { APPEARANCE_KEY } from '../theme/theme-boot.js'
import { glyph } from '../ui/icons.js'
import { opensPalette } from './AppShell.js'
import { workersLabel, workersStatus } from './ClusterChips.js'
import { liveStatus } from './LiveFooter.js'
import { notificationsName } from './Notifications.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
  resetAppearance()
  delete document.documentElement.dataset.theme
  document.title = ''
})

/** Waits for the signed-in page's h1. */
const page = async (name: string | RegExp): Promise<HTMLElement> =>
  await screen.findByRole('heading', { level: 1, name })

const sidebar = (): HTMLElement =>
  document.querySelector<HTMLElement>('.m-sidebar')!
const rail = (): HTMLElement => document.querySelector<HTMLElement>('.m-rail')!
const tabbar = (): HTMLElement =>
  document.querySelector<HTMLElement>('.m-tabbar')!
const texts = (nodes: Iterable<Element>): string[] =>
  [...nodes].map((node) => node.textContent!.trim())

describe('The app shell’s navigation per node and role', () => {
  it('gives an administrator on the master every destination, by section, in the sidebar, rail and tab bar', async () => {
    renderApp({ path: '/nodes' })
    await page('Nodes')
    assert.deepEqual(texts(sidebar().querySelectorAll('.m-sidebar__label')), [
      'Build',
      'Distribute',
      'Cluster',
      'Admin',
      'Projects',
    ])
    assert.deepEqual(
      texts(sidebar().querySelectorAll('nav .m-navitem')).map((text) =>
        text.slice(1),
      ),
      [
        'Projects & apps',
        'Artifacts',
        'Install apps',
        'Devices',
        'Nodes',
        'Cloud',
        'People',
        'Groups',
        'Settings',
        'Backups',
      ],
    )
    const current = sidebar().querySelector('[aria-current="page"]')!
    assert.equal(current.textContent!.slice(1), 'Nodes')
    assert.equal(rail().querySelectorAll('.m-rail__item').length, 10)
    assert.equal(
      rail().querySelector('[aria-current="page"]')!.textContent!.slice(1),
      'Nodes',
    )
    assert.equal(
      within(rail())
        .getByRole('link', { name: 'Projects & apps' })
        .textContent!.slice(1),
      'Projects',
    )
    // Narrow: four tabs and More, which holds the rest and is current for them.
    assert.deepEqual(
      texts(tabbar().querySelectorAll('.m-tabbar__platter > *')).map((text) =>
        text.slice(1),
      ),
      ['Projects', 'Artifacts', 'Install', 'Devices', 'More'],
    )
    const more = within(tabbar()).getByRole('button', { name: 'More' })
    assert.equal(more.getAttribute('aria-current'), 'page')
    await act(async () => more.click())
    const sheet = screen.getByRole('dialog', { name: 'More' })
    assert.deepEqual(texts(sheet.querySelectorAll('.m-list__title')), [
      'Nodes',
      'Cloud',
      'People',
      'Groups',
      'Settings',
      'Backups',
    ])
    assert.equal(
      within(sheet)
        .getByRole('link', { name: 'Nodes' })
        .getAttribute('aria-current'),
      'page',
    )
    // People hashes passwords: it is entered by a full load, under its own CSP.
    const people = within(sheet).getByRole('link', { name: 'People' })
    assert.equal(people.getAttribute('href'), '/people')
    await act(async () =>
      within(sheet).getByRole('link', { name: 'Groups' }).click(),
    )
    await page('Groups')
    assert.equal(screen.queryByRole('dialog'), null)
    assert.equal(where.path, '/groups')
  })

  it('gives a tester on the host only Install apps and Devices, two tabs and no More, and sends them home to Install apps', async () => {
    renderApp({
      node: nodeInfo('host'),
      replies: shellReplies('tester', 'host'),
      path: '/',
    })
    await page('Install apps')
    assert.equal(where.path, '/apps')
    assert.deepEqual(texts(sidebar().querySelectorAll('.m-sidebar__label')), [
      'Distribute',
    ])
    assert.equal(
      sidebar().querySelector('.m-sidebar__node')!.textContent!.slice(1),
      'Host',
    )
    assert.deepEqual(
      texts(tabbar().querySelectorAll('.m-tabbar__platter > *')).map((text) =>
        text.slice(1),
      ),
      ['Install', 'Devices'],
    )
    assert.equal(within(tabbar()).queryByRole('button', { name: 'More' }), null)
    assert.equal(document.querySelector('.m-topbar__chips'), null)
  })

  it('sends a developer home to Projects & apps, with four destinations on the host', async () => {
    renderApp({
      node: nodeInfo('host'),
      replies: shellReplies('developer', 'host'),
      path: '/',
    })
    await page('Projects & apps')
    assert.equal(where.path, '/projects')
    assert.equal(sidebar().querySelectorAll('nav .m-navitem').length, 4)
    assert.equal(within(tabbar()).queryByRole('button', { name: 'More' }), null)
  })

  it('shows the brand, version and node in the sidebar, and the projects with a live dot while one runs', async () => {
    renderApp({
      path: '/projects/fixture/runs',
      replies: shellReplies('developer', 'master', {
        '/api/v2/dashboard': dashboard([
          { slug: 'fixture', name: 'Fixture', running: 2 },
          { slug: 'website', name: 'website' },
        ]),
      }),
    })
    await page('Runs and builds')
    assert.equal(
      sidebar().querySelector('.m-sidebar__brand')!.textContent,
      'Masonv0.6.0',
    )
    assert.equal(
      sidebar().querySelector('.m-sidebar__node')!.textContent!.slice(1),
      'Master',
    )
    await until(
      () => sidebar().querySelectorAll('.m-navitem--project').length === 2,
      'the projects',
    )
    const fixture = within(sidebar()).getByRole('link', { name: /Fixture/ })
    assert.equal(fixture.getAttribute('href'), '/projects/fixture')
    assert.equal(fixture.getAttribute('aria-current'), 'page')
    within(fixture).getByRole('img', { name: '2 runs running' })
    const website = within(sidebar()).getByRole('link', { name: /website/ })
    assert.equal(website.querySelector('.m-navitem__mark')!.textContent, 'W')
    assert.equal(website.querySelector('.m-dot--live'), null)
    // Inside a project, Projects & apps is not also current in the sidebar.
    assert.equal(sidebar().querySelector('nav [aria-current]'), null)
    assert.equal(
      rail().querySelector('[aria-current]')!.textContent!.slice(1),
      'Projects',
    )
    assert.equal(
      sidebar().querySelector('.m-sidebar__foot .m-t-mono-sm')!.textContent,
      'master 0.6.0',
    )
  })

  it('lists one running run in the singular, and no projects for a tester', async () => {
    renderApp({
      path: '/projects',
      replies: shellReplies('developer', 'master', {
        '/api/v2/dashboard': dashboard([
          { slug: 'fixture', name: 'Fixture', running: 1 },
        ]),
      }),
    })
    await screen.findByRole('img', { name: '1 run running' })
    cleanup()
    renderApp({ path: '/apps', replies: shellReplies('tester') })
    await page('Install apps')
    assert.equal(sidebar().querySelector('.m-navitem--project'), null)
  })
})

describe('The live footer', () => {
  it('says Connecting…, Live, Reconnecting… and Offline as this browser’s socket goes', async () => {
    const app = renderApp({ path: '/projects' })
    await page('Projects & apps')
    const foot = (): string =>
      sidebar()
        .querySelector('.m-sidebar__foot .m-status')!
        .textContent!.replace(glyph('sync'), '')
    assert.equal(foot(), 'Connecting…')
    await act(async () => app.live.socket.accept())
    assert.equal(foot(), 'Live')
    assert(sidebar().querySelector('.m-sidebar__foot .m-dot--live') != null)
    await act(async () => app.live.socket.drop(1006))
    assert.equal(foot(), 'Reconnecting…')
    await act(async () => void app.live.tick())
    await act(async () => app.live.socket.drop(1008))
    assert.equal(foot().replace(glyph('circle'), ''), 'Offline')
  })

  it('says Master unreachable on a host whose link is down', async () => {
    renderApp({
      node: nodeInfo('host'),
      path: '/projects',
      replies: shellReplies('developer', 'host', {
        '/api/v2/status': {
          node: 'host',
          link: { online: false, maintenance: false },
          banners: [],
        },
      }),
    })
    await page('Projects & apps')
    await until(
      () =>
        /Master unreachable/.test(
          sidebar().querySelector('.m-sidebar__foot')!.textContent!,
        ),
      'the footer',
    )
    assert.match(
      sidebar().querySelector('.m-sidebar__foot .m-status')!.className,
      /m-status--warning/,
    )
  })

  it('notices the master go while a host page is open: /live stops, so the shell reads its status again', async () => {
    const status = (online: boolean): StatusInfo => ({
      node: 'host',
      link: { online, maintenance: false },
      banners: online
        ? []
        : [{ kind: 'offline', text: 'This host shows what it last synced.' }],
    })
    const app = renderApp({
      node: nodeInfo('host'),
      path: '/projects',
      replies: shellReplies('developer', 'host', {
        '/api/v2/status': status(true),
      }),
    })
    await page('Projects & apps')
    await act(async () => app.live.socket.accept())
    await act(async () =>
      app.live.socket.frame({
        key: 'shell-status',
        event: 'status',
        data: status(true),
      }),
    )
    const foot = (): string =>
      sidebar().querySelector('.m-sidebar__foot')!.textContent!
    assert.match(foot(), /Live/)
    // The host refuses /live while its master is unreachable.
    const reads = (): number =>
      app.node.requests.filter((r) => r === 'GET /api/v2/status').length
    const before = reads()
    app.node.set('/api/v2/status', status(false))
    await act(async () => app.live.socket.drop(1006))
    await until(() => /Master unreachable/.test(foot()), 'the footer')
    assert(reads() > before)
    await until(
      () => /The master is unreachable/.test(document.body.textContent!),
      'the banner',
    )
    // Back on /live, its status frames lead again.
    await act(async () => void app.live.tick())
    await act(async () => app.live.socket.accept())
    await act(async () =>
      app.live.socket.frame({
        key: 'shell-status',
        event: 'status',
        data: status(true),
      }),
    )
    await until(() => /Live/.test(foot()), 'Live again')
  })

  it('names every state', () => {
    assert.deepEqual(liveStatus('unavailable', false), {
      status: 'live_unavailable',
      label: 'Live updates unavailable',
    })
    assert.deepEqual(liveStatus('open', true), {
      status: 'unreachable',
      label: 'Master unreachable',
    })
  })
})

describe('The top bar', () => {
  it('shows both cluster chips and the compact one to a developer on the master, linking to Nodes for managers', async () => {
    renderApp({ path: '/projects', replies: shellReplies('developer') })
    await page('Projects & apps')
    await until(
      () => document.querySelector('.m-topbar__chips') != null,
      'the chips',
    )
    const chips = document.querySelector('.m-topbar__chips')!
    assert.deepEqual(
      texts(chips.querySelectorAll('.m-status')).map((t) => t.slice(1)),
      ['2 / 3 workers idle', 'Cluster healthy'],
    )
    assert.equal(chips.querySelector('a'), null)
    const compact = document.querySelector('.m-topbar__cluster')!
    assert.equal(
      compact.getAttribute('aria-label'),
      'Cluster healthy, 2 of 3 workers idle',
    )
    assert.equal(compact.textContent!.slice(1), '2 / 3 idle')
    cleanup()
    renderApp({
      path: '/projects',
      replies: shellReplies('manager', 'master', {
        '/api/v2/status': {
          node: 'master',
          cluster: { idle: 0, total: 0, healthy: false },
          banners: [],
        },
      }),
    })
    await until(
      () => document.querySelector('.m-topbar__chips a') != null,
      'the linked chip',
    )
    assert.equal(
      document.querySelector('.m-topbar__chips a')!.getAttribute('href'),
      '/nodes',
    )
    assert.equal(
      document.querySelector('.m-topbar__cluster')!.getAttribute('aria-label'),
      'Cluster degraded, no workers',
    )
    assert.equal(workersStatus({ idle: 0, total: 2, healthy: true }), 'busy')
    assert.equal(
      workersLabel({ idle: 1, total: 2, healthy: true }, true),
      '1 / 2 idle',
    )
  })

  it('shows no cluster chips to a tester', async () => {
    renderApp({ path: '/apps', replies: shellReplies('tester') })
    await page('Install apps')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    assert.equal(document.querySelector('.m-topbar__chips'), null)
  })

  it('shows the narrow back chevron named by the parent crumb, and the title once the h1 scrolls under the bar', async () => {
    renderApp({ path: '/projects/fixture/masonfile' })
    await page('Masonfile')
    // The page sets the chevron in an effect, after its heading renders.
    const back = await screen.findByRole('link', { name: 'Back to fixture' })
    assert.equal(back.getAttribute('href'), '/projects/fixture')
    const bar = document.querySelector('.m-topbar')!
    const title = bar.querySelector('.m-topbar__title')!
    assert.equal(title.textContent, 'Masonfile')
    assert.equal(bar.getAttribute('data-scrolled'), null)
    assert.equal(title.getAttribute('aria-hidden'), 'true')
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 200 })
    try {
      await act(async () => window.dispatchEvent(new window.Event('scroll')))
      assert.equal(bar.getAttribute('data-scrolled'), '')
      assert.equal(title.getAttribute('aria-hidden'), 'false')
    } finally {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    }
    cleanup()
    renderApp({ path: '/nodes' })
    await page('Nodes')
    assert.equal(screen.queryByRole('link', { name: /^Back to/ }), null)
  })
})

describe('Banners from the node’s status', () => {
  const status = (fields: Partial<StatusInfo>): StatusInfo => ({
    ...masterStatus,
    ...fields,
  })

  it('stacks the master unreachable banner first, then the backup reminder, collapsing test endpoints into +1 more', async () => {
    const app = renderApp({
      node: nodeInfo('host'),
      path: '/projects',
      replies: shellReplies('developer', 'host', {
        '/api/v2/status': {
          node: 'host',
          link: {
            online: false,
            lastContact: Date.now() - 14 * 60_000,
            maintenance: false,
          },
          banners: [
            { kind: 'testEndpoints', text: 'Test endpoints are on.' },
            {
              kind: 'backup',
              text: 'This master is not backed up',
              href: '/backups',
            },
            { kind: 'offline', text: 'You are seeing the last synced builds.' },
          ],
        },
      }),
    })
    await page('Projects & apps')
    await until(
      () => document.querySelector('.m-banners') != null,
      'the banners',
    )
    const titles = (): string[] =>
      texts(document.querySelectorAll('.m-banner__title'))
    assert.deepEqual(titles(), [
      'The master is unreachable Read-only',
      'This master is not backed up',
    ])
    const offline = document.querySelector<HTMLElement>(
      '.m-banner[role="status"]',
    )!
    assert.match(
      offline.textContent!,
      /You are seeing the last synced builds\. Runs, approvals and account changes need the master\./,
    )
    assert.match(
      offline.querySelector('.m-banner__meta')!.textContent!,
      /^Last reached Today \d{4} .+ · 14m ago$/,
    )
    assert.equal(
      screen.getByRole('link', { name: 'Open Backups' }).getAttribute('href'),
      '/backups',
    )
    await act(async () =>
      screen.getByRole('button', { name: '+1 more notice' }).click(),
    )
    assert.deepEqual(titles().slice(2), ['Test endpoints are on.'])
    const before = app.node.requests.filter(
      (r) => r === 'GET /api/v2/status',
    ).length
    await act(async () => screen.getByRole('button', { name: 'Retry' }).click())
    await until(
      () =>
        app.node.requests.filter((r) => r === 'GET /api/v2/status').length >
        before,
      'the retry',
    )
  })

  it('draws the offline banner without a last contact, and the backup link to Backups by default', async () => {
    renderApp({
      path: '/projects',
      replies: shellReplies('admin', 'master', {
        '/api/v2/status': status({
          link: { online: false, maintenance: false },
          banners: [
            { kind: 'offline', text: 'Offline.' },
            { kind: 'backup', text: 'Back up' },
          ],
        }),
      }),
    })
    await until(
      () => document.querySelector('.m-banner') != null,
      'the banners',
    )
    assert.equal(document.querySelector('.m-banner__meta'), null)
    assert.equal(
      screen.getByRole('link', { name: 'Open Backups' }).getAttribute('href'),
      '/backups',
    )
  })

  it('raises a degraded cluster as a banner on narrow, and live updates unavailable with Reload', async () => {
    const restore = matchMedia(narrow)
    try {
      const app = renderApp({
        path: '/projects',
        replies: shellReplies('manager', 'master', {
          '/api/v2/status': status({
            cluster: { idle: 1, total: 3, healthy: false },
          }),
        }),
      })
      await page('Projects & apps')
      await until(
        () => document.querySelector('.m-banner') != null,
        'the cluster banner',
      )
      screen.getByText('The cluster is degraded')
      screen.getByText('Not every worker is connected: 1 of 3 idle.')
      assert.equal(
        within(document.querySelector('.m-banners')!)
          .getByRole('link', { name: 'Nodes' })
          .getAttribute('href'),
        '/nodes',
      )
      await act(async () => app.live.socket.drop(4000))
      screen.getByText('Live updates are unavailable')
      within(document.querySelector('.m-banners')!).getByRole('button', {
        name: 'Reload',
      })
    } finally {
      restore()
    }
  })

  it('keeps the degraded banner without a Nodes link for a developer', async () => {
    const restore = matchMedia(narrow)
    try {
      renderApp({
        path: '/projects',
        replies: shellReplies('developer', 'master', {
          '/api/v2/status': status({
            cluster: { idle: 1, total: 3, healthy: false },
          }),
        }),
      })
      await until(
        () => document.querySelector('.m-banner') != null,
        'the cluster banner',
      )
      assert.equal(
        within(document.querySelector('.m-banner')!).queryByRole('link'),
        null,
      )
    } finally {
      restore()
    }
  })

  it('follows the live status: a host past its grace window shows maintenance', async () => {
    const app = renderApp({
      node: nodeInfo('host'),
      path: '/projects',
      replies: shellReplies('developer', 'host'),
    })
    await page('Projects & apps')
    await act(async () => app.live.socket.accept())
    await act(async () =>
      app.live.socket.frame({
        key: 'shell-status',
        event: 'status',
        data: {
          node: 'host',
          link: { online: false, maintenance: true },
          banners: [],
        },
      }),
    )
    await page('Maintenance')
  })
})

describe('Notifications', () => {
  it('counts what needs the viewer on the bell, and lists approvals and notices in a popover', async () => {
    renderApp({
      path: '/projects',
      replies: shellReplies('manager', 'master', {
        '/api/v2/notifications': [
          {
            kind: 'approval',
            text: 'fixture Run 7 (master) waits for your approval at ship',
            href: '/runs/r7',
          },
          { kind: 'notice', text: 'This master is not backed up' },
        ],
      }),
    })
    const bell = await screen.findByRole('button', {
      name: 'Notifications, 2 need you',
    })
    assert.equal(bell.querySelector('.m-badge')!.textContent, '2')
    await act(async () => bell.click())
    const popover = screen.getByRole('dialog', { name: 'Notifications' })
    within(popover).getByRole('img', { name: '2 need you' })
    const approval = within(popover).getByRole('link', {
      name: /waits for your approval/,
    })
    assert.equal(approval.getAttribute('href'), '/runs/r7')
    assert.match(approval.textContent!, /^.Approve/)
    assert.match(
      within(popover)
        .getByText('This master is not backed up')
        .closest('.m-list__row')!.textContent!,
      /Notice/,
    )
    await act(async () => approval.click())
    await page('Run')
    assert.equal(where.path, '/runs/r7')
  })

  it('says Nothing needs you, reloads on open and on each live status', async () => {
    const app = renderApp({ path: '/projects' })
    const bell = await screen.findByRole('button', {
      name: 'Notifications, nothing needs you',
    })
    const reads = (): number =>
      app.node.requests.filter((r) => r === 'GET /api/v2/notifications').length
    await until(() => reads() >= 1, 'the first read')
    const first = reads()
    await act(async () => bell.click())
    await until(() => reads() > first, 'the read on open')
    within(screen.getByRole('dialog', { name: 'Notifications' })).getByText(
      'Nothing needs you.',
    )
    app.node.set('/api/v2/notifications', [
      { kind: 'approval', text: 'Run 9 waits', href: '/runs/9' },
    ])
    await act(async () => app.live.socket.accept())
    await act(async () =>
      app.live.socket.frame({
        key: 'shell-status',
        event: 'status',
        data: masterStatus,
      }),
    )
    await screen.findByRole('button', { name: 'Notifications, 1 needs you' })
    await act(async () => bell.click())
    assert.equal(screen.queryByRole('dialog', { name: 'Notifications' }), null)
    assert.equal(notificationsName(3), 'Notifications, 3 need you')
  })

  it('says why the list failed, and shows its loading shape first', async () => {
    let answer: (response: Response) => void = () => undefined
    renderApp({
      path: '/projects',
      replies: shellReplies('admin', 'master', {
        '/api/v2/notifications': () =>
          new Promise<Response>((resolve) => (answer = resolve)),
      }),
    })
    const bell = await screen.findByRole('button', { name: /^Notifications/ })
    await act(async () => bell.click())
    within(screen.getByRole('dialog', { name: 'Notifications' })).getByRole(
      'status',
      { name: 'Loading notifications' },
    )
    await act(async () =>
      answer(new Response('{"error":"The master is busy"}', { status: 503 })),
    )
    await screen.findByText('The master is busy')
  })
})

describe('The account menu', () => {
  beforeEach(() => localStorage.clear())

  it('names the viewer, role and node, opens Your account, and switches Appearance at once and for later', async () => {
    const app = renderApp({ path: '/projects', replies: shellReplies('admin') })
    await page('Projects & apps')
    const avatar = screen.getByRole('button', { name: 'Your account' })
    assert.equal(avatar.textContent, 'P')
    await act(async () => avatar.click())
    const menu = screen.getByRole('menu', { name: 'Account' })
    assert.match(menu.textContent!, /Paul Puey/)
    assert.match(menu.textContent!, /Admin · Mason Master/)
    const choices = (): string[] =>
      within(screen.getByRole('menu'))
        .getAllByRole('menuitemradio')
        .map(
          (item) =>
            `${item.textContent!.replace(/[-]/g, '')}:${item.getAttribute('aria-checked')}`,
        )
    assert.deepEqual(choices(), [
      'Dark:true',
      'Light:false',
      'Match system:false',
    ])
    await act(async () =>
      within(menu).getByRole('menuitemradio', { name: 'Light' }).click(),
    )
    assert.equal(document.documentElement.dataset.theme, 'light')
    assert.equal(localStorage.getItem(APPEARANCE_KEY), 'light')
    await act(async () => avatar.click())
    assert.deepEqual(choices(), [
      'Dark:false',
      'Light:true',
      'Match system:false',
    ])
    await act(async () =>
      within(screen.getByRole('menu'))
        .getByRole('menuitemradio', { name: 'Match system' })
        .click(),
    )
    assert.equal(localStorage.getItem(APPEARANCE_KEY), 'system')
    assert.equal(document.documentElement.dataset.theme, 'dark')
    await act(async () => avatar.click())
    // Your account hashes passwords: it is entered by a full load.
    await act(async () =>
      within(screen.getByRole('menu'))
        .getByRole('menuitem', { name: 'Your account' })
        .click(),
    )
    assert.deepEqual(app.left, ['/account'])
  })

  it('signs out: ends the session, then leaves for the node’s sign-in with a full load', async () => {
    const app = renderApp({
      node: nodeInfo('host'),
      path: '/projects',
      replies: shellReplies('developer', 'host', {
        'DELETE /api/v2/session': null,
      }),
    })
    await page('Projects & apps')
    await act(async () =>
      screen.getByRole('button', { name: 'Your account' }).click(),
    )
    screen.getByText(/Developer · Mason Host/)
    await act(async () =>
      screen.getByRole('menuitem', { name: 'Sign out' }).click(),
    )
    await until(() => app.left.length > 0, 'the sign-out')
    assert(app.node.requests.includes('DELETE /api/v2/session'))
    assert.deepEqual(app.left, ['/auth/login?signed_out=1'])
  })

  it('still leaves when the node cannot end the session', async () => {
    const app = renderApp({
      path: '/projects',
      replies: shellReplies('admin', 'master', {
        'DELETE /api/v2/session': { status: 503 },
      }),
    })
    await page('Projects & apps')
    await act(async () =>
      screen.getByRole('button', { name: 'Your account' }).click(),
    )
    await act(async () =>
      screen.getByRole('menuitem', { name: 'Sign out' }).click(),
    )
    await until(() => app.left.length > 0, 'the sign-out')
    assert.deepEqual(app.left, ['/sign-in?signed_out=1'])
  })

  it('carries the cluster’s health on narrow, as an action sheet', async () => {
    const restore = matchMedia(narrow)
    try {
      renderApp({ path: '/projects', replies: shellReplies('admin') })
      await page('Projects & apps')
      await until(
        () => document.querySelector('.m-topbar__chips') != null,
        'the status',
      )
      await act(async () =>
        screen.getByRole('button', { name: 'Your account' }).click(),
      )
      const sheet = screen.getByRole('dialog', { name: 'Account' })
      assert.match(sheet.textContent!, /Cluster healthy · 2 \/ 3 workers idle/)
      await act(async () =>
        within(sheet).getByRole('button', { name: 'Close' }).click(),
      )
    } finally {
      restore()
    }
    cleanup()
    const again = matchMedia(narrow)
    try {
      renderApp({
        path: '/projects',
        replies: shellReplies('admin', 'master', {
          '/api/v2/status': {
            ...masterStatus,
            cluster: { idle: 0, total: 2, healthy: false },
          },
        }),
      })
      await page('Projects & apps')
      await until(
        () => document.querySelector('.m-banner') != null,
        'the status',
      )
      await act(async () =>
        screen.getByRole('button', { name: 'Your account' }).click(),
      )
      assert.match(
        screen.getByRole('dialog', { name: 'Account' }).textContent!,
        /Cluster degraded · 0 \/ 2 workers idle/,
      )
    } finally {
      again()
    }
  })
})

describe('The ⌘K palette', () => {
  const results = [
    {
      kind: 'project',
      label: 'Fixture',
      detail: 'fixture',
      href: '/projects/fixture',
    },
    {
      kind: 'app',
      label: 'com.example.alpha',
      detail: 'Alpha · fixture',
      href: '/projects/fixture/apps/com.example.alpha',
    },
    {
      kind: 'run',
      label: 'fixture Run 18',
      detail: 'master · succeeded',
      href: '/runs/r18',
    },
    {
      kind: 'commit',
      label: '18e2a7c9',
      detail: 'fixture · master · Bump',
      href: '/runs/r18',
    },
    {
      kind: 'branch',
      label: 'release/4.18',
      detail: 'fixture',
      href: '/projects/fixture/runs?branch=release%2F4.18',
    },
    {
      kind: 'run',
      label: 'fixture Run 181',
      detail: 'develop · failed',
      href: '/runs/r181',
    },
  ]
  const open = async (
    key: Partial<KeyboardEventInit> = { metaKey: true },
  ): Promise<HTMLInputElement> => {
    await act(async () => fireEvent.keyDown(document, { key: 'k', ...key }))
    return screen.getByRole('combobox', {
      name: 'Search projects, app IDs, runs, commits and branches',
    }) as HTMLInputElement
  }
  const type = async (input: HTMLInputElement, text: string): Promise<void> => {
    await act(async () => fireEvent.change(input, { target: { value: text } }))
  }

  it('opens on ⌘K or Ctrl K into its field, says what it finds, and closes on Esc back where focus was', async () => {
    renderApp({ path: '/projects' })
    const heading = await page('Projects & apps')
    heading.focus()
    await act(async () =>
      fireEvent.keyDown(document, { key: 'k', metaKey: true, shiftKey: true }),
    )
    assert.equal(screen.queryByRole('combobox'), null)
    const input = await open()
    assert.equal(document.activeElement, input)
    const dialog = screen.getByRole('dialog', { name: 'Search' })
    assert.match(
      dialog.textContent!,
      /Type to search projects, app IDs, runs, commits and branches\./,
    )
    await act(async () => fireEvent.keyDown(input, { key: 'Escape' }))
    assert.equal(screen.queryByRole('dialog', { name: 'Search' }), null)
    assert.equal(document.activeElement, heading)
    await open({ ctrlKey: true, key: 'K' })
    assert.equal(
      opensPalette(
        new window.KeyboardEvent('keydown', {
          key: 'k',
          ctrlKey: true,
          altKey: true,
        }),
      ),
      false,
    )
  })

  it('groups the five kinds, moves with ↑ and ↓ (wrapping), and opens the selected one on Enter', async () => {
    const app = renderApp({
      path: '/projects',
      replies: shellReplies('admin', 'master', { '/api/v2/search': results }),
    })
    await page('Projects & apps')
    const input = await open()
    await type(input, '18')
    const listbox = await screen.findByRole('listbox', { name: 'Results' })
    assert(app.node.requests.includes('GET /api/v2/search?q=18'))
    assert.deepEqual(
      within(listbox)
        .getAllByRole('group')
        .map((group) => group.getAttribute('aria-label')),
      ['Runs', 'Commits', 'Branches', 'Projects', 'App IDs'],
    )
    const options = within(listbox).getAllByRole('option')
    assert.deepEqual(
      options.map(
        (option) => option.querySelector('.m-list__main > span')!.textContent,
      ),
      [
        'fixture Run 18',
        'fixture Run 181',
        '18e2a7c9',
        'release/4.18',
        'Fixture',
        'com.example.alpha',
      ],
    )
    assert.equal(options[0]!.querySelector('mark')!.textContent, '18')
    assert.equal(options[0]!.getAttribute('aria-selected'), 'true')
    assert.equal(input.getAttribute('aria-activedescendant'), options[0]!.id)
    assert.equal(input.getAttribute('aria-expanded'), 'true')
    screen.getByText('6 results')
    await act(async () => fireEvent.keyDown(input, { key: 'ArrowDown' }))
    assert.equal(input.getAttribute('aria-activedescendant'), options[1]!.id)
    await act(async () => fireEvent.keyDown(input, { key: 'ArrowUp' }))
    await act(async () => fireEvent.keyDown(input, { key: 'ArrowUp' }))
    assert.equal(input.getAttribute('aria-activedescendant'), options[5]!.id)
    await act(async () => fireEvent.keyDown(input, { key: 'ArrowDown' }))
    await act(async () => fireEvent.keyDown(input, { key: 'ArrowDown' }))
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    await page('Run')
    assert.equal(where.path, '/runs/r181')
    assert.equal(screen.queryByRole('dialog', { name: 'Search' }), null)
  })

  it('leaves keys alone while an input method composes', async () => {
    renderApp({
      path: '/projects',
      replies: shellReplies('admin', 'master', { '/api/v2/search': results }),
    })
    await page('Projects & apps')
    const input = await open()
    await type(input, 'ラン')
    await screen.findByRole('listbox')
    await act(async () =>
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true }),
    )
    await act(async () =>
      fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 229 }),
    )
    assert.equal(where.path, '/projects')
    assert.equal(
      input.getAttribute('aria-activedescendant'),
      screen.getAllByRole('option')[0]!.id,
    )
    screen.getByRole('dialog', { name: 'Search' })
  })

  it('says nothing matches, opens a result by pointer, and does nothing on Enter with no results', async () => {
    const app = renderApp({
      path: '/projects',
      replies: shellReplies('admin', 'master', { '/api/v2/search': [] }),
    })
    await page('Projects & apps')
    const input = await open()
    await type(input, 'zebra')
    await screen.findByText(
      'No projects, app IDs, runs, commits or branches match "zebra".',
      { selector: 'p' },
    )
    await act(async () => fireEvent.keyDown(input, { key: 'ArrowDown' }))
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    await act(async () => fireEvent.keyDown(input, { key: 'Tab' }))
    assert.equal(input.getAttribute('aria-expanded'), 'false')
    app.node.set('/api/v2/search', results.slice(0, 1))
    await type(input, 'fix')
    const option = await screen.findByRole('option')
    screen.getByText('1 result')
    fireEvent.mouseMove(option)
    await act(async () => option.click())
    await page('Overview')
    assert.equal(where.path, '/projects/fixture')
  })

  it('says why a search failed and tries again, and clears when the field empties', async () => {
    let fail = true
    renderApp({
      path: '/projects',
      replies: shellReplies('admin', 'master', {
        '/api/v2/search': () =>
          fail
            ? new Response('{"error":"Search is busy"}', { status: 503 })
            : new Response(JSON.stringify(results.slice(2, 3))),
      }),
    })
    await page('Projects & apps')
    const input = await open()
    await type(input, '18')
    await screen.findByText('Search is busy')
    fail = false
    await act(async () =>
      screen.getByRole('button', { name: 'Try again' }).click(),
    )
    await screen.findByRole('option')
    await type(input, '')
    screen.getByText(/Type to search/)
  })

  it('shows Searching… while it waits, and opens from the search capsule and the tab bar’s search button', async () => {
    renderApp({
      path: '/projects',
      replies: shellReplies('admin', 'master', {
        '/api/v2/search': () => new Promise<Response>(() => undefined),
      }),
    })
    await page('Projects & apps')
    await act(async () =>
      screen
        .getByRole('button', { name: /Search projects, apps, runs, commits…/ })
        .click(),
    )
    const input = screen.getByRole('combobox') as HTMLInputElement
    await type(input, 'x')
    await screen.findByRole('status', { name: 'Searching' })
    await act(async () => fireEvent.keyDown(input, { key: 'Escape' }))
    await act(async () =>
      within(tabbar()).getByRole('button', { name: 'Search' }).click(),
    )
    screen.getByRole('combobox')
  })
})

describe('Pages in the shell', () => {
  it('moves focus to the new page’s h1 on every route change, titles the tab, and the skip link reaches the content', async () => {
    renderApp({ path: '/projects' })
    const first = await page('Projects & apps')
    assert.notEqual(document.activeElement, first)
    assert.equal(document.title, 'Projects & apps · Mason')
    await act(async () =>
      within(sidebar())
        .getByRole('link', { name: /Artifacts/ })
        .click(),
    )
    const next = await page('Artifacts')
    assert.equal(document.activeElement, next)
    assert.equal(document.title, 'Artifacts · Mason')
    const skip = screen.getAllByRole('link', { name: 'Skip to content' })[0]!
    assert.equal(skip.className, 'm-skip')
    await act(async () => skip.click())
    assert.equal(document.activeElement, screen.getByRole('main'))
  })

  it('draws a page a later milestone ports: breadcrumbs from the node’s pill, its header and what is coming', async () => {
    renderApp({
      path: '/projects/fixture/apps/com.example.alpha/build-numbers',
    })
    await page('Build numbers')
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    assert.deepEqual(
      within(crumbs)
        .getAllByRole('listitem')
        .map((item) => item.textContent!.replace(glyph('lan'), '')),
      [
        'Mason Master',
        'Projects & apps',
        'fixture',
        'com.example.alpha',
        'Build numbers',
      ],
    )
    assert.equal(
      within(crumbs)
        .getByRole('link', { name: /Mason Master/ })
        .getAttribute('href'),
      '/',
    )
    assert.equal(
      within(crumbs).getByText('Build numbers').getAttribute('aria-current'),
      'page',
    )
    screen.getByRole('heading', { name: 'Coming in M8' })
    assert.equal(
      screen
        .getByRole('link', { name: /Open the current page/ })
        .getAttribute('href'),
      '/projects/fixture/apps/com.example.alpha/build-numbers',
    )
  })

  it('renders 403 inside the shell, naming who can open the page and the viewer’s role', async () => {
    renderApp({ path: '/backups', replies: shellReplies('developer') })
    await page('Backups')
    screen.getByRole('heading', {
      level: 2,
      name: 'Backups is for managers and administrators',
    })
    screen.getByText(
      'Your role is developer. Ask an administrator if you need access.',
    )
    screen.getByRole('button', { name: 'Go back' }).click()
    cleanup()
    renderApp({ path: '/runs/1', replies: shellReplies('tester') })
    await page('Run')
    screen.getByRole('heading', {
      level: 2,
      name: 'Run is for developers, managers and administrators',
    })
  })

  it('renders 404 inside the shell, for unknown addresses and the master’s pages on the host', async () => {
    renderApp({ path: '/no-such-page' })
    await page('Not found')
    screen.getByRole('heading', { level: 2, name: 'There is no such page' })
    assert.equal(
      within(document.querySelector('.m-empty')!).getByRole('link', {
        name: 'Projects & apps',
      }).className,
      'm-btn m-btn--primary',
    )
    await act(async () =>
      within(document.querySelector('.m-empty')!)
        .getByRole('button', { name: 'Search' })
        .click(),
    )
    screen.getByRole('combobox')
    cleanup()
    renderApp({
      node: nodeInfo('host'),
      path: '/nodes',
      replies: shellReplies('admin', 'host'),
    })
    await page('Not found')
    cleanup()
    renderApp({
      node: nodeInfo('host'),
      path: '/projects/fixture/secrets',
      replies: shellReplies('admin', 'host'),
    })
    await page('Not found')
  })

  it('sends a 401 to the node’s sign-in with a full load, and offers to try again when the session cannot be read', async () => {
    const app = renderApp({
      path: '/projects',
      replies: {
        '/api/v2/session': { status: 401, body: { error: 'Sign in' } },
      },
    })
    await until(() => app.left.length > 0, 'the redirect')
    assert.deepEqual(app.left, ['/sign-in'])
    screen.getByRole('status', { name: 'Loading Mason' })
    cleanup()
    let up = false
    const again = renderApp({
      path: '/projects',
      replies: {
        ...shellReplies('admin'),
        '/api/v2/session': () =>
          up
            ? new Response(JSON.stringify(sessionFor('admin')))
            : new Response('{"error":"The master is restarting"}', {
                status: 503,
              }),
      },
    })
    await page('Mason could not be reached')
    screen.getByText('The master is restarting')
    up = true
    await act(async () =>
      screen.getByRole('button', { name: 'Try again' }).click(),
    )
    await page('Projects & apps')
    assert.equal(again.left.length, 0)
  })

  it('shows the signed-out pages in the bare shell, each node its own sign-in, and setup before anything on a fresh master', async () => {
    renderApp({ path: '/sign-in', replies: {} })
    await page('Sign in')
    assert(document.querySelector('.m-bare') != null)
    cleanup()
    renderApp({ node: nodeInfo('host'), path: '/auth/login', replies: {} })
    await page('Sign in')
    cleanup()
    renderApp({ node: nodeInfo('host'), path: '/auth/invite', replies: {} })
    await page('Choose your password')
    cleanup()
    renderApp({
      node: nodeInfo('master', { setupNeeded: true }),
      path: '/projects',
      replies: {},
    })
    await page('Set up this master')
  })
})

/** Keeps the harness type in use for readers of this file. */
export type { Harness }
