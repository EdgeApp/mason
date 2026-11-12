import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { FLOW_META, type SignInFlow } from '../shared/api/index.js'
import {
  masterContentSecurityPolicy,
  shellContentSecurityPolicy,
} from './csp.js'

/**
 * Where scripts/bundle-web.mjs writes the web app: `lib/web/bundles` in a
 * checkout and a release, whether this module runs from `lib/` or `src/`.
 */
export const webBundlesDir = fileURLToPath(
  new URL('../../lib/web/bundles/', import.meta.url),
)

/** The URL prefix the bundle's files are served under; index.html names them so. */
export const WEB_ASSETS = '/assets/web'

const types: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

/** esbuild's `[name]-[hash]` file names, which never change content. */
const hashed = /-[A-Z0-9]{8}\.(js|css)$/

export interface ShellOptions {
  /** The bundle's directory; the built one by default. */
  dir?: string
  status?: number
  /** A provider sign-in's state, for the app to draw at this address. */
  flow?: SignInFlow
}

/** An attribute value's text, escaped for HTML. */
const attribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

/**
 * Answers the app's `index.html`, never cached, under the shell's policy:
 * the base one with `worker-src 'self'`, so the password worker (served
 * with its own policy) may compile WebAssembly and the page may not. A
 * provider sign-in's state goes in a `<meta>` the app reads.
 */
export function sendShell(
  res: express.Response,
  options: ShellOptions = {},
): void {
  const file = path.join(options.dir ?? webBundlesDir, 'index.html')
  if (!existsSync(file)) {
    res.status(503).send('The web app is not built (npm run build).')
    return
  }
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': shellContentSecurityPolicy,
  })
  res.status(options.status ?? 200)
  if (options.flow == null) {
    res.type('html').sendFile(file, { dotfiles: 'allow' })
    return
  }
  const meta = `<meta name="${FLOW_META}" content="${attribute(JSON.stringify(options.flow))}">`
  res
    .type('html')
    .send(readFileSync(file, 'utf8').replace('</head>', `${meta}\n</head>`))
}

/**
 * Serves the React app on both nodes: the bundle's files under
 * `/assets/web/` (hashed ones cached for a year, `theme-boot.js`
 * revalidated), and `index.html` with `no-store` under the shell's policy for
 * `/_web` and every path below it. The password worker alone may compile
 * WebAssembly.
 */
export function webAppRoutes(options: { dir?: string } = {}): express.Router {
  const dir = options.dir ?? webBundlesDir
  const router = express.Router()
  router.get(`${WEB_ASSETS}/:file`, (req, res) => {
    const name = String(req.params.file)
    const type = types[path.extname(name)]
    const file = path.join(dir, name)
    if (
      type == null ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
      !existsSync(file)
    ) {
      res.status(404).send('Not found')
      return
    }
    res.set(
      'Cache-Control',
      hashed.test(name) ? 'public, max-age=31536000, immutable' : 'no-cache',
    )
    if (name.startsWith('password-worker-'))
      res.set('Content-Security-Policy', masterContentSecurityPolicy)
    res.type(type).sendFile(file, { dotfiles: 'allow' })
  })
  router.get(['/_web', '/_web/{*path}'], (_req, res) => {
    sendShell(res, { dir })
  })
  return router
}
