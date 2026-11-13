import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import { existsSync, readFileSync } from 'node:fs'
import {
  authRoutes,
  cookieOptions,
  csrf,
  SESSION_COOKIE,
  sessionContext,
  type AuthOptions,
  type Frame,
  type PasswordRelay,
} from '../auth/routes.js'
import { LinkError, type Link } from '../link/link.js'
import type { Session } from '../auth/accounts.js'
import { forwardRoutes } from './forward.js'
import { deviceCallbackRoutes } from '../devices/routes.js'
import {
  catalogRoutes,
  deviceRoutes,
  installationRoutes,
} from '../catalog/routes.js'
import {
  masterContentSecurityPolicy,
  nodeWebApp,
  sendPage,
  testBanner,
  type WebAppContext,
} from '../node/webApp.js'
import { accountView } from '../view/admin.js'
import { storedDetails } from '../master/projectDetails.js'
import {
  approvalNotifications,
  approvalRolesFromGraph,
  notificationsFor,
} from '../view/notifications.js'
import { search } from '../view/search.js'
import { page, shell, type FramedPage, type Viewer } from '../view/shell.js'
import { escape } from '../view/html.js'
import { stylesheet } from '../view/stylesheet.js'
import type { Projected } from '../master/changes.js'
import type { HostRuntime } from './runtime.js'
import { hostLogin } from './sessions.js'
import { hostNodeInfo, hostSessionApi } from './sessionApi.js'
import { nodeInfoRoutes } from '../node/nodeInfo.js'
import { catalogApi } from '../catalog/api.js'
import { StoreCatalogSource } from '../catalog/source.js'
import { Devices } from '../devices/store.js'
import { Refused } from './builds.js'
import { readApi } from '../node/readApi.js'
import { sendShell } from '../node/webRoutes.js'
import { hostAccount, hostReader, OFFLINE_TEXT } from './reads.js'

const OFFLINE_BANNER = `<p class="notice" role="status">${OFFLINE_TEXT}</p>`

/** Every HTML page carries the banner while the master is unreachable. */
function offlineBanner(host: HostRuntime): RequestHandler {
  return (_req, res, next) => {
    if (host.online()) {
      next()
      return
    }
    const send = res.send.bind(res)
    res.send = ((body: unknown) => {
      if (typeof body === 'string' && body.startsWith('<!doctype html>'))
        return send(body.replace('<main>', `<main>${OFFLINE_BANNER}`))
      return send(body)
    }) as typeof res.send
    next()
  }
}

/** The signed-in person as the views see them, from the host's cache. */
function hostViewer(
  host: HostRuntime,
  req: express.Request,
): { viewer: Viewer; accountId: number; csrf: string } | undefined {
  const context = sessionContext(req, host.accounts)
  if (context == null) return undefined
  const row = host.cache.db
    .prepare('SELECT name,role FROM accounts WHERE id=?')
    .get(context.account.id) as { name: string; role: string } | undefined
  const role = (['admin', 'manager', 'developer', 'tester'] as const).find(
    (entry) => entry === row?.role,
  )
  if (row == null || role == null) return undefined
  return {
    accountId: context.account.id,
    csrf: context.session.csrf,
    viewer: {
      name: row.name,
      role,
      node: 'host',
      signOut: `<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${escape(context.session.csrf)}"><button class="secondary">Sign out</button></form>`,
    },
  }
}

/**
 * A page in the host's shell: the side menu, search, the approvals that
 * wait for the viewer, and the test banner.
 */
function hostShell(
  host: HostRuntime,
  context: WebAppContext,
  viewer: Viewer | undefined,
  framed: FramedPage,
): string {
  return shell({
    title: framed.title,
    body: framed.body,
    ...(viewer == null ? {} : { viewer }),
    ...(framed.active == null ? {} : { active: framed.active }),
    ...(framed.scripts == null ? {} : { scripts: framed.scripts }),
    ...(framed.head == null ? {} : { head: framed.head }),
    banners: testBanner(context),
    notifications:
      viewer == null
        ? []
        : notificationsFor(
            viewer,
            approvalNotifications(host.cache.db, viewer, (job, stage) => {
              const row = host.cache.db
                .prepare('SELECT workflow,graph FROM jobs WHERE id=?')
                .get(job) as
                | { workflow: string; graph: string | null }
                | undefined
              return row == null
                ? undefined
                : approvalRolesFromGraph(row.graph, row.workflow, stage)
            }),
          ),
  })
}

/** The host's shell for the person a request is from: the catalog, device and sign-in pages. */
function hostFrame(host: HostRuntime, context: WebAppContext): Frame {
  return (req, framed) =>
    hostShell(host, context, hostViewer(host, req)?.viewer, framed)
}

/**
 * Projects & apps, the project pages, Artifacts, runs and search for
 * developers and up, and Your account for everyone; `/` and the rest of
 * Install apps are the catalog's.
 */
function viewRoutes(host: HostRuntime, context: WebAppContext): express.Router {
  const router = express.Router()
  const visible =
    (accountId: number) =>
    (appId: number): boolean =>
      host.cache.store.visible(accountId, appId)
  const render = (
    res: express.Response,
    viewer: Viewer,
    title: string,
    body: string,
    active: string,
    csrf?: string,
    scripts: string[] = [],
  ): void => {
    res.send(
      hostShell(host, context, viewer, {
        title,
        body,
        active,
        scripts: ['/assets/run.js', ...scripts],
        ...(csrf == null
          ? {}
          : { head: `<meta name="mason-csrf" content="${escape(csrf)}">` }),
      }),
    )
  }
  /** Sends someone not signed in to sign in, and back. */
  const signIn = (req: express.Request, res: express.Response): void => {
    res.redirect(
      303,
      '/auth/login?return=' + encodeURIComponent(req.originalUrl),
    )
  }
  // Projects are for developers and up: to a tester they do not exist.
  router.use('/projects', (req, res, next) => {
    const found = hostViewer(host, req)
    if (found?.viewer.role !== 'tester') {
      next()
      return
    }
    render(
      res.status(404),
      found.viewer,
      'Not found',
      '<h1>Not found</h1><p class="empty-state">There is no such page.</p>',
      'catalog',
    )
  })
  /**
   * A project's pages on the host are the web app's, read from the copy the
   * master sends, for developers and up and only for a project with an app
   * they may see: a project or app ID the host does not hold (or the viewer
   * may not see) answers its unknown state with that status.
   */
  const projectShell = (
    req: express.Request,
    res: express.Response,
    app?: string,
  ): void => {
    const found = hostViewer(host, req)
    if (found == null) {
      signIn(req, res)
      return
    }
    // A tester never gets here: the 404 above answers them.
    const db = host.cache.db
    const row = db
      .prepare('SELECT id,details FROM projects WHERE slug=? AND enabled=1')
      .get(String(req.params.slug)) as
      | { id: number; details: string | null }
      | undefined
    const apps =
      row == null
        ? []
        : (
            db
              .prepare(
                'SELECT a.id,a.slug,a.enabled FROM apps a JOIN project_apps pa ON pa.app_id=a.id WHERE pa.project_id=?',
              )
              .all(row.id) as Array<{
              id: number
              slug: string
              enabled: number
            }>
          ).filter((entry) => visible(found.accountId)(entry.id))
    // An app ID page needs that app ID, enabled.
    const known =
      row != null &&
      storedDetails(row.details) != null &&
      apps.length > 0 &&
      (app == null ||
        apps.some((entry) => entry.slug === app && entry.enabled === 1))
    sendShell(res, known ? {} : { status: 404 })
  }
  router.get(
    ['/projects/:slug', '/projects/:slug/runs', '/projects/:slug/masonfile'],
    (req, res) => {
      projectShell(req, res)
    },
  )
  router.get(
    [
      '/projects/:slug/apps/:appId',
      '/projects/:slug/apps/:appId/build-numbers',
    ],
    (req, res) => {
      projectShell(req, res, String(req.params.appId))
    },
  )
  // Your account: the person's own record from the cache; changes go to the
  // master over the link, so the page is read-only while it is down.
  router.get('/account', (req, res) => {
    const found = hostViewer(host, req)
    if (found == null) {
      signIn(req, res)
      return
    }
    const account = hostAccount(host, found.accountId)
    res.set('Content-Security-Policy', masterContentSecurityPolicy)
    render(
      res,
      found.viewer,
      'Your account',
      accountView({
        viewer: found.viewer,
        person: {
          id: account.id,
          name: account.name,
          role: account.role,
          ...(account.username == null ? {} : { username: account.username }),
          password: account.password,
          emails: account.emails,
        },
        signOut: found.viewer.signOut,
        editable: account.editable,
        passwordHere: account.passwordHere,
      }),
      'account',
      found.csrf,
      ['/assets/master.js', '/assets/people.js'],
    )
  })
  // Projects & apps and Artifacts are the web app's, read from this host's
  // copy; a tester reads the 403 inside it on Artifacts (and the 404 above
  // on Projects).
  router.get(['/projects', '/artifacts'], (req, res) => {
    const found = hostViewer(host, req)
    if (found == null) {
      signIn(req, res)
      return
    }
    sendShell(res, found.viewer.role === 'tester' ? { status: 403 } : {})
  })
  // E2E only: a browser that cannot be handed a cookie (Safari in a
  // Simulator) opens the session a test.session control request started.
  if (context.testEndpoints)
    router.get('/test/session/:token', (req, res) => {
      const token = String(req.params.token)
      if (host.accounts.session(token) == null) {
        res.status(404).send('Not found')
        return
      }
      res.cookie(SESSION_COOKIE, token, cookieOptions)
      res.redirect(303, '/')
    })
  // The run page is the web app's, read from this host's copy: a tester
  // reads its 403 inside it, and a run the host does not hold its
  // unknown-run state, each with that status.
  router.get('/runs/:id', (req, res) => {
    const found = hostViewer(host, req)
    if (found == null) {
      signIn(req, res)
      return
    }
    if (found.viewer.role === 'tester') {
      sendShell(res, { status: 403 })
      return
    }
    const known =
      host.cache.db
        .prepare('SELECT 1 FROM jobs WHERE id=?')
        .get(String(req.params.id)) != null
    sendShell(res, known ? {} : { status: 404 })
  })
  router.get('/search', (req, res) => {
    const found = hostViewer(host, req)
    if (found == null) {
      res.status(401).json([])
      return
    }
    res.json(
      search(
        {
          db: host.cache.db,
          viewer: found.viewer,
          appVisible: visible(found.accountId),
        },
        typeof req.query.q === 'string' ? req.query.q : '',
      ),
    )
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

/** Install apps and Devices as JSON, from the host's cache, for its own signed-in people. */
function hostCatalogApi(host: HostRuntime): express.Router {
  const store = host.cache.store
  return catalogApi({
    caller(req) {
      // Before the first sync and in maintenance there is nothing to serve.
      host.builds.ready()
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
    },
    failure: (error) =>
      error instanceof Refused
        ? { status: error.status, error: error.message }
        : undefined,
    now: () => host.now(),
  })
}

/** The host's public web listener: catalog, installs and sign-in from its cache. */
export function hostApp(
  context: WebAppContext & { host?: HostRuntime },
): express.Express {
  const app = nodeWebApp({ ...context, styles: stylesheet })
  const host = context.host
  // Before every gate: the web app reads it while the host waits or is in maintenance.
  app.use(nodeInfoRoutes(() => hostNodeInfo(host, context)))
  if (host == null) {
    app.use((_req, res) => {
      sendPage(
        res,
        context,
        'Mason',
        '<section class="card"><p>This Mason host is waiting for its master.</p></section>',
        503,
      )
    })
    return app
  }
  app.get('/assets/run.js', (_req, res) => {
    res
      .type('js')
      .send(
        readFileSync(
          new URL('../browser/bundles/run.js', import.meta.url),
          'utf8',
        ),
      )
  })
  app.get('/assets/catalog.js', (_req, res) => {
    res
      .type('js')
      .send(
        readFileSync(new URL('../browser/client.js', import.meta.url), 'utf8'),
      )
  })
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
  app.use((_req, res, next) => {
    if (host.cache.host() == null) {
      sendPage(
        res,
        context,
        'Mason',
        '<section class="card"><p>This Mason host is waiting for its master.</p></section>',
        503,
      )
      return
    }
    if (host.maintenance()) {
      sendPage(
        res,
        context,
        'Maintenance',
        '<section class="card"><p>This Mason host has not reached its master for too long to serve builds safely. It comes back as soon as the master is reachable.</p></section>',
        503,
      )
      return
    }
    next()
  })
  app.use(offlineBanner(host))
  app.use(xcodeRoutes(host))
  // The sign-in page's script and the worker that hashes a password.
  for (const name of ['master', 'password-worker', 'people'])
    app.get(`/assets/${name}.js`, (_req, res) => {
      if (name === 'password-worker')
        res.set('Content-Security-Policy', masterContentSecurityPolicy)
      res
        .type('js')
        .send(
          readFileSync(
            new URL(`../browser/bundles/${name}.js`, import.meta.url),
            'utf8',
          ),
        )
    })
  const frame = hostFrame(host, context)
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
      people: false,
      account: false,
      frame,
      shell: (res, options) => {
        sendShell(res, options)
      },
      password: hostPassword(host),
      invitation: hostInvitation(host),
    }),
  )
  app.use(
    deviceRoutes(host.cache.store, host.accounts, {
      relay: host.devices,
      frame,
      node: 'host',
    }),
  )
  app.use(
    installationRoutes(host.cache.store, host.accounts, {
      frame,
      node: 'host',
    }),
  )
  app.use(viewRoutes(host, context))
  app.use(
    catalogRoutes(host.cache.store, host.accounts, { frame, node: 'host' }),
  )
  app.use((_req, res) => {
    res.status(404).send('Not found')
  })
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    const message =
      error instanceof Error && error.name === 'SignInRefused'
        ? error.message
        : 'The request is invalid or has expired. Return to sign in and try again.'
    // The sign-in protocol's own failures are the web app's to show.
    if (req.path.startsWith('/auth/')) {
      sendShell(res, { status: 400, flow: { state: 'invalid', message } })
      return
    }
    res
      .status(400)
      .send(
        page(
          'Request could not be completed',
          `<p>${escape(message)}</p><a href="/auth/login">Sign in</a>`,
        ),
      )
  }
  app.use(errors)
  return app
}
