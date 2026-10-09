import express, { type Express } from 'express'
import { readFileSync } from 'node:fs'
import { BuilderStore, publicJob } from './store.js'
import { readLogPath, Worker } from './worker.js'
import { noSymlinks } from '../config.js'
import type { Server } from 'node:http'

export function builderApp(store: BuilderStore): Express {
  const app = express()
  app.disable('x-powered-by')
  let window = Date.now(),
    count = 0
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (Date.now() - window > 60000) {
      window = Date.now()
      count = 0
    }
    if (++count > 1200) {
      res.status(429).json({ error: 'Request limit exceeded' })
      return
    }
    const key = store.authenticate(
      (req.headers.authorization ?? '').replace(/^Bearer /, ''),
    )
    if (!req.headers.authorization?.startsWith('Bearer ') || key == null) {
      res.status(401).json({ error: 'Builder API key required' })
      return
    }
    res.locals.key = key
    next()
  })
  app.use(express.json({ limit: '8kb', strict: true }))
  app.post('/api/jobs', (req, res) => {
    try {
      res
        .status(202)
        .json(publicJob(store.enqueue(req.body, res.locals.key)))
    } catch {
      res.status(400).json({
        error: 'Invalid job, idempotency conflict, or queue full',
      })
    }
  })
  app.get('/api/jobs/:id', (req, res) => {
    const job = /^[a-f0-9-]{36}$/.test(req.params.id)
      ? store.job(req.params.id)
      : undefined
    if (job == null) {
      res.status(404).json({ error: 'Job not found' })
      return
    }
    res.json(publicJob(job))
  })
  app.get('/api/jobs/:id/log', (req, res) => {
    const file = /^[a-f0-9-]{36}$/.test(req.params.id)
      ? readLogPath(store, req.params.id)
      : undefined
    if (file == null) {
      res.status(404).end()
      return
    }
    noSymlinks(file)
    res.type('text/plain').send(readFileSync(file, 'utf8'))
  })
  app.post('/api/jobs/:id/cancel', (req, res) => {
    if (
      !/^[a-f0-9-]{36}$/.test(req.params.id) ||
      !store.cancel(req.params.id)
    ) {
      res.status(409).json({ error: 'Job is not active' })
      return
    }
    res.json({ cancelled: true })
  })
  app.get('/api/jobs/:id/logs', (req, res) => {
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) {
      res.status(404).json({ error: 'Build log not found' })
      return
    }
    const full = readLogPath(store, req.params.id, true)
    const file = full ?? readLogPath(store, req.params.id)
    if (file == null) {
      res.status(404).json({ error: 'Build log not found' })
      return
    }
    noSymlinks(file)
    res.set('X-Mason-Log-Capture', full == null ? 'legacy' : 'full')
    res.type('text/plain')
    res.download(
      file,
      `mason-build-${req.params.id}.log`,
      { cacheControl: false, lastModified: false },
      (error) => {
        if (error == null || res.headersSent) return
        if ((error as Error & { status?: number }).status === 416) {
          res.status(416).end()
        } else
          res.status(500).json({ error: 'Build log unavailable' })
      },
    )
  })
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({ error: 'Invalid request' })
    },
  )
  return app
}
export function serveBuilder(store: BuilderStore): {
  server: Server
  worker: Worker
  close: () => Promise<void>
} {
  const worker = new Worker(store)
  const server = builderApp(store).listen(
    store.config.port,
    store.config.listenHost,
  )
  const close = async (): Promise<void> => {
    server.close()
    await worker.close()
    store.close()
  }
  return { server, worker, close }
}
