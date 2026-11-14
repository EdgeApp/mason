import express, { type ErrorRequestHandler } from 'express'
import { existsSync } from 'node:fs'
import {
  authRoutes,
  cookieOptions,
  csrf,
  returnPath,
  SESSION_COOKIE,
  sessionContext,
  type AuthOptions,
  type PasswordRelay,
} from '../auth/routes.js'
import { LinkError, type Link } from '../link/link.js'
import type { Session } from '../auth/accounts.js'
import { forwardRoutes } from './forward.js'
import { deviceCallbackRoutes } from '../devices/routes.js'
import { nodeWebApp, type WebAppContext } from '../node/webApp.js'
import { storedDetails } from '../master/projectDetails.js'
import { isRole, type Role } from '../shared/permissions.js'
import type { Projected } from '../master/changes.js'
import type { HostRuntime } from './runtime.js'
import { hostLogin } from './sessions.js'
import { hostNodeInfo, hostSessionApi } from './sessionApi.js'
import { nodeInfoRoutes } from '../node/nodeInfo.js'
import { catalogApi, type CatalogApiCaller } from '../catalog/api.js'
import {
  catalogShellRoutes,
  catalogStatus,
  type CatalogShellOptions,
} from '../catalog/shell.js'
import { StoreCatalogSource } from '../catalog/source.js'
import { Devices } from '../devices/store.js'
import { Refused } from './builds.js'
import { readApi } from '../node/readApi.js'
import {
  pageFallback,
  pageRoutes,
  sendShell,
  type PageAnswer,
  type PageNode,
  type PageSubject,
} from '../node/webRoutes.js'
import { hostReader } from './reads.js'

/** The signed-in person's role on the host, from its cache. */
function hostRole(host: HostRuntime, req: express.Request): Role | undefined {
  const context = sessionContext(req, host.accounts)
  if (context == null) return undefined
  const row = host.cache.db
    .prepare('SELECT role FROM accounts WHERE id=?')
    .get(context.account.id) as { role: string } | undefined
  return isRole(row?.role) ? row.role : undefined
}

/**
 * The host's pages, from the web app's route table, read from the copy the
 * master sends: a project, app ID or run the host does not hold (or the
 * viewer may not see) answers its unknown state with 404; `/` is Install
 * apps for everyone here.
 */
function hostPageNode(
  host: HostRuntime,
  catalog: CatalogShellOptions,
): PageNode {
  /** Whether the enabled project at `:slug` is here, and the viewer sees its app ID `app`. */
  const projectKnown = (req: express.Request, app?: string): boolean => {
    const context = sessionContext(req, host.accounts)
    if (context == null) return false
    const db = host.cache.db
    const row = db
      .prepare('SELECT id,details FROM projects WHERE slug=? AND enabled=1')
      .get(String(req.params.slug)) as
      | { id: number; details: string | null }
      | undefined
    // As on the master, a project's pages need only the project (and its
    // reads only the role and scope); an app ID page needs that app ID,
    // enabled and visible.
    if (row == null || storedDetails(row.details) == null) return false
    if (app == null) return true
    const found = db
      .prepare(
        'SELECT a.id FROM apps a JOIN project_apps pa ON pa.app_id=a.id WHERE pa.project_id=? AND a.slug=? AND a.enabled=1',
      )
      .get(row.id, app) as { id: number } | undefined
    return (
      found != null && host.cache.store.visible(context.account.id, found.id)
    )
  }
  const signIn = (req: express.Request): string =>
    '/auth/login?return=' + encodeURIComponent(req.originalUrl)
  const check = (
    subject: PageSubject,
    req: express.Request,
    role: Role | undefined,
  ): PageAnswer | Promise<PageAnswer> => {
    switch (subject) {
      case 'home':
        return role == null
          ? { redirect: signIn(req) }
          : check('catalog', req, role)
      case 'signIn':
        // Where it goes back to must be a path on this node.
        returnPath(req.query.return)
        return 200
      case 'invite':
        // The web app reads the token from the fragment, then drops it.
        return 200
      case 'project':
        return projectKnown(req) ? 200 : 404
      case 'app':
        return projectKnown(req, String(req.params.appId)) ? 200 : 404
      case 'run':
        return host.cache.db
          .prepare('SELECT 1 FROM jobs WHERE id=?')
          .get(String(req.params.id)) == null
          ? 404
          : 200
      case 'catalog':
      case 'devices':
        return catalogStatus(catalog, subject, req)
      case 'group':
        return 404
    }
  }
  return {
    node: 'host',
    role: (req) => hostRole(host, req),
    signIn,
    check,
  }
}

/** E2E only: a browser that cannot be handed a cookie (Safari in a Simulator) opens the session a test.session control request started. */
function testSessionRoutes(host: HostRuntime): express.Router {
  const router = express.Router()
  router.get('/test/session/:token', (req, res) => {
    const token = String(req.params.token)
    if (host.accounts.session(token) == null) {
      res.status(404).send('Not found')
      return
    }
    res.cookie(SESSION_COOKIE, token, cookieOptions)
    res.redirect(303, '/')
  })
  return router
}

/** A mirrored Xcode, for a node holding the master's grant for that version. */
export function xcodeRoutes(
  host: Pick<HostRuntime, 'xcodeFile' | 'granted'>,
): express.Router {
  const router = express.Router()
  router.get('/xcode/:file', (req, res) => {
    const version = /^Xcode-(\d[\w.-]*)\.xip$/.exec(
      String(req.params.file),
    )?.[1]
    if (version == null || !host.granted(version, req.query.grant)) {
      res.status(403).send('Forbidden')
      return
    }
    const file = host.xcodeFile(version)
    if (!existsSync(file)) {
      res.status(404).send('Not found')
      return
    }
    res.type('application/octet-stream').sendFile(file, { dotfiles: 'allow' })
  })
  return router
}

/**
 * Username-or-email and password sign-in on the host: the master checks the hash the
 * browser made, with its lockouts, and answers only whose account it is; the
 * host then signs that cached account in, with its role's limits.
 */
/**
 * How the link names a person: `identifier`, and for a username also
 * `username`, which a master on the previous release reads.
 */
export function named(identifier: unknown): {
  identifier: unknown
  username?: unknown
} {
  return typeof identifier === 'string' && !identifier.includes('@')
    ? { identifier, username: identifier }
    : { identifier }
}

function hostPassword(host: HostRuntime): PasswordRelay {
  const link = (): Link => {
    const current = host.options.link()
    if (current == null || current.closed)
      throw new LinkError('The master is unreachable', 'closed')
    return current
  }
  return {
    parameters: async (identifier): Promise<unknown> =>
      await link().request('auth.parameters', named(identifier)),
    signIn: async (
      value,
      address,
      previousToken,
    ): Promise<{ token: string; session: Session }> => {
      const { accountId } = (await link().request('auth.password', {
        ...named(value.identifier),
        clientHash: value.clientHash,
        address,
      })) as { accountId: number }
      if (
        host.cache.db
          .prepare('SELECT 1 FROM accounts WHERE id=? AND disabled=0')
          .get(accountId) == null
      )
        throw new Error(
          'This account is not on the host yet; try again shortly',
        )
      return host.accounts.startSession(accountId, previousToken)
    },
  }
}

/**
 * Invitation links on the host: the master checks and uses the token and
 * sets the password; the host waits until its cache has the account at the
 * permission version the master answered, then signs it in.
 */
function hostInvitation(
  host: HostRuntime,
  waitMs = 10_000,
): NonNullable<AuthOptions['invitation']> {
  const link = (): Link => {
    const current = host.options.link()
    if (current == null || current.closed)
      throw new LinkError('The master is unreachable', 'closed')
    return current
  }
  return {
    lookup: async (token): Promise<unknown> =>
      await link().request('auth.invitation', { token }),
    accept: async (
      value,
      address,
      previousToken,
    ): Promise<{ token: string; session: Session }> => {
      const { accountId, permissionVersion } = (await link().request(
        'auth.accept',
        {
          token: value.token,
          username: value.username,
          clientHash: value.clientHash,
          clientParameters: value.clientParameters,
          address,
        },
      )) as { accountId: number; permissionVersion: number }
      const deadline = Date.now() + waitMs
      for (;;) {
        const row = host.cache.db
          .prepare(
            'SELECT permission_version FROM accounts WHERE id=? AND disabled=0',
          )
          .get(accountId) as { permission_version: number } | undefined
        if (row != null && row.permission_version >= permissionVersion) break
        if (Date.now() > deadline)
          throw new Error('Your password is set; sign in with it in a moment')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return host.accounts.startSession(accountId, previousToken)
    },
  }
}

/** The person signed in on the host, as Install apps and Devices answer for them. */
function hostCatalogCaller(
  host: HostRuntime,
  req: express.Request,
): CatalogApiCaller | undefined {
  const store = host.cache.store
  const context = sessionContext(req, host.accounts)
  if (context == null) return undefined
  return {
    accountId: context.account.id,
    source: new StoreCatalogSource(store, {
      session: context.session,
      relay: host.devices,
    }),
    checkCsrf: (request): void => {
      csrf(request, store, context.session)
    },
    mayRegister: new Devices(store, host.devices).allowed(context.account),
    registration: store.config.devices != null,
    installOrigin: store.config.origin,
  }
}

/** Install apps and Devices as JSON, from the host's cache, for its own signed-in people. */
function hostCatalogApi(host: HostRuntime): express.Router {
  return catalogApi({
    caller(req) {
      // Before the first sync and in maintenance there is nothing to serve.
      host.builds.ready()
      return hostCatalogCaller(host, req)
    },
    failure: (error) =>
      error instanceof Refused
        ? { status: error.status, error: error.message }
        : undefined,
    now: () => host.now(),
  })
}

/**
 * Install apps and Devices on the host, read from its cache; the QR code
 * and the grants' files are the host's own.
 */
function hostCatalogOptions(host: HostRuntime): CatalogShellOptions {
  return {
    caller: (req) => hostCatalogCaller(host, req),
    signIn: (req) =>
      '/auth/login?return=' + encodeURIComponent(req.originalUrl),
    files: () => new StoreCatalogSource(host.cache.store),
    qr: () => host.cache.store.config.origin + '/devices',
  }
}

/**
 * While the host waits for its master or is in maintenance: a page answers
 * the web app's shell with 503 (the app reads which from `/api/v2/node`),
 * anything else a plain 503.
 */
function unavailable(
  req: express.Request,
  res: express.Response,
  text: string,
): void {
  if (req.method === 'GET' && !/^\/(api|assets)(\/|$)/.test(req.path)) {
    sendShell(res, { status: 503 })
    return
  }
  res.status(503).type('text/plain').send(text)
}

const WAITING = 'This Mason host is waiting for its master.'

/** The host's public web listener: catalog, installs and sign-in from its cache. */
export function hostApp(
  context: WebAppContext & { host?: HostRuntime },
): express.Express {
  const app = nodeWebApp(context)
  const host = context.host
  // Before every gate: the web app reads it while the host waits or is in maintenance.
  app.use(nodeInfoRoutes(() => hostNodeInfo(host, context)))
  if (host == null) {
    app.use((req, res) => {
      unavailable(req, res, WAITING)
    })
    return app
  }
  // Webhooks are relayed or kept for the master even past the grace window, and
  // stages upload and fetch artifacts by their tokens and grants.
  app.use(host.webhooks.routes())
  app.use(host.artifacts.routes(host.accounts))
  // The web app's session is the host's own; it never reaches the forwarder.
  app.use(hostSessionApi(host, hostPassword(host)))
  // The builds API and the pages' reads are answered here, from the cache
  // and storage, so they keep working while the master is away; the rest of
  // /api/v2 is forwarded.
  app.use(host.builds.routes(host.accounts))
  app.use(readApi(hostReader(host, context)))
  app.use(hostCatalogApi(host))
  app.use(forwardRoutes(host))
  app.use((req, res, next) => {
    if (host.cache.host() == null) {
      unavailable(req, res, WAITING)
      return
    }
    if (host.maintenance()) {
      unavailable(
        req,
        res,
        'This Mason host has not reached its master for too long to serve builds safely. It comes back as soon as the master is reachable.',
      )
      return
    }
    next()
  })
  app.use(xcodeRoutes(host))
  if (context.testEndpoints) app.use(testSessionRoutes(host))
  // The Profile Service posts a signed body, read raw before any form parser.
  app.use(deviceCallbackRoutes(host.cache.store, host.devices))
  app.use(express.urlencoded({ extended: false, limit: '16kb' }))
  app.use(
    authRoutes(host.cache.store, () => host.providers(), host.accounts, {
      login: hostLogin(host.cache, host.accounts, async (identity) => {
        const current = host.options.link()
        if (current == null || current.closed)
          throw new LinkError('The master is unreachable', 'closed')
        return (await current.request('auth.admit', {
          provider: identity.provider,
          email: identity.email,
          name: identity.name,
        })) as { account: Projected }
      }),
      password: hostPassword(host),
      invitation: hostInvitation(host),
    }),
  )
  const catalog = hostCatalogOptions(host)
  // Install apps' and Devices' own addresses: the QR code, the completion
  // link and the grants' files; their pages are the web app's.
  app.use(catalogShellRoutes(catalog))
  const pages = hostPageNode(host, catalog)
  app.use(pageRoutes(pages))
  app.use(pageFallback(pages))
  // A failed request's reason is the web app's to show, with a way back to sign in.
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const message =
      error instanceof Error && error.name === 'SignInRefused'
        ? error.message
        : 'The request is invalid or has expired. Return to sign in and try again.'
    sendShell(res, { status: 400, flow: { state: 'invalid', message } })
  }
  app.use(errors)
  return app
}
