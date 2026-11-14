import type { DatabaseSync } from 'node:sqlite'
import { isGlob, matches } from '../rules.js'
import { queueEntries } from '../queue.js'
import type { Viewer } from './viewer.js'
import type {
  DashboardData,
  DashboardFilter,
  PlatformName,
  ProjectCard,
  QueueEntry,
  WorkerNode,
} from '../../shared/api/dashboard.js'

/**
 * Whether builds row `b` stands for its build: a run's variants are one
 * build, shown as its default variant, or, when the run published only
 * named ones, its first by name (SQLite's byte order, as the branch page
 * and the run pages sort them).
 */
const leadsItsBuild = (b: string): string =>
  `(${b}.variant='' OR NOT EXISTS (SELECT 1 FROM builds d WHERE d.run=${b}.run AND d.app_id=${b}.app_id AND d.platform=${b}.platform AND d.state='ready' AND d.deleted_at IS NULL AND (d.variant='' OR d.variant<${b}.variant)))`

/** What the dashboard reads; the master's database and the host's cache share these tables. */
export interface DashboardSource {
  db: DatabaseSync
  viewer: Viewer
  now: number
  /** Whether the viewer may see an app ID (its builds and installs). */
  appVisible: (appId: number) => boolean
  /** The master's worker nodes; the host has none to show. */
  nodes?: WorkerNode[]
  /** Projects' repositories and webhooks: the master's, or the host's copy of them. */
  repositories?: Map<number, { repository: string; webhook: boolean }>
  /** Each project's push branches (or patterns), whose builds its card lists first. */
  pinned?: Map<number, readonly string[]>
}

export type { DashboardData, DashboardFilter, ProjectCard, QueueEntry }

/** How many of an app's most recently built branches the card reads to rank its chips. */
const BRANCHES_READ = 100

const DAY = 86_400_000

/** Gathers the dashboard: tiles, filter counts, project cards and the side column. */
export function dashboardData(
  source: DashboardSource,
  filter: DashboardFilter = {},
): DashboardData {
  const { db } = source
  const projects = (
    db
      .prepare(
        'SELECT id,slug,name,default_branch FROM projects WHERE enabled=1 ORDER BY position,id',
      )
      .all() as Array<{
      id: number
      slug: string
      name: string
      default_branch: string | null
    }>
  ).filter(
    (project) => filter.project == null || project.slug === filter.project,
  )
  const appsOf = db.prepare(
    'SELECT a.id,a.slug,a.name FROM project_apps pa JOIN apps a ON a.id=pa.app_id WHERE pa.project_id=? AND a.enabled=1 ORDER BY a.position,a.id',
  )
  const platformsOf = db.prepare(
    'SELECT DISTINCT platform FROM channels WHERE app_id=? AND enabled=1 ORDER BY platform',
  )
  const buildsOf = db.prepare(
    // Each branch's latest build, and its run: a build's other variants never displace it.
    `SELECT b.branch,b.build_number,b.published_at,b.run,j.status FROM builds b LEFT JOIN jobs j ON j.id=b.run WHERE b.app_id=? AND b.state='ready' AND b.deleted_at IS NULL AND b.id IN (SELECT MAX(h.id) FROM builds h WHERE h.app_id=? AND h.state='ready' AND h.deleted_at IS NULL AND ${leadsItsBuild('h')} GROUP BY h.branch) ORDER BY b.published_at DESC,b.id DESC LIMIT ${BRANCHES_READ}`,
  )
  const branchesOf = db.prepare(
    "SELECT COUNT(DISTINCT branch) AS n FROM builds WHERE app_id=? AND state='ready' AND deleted_at IS NULL",
  )
  const runsOf = db.prepare(
    "SELECT id,branch,number,status,workflow,commit_sha,description,created FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY branch ORDER BY created DESC) AS place FROM jobs WHERE project_id=? AND workflow NOT LIKE '@%') WHERE place=1 ORDER BY created DESC LIMIT 4",
  )
  const counts: DashboardData['counts'] = {
    all: 0,
    ios: 0,
    android: 0,
    macos: 0,
    windows: 0,
    tvos: 0,
  }
  const cards: ProjectCard[] = []
  let appTotal = 0
  for (const project of projects) {
    // Push branches first, in the trigger's order; the rest stay newest first.
    const pinned = source.pinned?.get(project.id) ?? []
    const rank = (branch: string): number => {
      const place = pinned.findIndex((pattern) =>
        isGlob(pattern) ? matches(pattern, branch) : pattern === branch,
      )
      return place === -1 ? pinned.length : place
    }
    const apps = (
      appsOf.all(project.id) as Array<{
        id: number
        slug: string
        name: string
      }>
    )
      .filter((app) => source.appVisible(app.id))
      .map((app) => ({
        ...app,
        platforms: (platformsOf.all(app.id) as Array<{ platform: string }>).map(
          (row) => row.platform,
        ),
        builds: (
          buildsOf.all(app.id, app.id) as Array<{
            branch: string
            build_number: string
            published_at: number
            run: string | null
            status: string | null
          }>
        )
          .map((row) => ({
            branch: row.branch,
            buildNumber: row.build_number,
            at: row.published_at,
            ...(row.run == null ? {} : { run: row.run }),
            ...(row.status == null ? {} : { status: row.status }),
          }))
          .sort((a, b) => rank(a.branch) - rank(b.branch)),
        branches: Number(
          (branchesOf.get(app.id) as { n: number } | undefined)?.n ?? 0,
        ),
      }))
    appTotal += apps.length
    for (const app of apps) {
      counts.all++
      for (const platform of app.platforms)
        if (platform in counts) counts[platform as PlatformName]++
    }
    const shown =
      filter.platform == null
        ? apps
        : apps.filter((app) => app.platforms.includes(filter.platform!))
    if (filter.platform != null && shown.length === 0) continue
    const runs = runsOf.all(project.id) as Array<{
      id: string
      branch: string
      number: number
      status: string
      workflow: string
      commit_sha: string | null
      description: string | null
      created: number
    }>
    const head = runs.find((run) => run.commit_sha != null)
    const meta = source.repositories?.get(project.id)
    cards.push({
      id: project.id,
      slug: project.slug,
      name: project.name,
      defaultBranch: project.default_branch,
      ...(meta == null
        ? {}
        : { repository: meta.repository, webhook: meta.webhook }),
      ...(head == null
        ? {}
        : {
            latest: {
              commit: head.commit_sha!,
              description: head.description ?? '',
              at: head.created,
            },
          }),
      runs: runs.map((run) => ({
        id: run.id,
        branch: run.branch,
        number: run.number,
        status: run.status,
        workflow: run.workflow,
      })),
      apps: shown,
    })
  }
  const finished = db
    .prepare(
      "SELECT SUM(status='succeeded') AS ok,COUNT(*) AS total FROM jobs WHERE status IN ('succeeded','unstable','failed','timed_out') AND finished>=? AND workflow NOT LIKE '@%'",
    )
    .get(source.now - 30 * DAY) as { ok: number | null; total: number }
  const storage =
    Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(size),0) AS size FROM builds WHERE state='ready' AND deleted_at IS NULL",
          )
          .get() as { size: number }
      ).size,
    ) +
    Number(
      (
        db
          .prepare(
            'SELECT COALESCE(SUM(size),0) AS size FROM run_artifacts WHERE deleting=0',
          )
          .get() as { size: number }
      ).size,
    )
  const queue = queueEntries(db, source.now)
  const builds = (
    db
      .prepare(
        `SELECT b.id,b.app_id,a.name,b.platform,b.build_number,b.version,b.branch,b.published_at,b.size FROM builds b JOIN apps a ON a.id=b.app_id WHERE b.state='ready' AND b.deleted_at IS NULL AND ${leadsItsBuild('b')} AND a.enabled=1 ORDER BY b.published_at DESC,b.id DESC LIMIT 20`,
      )
      .all() as Array<{
      id: number
      app_id: number
      name: string
      platform: string
      build_number: string
      version: string
      branch: string
      published_at: number
      size: number
    }>
  )
    .filter((row) => source.appVisible(row.app_id))
    .slice(0, 6)
    .map((row) => ({
      id: row.id,
      app: row.name,
      platform: row.platform,
      buildNumber: row.build_number,
      version: row.version,
      branch: row.branch,
      at: row.published_at,
      size: row.size,
    }))
  return {
    tiles: {
      projects: projects.length,
      apps: appTotal,
      finished: finished.total,
      ...(finished.total === 0
        ? {}
        : { successRate: Number(finished.ok ?? 0) / finished.total }),
      storage,
    },
    counts,
    filter,
    projects: cards,
    queue,
    builds,
    ...(source.nodes == null ? {} : { nodes: source.nodes }),
  }
}
