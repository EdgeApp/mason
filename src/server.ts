import {
  deviceCallbackRoutes,
  deviceRoutes,
  deviceWorkerRoutes,
} from './devices/routes.js'
import express, { type ErrorRequestHandler } from 'express'
import { Accounts } from './auth/accounts.js'
import { Providers } from './auth/providers.js'
import { authRoutes } from './auth/routes.js'
import { readFileSync } from 'node:fs'
import { catalogRoutes } from './catalog/routes.js'
import { installationRoutes } from './catalog/install.js'
import { page, stylesheet, catalogStyles } from './view.js'
import type { Server } from 'node:http'
import { Store } from './store.js'
import { uploadRoutes } from './upload/routes.js'

export function createApp(
  store: Store,
  providers = new Providers(store.config.origin, store.config.providers),
): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
  app.get('/assets/style.css', (_req, res) => {
    res.type('css').send(stylesheet + catalogStyles)
  })
  app.get('/assets/catalog.js', (_req, res) => {
    res
      .type('js')
      .send(
        readFileSync(
          new URL('../lib/browser/client.js', import.meta.url),
          'utf8',
        ),
      )
  })
  app.use(deviceCallbackRoutes(store))
  app.use(deviceWorkerRoutes(store))
  app.use(uploadRoutes(store))
  app.use(express.urlencoded({ extended: false, limit: '16kb' }))
  const accounts = new Accounts(store)
  app.use(authRoutes(store, providers, accounts))
  app.use(deviceRoutes(store, accounts))
  app.use(installationRoutes(store, accounts))
  app.use(catalogRoutes(store, accounts))
  app.use((_req, res) => {
    res.status(404).send('Not found')
  })
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => {
    res
      .status(400)
      .send(
        page(
          'Request could not be completed',
          '<p>The request is invalid or has expired. Return to sign in and try again.</p><a href="/auth/login">Sign in</a>',
        ),
      )
  }
  app.use(errors)
  return app
}
export function serve(store: Store, intervalMs = 3600000): Server {
  store.prune()
  new Accounts(store).prune()
  const server = createApp(store).listen(
    store.config.port,
    store.config.listenHost,
  )
  // Node's default five-minute request deadline is too short for large packages.
  server.requestTimeout = 90 * 60000
  server.headersTimeout = 60000
  const timer = setInterval(() => {
    try {
      store.prune()
      new Accounts(store).prune()
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
