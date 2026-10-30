import type { DatabaseSync } from 'node:sqlite'
import { bytes, platformChip, runHref, statusDot } from './dashboard.js'
import { ago, duration, escape, time } from './html.js'
import { icon } from './icons.js'
import type { Viewer } from './shell.js'

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

function artifactLinks(source: ArtifactsSource, run: string): string {
  const rows = source.db
    .prepare(
      'SELECT name,stage,kind,size,entry,created_at FROM run_artifacts WHERE job_id=? AND deleting=0 ORDER BY stage,name',
    )
    .all(run) as Array<{
    name: string
    stage: string
    kind: string
    size: number
    entry: string | null
    created_at: number
  }>
  if (rows.length === 0)
    return '<p class="empty-state">This run saved no artifacts.</p>'
  const base = `${source.artifactBase}/runs/${encodeURIComponent(run)}/artifacts/`
  return `<table class="list"><thead><tr><th>Artifact</th><th>Stage</th><th>Kind</th><th>Size</th><th></th></tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr><td class="mono">${escape(row.name)}</td><td class="mono">${escape(row.stage)}</td><td>${escape(row.kind)}</td><td class="mono">${escape(bytes(row.size))}</td><td class="actions">${
          row.kind === 'report'
            ? `<a href="${escape(base + encodeURIComponent(row.name))}/view">${icon('open_in_new')} View</a>`
            : ''
        }<a href="${escape(base + encodeURIComponent(row.name))}">${icon('download')} Download</a></td></tr>`,
    )
    .join('')}</tbody></table>`
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
}> {
  return (
    source.db
      .prepare(
        "SELECT b.id,b.app_id,a.name,b.platform,b.version,b.build_number,b.size,b.variant FROM builds b JOIN apps a ON a.id=b.app_id WHERE (b.run=? OR (b.run IS NULL AND b.commit_hash=? AND b.branch=?)) AND b.state='ready' AND b.deleted_at IS NULL ORDER BY b.app_id,b.platform,b.variant<>'',b.variant",
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
    }>
  ).filter((build) => source.appVisible(build.app_id))
}

function runDetail(source: ArtifactsSource, run: RunRow): string {
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
  const tests = source.db
    .prepare(
      'SELECT stage,summary FROM run_tests WHERE job_id=? ORDER BY stage,attempt',
    )
    .all(run.id) as Array<{ stage: string; summary: string }>
  const builds = runBuilds(source, run)
  const took =
    run.started == null
      ? ''
      : ` · took ${duration((run.finished ?? source.now) - run.started)}`
  return `<div class="page-head"><div><div class="breadcrumbs"><a href="/artifacts">Artifacts</a><span>/</span><a href="/artifacts?project=${encodeURIComponent(run.slug)}">${escape(run.slug)}</a></div><h1>${escape(run.workflow)} #${run.number}</h1><p>${statusDot(run.status)} ${escape(run.status)} · <span class="mono">${escape(run.branch)}</span>${run.commit_sha == null ? '' : ` · <span class="mono">${escape(run.commit_sha.slice(0, 12))}</span>`} · ${time(run.created)}${escape(took)}${run.description == null ? '' : ` · ${escape(run.description)}`}</p></div></div><section class="panel"><h2>${icon('account_tree')}Stages</h2><ul>${stages
    .map(
      (stage) =>
        `<li><span class="mono">${escape(stage.name)}</span><span class="state-${escape(stage.status)}">${statusDot(stage.status)} ${escape(stage.status)}${stage.started == null ? '' : ` · ${escape(duration((stage.finished ?? source.now) - stage.started))}`}</span></li>`,
    )
    .join('')}</ul></section>${
    tests.length === 0
      ? ''
      : `<section class="panel"><h2>${icon('check_circle')}Tests</h2><ul>${tests
          .map((row) => {
            const summary = JSON.parse(row.summary) as {
              passed: number
              failed: number
              skipped: number
            }
            return `<li><span class="mono">${escape(row.stage)}</span><span>${summary.passed} passed · <span class="${summary.failed > 0 ? 'state-failed' : ''}">${summary.failed} failed</span> · ${summary.skipped} skipped</span></li>`
          })
          .join('')}</ul></section>`
  }<section class="panel"><h2>${icon('deployed_code')}Published builds</h2><ul>${
    builds
      .map(
        (build) =>
          `<li><div><span class="mono">${escape(build.name)} ${escape(build.version)} (${escape(build.build_number)})${build.variant === '' ? '' : ` ${escape(build.variant)}`}</span><small>${platformChip(build.platform)} · ${escape(bytes(build.size))}</small></div>${
            source.viewer.node === 'host'
              ? `<a href="/apps/${build.app_id}">Install</a>`
              : ''
          }</li>`,
      )
      .join('') || '<li>None.</li>'
  }</ul></section><h2>Saved artifacts</h2>${artifactLinks(source, run.id)}`
}

const runSelect =
  'SELECT j.id,j.number,j.workflow,j.branch,j.status,j.commit_sha,j.description,j.created,j.started,j.finished,p.slug,p.name FROM jobs j JOIN projects p ON p.id=j.project_id'

/**
 * The latest 50 runs, newest first, of every project or one, on every branch
 * or one: each with its status, its published builds' numbers and its saved
 * artifacts.
 */
export function runsTable(
  source: ArtifactsSource,
  filter: { project?: string; branch?: string },
): string {
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
  if (runs.length === 0) return '<p class="empty-state">No runs yet.</p>'
  const counts = db.prepare(
    'SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS size FROM run_artifacts WHERE job_id=? AND deleting=0',
  )
  return `<table class="list"><thead><tr><th>Run</th><th>Branch</th><th>Status</th><th>Builds</th><th>Artifacts</th><th>Started</th></tr></thead><tbody>${runs
    .map((run) => {
      const saved = counts.get(run.id) as { count: number; size: number }
      const builds = runBuilds(source, run)
      const numbers = [...new Set(builds.map((build) => build.build_number))]
      return `<tr><td><a href="${runHref(run.id)}">${escape(run.slug)} ${escape(run.workflow)} #${run.number}</a></td><td class="mono">${escape(run.branch)}</td><td>${statusDot(run.status)} ${escape(run.status)}</td><td class="mono">${builds.length === 0 ? '—' : `${numbers.map(escape).join(', ')} · ${builds.length} ${builds.length === 1 ? 'file' : 'files'}`}</td><td class="mono">${saved.count === 0 ? '—' : `${saved.count} · ${escape(bytes(saved.size))}`}</td><td>${escape(ago(run.created, source.now))}</td></tr>`
    })
    .join('')}</tbody></table>`
}

/** Published builds and saved artifacts, by project, branch and run. */
export function artifactsView(
  source: ArtifactsSource,
  filter: ArtifactsFilter,
): string {
  if (filter.run != null) {
    const run = source.db
      .prepare(`${runSelect} WHERE j.id=?`)
      .get(filter.run) as RunRow | undefined
    if (run == null)
      return '<h1>Run unavailable</h1><p class="empty-state">There is no such run.</p>'
    return runDetail(source, run)
  }
  const heading = [filter.project, filter.branch]
    .filter((part) => part != null)
    .join(' · ')
  return `<div class="page-head"><div><div class="breadcrumbs"><a href="/artifacts">Artifacts</a>${heading === '' ? '' : `<span>/</span><span>${escape(heading)}</span>`}</div><h1>Artifacts</h1><p>Each run's saved artifacts, test results and published builds.</p></div></div>${runsTable(
    source,
    {
      ...(filter.project == null ? {} : { project: filter.project }),
      ...(filter.branch == null ? {} : { branch: filter.branch }),
    },
  )}`
}
