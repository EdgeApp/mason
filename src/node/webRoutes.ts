import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { FLOW_META, type SignInFlow } from '../shared/api/index.js'
import type { Permission, Role } from '../shared/permissions.js'
import { roleCan } from '../master/permissions.js'
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
  // A function, so `$'`, `$&` and the like in the flow are not patterns.
  res
    .type('html')
    .send(
      readFileSync(file, 'utf8').replace('</head>', () => `${meta}\n</head>`),
    )
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

/** What a page names, which the node checks before it answers 200. */
export type PageSubject =
  /** `/`: first-run setup, Projects & apps, or Install apps. */
  | 'home'
  /** Sign-in and invitations, open to everyone. */
  | 'signIn'
  | 'invite'
  /** A project, an app ID in it, a run, a group. */
  | 'project'
  | 'app'
  | 'run'
  | 'group'
  /** Install apps' pages and Devices. */
  | 'catalog'
  | 'devices'

/** One page address of the web app, and who may open it. */
export interface PageRoute {
  path: string | string[]
  /** What a signed-in viewer needs: without it the page answers 403. */
  permission?: Permission
  /** To a viewer without this permission the page does not exist: 404, not 403. */
  hiddenWithout?: Permission
  /** What the page names, which the node checks. */
  subject?: PageSubject
  /** Served by the master only; on a host the address is unknown. */
  masterOnly?: boolean
  /**
   * Served by a host only; on the master the address is unknown, so a
   * signed-out viewer goes to the master's own sign-in.
   */
  hostOnly?: boolean
}

/**
 * Every page of the web app on both nodes; the app's own table
 * (src/web/profile/routes.tsx) declares the same access for each, which
 * src/web/profile/pageAccess.test.ts checks. Each answers the app's shell
 * (`index.html`), with the status of what the app will show there: 403 for
 * a role without the page's permission, 404 for a page hidden from it or a
 * thing that does not exist, the node's own status for what it names.
 * Signed out, a page sends to sign in. Any other address answers the shell
 * with 404 (src/node/webRoutes.ts `pageFallback`).
 */
export const PAGE_ROUTES: readonly PageRoute[] = [
  { path: '/', subject: 'home' },
  { path: '/sign-in', subject: 'signIn', masterOnly: true },
  { path: '/auth/login', subject: 'signIn', hostOnly: true },
  { path: '/auth/invite', subject: 'invite' },
  {
    path: '/projects',
    permission: 'projects.read',
    hiddenWithout: 'projects.read',
  },
  {
    path: '/projects/new',
    permission: 'projects.change',
    hiddenWithout: 'projects.read',
    masterOnly: true,
  },
  {
    path: [
      '/projects/:slug',
      '/projects/:slug/runs',
      '/projects/:slug/masonfile',
    ],
    permission: 'projects.read',
    hiddenWithout: 'projects.read',
    subject: 'project',
  },
  {
    path: '/projects/:slug/secrets',
    permission: 'projects.read',
    hiddenWithout: 'projects.read',
    subject: 'project',
    masterOnly: true,
  },
  {
    path: [
      '/projects/:slug/apps/:appId',
      '/projects/:slug/apps/:appId/build-numbers',
    ],
    permission: 'projects.read',
    hiddenWithout: 'projects.read',
    subject: 'app',
  },
  { path: '/artifacts', permission: 'runs.read' },
  { path: '/runs/:id', permission: 'runs.read', subject: 'run' },
  // Search reads what GET /api/v2/search allows; Your account is every
  // signed-in viewer's own.
  { path: '/search', permission: 'builds.read' },
  { path: '/account' },
  { path: '/nodes', permission: 'nodes.read', masterOnly: true },
  {
    path: ['/cloud', '/settings', '/backups'],
    permission: 'settings.read',
    masterOnly: true,
  },
  { path: '/people', permission: 'people.read', masterOnly: true },
  { path: '/groups', permission: 'groups.read', masterOnly: true },
  {
    path: '/groups/:id',
    permission: 'groups.read',
    subject: 'group',
    masterOnly: true,
  },
  {
    path: ['/apps', '/apps/:appId', '/apps/:appId/branches/:branchKey'],
    permission: 'builds.read',
    subject: 'catalog',
  },
  { path: '/devices', permission: 'devices.register', subject: 'devices' },
]

/** What a page answers: the shell with a status, or a redirect. */
export type PageAnswer = number | { redirect: string }

/** What the page routes need of a node. */
export interface PageNode {
  node: 'master' | 'host'
  /** The signed-in viewer's role; undefined when signed out. */
  role(req: express.Request): Role | undefined
  /** Where a signed-out request is sent to sign in. */
  signIn(req: express.Request): string
  /**
   * What a page about `subject` answers. `home`, `signIn` and `invite` are
   * asked signed out too (`role` undefined); the others only once the
   * viewer holds the page's permission.
   */
  check(
    subject: PageSubject,
    req: express.Request,
    role: Role | undefined,
  ): PageAnswer | Promise<PageAnswer>
}

/** Subjects a signed-out viewer reaches: the node decides where they go. */
const open: ReadonlySet<PageSubject> = new Set(['home', 'signIn', 'invite'])

/** Answers a page: a redirect, or the shell with its status. */
function send(res: express.Response, answer: PageAnswer): void {
  if (typeof answer === 'number') sendShell(res, { status: answer })
  // A bare redirect: no body, so no page.
  else res.status(303).location(answer.redirect).end()
}

/**
 * The node's page addresses from {@link PAGE_ROUTES}, each answering the
 * web app's shell with the status of what it will show, or sending a
 * signed-out viewer to sign in.
 */
export function pageRoutes(node: PageNode): express.Router {
  const router = express.Router()
  for (const route of PAGE_ROUTES) {
    if (route.masterOnly === true && node.node !== 'master') continue
    if (route.hostOnly === true && node.node !== 'host') continue
    router.get(route.path, (req, res, next) => {
      const role = node.role(req)
      const answer = async (): Promise<PageAnswer> => {
        const subject = route.subject
        if (subject != null && open.has(subject))
          return await node.check(subject, req, role)
        if (role == null) return { redirect: node.signIn(req) }
        if (route.hiddenWithout != null && !roleCan(role, route.hiddenWithout))
          return 404
        if (route.permission != null && !roleCan(role, route.permission))
          return 403
        return subject == null ? 200 : await node.check(subject, req, role)
      }
      answer().then(
        (result) => {
          send(res, result)
        },
        (error: unknown) => {
          next(error)
        },
      )
    })
  }
  return router
}

/**
 * Every other GET address a browser opens answers the shell with 404 (or
 * sends a signed-out viewer to sign in); the API, assets and other
 * addresses (`/api/`, `/assets/`, any other method) answer a plain 404.
 */
export function pageFallback(node: PageNode): express.RequestHandler {
  return (req, res) => {
    if (
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      /^\/(api|assets)(\/|$)/.test(req.path)
    ) {
      res.status(404).send('Not found')
      return
    }
    send(res, node.role(req) == null ? { redirect: node.signIn(req) } : 404)
  }
}
