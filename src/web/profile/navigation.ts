// The destinations (DESIGN-LANGUAGE.md §9's table): sections, order, the
// permission that opens each (the viewer's set comes from the session) and
// the nodes that serve it. The sidebar, the rail, the tab bar and the 403
// page read it; the order is the same at every tier.
import type { Permission, Role } from '../../shared/permissions.js'
import type { IconName } from '../ui/icons.js'

export type NavSection = 'Build' | 'Distribute' | 'Cluster' | 'Admin'

export interface NavItem {
  key: string
  label: string
  /** The rail's and tab bar's shorter label. */
  short: string
  icon: IconName
  href: string
  section: NavSection
  /** What the viewer's session must hold to open it. */
  permission: Permission
  /** The least role holding that permission, for the 403 page's words. */
  least: Role
  /** Master-only destinations are not registered on the host. */
  masterOnly: boolean
}

const item = (
  section: NavSection,
  key: string,
  label: string,
  short: string,
  icon: IconName,
  href: string,
  permission: Permission,
  least: Role,
  masterOnly = false,
): NavItem => ({
  key,
  label,
  short,
  icon,
  href,
  section,
  permission,
  least,
  masterOnly,
})

/** Every destination, in order. */
export const NAV: readonly NavItem[] = [
  item(
    'Build',
    'dashboard',
    'Projects & apps',
    'Projects',
    'dashboard',
    '/projects',
    'projects.read',
    'developer',
  ),
  item(
    'Build',
    'artifacts',
    'Artifacts',
    'Artifacts',
    'inventory_2',
    '/artifacts',
    'runs.read',
    'developer',
  ),
  item(
    'Distribute',
    'catalog',
    'Install apps',
    'Install',
    'mobile_arrow_down',
    '/apps',
    'builds.read',
    'tester',
  ),
  item(
    'Distribute',
    'devices',
    'Devices',
    'Devices',
    'mobile',
    '/devices',
    'devices.register',
    'tester',
  ),
  item(
    'Cluster',
    'nodes',
    'Nodes',
    'Nodes',
    'dns',
    '/nodes',
    'nodes.read',
    'manager',
    true,
  ),
  item(
    'Cluster',
    'cloud',
    'Cloud',
    'Cloud',
    'cloud',
    '/cloud',
    'settings.read',
    'manager',
    true,
  ),
  item(
    'Admin',
    'people',
    'People',
    'People',
    'person',
    '/people',
    'people.read',
    'manager',
    true,
  ),
  item(
    'Admin',
    'groups',
    'Groups',
    'Groups',
    'group',
    '/groups',
    'groups.read',
    'manager',
    true,
  ),
  item(
    'Admin',
    'settings',
    'Settings',
    'Settings',
    'settings',
    '/settings',
    'settings.read',
    'manager',
    true,
  ),
  item(
    'Admin',
    'backups',
    'Backups',
    'Backups',
    'backup',
    '/backups',
    'settings.read',
    'manager',
    true,
  ),
]

/** A destination by its key. */
export const navItem = (key: string): NavItem | undefined =>
  NAV.find((entry) => entry.key === key)

/** Whether a node serves a destination at all. */
export const served = (entry: NavItem, node: 'master' | 'host'): boolean =>
  node === 'master' || !entry.masterOnly

/** The destinations a viewer may open on this node, in order. */
export function navFor(
  node: 'master' | 'host',
  permissions: readonly Permission[],
): NavItem[] {
  return NAV.filter(
    (entry) => served(entry, node) && permissions.includes(entry.permission),
  )
}

/** The destinations grouped by section, empty sections dropped. */
export function navSections(
  items: readonly NavItem[],
): Array<{ section: NavSection; items: NavItem[] }> {
  const sections: Array<{ section: NavSection; items: NavItem[] }> = []
  for (const entry of items) {
    const last = sections[sections.length - 1]
    if (last?.section === entry.section) last.items.push(entry)
    else sections.push({ section: entry.section, items: [entry] })
  }
  return sections
}

/** The most items the tab bar holds. */
export const TAB_BAR_MAX = 5

/**
 * The tab bar's items: all of them when there are five or fewer, else the
 * first four and More, which holds the rest.
 */
export function tabBar(items: readonly NavItem[]): {
  tabs: NavItem[]
  more: NavItem[]
} {
  if (items.length <= TAB_BAR_MAX) return { tabs: [...items], more: [] }
  return {
    tabs: items.slice(0, TAB_BAR_MAX - 1),
    more: items.slice(TAB_BAR_MAX - 1),
  }
}

/** The destination a path belongs to, for `aria-current`. */
export function currentNav(
  pathname: string,
  items: readonly NavItem[],
): NavItem | undefined {
  return items.find(
    (entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`),
  )
}

/** Who a destination is for, in words: "managers and administrators". */
export function audience(least: Role): string {
  return {
    tester: 'everyone signed in',
    developer: 'developers, managers and administrators',
    manager: 'managers and administrators',
    admin: 'administrators',
  }[least]
}

/** Where `/` takes a viewer: the first destination they may open. */
export const homeFor = (items: readonly NavItem[]): string =>
  items[0]?.href ?? '/account'
