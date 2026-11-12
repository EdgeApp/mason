import type { DatabaseSync } from 'node:sqlite'
import {
  Router,
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'
import { apiErrors, json, NotFound } from '../master/api.js'
import { allow, allowRole, can, covers } from '../master/permissions.js'
import type { Actor } from '../master/roles.js'
import { SCRIPT_PROJECT } from '../master/projectDetails.js'
import {
  ACCOUNT_PATH,
  ARTIFACTS_PATH,
  DASHBOARD_PATH,
  NOTIFICATIONS_PATH,
  QUEUE_PATH,
  runIncludes,
  SEARCH_PATH,
  STATUS_PATH,
  type AccountInfo,
  type ArtifactRunDetail,
  type ArtifactsList,
  type DashboardData,
  type MasonfileCommit,
  type MasonfileText,
  type NotificationItem,
  type ProjectApp,
  type ProjectDetails,
  type ProjectOverview,
  type ProjectRuns,
  type QueueEntry,
  type RunInclude,
  type RunPage,
  type SearchResult,
  type StatusInfo,
} from '../shared/api/index.js'
import { appBuildNumbers } from '../view/admin.js'
import {
  artifactRunData,
  artifactsListData,
  projectRunsData,
} from '../view/artifacts.js'
import {
  dashboardData,
  queueEntries,
  type DashboardSource,
} from '../view/dashboard.js'
import { layoutGraph, type StageState } from '../view/graph.js'
import {
  approvalNotifications,
  notificationsFor,
} from '../view/notifications.js'
import { runData, type RunData, type RunGraph } from '../view/run.js'
import { search } from '../view/search.js'
import type { Viewer, ViewerRole } from '../view/shell.js'

/** A project as its pages read it, on either node. */
export interface ProjectRecord {
  id: number
  slug: string
  name: string
  details: ProjectDetails
  /** Its app IDs' names, in the project's order. */
  appNames: Array<{ bundleId: string; name: string }>
}

/**
 * What the read routes need of a node: the master over its database, the
 * host over its cache, which share the tables the page-data functions read.
 * The HTML pages read through the same functions.
 */
export interface NodeReader {
  node: 'master' | 'host'
  db: DatabaseSync
  now(): number
  /** Sets the caller (`res.locals.actor`), or answers 401 or 403. */
  authenticate: RequestHandler
  /** The caller `authenticate` set. */
  caller(res: Response): Actor
  /** Whether the caller may see an app ID: developers and up every one, testers their groups'. */
  appVisible(actor: Actor): (appId: number) => boolean
  /** Where a run's artifacts are served: `''` for this node, else the host's origin. */
  artifactBase(): string
  status(actor: Actor): StatusInfo
  /** Who may decide an approval, from its run's graph. */
  approvalRoles(job: string, stage: string): ViewerRole[] | undefined
  /** The master's notices for managers; none on a host. */
  notices(): string[]
  /** What the dashboard reads beyond the shared tables. */
  dashboard(): Pick<DashboardSource, 'nodes' | 'repositories' | 'pinned'>
  /** An enabled project, or undefined. */
  project(slug: string): ProjectRecord | undefined
  /** The app build number a run reserved. */
  reserved(run: string): string | undefined
  graphOf(run: string): RunGraph | undefined
  runOptions(): NonNullable<Parameters<typeof runData>[3]>
  /** The commits the Masonfile tab offers, newest run first. */
  masonfileCommits(projectId: number): MasonfileCommit[]
  /** A commit's Masonfile; a NotFound that says why there is none. */
  masonfile(project: ProjectRecord, commit: string): Promise<MasonfileText>
  account(actor: Actor): AccountInfo
  /** Whether the caller may set where a build-number sequence stands. */
  canSeed(actor: Actor): boolean
}

/** The view functions' viewer for an API caller. */
export function viewerFor(reader: NodeReader, actor: Actor): Viewer {
  return { name: '', role: actor.role, node: reader.node, signOut: '' }
}

const text = (req: Request, name: string): string | undefined => {
  const value = req.query[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A run's project and branch, for a key's scopes; 404 for no such run. */
export function runTarget(
  db: DatabaseSync,
  id: string,
): { project: string; branch: string } {
  const row = db
    .prepare(
      'SELECT p.slug,j.branch FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=?',
    )
    .get(id) as { slug: string; branch: string } | undefined
  if (row == null) throw new NotFound('Run not found')
  return { project: row.slug, branch: row.branch }
}

/** What needs the caller: approvals they may decide, and the master's notices for managers. */
export function notificationsOf(
  reader: NodeReader,
  actor: Actor,
): NotificationItem[] {
  const viewer = viewerFor(reader, actor)
  const target = (href: string | undefined): boolean => {
    const id = /^\/runs\/([^/?]+)$/.exec(href ?? '')?.[1]
    if (id == null) return true
    try {
      return covers(actor, runTarget(reader.db, decodeURIComponent(id)))
    } catch {
      return false
    }
  }
  const approvals = approvalNotifications(reader.db, viewer, (job, stage) =>
    reader.approvalRoles(job, stage),
  ).filter((entry) => can(actor, 'runs.approve') && target(entry.href))
  return notificationsFor(viewer, approvals, reader.notices()).map((entry) => ({
    kind: entry.icon === 'pan_tool' ? 'approval' : 'notice',
    text: entry.text,
    ...(entry.href == null ? {} : { href: entry.href }),
  }))
}

/** Everything the run page draws, with the parts asked for. */
export function runPageData(
  reader: NodeReader,
  id: string,
  include: ReadonlySet<RunInclude>,
): RunPage | undefined {
  const run: RunData | undefined = runData(
    reader.db,
    id,
    (job) => reader.graphOf(job),
    reader.runOptions(),
  )
  if (run == null) return undefined
  const page: RunPage = {
    id: run.id,
    number: run.number,
    workflow: run.workflow,
    branch: run.branch,
    commit: run.commit,
    status: run.status,
    created: run.created,
    started: run.started,
    finished: run.finished,
    description: run.description,
    reason: run.reason,
    project: { slug: run.project.slug, name: run.project.name },
    stages: run.stages.map((stage) => ({
      name: stage.name,
      kind: stage.kind,
      status: stage.status,
      attempt: stage.attempt,
      started: stage.started ?? null,
      finished: stage.finished ?? null,
      ...(stage.node == null ? {} : { node: stage.node }),
    })),
    artifacts: run.artifacts.map((artifact) => ({
      ...artifact,
      url: `${reader.artifactBase()}/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.name)}`,
    })),
  }
  if (include.has('graph') && run.graph != null) {
    const states = new Map<string, StageState>(
      run.stages.map((stage) => [stage.name, stage]),
    )
    const known = new Set(run.stages.map((stage) => stage.name))
    page.graph = run.graph
    page.layout = layoutGraph(
      run.graph.stages,
      run.graph.post.filter((stage) => known.has(stage.name)),
      states,
      reader.now(),
    )
  }
  if (include.has('steps')) page.steps = run.steps
  if (include.has('history')) page.history = run.history
  if (include.has('details'))
    page.details = {
      trigger: run.trigger,
      requestedBy: run.requestedBy,
      buildNumber: run.buildNumber,
      params: run.params,
      ...(run.project.repository == null
        ? {}
        : { repository: run.project.repository }),
      nodes: [
        ...new Set(
          run.stages.flatMap((stage) =>
            stage.node == null ? [] : [stage.node],
          ),
        ),
      ],
    }
  return page
}

/**
 * The commit a Masonfile tab shows and its text, or why there is none:
 * the newest commit by default; for a script project, a commit with no run,
 * or one the node has no copy of, the reason.
 */
export async function masonfileData(
  reader: NodeReader,
  project: ProjectRecord,
  commit: string | undefined,
): Promise<{
  commits: MasonfileCommit[]
  commit?: string
  file?: string
  text?: string
  error?: string
}> {
  const commits = reader.masonfileCommits(project.id)
  const chosen = commit ?? commits[0]?.sha
  if (project.details.format === 'script')
    return {
      commits,
      ...(chosen == null ? {} : { commit: chosen }),
      error: SCRIPT_PROJECT,
    }
  if (chosen == null) return { commits, error: 'No run has a commit yet.' }
  try {
    const found = await reader.masonfile(project, chosen)
    return { commits, commit: chosen, file: found.file, text: found.text }
  } catch (error) {
    if (!(error instanceof NotFound)) throw error
    return { commits, commit: chosen, error: error.message }
  }
}

/** Maps a refusal that carries its own status (the host's, the catalog's) or the API's errors. */
export const readErrors: ErrorRequestHandler = (error, req, res, next) => {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number' && status >= 400 && status < 600) {
    res.status(status).json({ error: (error as Error).message })
    return
  }
  apiErrors(error, req, res, next)
}

/** The read routes' paths, which a node mounts ahead of its other `/api/v2` routes. */
export const READ_PATHS = [
  STATUS_PATH,
  NOTIFICATIONS_PATH,
  SEARCH_PATH,
  DASHBOARD_PATH,
  QUEUE_PATH,
  ARTIFACTS_PATH,
  `${ARTIFACTS_PATH}/runs/:id`,
  '/api/v2/runs/:id',
  '/api/v2/projects/:slug/overview',
  '/api/v2/projects/:slug/runs',
  '/api/v2/projects/:slug/apps/:appId',
  '/api/v2/projects/:slug/masonfile/commits',
  '/api/v2/projects/:slug/masonfile',
  ACCOUNT_PATH,
]

/**
 * The pages' reads, the same routes on the master (from its database) and
 * the host (from its cache, so they keep answering while the master is
 * away): the shell's status, notifications and search; the dashboard and
 * queue; Artifacts; a run page with `include`; a project's overview, runs,
 * app ID and Masonfile; and Your account.
 */
export function readApi(reader: NodeReader): Router {
  const router = Router()
  const get = (
    path: string,
    handler: (req: Request, res: Response, actor: Actor) => unknown,
  ): void => {
    router.get(
      path,
      reader.authenticate,
      json(async (req, res) => await handler(req, res, reader.caller(res))),
    )
  }
  const source = (
    actor: Actor,
  ): DashboardSource & { artifactBase: string } => ({
    db: reader.db,
    viewer: viewerFor(reader, actor),
    now: reader.now(),
    appVisible: reader.appVisible(actor),
    artifactBase: reader.artifactBase(),
  })
  /** A project the caller may read; 404 for one that does not exist or is disabled. */
  const project = (req: Request, actor: Actor): ProjectRecord => {
    const slug = String(req.params.slug)
    allowRole(actor, 'projects.read')
    allow(actor, 'projects.read', { project: slug })
    const found = reader.project(slug)
    if (found == null) throw new NotFound('No such project')
    return found
  }
  /** One of the project's enabled app IDs the caller may see; 404 otherwise. */
  const appOf = (
    found: ProjectRecord,
    actor: Actor,
    bundleId: string,
  ): ProjectRuns['app'] & object => {
    const row = reader.db
      .prepare(
        'SELECT a.id,a.slug,a.name FROM apps a JOIN project_apps pa ON pa.app_id=a.id WHERE pa.project_id=? AND a.slug=? AND a.enabled=1',
      )
      .get(found.id, bundleId) as
      | { id: number; slug: string; name: string }
      | undefined
    if (row == null || !reader.appVisible(actor)(Number(row.id)))
      throw new NotFound('No such app ID in this project')
    return {
      id: Number(row.id),
      bundleId: row.slug,
      name: row.name,
      platforms:
        found.details.apps.find((entry) => entry.bundleId === row.slug)
          ?.platforms ?? [],
    }
  }

  get(STATUS_PATH, (_req, _res, actor): StatusInfo => {
    allowRole(actor, 'builds.read')
    return reader.status(actor)
  })
  get(NOTIFICATIONS_PATH, (_req, _res, actor): NotificationItem[] => {
    allowRole(actor, 'builds.read')
    return notificationsOf(reader, actor)
  })
  get(SEARCH_PATH, (req, _res, actor): SearchResult[] => {
    allow(actor, 'builds.read')
    return search(
      {
        db: reader.db,
        viewer: viewerFor(reader, actor),
        appVisible: reader.appVisible(actor),
      },
      text(req, 'q') ?? '',
    )
  })
  get(DASHBOARD_PATH, (req, _res, actor): DashboardData => {
    allow(actor, 'projects.read')
    const platform = text(req, 'platform')
    const filter = text(req, 'project')
    return dashboardData(
      { ...source(actor), ...reader.dashboard() },
      {
        ...(platform == null ? {} : { platform }),
        ...(filter == null ? {} : { project: filter }),
      },
    )
  })
  get(QUEUE_PATH, (_req, _res, actor): QueueEntry[] => {
    allowRole(actor, 'runs.read')
    return queueEntries(reader.db, reader.now()).filter((entry) =>
      covers(actor, { project: entry.project, branch: entry.branch }),
    )
  })
  get(ARTIFACTS_PATH, (req, _res, actor): ArtifactsList => {
    const filter = text(req, 'project')
    const branch = text(req, 'branch')
    allowRole(actor, 'runs.read')
    allow(
      actor,
      'runs.read',
      filter == null
        ? undefined
        : { project: filter, ...(branch == null ? {} : { branch }) },
    )
    const list = artifactsListData(source(actor), {
      ...(filter == null ? {} : { project: filter }),
      ...(branch == null ? {} : { branch }),
    })
    // A scoped key's filters offer only what it may read.
    return {
      ...list,
      projects: list.projects.filter((project) =>
        covers(actor, { project: project.slug }),
      ),
      branches: list.branches.filter((name) =>
        covers(actor, { project: filter!, branch: name }),
      ),
    }
  })
  get(`${ARTIFACTS_PATH}/runs/:id`, (req, _res, actor): ArtifactRunDetail => {
    const id = String(req.params.id)
    allowRole(actor, 'runs.read')
    allow(actor, 'runs.read', runTarget(reader.db, id))
    return artifactRunData(source(actor), id)!
  })
  // Without `include` the run is the master's own answer (runsApi).
  router.get(
    '/api/v2/runs/:id',
    (req, _res, next) => {
      next(req.query.include == null ? 'route' : undefined)
    },
    reader.authenticate,
    json((req, res): RunPage => {
      const actor = reader.caller(res)
      const id = String(req.params.id)
      const asked = String(req.query.include)
        .split(',')
        .filter((part) => part !== '')
      const unknown = asked.find(
        (part) => !(runIncludes as readonly string[]).includes(part),
      )
      if (unknown != null)
        throw new Error(
          `include takes ${runIncludes.join(', ')}; not ${unknown.slice(0, 40)}`,
        )
      allowRole(actor, 'runs.read')
      allow(actor, 'runs.read', runTarget(reader.db, id))
      return runPageData(reader, id, new Set(asked as RunInclude[]))!
    }),
  )
  get(
    '/api/v2/projects/:slug/overview',
    (req, _res, actor): ProjectOverview => {
      const found = project(req, actor)
      return {
        ...found.details,
        slug: found.slug,
        name: found.name,
        appNames: found.appNames,
        canSeed: reader.canSeed(actor),
        secrets: reader.node === 'master',
      }
    },
  )
  get('/api/v2/projects/:slug/runs', (req, _res, actor): ProjectRuns => {
    const found = project(req, actor)
    const branch = text(req, 'branch')
    if (branch != null)
      allow(actor, 'projects.read', { project: found.slug, branch })
    const bundleId = text(req, 'app')
    const app = bundleId == null ? undefined : appOf(found, actor, bundleId)
    const { branches, runs } = projectRunsData(
      { ...source(actor), reserved: (run) => reader.reserved(run) },
      found.slug,
      {
        ...(branch == null ? {} : { branch }),
        pinned: found.details.pinned,
        ...(app == null ? {} : { app: app.bundleId }),
      },
    )
    return {
      slug: found.slug,
      name: found.name,
      ...(branch == null ? {} : { branch }),
      ...(app == null ? {} : { app }),
      branches,
      runs,
    }
  })
  get('/api/v2/projects/:slug/apps/:appId', (req, _res, actor): ProjectApp => {
    const found = project(req, actor)
    const app = appOf(found, actor, String(req.params.appId))
    return {
      slug: found.slug,
      name: found.name,
      app,
      ...appBuildNumbers(
        found.details.buildNumbers,
        found.details.apps.map((entry) => entry.bundleId),
        app.bundleId,
      ),
      canSeed: reader.canSeed(actor),
    }
  })
  get(
    '/api/v2/projects/:slug/masonfile/commits',
    (req, _res, actor): MasonfileCommit[] =>
      reader.masonfileCommits(project(req, actor).id),
  )
  get(
    '/api/v2/projects/:slug/masonfile',
    async (req, _res, actor): Promise<MasonfileText> => {
      const found = project(req, actor)
      const data = await masonfileData(reader, found, text(req, 'commit'))
      if (data.text == null) throw new NotFound(data.error!)
      return { commit: data.commit!, file: data.file!, text: data.text }
    },
  )
  get(ACCOUNT_PATH, (_req, _res, actor): AccountInfo => {
    if (actor.accountId == null)
      throw Object.assign(new Error('Sign in: an API key has no account'), {
        status: 401,
      })
    return reader.account(actor)
  })
  router.use(READ_PATHS, readErrors)
  return router
}
