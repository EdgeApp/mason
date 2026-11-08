import { version } from '../version.js'
import { escape } from './html.js'
import { icon, type IconName } from './icons.js'

export type ViewerRole = 'admin' | 'manager' | 'developer' | 'tester'

/** Where a page is served: the master, a host, or a standalone distribution server. */
export type ViewerNode = 'master' | 'host' | 'standalone'

/**
 * Who is looking, and where: the capability object every view consults.
 * Administration exists only on the master; the host renders the same views
 * without it, and the standalone distribution server only Install apps,
 * Devices and its own People.
 */
export interface Viewer {
  name: string
  role: ViewerRole
  node: ViewerNode
  /** The sign-out control, which differs between the host and the master; on Your account. */
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
  /** The nodes that serve it. */
  nodes: ViewerNode[]
}
const everywhere: ViewerNode[] = ['master', 'host', 'standalone']
const nodes: ViewerNode[] = ['master', 'host']
const master: ViewerNode[] = ['master']
const rail: RailItem[] = [
  {
    key: 'catalog',
    href: '/apps',
    label: 'Install apps',
    icon: 'mobile_arrow_down',
    role: 'tester',
    nodes: everywhere,
  },
  {
    key: 'dashboard',
    href: '/projects',
    label: 'Projects & apps',
    icon: 'dashboard',
    role: 'developer',
    nodes,
  },
  {
    key: 'artifacts',
    href: '/artifacts',
    label: 'Artifacts',
    icon: 'inventory_2',
    role: 'developer',
    nodes,
  },
  {
    key: 'devices',
    href: '/devices',
    label: 'Devices',
    icon: 'mobile',
    role: 'tester',
    nodes: everywhere,
  },
  {
    key: 'nodes',
    href: '/nodes',
    label: 'Nodes',
    icon: 'dns',
    role: 'manager',
    nodes: master,
  },
  {
    key: 'cloud',
    href: '/cloud',
    label: 'Cloud',
    icon: 'cloud',
    role: 'manager',
    nodes: master,
  },
  {
    key: 'people',
    href: '/people',
    label: 'People',
    icon: 'person',
    role: 'manager',
    nodes: master,
  },
  {
    key: 'groups',
    href: '/groups',
    label: 'Groups',
    icon: 'group',
    role: 'manager',
    nodes: master,
  },
  {
    key: 'settings',
    href: '/settings',
    label: 'Settings',
    icon: 'settings',
    role: 'manager',
    nodes: master,
  },
  {
    key: 'backups',
    href: '/backups',
    label: 'Backups',
    icon: 'backup',
    role: 'manager',
    nodes: master,
  },
  // The standalone server's own accounts page, for its administrators.
  {
    key: 'people',
    href: '/people',
    label: 'People',
    icon: 'person',
    role: 'admin',
    nodes: ['standalone'],
  },
]

/** The navigation rail's links the viewer may follow on this node. */
export function railItems(viewer: Viewer): RailItem[] {
  return rail.filter(
    (item) => item.nodes.includes(viewer.node) && atLeast(viewer, item.role),
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
}

/** Whether the node serves search, notifications and the shell script (not a standalone server). */
const searchable = (viewer: Viewer | undefined): viewer is Viewer =>
  viewer != null && viewer.node !== 'standalone'

function topbar(options: ShellOptions): string {
  const viewer = options.viewer
  const search = !searchable(viewer)
    ? '<span class="spacer"></span>'
    : `<button type="button" class="search" data-search aria-keyshortcuts="Meta+K Control+K">${icon('search')}<span>Search projects, apps, runs, commits</span><kbd>⌘K</kbd></button><span class="spacer"></span>`
  const status =
    options.status == null
      ? ''
      : `<span class="status" title="Workers idle of those linked">${icon('dns')}${options.status.idle} / ${options.status.total} workers idle</span><span class="status">${icon(options.status.healthy ? 'check_circle' : 'warning')}Cluster ${options.status.healthy ? 'healthy' : 'degraded'}</span>`
  const notifications = !searchable(viewer)
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
      : `<a class="account" href="/account" aria-label="Your account" title="${escape(`${viewer.name} · ${viewer.role} · ${viewer.node}`)}"><span class="avatar">${escape(viewer.name.trim().charAt(0).toUpperCase() || '?')}</span></a>`
  return `<header class="topbar"><a class="brand" href="/"><img src="/assets/logo/mason-logo-64.png" alt="" width="32" height="32"><span>Mason</span><small class="mono">v${escape(version)}</small></a>${search}${status}${notifications}${account}</header>`
}

function railNav(viewer: Viewer, active?: string): string {
  return `<nav class="rail" aria-label="Main"><div class="section">${viewer.node === 'master' ? 'Master' : 'Host'}</div>${railItems(
    viewer,
  )
    .map(
      (item) =>
        `<a href="${item.href}"${item.key === active ? ' aria-current="page"' : ''} title="${escape(item.label)}">${icon(item.icon)}<span class="label">${escape(item.label)}</span></a>`,
    )
    .join('')}</nav>`
}

/**
 * A whole page: head, top bar and the content, with the side menu for
 * anyone signed in. Search, notifications and their script are the
 * master's and the host's.
 */
export function shell(options: ShellOptions): string {
  const viewer = options.viewer
  const scripts = [
    ...(searchable(viewer) ? ['/assets/shell.js'] : []),
    ...(options.scripts ?? []),
  ]
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(options.title)} · Mason</title><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/assets/logo/mason-logo-180.png"><link rel="stylesheet" href="/assets/style.css">${options.head ?? ''}${scripts
    .map((src) => `<script type="module" src="${escape(src)}"></script>`)
    .join(
      '',
    )}</head><body class="${viewer != null ? 'with-rail' : 'phone'}">${topbar(
    options,
  )}<div class="layout">${viewer != null ? railNav(viewer, options.active) : ''}<main>${options.banners ?? ''}${options.body}</main></div>${
    !searchable(viewer)
      ? ''
      : '<dialog class="search-dialog" aria-label="Search"><form method="dialog"><input type="search" name="q" placeholder="Projects, app IDs, runs, commits, branches" autocomplete="off" aria-label="Search"></form><ul role="listbox"></ul></dialog>'
  }</body></html>`
}

/** A signed-in page's parts, which each node draws in its own shell. */
export interface FramedPage {
  title: string
  /** The whole content, its heading included. */
  body: string
  /** The rail item for this page. */
  active?: string
  scripts?: string[]
  head?: string
}

/**
 * The phone-first page for those not signed in (sign-in, invitations, the
 * device-registration callback): no side menu.
 */
export function page(title: string, content: string): string {
  return shell({ title, body: `<h1>${escape(title)}</h1>${content}` })
}
