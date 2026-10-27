import type { DatabaseSync } from 'node:sqlite'
import { runHref } from './dashboard.js'
import {
  atLeast,
  type Notification,
  type Viewer,
  type ViewerRole,
} from './shell.js'

/**
 * The approvals the viewer may decide: each waiting approval whose roles
 * include the viewer's. `roles` reads an approval's roles from its run's
 * graph; admin and manager decide when it names none.
 */
export function approvalNotifications(
  db: DatabaseSync,
  viewer: Viewer,
  roles: (job: string, stage: string) => ViewerRole[] | undefined,
): Notification[] {
  return (
    db
      .prepare(
        "SELECT j.id,j.number,j.workflow,j.branch,s.name,p.slug FROM job_stages s JOIN jobs j ON j.id=s.job_id JOIN projects p ON p.id=j.project_id WHERE s.status='awaiting_approval' ORDER BY s.started,j.created LIMIT 20",
      )
      .all() as Array<{
      id: string
      number: number
      workflow: string
      branch: string
      name: string
      slug: string
    }>
  )
    .filter(
      (row) =>
        viewer.role === 'admin' ||
        (roles(row.id, row.name) ?? ['admin', 'manager']).includes(viewer.role),
    )
    .map((row) => ({
      icon: 'pan_tool' as const,
      text: `${row.slug} ${row.workflow} #${row.number} (${row.branch}) waits for your approval at ${row.name}`,
      href: runHref(row.id),
    }))
}

/**
 * What needs the viewer: approvals they may decide, and on the master, for
 * managers and administrators, its own notices (the Apple two-factor code,
 * cloud budget, node checklists, certificates and app IDs needing Apple
 * setup, the backup reminder).
 */
export function notificationsFor(
  viewer: Viewer,
  approvals: Notification[],
  masterNotices: string[] = [],
): Notification[] {
  const notices =
    viewer.node === 'master' && atLeast(viewer, 'manager')
      ? masterNotices.map((text) => ({ icon: 'warning' as const, text }))
      : []
  return [...approvals, ...notices]
}

/** An approval's roles from a run's graph as the host caches it (JSON). */
export function approvalRolesFromGraph(
  graph: string | null,
  workflow: string,
  stage: string,
): ViewerRole[] | undefined {
  if (graph == null) return undefined
  try {
    const parsed = JSON.parse(graph) as {
      workflows?: Array<{
        name: string
        stages?: Array<{ name: string; approval?: { roles?: ViewerRole[] } }>
      }>
    }
    return parsed.workflows
      ?.find((entry) => entry.name === workflow)
      ?.stages?.find((entry) => entry.name === stage)?.approval?.roles
  } catch {
    return undefined
  }
}
