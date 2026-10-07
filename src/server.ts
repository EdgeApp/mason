import express from 'express'
import type { Server } from 'node:http'
import { Store } from './store.js'

export function createApp(store: Store): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    })
    next()
  })
  app.get('/health', (_req, res) => {
    try {
      store.db.prepare('SELECT 1').get()
      res.json({ status: 'ready' })
    } catch {
      res.status(503).json({ status: 'unavailable' })
    }
  })
  app.use((_req, res) => {
    res.status(404).send('Not found')
  })
  return app
}
export function serve(store: Store, intervalMs = 3600000): Server {
  store.prune()
  const server = createApp(store).listen(
    store.config.port,
    store.config.listenHost,
  )
  const timer = setInterval(() => {
    try {
      store.prune()
    } catch {
      console.error('Mason retention check failed')
    }
  }, intervalMs)
  timer.unref()
  server.on('close', () => {
    clearInterval(timer)
    store.close()
  })
  server.on('error', () => {
    clearInterval(timer)
    store.close()
  })
  return server
}
