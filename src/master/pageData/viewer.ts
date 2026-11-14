// Who reads a page's data, and on which node: what the page-data functions
// consult to decide what the caller may see.

export type ViewerRole = 'admin' | 'manager' | 'developer' | 'tester'

/** The node answering: the master, or a host from its cache. */
export type ViewerNode = 'master' | 'host'

/** The caller of a page's data route, by role and node. */
export interface Viewer {
  role: ViewerRole
  node: ViewerNode
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

/** Something that needs the viewer: an approval they may decide, or a master notice. */
export interface Notification {
  kind: 'approval' | 'notice'
  text: string
  href?: string
}
