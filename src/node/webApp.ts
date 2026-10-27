import express from 'express'
import { escape } from '../view/html.js'
import { page } from '../view/shell.js'
import { assetRoutes } from '../view/assets.js'
import { stylesheet } from '../view/stylesheet.js'

export const contentSecurityPolicy =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
/**
 * The master's sign-in, first-run and password pages, and the password
 * worker, compile the Argon2id WebAssembly; no other page may.
 */
export const masterContentSecurityPolicy = contentSecurityPolicy.replace(
  "script-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'",
)

export interface WebAppContext {
  role: 'master' | 'host'
  testEndpoints: boolean
  /** The stylesheet; the base one by default. */
  styles?: string
}

/** The banner every page shows while test endpoints are enabled. */
export function testBanner(context: WebAppContext): string {
  return context.testEndpoints
    ? '<p class="notice" role="status">Test endpoints are enabled on this Mason node.</p>'
    : ''
}

/** Common headers, health check and stylesheet for a node's web listener. */
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
  app.get('/assets/style.css', (_req, res) => {
    res.type('css').send(context.styles ?? stylesheet)
  })
  app.use(assetRoutes())
  return app
}

/** Sends a page with the test-endpoints banner when it applies. */
export function sendPage(
  res: express.Response,
  context: WebAppContext,
  title: string,
  content: string,
  status = 200,
): void {
  res.status(status).send(page(title, testBanner(context) + content))
}
export { escape }
