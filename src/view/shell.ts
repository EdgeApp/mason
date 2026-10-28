import { version } from '../version.js'
import { escape } from './html.js'
import { icon, type IconName } from './icons.js'

export type ViewerRole = 'admin' | 'manager' | 'developer' | 'tester'

/**
 * Who is looking, and where: the capability object every view consults.
 * Administration exists only on the master; the host renders the same views
 * without it.
 */
export interface Viewer {
  name: string
  role: ViewerRole
  node: 'master' | 'host'
  /** The sign-out control, which differs between the host and the master. */
  signOut: string
}

const rank: Record<ViewerRole, number> = {
  tester: 0,
  developer: 1,
  manager: 2,
  admin: 3,
}
/** Whether the viewer's role is at least `role`. */
export function atLeast(viewer: Viewer, role: ViewerRole): boolean {
  return rank[viewer.role] >= rank[role]
}

export interface Notification {
  icon: IconName
  text: string
  href?: string
}

interface RailItem {
  key: string
  href: string
  label: string
  icon: IconName
  /** The least role that sees it. */
  role: ViewerRole
  /** Only on this node; both when absent. */
  node?: 'master' | 'host'
}
const rail: RailItem[] = [
  {
    key: 'dashboard',
    href: '/',
    label: 'Projects & apps',
    icon: 'dashboard',
    role: 'developer',
  },
  {
    key: 'catalog',
    href: '/apps',
    label: 'Install apps',
    icon: 'mobile_arrow_down',
    role: 'tester',
    node: 'host',
  },
  {
    key: 'artifacts',
    href: '/artifacts',
    label: 'Artifacts',
    icon: 'inventory_2',
    role: 'developer',
  },
  {
    key: 'devices',
    href: '/devices',
    label: 'Devices',
    icon: 'mobile',
    role: 'tester',
    node: 'host',
  },
  {
    key: 'nodes',
    href: '/nodes',
    label: 'Nodes',
    icon: 'dns',
    role: 'manager',
    node: 'master',
  },
  {
    key: 'cloud',
    href: '/cloud',
    label: 'Cloud',
    icon: 'cloud',
    role: 'manager',
    node: 'master',
  },
  {
    key: 'people',
    href: '/people',
    label: 'People',
    icon: 'group',
    role: 'manager',
    node: 'master',
  },
  {
    key: 'settings',
    href: '/settings',
    label: 'Settings',
    icon: 'settings',
    role: 'manager',
    node: 'master',
  },
  {
    key: 'backups',
    href: '/backups',
    label: 'Backups',
    icon: 'backup',
    role: 'manager',
    node: 'master',
  },
]

/** The navigation rail's links the viewer may follow on this node. */
export function railItems(viewer: Viewer): RailItem[] {
  return rail.filter(
    (item) =>
      atLeast(viewer, item.role) &&
      (item.node == null || item.node === viewer.node),
  )
}

export interface ShellOptions {
  title: string
  body: string
  viewer?: Viewer
  /** The rail item for this page. */
  active?: string
  /** Notices above the content: test endpoints, the backup reminder. */
  banners?: string
  scripts?: string[]
  /** Extra `<head>` markup, such as the CSRF meta tag. */
  head?: string
  /** Worker capacity and cluster health, on the master. */
  status?: { idle: number; total: number; healthy: boolean }
  notifications?: Notification[]
  /** Tester pages are phone-first and have no navigation rail. */
  phone?: boolean
  /** Controls at the right of the top bar, for pages without a viewer. */
  actions?: string
}

function topbar(options: ShellOptions): string {
  const viewer = options.viewer
  const search =
    viewer == null
      ? '<span class="spacer"></span>'
      : `<button type="button" class="search" data-search aria-keyshortcuts="Meta+K Control+K">${icon('search')}<span>Search projects, apps, runs, commits</span><kbd>⌘K</kbd></button><span class="spacer"></span>`
  const status =
    options.status == null
      ? ''
      : `<span class="status" title="Workers idle of those linked">${icon('dns')}${options.status.idle} / ${options.status.total} workers idle</span><span class="status">${icon(options.status.healthy ? 'check_circle' : 'warning')}Cluster ${options.status.healthy ? 'healthy' : 'degraded'}</span>`
  const notifications =
    viewer == null
      ? ''
      : `<details class="notifications"><summary aria-label="Notifications">${icon('notifications')}${
          (options.notifications ?? []).length > 0
            ? `<span class="count">${options.notifications!.length}</span>`
            : ''
        }</summary><div class="menu"><ul>${
          (options.notifications ?? [])
            .map(
              (item) =>
                `<li>${icon(item.icon)} ${item.href == null ? escape(item.text) : `<a href="${escape(item.href)}">${escape(item.text)}</a>`}</li>`,
            )
            .join('') || '<li>Nothing needs you.</li>'
        }</ul></div></details>`
  const account =
    viewer == null
      ? ''
      : `<details class="account"><summary aria-label="Account"><span class="avatar">${escape(viewer.name.trim().charAt(0).toUpperCase() || '?')}</span></summary><div class="menu"><div class="who"><strong>${escape(viewer.name)}</strong><small>${escape(viewer.role)} · ${viewer.node}</small></div>${viewer.signOut}</div></details>`
  return `<header class="topbar"><a class="brand" href="/"><img src="/assets/logo/mason-logo-64.png" alt="" width="32" height="32"><span>Mason</span><small class="mono">v${escape(version)}</small></a>${search}${status}${
    options.actions == null ? '' : `<nav>${options.actions}</nav>`
  }${notifications}${account}</header>`
}

function railNav(viewer: Viewer, active?: string): string {
  return `<nav class="rail" aria-label="Main"><div class="section">${viewer.node === 'master' ? 'Master' : 'Builds'}</div>${railItems(
    viewer,
  )
    .map(
      (item) =>
        `<a href="${item.href}"${item.key === active ? ' aria-current="page"' : ''} title="${escape(item.label)}">${icon(item.icon)}<span class="label">${escape(item.label)}</span></a>`,
    )
    .join('')}</nav>`
}

/** A whole page: head, top bar, the rail for developers and up, and the content. */
export function shell(options: ShellOptions): string {
  const viewer = options.viewer
  const withRail =
    viewer != null && options.phone !== true && atLeast(viewer, 'developer')
  const scripts = [
    ...(viewer == null ? [] : ['/assets/shell.js']),
    ...(options.scripts ?? []),
  ]
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(options.title)} · Mason</title><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/assets/logo/mason-logo-180.png"><link rel="stylesheet" href="/assets/style.css">${options.head ?? ''}${scripts
    .map((src) => `<script type="module" src="${escape(src)}"></script>`)
    .join('')}</head><body class="${withRail ? 'with-rail' : 'phone'}">${topbar(
    options,
  )}<div class="layout">${withRail ? railNav(viewer, options.active) : ''}<main>${options.banners ?? ''}${options.body}</main></div>${
    viewer == null
      ? ''
      : '<dialog class="search-dialog" aria-label="Search"><form method="dialog"><input type="search" name="q" placeholder="Projects, app IDs, runs, commits, branches" autocomplete="off" aria-label="Search"></form><ul role="listbox"></ul></dialog>'
  }</body></html>`
}

/**
 * The phone-first page the tester flows use (sign-in, catalog, install,
 * device registration): no rail, the given controls in the top bar.
 */
export function page(
  title: string,
  content: string,
  navigation = '',
  interactive = false,
): string {
  return shell({
    title,
    body: `<h1>${escape(title)}</h1>${content}`,
    actions: navigation,
    phone: true,
    ...(interactive ? { scripts: ['/assets/catalog.js'] } : {}),
  })
}
