import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { asRequest, commitHash } from '../builder/config.js'
import type { MasterDatabase } from './database.js'
import { ruleFor } from './rules.js'
import type { Projects, Project } from './projects.js'
import { allow, allowRole } from './permissions.js'
import type { Actor } from './roles.js'

export const statuses = [
  'queued',
  'running',
  'succeeded',
  'unstable',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
] as const
export type JobStatus = (typeof statuses)[number]
export const active: JobStatus[] = ['queued', 'running']

/** A job in the shape the v1 job API has always returned. */
export interface JobView {
  id: string
  app: string
  project: string
  workflow: string
  number: number
  branch: string
  status: JobStatus
  trigger: string
  created: number
  started?: number
  finished?: number
  commit_sha?: string
  requested_commit?: string
  automatic: number
  exit_code?: number
  result?: unknown
  cancel: number
  quarantine: number
  client_ip?: string
  params: Record<string, unknown>
}

export class BranchRefused extends Error {}
export class QueueFull extends Error {
  constructor() {
    super('The queue is full')
  }
}
export class IdempotencyConflict extends Error {
  constructor() {
    super('That idempotency key was used for a different request')
  }
}

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

/** The master's jobs: one run of one workflow of a project at one commit. */
export class Jobs {
  constructor(
    readonly master: MasterDatabase,
    readonly projects: Projects,
  ) {}
  private get db(): MasterDatabase['db'] {
    return this.master.db
  }

  view(row: Record<string, unknown>): JobView {
    const project = this.db
      .prepare('SELECT slug FROM projects WHERE id=?')
      .get(Number(row.project_id))
    const request = JSON.parse(String(row.request)) as { app?: string }
    return {
      id: String(row.id),
      app: request.app ?? String(project?.slug),
      project: String(project?.slug),
      workflow: String(row.workflow),
      number: Number(row.number),
      branch: String(row.branch),
      status: row.status as JobStatus,
      trigger: String(row.trigger),
      created: Number(row.created),
      ...(row.started == null ? {} : { started: Number(row.started) }),
      ...(row.finished == null ? {} : { finished: Number(row.finished) }),
      ...(row.commit_sha == null ? {} : { commit_sha: String(row.commit_sha) }),
      ...(row.requested_commit == null
        ? {}
        : { requested_commit: String(row.requested_commit) }),
      automatic: row.trigger === 'push' ? 1 : 0,
      ...(row.exit_code == null ? {} : { exit_code: Number(row.exit_code) }),
      ...(row.result == null ? {} : { result: JSON.parse(String(row.result)) }),
      cancel: Number(row.cancel),
      quarantine: 0,
      ...(row.client_ip == null ? {} : { client_ip: String(row.client_ip) }),
      params: JSON.parse(String(row.params)) as Record<string, unknown>,
    }
  }
  job(id: string): JobView | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)
    return row == null ? undefined : this.view(row)
  }
  pending(): JobView[] {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created,id",
      )
      .all()
      .map((row) => this.view(row))
  }

  /**
   * `POST /api/jobs`: a requested build. `app` names a project or one of its
   * app IDs; the branch must match one of the project's rules and the key's
   * scopes.
   */
  request(actor: Actor, value: unknown, clientIp?: string): JobView {
    allowRole(actor, 'runs.request')
    let request = asRequest(value)
    const project = this.projects.resolve(request.app)
    if (project == null || !project.enabled)
      throw new BranchRefused('Unknown or disabled project')
    const branch = request.branch ?? project.defaultBranch
    request = asRequest({ ...request, branch })
    if (ruleFor(project.rules, branch) == null)
      throw new BranchRefused(
        `No branch rule of ${project.slug} allows ${branch}`,
      )
    allow(actor, 'runs.request', { project: project.slug, branch })
    const platforms = project.script.platforms
    if (
      request.platforms != null &&
      (request.platforms.length === 0 ||
        new Set(request.platforms).size !== request.platforms.length ||
        (platforms != null &&
          request.platforms.some((platform) => !platforms.includes(platform))))
    )
      throw new BranchRefused('Unsupported platforms')
    const injected = new Set(
      project.files.flatMap((file) => (file.env == null ? [] : [file.env])),
    )
    if (
      request.envVars.some((entry) =>
        Object.keys(entry).some((name) => injected.has(name)),
      )
    )
      throw new BranchRefused(
        'Cannot override an injected file environment variable',
      )
    const token =
      request.idempotencyKey == null
        ? null
        : hash(actor.label + ':' + request.idempotencyKey)
    return this.master.transaction(() => {
      if (token != null) {
        const old = this.db
          .prepare('SELECT * FROM jobs WHERE token=?')
          .get(token)
        if (old != null) {
          if (String(old.request) !== JSON.stringify(request))
            throw new IdempotencyConflict()
          return this.view(old)
        }
      }
      return this.insert(project, branch, 'request', JSON.stringify(request), {
        token,
        clientIp:
          clientIp != null && isIP(clientIp) !== 0 ? clientIp : undefined,
        actor,
      })
    })
  }

  /**
   * A job for a new commit on an automatic branch: one pending job per
   * project and branch, and at most three attempts per commit.
   */
  automatic(
    project: Project,
    branch: string,
    commit: string,
  ): JobView | undefined {
    commitHash(commit)
    return this.master.transaction(() => {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM jobs WHERE project_id=? AND branch=? AND status IN ('queued','running')",
          )
          .get(project.id, branch) != null
      ) {
        // The branch is busy: remember the commit for when its run ends.
        this.db
          .prepare(
            'INSERT INTO automatic_branches(project_id,branch,observed_commit) VALUES(?,?,?) ON CONFLICT(project_id,branch) DO UPDATE SET observed_commit=excluded.observed_commit',
          )
          .run(project.id, branch, commit)
        return undefined
      }
      const attempt = this.db
        .prepare(
          'SELECT attempts,succeeded FROM automatic_attempts WHERE project_id=? AND branch=? AND commit_sha=?',
        )
        .get(project.id, branch, commit)
      if (
        attempt != null &&
        (attempt.succeeded === 1 || Number(attempt.attempts) >= 3)
      )
        return undefined
      const job = this.insert(
        project,
        branch,
        'push',
        JSON.stringify(asRequest({ app: project.slug, branch })),
        {
          commit,
        },
      )
      this.db
        .prepare(
          'INSERT INTO automatic_attempts(project_id,branch,commit_sha,attempts) VALUES(?,?,?,1) ON CONFLICT(project_id,branch,commit_sha) DO UPDATE SET attempts=attempts+1',
        )
        .run(project.id, branch, commit)
      this.db
        .prepare(
          'INSERT INTO automatic_branches(project_id,branch,last_attempted_commit,last_job_id) VALUES(?,?,?,?) ON CONFLICT(project_id,branch) DO UPDATE SET last_attempted_commit=excluded.last_attempted_commit,last_job_id=excluded.last_job_id',
        )
        .run(project.id, branch, commit, job.id)
      return job
    })
  }

  /**
   * When a branch's run ends: the newest commit a push or poll saw while it
   * was busy, if the branch is still automatic and has not tried that commit.
   */
  pushedSince(project: Project, branch: string): JobView | undefined {
    const row = this.db
      .prepare(
        'SELECT observed_commit,last_attempted_commit FROM automatic_branches WHERE project_id=? AND branch=?',
      )
      .get(project.id, branch)
    if (
      row?.observed_commit == null ||
      row.observed_commit === row.last_attempted_commit ||
      ruleFor(project.rules, branch)?.mode !== 'automatic'
    )
      return undefined
    return this.automatic(project, branch, String(row.observed_commit))
  }

  /** Records a successful automatic build so its commit is not built again. */
  succeeded(id: string): void {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)
    if (row == null || row.trigger !== 'push' || row.requested_commit == null)
      return
    this.db
      .prepare(
        'UPDATE automatic_attempts SET succeeded=1 WHERE project_id=? AND branch=? AND commit_sha=?',
      )
      .run(
        Number(row.project_id),
        String(row.branch),
        String(row.requested_commit),
      )
    this.db
      .prepare(
        'UPDATE automatic_branches SET last_successful_commit=? WHERE project_id=? AND branch=?',
      )
      .run(
        String(row.requested_commit),
        Number(row.project_id),
        String(row.branch),
      )
  }

  /** A job of any workflow and trigger; the scheduler resolves its commit and graph. */
  create(
    project: Project,
    branch: string,
    trigger:
      | 'push'
      | 'request'
      | 'schedule'
      | 'after'
      | 'deviceRegistered'
      | 'restart',
    options: {
      workflow?: string
      commit?: string
      params?: Record<string, unknown>
      actor?: Actor
      restartOf?: string
      restartFrom?: string
      graphKey?: string
    } = {},
  ): JobView {
    return this.master.transaction(() =>
      this.insert(
        project,
        branch,
        trigger,
        JSON.stringify(asRequest({ app: project.slug, branch })),
        {
          ...(options.commit == null ? {} : { commit: options.commit }),
          ...(options.actor == null ? {} : { actor: options.actor }),
          workflow: options.workflow ?? 'build',
          params: options.params ?? {},
          ...(options.restartOf == null
            ? {}
            : { restartOf: options.restartOf }),
          ...(options.restartFrom == null
            ? {}
            : { restartFrom: options.restartFrom }),
          ...(options.graphKey == null ? {} : { graphKey: options.graphKey }),
        },
      ),
    )
  }

  private insert(
    project: Project,
    branch: string,
    trigger: string,
    request: string,
    options: {
      token?: string | null
      clientIp?: string | undefined
      actor?: Actor
      commit?: string
      workflow?: string
      params?: Record<string, unknown>
      restartOf?: string
      restartFrom?: string
      graphKey?: string
    },
  ): JobView {
    const count = Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running')",
          )
          .get() as { n: number }
      ).n,
    )
    if (count >= 100) throw new QueueFull()
    const workflow = options.workflow ?? 'build'
    const number =
      Number(
        (
          this.db
            .prepare(
              'SELECT COALESCE(MAX(number),0) n FROM jobs WHERE project_id=? AND workflow=?',
            )
            .get(project.id, workflow) as {
            n: number
          }
        ).n,
      ) + 1
    const id = randomUUID()
    this.db
      .prepare(
        "INSERT INTO jobs(id,project_id,workflow,number,branch,requested_commit,trigger,status,created,request,token,client_ip,key_id,actor,params,restart_of,restart_from,graph_key) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        project.id,
        workflow,
        number,
        branch,
        options.commit ?? null,
        trigger,
        this.master.now(),
        request,
        options.token ?? null,
        options.clientIp ?? null,
        options.actor?.keyId ?? null,
        options.actor?.label ?? (trigger === 'push' ? 'poller' : trigger),
        JSON.stringify(options.params ?? {}),
        options.restartOf ?? null,
        options.restartFrom ?? null,
        options.graphKey ?? null,
      )
    this.master.change('job', id)
    return this.job(id)!
  }
}
