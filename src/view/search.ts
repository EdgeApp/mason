import type { DatabaseSync } from 'node:sqlite'
import type { SearchResult } from '../browser/shell.js'
import { runHref } from './dashboard.js'
import { atLeast, type Viewer } from './shell.js'

export interface SearchScope {
  db: DatabaseSync
  viewer: Viewer
  /** Whether the viewer may see an app ID. */
  appVisible: (appId: number) => boolean
}

const LIMIT = 20

/** `%`, `_` and `\` matched literally in a LIKE pattern. */
const like = (text: string): string => text.replace(/[\\%_]/g, (c) => '\\' + c)

/**
 * ⌘K search: projects, app IDs, runs by number, commits by SHA prefix and
 * branches, within what the viewer may see. Testers find only the app IDs
 * they may install and the projects that hold them; runs, commits and
 * branches are for developers and up.
 */
export function search(scope: SearchScope, text: string): SearchResult[] {
  const query = text.trim().slice(0, 100)
  if (query === '') return []
  const { db, viewer } = scope
  const developer = atLeast(viewer, 'developer')
  const pattern = `%${like(query.toLowerCase())}%`
  const out: SearchResult[] = []
  const apps = (
    db
      .prepare(
        "SELECT a.id,a.slug,a.name,p.slug AS project FROM apps a JOIN project_apps pa ON pa.app_id=a.id JOIN projects p ON p.id=pa.project_id WHERE a.enabled=1 AND p.enabled=1 AND (lower(a.slug) LIKE ? ESCAPE '\\' OR lower(a.name) LIKE ? ESCAPE '\\') ORDER BY a.slug LIMIT 50",
      )
      .all(pattern, pattern) as Array<{
      id: number
      slug: string
      name: string
      project: string
    }>
  ).filter((app) => scope.appVisible(app.id))
  const visibleProjects = new Set<string>()
  if (!developer)
    for (const row of db
      .prepare(
        'SELECT p.slug,pa.app_id FROM projects p JOIN project_apps pa ON pa.project_id=p.id WHERE p.enabled=1',
      )
      .all() as Array<{ slug: string; app_id: number }>)
      if (scope.appVisible(row.app_id)) visibleProjects.add(row.slug)
  for (const project of db
    .prepare(
      "SELECT slug,name FROM projects WHERE enabled=1 AND (lower(slug) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\') ORDER BY position,id LIMIT 20",
    )
    .all(pattern, pattern) as Array<{ slug: string; name: string }>)
    if (developer || visibleProjects.has(project.slug))
      out.push({
        kind: 'project',
        label: project.name,
        detail: project.slug,
        href: `/projects/${encodeURIComponent(project.slug)}`,
      })
  for (const app of apps)
    out.push({
      kind: 'app',
      label: app.slug,
      detail: `${app.name} · ${app.project}`,
      href:
        viewer.node === 'host'
          ? `/apps/${app.id}`
          : `/projects/${encodeURIComponent(app.project)}`,
    })
  if (!developer) return out.slice(0, LIMIT)
  const number = /^#?(\d{1,9})$/.exec(query)?.[1]
  if (number != null)
    for (const run of db
      .prepare(
        "SELECT j.id,j.number,j.workflow,j.branch,j.status,p.slug FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.number=? AND j.workflow NOT LIKE '@%' ORDER BY j.created DESC LIMIT 10",
      )
      .all(Number(number)) as Array<{
      id: string
      number: number
      workflow: string
      branch: string
      status: string
      slug: string
    }>)
      out.push({
        kind: 'run',
        label: `${run.slug} ${run.workflow} #${run.number}`,
        detail: `${run.branch} · ${run.status}`,
        href: runHref(run.id),
      })
  if (/^[0-9a-f]{4,40}$/i.test(query))
    for (const commit of db
      .prepare(
        "SELECT id,commit_sha,branch,description,slug FROM (SELECT j.id,j.commit_sha,j.branch,j.description,j.created,p.slug,ROW_NUMBER() OVER (PARTITION BY j.commit_sha ORDER BY j.created DESC) AS place FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.commit_sha LIKE ? ESCAPE '\\') WHERE place=1 ORDER BY created DESC LIMIT 10",
      )
      .all(`${like(query.toLowerCase())}%`) as Array<{
      id: string
      commit_sha: string
      branch: string
      description: string | null
      slug: string
    }>)
      out.push({
        kind: 'commit',
        label: commit.commit_sha.slice(0, 12),
        detail: `${commit.slug} · ${commit.branch}${commit.description == null ? '' : ` · ${commit.description}`}`,
        href: runHref(commit.id),
      })
  for (const branch of db
    .prepare(
      "SELECT j.branch,p.slug,MAX(j.created) AS at FROM jobs j JOIN projects p ON p.id=j.project_id WHERE lower(j.branch) LIKE ? ESCAPE '\\' GROUP BY p.slug,j.branch ORDER BY at DESC LIMIT 10",
    )
    .all(pattern) as Array<{ branch: string; slug: string }>)
    out.push({
      kind: 'branch',
      label: branch.branch,
      detail: branch.slug,
      href: `/artifacts?project=${encodeURIComponent(branch.slug)}&branch=${encodeURIComponent(branch.branch)}`,
    })
  return out.slice(0, LIMIT)
}
