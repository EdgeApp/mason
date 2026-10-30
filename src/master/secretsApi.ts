import express, { Router, type Request } from 'express'
import {
  actorOf,
  apiErrors,
  authenticate,
  Conflict,
  json,
  NotFound,
} from './api.js'
import { clientAddress, FORWARDED_FOR } from './forward.js'
import type { Master } from './runtime.js'
import {
  BackupRefused,
  NotApplied,
  SecretNotFound,
  SecretsNeedBackups,
  type SecretsCaller,
} from './secrets.js'

/**
 * Where a request came from, for the audit. A request a host forwarded
 * arrives on the master's API socket with no address of its own; the host's
 * header is believed only there, so a direct client cannot forge it.
 */
export function requestAddress(
  req: Request,
  forwarded: (req: Request) => boolean,
): string {
  if (forwarded(req)) {
    const client = req.get(FORWARDED_FOR)
    return client == null || client === '' ? 'via host' : `${client} via host`
  }
  return clientAddress(req)
}

/** Maps secret errors onto the API's status codes. */
const errors: express.ErrorRequestHandler = (error, req, res, next) => {
  if (error instanceof SecretNotFound)
    return apiErrors(new NotFound(error.message), req, res, next)
  if (error instanceof SecretsNeedBackups)
    return apiErrors(new Conflict(error.message), req, res, next)
  if (error instanceof BackupRefused) {
    res.status(502).json({ error: error.message })
    return
  }
  if (error instanceof NotApplied) {
    res.status(500).json({ error: error.message })
    return
  }
  apiErrors(error, req, res, next)
}

/**
 * `/api/v2/projects/:slug/secrets`: a project's secret variants and their
 * audit. Mounted ahead of the other project routes so its own body limit
 * (a 5 MiB file in base64) applies before their smaller ones.
 */
export function secretsApi(master: Master): Router {
  const router = Router()
  router.use(
    '/api/v2/projects/:slug/secrets',
    express.json({ limit: '8mb', strict: true }),
    authenticate(master),
  )
  const caller = (req: Request, res: express.Response): SecretsCaller => ({
    actor: actorOf(res),
    address: requestAddress(req, (request) =>
      master.forwarder.forwarded(request),
    ),
  })
  const slug = (req: Request): string => String(req.params.slug)
  router.get(
    '/api/v2/projects/:slug/secrets',
    json((req, res) => master.secrets.list(caller(req, res), slug(req))),
  )
  router.get(
    '/api/v2/projects/:slug/secrets/audit',
    json((req, res) =>
      master.secrets.audit(
        caller(req, res),
        slug(req),
        req.query.limit == null ? undefined : Number(req.query.limit),
      ),
    ),
  )
  router.get(
    '/api/v2/projects/:slug/secrets/:id',
    json((req, res) =>
      master.secrets.contents(caller(req, res), slug(req), req.params.id),
    ),
  )
  router.post(
    '/api/v2/projects/:slug/secrets',
    json(async (req, res) => {
      const out = await master.secrets.add(
        caller(req, res),
        slug(req),
        req.body,
      )
      res.status(201)
      return out
    }),
  )
  router.put(
    '/api/v2/projects/:slug/secrets/:id',
    json(
      async (req, res) =>
        await master.secrets.edit(
          caller(req, res),
          slug(req),
          req.params.id,
          req.body,
        ),
    ),
  )
  router.put(
    '/api/v2/projects/:slug/secrets/:id/file',
    json(
      async (req, res) =>
        await master.secrets.replace(
          caller(req, res),
          slug(req),
          req.params.id,
          req.body,
        ),
    ),
  )
  router.put(
    '/api/v2/projects/:slug/secrets/:id/configs',
    json(
      async (req, res) =>
        await master.secrets.setConfigs(
          caller(req, res),
          slug(req),
          req.params.id,
          req.body,
        ),
    ),
  )
  router.delete(
    '/api/v2/projects/:slug/secrets/:id',
    json(
      async (req, res) =>
        await master.secrets.remove(caller(req, res), slug(req), req.params.id),
    ),
  )
  router.use('/api/v2/projects/:slug/secrets', errors)
  return router
}
