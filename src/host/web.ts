import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import { existsSync, readFileSync } from 'node:fs'
import {
  authRoutes,
  cookieOptions,
  SESSION_COOKIE,
  sessionContext,
  type AuthOptions,
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
import {
  accountView,
  masonfileView,
  projectRunsView,
  projectView,
} from '../view/admin.js'
import {
  SCRIPT_PROJECT,
  storedDetails,
  type ProjectDetails,
} from '../master/projectDetails.js'
import { artifactsView, projectRunsData } from '../view/artifacts.js'
import { dashboardData, dashboardView } from '../view/dashboard.js'
import {
  approvalNotifications,
  approvalRolesFromGraph,
  notificationsFor,
} from '../view/notifications.js'
import { graphFromJson, runData, runTitle, runView } from '../view/run.js'
import { search } from '../view/search.js'
import { page, shell, type Viewer } from '../view/shell.js'
import { escape } from '../view/html.js'
import { stylesheet } from '../view/stylesheet.js'
import type { Projected } from '../master/changes.js'
import type { HostRuntime } from './runtime.js'
import { hostLogin } from './sessions.js'

const OFFLINE_BANNER =
  '<p class="notice" role="status">The Mason master is unreachable. You are seeing the last synced builds.</p>'

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

/** The dashboard, artifacts and search for developers and up; testers keep the catalog. */
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
      shell({
        title,
        body,
        viewer,
        active,
        scripts: ['/assets/run.js', ...scripts],
        ...(csrf == null
          ? {}
          : { head: `<meta name="mason-csrf" content="${escape(csrf)}">` }),
        banners: testBanner(context),
        notifications: notificationsFor(
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
      }),
    )
  }
  /**
   * A project's pages on the host: the master's views over the copy the
   * master sends, read-only, for developers and up and only for a project
   * with an app they may see. Testers reach apps through Install apps.
   */
  const projectPage = (
    req: express.Request,
    res: express.Response,
  ):
    | {
        found: NonNullable<ReturnType<typeof hostViewer>>
        project: { id: number; slug: string; name: string }
        details: ProjectDetails
      }
    | undefined => {
    const found = hostViewer(host, req)
    if (found == null) {
      res.redirect(
        303,
        '/auth/login?return=' + encodeURIComponent(req.originalUrl),
      )
      return undefined
    }
    const db = host.cache.db
    const row = db
      .prepare(
        'SELECT id,slug,name,details FROM projects WHERE slug=? AND enabled=1',
      )
      .get(String(req.params.slug)) as
      | { id: number; slug: string; name: string; details: string | null }
      | undefined
    const details = storedDetails(row?.details)
    const sees =
      row != null &&
      (
        db
          .prepare('SELECT app_id FROM project_apps WHERE project_id=?')
          .all(row.id) as Array<{ app_id: number }>
      ).some((app) => host.cache.store.visible(found.accountId, app.app_id))
    if (
      row == null ||
      details == null ||
      !sees ||
      found.viewer.role === 'tester'
    ) {
      render(
        res.status(404),
        found.viewer,
        'Project',
        '<p class="empty-state">There is no such project.</p>',
        'dashboard',
      )
      return undefined
    }
    return {
      found,
      project: { id: row.id, slug: row.slug, name: row.name },
      details,
    }
  }
  router.get('/projects/:slug', (req, res) => {
    const page = projectPage(req, res)
    if (page == null) return
    render(
      res,
      page.found.viewer,
      page.project.name,
      projectView({
        slug: page.project.slug,
        name: page.project.name,
        ...page.details,
        canSeed: false,
        secrets: false,
      }),
      'dashboard',
    )
  })
  router.get('/projects/:slug/runs', (req, res) => {
    const page = projectPage(req, res)
    if (page == null) return
    const branch =
      typeof req.query.branch === 'string' && req.query.branch !== ''
        ? req.query.branch
        : undefined
    const now = host.now()
    const { branches, runs } = projectRunsData(
      {
        db: host.cache.db,
        viewer: page.found.viewer,
        now,
        appVisible: visible(page.found.accountId),
        artifactBase: '',
        reserved: (run): string | undefined =>
          (
            host.cache.db
              .prepare('SELECT build_number FROM jobs WHERE id=?')
              .get(run) as { build_number: string | null } | undefined
          )?.build_number ?? undefined,
      },
      page.project.slug,
      { ...(branch == null ? {} : { branch }), pinned: page.details.pinned },
    )
    render(
      res,
      page.found.viewer,
      `${page.project.name} · Runs and builds`,
      projectRunsView(
        {
          slug: page.project.slug,
          name: page.project.name,
          ...(branch == null ? {} : { branch }),
          branches,
          runs,
          secrets: false,
        },
        now,
      ),
      'dashboard',
    )
  })
  router.get('/projects/:slug/masonfile', (req, res) => {
    const page = projectPage(req, res)
    if (page == null) return
    const db = host.cache.db
    // The commits the host has a copy for, newest run first.
    const commits = db
      .prepare(
        "SELECT j.commit_sha AS sha, j.branch FROM jobs j JOIN masonfiles m ON m.key=j.project_id || ':' || j.commit_sha WHERE j.project_id=? GROUP BY j.commit_sha ORDER BY MAX(j.created) DESC LIMIT 50",
      )
      .all(page.project.id) as Array<{ sha: string; branch: string }>
    const commit =
      typeof req.query.commit === 'string' ? req.query.commit : commits[0]?.sha
    const kept =
      commit == null
        ? undefined
        : (db
            .prepare('SELECT file,text FROM masonfiles WHERE key=?')
            .get(`${page.project.id}:${commit}`) as
            | { file: string; text: string | null }
            | undefined)
    render(
      res,
      page.found.viewer,
      `${page.project.name} · Masonfile`,
      masonfileView({
        slug: page.project.slug,
        name: page.project.name,
        commits,
        ...(commit == null ? {} : { commit }),
        ...(kept?.text == null ? {} : { file: kept.file, text: kept.text }),
        ...(kept?.text != null
          ? {}
          : {
              error:
                page.details.format === 'script'
                  ? SCRIPT_PROJECT
                  : commit == null
                    ? 'No run has a commit yet.'
                    : kept != null
                      ? 'The host is still copying that commit’s Masonfile from the master.'
                      : 'The host has no copy of that commit’s Masonfile.',
            }),
        secrets: false,
      }),
      'dashboard',
    )
  })
  // Your account: the person's own record from the cache; changes go to the
  // master over the link, so the page is read-only while it is down.
  router.get('/account', (req, res) => {
    const found = hostViewer(host, req)
    if (found == null) {
      res.redirect(
        303,
        '/auth/login?return=' + encodeURIComponent(req.originalUrl),
      )
      return
    }
    const db = host.cache.db
    const row = db
      .prepare(
        'SELECT id,name,username,role,has_password FROM accounts WHERE id=?',
      )
      .get(found.accountId) as {
      id: number
      name: string
      username: string | null
      role: string
      has_password: number
    }
    const link = host.options.link()
    res.set('Content-Security-Policy', masterContentSecurityPolicy)
    render(
      res,
      found.viewer,
      'Your account',
      accountView({
        person: {
          id: row.id,
          name: row.name,
          role: row.role,
          ...(row.username == null ? {} : { username: row.username }),
          password: row.has_password === 1,
          emails: (
            db
              .prepare(
                'SELECT email,confirmed FROM account_emails WHERE account_id=? ORDER BY position',
              )
              .all(row.id) as Array<{ email: string; confirmed: number }>
          ).map((entry) => ({
            email: entry.email,
            confirmed: entry.confirmed === 1,
          })),
        },
        signOut: found.viewer.signOut,
        editable: link != null && !link.closed,
        // The master takes a password through a host from testers only.
        passwordHere: row.role === 'tester',
      }),
      'account',
      found.csrf,
      ['/assets/master.js', '/assets/people.js'],
    )
  })
  router.get('/', (req, res, next) => {
    const found = hostViewer(host, req)
    if (found == null || found.viewer.role === 'tester') {
      next()
      return
    }
    const now = host.now()
    const platform =
      typeof req.query.platform === 'string' ? req.query.platform : undefined
    const project =
      typeof req.query.project === 'string' ? req.query.project : undefined
    render(
      res,
      found.viewer,
      'Projects & apps',
      dashboardView(
        dashboardData(
          {
            db: host.cache.db,
            viewer: found.viewer,
            now,
            appVisible: visible(found.accountId),
          },
          {
            ...(platform == null ? {} : { platform }),
            ...(project == null ? {} : { project }),
          },
        ),
        found.viewer,
        now,
      ),
      'dashboard',
    )
  })
  router.get('/artifacts', (req, res) => {
    const found = hostViewer(host, req)
    if (found == null) {
      res.redirect(
        303,
        '/auth/login?return=' + encodeURIComponent(req.originalUrl),
      )
      return
    }
    if (found.viewer.role === 'tester') {
      res
        .status(403)
        .send(page('Artifacts', '<p>Artifacts are for developers and up.</p>'))
      return
    }
    const filter = (name: string): string | undefined =>
      typeof req.query[name] === 'string'
        ? (req.query[name] as string)
        : undefined
    const run = filter('run')
    const project = filter('project')
    const branch = filter('branch')
    render(
      res,
      found.viewer,
      'Artifacts',
      artifactsView(
        {
          db: host.cache.db,
          viewer: found.viewer,
          now: host.now(),
          appVisible: visible(found.accountId),
          artifactBase: '',
        },
        {
          ...(run == null ? {} : { run }),
          ...(project == null ? {} : { project }),
          ...(branch == null ? {} : { branch }),
        },
      ),
      'artifacts',
    )
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
  router.get('/runs/:id', (req, res) => {
    const found = hostViewer(host, req)
    if (found == null) {
      res.redirect(
        303,
        '/auth/login?return=' + encodeURIComponent(req.originalUrl),
      )
      return
    }
    if (found.viewer.role === 'tester') {
      res
        .status(403)
        .send(page('Run', '<p>Runs are for developers and up.</p>'))
      return
    }
    const db = host.cache.db
    const id = String(req.params.id)
    const run = runData(db, id, (job) => {
      const row = db
        .prepare('SELECT workflow,graph FROM jobs WHERE id=?')
        .get(job) as { workflow: string; graph: string | null } | undefined
      return row == null ? undefined : graphFromJson(row.graph, row.workflow)
    })
    if (run == null) {
      res
        .status(404)
        .send(page('Run unavailable', '<p>There is no such run.</p>'))
      return
    }
    const query = (name: string): string | undefined =>
      typeof req.query[name] === 'string'
        ? (req.query[name] as string)
        : undefined
    const stage = run.stages.some((entry) => entry.name === query('stage'))
      ? query('stage')
      : undefined
    const step =
      stage == null || query('step') == null ? undefined : Number(query('step'))
    const logs = `/api/v2/runs/${encodeURIComponent(id)}/logs`
    const role = found.viewer.role
    render(
      res,
      found.viewer,
      runTitle(run),
      runView(run, {
        ...(stage == null ? {} : { selected: stage }),
        ...(step == null || !Number.isSafeInteger(step) ? {} : { step }),
        tab: query('tab') === 'timeline' ? 'timeline' : 'graph',
        now: host.now(),
        // The logs are on the master: a stage's arrive by its live stream, a step's are fetched.
        log:
          stage == null
            ? {
                unavailable:
                  'The whole run’s log is on the master: download it, or choose a stage to follow its log here.',
              }
            : { text: '' },
        ...(stage != null && step != null && Number.isSafeInteger(step)
          ? {
              logSource: `${logs}?stage=${encodeURIComponent(stage)}&step=${step}`,
            }
          : {}),
        // It holds none of the stage's log: the socket starts at its end.
        logTail: true,
        can: {
          cancel: true,
          restart: true,
          request: true,
          approve: (name) =>
            role === 'admin' ||
            (
              run.graph?.approvals[name]?.roles ?? ['admin', 'manager']
            ).includes(role),
        },
        base: '',
      }),
      'dashboard',
      found.csrf,
    )
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

function hostPassword(host: HostRuntime): NonNullable<AuthOptions['password']> {
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

/** The host's public web listener: catalog, installs and sign-in from its cache. */
export function hostApp(
  context: WebAppContext & { host?: HostRuntime },
): express.Express {
  const app = nodeWebApp({ ...context, styles: stylesheet })
  const host = context.host
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
  // The builds API is answered here, from the cache and storage, so it keeps
  // working while the master is away; the rest of /api/v2 is forwarded.
  app.use(host.builds.routes(host.accounts))
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
      password: hostPassword(host),
      invitation: hostInvitation(host),
    }),
  )
  app.use(deviceRoutes(host.cache.store, host.accounts, host.devices))
  app.use(installationRoutes(host.cache.store, host.accounts))
  app.use(viewRoutes(host, context))
  app.use(catalogRoutes(host.cache.store, host.accounts))
  app.use((_req, res) => {
    res.status(404).send('Not found')
  })
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res
      .status(400)
      .send(
        page(
          'Request could not be completed',
          `<p>${escape(error instanceof Error && error.name === 'SignInRefused' ? error.message : 'The request is invalid or has expired. Return to sign in and try again.')}</p><a href="/auth/login">Sign in</a>`,
        ),
      )
  }
  app.use(errors)
  return app
}
