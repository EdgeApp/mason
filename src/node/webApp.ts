import express from 'express'
import { assetRoutes } from './assets.js'
import { contentSecurityPolicy } from './csp.js'
import { webAppRoutes } from './webRoutes.js'

export { contentSecurityPolicy, masterContentSecurityPolicy } from './csp.js'

export interface WebAppContext {
  role: 'master' | 'host'
  testEndpoints: boolean
}

/**
 * Common headers, health check, fonts and logo, and the React app's files
 * (and its shell under `/_web`) for a node's web listener.
 */
export function nodeWebApp(context: WebAppContext): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': contentSecurityPolicy,
    })
    next()
  })
  app.get('/health', (_req, res) => {
    res.json({ status: 'ready', role: context.role })
  })
  app.use(assetRoutes())
  app.use(webAppRoutes())
  return app
}
