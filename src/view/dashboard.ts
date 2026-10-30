import type { DatabaseSync } from 'node:sqlite'
import { ago, duration, escape } from './html.js'
import { icon, type IconName } from './icons.js'
import type { Viewer } from './shell.js'

export const platforms = ['ios', 'android', 'macos', 'windows'] as const
export type Platform = (typeof platforms)[number]
/**
 * Whether builds row `b` stands for its build: a run's variants are one
 * build, shown as its default variant, or, when the run published only
 * named ones, its first by name (SQLite's byte order, as the branch page
 * and the run pages sort them).
 */
const leadsItsBuild = (b: string): string =>
  `(${b}.variant='' OR NOT EXISTS (SELECT 1 FROM builds d WHERE d.run=${b}.run AND d.app_id=${b}.app_id AND d.platform=${b}.platform AND d.state='ready' AND d.deleted_at IS NULL AND (d.variant='' OR d.variant<${b}.variant)))`

const platformNames: Record<Platform, string> = {
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
}
const platformIcons: Record<Platform, IconName> = {
  ios: 'ios',
  android: 'android',
  macos: 'desktop_mac',
  windows: 'desktop_windows',
}

/** A platform chip. */
export function platformChip(platform: string): string {
  const known = (platforms as readonly string[]).includes(platform)
    ? (platform as Platform)
    : undefined
  return `<span class="platform">${known == null ? '' : icon(platformIcons[known])}${escape(known == null ? platform : platformNames[known])}</span>`
}

/** A run status as a dot and its word. */
export function statusDot(status: string): string {
  return `<span class="dot ${escape(status)}" aria-hidden="true"></span>`
}

/** What the dashboard reads; the master's database and the host's cache share these tables. */
export interface DashboardSource {
  db: DatabaseSync
  viewer: Viewer
  now: number
  /** Whether the viewer may see an app ID (its builds and installs). */
  appVisible: (appId: number) => boolean
  /** The master's worker nodes; the host has none to show. */
  nodes?: Array<{
    name: string
    status: 'idle' | 'busy' | 'offline'
    detail: string
  }>
  /** Projects' repositories and webhooks, which only the master keeps. */
  repositories?: Map<number, { repository: string; webhook: boolean }>
}

export interface DashboardFilter {
  platform?: string
  project?: string
}

interface ProjectCard {
  id: number
  slug: string
  name: string
  defaultBranch: string | null
  repository?: string
  webhook?: boolean
  latest?: { commit: string; description: string; at: number }
  runs: Array<{
    id: string
    branch: string
    number: number
    status: string
    workflow: string
  }>
  apps: Array<{
    id: number
    slug: string
    name: string
    platforms: string[]
    builds: Array<{ branch: string; buildNumber: string; at: number }>
  }>
}

export interface DashboardData {
  tiles: {
    projects: number
    apps: number
    successRate?: number
    finished: number
    storage: number
  }
  counts: Record<'all' | Platform, number>
  filter: DashboardFilter
  projects: ProjectCard[]
  queue: Array<{
    job: string
    project: string
    workflow: string
    number: number
    branch: string
    stage: string
    status: string
    elapsed?: number
    progress?: number
  }>
  builds: Array<{
    id: number
    app: string
    platform: string
    buildNumber: string
    version: string
    branch: string
    at: number
    size: number
  }>
  nodes?: DashboardSource['nodes']
}

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
    // One row per build: a build's other variants never displace it.
    `SELECT branch,build_number,published_at FROM builds WHERE app_id=? AND state='ready' AND deleted_at IS NULL AND id IN (SELECT MAX(h.id) FROM builds h WHERE h.app_id=? AND h.state='ready' AND h.deleted_at IS NULL AND ${leadsItsBuild('h')} GROUP BY h.branch) ORDER BY published_at DESC LIMIT 3`,
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
  }
  const cards: ProjectCard[] = []
  let appTotal = 0
  for (const project of projects) {
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
          }>
        ).map((row) => ({
          branch: row.branch,
          buildNumber: row.build_number,
          at: row.published_at,
        })),
      }))
    appTotal += apps.length
    for (const app of apps) {
      counts.all++
      for (const platform of app.platforms)
        if (platform in counts) counts[platform as Platform]++
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
  const typical = db.prepare(
    "SELECT AVG(s.finished-s.started) AS ms FROM job_stages s JOIN jobs j ON j.id=s.job_id WHERE j.project_id=? AND j.workflow=? AND s.name=? AND s.status='succeeded' AND s.finished IS NOT NULL AND s.started IS NOT NULL",
  )
  const queue = (
    db
      .prepare(
        "SELECT j.id AS job,j.project_id,p.slug,j.workflow,j.number,j.branch,s.name,s.status,s.started FROM job_stages s JOIN jobs j ON j.id=s.job_id JOIN projects p ON p.id=j.project_id WHERE s.status IN ('running','queued') AND s.kind!='approval' AND s.name NOT LIKE '@%' ORDER BY s.status='running' DESC,j.created,s.position LIMIT 8",
      )
      .all() as Array<{
      job: string
      project_id: number
      slug: string
      workflow: string
      number: number
      branch: string
      name: string
      status: string
      started: number | null
    }>
  ).map((row) => {
    const elapsed = row.started == null ? undefined : source.now - row.started
    const usual = (
      typical.get(row.project_id, row.workflow, row.name) as {
        ms: number | null
      }
    ).ms
    return {
      job: row.job,
      project: row.slug,
      workflow: row.workflow,
      number: row.number,
      branch: row.branch,
      stage: row.name,
      status: row.status,
      ...(elapsed == null ? {} : { elapsed }),
      ...(elapsed == null || usual == null || usual <= 0
        ? {}
        : { progress: Math.min(0.99, elapsed / usual) }),
    }
  })
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

/** Bytes as `312.8 GB`. */
export function bytes(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

function tile(
  iconName: IconName,
  label: string,
  value: string,
  note = '',
): string {
  return `<div class="tile">${icon(iconName)}<div><span>${escape(label)}</span><strong>${escape(value)}</strong>${note === '' ? '' : `<small>${escape(note)}</small>`}</div></div>`
}

function query(filter: DashboardFilter, change: DashboardFilter): string {
  const merged = { ...filter, ...change }
  const params = new URLSearchParams()
  if (merged.project != null) params.set('project', merged.project)
  if (merged.platform != null) params.set('platform', merged.platform)
  const text = params.toString()
  return text === '' ? '/' : `/?${text}`
}

/** A run's page. */
export const runHref = (id: string): string => `/runs/${encodeURIComponent(id)}`

function projectCard(
  card: ProjectCard,
  now: number,
  masonfile: boolean,
): string {
  const runs = card.runs
    .map(
      (run) =>
        `<a class="run-chip" href="${runHref(run.id)}" title="${escape(run.workflow)} ${escape(run.status)}">${escape(run.branch)} <span>#${run.number}</span>${statusDot(run.status)}</a>`,
    )
    .join('')
  const apps = card.apps
    .map(
      (app) =>
        `<div class="app-row"><div><span class="mono">${escape(app.slug)}</span> ${app.platforms.map(platformChip).join(' ')}<small>${escape(app.name)}</small></div><div class="runs">${
          app.builds
            .map(
              (build) =>
                `<span class="run-chip">${escape(build.branch)} <span>${escape(build.buildNumber)}</span> <small>${escape(ago(build.at, now))}</small></span>`,
            )
            .join('') || '<small>No builds yet</small>'
        }</div></div>`,
    )
    .join('')
  return `<article class="project" id="project-${escape(card.slug)}"><header>${icon('folder')}<div><h2><a href="${query({}, { project: card.slug })}">${escape(card.name)}</a></h2>${
    card.repository == null
      ? ''
      : `<small class="mono">${escape(card.repository)}</small>`
  }${masonfile ? `<a class="meta-link" href="/projects/${encodeURIComponent(card.slug)}">${icon('tune')} Project</a> <a class="meta-link" href="/projects/${encodeURIComponent(card.slug)}/masonfile">${icon('description')} Masonfile</a>` : ''}<div class="meta">${card.defaultBranch == null ? '' : `<span>${icon('fork_right')} Default: <span class="mono">${escape(card.defaultBranch)}</span></span>`}${
    card.webhook == null
      ? ''
      : `<span>${statusDot(card.webhook ? 'succeeded' : 'queued')} Webhook ${card.webhook ? 'active' : 'not set up'}</span>`
  }${
    card.latest == null
      ? ''
      : `<span>${icon('commit')} <span class="mono">${escape(card.latest.commit.slice(0, 8))}</span> ${escape(card.latest.description)} · ${escape(ago(card.latest.at, now))}</span>`
  }</div></div><div class="runs">${runs}</div></header><div class="apps"><h3>App IDs (${card.apps.length})</h3>${apps || '<p>No app IDs.</p>'}</div></article>`
}

/** The projects-and-apps dashboard for developers and up. */
export function dashboardView(
  data: DashboardData,
  viewer: Viewer,
  now: number,
): string {
  const rate =
    data.tiles.successRate == null
      ? '—'
      : `${(data.tiles.successRate * 100).toFixed(1)}%`
  const chips = (['all', ...platforms] as const)
    .filter((key) => key === 'all' || data.counts[key] > 0)
    .map((key) => {
      const current =
        key === 'all'
          ? data.filter.platform == null
          : data.filter.platform === key
      const href = query(data.filter, {
        platform: key === 'all' ? undefined : key,
      })
      return `<a class="chip" href="${escape(href)}"${current ? ' aria-current="true"' : ''}>${escape(key === 'all' ? 'All' : platformNames[key])} (${data.counts[key]})</a>`
    })
    .join('')
  const queue = data.queue
    .map(
      (entry) =>
        `<li><div><span class="mono">${escape(entry.project)} · ${escape(entry.stage)}</span><small>${escape(entry.workflow)} #${entry.number} · <span class="mono">${escape(entry.branch)}</span>${entry.elapsed == null ? '' : ` · ${escape(duration(entry.elapsed))}`}</small>${
          entry.progress == null
            ? ''
            : `<div class="progress" role="progressbar" aria-valuenow="${Math.round(entry.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.round(entry.progress * 100)}%"></span></div>`
        }</div><span class="state-${escape(entry.status)}">${statusDot(entry.status)} ${escape(entry.status)}</span></li>`,
    )
    .join('')
  const nodes =
    data.nodes == null
      ? ''
      : `<section class="panel"><h2>${icon('dns')}Worker nodes</h2><ul>${
          data.nodes
            .map(
              (node) =>
                `<li><div><span class="mono">${escape(node.name)}</span><small>${escape(node.detail)}</small></div><span>${statusDot(node.status === 'busy' ? 'running' : node.status === 'idle' ? 'succeeded' : 'cancelled')} ${escape(node.status)}</span></li>`,
            )
            .join('') || '<li>No nodes are linked.</li>'
        }</ul></section>`
  const builds = data.builds
    .map(
      (build) =>
        `<li><div><span class="mono">${escape(build.app)} ${escape(build.version)} (${escape(build.buildNumber)})</span><small>${platformChip(build.platform)} <span class="mono">${escape(build.branch)}</span> · ${escape(bytes(build.size))} · ${escape(ago(build.at, now))}</small></div></li>`,
    )
    .join('')
  return `<div class="page-head"><div><div class="breadcrumbs"><span>Mason</span><span>/</span><span>${viewer.node === 'master' ? 'Master' : 'Builds'}</span></div><h1>Projects &amp; apps</h1><p>Every project's app IDs, their latest builds and runs.</p></div>${viewer.node === 'master' && (viewer.role === 'admin' || viewer.role === 'manager') ? `<a class="button" href="/projects/new">${icon('add')} Add project</a>` : ''}</div><div class="tiles">${tile('folder', 'Projects', String(data.tiles.projects))}${tile('apps', 'App IDs', String(data.tiles.apps))}${tile('speed', 'Success rate', rate, data.tiles.finished === 0 ? 'No finished runs in 30 days' : `${data.tiles.finished} runs in 30 days`)}${tile('storage', 'Artifact storage', bytes(data.tiles.storage))}</div><nav class="chips" aria-label="Platforms">${chips}</nav><div class="columns"><div>${
    data.projects
      .map((card) => projectCard(card, now, viewer.node === 'master'))
      .join('') || '<p class="empty-state">No projects match.</p>'
  }</div><aside><section class="panel" data-queue><h2>${icon('hourglass_top')}Queue</h2><ul>${queue || '<li>Nothing is running.</li>'}</ul></section>${nodes}<section class="panel"><h2>${icon('deployed_code')}Recent builds</h2><ul>${builds || '<li>No builds yet.</li>'}</ul></section></aside></div>`
}
