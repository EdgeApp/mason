import express, { Router, type ErrorRequestHandler } from 'express'
import type { Definition } from './config.js'
import type { BuilderStore } from './store.js'

/** A definition without secret values or injected file contents. */
export function publicDefinition(app: Definition): Record<string, unknown> {
  return {
    ...app,
    env: app.env.map(({ name, value, secret }) =>
      secret ? { name, secret } : { name, value, secret },
    ),
    files: app.files.map(({ destination, contents, env }) => ({
      destination,
      ...(env == null ? {} : { env }),
      bytes: Buffer.from(contents, 'base64').length,
    })),
  }
}

/**
 * App definitions over HTTP for builder keys created with `--role admin`.
 * Definitions may carry base64 files, so this parses larger bodies than the
 * job API and must run before its parser.
 */
export function builderAdminRoutes(store: BuilderStore): Router {
  const router = Router()
  router.use('/api/admin', (_req, res, next) => {
    if (!store.isAdmin(res.locals.key as string)) {
      res.status(403).json({ error: 'Builder admin key required' })
      return
    }
    next()
  })
  router.use('/api/admin', express.json({ limit: '1mb', strict: true }))
  router.get('/api/admin/apps', (_req, res) => {
    res.json(store.apps().map(publicDefinition))
  })
  router.get('/api/admin/apps/:slug', (req, res) => {
    const app = store.apps().find((app) => app.slug === req.params.slug)
    if (app == null) {
      res.status(404).json({ error: 'App not found' })
      return
    }
    res.json(publicDefinition(app))
  })
  router.put('/api/admin/apps/:slug', (req, res) => {
    try {
      const { created, app } = store.saveApp(req.params.slug, req.body)
      res.status(created ? 201 : 200).json(publicDefinition(app))
    } catch {
      res.status(400).json({ error: 'Invalid app definition' })
    }
  })
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ error: 'Invalid app definition' })
  }
  router.use('/api/admin', errors)
  return router
}
