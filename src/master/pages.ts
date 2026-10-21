import type express from 'express'
import { cookie } from '../auth/routes.js'
import {
  masterContentSecurityPolicy,
  testBanner,
  type WebAppContext,
} from '../node/webApp.js'
import { escape } from '../view/html.js'
import { artifactsView } from '../view/artifacts.js'
import {
  dashboardData,
  dashboardView,
  type DashboardSource,
} from '../view/dashboard.js'
import {
  approvalNotifications,
  notificationsFor,
} from '../view/notifications.js'
import { search } from '../view/search.js'
import { shell, type Viewer } from '../view/shell.js'
import { MASTER_SESSION_COOKIE, type MasterSession } from './auth.js'
import { can } from './permissions.js'
import { sessionActor } from './auth.js'
import type { Master } from './runtime.js'

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

/** Worker capacity and health for the top bar, and the nodes for the dashboard. */
function cluster(master: Master): {
  status: { idle: number; total: number; healthy: boolean }
  nodes: NonNullable<DashboardSource['nodes']>
} {
  const workers = master.registry
    .list()
    .filter((node) => node.role === 'worker')
  const nodes = workers.map((node) => {
    const busy = node.connected && master.scheduler.busy(node.fingerprint)
    const inventory = master.scheduler.inventoryOf(node.fingerprint)
    return {
      name: node.name,
      status: (!node.connected ? 'offline' : busy ? 'busy' : 'idle') as
        | 'offline'
        | 'busy'
        | 'idle',
      detail: [
        node.type,
        inventory == null ? undefined : `${inventory.os} ${inventory.arch}`,
        `${node.slots} slot${node.slots === 1 ? '' : 's'}`,
      ]
        .filter((part) => part != null && part !== '')
        .join(' · '),
    }
  })
  return {
    status: {
      idle: nodes.filter((node) => node.status === 'idle').length,
      total: nodes.length,
      healthy: nodes.every((node) => node.status !== 'offline'),
    },
    nodes,
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
): string {
  // The backup reminder is for those who may configure backups.
  const notice =
    master.configured() &&
    session != null &&
    can(sessionActor(session), 'settings.read')
      ? master.backups.notice()
      : undefined
  const banner =
    notice == null
      ? ''
      : `<p class="notice" role="alert">${escape(notice)}. <a href="/backups">Backups</a></p>`
  const viewer = session == null ? undefined : viewerOf(session)
  return shell({
    title,
    body: content.startsWith('<div class="page-head">')
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
    scripts: ['/assets/master.js'],
  })
}

/** Whether the viewer may see an app ID: developers and up see every one, testers their groups'. */
function appVisible(
  master: Master,
  session: MasterSession,
): (appId: number) => boolean {
  if (session.role !== 'tester') return () => true
  const allowed = new Set(
    (
      master.database.db
        .prepare(
          'SELECT ga.app_id FROM group_apps ga JOIN group_members gm ON gm.group_id=ga.group_id WHERE gm.account_id=?',
        )
        .all(session.accountId) as Array<{ app_id: number }>
    ).map((row) => row.app_id),
  )
  return (appId) => allowed.has(appId)
}

const status = '<p class="notice" role="status" data-field="status" hidden></p>'

const setupPage = `<section class="card"><h2>Create the first account</h2><p>Enter the six-digit setup code this master printed in its terminal when it started. The first account is an administrator.</p><form data-mason="setup"><label for="code">Setup code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required><p><button>Create account</button></p>${status}</form></section><section class="card"><h2>Restore from a backup</h2><p>Rebuild this master from its encrypted git backup instead.</p><form data-mason="restore"><label for="restore-code">Setup code</label><input id="restore-code" name="code" inputmode="numeric" pattern="[0-9]{6}" required><label for="repository">Backup repository</label><input id="repository" name="repository" placeholder="git@github.com:owner/mason-backup.git" required><label for="key">Backup key file</label><input id="key" name="key" type="file" required><label for="date">Date (optional, YYYY-MM-DD)</label><input id="date" name="date" pattern="\\d{4}-\\d{2}-\\d{2}"><p><button class="secondary">Restore</button></p>${status}</form></section>`

const signInPage = `<section class="card"><form data-mason="sign-in"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><p><button>Sign in</button></p>${status}</form></section>`

function backupsPage(master: Master, session: MasterSession): string {
  const actor = sessionActor(session)
  const backups = master.backups.status()
  const value = (master.settings.value('backup') ?? {}) as {
    repository?: string
    branch?: string
    deployKey?: { publicKey: string }
  }
  const state = backups.backedUp
    ? `<p>Last backup ${escape(new Date(backups.lastSuccess!.at).toISOString())} (${escape(backups.lastSuccess!.commit.slice(0, 12))}).</p>`
    : backups.lastFailure != null
      ? `<p>The last backup failed: ${escape(backups.lastFailure.error)}</p>`
      : '<p>No backup has run yet.</p>'
  const key =
    backups.configured && can(actor, 'backups.key')
      ? `<section class="card"><h2>Backup key</h2><p>Store this key somewhere safe outside this master. Without it no backup can be restored.</p><pre data-field="backupKey">${escape(master.backups.keyText())}</pre>${
          master.backups.needsConfirmation(session.accountId)
            ? `<form data-mason="backup-confirm"><p><button>I have stored the backup key</button></p>${status}</form>`
            : '<p>You confirmed you stored this key.</p>'
        }</section>`
      : ''
  return `<section class="card"><p>Every hour the master encrypts a snapshot of its database and pushes it to a git repository. Add the deploy key below to that repository with write access.</p>${state}<form data-mason="backup"><label for="repository">Repository</label><input id="repository" name="repository" value="${escape(value.repository ?? '')}" placeholder="git@github.com:owner/mason-backup.git" required><label for="branch">Branch</label><input id="branch" name="branch" value="${escape(value.branch ?? 'master')}" required><p><button>Save</button></p><p>Deploy key</p><pre data-field="deployKey"${value.deployKey == null ? ' hidden' : ''}>${escape(value.deployKey?.publicKey ?? '')}</pre><pre data-field="backupKey" hidden></pre>${status}</form><p><a href="/">Skip for now</a></p></section>${key}`
}

/** A tester's apps on the master: installs happen on the host. */
function testerApps(master: Master, session: MasterSession): string {
  const visible = appVisible(master, session)
  const origin = ((master.settings.value('host') ?? {}) as { origin?: string })
    .origin
  const apps = (
    master.database.db
      .prepare(
        'SELECT id,name,slug FROM apps WHERE enabled=1 ORDER BY position,id',
      )
      .all() as Array<{ id: number; name: string; slug: string }>
  ).filter((app) => visible(app.id))
  return `<p class="intro">Install builds from ${origin == null ? 'the Mason host' : `<a href="${escape(origin)}">${escape(new URL(origin).host)}</a>`}.</p><div class="app-list">${
    apps
      .map(
        (app) =>
          `<a class="app-card" href="${escape(origin == null ? '#' : `${origin}/apps/${app.id}`)}"><div><h2>${escape(app.name)}</h2><small>${escape(app.slug)}</small></div><span aria-hidden="true">→</span></a>`,
      )
      .join('') || '<p class="empty-state">No apps are shared with you yet.</p>'
  }</div>`
}

/** The master's pages: setup until the first account exists, then sign-in, home and backups. */
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
  ): void => {
    res
      .status(code)
      .send(masterPage(context, master, title, content, current, active))
  }
  // Only the pages that hash a password run the Argon2id WebAssembly.
  const hashing = (res: express.Response): void => {
    res.set('Content-Security-Policy', masterContentSecurityPolicy)
  }
  app.get('/', (req, res) => {
    if (!master.configured()) {
      hashing(res)
      send(res, 'Set up this master', setupPage)
      return
    }
    const current = session(req)
    if (current == null) {
      res.redirect(303, '/sign-in')
      return
    }
    // An administrator sees the Backups page until they confirm the key.
    if (
      can(sessionActor(current), 'backups.key') &&
      master.backups.needsConfirmation(current.accountId)
    ) {
      res.redirect(303, '/backups')
      return
    }
    const now = master.database.now()
    if (current.role === 'tester') {
      send(res, 'Your apps', testerApps(master, current), current)
      return
    }
    const platform =
      typeof req.query.platform === 'string' ? req.query.platform : undefined
    const project =
      typeof req.query.project === 'string' ? req.query.project : undefined
    const repositories = new Map(
      (
        master.database.db
          .prepare(
            'SELECT id,repository,webhook_secret IS NOT NULL AS webhook FROM projects',
          )
          .all() as Array<{ id: number; repository: string; webhook: number }>
      ).map((row) => [
        row.id,
        { repository: row.repository, webhook: row.webhook === 1 },
      ]),
    )
    const data = dashboardData(
      {
        db: master.database.db,
        viewer: viewerOf(current),
        now,
        appVisible: appVisible(master, current),
        nodes: cluster(master).nodes,
        repositories,
      },
      {
        ...(platform == null ? {} : { platform }),
        ...(project == null ? {} : { project }),
      },
    )
    send(
      res,
      'Projects & apps',
      dashboardView(data, viewerOf(current), now),
      current,
      200,
      'dashboard',
    )
  })
  app.get('/artifacts', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    if (current.role === 'tester') {
      send(
        res,
        'Artifacts',
        '<p>Artifacts are for developers and up.</p>',
        current,
        403,
      )
      return
    }
    const origin = (
      (master.settings.value('host') ?? {}) as { origin?: string }
    ).origin
    const filter = (name: string): string | undefined =>
      typeof req.query[name] === 'string'
        ? (req.query[name] as string)
        : undefined
    const run = filter('run')
    const project = filter('project')
    const branch = filter('branch')
    send(
      res,
      'Artifacts',
      artifactsView(
        {
          db: master.database.db,
          viewer: viewerOf(current),
          now: master.database.now(),
          appVisible: appVisible(master, current),
          artifactBase: origin ?? '',
        },
        {
          ...(run == null ? {} : { run }),
          ...(project == null ? {} : { project }),
          ...(branch == null ? {} : { branch }),
        },
      ),
      current,
      200,
      'artifacts',
    )
  })
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
  app.get('/sign-in', (req, res) => {
    if (!master.configured()) {
      res.redirect(303, '/')
      return
    }
    if (session(req) != null) {
      res.redirect(303, '/')
      return
    }
    hashing(res)
    send(res, 'Sign in', signInPage)
  })
  app.get('/backups', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    if (!can(sessionActor(current), 'settings.read')) {
      send(
        res,
        'Backups',
        '<p>Backups are for managers and administrators.</p>',
        current,
        403,
      )
      return
    }
    send(res, 'Backups', backupsPage(master, current), current, 200, 'backups')
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
