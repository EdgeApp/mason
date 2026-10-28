import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import type { Json, ParamValue, Role } from '../../types/mason/index.js'
import {
  LinkError,
  type Link,
  type MethodTable,
  type Stream,
} from '../link/link.js'
import type {
  SetupAssignment,
  StageAssignment,
  StageSigning,
  RunReport,
} from '../pipeline/assignment.js'
import type { AppleService } from '../apple/service.js'
import {
  decide,
  evaluateWhen,
  isTerminal,
  postConditions,
  postRuns,
  runStatus,
  scriptGraph,
  validateGraph,
  validateParams,
  GraphError,
  ParamsError,
  type Graph,
  type GraphStage,
  type GraphWorkflow,
  type StageState,
} from '../pipeline/graph.js'
import type { FullInventory } from '../worker/inventory.js'
import { missingTools, type InstallRequest } from '../worker/tools/index.js'
import { selectXcode } from '../worker/tools/versions.js'
import type { ChecklistItem } from '../worker/system/reconcile.js'
import type { AppleXcode } from './apple/developerDownloads.js'
import type { NodeType } from './nodeTypes.js'
import type { Artifacts } from './artifacts.js'
import type { BuildNumbers } from './buildNumbers.js'
import type { MasterDatabase } from './database.js'
import { allowRole } from './permissions.js'
import { Forbidden, type Actor } from './roles.js'
import type { Jobs, JobView } from './jobs.js'
import type { Mirrors } from './mirrors.js'
import { IN_PROCESS, type NodeRecord, type NodeRegistry } from './nodes.js'
import type { Project, Projects } from './projects.js'
import { matches, ruleFor } from './rules.js'
import type { Stashes } from './stash.js'
import { cronMatches, masterTimeZone, parseCron } from './triggers.js'

type Row = Record<string, unknown>

/** The workflow name of a run that only reads the Masonfile (the add-project wizard). */
export const DISCOVER = '@discover'
export const SETUP = '@setup'
const terminalJob = [
  'succeeded',
  'unstable',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
]
const failures = ['failed', 'timed_out', 'interrupted']
/** Extra time past a stage's own timeout before the master gives up on a silent worker. */
const GRACE_MS = 60_000
/** How a run that passed its workflow timeout is recorded. */
const TIMED_OUT = 'The run passed its workflow timeout'

export class RunRefused extends Error {}

export interface StageView {
  name: string
  kind: string
  status: string
  /** `running (disconnected)` while the worker's link is down. */
  display: string
  attempt: number
  worker?: string
  workerName?: string
  started?: number
  finished?: number
  reason?: string
  output?: Json
  reused: boolean
  group?: string
  approval?: GraphStage['approval'] & { decision?: unknown }
  steps: Array<{
    id: number
    attempt: number
    kind: string
    title: string
    status: string
    ms?: number
  }>
}

export interface SchedulerOptions {
  master: MasterDatabase
  projects: Projects
  jobs: Jobs
  buildNumbers: BuildNumbers
  registry: NodeRegistry
  mirrors: Mirrors
  stashes: Stashes
  /** `<data>/logs`. */
  logs: string
  /** The run page URL, for `ctx.run.url`. */
  runUrl?: (job: string) => string
  timeZone?: string
  tickMs?: number
  /** How long past a stage's timeout the master waits for a silent worker. */
  graceMs?: number
  /** Whether a node type records an administrator's Android SDK licence acceptance. */
  androidLicencesAccepted?: (nodeType: string) => boolean
  /** A node type's definition: its Xcode default and whether betas are allowed. */
  nodeType?: (name: string) => NodeType | undefined
  /** Xcodes Apple offers to the master's signed-in Apple ID, for on-demand installs. */
  appleXcodes?: () => AppleXcode[]
  /** Manual steps on the master that block nodes (the Apple ID code). */
  masterChecklist?: () => ChecklistItem[]
  /** Publication: reservations and upload tokens at assignment, grants and queries from stages. */
  artifacts?: Artifacts
  /** Apple signing: a signing stage's identity and profiles, and its TestFlight and notary calls. */
  apple?: {
    signing(project: Project, stage: GraphStage): Promise<StageSigning>
    service: AppleService
  }
  /** Cloud pools: a machine for a type no free node serves, and machines that are retiring. */
  cloud?: {
    demand(type: string): string | undefined
    draining(fingerprint: string): boolean
    /** A setup with no connected worker asks a pool for a machine. */
    setupDemand?(): string | undefined
  }
}

/** A stage needs an Xcode when it has an `apple` option or asks for macOS. */
export function needsXcode(stage: GraphStage): boolean {
  return (
    stage.tools?.xcode != null ||
    stage.apple != null ||
    (typeof stage.on === 'object' && stage.on.os === 'macos')
  )
}

/**
 * The Xcode a stage asks for on a node of this type: its own `xcode` (with
 * the repository's `.xcode-version` filled in at setup), else the type's
 * default, else `latest`. `latest-beta` is `latest` unless the type allows
 * betas.
 */
export function xcodeSpec(
  stage: GraphStage,
  type: NodeType | undefined,
): string | undefined {
  if (!needsXcode(stage)) return undefined
  const spec = stage.tools?.xcode ?? type?.software.xcodeDefault ?? 'latest'
  return spec === 'latest-beta' && type?.software.allowBeta !== true
    ? 'latest'
    : spec
}

/** The `.xcode-version` file's version, applied to stages that need Xcode and name none. */
export function applyXcodeVersion(
  graph: Graph,
  file: string | undefined,
): string | undefined {
  if (file == null) return undefined
  const version = file.trim().split('\n')[0]!.trim()
  if (!/^[\w.<>= -]{1,40}$/.test(version))
    return `Ignoring .xcode-version: ${JSON.stringify(version.slice(0, 40))} is not an Xcode version`
  for (const workflow of graph.workflows)
    for (const stage of workflow.stages)
      if (needsXcode(stage) && stage.tools?.xcode == null)
        stage.tools = { ...stage.tools, xcode: version }
  return undefined
}

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex')
const sortedParams = (params: Record<string, unknown>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
    ),
  )

/** A worker's inventory row with the master's node record. */
interface WorkerSlot {
  node: NodeRecord
  inventory: FullInventory
  link: Link
  /** Tools the stage needs that this worker must install first. */
  missing: InstallRequest[]
  /** The Xcode chosen for the stage's `xcode` range. */
  developerDir?: string
}

interface Fit {
  missing: InstallRequest[]
  developerDir?: string
  /** The checklist item that keeps the stage off this node for now. */
  blocked?: string
}

const noTools = { node: [], rust: [], java: [], android: [] }

/**
 * The master's scheduler: resolves each job's commit, gets its validated
 * graph (from the cache or a secret-free setup run on any idle worker), and
 * assigns ready stages to workers whose inventory matches, recording every
 * transition in the database before it takes effect.
 */
/**
 * A signing stage runs only on nodes with the project's signing label, when
 * the project sets one.
 */
export function withSigningLabel(
  stage: GraphStage,
  project: Project,
): GraphStage {
  const label = project.signingLabel
  if (stage.apple == null || label == null) return stage
  const on = stage.on
  if (on === 'master') return stage
  if (on == null) return { ...stage, on: { labels: [label] } }
  if (typeof on === 'string')
    return { ...stage, on: { type: on, labels: [label] } }
  return {
    ...stage,
    on: { ...on, labels: [...new Set([...(on.labels ?? []), label])] },
  }
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined
  private ticking: Promise<void> | undefined
  private again = false
  private readonly preparing = new Map<string, Promise<void>>()
  /** Signing prepared for a stage, by `<job>/<stage>`, until it is placed. */
  private readonly signing = new Map<
    string,
    | { state: 'pending' }
    | { state: 'ready'; signing: StageSigning }
    | { state: 'failed'; error: string }
  >()
  private readonly ensured = new Set<string>()
  private lastSchedule = 0
  private stopped = false
  private readonly waiters = new Set<() => void>()
  /** System installs preparing stages asked each worker for: `xcode:<version>`, `simulators:<name>`. */
  private readonly requestedInstalls = new Map<string, Map<string, number>>()

  constructor(readonly options: SchedulerOptions) {
    options.registry.on('connected', (fingerprint: string, link: Link) => {
      if (this.stopped) return
      void this.connected(fingerprint, link)
        .catch(() => undefined)
        .finally(() => {
          this.poke()
        })
    })
    options.registry.on('disconnected', (fingerprint: string) => {
      // Links also close while the master shuts down, after its database.
      if (this.stopped) return
      this.db
        .prepare(
          "UPDATE job_stages SET disconnected=1 WHERE worker=? AND status='running'",
        )
        .run(fingerprint)
      this.poke()
    })
  }

  private get db(): MasterDatabase['db'] {
    return this.options.master.db
  }
  private now(): number {
    return this.options.master.now()
  }

  start(): void {
    this.stopped = false
    // After a restart no worker link is up yet; running stages wait for their workers to report.
    this.db
      .prepare("UPDATE job_stages SET disconnected=1 WHERE status='running'")
      .run()
    this.timer = setInterval(() => {
      this.poke()
    }, this.options.tickMs ?? 1000)
    this.timer.unref()
    this.poke()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    await this.ticking
    await Promise.allSettled([...this.preparing.values()])
  }

  /** Runs a scheduling pass soon. */
  poke(): void {
    if (this.stopped) return
    if (this.ticking != null) {
      this.again = true
      return
    }
    this.ticking = this.tick()
      .catch(() => undefined)
      .finally(() => {
        this.ticking = undefined
        for (const wake of this.waiters) wake()
        if (this.again) {
          this.again = false
          this.poke()
        }
      })
  }

  /** Resolves after the next scheduling pass; for tests and the CLI. */
  async settle(): Promise<void> {
    if (this.stopped) return
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        this.waiters.delete(wake)
        resolve()
      }
      this.waiters.add(wake)
      this.poke()
    })
    await Promise.allSettled([...this.preparing.values()])
  }

  async tick(): Promise<void> {
    if (this.now() - this.lastSchedule >= 10_000) {
      this.lastSchedule = this.now()
      this.schedules()
    }
    const jobs = this.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created, id",
      )
      .all()
    for (const job of jobs) {
      try {
        await this.advance(job)
      } catch (error) {
        this.finishJob(
          String(job.id),
          'failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  // ── Jobs ──────────────────────────────────────────────────────────────

  private job(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)
  }
  private project(row: Row): Project {
    const slug = this.db
      .prepare('SELECT slug FROM projects WHERE id=?')
      .get(Number(row.project_id))
    return this.options.projects.get(String(slug?.slug))
  }
  private stages(job: string): Row[] {
    return this.db
      .prepare(
        'SELECT * FROM job_stages WHERE job_id=? ORDER BY position, name',
      )
      .all(job)
  }
  private stage(job: string, name: string): Row | undefined {
    return this.db
      .prepare('SELECT * FROM job_stages WHERE job_id=? AND name=?')
      .get(job, name)
  }
  graph(key: string): Graph | undefined {
    const row = this.db.prepare('SELECT graph FROM graphs WHERE key=?').get(key)
    return row == null ? undefined : (JSON.parse(String(row.graph)) as Graph)
  }
  private workflowOf(
    job: Row,
  ): { graph: Graph; workflow: GraphWorkflow } | undefined {
    if (job.graph_key == null) return undefined
    const graph = this.graph(String(job.graph_key))
    const workflow = graph?.workflows.find(
      (entry) => entry.name === job.workflow,
    )
    return graph == null || workflow == null ? undefined : { graph, workflow }
  }
  /** The roles that may decide an approval stage, from its run's graph. */
  approvalRoles(id: string, name: string): Role[] | undefined {
    const job = this.job(id)
    return job == null
      ? undefined
      : this.workflowOf(job)?.workflow.stages.find(
          (entry) => entry.name === name,
        )?.approval?.roles
  }
  private params(job: Row): Record<string, ParamValue> {
    return JSON.parse(String(job.params)) as Record<string, ParamValue>
  }

  private graphKey(job: Row, commit: string): string {
    return hash(
      JSON.stringify([
        Number(job.project_id),
        commit,
        job.workflow,
        job.branch,
        job.trigger === 'restart' ? 'request' : job.trigger,
        sortedParams(this.params(job)),
      ]),
    )
  }

  private async advance(job: Row): Promise<void> {
    const id = String(job.id)
    if (this.preparing.has(id)) return
    if (job.status === 'running') {
      this.run(job)
      return
    }
    if (job.cancel === 1) {
      this.cancelStage(id, SETUP)
      if (!this.active(id))
        this.finishJob(id, 'cancelled', 'Cancelled before it started')
      return
    }
    if (
      job.commit_sha == null ||
      !this.ensured.has(`${String(job.project_id)}:${String(job.commit_sha)}`)
    ) {
      this.preparing.set(
        id,
        this.prepare(job)
          .catch((error: unknown) => {
            this.finishJob(
              id,
              'failed',
              error instanceof Error ? error.message : String(error),
            )
          })
          .finally(() => {
            this.preparing.delete(id)
            this.poke()
          }),
      )
      return
    }
    if (job.graph_key == null) this.setup(job)
    else this.begin(job)
  }

  /** Pins the job's commit and makes sure the master's mirror holds it. */
  private async prepare(job: Row): Promise<void> {
    const project = this.project(job)
    const commit = await this.options.mirrors.ensure(
      project.slug,
      project.repository,
      job.commit_sha != null
        ? { commit: String(job.commit_sha) }
        : job.requested_commit != null
          ? { commit: String(job.requested_commit) }
          : { branch: String(job.branch) },
    )
    // Submodules and `ctx.checkout` fetch from mirrors of the other listed repositories.
    for (const repository of project.repositories)
      await this.options.mirrors.ensure(project.slug, repository)
    this.db
      .prepare('UPDATE jobs SET commit_sha=? WHERE id=?')
      .run(commit!, String(job.id))
    this.ensured.add(`${String(job.project_id)}:${commit!}`)
    if (job.graph_key != null) return
    if (project.format === 'script') {
      const graph = scriptGraph(project)
      const key = hash(
        JSON.stringify([
          'script',
          project.id,
          project.timeoutSeconds,
          project.script.on ?? null,
        ]),
      )
      this.storeGraph(key, job, commit!, graph)
      this.db
        .prepare('UPDATE jobs SET graph_key=? WHERE id=?')
        .run(key, String(job.id))
      return
    }
    const key = this.graphKey(job, commit!)
    if (this.graph(key) != null)
      this.db
        .prepare('UPDATE jobs SET graph_key=? WHERE id=?')
        .run(key, String(job.id))
  }

  private storeGraph(
    key: string,
    job: Row,
    commit: string,
    graph: Graph,
  ): void {
    this.db
      .prepare(
        'INSERT INTO graphs(key,project_id,branch,commit_sha,workflow,graph,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO NOTHING',
      )
      .run(
        key,
        Number(job.project_id),
        String(job.branch),
        commit,
        String(job.workflow),
        JSON.stringify(graph),
        this.now(),
      )
  }

  /** Assigns the job's setup run to any idle worker. */
  private setup(job: Row): void {
    const id = String(job.id)
    const row = this.stage(id, SETUP)
    if (row == null) {
      this.db
        .prepare(
          "INSERT INTO job_stages(job_id,name,position,kind,status) VALUES(?,?,-1,'setup','queued')",
        )
        .run(id, SETUP)
      this.options.master.change('job', id)
    } else if (row.status !== 'queued') {
      if (row.status === 'running') this.checkDeadline(job, row)
      return
    }
    const project = this.project(job)
    const worker = this.pick(undefined, id)
    if (worker == null) {
      // With no worker connected at all, only a cloud machine can run it.
      const connected = this.options.registry
        .list()
        .some((node) => node.role === 'worker' && node.connected)
      const reason = connected ? undefined : this.options.cloud?.setupDemand?.()
      if (reason != null && this.stage(id, SETUP)?.reason !== reason) {
        this.db
          .prepare(
            "UPDATE job_stages SET reason=? WHERE job_id=? AND name=? AND status='queued'",
          )
          .run(reason, id, SETUP)
        this.options.master.change('job', id)
      }
      return
    }
    const attempt = Number(this.stage(id, SETUP)!.attempt) + 1
    const token = randomBytes(24).toString('hex')
    const assignment: SetupAssignment = {
      kind: 'setup',
      key: `${id}/${SETUP}/${attempt}`,
      token,
      job: id,
      project: project.slug,
      repository: project.repository,
      repositories: project.repositories,
      commit: String(job.commit_sha),
      ...(project.entrypoint == null ? {} : { entrypoint: project.entrypoint }),
      context: {
        workflow: String(job.workflow),
        branch: String(job.branch),
        commit: String(job.commit_sha),
        trigger: (job.trigger === 'restart'
          ? 'request'
          : job.trigger) as SetupAssignment['context']['trigger'],
        params: this.params(job),
      },
      timeout: 300,
    }
    this.startStage(job, SETUP, attempt, token, worker, 300)
    this.send(worker, 'setup.run', assignment, id, SETUP)
  }

  /** Records a stage as running on a worker before the assignment is sent. */
  private startStage(
    job: Row,
    name: string,
    attempt: number,
    token: string,
    worker: WorkerSlot,
    timeout: number,
  ): void {
    const id = String(job.id)
    this.db
      .prepare(
        "UPDATE job_stages SET status='running',attempt=?,token=?,worker=?,assigned=?,started=?,finished=NULL,deadline=?,disconnected=0,log_seq=0,reason=NULL,cancel=0 WHERE job_id=? AND name=?",
      )
      .run(
        attempt,
        token,
        worker.node.fingerprint,
        this.now(),
        this.now(),
        this.now() + timeout * 1000 + (this.options.graceMs ?? GRACE_MS),
        id,
        name,
      )
    this.appendLog(
      id,
      name,
      `── ${name === SETUP ? 'Setup' : `Stage ${name}`}, attempt ${attempt}, on ${worker.node.name} ──\n`,
    )
    this.options.master.change('job', id)
  }

  private send(
    worker: WorkerSlot,
    method: string,
    assignment: SetupAssignment | StageAssignment,
    job: string,
    name: string,
  ): void {
    worker.link.request(method, assignment).then(
      () => undefined,
      (error: unknown) => {
        const row = this.stage(job, name)
        if (row?.status === 'running' && row.token === assignment.token) {
          if (
            error instanceof LinkError &&
            (error.code === 'closed' || error.code === 'timeout')
          )
            // The worker may have it: reconciliation on its next link, or the stage's deadline, decides.
            this.db
              .prepare(
                'UPDATE job_stages SET disconnected=1 WHERE job_id=? AND name=?',
              )
              .run(job, name)
          else
            // The worker refused it: queue it again; the next attempt gets a new key.
            this.db
              .prepare(
                "UPDATE job_stages SET status='queued',worker=NULL,token=NULL WHERE job_id=? AND name=?",
              )
              .run(job, name)
        }
        this.appendLog(
          job,
          name,
          `Assignment to ${worker.node.name} failed: ${(error as Error).message}\n`,
        )
        this.poke()
      },
    )
  }

  /** Applies the graph a setup run returned, or fails the job with its error. */
  private setupDone(job: Row, report: RunReport): void {
    const id = String(job.id)
    if (report.status !== 'succeeded') {
      this.finishJob(
        id,
        report.status === 'cancelled' ? 'cancelled' : 'failed',
        report.reason ?? 'Setup failed',
      )
      return
    }
    const project = this.project(job)
    let graph: Graph
    try {
      const discover = job.workflow === DISCOVER
      graph = validateGraph(report.value, {
        ...(discover ? { structureOnly: true } : {}),
        apps: project.apps.map((app) => app.bundleId),
        signs: Object.fromEntries(
          project.apps
            .filter((app) => app.apple != null)
            .map((app) => [app.bundleId, app.apple!.bundleIds]),
        ),
        secrets: [
          ...project.env.map((entry) => entry.name),
          ...project.files.map((file) => file.env ?? file.destination),
        ],
      })
      // A discovery's graph is never run, so its schemes are not declared.
      if (!discover)
        for (const [key, scheme] of Object.entries(graph.buildNumbers))
          this.options.buildNumbers.checkScheme(
            project.id,
            key,
            String(job.branch),
            scheme,
          )
      if (!discover)
        for (const [key, scheme] of Object.entries(graph.buildNumbers))
          this.options.buildNumbers.declare(project.id, key, scheme)
    } catch (error) {
      this.appendLog(id, SETUP, `${(error as Error).message}\n`)
      this.finishJob(id, 'failed', (error as Error).message)
      return
    }
    const ignored = applyXcodeVersion(graph, report.xcodeVersion)
    if (ignored != null) graph.warnings.push(ignored)
    for (const warning of graph.warnings)
      this.appendLog(id, SETUP, `warning: ${warning}\n`)
    // An Xcode that launches on none of the nodes a stage can use fails the run now.
    for (const stage of graph.workflows.find(
      (workflow) => workflow.name === job.workflow,
    )?.stages ?? []) {
      const reason = needsXcode(stage) ? this.neverLaunches(stage) : undefined
      if (reason == null) continue
      this.appendLog(id, SETUP, `${stage.name}: ${reason}\n`)
      this.finishJob(id, 'failed', `${stage.name}: ${reason}`)
      return
    }
    const key = this.graphKey(job, String(job.commit_sha))
    this.storeGraph(key, job, String(job.commit_sha), graph)
    this.db.prepare('UPDATE jobs SET graph_key=? WHERE id=?').run(key, id)
    if (job.trigger === 'push' && job.workflow === 'build')
      for (const workflow of graph.workflows)
        if (
          workflow.name !== 'build' &&
          workflow.triggers.some((trigger) => 'push' in trigger)
        )
          this.options.jobs.create(project, String(job.branch), 'push', {
            workflow: workflow.name,
            commit: String(job.commit_sha),
          })
  }

  /** Starts a job whose graph is known: checks its trigger, parameters and concurrency group, then creates its stages. */
  private begin(job: Row): void {
    const id = String(job.id)
    // A discovery run only records the Masonfile's graph, for the add-project wizard.
    if (job.workflow === DISCOVER) {
      this.finishJob(id, 'succeeded', 'Read the Masonfile')
      return
    }
    const found = this.workflowOf(job)
    if (found == null) {
      this.finishJob(
        id,
        'failed',
        `Workflow ${String(job.workflow)} is not declared in the Masonfile`,
      )
      return
    }
    const { workflow } = found
    const trigger = String(job.trigger)
    const allowed =
      trigger === 'restart' ||
      workflow.triggers.some((entry) =>
        trigger === 'push'
          ? 'push' in entry
          : trigger === 'request'
            ? 'request' in entry
            : trigger === 'schedule'
              ? 'schedule' in entry
              : trigger === 'after'
                ? 'after' in entry
                : 'deviceRegistered' in entry,
      )
    if (!allowed) {
      this.finishJob(
        id,
        'cancelled',
        `Workflow ${workflow.name} has no ${trigger} trigger`,
      )
      return
    }
    let params: Record<string, ParamValue>
    try {
      params = validateParams(workflow.params, this.params(job))
    } catch (error) {
      this.finishJob(id, 'failed', (error as Error).message)
      return
    }
    const project = this.project(job)
    const group = workflow.concurrency.group
    const concurrency = `${project.id}:${
      group === 'branch'
        ? `branch:${workflow.name}:${String(job.branch)}`
        : group === 'workflow'
          ? `workflow:${workflow.name}`
          : group === 'project'
            ? 'project'
            : `group:${group}`
    }`
    // Runs that share the group: those already placed in it, and older ones still
    // waiting for their graph that will land in it.
    const older = (other: Row): boolean =>
      Number(other.created) < Number(job.created) ||
      (Number(other.created) === Number(job.created) && String(other.id) < id)
    const others = this.db
      .prepare(
        "SELECT * FROM jobs WHERE project_id=? AND id<>? AND status IN ('queued','running') AND cancel=0",
      )
      .all(Number(job.project_id), id)
      .filter((other) =>
        other.concurrency != null
          ? other.concurrency === concurrency
          : older(other) &&
            (group === 'project' ||
              (other.workflow === workflow.name &&
                (group !== 'branch' || other.branch === job.branch))),
      )
    if (workflow.concurrency.cancelPrevious)
      for (const other of others.filter(older))
        this.cancel(
          String(other.id),
          'Cancelled by a newer run in its concurrency group',
        )
    else if (
      others.some((other) => other.status === 'running' || older(other))
    ) {
      this.db
        .prepare('UPDATE jobs SET concurrency=? WHERE id=?')
        .run(concurrency, id)
      return
    }
    this.options.master.transaction(() => {
      this.db
        .prepare(
          "UPDATE jobs SET status='running',started=?,deadline=?,concurrency=?,params=? WHERE id=?",
        )
        .run(
          this.now(),
          this.now() + workflow.timeout * 1000,
          concurrency,
          JSON.stringify(params),
          id,
        )
      const existing = new Set(this.stages(id).map((row) => String(row.name)))
      ;[...workflow.stages, ...workflow.post].forEach((stage, position) => {
        if (!existing.has(stage.name))
          this.db
            .prepare(
              "INSERT INTO job_stages(job_id,name,position,kind,status) VALUES(?,?,?,?,'queued')",
            )
            .run(id, stage.name, position, stage.kind)
      })
    })
    this.options.master.change('job', id)
    this.run(this.job(id)!)
  }

  private states(job: string): Record<string, StageState> {
    return Object.fromEntries(
      this.stages(job).map((row) => [
        String(row.name),
        row.status as StageState,
      ]),
    )
  }

  private active(job: string): boolean {
    return this.stages(job).some((row) => row.status === 'running')
  }

  /** Moves a running job along: deadlines, approvals, ready stages, post stages and the end. */
  private run(job: Row): void {
    const id = String(job.id)
    const found = this.workflowOf(job)
    if (found == null) {
      this.finishJob(id, 'failed', 'The run has no graph')
      return
    }
    const { workflow } = found
    if (
      job.cancel === 1 ||
      (job.deadline != null && this.now() > Number(job.deadline))
    ) {
      const timedOut = job.cancel !== 1
      if (timedOut && job.reason !== TIMED_OUT)
        this.db
          .prepare('UPDATE jobs SET reason=?,cancel=1 WHERE id=?')
          .run(TIMED_OUT, id)
      for (const stage of workflow.stages) this.cancelStage(id, stage.name)
    }
    const fresh = this.job(id)!
    const facts = {
      branch: String(job.branch),
      trigger: (job.trigger === 'restart'
        ? 'request'
        : job.trigger) as 'request',
      params: this.params(job),
    }
    let states = this.states(id)
    for (const stage of workflow.stages) {
      const state = states[stage.name]
      const row = this.stage(id, stage.name)!
      if (state === 'running') {
        this.checkDeadline(fresh, row)
        continue
      }
      if (state === 'awaiting_approval') {
        if (row.deadline != null && this.now() > Number(row.deadline)) {
          this.finishStage(
            id,
            stage.name,
            'cancelled',
            'The approval timed out',
          )
          this.cancel(id, `Approval ${stage.name} timed out`)
        }
        continue
      }
      if (state !== 'queued' || fresh.cancel === 1) continue
      const decision = decide(stage, states, facts)
      if (decision === 'wait') continue
      if (decision === 'skip') {
        this.finishStage(
          id,
          stage.name,
          'skipped',
          evaluateWhen(stage.when, facts)
            ? 'A dependency did not succeed'
            : 'Its when condition is false',
        )
        states = this.states(id)
        continue
      }
      if (stage.kind === 'approval') {
        this.db
          .prepare(
            "UPDATE job_stages SET status='awaiting_approval',started=?,deadline=? WHERE job_id=? AND name=?",
          )
          .run(
            this.now(),
            stage.approval?.timeout == null
              ? null
              : this.now() + stage.approval.timeout * 1000,
            id,
            stage.name,
          )
        this.options.master.change('job', id)
        states = this.states(id)
        continue
      }
      this.assign(fresh, stage, workflow)
      states = this.states(id)
    }
    if (workflow.stages.some((stage) => !isTerminal(states[stage.name]))) return
    // Post stages run one after another once everything else has finished.
    const latest = this.job(id)!
    const main = this.mainStatus(latest, workflow, states)
    for (const condition of postConditions) {
      const stage = workflow.post.find((entry) => entry.post === condition)
      if (stage == null) continue
      const state = states[stage.name]
      if (state === 'running') {
        this.checkDeadline(latest, this.stage(id, stage.name)!)
        return
      }
      if (state !== 'queued') continue
      if (!postRuns(condition, main, this.previousStatus(latest))) {
        this.finishStage(
          id,
          stage.name,
          'skipped',
          `The ${condition} condition does not hold`,
        )
        continue
      }
      this.assign(latest, stage, workflow)
      return
    }
    const finalStates = this.states(id)
    const postFailed = workflow.post.some((stage) =>
      failures.includes(String(finalStates[stage.name])),
    )
    this.finishJob(
      id,
      postFailed && main !== 'cancelled' && main !== 'timed_out'
        ? 'failed'
        : main,
    )
  }

  private mainStatus(
    job: Row,
    workflow: GraphWorkflow,
    states: Record<string, StageState>,
  ): ReturnType<typeof runStatus> {
    if (job.reason === TIMED_OUT) return 'timed_out'
    const status = runStatus(
      workflow.stages.map((stage) => states[stage.name]!),
      workflow.stages,
    )
    if (job.cancel === 1 && status !== 'failed') return 'cancelled'
    return status
  }

  /** The status of the previous finished run of the same workflow and branch. */
  private previousStatus(job: Row): string | undefined {
    const row = this.db
      .prepare(
        "SELECT status FROM jobs WHERE project_id=? AND workflow=? AND branch=? AND created<? AND status IN ('succeeded','unstable','failed','cancelled','timed_out','interrupted') ORDER BY created DESC LIMIT 1",
      )
      .get(
        Number(job.project_id),
        String(job.workflow),
        String(job.branch),
        Number(job.created),
      )
    return row == null ? undefined : String(row.status)
  }

  private checkDeadline(job: Row, row: Row): void {
    if (row.deadline == null || this.now() <= Number(row.deadline)) return
    const fingerprint = row.worker == null ? undefined : String(row.worker)
    if (
      row.disconnected === 1 ||
      fingerprint == null ||
      this.options.registry.link(fingerprint) == null
    ) {
      this.appendLog(
        String(job.id),
        String(row.name),
        'No word from the worker by the stage timeout; the stage is interrupted.\n',
      )
      this.stageDone(String(job.id), String(row.name), Number(row.attempt), {
        status: 'interrupted',
        reason: 'No word from its worker by the stage timeout',
      })
    }
  }

  // ── Workers ───────────────────────────────────────────────────────────

  /** The inventory a worker last reported. */
  inventoryOf(fingerprint: string): FullInventory | undefined {
    return this.inventory(fingerprint)
  }

  /** Whether a worker has a stage or setup run in progress. */
  busy(fingerprint: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM job_stages WHERE worker=? AND status IN ('running','preparing') LIMIT 1",
        )
        .get(fingerprint) != null
    )
  }

  private inventory(fingerprint: string): FullInventory | undefined {
    const row = this.db
      .prepare('SELECT inventory FROM worker_inventory WHERE fingerprint=?')
      .get(fingerprint)
    return row == null
      ? undefined
      : (JSON.parse(String(row.inventory)) as FullInventory)
  }

  /** Connected, unquarantined workers matching a selector, least busy first. */
  private candidates(stage: GraphStage | undefined): WorkerSlot[] {
    const out: Array<WorkerSlot & { load: number }> = []
    for (const node of this.options.registry.list()) {
      if (node.role !== 'worker') continue
      const link = this.options.registry.link(node.fingerprint)
      const inventory = this.inventory(node.fingerprint)
      if (link == null || inventory == null || inventory.quarantine != null)
        continue
      if (this.options.cloud?.draining(node.fingerprint) === true) continue
      const load = Number(
        (
          this.db
            .prepare(
              "SELECT COUNT(*) n FROM job_stages WHERE worker=? AND status IN ('running','preparing')",
            )
            .get(node.fingerprint) as { n: number }
        ).n,
      )
      if (load >= Math.min(node.slots, inventory.slots)) continue
      if (stage != null && !this.matches(stage, node, inventory)) continue
      const fit: Fit | undefined =
        stage == null ? { missing: [] } : this.fit(stage, node, inventory)
      if (fit == null || fit.blocked != null) continue
      out.push({ node, inventory, link, load, ...fit })
    }
    // Workers that already have the stage's tools come before ones that must install them.
    return out.sort(
      (a, b) =>
        Number(a.missing.length > 0) - Number(b.missing.length > 0) ||
        a.load - b.load ||
        a.node.name.localeCompare(b.node.name),
    )
  }

  /**
   * Whether a worker can run a stage: the Xcode it asks for must launch on
   * the node, or be one Apple offers to install; node, rust, java, Android,
   * simulator runtimes and packages may be installed first. A checklist item
   * that blocks one of those installs keeps the stage off the node for now.
   */
  private fit(
    stage: GraphStage,
    node: NodeRecord,
    inventory: FullInventory,
  ): Fit | undefined {
    const tools = stage.tools
    const type = this.options.nodeType?.(node.type)
    const missing = missingTools(tools, inventory.tools ?? noTools)
    const needs = new Set<string>()
    let developerDir: string | undefined
    const spec = xcodeSpec(stage, type)
    if (spec != null) {
      if (inventory.os !== 'macos') return undefined
      const launching = (inventory.xcodes ?? []).filter(
        (install) => install.launches !== false,
      )
      const xcode = selectXcode(spec, launching)
      if (xcode != null)
        developerDir = path.join(xcode.path, 'Contents', 'Developer')
      else {
        const offered = selectXcode(
          spec,
          (this.options.appleXcodes?.() ?? []).map((release) => ({
            version: release.version,
            build: '',
            path: release.version,
            beta: release.beta,
          })),
        )
        // Before the Apple ID signs in, the releases Apple offers are unknown: wait for it.
        const apple = (this.options.masterChecklist?.() ?? []).find((item) =>
          item.blocks.includes('apple'),
        )
        if (
          offered == null &&
          apple != null &&
          (this.options.appleXcodes?.() ?? []).length === 0
        )
          return { missing, blocked: apple.title }
        if (
          offered == null ||
          (inventory.xcodes ?? []).some(
            (install) =>
              install.launches === false &&
              path.basename(install.path) === `Xcode-${offered.version}.app`,
          )
        )
          return undefined
        missing.push({ tool: 'xcode', version: offered.version })
        needs.add('system').add('apple')
      }
    }
    const system = inventory.system
    const lacking = (
      wanted: string[] | undefined,
      have: string[] | undefined,
    ): string[] => (wanted ?? []).filter((name) => !(have ?? []).includes(name))
    if (inventory.os === 'macos') {
      const runtimes = lacking(
        tools?.simulators,
        system?.runtimes.map((runtime) => runtime.name),
      )
      if (runtimes.length > 0) {
        missing.push({ tool: 'simulators', packages: runtimes })
        needs.add('system')
      }
      const brew = lacking(tools?.brew, system?.brew?.formulae)
      if (brew.length > 0) {
        missing.push({ tool: 'brew', packages: brew })
        needs.add('system').add('brew')
      }
    } else {
      for (const manager of ['apt', 'dnf'] as const) {
        const packages = lacking(tools?.[manager], system?.[manager])
        if (packages.length === 0) continue
        if (system != null && system[manager] == null) return undefined
        missing.push({ tool: manager, packages })
        needs.add('system')
      }
    }
    const blocked = [
      ...(inventory.checklist ?? []),
      ...(this.options.masterChecklist?.() ?? []),
    ].find((item) => item.blocks.some((tag) => needs.has(tag)))
    return {
      missing,
      ...(developerDir == null ? {} : { developerDir }),
      ...(blocked == null ? {} : { blocked: blocked.title }),
    }
  }

  /** Why an Xcode a stage asks for runs on no connected node, when every match fails to launch. */
  private neverLaunches(stage: GraphStage): string | undefined {
    let reason: string | undefined
    for (const node of this.options.registry.list()) {
      const inventory = this.inventory(node.fingerprint)
      if (node.role !== 'worker' || inventory == null) continue
      if (!this.matches(stage, node, inventory)) continue
      const spec = xcodeSpec(stage, this.options.nodeType?.(node.type))
      if (spec == null || inventory.os !== 'macos') return undefined
      if (selectXcode(spec, inventory.xcodes ?? [])?.launches !== false)
        return undefined
      const install = selectXcode(spec, inventory.xcodes ?? [])!
      reason ??= `Xcode ${install.version} does not launch on ${node.name} (macOS ${inventory.osVersion}): ${install.launchError ?? 'it does not start'}`
    }
    return reason
  }

  /** Connected workers whose selector and Xcode fit a stage, whatever their load. */
  private candidatesIgnoringLoad(stage: GraphStage): number {
    return this.options.registry.list().filter((node) => {
      const inventory = this.inventory(node.fingerprint)
      return (
        node.role === 'worker' &&
        inventory != null &&
        this.options.registry.link(node.fingerprint) != null &&
        this.matches(stage, node, inventory) &&
        this.fit(stage, node, inventory) != null
      )
    }).length
  }

  /** Connected workers a stage's selector matches, whatever their tools and load. */
  private selectable(stage: GraphStage): number {
    return this.options.registry.list().filter((node) => {
      const inventory = this.inventory(node.fingerprint)
      return (
        node.role === 'worker' &&
        inventory != null &&
        this.options.registry.link(node.fingerprint) != null &&
        this.matches(stage, node, inventory)
      )
    }).length
  }

  /**
   * Ensures a signing stage's profiles and identity on the master — Apple is
   * asked only when a profile must be made or replaced — then pokes the
   * scheduler to place the stage.
   */
  private prepareSigning(job: Row, stage: GraphStage, key: string): void {
    const apple = this.options.apple
    const id = String(job.id)
    if (apple == null) {
      this.signing.set(key, {
        state: 'failed',
        error: 'This master has no Apple signing',
      })
      this.poke()
      return
    }
    this.signing.set(key, { state: 'pending' })
    void apple
      .signing(this.project(job), stage)
      .then(
        (signing) => {
          this.appendLog(
            id,
            stage.name,
            `Apple signing: ${signing.identity.name}; profiles ${signing.profiles.map((profile) => profile.name).join(', ')}\n`,
          )
          this.signing.set(key, { state: 'ready', signing })
        },
        (error: unknown) => {
          this.signing.set(key, {
            state: 'failed',
            error: (error as Error).message,
          })
        },
      )
      .finally(() => {
        this.poke()
      })
  }

  /**
   * Installs the tools a stage is missing on the chosen worker while the stage
   * waits in `preparing`; the installers' logs go into the stage log.
   */
  private prepareTools(
    job: string,
    stage: GraphStage,
    worker: WorkerSlot,
  ): void {
    this.db
      .prepare(
        "UPDATE job_stages SET status='preparing',worker=?,started=? WHERE job_id=? AND name=?",
      )
      .run(worker.node.fingerprint, this.now(), job, stage.name)
    this.appendLog(
      job,
      stage.name,
      `── Preparing ${stage.name} on ${worker.node.name}: installing ${worker.missing
        .map((request) =>
          request.packages != null
            ? `${request.tool} ${request.packages.join(' ')}`
            : `${request.tool} ${request.version ?? ''}`,
        )
        .join(', ')} ──\n`,
    )
    this.options.master.change('job', job)
    const fingerprint = worker.node.fingerprint
    const asked = worker.missing.flatMap((request) =>
      request.tool === 'xcode'
        ? [`xcode:${request.version ?? ''}`]
        : request.tool === 'simulators'
          ? (request.packages ?? []).map((name) => `simulators:${name}`)
          : [],
    )
    const requested = this.requestedInstalls.get(fingerprint) ?? new Map()
    this.requestedInstalls.set(fingerprint, requested)
    for (const entry of asked)
      requested.set(entry, (requested.get(entry) ?? 0) + 1)
    void (async (): Promise<void> => {
      for (const request of worker.missing) {
        const system = request.tool === 'xcode' || request.tool === 'simulators'
        const answer = (await worker.link.request(
          'tools.install',
          request.tool === 'android'
            ? {
                ...request,
                nodeType: worker.node.type,
                acceptLicences:
                  this.options.androidLicencesAccepted?.(worker.node.type) ===
                  true,
              }
            : request,
          (system ? 6 : 1) * 60 * 60 * 1000,
        )) as {
          ok: boolean
          error?: string
          log: string
          inventory: FullInventory
        }
        this.appendLog(job, stage.name, answer.log)
        this.storeInventory(worker.node.fingerprint, answer.inventory)
        if (this.stage(job, stage.name)?.status !== 'preparing') return
        if (!answer.ok) {
          this.appendLog(
            job,
            stage.name,
            `${answer.error ?? 'Install failed'}\n`,
          )
          this.finishStage(
            job,
            stage.name,
            'failed',
            answer.error ?? 'Install failed',
          )
          return
        }
      }
      if (this.stage(job, stage.name)?.status === 'preparing')
        this.db
          .prepare(
            "UPDATE job_stages SET status='queued',worker=NULL WHERE job_id=? AND name=?",
          )
          .run(job, stage.name)
    })()
      .catch((error: unknown) => {
        // The worker went away mid-install: the stage waits for a worker again.
        this.appendLog(
          job,
          stage.name,
          `Preparing failed: ${(error as Error).message}\n`,
        )
        if (this.stage(job, stage.name)?.status === 'preparing')
          this.db
            .prepare(
              "UPDATE job_stages SET status='queued',worker=NULL WHERE job_id=? AND name=?",
            )
            .run(job, stage.name)
      })
      .finally(() => {
        for (const entry of asked) {
          const left = (requested.get(entry) ?? 1) - 1
          if (left > 0) requested.set(entry, left)
          else requested.delete(entry)
        }
        this.poke()
      })
  }

  /** Whether a stage preparing on this worker asked it to install this Xcode or runtime. */
  requested(
    fingerprint: string,
    tool: 'xcode' | 'simulators',
    name: string,
  ): boolean {
    return (
      this.requestedInstalls.get(fingerprint)?.has(`${tool}:${name}`) ?? false
    )
  }

  storeInventory(fingerprint: string, inventory: FullInventory): void {
    this.db
      .prepare(
        'INSERT INTO worker_inventory(fingerprint,inventory,quarantine,updated) VALUES(?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET inventory=excluded.inventory,quarantine=excluded.quarantine,updated=excluded.updated',
      )
      .run(
        fingerprint,
        JSON.stringify(inventory),
        inventory.quarantine ?? null,
        this.now(),
      )
  }

  private matches(
    stage: GraphStage,
    node: NodeRecord,
    inventory: FullInventory,
  ): boolean {
    const on = stage.on
    if (on == null) return true
    if (typeof on === 'string')
      return on === 'master' ? node.host === IN_PROCESS : node.type === on
    if (on.type != null && node.type !== on.type) return false
    if (on.os != null && inventory.os !== on.os) return false
    if (on.arch != null && inventory.arch !== on.arch) return false
    return (on.labels ?? []).every((label) => node.labels.includes(label))
  }

  private pick(
    stage: GraphStage | undefined,
    _job: string,
  ): WorkerSlot | undefined {
    return this.candidates(stage)[0]
  }

  /** Called when a worker's link opens: stores its inventory and reconciles what each side thinks runs. */
  async connected(fingerprint: string, link: Link): Promise<void> {
    const node = this.options.registry.get(fingerprint)
    if (node?.role !== 'worker') return
    let state: {
      inventory: FullInventory
      runs: Array<{ key: string; status: string }>
    }
    // Anything assigned after this question cannot be in the answer.
    const asked = this.now()
    try {
      state = (await link.request('worker.state')) as typeof state
    } catch {
      return
    }
    this.storeInventory(fingerprint, state.inventory)
    const known = new Map(state.runs.map((run) => [run.key, run.status]))
    for (const row of this.db
      .prepare("SELECT * FROM job_stages WHERE worker=? AND status='running'")
      .all(fingerprint)) {
      const key = `${String(row.job_id)}/${String(row.name)}/${Number(row.attempt)}`
      if (known.has(key) && row.cancel === 1)
        await link.request('stage.cancel', { key }).catch(() => undefined)
      if (known.has(key))
        this.db
          .prepare(
            'UPDATE job_stages SET disconnected=0 WHERE job_id=? AND name=?',
          )
          .run(String(row.job_id), String(row.name))
      else if (Number(row.assigned) < asked)
        this.stageDone(
          String(row.job_id),
          String(row.name),
          Number(row.attempt),
          {
            status: 'interrupted',
            reason: 'Its worker no longer had the stage',
          },
        )
    }
    for (const [key, status] of known) {
      if (status !== 'running') continue
      const [job, ...rest] = key.split('/')
      const attempt = Number(rest.pop())
      const row = this.stage(job!, rest.join('/'))
      if (
        row?.status !== 'running' ||
        Number(row.attempt) !== attempt ||
        row.worker !== fingerprint
      )
        await link.request('stage.cancel', { key }).catch(() => undefined)
    }
  }

  // ── Stages ────────────────────────────────────────────────────────────

  private secretFacts(
    project: Project,
    stage: GraphStage,
  ): {
    secrets: Record<string, string>
    files: Record<string, string>
    env: Record<string, string>
    inject: NonNullable<StageAssignment['inject']>
  } {
    const stored = this.options.projects.secrets(project.id)
    if (stage.kind === 'script')
      return {
        env: Object.fromEntries(
          stored.env
            .filter((entry) => !entry.secret)
            .map((entry) => [entry.name, entry.value]),
        ),
        secrets: Object.fromEntries(
          stored.env
            .filter((entry) => entry.secret)
            .map((entry) => [entry.name, entry.value]),
        ),
        files: {},
        inject: stored.files.map((file) => ({
          destination: file.destination,
          contents: file.contents,
          ...(file.env == null ? {} : { env: file.env }),
        })),
      }
    const declared = new Set(stage.secrets)
    return {
      env: {},
      secrets: Object.fromEntries(
        stored.env
          .filter((entry) => declared.has(entry.name))
          .map((entry) => [entry.name, entry.value]),
      ),
      files: Object.fromEntries(
        stored.files
          .filter((file) => declared.has(file.env ?? file.destination))
          .map((file) => [file.env ?? file.destination, file.contents]),
      ),
      inject: [],
    }
  }

  private locks(job: Row, stage: GraphStage): boolean {
    if (stage.lock.length === 0) return true
    const id = String(job.id)
    return this.options.master.transaction(() => {
      for (const name of stage.lock) {
        const row = this.db
          .prepare(
            'SELECT job_id,stage FROM resource_locks WHERE project_id=? AND name=?',
          )
          .get(Number(job.project_id), name)
        if (row != null && (row.job_id !== id || row.stage !== stage.name))
          return false
      }
      for (const name of stage.lock)
        this.db
          .prepare(
            'INSERT OR REPLACE INTO resource_locks(project_id,name,job_id,stage) VALUES(?,?,?,?)',
          )
          .run(Number(job.project_id), name, id, stage.name)
      return true
    })
  }

  private unlock(job: string, stage: string): void {
    this.db
      .prepare('DELETE FROM resource_locks WHERE job_id=? AND stage=?')
      .run(job, stage)
  }

  /** Assigns a ready stage to a matching idle worker: reserves its build numbers and sends its snapshot. */
  private assign(
    job: Row,
    graphStage: GraphStage,
    workflow: GraphWorkflow,
  ): void {
    const id = String(job.id)
    const stage = withSigningLabel(graphStage, this.project(job))
    const worker = this.pick(stage, id)
    if (worker == null) {
      // Connected workers match the selector but none has an Xcode the range accepts.
      if (
        needsXcode(stage) &&
        this.selectable(stage) > 0 &&
        this.candidatesIgnoringLoad(stage) === 0
      )
        this.finishStage(
          id,
          stage.name,
          'failed',
          this.neverLaunches(stage) ??
            `No connected node for this stage has or can install an Xcode matching ${stage.tools?.xcode ?? 'its node type’s default'}`,
        )
      else {
        // A type backed by a cloud pool starts a machine; the stage shows why it waits.
        const type = typeof stage.on === 'string' ? stage.on : stage.on?.type
        const reason =
          type == null ? undefined : this.options.cloud?.demand(type)
        if (reason != null && this.stage(id, stage.name)?.reason !== reason) {
          this.db
            .prepare(
              "UPDATE job_stages SET reason=? WHERE job_id=? AND name=? AND status='queued'",
            )
            .run(reason, id, stage.name)
          this.options.master.change('job', id)
        }
      }
      return
    }
    // A signing stage waits for its identity and profiles before it is placed.
    let signing: StageSigning | undefined
    if (stage.apple != null) {
      const key = `${id}/${stage.name}`
      const prepared = this.signing.get(key)
      if (prepared == null) {
        this.prepareSigning(job, stage, key)
        return
      }
      if (prepared.state === 'pending') return
      this.signing.delete(key)
      if (prepared.state === 'failed') {
        this.appendLog(id, stage.name, `Apple signing: ${prepared.error}\n`)
        this.finishStage(id, stage.name, 'failed', prepared.error)
        return
      }
      signing = prepared.signing
    }
    if (!this.locks(job, stage)) return
    if (worker.missing.length > 0) {
      this.unlock(id, stage.name)
      this.prepareTools(id, stage, worker)
      return
    }
    const project = this.project(job)
    const row = this.stage(id, stage.name)!
    const attempt = Number(row.attempt) + 1
    const token = randomBytes(24).toString('hex')
    const graph = this.workflowOf(job)!.graph
    const buildNumbers: Record<string, string> = {}
    try {
      // An app ID listed in a sequence's `apps` takes its number from that sequence.
      const sequenceOf = (key: string): string =>
        Object.entries(graph.buildNumbers).find(([, scheme]) =>
          scheme.apps?.includes(key),
        )?.[0] ?? key
      for (const key of [
        ...new Set([...stage.publishes, ...stage.buildNumbers]),
      ]) {
        const sequence = sequenceOf(key)
        // One number per sequence per run: a run's stages share it; a new run gets the next.
        buildNumbers[key] = this.options.buildNumbers.reserve(
          project.id,
          sequence,
          String(job.branch),
          graph.buildNumbers[sequence] ?? {},
          id,
        )
        buildNumbers[sequence] = buildNumbers[key]
      }
    } catch (error) {
      this.unlock(id, stage.name)
      this.appendLog(id, stage.name, `${(error as Error).message}\n`)
      this.finishStage(id, stage.name, 'failed', (error as Error).message)
      return
    }
    const outputs: Record<string, Json> = {}
    const params = { ...this.params(job) }
    for (const other of this.stages(id))
      if (other.output != null && isTerminal(other.status as StageState)) {
        outputs[String(other.name)] = JSON.parse(String(other.output)) as Json
        if (other.kind === 'approval')
          Object.assign(
            params,
            (JSON.parse(String(other.output)) as { params?: object }).params ??
              {},
          )
      }
    const secrets = this.secretFacts(project, stage)
    const node = this.options.registry.get(worker.node.fingerprint)!
    const request = JSON.parse(String(job.request)) as {
      platforms?: string[]
      envVars?: Array<Record<string, string>>
    }
    // Each declared publication gets a reservation with its reserved number, and the stage a signed upload token.
    const reserved = {
      job: id,
      stage: stage.name,
      attempt,
      project: project.id,
    }
    const reservations =
      this.options.artifacts?.reserve(
        reserved,
        stage.publishes,
        buildNumbers,
      ) ?? []
    const upload = this.options.artifacts?.uploadToken(
      reserved,
      reservations,
      stage.timeout,
    )
    const assignment: StageAssignment = {
      kind: stage.kind === 'script' ? 'script' : 'stage',
      key: `${id}/${stage.name}/${attempt}`,
      token,
      job: id,
      stage: stage.name,
      attempt,
      project: project.slug,
      repository: project.repository,
      repositories: project.repositories,
      commit: String(job.commit_sha),
      ...(project.entrypoint == null ? {} : { entrypoint: project.entrypoint }),
      ...(stage.run == null ? {} : { function: stage.run }),
      run: {
        id,
        number: Number(job.number),
        workflow: workflow.name,
        branch: String(job.branch),
        commit: String(job.commit_sha),
        trigger: (job.trigger === 'restart'
          ? 'request'
          : job.trigger) as 'request',
        params,
        url: this.options.runUrl?.(id) ?? `/runs/${id}`,
        changes: [],
      },
      matrix: stage.matrix,
      checkout: stage.checkout,
      workspace: stage.workspace,
      workspaceRoots: node.workspaceRoots,
      cache: stage.cache,
      env: {
        ...workflow.env,
        ...stage.env,
        ...secrets.env,
        ...Object.fromEntries(
          (request.envVars ?? []).flatMap((entry) => Object.entries(entry)),
        ),
      },
      secrets: secrets.secrets,
      files: secrets.files,
      ...(stage.kind === 'script'
        ? {
            inject: secrets.inject,
            platforms: request.platforms ?? project.script.platforms ?? [],
          }
        : {}),
      buildNumbers,
      outputs,
      stashes: this.options.stashes.list(id).map((entry) => entry.name),
      timeout: stage.timeout,
      ...(stage.activityTimeout == null
        ? {}
        : { activityTimeout: stage.activityTimeout }),
      continueOnError: stage.continueOnError,
      ...(stage.tools == null ? {} : { tools: stage.tools }),
      ...(worker.developerDir == null
        ? {}
        : { developerDir: worker.developerDir }),
      ...(upload == null ? {} : { uploads: { ...upload, reservations } }),
      ...(signing == null ? {} : { apple: signing }),
    }
    this.startStage(job, stage.name, attempt, token, worker, stage.timeout)
    this.send(worker, 'stage.run', assignment, id, stage.name)
  }

  /** Marks a stage finished without running it. */
  private finishStage(
    job: string,
    name: string,
    status: string,
    reason?: string,
  ): void {
    this.db
      .prepare(
        'UPDATE job_stages SET status=?,reason=?,finished=? WHERE job_id=? AND name=?',
      )
      .run(status, reason ?? null, this.now(), job, name)
    this.unlock(job, name)
    this.options.master.change('job', job)
  }

  /** Stops a stage: a running one is asked to stop, a waiting one is cancelled at once. */
  private cancelStage(job: string, name: string): void {
    const row = this.stage(job, name)
    if (row == null) return
    if (
      row.status === 'queued' ||
      row.status === 'awaiting_approval' ||
      row.status === 'preparing'
    ) {
      this.finishStage(job, name, 'cancelled', 'The run was stopped')
      return
    }
    if (row.status !== 'running' || row.cancel === 1) return
    this.db
      .prepare('UPDATE job_stages SET cancel=1 WHERE job_id=? AND name=?')
      .run(job, name)
    const key = `${job}/${name}/${Number(row.attempt)}`
    const link =
      row.worker == null
        ? undefined
        : this.options.registry.link(String(row.worker))
    if (link == null) {
      // A disconnected worker learns of the cancel when it reconnects.
      return
    }
    void link.request('stage.cancel', { key }).catch(() => undefined)
  }

  /** Applies a worker's report for one stage attempt. */
  private stageDone(
    job: string,
    name: string,
    attempt: number,
    report: RunReport,
  ): void {
    const row = this.stage(job, name)
    if (
      row == null ||
      row.status !== 'running' ||
      Number(row.attempt) !== attempt
    )
      return
    const jobRow = this.job(job)!
    if (name === SETUP) {
      this.db
        .prepare(
          'UPDATE job_stages SET status=?,finished=?,reason=? WHERE job_id=? AND name=?',
        )
        .run(report.status, this.now(), report.reason ?? null, job, name)
      this.setupDone(jobRow, report)
      this.poke()
      return
    }
    const found = this.workflowOf(jobRow)
    const stage =
      found == null
        ? undefined
        : [...found.workflow.stages, ...found.workflow.post].find(
            (entry) => entry.name === name,
          )
    const retry = stage?.retry
    if (
      retry != null &&
      attempt < retry.attempts &&
      (retry.on as string[]).includes(report.status) &&
      row.cancel !== 1 &&
      jobRow.cancel !== 1
    ) {
      this.appendLog(
        job,
        name,
        `Attempt ${attempt} ended ${report.status}; retrying.\n`,
      )
      this.db
        .prepare(
          "UPDATE job_stages SET status='queued',worker=NULL,token=NULL,reason=? WHERE job_id=? AND name=?",
        )
        .run(report.reason ?? report.status, job, name)
      this.unlock(job, name)
      this.poke()
      return
    }
    this.db
      .prepare(
        'UPDATE job_stages SET status=?,finished=?,reason=?,output=? WHERE job_id=? AND name=?',
      )
      .run(
        report.status,
        this.now(),
        report.reason ?? null,
        report.value === undefined ? null : JSON.stringify(report.value),
        job,
        name,
      )
    if (report.exitCode != null)
      this.db
        .prepare('UPDATE jobs SET exit_code=? WHERE id=?')
        .run(report.exitCode, job)
    if (stage?.kind === 'script' && report.value !== undefined)
      this.db
        .prepare('UPDATE jobs SET result=? WHERE id=?')
        .run(JSON.stringify(report.value), job)
    this.unlock(job, name)
    // failFast: a failure cancels the run's other running stages; what needed it is skipped.
    if (
      failures.includes(report.status) &&
      stage?.failFast === true &&
      stage.post == null &&
      found != null
    )
      for (const other of found.workflow.stages)
        if (
          other.name !== name &&
          this.stage(job, other.name)?.status === 'running'
        )
          this.cancelStage(job, other.name)
    this.options.master.change('job', job)
    this.poke()
  }

  private finishJob(id: string, status: string, reason?: string): void {
    const job = this.job(id)
    if (job == null || terminalJob.includes(String(job.status))) return
    this.db
      .prepare(
        'UPDATE jobs SET status=?,finished=?,reason=COALESCE(reason,?) WHERE id=?',
      )
      .run(status, this.now(), reason ?? null, id)
    this.db.prepare('DELETE FROM resource_locks WHERE job_id=?').run(id)
    this.options.artifacts?.release(id)
    for (const row of this.stages(id))
      if (row.status === 'queued' || row.status === 'awaiting_approval')
        this.db
          .prepare(
            'UPDATE job_stages SET status=?,finished=? WHERE job_id=? AND name=?',
          )
          .run(
            row.name === SETUP ? 'cancelled' : 'skipped',
            this.now(),
            id,
            String(row.name),
          )
    if (status === 'succeeded' && job.trigger === 'push')
      this.options.jobs.succeeded(id)
    this.options.master.change('job', id)
    // A push that arrived while this run was busy builds now, not at the next poll.
    if (job.trigger === 'push')
      try {
        this.options.jobs.pushedSince(this.project(job), String(job.branch))
      } catch {
        // The project is gone.
      }
    for (const node of this.options.registry.list())
      void this.options.registry
        .link(node.fingerprint)
        ?.request('job.forget', { job: id })
        .catch(() => undefined)
    this.after(this.job(id)!)
  }

  // ── Triggers ──────────────────────────────────────────────────────────

  /** `after` triggers: workflows of the same project that follow this run's workflow for the same commit. */
  private after(job: Row): void {
    const found = this.workflowOf(job)
    if (found == null || job.commit_sha == null) return
    const project = this.project(job)
    for (const workflow of found.graph.workflows)
      for (const trigger of workflow.triggers)
        if (
          'after' in trigger &&
          trigger.after.workflow === job.workflow &&
          ((trigger.after.status ?? 'success') === 'completed' ||
            job.status === 'succeeded')
        )
          this.options.jobs.create(project, String(job.branch), 'after', {
            workflow: workflow.name,
            commit: String(job.commit_sha),
          })
  }

  /** The newest recorded graph of each branch of a project. */
  private branchGraphs(
    project: Project,
  ): Array<{ branch: string; commit: string; graph: Graph }> {
    return this.db
      .prepare(
        'SELECT g.branch,g.commit_sha,g.graph FROM graphs g WHERE g.project_id=? AND g.created=(SELECT MAX(created) FROM graphs WHERE project_id=g.project_id AND branch=g.branch)',
      )
      .all(project.id)
      .map((row) => ({
        branch: String(row.branch),
        commit: String(row.commit_sha),
        graph: JSON.parse(String(row.graph)) as Graph,
      }))
  }

  /** `schedule` triggers: once per matching minute, on branches the rules allow. */
  schedules(at = this.now()): void {
    const minute = Math.floor(at / 60000) * 60000
    const timeZone = this.options.timeZone ?? masterTimeZone()
    for (const project of this.options.projects.list()) {
      if (!project.enabled) continue
      for (const { branch, graph } of this.branchGraphs(project)) {
        if (ruleFor(project.rules, branch) == null) continue
        for (const workflow of graph.workflows)
          for (const trigger of workflow.triggers) {
            if (!('schedule' in trigger)) continue
            const branches = trigger.branches ?? [project.defaultBranch]
            if (!branches.some((pattern) => matches(pattern, branch))) continue
            let cron
            try {
              cron = parseCron(trigger.schedule)
            } catch {
              continue
            }
            if (!cronMatches(cron, minute, timeZone)) continue
            const inserted = this.db
              .prepare(
                'INSERT OR IGNORE INTO schedule_fires(project_id,workflow,branch,at) VALUES(?,?,?,?)',
              )
              .run(project.id, workflow.name, branch, minute)
            if (Number(inserted.changes) === 1)
              this.options.jobs.create(project, branch, 'schedule', {
                workflow: workflow.name,
              })
          }
      }
    }
  }

  /** `deviceRegistered` triggers: the workflows on each project's default branch that declare it. */
  deviceRegistered(): JobView[] {
    const out: JobView[] = []
    for (const project of this.options.projects.list()) {
      if (!project.enabled) continue
      const latest = this.branchGraphs(project).find(
        (entry) => entry.branch === project.defaultBranch,
      )
      for (const workflow of latest?.graph.workflows ?? [])
        if (workflow.triggers.some((trigger) => 'deviceRegistered' in trigger))
          out.push(
            this.options.jobs.create(
              project,
              project.defaultBranch,
              'deviceRegistered',
              { workflow: workflow.name },
            ),
          )
    }
    this.poke()
    return out
  }

  // ── Actions ───────────────────────────────────────────────────────────

  /**
   * Requests a run of any workflow. Parameters are checked against the
   * newest graph of that branch before anything runs; a bad one is refused.
   */
  async request(
    actor: Actor,
    input: {
      project: string
      branch?: string
      workflow?: string
      params?: unknown
      commit?: string
    },
  ): Promise<JobView> {
    allowRole(actor, 'runs.request')
    const project = this.options.projects.resolve(input.project)
    if (project == null || !project.enabled)
      throw new RunRefused('Unknown or disabled project')
    const branch = input.branch ?? project.defaultBranch
    if (ruleFor(project.rules, branch) == null)
      throw new RunRefused(`No branch rule of ${project.slug} allows ${branch}`)
    if (input.commit != null && !/^[0-9a-f]{40}$/.test(input.commit))
      throw new RunRefused('Invalid commit')
    if (
      input.params != null &&
      (typeof input.params !== 'object' || Array.isArray(input.params))
    )
      throw new ParamsError('Parameters must be an object')
    const workflowName = input.workflow ?? 'build'
    // The run is pinned to the branch head now, so its parameters can be
    // checked against that commit's Masonfile when a setup already recorded it.
    let commit: string | undefined
    try {
      commit = await this.options.mirrors.ensure(
        project.slug,
        project.repository,
        input.commit != null ? { commit: input.commit } : { branch },
      )
    } catch (error) {
      throw new RunRefused((error as Error).message)
    }
    const known = this.db
      .prepare(
        'SELECT graph FROM graphs WHERE project_id=? AND commit_sha=? AND workflow=? ORDER BY branch=? DESC, created DESC LIMIT 1',
      )
      .get(project.id, commit!, workflowName, branch)
    const workflow =
      known == null
        ? undefined
        : (JSON.parse(String(known.graph)) as Graph).workflows.find(
            (entry) => entry.name === workflowName,
          )
    let params = (input.params ?? {}) as Record<string, unknown>
    if (workflow != null) params = validateParams(workflow.params, params)
    const job = this.options.jobs.create(project, branch, 'request', {
      workflow: workflowName,
      params,
      actor,
      commit: commit!,
    })
    this.poke()
    return job
  }

  cancel(id: string, reason = 'Cancelled'): boolean {
    const job = this.job(id)
    if (job == null || terminalJob.includes(String(job.status))) return false
    this.db
      .prepare('UPDATE jobs SET cancel=1,reason=COALESCE(reason,?) WHERE id=?')
      .run(reason, id)
    // Post stages still run after a cancel (`aborted`, `always`).
    const post = new Set(
      this.workflowOf(job)?.workflow.post.map((stage) => stage.name) ?? [],
    )
    for (const row of this.stages(id))
      if (!post.has(String(row.name))) this.cancelStage(id, String(row.name))
    this.poke()
    return true
  }

  /** Approves or rejects a waiting approval. */
  approve(
    actor: Actor,
    id: string,
    name: string,
    decision: { approve: boolean; params?: unknown },
  ): void {
    const job = this.job(id)
    const row = job == null ? undefined : this.stage(id, name)
    if (job == null || row == null || row.status !== 'awaiting_approval')
      throw new RunRefused('No approval is waiting there')
    const stage = this.workflowOf(job)?.workflow.stages.find(
      (entry) => entry.name === name,
    )
    const allowed = stage?.approval?.roles ?? ['admin', 'manager']
    if (
      !allowed.some((role: Role) => actor.role === role) &&
      actor.role !== 'admin'
    )
      throw new Forbidden(
        `Only ${allowed.join(' or ')} may decide this approval`,
      )
    if (!decision.approve) {
      this.finishStage(id, name, 'cancelled', `Rejected by ${actor.label}`)
      this.cancel(id, `Approval ${name} rejected by ${actor.label}`)
      return
    }
    const params = validateParams(
      stage?.approval?.params ?? {},
      decision.params ?? {},
    )
    this.db
      .prepare(
        "UPDATE job_stages SET status='succeeded',finished=?,output=?,approval=? WHERE job_id=? AND name=?",
      )
      .run(
        this.now(),
        JSON.stringify({ approver: actor.label, params }),
        JSON.stringify({ approver: actor.label, params, at: this.now() }),
        id,
        name,
      )
    this.options.master.change('job', id)
    this.poke()
  }

  /** A new run that reuses every stage not depending on `from`, and reruns `from` and its dependents. */
  restart(actor: Actor, id: string, from: string): JobView {
    allowRole(actor, 'runs.request')
    const job = this.job(id)
    if (job == null) throw new RunRefused('No such run')
    if (!terminalJob.includes(String(job.status)))
      throw new RunRefused('The run has not finished')
    const found = this.workflowOf(job)
    if (found == null) throw new RunRefused('The run’s graph is no longer kept')
    const { workflow } = found
    if (!workflow.stages.some((stage) => stage.name === from))
      throw new RunRefused(`The run has no stage ${from}`)
    const rerun = new Set([from])
    for (let grown = true; grown; ) {
      grown = false
      for (const stage of workflow.stages)
        if (
          !rerun.has(stage.name) &&
          stage.needs.some((need) => rerun.has(need))
        ) {
          rerun.add(stage.name)
          grown = true
        }
    }
    const reused = workflow.stages
      .filter((stage) => !rerun.has(stage.name))
      .map((stage) => stage.name)
    if (!this.options.stashes.kept(id, reused))
      throw new RunRefused(
        'The stashes of the stages it would reuse have expired',
      )
    const project = this.project(job)
    const created = this.options.jobs.create(
      project,
      String(job.branch),
      'restart',
      {
        workflow: String(job.workflow),
        commit: String(job.commit_sha),
        params: this.params(job),
        actor,
        restartOf: id,
        restartFrom: from,
        graphKey: String(job.graph_key),
      },
    )
    const original = new Map(
      this.stages(id).map((row) => [String(row.name), row]),
    )
    this.options.master.transaction(() => {
      ;[...workflow.stages, ...workflow.post].forEach((stage, position) => {
        const old = original.get(stage.name)
        const reuse =
          reused.includes(stage.name) &&
          old != null &&
          isTerminal(old.status as StageState)
        this.db
          .prepare(
            'INSERT INTO job_stages(job_id,name,position,kind,status,attempt,worker,started,finished,output,reason,reused) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            created.id,
            stage.name,
            position,
            stage.kind,
            reuse ? String(old.status) : 'queued',
            reuse ? Number(old.attempt) : 0,
            reuse ? ((old.worker as string | null) ?? null) : null,
            reuse ? ((old.started as number | null) ?? null) : null,
            reuse ? ((old.finished as number | null) ?? null) : null,
            reuse ? ((old.output as string | null) ?? null) : null,
            reuse ? ((old.reason as string | null) ?? null) : null,
            reuse ? 1 : 0,
          )
        if (reuse) {
          const file = this.logFile(id, stage.name)
          if (existsSync(file))
            this.appendLog(created.id, stage.name, readFileSync(file, 'utf8'))
        }
      })
    })
    this.options.stashes.share(id, created.id, reused)
    this.poke()
    return created
  }

  // ── Views ─────────────────────────────────────────────────────────────

  stageViews(id: string): StageView[] {
    const job = this.job(id)
    if (job == null) return []
    const found = this.workflowOf(job)
    const byName = new Map(
      [...(found?.workflow.stages ?? []), ...(found?.workflow.post ?? [])].map(
        (stage) => [stage.name, stage],
      ),
    )
    return this.stages(id).map((row) => {
      const stage = byName.get(String(row.name))
      const fingerprint = row.worker == null ? undefined : String(row.worker)
      const node =
        fingerprint == null ? undefined : this.options.registry.get(fingerprint)
      const status = String(row.status)
      return {
        name: String(row.name),
        kind: String(row.kind),
        status,
        display:
          status === 'running' && row.disconnected === 1
            ? 'running (disconnected)'
            : status.replace('_', ' '),
        attempt: Number(row.attempt),
        ...(fingerprint == null ? {} : { worker: fingerprint }),
        ...(node == null ? {} : { workerName: node.name }),
        ...(row.started == null ? {} : { started: Number(row.started) }),
        ...(row.finished == null ? {} : { finished: Number(row.finished) }),
        ...(row.reason == null ? {} : { reason: String(row.reason) }),
        ...(row.output == null
          ? {}
          : { output: JSON.parse(String(row.output)) as Json }),
        reused: row.reused === 1,
        ...(stage?.group == null ? {} : { group: stage.group }),
        ...(stage?.approval == null
          ? {}
          : {
              approval: {
                ...stage.approval,
                ...(row.approval == null
                  ? {}
                  : { decision: JSON.parse(String(row.approval)) as unknown }),
              },
            }),
        steps: this.db
          .prepare(
            'SELECT * FROM job_steps WHERE job_id=? AND stage=? ORDER BY attempt,id',
          )
          .all(id, String(row.name))
          .map((step) => ({
            id: Number(step.id),
            attempt: Number(step.attempt),
            kind: String(step.kind),
            title: String(step.title),
            status: String(step.status),
            ...(step.ms == null ? {} : { ms: Number(step.ms) }),
          })),
      }
    })
  }

  logFile(job: string, stage: string): string {
    return path.join(this.options.logs, job, `${encodeURIComponent(stage)}.log`)
  }

  /** How long a stage's log is, in bytes. */
  logSize(job: string, stage: string): number {
    return (
      statSync(this.logFile(job, stage), { throwIfNoEntry: false })?.size ?? 0
    )
  }

  private appendLog(job: string, stage: string, text: string): void {
    const file = this.logFile(job, stage)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, text, { mode: 0o600 })
  }

  /** Every stage log of a job, setup first, each under a header. */
  logs(job: string): string | undefined {
    if (this.job(job) == null) return undefined
    return this.stages(job)
      .map((row) => {
        const file = this.logFile(job, String(row.name))
        return existsSync(file) ? readFileSync(file, 'utf8') : ''
      })
      .filter((text) => text !== '')
      .join('\n')
  }

  /** Removes a run and everything kept for it. */
  removeRun(id: string): void {
    this.options.stashes.remove(id)
    rmSync(path.join(this.options.logs, id), { recursive: true, force: true })
    this.db.prepare('DELETE FROM jobs WHERE id=?').run(id)
    this.options.master.change('job', id)
  }

  // ── The worker's link ─────────────────────────────────────────────────

  /** Checks a worker call: the key names a stage attempt this worker runs, with its token. */
  private authorize(
    params: unknown,
    link: Link,
    running = true,
  ): { job: Row; row: Row; name: string; attempt: number; project: Project } {
    const { key, token } = (params ?? {}) as { key?: unknown; token?: unknown }
    if (typeof key !== 'string' || typeof token !== 'string')
      throw new LinkError('Missing stage key', 'not_allowed')
    const parts = key.split('/')
    const attempt = Number(parts.pop())
    const [jobId, ...rest] = parts
    const name = rest.join('/')
    const row = this.stage(jobId!, name)
    const job = row == null ? undefined : this.job(jobId!)
    const expected = row?.token == null ? '' : String(row.token)
    if (
      row == null ||
      job == null ||
      Number(row.attempt) !== attempt ||
      expected.length !== token.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(token)) ||
      row.worker !== link.peer?.fingerprint ||
      (running && row.status !== 'running')
    )
      throw new LinkError(
        'That stage is not assigned to this worker',
        'not_allowed',
      )
    return { job, row, name, attempt, project: this.project(job) }
  }

  /** A signing stage's Apple context: its graph stage, team, app and platform. */
  private appleStage(
    job: Row,
    name: string,
    project: Project,
  ): {
    stage: GraphStage
    signing: Pick<StageSigning, 'team' | 'app' | 'platform' | 'bundleIds'>
    service: AppleService
  } {
    const service = this.options.apple?.service
    const graphStage = this.workflowOf(job)?.workflow.stages.find(
      (entry) => entry.name === name,
    )
    if (service == null || graphStage?.apple == null)
      throw new LinkError('This stage declared no Apple signing', 'failed')
    const stage = withSigningLabel(graphStage, project)
    const appId =
      stage.apple!.app ??
      project.apps.find((app) => app.apple != null)?.bundleId
    const app = project.apps.find((entry) => entry.bundleId === appId)
    if (app?.apple == null)
      throw new LinkError(
        `The app ID ${String(appId)} has no Apple team`,
        'failed',
      )
    const distribution = stage.apple!.distribution
    return {
      stage,
      service,
      signing: {
        team: app.apple.team,
        app: app.bundleId,
        bundleIds: stage.apple!.bundleIds ?? app.apple.bundleIds,
        platform:
          distribution === 'developerId' ||
          distribution === 'macAppStore' ||
          !app.platforms.includes('ios')
            ? 'macos'
            : 'ios',
      },
    }
  }

  /** Apple's refusals reach the stage as link failures with Apple's explanation. */
  private async appleCall<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body()
    } catch (error) {
      if (error instanceof LinkError) throw error
      throw new LinkError((error as Error).message, 'failed')
    }
  }

  private allowedRepository(project: Project, repository: unknown): string {
    const wanted = String(repository).toLowerCase()
    const normalize = (value: string): string =>
      value
        .toLowerCase()
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/(\.git)?$/, '.git')
    const found = [project.repository, ...project.repositories].find(
      (entry) => normalize(entry) === normalize(wanted),
    )
    if (found == null)
      throw new LinkError(
        'That repository is not one this project lists',
        'not_allowed',
      )
    return found
  }

  private relayProcess(
    child: ReturnType<Mirrors['uploadPack']>,
    stream: Stream,
  ): void {
    stream.on('data', (chunk: Buffer) => child.stdin!.write(chunk))
    stream.on('end', () => child.stdin!.end())
    stream.on('abort', () => child.kill())
    child.stdin!.on('error', () => undefined)
    // Writes wait for credit; the stream ends only after the last one is sent.
    let writing = Promise.resolve()
    child.stdout!.on('data', (chunk: Buffer) => {
      child.stdout!.pause()
      writing = writing
        .then(async () => {
          await stream.write(chunk)
        })
        .then(
          () => {
            child.stdout!.resume()
          },
          () => {
            child.kill()
          },
        )
    })
    child.stdout!.on('end', () => {
      void writing.then(() => {
        stream.end()
      })
    })
  }

  /** Methods the master accepts from workers. */
  methods(): MethodTable {
    return {
      requests: {
        'stage.report': (params, link): { acked: number } => {
          const { job, row, name, attempt } = this.authorize(
            params,
            link,
            false,
          )
          const records = ((params as { records?: unknown }).records ??
            []) as Array<{ seq: number; kind: string; data: string }>
          let acked = Number(row.log_seq)
          const id = String(job.id)
          for (const record of records) {
            if (!Number.isSafeInteger(record.seq) || record.seq <= acked)
              continue
            if (record.seq !== acked + 1) break
            if (record.kind === 'log')
              this.appendLog(id, name, String(record.data))
            else if (record.kind === 'publication') {
              const staged = JSON.parse(String(record.data)) as {
                reservation: string
                app: string
                platform: string
              }
              this.options.artifacts?.markStaged(id, staged.reservation)
              this.appendLog(
                id,
                name,
                `Staged ${staged.app} for ${staged.platform} while the master was away; the host confirms it on reconnect\n`,
              )
            } else if (record.kind === 'tests')
              this.options.artifacts?.tests(
                { job: id, stage: name, attempt },
                JSON.parse(String(record.data)),
              )
            else if (record.kind === 'describe')
              this.db
                .prepare('UPDATE jobs SET description=? WHERE id=?')
                .run(String(record.data).slice(0, 200), id)
            else if (record.kind === 'step') {
              const step = JSON.parse(String(record.data)) as {
                id: number
                kind: string
                title: string
                status: string
                ms?: number
              }
              // The step's lines are those its stage log gains while it runs.
              const offset = this.logSize(id, name)
              const done = String(step.status) !== 'running'
              this.db
                .prepare(
                  'INSERT INTO job_steps(job_id,stage,attempt,id,kind,title,status,ms,at,log_start,log_end) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,stage,attempt,id) DO UPDATE SET status=excluded.status,ms=excluded.ms,log_end=excluded.log_end',
                )
                .run(
                  id,
                  name,
                  attempt,
                  step.id,
                  String(step.kind).slice(0, 40),
                  String(step.title).slice(0, 500),
                  String(step.status),
                  step.ms ?? null,
                  this.now(),
                  offset,
                  done ? offset : null,
                )
            }
            acked = record.seq
          }
          this.db
            .prepare(
              'UPDATE job_stages SET log_seq=?,disconnected=0 WHERE job_id=? AND name=?',
            )
            .run(acked, id, name)
          this.options.master.change('job', id)
          return { acked }
        },
        'stage.result': (params, link): null => {
          let authorized
          try {
            authorized = this.authorize(params, link, false)
          } catch {
            // A result for an attempt the master already settled is acknowledged and dropped.
            return null
          }
          this.stageDone(
            String(authorized.job.id),
            authorized.name,
            authorized.attempt,
            (params as { report: RunReport }).report,
          )
          return null
        },
        'run.output': async (
          params,
          link,
        ): Promise<{ value?: Json; pending?: true }> => {
          const { job } = this.authorize(params, link)
          const stage = String((params as { stage?: unknown }).stage)
          const id = String(job.id)
          if (this.stage(id, stage) == null || stage === SETUP)
            throw new LinkError(`Unknown stage ${stage}`, 'failed')
          const deadline = Date.now() + 45_000
          for (;;) {
            const row = this.stage(id, stage)!
            if (isTerminal(row.status as StageState))
              return {
                value:
                  row.output == null
                    ? null
                    : (JSON.parse(String(row.output)) as Json),
              }
            if (Date.now() > deadline) return { pending: true }
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
        },
        /** A grant for one publication into the stage's reservation. */
        'artifacts.grant': (params, link): unknown => {
          const { job, name, attempt } = this.authorize(params, link)
          const artifacts = this.options.artifacts
          if (artifacts == null)
            throw new LinkError('Publication is unavailable', 'failed')
          try {
            return artifacts.grant(
              { job: String(job.id), stage: name, attempt },
              params as Parameters<Artifacts['grant']>[1],
            )
          } catch (error) {
            throw new LinkError((error as Error).message, 'failed')
          }
        },
        /** An archive's entitlements: capabilities they need are added, and the stage's profiles made again when any was. */
        'apple.entitlements': async (params, link): Promise<unknown> => {
          const { job, name, project } = this.authorize(params, link)
          const { stage, signing, service } = this.appleStage(
            job,
            name,
            project,
          )
          const entitlements = ((params as { entitlements?: unknown })
            .entitlements ?? {}) as Record<string, Record<string, unknown>>
          return await this.appleCall(async () => {
            let changed = false
            for (const [bundleId, values] of Object.entries(entitlements)) {
              if (!signing.bundleIds.includes(bundleId)) continue
              changed =
                (await service.profiles.syncCapabilities(
                  signing.team,
                  bundleId,
                  values,
                  [signing.platform],
                )) || changed
            }
            if (!changed) return { changed: false }
            const again = await this.options.apple!.signing(project, stage)
            this.appendLog(
              String(job.id),
              name,
              'Apple signing: capabilities added from the archive’s entitlements; profiles made again\n',
            )
            return { changed: true, profiles: again.profiles }
          })
        },
        /** `ctx.apple.testflight`: the build upload and Apple's pre-signed upload operations. */
        'apple.testflight.start': async (params, link): Promise<unknown> => {
          const { job, name, project } = this.authorize(params, link)
          const { signing, service } = this.appleStage(job, name, project)
          const input = params as {
            fileName?: unknown
            fileSize?: unknown
            version?: unknown
            buildNumber?: unknown
            options?: unknown
          }
          if (
            typeof input.fileName !== 'string' ||
            !Number.isSafeInteger(input.fileSize) ||
            typeof input.version !== 'string' ||
            typeof input.buildNumber !== 'string'
          )
            throw new LinkError(
              'A TestFlight upload needs the file, its size, version and build number',
              'failed',
            )
          return await this.appleCall(
            async () =>
              await service.testflight.start({
                job: String(job.id),
                stage: name,
                team: signing.team,
                bundleId: signing.app,
                platform: signing.platform,
                fileName: input.fileName as string,
                fileSize: input.fileSize as number,
                version: input.version as string,
                buildNumber: input.buildNumber as string,
                options: (input.options ?? {}) as Parameters<
                  AppleService['testflight']['start']
                >[0]['options'],
              }),
          )
        },
        'apple.testflight.complete': async (params, link): Promise<unknown> => {
          const { job } = this.authorize(params, link, false)
          const service = this.options.apple?.service
          if (service == null)
            throw new LinkError('Apple signing is unavailable', 'failed')
          return await this.appleCall(
            async () =>
              await service.testflight.complete(
                String((params as { id?: unknown }).id),
                String(job.id),
              ),
          )
        },
        'apple.testflight.status': async (params, link): Promise<unknown> => {
          const { job } = this.authorize(params, link, false)
          const service = this.options.apple?.service
          if (service == null)
            throw new LinkError('Apple signing is unavailable', 'failed')
          return await this.appleCall(
            async () =>
              await service.testflight.status(
                String((params as { id?: unknown }).id),
                String(job.id),
              ),
          )
        },
        /** `ctx.apple.notarize`: a notary submission and its single-submission upload credentials. */
        'apple.notary.start': async (params, link): Promise<unknown> => {
          const { job, name, project } = this.authorize(params, link)
          const { signing, service } = this.appleStage(job, name, project)
          const input = params as { name?: unknown; sha256?: unknown }
          return await this.appleCall(
            async () =>
              await service.notary.start({
                job: String(job.id),
                stage: name,
                team: signing.team,
                name: String(input.name ?? ''),
                sha256: String(input.sha256 ?? ''),
              }),
          )
        },
        'apple.notary.status': async (params, link): Promise<unknown> => {
          const { job } = this.authorize(params, link, false)
          const service = this.options.apple?.service
          if (service == null)
            throw new LinkError('Apple signing is unavailable', 'failed')
          return await this.appleCall(
            async () =>
              await service.notary.status(
                String((params as { id?: unknown }).id),
                String(job.id),
              ),
          )
        },
        /** `ctx.artifacts.fetch`: the matching run's artifact and a download grant, within the project. */
        'artifacts.query': (params, link): unknown => {
          const { project } = this.authorize(params, link)
          const artifacts = this.options.artifacts
          if (artifacts == null)
            throw new LinkError('Artifacts are unavailable', 'failed')
          try {
            return artifacts.query(
              project.id,
              (params as { query?: Record<string, unknown> }).query ?? {},
            )
          } catch (error) {
            throw new LinkError((error as Error).message, 'failed')
          }
        },
        /** `ctx.tests`: the stage's parsed results. */
        'artifacts.tests': (params, link): null => {
          const { job, name, attempt } = this.authorize(params, link)
          this.options.artifacts?.tests(
            { job: String(job.id), stage: name, attempt },
            (params as { summary?: unknown }).summary,
          )
          return null
        },
        'git.prepare': async (
          params,
          link,
        ): Promise<{ commit: string | undefined }> => {
          const { project } = this.authorize(params, link)
          const repository = this.allowedRepository(
            project,
            (params as { repository?: unknown }).repository,
          )
          const ref = (params as { ref?: unknown }).ref
          const commit = await this.options.mirrors.ensure(
            project.slug,
            repository,
            typeof ref === 'string' && /^[0-9a-f]{40}$/.test(ref)
              ? { commit: ref }
              : {
                  branch: typeof ref === 'string' ? ref : project.defaultBranch,
                },
          )
          return { commit }
        },
        'git.tag': async (params, link): Promise<null> => {
          const { project, job } = this.authorize(params, link)
          if (!project.tagPushes)
            throw new LinkError(
              'This project does not allow tag pushes',
              'not_allowed',
            )
          const { name, message } = params as {
            name?: unknown
            message?: unknown
          }
          await this.options.mirrors.pushTag(
            project.slug,
            project.repository,
            String(name),
            String(job.commit_sha),
            typeof message === 'string' ? message : undefined,
          )
          return null
        },
      },
      streams: {
        'git.upload-pack': async (stream, params, link): Promise<void> => {
          try {
            const { project } = this.authorize(params, link)
            const { service, protocol } = params as {
              service?: unknown
              protocol?: unknown
            }
            if (service !== 'git-upload-pack')
              throw new LinkError(
                'Only git-upload-pack is served',
                'not_allowed',
              )
            const repository = this.allowedRepository(
              project,
              (params as { repository?: unknown }).repository,
            )
            if (!existsSync(this.options.mirrors.dir(project.slug, repository)))
              await this.options.mirrors.ensure(project.slug, repository)
            this.relayProcess(
              this.options.mirrors.uploadPack(
                project.slug,
                repository,
                typeof protocol === 'string' ? protocol : undefined,
              ),
              stream,
            )
          } catch (error) {
            stream.abort((error as Error).message)
          }
        },
        'git.lfs': async (stream, params, link): Promise<void> => {
          try {
            const { project } = this.authorize(params, link)
            const { oid, size } = params as { oid?: unknown; size?: unknown }
            const repository = this.allowedRepository(
              project,
              (params as { repository?: unknown }).repository,
            )
            const body = await this.options.mirrors.lfsObject(
              repository,
              String(oid),
              Number(size),
            )
            for await (const chunk of body) await stream.write(chunk as Buffer)
            stream.end()
          } catch (error) {
            stream.abort((error as Error).message)
          }
        },
        'stash.put': async (stream, params, link): Promise<void> => {
          try {
            const { job, name } = this.authorize(params, link)
            await this.options.stashes.put(
              String(job.id),
              name,
              (params as { name?: unknown }).name,
              stream,
            )
            stream.end()
          } catch (error) {
            stream.abort((error as Error).message)
          }
        },
        'stash.get': async (stream, params, link): Promise<void> => {
          try {
            const { job } = this.authorize(params, link)
            const file = this.options.stashes.open(
              String(job.id),
              (params as { name?: unknown }).name,
            )
            if (file == null) throw new Error('No such stash in this run')
            for await (const chunk of file) await stream.write(chunk as Buffer)
            stream.end()
          } catch (error) {
            stream.abort((error as Error).message)
          }
        },
      },
    }
  }

  /** Whether the actor may see logs: developers and above. */
}

export { GraphError, ParamsError }
