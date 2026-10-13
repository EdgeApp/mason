import express, {
  Router,
  type ErrorRequestHandler,
  type Response,
} from 'express'
import { asOptional } from 'cleaners'
import type { Store } from '../store.js'
import { ApiKeys, asKeyId } from '../upload/keys.js'
import { integer, object, text } from '../validation.js'
import { AppAdmin, Conflict, NotFound } from './apps.js'

const asNewKey = object({
  name: text(120),
  apps: (value: unknown): unknown => value,
  expiresAt: asOptional(integer()),
})
function failure(res: Response, error: unknown): void {
  if (error instanceof NotFound) res.status(404).json({ error: error.message })
  else if (error instanceof Conflict)
    res.status(409).json({ error: error.message })
  else res.status(400).json({ error: 'Invalid admin request' })
}

/**
 * Admin keys manage apps, upload channels and upload keys, so adding an app
 * never needs database access. Upload keys and browser sessions are refused.
 */
export function adminRoutes(store: Store): Router {
  const router = Router(),
    keys = new ApiKeys(store),
    apps = new AppAdmin(store)
  let window = store.now(),
    count = 0
  router.use('/api/admin', (req, res, next) => {
    if (store.now() - window > 60000) {
      window = store.now()
      count = 0
    }
    if (++count > 120) {
      res.status(429).json({ error: 'Too many admin requests' })
      return
    }
    const header = req.headers.authorization ?? ''
    try {
      if (!header.startsWith('Bearer ')) throw new Error('Missing key')
      res.locals.adminKey = keys.authenticateAdmin(header.slice(7)).id
    } catch {
      res.status(401).json({ error: 'Admin API key required' })
      return
    }
    next()
  })
  router.use('/api/admin', express.json({ limit: '16kb', strict: true }))
  router.get('/api/admin/apps', (_req, res) => {
    res.json(apps.list())
  })
  router.post('/api/admin/apps', (req, res) => {
    try {
      res.status(201).json(apps.create(req.body))
    } catch (error) {
      failure(res, error)
    }
  })
  router.get('/api/admin/apps/:slug', (req, res) => {
    try {
      res.json(apps.get(req.params.slug))
    } catch (error) {
      failure(res, error)
    }
  })
  router.patch('/api/admin/apps/:slug', (req, res) => {
    try {
      res.json(apps.update(req.params.slug, req.body))
    } catch (error) {
      failure(res, error)
    }
  })
  router.post('/api/admin/apps/:slug/channels', (req, res) => {
    try {
      res.status(201).json(apps.addChannel(req.params.slug, req.body))
    } catch (error) {
      failure(res, error)
    }
  })
  router.patch('/api/admin/apps/:slug/channels/:platform', (req, res) => {
    try {
      res.json(
        apps.updateChannel(req.params.slug, req.params.platform, req.body),
      )
    } catch (error) {
      failure(res, error)
    }
  })
  router.get('/api/admin/keys', (_req, res) => {
    res.json(keys.list().map((key) => ({ ...key, apps: apps.slugs(key.apps) })))
  })
  // Upload keys only: a new admin key is minted on the server with the CLI.
  router.post('/api/admin/keys', (req, res) => {
    try {
      const input = asNewKey(req.body)
      const scopes = input.apps === 'all' ? 'all' : apps.ids(input.apps)
      res
        .status(201)
        .json(keys.create(input.name, scopes, input.expiresAt, 'upload'))
    } catch (error) {
      failure(res, error)
    }
  })
  router.post('/api/admin/keys/:id/revoke', (req, res) => {
    try {
      const id = asKeyId(req.params.id)
      if (
        store.db.prepare('SELECT id FROM api_keys WHERE id=?').get(id) == null
      )
        throw new NotFound('Key not found')
      keys.revoke(id)
      res.json({ revoked: true })
    } catch (error) {
      failure(res, error)
    }
  })
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ error: 'Invalid admin request' })
  }
  router.use('/api/admin', errors)
  return router
}
