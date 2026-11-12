import type { RequestHandler, Response } from 'express'
import { NotFound, Unauthorized } from '../master/api.js'
import { storedDetails } from '../master/projectDetails.js'
import type { Actor } from '../master/roles.js'
import type { NodeReader, ProjectRecord } from '../node/readApi.js'
import type {
  AccountInfo,
  Banner,
  MasonfileCommit,
  MasonfileText,
  StatusInfo,
} from '../shared/api/index.js'
import { isRole } from '../shared/permissions.js'
import { approvalRolesFromGraph } from '../view/notifications.js'
import { graphFromJson, type RunGraph } from '../view/run.js'
import type { ViewerRole } from '../view/shell.js'
import { refusal } from './builds.js'
import type { HostRuntime } from './runtime.js'

/** What the shell says while the master is unreachable. */
export const OFFLINE_TEXT =
  'The Mason master is unreachable. You are seeing the last synced builds.'

/** The host's link to its master, and the banners its pages show. */
export function hostStatus(
  host: HostRuntime,
  testEndpoints: boolean,
): StatusInfo {
  const online = host.online()
  const contact = host.cache.syncedAt()
  const banners: Banner[] = [
    ...(testEndpoints
      ? [
          {
            kind: 'testEndpoints' as const,
            text: 'Test endpoints are enabled on this Mason node.',
          },
        ]
      : []),
    ...(online ? [] : [{ kind: 'offline' as const, text: OFFLINE_TEXT }]),
  ]
  return {
    node: 'host',
    link: {
      online,
      ...(contact == null ? {} : { lastContact: contact }),
      maintenance: host.maintenance(),
    },
    banners,
  }
}

/** A person's own record from the host's cache: changes go to the master, so only while it is reachable. */
export function hostAccount(host: HostRuntime, accountId: number): AccountInfo {
  const db = host.cache.db
  const row = db
    .prepare(
      'SELECT id,name,username,role,has_password FROM accounts WHERE id=?',
    )
    .get(accountId) as
    | {
        id: number
        name: string
        username: string | null
        role: string
        has_password: number
      }
    | undefined
  if (row == null || !isRole(row.role)) throw new NotFound('No such account')
  const link = host.options.link()
  return {
    id: Number(row.id),
    name: row.name,
    role: row.role,
    ...(row.username == null ? {} : { username: row.username }),
    password: row.has_password === 1,
    emails: (
      db
        .prepare(
          'SELECT email,confirmed FROM account_emails WHERE account_id=? ORDER BY position',
        )
        .all(row.id) as Array<{ email: string; confirmed: number }>
    ).map((entry) => ({
      email: entry.email,
      confirmed: entry.confirmed === 1,
    })),
    editable: link != null && !link.closed,
    // The master takes a password through a host from testers only.
    passwordHere: row.role === 'tester',
  }
}

/** The commits the host has a Masonfile copy for, newest run first. */
export function hostMasonfileCommits(
  host: HostRuntime,
  projectId: number,
): MasonfileCommit[] {
  return host.cache.db
    .prepare(
      "SELECT j.commit_sha AS sha, j.branch FROM jobs j JOIN masonfiles m ON m.key=j.project_id || ':' || j.commit_sha WHERE j.project_id=? GROUP BY j.commit_sha ORDER BY MAX(j.created) DESC LIMIT 50",
    )
    .all(projectId) as unknown as MasonfileCommit[]
}

/**
 * The caller of a host read: an API key the host verifies itself, or a
 * signed-in host session; 503 while the host waits for its master or is in
 * maintenance.
 */
function hostAuthenticate(host: HostRuntime): RequestHandler {
  return (req, res, next) => {
    try {
      host.builds.ready()
      const viewer = host.builds.viewer(req, host.accounts)
      const session = viewer.label.startsWith('account:')
      const actor: Actor = {
        role: viewer.role,
        label: viewer.label,
        ...(viewer.scopes == null ? {} : { scopes: viewer.scopes }),
        ...(viewer.account == null
          ? {}
          : session
            ? { accountId: viewer.account }
            : { creator: viewer.account }),
      }
      res.locals.actor = actor
      next()
    } catch (error) {
      const { status, error: message } = refusal(error)
      res.status(status).json({ error: message })
    }
  }
}

/** The host's reads for the shared read routes, over its cache. */
export function hostReader(
  host: HostRuntime,
  context: { testEndpoints: boolean },
): NodeReader {
  const db = host.cache.db
  const projects = (): Array<{
    id: number
    slug: string
    name: string
    details: string | null
  }> =>
    db
      .prepare('SELECT id,slug,name,details FROM projects WHERE enabled=1')
      .all() as Array<{
      id: number
      slug: string
      name: string
      details: string | null
    }>
  const project = (slug: string): ProjectRecord | undefined => {
    const row = projects().find((entry) => entry.slug === slug)
    const details = storedDetails(row?.details)
    if (row == null || details == null) return undefined
    const names = new Map(
      (
        db
          .prepare(
            'SELECT a.slug,a.name FROM apps a JOIN project_apps pa ON pa.app_id=a.id WHERE pa.project_id=?',
          )
          .all(row.id) as Array<{ slug: string; name: string }>
      ).map((app) => [app.slug, app.name]),
    )
    return {
      id: Number(row.id),
      slug: row.slug,
      name: row.name,
      details,
      appNames: details.apps.map((app) => ({
        bundleId: app.bundleId,
        name: names.get(app.bundleId) ?? app.bundleId,
      })),
    }
  }
  const graph = (
    job: string,
  ): { workflow: string; graph: string | null } | undefined =>
    db.prepare('SELECT workflow,graph FROM jobs WHERE id=?').get(job) as
      | { workflow: string; graph: string | null }
      | undefined
  return {
    node: 'host',
    db,
    now: () => host.now(),
    authenticate: hostAuthenticate(host),
    caller: (res: Response): Actor => {
      const actor = res.locals.actor as Actor | undefined
      if (actor == null) throw new Unauthorized()
      return actor
    },
    appVisible: (actor) => {
      const apps = host.cache.appsFor(
        actor.role,
        actor.accountId ?? actor.creator,
      )
      return (appId) => apps === 'all' || apps.has(appId)
    },
    artifactBase: () => '',
    status: () => hostStatus(host, context.testEndpoints),
    approvalRoles: (job, stage): ViewerRole[] | undefined => {
      const row = graph(job)
      return row == null
        ? undefined
        : approvalRolesFromGraph(row.graph, row.workflow, stage)
    },
    notices: () => [],
    // Each project's repository, webhook and push branches, from the copy of its details the master sent.
    dashboard: (): ReturnType<NodeReader['dashboard']> => {
      const details = projects().flatMap((row) => {
        const kept = storedDetails(row.details)
        return kept == null ? [] : [[Number(row.id), kept] as const]
      })
      return {
        repositories: new Map(
          details.map(([id, kept]) => [
            id,
            { repository: kept.repository, webhook: kept.webhook },
          ]),
        ),
        pinned: new Map(details.map(([id, kept]) => [id, kept.pinned])),
      }
    },
    project,
    // The app build number each run reserved, which the master replicates.
    reserved: (run) =>
      (
        db.prepare('SELECT build_number FROM jobs WHERE id=?').get(run) as
          | { build_number: string | null }
          | undefined
      )?.build_number ?? undefined,
    graphOf: (job): RunGraph | undefined => {
      const row = graph(job)
      return row == null ? undefined : graphFromJson(row.graph, row.workflow)
    },
    runOptions: () => ({}),
    masonfileCommits: (projectId) => hostMasonfileCommits(host, projectId),
    // The host answers from its copies only: it cannot read a repository.
    masonfile: async (found, commit): Promise<MasonfileText> => {
      const kept = db
        .prepare('SELECT file,text FROM masonfiles WHERE key=?')
        .get(`${found.id}:${commit}`) as
        | { file: string; text: string | null }
        | undefined
      if (kept?.text == null)
        throw new NotFound(
          kept != null
            ? 'The host is still copying that commit’s Masonfile from the master.'
            : 'The host has no copy of that commit’s Masonfile.',
        )
      return { commit, file: kept.file, text: kept.text }
    },
    account: (actor) => hostAccount(host, actor.accountId!),
    // The host keeps a read-only copy: sequences are set on the master.
    canSeed: () => false,
  }
}
