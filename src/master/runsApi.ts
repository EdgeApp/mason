import { existsSync, readFileSync } from 'node:fs'
import express, { Router } from 'express'
import { lineAt, plainLog } from '../view/log.js'
import { streamRunEvents, streamSnapshots } from './runEvents.js'
import { AUTOMATIC_POLL_MS } from '../builder/automatic.js'
import { branchName } from '../builder/config.js'
import { actorOf, apiErrors, authenticate, json, NotFound } from './api.js'
import { BranchRefused, IdempotencyConflict, QueueFull } from './jobs.js'
import { ProjectNotFound } from './projects.js'
import { allow, allowRole, covers, type Target } from './permissions.js'
import type { Master } from './runtime.js'
import { isGlob } from './rules.js'
import { GraphError, ParamsError, RunRefused } from './scheduler.js'

/** A job in the fields the builder's v1 job API returns, plus `stages`. */
export function v1Job(
  master: Master,
  id: string,
): Record<string, unknown> | undefined {
  const job = master.jobs.job(id)
  if (job == null) return undefined
  const row = master.database.db
    .prepare('SELECT description,reason FROM jobs WHERE id=?')
    .get(id)!
  return {
    id: job.id,
    app: job.app,
    branch: job.branch,
    status: job.status,
    created: job.created,
    ...(job.started == null ? {} : { started: job.started }),
    ...(job.finished == null ? {} : { finished: job.finished }),
    ...(job.commit_sha == null ? {} : { commit_sha: job.commit_sha }),
    ...(job.requested_commit == null
      ? {}
      : { requested_commit: job.requested_commit }),
    automatic: job.automatic,
    ...(job.exit_code == null ? {} : { exit_code: job.exit_code }),
    ...(job.result === undefined ? {} : { result: job.result }),
    cancel: job.cancel,
    quarantine: 0,
    ...(job.client_ip == null ? {} : { client_ip: job.client_ip }),
    project: job.project,
    workflow: job.workflow,
    number: job.number,
    ...(row.description == null
      ? {}
      : { description: String(row.description) }),
    ...(row.reason == null ? {} : { reason: String(row.reason) }),
    stages: master.scheduler.stageViews(id).map((stage) => ({
      name: stage.name,
      status: stage.display,
      ...(stage.workerName == null ? {} : { worker: stage.workerName }),
    })),
  }
}

/** A queue entry as the builder's `/api/queue` returns it, plus `stages`. */
function queueEntry(master: Master, id: string): Record<string, unknown> {
  const job = v1Job(master, id)!
  return {
    ...job,
    started: job.started ?? null,
    finished: job.finished ?? null,
    commit_sha: job.commit_sha ?? null,
    requested_commit: job.requested_commit ?? null,
    exit_code: job.exit_code ?? null,
    cleanup_error: null,
    quarantine_reason: null,
    client_ip: job.client_ip ?? null,
    client_name: null,
    trigger: job.automatic === 1 ? 'poll' : 'api',
  }
}

function buildSettings(master: Master, slug: string): Record<string, unknown> {
  const project = master.projects.get(slug)
  const automatic = project.rules
    .filter((rule) => rule.mode === 'automatic' && !isGlob(rule.pattern))
    .map((rule) => rule.pattern)
  const branches = master.database.db
    .prepare(
      'SELECT * FROM automatic_branches WHERE project_id=? ORDER BY branch',
    )
    .all(project.id)
    .map((row) => ({
      app: project.slug,
      branch: String(row.branch),
      enabled: automatic.includes(String(row.branch)),
      ...(row.last_successful_commit == null
        ? {}
        : { lastSuccessfulCommit: String(row.last_successful_commit) }),
      ...(row.last_attempted_commit == null
        ? {}
        : { lastAttemptedCommit: String(row.last_attempted_commit) }),
      ...(row.last_job_id == null
        ? {}
        : { lastJobId: String(row.last_job_id) }),
      ...(row.last_checked == null
        ? {}
        : { lastChecked: Number(row.last_checked) }),
      ...(row.observed_commit == null
        ? {}
        : { observedCommit: String(row.observed_commit) }),
      ...(row.poll_error == null ? {} : { pollError: String(row.poll_error) }),
      attempts: 0,
    }))
  return {
    defaultBranch: project.defaultBranch,
    automaticBranches: automatic,
    branches,
    pollIntervalMs: AUTOMATIC_POLL_MS,
  }
}

const refused = (error: unknown): boolean =>
  error instanceof BranchRefused ||
  error instanceof QueueFull ||
  error instanceof IdempotencyConflict ||
  error instanceof ParamsError ||
  error instanceof GraphError ||
  error instanceof RunRefused

const errors: express.ErrorRequestHandler = (error, req, res, next) => {
  if (refused(error))
    return void res.status(400).json({ error: (error as Error).message })
  if (error instanceof ProjectNotFound)
    return apiErrors(new NotFound(error.message), req, res, next)
  apiErrors(error, req, res, next)
}

/** The project and branch of a run, for a key's scopes. */
export function runTarget(master: Master, id: string): Target {
  const row = master.database.db
    .prepare(
      'SELECT p.slug,j.branch FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=?',
    )
    .get(id) as { slug: string; branch: string } | undefined
  if (row == null) throw new NotFound('Run not found')
  return { project: row.slug, branch: row.branch }
}

/** A run's log: the whole run's, one stage's, or one step's lines, numbered from where they start. */
export function runLog(
  master: Master,
  id: string,
  options: { stage?: string; step?: number } = {},
): { text: string; first: number } | undefined {
  if (master.jobs.job(id) == null) return undefined
  if (options.stage == null)
    return { text: master.scheduler.logs(id) ?? '', first: 1 }
  const file = master.scheduler.logFile(id, options.stage)
  const content = existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
  if (options.step == null) return { text: content.toString('utf8'), first: 1 }
  const step = master.database.db
    .prepare(
      'SELECT log_start,log_end FROM job_steps WHERE job_id=? AND stage=? AND id=? ORDER BY attempt DESC LIMIT 1',
    )
    .get(id, options.stage, options.step) as
    | { log_start: number | null; log_end: number | null }
    | undefined
  if (step == null) throw new NotFound('No such step')
  const start = Math.min(step.log_start ?? 0, content.length)
  const end = Math.min(step.log_end ?? content.length, content.length)
  return {
    text: content.subarray(start, end).toString('utf8'),
    first: lineAt(content, start),
  }
}

/** What a run's event stream compares: status, stages and the selected stage's steps. */
export function runSnapshot(
  master: Master,
  id: string,
  stage?: string,
): string | undefined {
  const db = master.database.db
  const job = db
    .prepare('SELECT status,finished FROM jobs WHERE id=?')
    .get(id) as { status: string; finished: number | null } | undefined
  if (job == null) return undefined
  return JSON.stringify({
    status: job.status,
    finished: job.finished != null,
    stages: db
      .prepare(
        "SELECT name,status,started,finished FROM job_stages WHERE job_id=? AND name NOT LIKE '@%' ORDER BY position",
      )
      .all(id),
    steps:
      stage == null
        ? []
        : db
            .prepare(
              'SELECT id,kind,title,status,ms FROM job_steps WHERE job_id=? AND stage=? AND attempt=(SELECT MAX(attempt) FROM job_steps WHERE job_id=? AND stage=?) ORDER BY id',
            )
            .all(id, stage, id, stage),
  })
}

/** The v1 job API on the master (paths and fields unchanged) and `/api/v2/runs`. */
export function runsApi(master: Master): Router {
  const router = Router()
  const auth = authenticate(master)
  router.use(
    ['/api/jobs', '/api/queue', '/api/apps', '/api/v2/runs', '/api/v2/queue'],
    express.json({ limit: '16kb', strict: true }),
    auth,
  )

  router.post(
    '/api/jobs',
    json((req, res) => {
      const job = master.jobs.request(
        actorOf(res),
        req.body,
        req.socket.remoteAddress?.replace(/^::ffff:/, ''),
      )
      master.scheduler.poke()
      master.database.audit(actorOf(res), 'run.request', job.id)
      res.status(202)
      return v1Job(master, job.id)
    }),
  )
  router.get(
    '/api/jobs/:id',
    json((req, res) => {
      const id = String(req.params.id)
      allowRole(actorOf(res), 'runs.read')
      allow(actorOf(res), 'runs.read', runTarget(master, id))
      const job = v1Job(master, id)
      if (job == null) throw new NotFound('Job not found')
      return job
    }),
  )
  router.get('/api/jobs/:id/log', (req, res, next) => {
    try {
      const id = String(req.params.id)
      allowRole(actorOf(res), 'runs.read')
      allow(actorOf(res), 'runs.read', runTarget(master, id))
      const text = master.scheduler.logs(id)
      if (text == null) throw new NotFound('Build log not found')
      res.type('text/plain').send(text)
    } catch (error) {
      next(error)
    }
  })
  router.get('/api/jobs/:id/logs', (req, res, next) => {
    try {
      const id = String(req.params.id)
      allowRole(actorOf(res), 'runs.read')
      allow(actorOf(res), 'runs.read', runTarget(master, id))
      const text = master.scheduler.logs(id)
      if (text == null) throw new NotFound('Build log not found')
      res.set('X-Mason-Log-Capture', 'full')
      res.attachment(`mason-build-${String(req.params.id)}.log`)
      res.type('text/plain').send(text)
    } catch (error) {
      next(error)
    }
  })
  router.post('/api/jobs/:id/cancel', (req, res, next) => {
    try {
      const id = String(req.params.id)
      allowRole(actorOf(res), 'runs.request')
      allow(actorOf(res), 'runs.request', runTarget(master, id))
      if (!master.scheduler.cancel(id)) {
        res.status(409).json({ error: 'Job is not active' })
        return
      }
      master.database.audit(actorOf(res), 'run.cancel', id)
      res.json({ cancelled: true })
    } catch (error) {
      next(error)
    }
  })
  router.get(
    '/api/queue',
    json((_req, res) => {
      const actor = actorOf(res)
      allowRole(actor, 'runs.read')
      return master.jobs
        .pending()
        .filter((job) => covers(actor, runTarget(master, job.id)))
        .map((job) => queueEntry(master, job.id))
    }),
  )
  router.get(
    '/api/apps',
    json((_req, res) => {
      const actor = actorOf(res)
      allowRole(actor, 'apps.read')
      return master.projects
        .list()
        .filter((project) => covers(actor, { project: project.slug }))
        .map((project) => ({
          slug: project.slug,
          name: project.name,
          enabled: project.enabled,
          platforms: [...new Set(project.apps.flatMap((app) => app.platforms))],
          ...buildSettings(master, project.slug),
        }))
    }),
  )
  router.get(
    '/api/apps/:slug/build-settings',
    json((req, res) => {
      allow(actorOf(res), 'apps.read', { project: String(req.params.slug) })
      return buildSettings(master, String(req.params.slug))
    }),
  )
  router.put(
    '/api/apps/:slug/build-settings',
    json((req, res) => {
      const actor = actorOf(res)
      const slug = String(req.params.slug)
      allowRole(actor, 'projects.change')
      allow(actor, 'projects.change', { project: slug })
      const body = (req.body ?? {}) as {
        defaultBranch?: unknown
        automaticBranches?: unknown
      }
      const project = master.projects.get(slug)
      const automatic = Array.isArray(body.automaticBranches)
        ? body.automaticBranches.map(branchName)
        : undefined
      if (automatic != null && automatic.length > 20)
        throw new BranchRefused('At most 20 automatic branches')
      if (body.defaultBranch != null)
        master.projects.save(actor, slug, {
          defaultBranch: branchName(body.defaultBranch),
        })
      if (automatic != null)
        master.projects.setRules(actor, slug, [
          ...automatic.map((pattern) => ({ pattern, mode: 'automatic' })),
          ...project.rules.filter(
            (rule) =>
              isGlob(rule.pattern) ||
              (rule.mode === 'request' && !automatic.includes(rule.pattern)),
          ),
        ])
      return buildSettings(master, slug)
    }),
  )

  router.get(
    '/api/v2/runs',
    json((req, res) => {
      const actor = actorOf(res)
      allowRole(actor, 'runs.read')
      return master.runs(req.query).filter((run) =>
        covers(actor, {
          project: (run as { project: string }).project,
          branch: (run as { branch: string }).branch,
        }),
      )
    }),
  )
  router.post(
    '/api/v2/runs',
    json(async (req, res) => {
      const actor = actorOf(res)
      allowRole(actor, 'runs.request')
      const body = (req.body ?? {}) as {
        project?: unknown
        app?: unknown
        branch?: unknown
        workflow?: unknown
        params?: unknown
        commit?: unknown
      }
      const project = master.projects.resolve(
        String(body.project ?? body.app ?? ''),
      )
      if (project == null) throw new RunRefused('Unknown project')
      const branch =
        body.branch == null ? project.defaultBranch : branchName(body.branch)
      allow(actor, 'runs.request', { project: project.slug, branch })
      const job = await master.scheduler.request(actor, {
        project: project.slug,
        branch,
        ...(typeof body.workflow === 'string'
          ? { workflow: body.workflow }
          : {}),
        ...(body.params === undefined ? {} : { params: body.params }),
        ...(typeof body.commit === 'string' ? { commit: body.commit } : {}),
      })
      master.database.audit(actor, 'run.request', job.id)
      res.status(202)
      return master.run(job.id)
    }),
  )
  router.get(
    '/api/v2/runs/:id',
    json((req, res) => {
      const id = String(req.params.id)
      allowRole(actorOf(res), 'runs.read')
      allow(actorOf(res), 'runs.read', runTarget(master, id))
      return master.run(id)
    }),
  )
  router.post(
    '/api/v2/runs/:id/cancel',
    json((req, res) => {
      const id = String(req.params.id)
      allowRole(actorOf(res), 'runs.request')
      allow(actorOf(res), 'runs.request', runTarget(master, id))
      const cancelled = master.scheduler.cancel(id)
      if (cancelled) master.database.audit(actorOf(res), 'run.cancel', id)
      return { cancelled }
    }),
  )
  router.post(
    '/api/v2/runs/:id/restart',
    json((req, res) => {
      const id = String(req.params.id)
      allowRole(actorOf(res), 'runs.request')
      allow(actorOf(res), 'runs.request', runTarget(master, id))
      const stage = (req.body as { stage?: unknown } | null)?.stage
      if (typeof stage !== 'string')
        throw new RunRefused('Name the stage to restart from')
      const job = master.scheduler.restart(
        actorOf(res),
        String(req.params.id),
        stage,
      )
      master.database.audit(actorOf(res), 'run.restart', job.id)
      res.status(201)
      return master.run(job.id)
    }),
  )
  router.post(
    '/api/v2/runs/:id/approve',
    json((req, res) => {
      const body = (req.body ?? {}) as {
        stage?: unknown
        approve?: unknown
        params?: unknown
      }
      const id = String(req.params.id)
      allowRole(actorOf(res), 'runs.approve')
      allow(actorOf(res), 'runs.approve', runTarget(master, id))
      if (typeof body.stage !== 'string')
        throw new RunRefused('Name the approval')
      master.scheduler.approve(
        actorOf(res),
        String(req.params.id),
        body.stage,
        {
          approve: body.approve !== false,
          ...(body.params === undefined ? {} : { params: body.params }),
        },
      )
      master.database.audit(actorOf(res), 'run.approve', `${id}/${body.stage}`)
      return master.run(id)
    }),
  )
  router.get('/api/v2/runs/:id/logs', (req, res, next) => {
    try {
      const id = String(req.params.id)
      allowRole(actorOf(res), 'runs.read')
      allow(actorOf(res), 'runs.read', runTarget(master, id))
      const text = runLog(master, id, {
        ...(typeof req.query.stage === 'string'
          ? { stage: req.query.stage }
          : {}),
        ...(typeof req.query.step === 'string'
          ? { step: Number(req.query.step) }
          : {}),
      })
      if (text == null) throw new NotFound('Run not found')
      const plain = req.query.plain === '1'
      res.set(
        'Content-Disposition',
        `attachment; filename="run-${id}${typeof req.query.stage === 'string' ? '-' + req.query.stage.replace(/[^A-Za-z0-9._-]/g, '_') : ''}${plain ? '' : '.ansi'}.log"`,
      )
      res.type('text/plain').send(plain ? plainLog(text.text) : text.text)
    } catch (error) {
      next(error)
    }
  })
  router.get('/api/v2/runs/:id/events', (req, res, next) => {
    try {
      const id = String(req.params.id)
      allowRole(actorOf(res), 'runs.read')
      allow(actorOf(res), 'runs.read', runTarget(master, id))
      streamRunEvents(
        req,
        res,
        {
          snapshot: (stage) => runSnapshot(master, id, stage),
          finished: () =>
            (
              master.database.db
                .prepare('SELECT finished FROM jobs WHERE id=?')
                .get(id) as { finished: number | null } | undefined
            )?.finished != null,
          logFile: (stage) => master.scheduler.logFile(id, stage),
        },
        { logs: true },
      )
    } catch (error) {
      next(error)
    }
  })
  router.get('/api/v2/queue/events', (req, res, next) => {
    try {
      allowRole(actorOf(res), 'runs.read')
      streamSnapshots(req, res, 'queue', () =>
        JSON.stringify(
          master.database.db
            .prepare(
              "SELECT s.job_id AS job,s.name AS stage,s.status FROM job_stages s WHERE s.status IN ('running','queued','awaiting_approval') AND s.name NOT LIKE '@%' ORDER BY s.job_id,s.position",
            )
            .all(),
        ),
      )
    } catch (error) {
      next(error)
    }
  })
  router.use(
    ['/api/jobs', '/api/queue', '/api/apps', '/api/v2/runs', '/api/v2/queue'],
    errors,
  )
  return router
}
