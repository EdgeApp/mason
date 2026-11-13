import type express from 'express'
import { cookie } from '../auth/routes.js'
import { testBanner, type WebAppContext } from '../node/webApp.js'
import { escape } from '../view/html.js'
import {
  approvalNotifications,
  notificationsFor,
} from '../view/notifications.js'
import { search } from '../view/search.js'
import { shell, type Viewer } from '../view/shell.js'
import {
  MASTER_SESSION_COOKIE,
  sessionActor,
  type MasterSession,
} from './auth.js'
import { can, type Action } from './permissions.js'
import type { Master } from './runtime.js'
import { ProjectNotFound, type Project } from './projects.js'
import { masterCatalogPages } from './catalogPages.js'
import { appVisibleTo, backupNotice, cluster } from './reads.js'
import { sendShell } from '../node/webRoutes.js'

/** The signed-in person as the views see them. */
function viewerOf(session: MasterSession): Viewer {
  return {
    name: session.name,
    role: session.role,
    node: 'master',
    signOut:
      '<form method="post" data-mason="sign-out"><button class="secondary">Sign out</button></form>',
  }
}

/** A master page: the shell, the forms script, and the banners that apply. */
function masterPage(
  context: WebAppContext,
  master: Master,
  title: string,
  content: string,
  session?: MasterSession,
  active?: string,
  scripts: string[] = [],
): string {
  const notice =
    session == null ? undefined : backupNotice(master, sessionActor(session))
  const banner =
    notice == null
      ? ''
      : `<p class="notice" role="alert">${escape(notice)}. <a href="/backups">Backups</a></p>`
  const viewer = session == null ? undefined : viewerOf(session)
  return shell({
    title,
    body: content.startsWith('<div class="page-head')
      ? content
      : `<h1>${escape(title)}</h1>${content}`,
    ...(viewer == null
      ? {}
      : {
          viewer,
          status: cluster(master).status,
          notifications: notificationsFor(
            viewer,
            approvalNotifications(master.database.db, viewer, (job, stage) =>
              master.scheduler.approvalRoles(job, stage),
            ),
            master.notices(),
          ),
          head: `<meta name="mason-csrf" content="${escape(session!.csrf)}">`,
        }),
    ...(active == null ? {} : { active }),
    banners: testBanner(context) + banner,
    scripts: ['/assets/master.js', '/assets/run.js', ...scripts],
  })
}

/** Whether the viewer may see an app ID: developers and up see every one, testers their groups'. */
function appVisible(
  master: Master,
  session: MasterSession,
): (appId: number) => boolean {
  return appVisibleTo(master, sessionActor(session))
}

/** The master's pages: the web app's shell behind each page's guard, search, and Install apps from the host. */
export function masterPages(
  app: express.Express,
  context: WebAppContext,
  master: Master,
): void {
  const session = (req: express.Request): MasterSession | undefined =>
    master.auth.session(cookie(req, MASTER_SESSION_COOKIE))
  const send = (
    res: express.Response,
    title: string,
    content: string,
    current?: MasterSession,
    code = 200,
    active?: string,
    scripts: string[] = [],
  ): void => {
    res
      .status(code)
      .send(
        masterPage(context, master, title, content, current, active, scripts),
      )
  }
  app.get('/', (req, res, next) => {
    // First-run setup and restore are the web app's.
    if (!master.configured()) {
      sendShell(res)
      return
    }
    const current = session(req)
    if (current == null) {
      res.redirect(303, '/sign-in')
      return
    }
    // The master opens on Projects & apps for developers and up (the web
    // app sends an administrator who has not confirmed the backup key to
    // Backups once per browser session); a tester's home is Install apps,
    // from the host.
    if (current.role !== 'tester') {
      sendShell(res)
      return
    }
    next()
  })
  // Projects are for developers and up: to a tester they do not exist.
  app.use('/projects', (req, res, next) => {
    const current = session(req)
    if (current?.role !== 'tester') {
      next()
      return
    }
    send(
      res,
      'Not found',
      '<p class="empty-state">There is no such page.</p>',
      current,
      404,
      'catalog',
    )
  })
  // Projects & apps and Artifacts are the web app's; a tester reads the
  // 403 inside it on Artifacts (and the 404 above on Projects).
  app.get(['/projects', '/artifacts'], (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    sendShell(res, current.role === 'tester' ? { status: 403 } : {})
  })
  // The run page is the web app's: a tester reads its 403 inside it, and a
  // run that does not exist its unknown-run state, each with that status.
  app.get('/runs/:id', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    if (!can(sessionActor(current), 'runs.read')) {
      sendShell(res, { status: 403 })
      return
    }
    sendShell(
      res,
      master.jobs.job(String(req.params.id)) == null ? { status: 404 } : {},
    )
  })
  /**
   * A page of the web app behind a permission: signed out it sends to sign
   * in; a role without `action` reads the 403 inside the app, and a thing
   * that does not exist its unknown state, each with that status.
   */
  const guardedShell = (
    req: express.Request,
    res: express.Response,
    action: Action | undefined,
    exists: (current: MasterSession) => boolean = () => true,
  ): void => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    if (action != null && !can(sessionActor(current), action)) {
      sendShell(res, { status: 403 })
      return
    }
    sendShell(res, exists(current) ? {} : { status: 404 })
  }
  // Administration is the web app's: Nodes, Cloud, Settings, People, Groups
  // and Backups for the roles that may read them, and Your account for
  // everyone signed in.
  const admin: Array<[string, Action | undefined]> = [
    ['/nodes', 'nodes.read'],
    ['/cloud', 'settings.read'],
    ['/settings', 'settings.read'],
    ['/people', 'people.read'],
    ['/account', undefined],
    ['/groups', 'groups.read'],
    ['/backups', 'settings.read'],
  ]
  for (const [path, action] of admin)
    app.get(path, (req, res) => {
      guardedShell(req, res, action)
    })
  // A group's page: an unknown or malformed id answers its unknown state.
  app.get('/groups/:id', (req, res) => {
    const id = String(req.params.id)
    guardedShell(
      req,
      res,
      'groups.read',
      () =>
        /^[1-9]\d{0,15}$/.test(id) && master.people.group(Number(id)) != null,
    )
  })
  /** The enabled project at `:slug`, if any. */
  const projectAt = (req: express.Request): Project | undefined => {
    try {
      return master.projects.get(String(req.params.slug))
    } catch (error) {
      if (!(error instanceof ProjectNotFound)) throw error
      return undefined
    }
  }
  // A project's pages are the web app's: a role without projects.read reads
  // their 403 inside it, and a project (or one of its app IDs) that does not
  // exist its unknown state, each with that status. The add-project wizard
  // is for those who may change projects.
  app.get('/projects/new', (req, res) => {
    guardedShell(req, res, 'projects.change', () => true)
  })
  app.get(
    [
      '/projects/:slug',
      '/projects/:slug/runs',
      '/projects/:slug/masonfile',
      '/projects/:slug/secrets',
    ],
    (req, res) => {
      guardedShell(req, res, 'projects.read', () => projectAt(req) != null)
    },
  )
  app.get(
    [
      '/projects/:slug/apps/:appId',
      '/projects/:slug/apps/:appId/build-numbers',
    ],
    (req, res) => {
      guardedShell(req, res, 'projects.read', (current) => {
        const project = projectAt(req)
        const app = project?.apps.find(
          (entry) => entry.bundleId === String(req.params.appId),
        )
        return (
          app != null &&
          master.database.db
            .prepare('SELECT 1 FROM apps WHERE id=? AND enabled=1')
            .get(app.id) != null &&
          appVisible(master, current)(app.id)
        )
      })
    },
  )
  app.get('/search', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.status(401).json([])
      return
    }
    res.json(
      search(
        {
          db: master.database.db,
          viewer: viewerOf(current),
          appVisible: appVisible(master, current),
        },
        typeof req.query.q === 'string' ? req.query.q : '',
      ),
    )
  })
  // Install apps and Devices, from the host over the link.
  masterCatalogPages(app, master, session, send)
  app.get('/sign-in', (req, res) => {
    if (!master.configured()) {
      res.redirect(303, '/')
      return
    }
    if (session(req) != null) {
      res.redirect(303, '/')
      return
    }
    sendShell(res)
  })
  // Every other page needs a signed-in user once the master is set up.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next()
      return
    }
    if (!master.configured()) {
      next()
      return
    }
    if (session(req) == null) {
      res.redirect(303, '/sign-in')
      return
    }
    next()
  })
}
