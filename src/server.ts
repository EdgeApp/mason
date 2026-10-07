import express, { type ErrorRequestHandler } from 'express'
import { Accounts } from './auth/accounts.js'
import { Providers } from './auth/providers.js'
import { authRoutes, navigation, sessionContext } from './auth/routes.js'
import { page, stylesheet } from './view.js'
import type { Server } from 'node:http'
import { Store } from './store.js'

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
        "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
    res.type('css').send(stylesheet)
  })
  app.use(express.urlencoded({ extended: false, limit: '16kb' }))
  const accounts = new Accounts(store)
  app.use(authRoutes(store, providers, accounts))
  app.get('/', (req, res) => {
    const context = sessionContext(req, accounts)
    if (context == null) {
      res.redirect(303, '/auth/login')
      return
    }
    const { account, session } = context
    if (!account.is_admin && !account.is_tester) {
      res
        .status(403)
        .send(
          page(
            'Waiting for tester access',
            '<section class="card"><p>Your account is signed in. A Mason administrator needs to grant you tester access before you can view or download builds.</p></section>',
            navigation(session, account),
          ),
        )
      return
    }
    res.send(
      page(
        'Builds',
        '<p>Your account can access builds.</p>',
        navigation(session, account),
      ),
    )
  })
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
