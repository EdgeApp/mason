import express, { Router } from 'express'
import {
  actorOf,
  apiErrors,
  authenticate,
  Conflict,
  json,
  NotFound,
} from './api.js'
import { ProjectConflict, ProjectNotFound } from './projects.js'
import { allow, allowRole, covers } from './permissions.js'
import type { Master } from './runtime.js'

/** Maps project and job errors onto the API's status codes. */
const errors: express.ErrorRequestHandler = (error, req, res, next) => {
  if (error instanceof ProjectNotFound)
    return apiErrors(new NotFound(error.message), req, res, next)
  if (error instanceof ProjectConflict)
    return apiErrors(new Conflict(error.message), req, res, next)
  apiErrors(error, req, res, next)
}

/** `/api/v2/projects` and build-number seeding. */
export function projectsApi(master: Master): Router {
  const router = Router()
  const auth = authenticate(master)
  const body = express.json({ limit: '1mb' })
  router.use('/api/v2/projects', body, auth)
  router.get(
    '/api/v2/projects',
    json((_req, res) => {
      const actor = actorOf(res)
      allowRole(actor, 'projects.read')
      return master.projects
        .list()
        .filter((project) => covers(actor, { project: project.slug }))
    }),
  )
  router.get(
    '/api/v2/projects/:slug',
    json((req, res) => {
      const slug = String(req.params.slug)
      allowRole(actorOf(res), 'projects.read')
      allow(actorOf(res), 'projects.read', { project: slug })
      return master.projects.get(slug)
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
      const input = (req.body ?? {}) as {
        project?: unknown
        key?: unknown
        branch?: unknown
        last?: unknown
      }
      allowRole(actorOf(res), 'buildNumbers.seed')
      allow(actorOf(res), 'buildNumbers.seed', {
        project: String(input.project ?? ''),
      })
      return master.seed(
        String(input.project ?? ''),
        String(input.key ?? ''),
        { branch: input.branch, last: input.last },
        actorOf(res),
      )
    }),
  )
  router.use('/api/v2/build-numbers', errors)

  return router
}
