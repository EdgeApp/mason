import type { NodeRecord } from './nodes.js'
import { reservedBuildNumber } from './buildNumbers.js'
import { NotFound, authenticate, actorOf } from './api.js'
import { can } from './permissions.js'
import type { Actor } from './roles.js'
import type { Master } from './runtime.js'
import { projectDetails, pushBranches } from './projectDetails.js'
import { ProjectNotFound } from './projects.js'
import { requesterName } from './requesters.js'
import { masonfileTooLarge } from './scheduler.js'
import type { NodeReader, ProjectRecord } from '../node/readApi.js'
import type {
  AccountInfo,
  AppleSigning,
  Banner,
  ClusterStatus,
  MasonfileCommit,
  MasonfileText,
  NodeView,
  StatusInfo,
  WorkerNode,
} from '../shared/api/index.js'
import { graphFromJson, type RunGraph } from '../view/run.js'
import type { ViewerRole } from '../view/shell.js'

/** Worker capacity and health for the top bar, and the workers for the dashboard. */
export function cluster(master: Master): {
  status: ClusterStatus
  nodes: WorkerNode[]
} {
  const workers = master.registry
    .list()
    .filter((node) => node.role === 'worker')
  const nodes = workers.map((node): WorkerNode => {
    const inventory = master.scheduler.inventoryOf(node.fingerprint)
    return {
      name: node.name,
      status: workerStatus(master, node),
      detail: [
        node.type,
        inventory == null ? undefined : `${inventory.os} ${inventory.arch}`,
        `${node.slots} slot${node.slots === 1 ? '' : 's'}`,
      ]
        .filter((part) => part != null && part !== '')
        .join(' · '),
    }
  })
  return {
    status: {
      idle: nodes.filter((node) => node.status === 'idle').length,
      total: nodes.length,
      healthy: nodes.every((node) => node.status !== 'offline'),
    },
    nodes,
  }
}

/** A worker's state: offline, busy running a stage, or idle; a host is idle while connected. */
export function workerStatus(
  master: Master,
  node: Pick<NodeRecord, 'role' | 'connected' | 'fingerprint'>,
): 'idle' | 'busy' | 'offline' {
  if (!node.connected) return 'offline'
  if (node.role === 'host') return 'idle'
  return master.scheduler.busy(node.fingerprint) ? 'busy' : 'idle'
}

/** The stage a node runs now, as `<run id> <stage>`. */
export function runningStage(
  master: Master,
  fingerprint: string,
): string | undefined {
  return (
    master.database.db
      .prepare(
        "SELECT job_id||' '||name AS name FROM job_stages WHERE worker=? AND status='running' LIMIT 1",
      )
      .get(fingerprint) as { name: string } | undefined
  )?.name
}

/** `GET /api/v2/nodes`: each node's record and details, with what it is doing. */
export function nodeViews(master: Master): NodeView[] {
  return master.registry.list().map((node) => {
    const stage = runningStage(master, node.fingerprint)
    return {
      ...node,
      checklist: [],
      ...master.nodeDetails(node.fingerprint),
      status: workerStatus(master, node),
      ...(stage == null ? {} : { stage }),
    } as NodeView
  })
}

/**
 * The backup reminder, for those who may configure backups; an
 * administrator who skipped confirming the key is reminded of it too.
 */
export function backupNotice(master: Master, actor: Actor): string | undefined {
  if (!master.configured() || !can(actor, 'settings.read')) return undefined
  return (
    master.backups.notice() ??
    (can(actor, 'backups.key') &&
    actor.accountId != null &&
    master.backups.needsConfirmation(actor.accountId)
      ? 'The backup key is not confirmed as stored'
      : undefined)
  )
}

/** The master's shell status for a caller: its workers, and the banners that apply. */
export function masterStatus(
  master: Master,
  actor: Actor,
  testEndpoints: boolean,
): StatusInfo {
  const notice = backupNotice(master, actor)
  const banners: Banner[] = [
    ...(testEndpoints
      ? [
          {
            kind: 'testEndpoints' as const,
            text: 'Test endpoints are enabled on this Mason node.',
          },
        ]
      : []),
    ...(notice == null
      ? []
      : [{ kind: 'backup' as const, text: notice, href: '/backups' }]),
  ]
  return { node: 'master', cluster: cluster(master).status, banners }
}

/** Whether a caller may see an app ID: developers and up every one, testers (and tester keys) their groups'. */
export function appVisibleTo(
  master: Master,
  actor: Pick<Actor, 'role' | 'accountId' | 'creator'>,
): (appId: number) => boolean {
  if (actor.role !== 'tester') return () => true
  const account = actor.accountId ?? actor.creator
  if (account == null) return () => false
  const admitted = master.database.db
    .prepare('SELECT open_admission FROM accounts WHERE id=?')
    .get(account) as { open_admission?: number } | undefined
  if (admitted?.open_admission === 1) return () => true
  const allowed = new Set(
    (
      master.database.db
        .prepare(
          'SELECT ga.app_id FROM group_apps ga JOIN group_members gm ON gm.group_id=ga.group_id WHERE gm.account_id=?',
        )
        .all(account) as Array<{ app_id: number }>
    ).map((row) => row.app_id),
  )
  return (appId) => allowed.has(appId)
}

/** The commits a project's Masonfile tab offers: each commit's newest run first, 30 at most. */
export function masonfileCommits(
  master: Master,
  projectId: number,
): MasonfileCommit[] {
  return master.database.db
    .prepare(
      'SELECT commit_sha AS sha,branch FROM (SELECT commit_sha,branch,ROW_NUMBER() OVER (PARTITION BY commit_sha ORDER BY created DESC) AS place,created FROM jobs WHERE project_id=? AND commit_sha IS NOT NULL) WHERE place=1 ORDER BY created DESC LIMIT 30',
    )
    .all(projectId) as unknown as MasonfileCommit[]
}

/** Settings → Apple: the Apple ID, its teams and their certificates, failures and teams being set up. */
export async function appleSigning(master: Master): Promise<AppleSigning> {
  const apple = master.apple.status()
  const stored = (
    (master.settings.value('apple') ?? {}) as {
      teams?: Record<string, { keyId: string; name?: string }>
    }
  ).teams
  const configured = Object.entries(stored ?? {}).map(([id, key]) => {
    const certificate = master.appleSigning.certificates.current(
      id,
      'distribution',
    )
    return {
      id,
      name: key.name ?? id,
      keyId: key.keyId,
      ...(certificate == null
        ? {}
        : {
            certificate: {
              name: certificate.name,
              expiresAt: certificate.expiresAt,
            },
          }),
    }
  })
  const setup =
    apple.state !== 'signedIn'
      ? undefined
      : await master.appleSetup.teams().then(
          (teams) => ({
            keyName: master.appleSetup.keyName,
            teams,
            configured,
          }),
          (error: unknown) => ({
            keyName: master.appleSetup.keyName,
            teams: [],
            configured,
            error: (error as Error).message,
          }),
        )
  return {
    signedIn: apple.state === 'signedIn',
    needsCode: apple.state === 'needsCode',
    ...(apple.appleId == null ? {} : { appleId: apple.appleId }),
    ...(apple.notice == null ? {} : { notice: apple.notice }),
    ...(setup == null ? {} : { setup }),
    failures: master.appleSigning.setupFailures(),
    settingUp: master.appleTeamsInSetup(),
  }
}

/** The master's reads for the shared read routes, over its database. */
export function masterReader(
  master: Master,
  context: { testEndpoints: boolean },
): NodeReader {
  const db = master.database.db
  const record = (slug: string): ProjectRecord | undefined => {
    let project
    try {
      project = master.projects.get(slug)
    } catch (error) {
      if (error instanceof ProjectNotFound) return undefined
      throw error
    }
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      details: projectDetails(project, master.buildNumbers, master.pushes),
      appNames: project.apps.map((app) => ({
        bundleId: app.bundleId,
        name: app.name,
      })),
    }
  }
  return {
    node: 'master',
    db,
    now: () => master.database.now(),
    authenticate: authenticate(master),
    caller: actorOf,
    appVisible: (actor) => appVisibleTo(master, actor),
    artifactBase: () =>
      ((master.settings.value('host') ?? {}) as { origin?: string }).origin ??
      '',
    status: (actor) => masterStatus(master, actor, context.testEndpoints),
    approvalRoles: (job, stage) =>
      master.scheduler.approvalRoles(job, stage) as ViewerRole[] | undefined,
    notices: () => master.notices(),
    dashboard: () => ({
      nodes: cluster(master).nodes,
      repositories: new Map(
        (
          db
            .prepare(
              'SELECT id,repository,webhook_secret IS NOT NULL AS webhook FROM projects',
            )
            .all() as Array<{ id: number; repository: string; webhook: number }>
        ).map((row) => [
          row.id,
          { repository: row.repository, webhook: row.webhook === 1 },
        ]),
      ),
      pinned: new Map(
        master.projects
          .list()
          .map((project) => [project.id, pushBranches(project, master.pushes)]),
      ),
    }),
    project: record,
    reserved: (run) => reservedBuildNumber(db, run),
    graphOf: (job): RunGraph | undefined => {
      const row = db
        .prepare(
          'SELECT j.workflow,g.graph FROM jobs j LEFT JOIN graphs g ON g.key=j.graph_key WHERE j.id=?',
        )
        .get(job) as { workflow: string; graph: string | null } | undefined
      return row == null ? undefined : graphFromJson(row.graph, row.workflow)
    },
    runOptions: () => ({
      repository: (project) =>
        (
          db
            .prepare('SELECT repository FROM projects WHERE id=?')
            .get(project) as { repository: string } | undefined
        )?.repository,
      nodeName: (fingerprint) => master.registry.get(fingerprint)?.name,
      requester: (label) => requesterName(db, label),
      buildNumber: (job) => reservedBuildNumber(db, job),
    }),
    masonfileCommits: (projectId) => masonfileCommits(master, projectId),
    // The copy kept when a run pinned the commit, else the mirror; a
    // Masonfile too large to copy is read from the mirror.
    masonfile: async (project, commit): Promise<MasonfileText> => {
      const kept = db
        .prepare('SELECT file,text FROM masonfiles WHERE key=?')
        .get(`${project.id}:${commit}`) as
        | { file: string; text: string }
        | undefined
      const file =
        kept?.file ??
        master.projects.get(project.slug).entrypoint ??
        'Masonfile.ts'
      if (kept != null && kept.text !== masonfileTooLarge(kept.file))
        return { commit, file, text: kept.text }
      const text = await master.mirrors
        .show(project.slug, project.details.repository, commit, file)
        .catch((error: unknown) => {
          throw new NotFound((error as Error).message)
        })
      if (text == null) throw new NotFound(`${file} is not in that commit.`)
      return { commit, file, text }
    },
    account: (actor): AccountInfo => {
      const person = master.people.get(actor, actor.accountId!)
      return {
        id: person.id,
        name: person.name,
        role: person.role,
        ...(person.username == null ? {} : { username: person.username }),
        password: person.password,
        emails: person.emails,
        editable: true,
        passwordHere: true,
      }
    },
    canSeed: (actor) => can(actor, 'buildNumbers.seed'),
  }
}
