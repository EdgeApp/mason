import type { DatabaseSync } from 'node:sqlite'
import { runHref, statusDot } from './dashboard.js'
import { escape, localTime } from './html.js'
import type { Viewer } from './shell.js'
import { isGlob, matches } from '../master/rules.js'
import { downloadOnly } from '../validation.js'
import type {
  ArtifactRun,
  ArtifactRunDetail,
  ArtifactsList,
  PublishedBuild,
  SavedArtifact,
} from '../shared/api/artifacts.js'
import type { BranchItem, ProjectRunRow } from '../shared/api/projects.js'

export interface ArtifactsFilter {
  project?: string
  run?: string
  branch?: string
}

export interface ArtifactsSource {
  db: DatabaseSync
  viewer: Viewer
  now: number
  appVisible: (appId: number) => boolean
  /** Where a run's artifacts are served: this host, or the host's origin from the master. */
  artifactBase: string
}

interface RunRow {
  id: string
  number: number
  workflow: string
  branch: string
  status: string
  commit_sha: string | null
  description: string | null
  created: number
  started: number | null
  finished: number | null
  slug: string
  name: string
}

/** A run's saved artifacts, each with where it downloads and, for a report, its viewer. */
function savedArtifacts(source: ArtifactsSource, run: string): SavedArtifact[] {
  const rows = source.db
    .prepare(
      'SELECT name,stage,kind,size,created_at FROM run_artifacts WHERE job_id=? AND deleting=0 ORDER BY stage,name',
    )
    .all(run) as Array<{
    name: string
    stage: string
    kind: string
    size: number
    created_at: number
  }>
  const base = `${source.artifactBase}/runs/${encodeURIComponent(run)}/artifacts/`
  return rows.map((row) => ({
    name: row.name,
    stage: row.stage,
    kind: row.kind,
    size: Number(row.size),
    created: Number(row.created_at),
    url: base + encodeURIComponent(row.name),
    ...(row.kind === 'report'
      ? { viewUrl: `${base + encodeURIComponent(row.name)}/view` }
      : {}),
  }))
}

/** A run's published builds the viewer may see; one published before builds named their run is found by its commit and branch. */
function runBuilds(
  source: ArtifactsSource,
  run: RunRow,
): Array<{
  id: number
  app_id: number
  name: string
  platform: string
  version: string
  build_number: string
  size: number
  variant: string
  format: string
}> {
  return (
    source.db
      .prepare(
        "SELECT b.id,b.app_id,a.name,b.platform,b.version,b.build_number,b.size,b.variant,b.format FROM builds b JOIN apps a ON a.id=b.app_id WHERE (b.run=? OR (b.run IS NULL AND b.commit_hash=? AND b.branch=?)) AND b.state='ready' AND b.deleted_at IS NULL ORDER BY b.app_id,b.platform,b.variant<>'',b.variant",
      )
      .all(run.id, run.commit_sha ?? '', run.branch) as Array<{
      id: number
      app_id: number
      name: string
      platform: string
      version: string
      build_number: string
      size: number
      variant: string
      format: string
    }>
  ).filter((build) => source.appVisible(build.app_id))
}

/** A run as the Artifacts pages show it. */
function artifactRun(run: RunRow): ArtifactRun {
  return {
    id: run.id,
    number: Number(run.number),
    workflow: run.workflow,
    branch: run.branch,
    status: run.status,
    project: { slug: run.slug, name: run.name },
    commit: run.commit_sha,
    description: run.description,
    created: Number(run.created),
    started: run.started == null ? null : Number(run.started),
    finished: run.finished == null ? null : Number(run.finished),
  }
}

/** A published build as the Artifacts pages and the API show it. */
function publishedBuild(
  build: ReturnType<typeof runBuilds>[number],
): PublishedBuild {
  const only = downloadOnly(build)
  return {
    id: Number(build.id),
    appId: Number(build.app_id),
    app: build.name,
    platform: build.platform,
    version: build.version,
    buildNumber: build.build_number,
    size: Number(build.size),
    variant: build.variant,
    format: build.format,
    ...(only == null ? {} : { downloadOnly: only }),
  }
}

/**
 * One run's Artifacts page: its stages, test results, the builds it
 * published that the viewer may see, and its saved artifacts; undefined for
 * no such run.
 */
export function artifactRunData(
  source: ArtifactsSource,
  id: string,
): ArtifactRunDetail | undefined {
  const run = source.db.prepare(`${runSelect} WHERE j.id=?`).get(id) as
    | RunRow
    | undefined
  if (run == null) return undefined
  const stages = source.db
    .prepare(
      "SELECT name,status,kind,started,finished FROM job_stages WHERE job_id=? AND name NOT LIKE '@%' ORDER BY position",
    )
    .all(run.id) as Array<{
    name: string
    status: string
    kind: string
    started: number | null
    finished: number | null
  }>
  const tests = (
    source.db
      .prepare(
        'SELECT stage,summary FROM run_tests WHERE job_id=? ORDER BY stage,attempt',
      )
      .all(run.id) as Array<{ stage: string; summary: string }>
  ).map((row) => {
    const summary = JSON.parse(row.summary) as {
      passed: number
      failed: number
      skipped: number
    }
    return {
      stage: row.stage,
      passed: Number(summary.passed),
      failed: Number(summary.failed),
      skipped: Number(summary.skipped),
    }
  })
  return {
    run: artifactRun(run),
    stages: stages.map((stage) => ({
      name: stage.name,
      status: stage.status,
      kind: stage.kind,
      started: stage.started == null ? null : Number(stage.started),
      finished: stage.finished == null ? null : Number(stage.finished),
    })),
    tests,
    builds: runBuilds(source, run).map(publishedBuild),
    artifacts: savedArtifacts(source, run.id),
    artifactOrigin: source.artifactBase,
  }
}

const runSelect =
  'SELECT j.id,j.number,j.workflow,j.branch,j.status,j.commit_sha,j.description,j.created,j.started,j.finished,p.slug,p.name FROM jobs j JOIN projects p ON p.id=j.project_id'

/**
 * The latest 50 runs, newest first, of every project or one, on every branch
 * or one: each with its status, its published builds' numbers and its saved
 * artifacts.
 */
export function artifactsListData(
  source: ArtifactsSource,
  filter: { project?: string; branch?: string },
): ArtifactsList {
  const { db } = source
  const runs = db
    .prepare(
      `${runSelect} WHERE p.enabled=1 AND j.workflow NOT LIKE '@%' AND (? IS NULL OR p.slug=?) AND (? IS NULL OR j.branch=?) ORDER BY j.created DESC LIMIT 50`,
    )
    .all(
      filter.project ?? null,
      filter.project ?? null,
      filter.branch ?? null,
      filter.branch ?? null,
    ) as unknown as RunRow[]
  const counts = db.prepare(
    'SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS size FROM run_artifacts WHERE job_id=? AND deleting=0',
  )
  const project =
    filter.project == null
      ? undefined
      : (db
          .prepare('SELECT slug,name FROM projects WHERE slug=?')
          .get(filter.project) as { slug: string; name: string } | undefined)
  return {
    ...(filter.project == null
      ? {}
      : {
          project: {
            slug: filter.project,
            name: project?.name ?? filter.project,
          },
        }),
    ...(filter.branch == null ? {} : { branch: filter.branch }),
    projects: db
      .prepare(
        'SELECT slug,name FROM projects WHERE enabled=1 ORDER BY position,id',
      )
      .all() as Array<{ slug: string; name: string }>,
    branches:
      filter.project == null
        ? []
        : (
            db
              .prepare(
                "SELECT j.branch FROM jobs j JOIN projects p ON p.id=j.project_id WHERE p.slug=? AND j.workflow NOT LIKE '@%' GROUP BY j.branch ORDER BY MAX(j.created) DESC LIMIT 100",
              )
              .all(filter.project) as Array<{ branch: string }>
          ).map((row) => row.branch),
    runs: runs.map((run) => {
      const saved = counts.get(run.id) as { count: number; size: number }
      const builds = runBuilds(source, run)
      return {
        ...artifactRun(run),
        buildNumbers: [...new Set(builds.map((build) => build.build_number))],
        builds: builds.length,
        artifacts: { count: Number(saved.count), size: Number(saved.size) },
      }
    }),
  }
}

/**
 * Whether the run's own workflow (`workflow`, its `jobs.workflow`) has a
 * stage, in `stages` or `post`, whose `publishes` holds the app ID bound to
 * each `?` (bound twice): `graph` is the run's recorded graph as JSON.
 */
const publishesApp = (graph: string, workflow: string): string =>
  `(${['stages', 'post']
    .map(
      (part) =>
        `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${graph}) THEN ${graph} END,'$.workflows') w, json_each(w.value,'$.${part}') s, json_each(s.value,'$.publishes') pub WHERE json_extract(w.value,'$.name')=${workflow} AND pub.value=?)`,
    )
    .join(' OR ')})`

/**
 * The condition on `jobs j` that its run publishes an app ID, for the
 * database at hand: the master keeps each graph once in `graphs`, named by
 * `jobs.graph_key`; the host's copy keeps it on the run, `jobs.graph`.
 */
function publishing(
  db: DatabaseSync,
  project: string,
  app: string,
): { where: string; args: string[] } {
  const keyed =
    db
      .prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name='graph_key'")
      .get() != null
  // On the master each of the project's graphs is read once, not once per run.
  return keyed
    ? {
        where: ` AND j.graph_key IN (SELECT g.key FROM graphs g WHERE g.project_id=(SELECT id FROM projects WHERE slug=?) AND ${publishesApp('g.graph', 'g.workflow')})`,
        args: [project, app, app],
      }
    : {
        where: ` AND ${publishesApp('j.graph', 'j.workflow')}`,
        args: [app, app],
      }
}

export type { BranchItem, ProjectRunRow }

/**
 * A project's branches and runs for its Runs and builds tab. The branches
 * its build's push trigger names come first, in its order, a glob standing
 * for the branches with runs it matches; then every other branch with runs,
 * most recently run first. The runs are the latest 50 of one branch or all,
 * each with its published version and the app build number it reserved,
 * else its published ones. With `app`, only the runs whose workflow
 * publishes that app ID count, and only the branches that have one.
 */
export function projectRunsData(
  source: ArtifactsSource & {
    /** The app build number a run reserved. */
    reserved?: (run: string) => string | undefined
  },
  project: string,
  options: { branch?: string; pinned: string[]; app?: string },
): { branches: BranchItem[]; runs: ProjectRunRow[] } {
  const { db } = source
  const app =
    options.app == null ? undefined : publishing(db, project, options.app)
  const filter = app?.where ?? ''
  const appArgs = app?.args ?? []
  const latest = (
    db
      .prepare(
        `SELECT j.branch,MAX(j.created) AS at FROM jobs j JOIN projects p ON p.id=j.project_id WHERE p.slug=? AND j.workflow NOT LIKE '@%'${filter} GROUP BY j.branch ORDER BY at DESC,j.branch LIMIT 200`,
      )
      .all(project, ...appArgs) as Array<{ branch: string; at: number }>
  ).map((row) => ({ branch: row.branch, at: Number(row.at) }))
  const branches: BranchItem[] = []
  const add = (branch: string, pinned: boolean, at?: number): void => {
    if (branches.some((entry) => entry.branch === branch)) return
    branches.push({ branch, pinned, ...(at == null ? {} : { at }) })
  }
  for (const pattern of options.pinned)
    if (!isGlob(pattern)) {
      const at = latest.find((entry) => entry.branch === pattern)?.at
      // An app ID's page lists only the branches that ran a workflow publishing it.
      if (at != null || options.app == null) add(pattern, true, at)
    } else
      for (const entry of latest)
        if (matches(pattern, entry.branch)) add(entry.branch, true, entry.at)
  for (const entry of latest) add(entry.branch, false, entry.at)
  const runs = (
    db
      .prepare(
        `${runSelect} WHERE p.slug=? AND j.workflow NOT LIKE '@%' AND (? IS NULL OR j.branch=?)${filter} ORDER BY j.created DESC LIMIT 50`,
      )
      .all(
        project,
        options.branch ?? null,
        options.branch ?? null,
        ...appArgs,
      ) as unknown as RunRow[]
  ).map((run) => {
    const builds = runBuilds(source, run)
    const versions = [...new Set(builds.map((build) => build.version))]
    const numbers = [...new Set(builds.map((build) => build.build_number))]
    return {
      id: run.id,
      number: run.number,
      workflow: run.workflow,
      branch: run.branch,
      status: run.status,
      at: run.started ?? run.created,
      version: versions.join(', '),
      buildNumber: source.reserved?.(run.id) ?? numbers.join(', '),
    }
  })
  return { branches, runs }
}

/** The Runs and builds tab's runs table: status, version, build number and when each started. */
export function projectRunsTable(
  rows: ProjectRunRow[],
  now: number,
  every: boolean,
): string {
  if (rows.length === 0) return '<p class="empty-state">No runs yet.</p>'
  return `<table class="list runs"><thead><tr><th>Status</th><th>Version</th><th>Build number</th><th>Started</th></tr></thead><tbody>${rows
    .map(
      (run) =>
        `<tr data-run-id="${escape(run.id)}" data-status="${escape(run.status)}"><td><a href="${runHref(run.id)}">${statusDot(run.status)} <span data-status-text>${escape(run.status)}</span></a><small>Run ${run.number}${run.workflow === 'build' ? '' : ` · ${escape(run.workflow)}`}${every ? ` · <span class="mono">${escape(run.branch)}</span>` : ''}</small></td><td class="mono">${run.version === '' ? '—' : escape(run.version)}</td><td class="mono">${run.buildNumber === '' ? '—' : escape(run.buildNumber)}</td><td>${localTime(run.at, now, 'since')}</td></tr>`,
    )
    .join('')}</tbody></table>`
}
