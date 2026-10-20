import express, { Router } from 'express'
import {
  actorOf,
  apiErrors,
  authenticate,
  Conflict,
  json,
  NotFound,
} from './api.js'
import { BranchRefused, IdempotencyConflict, QueueFull } from './jobs.js'
import { ProjectConflict, ProjectNotFound } from './projects.js'
import { requireRole } from './roles.js'
import type { Master } from './runtime.js'

/** Maps project and job errors onto the API's status codes. */
const errors: express.ErrorRequestHandler = (error, req, res, next) => {
  if (error instanceof ProjectNotFound)
    return apiErrors(new NotFound(error.message), req, res, next)
  if (error instanceof ProjectConflict)
    return apiErrors(new Conflict(error.message), req, res, next)
  apiErrors(error, req, res, next)
}

/** `/api/v2/projects`, the v1 job API and build-number seeding. */
export function projectsApi(master: Master): Router {
  const router = Router()
  const auth = authenticate(master.keys)
  const body = express.json({ limit: '1mb' })
  router.use('/api/v2/projects', body, auth)
  router.get(
    '/api/v2/projects',
    json((_req, res) => {
      requireRole(actorOf(res), 'developer')
      return master.projects.list()
    }),
  )
  router.get(
    '/api/v2/projects/:slug',
    json((req, res) => {
      requireRole(actorOf(res), 'developer')
      return master.projects.get(String(req.params.slug))
    }),
  )
  router.put(
    '/api/v2/projects/:slug',
    json((req, res) => {
      const out = master.projects.save(
        actorOf(res),
        String(req.params.slug),
        req.body,
      )
      res.status(out.created ? 201 : 200)
      return out.project
    }),
  )
  router.delete(
    '/api/v2/projects/:slug',
    json((req, res) => {
      master.projects.remove(actorOf(res), String(req.params.slug))
      return null
    }),
  )
  router.post(
    '/api/v2/projects/:slug/apps',
    json((req, res) => {
      res.status(201)
      return master.projects.addApp(
        actorOf(res),
        String(req.params.slug),
        req.body,
      )
    }),
  )
  router.delete(
    '/api/v2/projects/:slug/apps/:bundleId',
    json((req, res) => {
      master.projects.removeApp(
        actorOf(res),
        String(req.params.slug),
        String(req.params.bundleId),
      )
      return null
    }),
  )
  router.put(
    '/api/v2/projects/:slug/secrets',
    json((req, res) =>
      master.projects.setSecrets(
        actorOf(res),
        String(req.params.slug),
        req.body,
      ),
    ),
  )
  router.put(
    '/api/v2/projects/:slug/rules',
    json((req, res) =>
      master.projects.setRules(actorOf(res), String(req.params.slug), req.body),
    ),
  )
  router.use('/api/v2/projects', errors)

  router.post(
    '/api/v2/build-numbers/seed',
    body,
    auth,
    json((req, res) => {
      requireRole(actorOf(res), 'admin')
      const input = (req.body ?? {}) as {
        project?: unknown
        key?: unknown
        entries?: unknown
      }
      return master.seed(
        String(input.project ?? ''),
        String(input.key ?? ''),
        input.entries,
      )
    }),
  )
  router.use('/api/v2/build-numbers', errors)

  // The v1 job API keeps its paths and fields for existing clients.
  router.use(
    ['/api/jobs', '/api/queue'],
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
      res.status(202)
      return job
    }),
  )
  router.get(
    '/api/jobs/:id',
    json((req, res) => {
      requireRole(actorOf(res), 'developer')
      const job = master.jobs.job(String(req.params.id))
      if (job == null) throw new NotFound('Job not found')
      return job
    }),
  )
  router.get(
    '/api/queue',
    json((_req, res) => {
      requireRole(actorOf(res), 'developer')
      return master.jobs.pending()
    }),
  )
  router.use(['/api/jobs', '/api/queue'], ((error, req, res, next) => {
    if (
      error instanceof BranchRefused ||
      error instanceof QueueFull ||
      error instanceof IdempotencyConflict
    )
      return void res.status(400).json({ error: error.message })
    errors(error, req, res, next)
  }) as express.ErrorRequestHandler)
  return router
}
