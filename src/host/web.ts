import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { authRoutes, navigation, sessionContext } from '../auth/routes.js'
import { forwardRoutes } from './forward.js'
import { deviceCallbackRoutes, deviceRoutes } from '../devices/routes.js'
import { installationRoutes } from '../catalog/install.js'
import { catalogRoutes } from '../catalog/routes.js'
import { nodeWebApp, sendPage, type WebAppContext } from '../node/webApp.js'
import { catalogStyles, escape, page, stylesheet } from '../view.js'
import type { HostRuntime } from './runtime.js'
import { hostLogin } from './sessions.js'
import { uploadRoutes } from '../upload/routes.js'

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

/** A project's home: its apps the account may see and, for developers and up, its latest runs. */
function projectRoutes(host: HostRuntime): express.Router {
  const router = express.Router()
  router.get('/projects/:slug', (req, res) => {
    const context = sessionContext(req, host.accounts)
    if (context == null) {
      res.redirect(
        303,
        '/auth/login?return=' + encodeURIComponent(req.originalUrl),
      )
      return
    }
    const db = host.cache.db
    const project = db
      .prepare('SELECT * FROM projects WHERE slug=? AND enabled=1')
      .get(String(req.params.slug)) as
      | { id: number; slug: string; name: string }
      | undefined
    const nav = navigation(context.session, context.account)
    const apps =
      project == null
        ? []
        : (
            db
              .prepare(
                'SELECT a.id,a.name,a.slug FROM project_apps pa JOIN apps a ON a.id=pa.app_id WHERE pa.project_id=? AND a.enabled=1 ORDER BY a.position,a.id',
              )
              .all(project.id) as Array<{
              id: number
              name: string
              slug: string
            }>
          ).filter((app) =>
            host.cache.store.visible(context.account.id, app.id),
          )
    const role = (
      db
        .prepare('SELECT role FROM accounts WHERE id=?')
        .get(context.account.id) as { role: string }
    ).role
    if (project == null || (apps.length === 0 && role === 'tester')) {
      res
        .status(404)
        .send(
          page(
            'Project unavailable',
            '<p>This project is unavailable.</p>',
            nav,
          ),
        )
      return
    }
    const cards = apps
      .map(
        (app) =>
          `<a class="app-card" href="/apps/${app.id}"><div><h2>${escape(app.name)}</h2><small>${escape(app.slug)}</small></div><span aria-hidden="true">→</span></a>`,
      )
      .join('')
    const runs =
      role === 'tester'
        ? ''
        : `<h2>Recent runs</h2><div class="build-list">${
            (
              db
                .prepare(
                  'SELECT number,workflow,branch,status,created FROM jobs WHERE project_id=? ORDER BY created DESC LIMIT 10',
                )
                .all(project.id) as Array<{
                number: number
                workflow: string
                branch: string
                status: string
                created: number
              }>
            )
              .map(
                (run) =>
                  `<div class="list-row"><div><strong>${escape(run.workflow)} #${run.number}</strong><small>${escape(run.branch)} · ${new Date(run.created).toISOString().slice(0, 16).replace('T', ' ')} UTC</small></div><span>${escape(run.status)}</span></div>`,
              )
              .join('') || '<section class="card"><p>No runs yet.</p></section>'
          }</div>`
    res.send(
      page(
        project.name,
        `<div class="app-list">${cards || '<section class="card"><p>No apps.</p></section>'}</div>${runs}`,
        nav,
      ),
    )
  })
  return router
}

/** The current release's installer and files, exactly as the master stores them. */
export function releaseRoutes(
  host: Pick<HostRuntime, 'currentRelease' | 'xcodeFile' | 'granted'>,
): express.Router {
  const router = express.Router()
  const serve = (name: string, res: express.Response): void => {
    const release = host.currentRelease()
    if (release == null || !(name in release.files || name === 'SHA256SUMS')) {
      res.status(404).send('Not found')
      return
    }
    const file = path.join(release.dir, name)
    if (!existsSync(file)) {
      res.status(404).send('Not found')
      return
    }
    res.type(
      name.endsWith('.sh') ? 'text/x-shellscript' : 'application/octet-stream',
    )
    res.sendFile(file, { dotfiles: 'allow' })
  }
  // A mirrored Xcode, for a node holding the master's grant for that version.
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
  router.get('/install.sh', (_req, res) => {
    serve('install.sh', res)
  })
  router.get('/releases/current/:file', (req, res) => {
    const name = String(req.params.file)
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      res.status(404).send('Not found')
      return
    }
    serve(name, res)
  })
  return router
}

/** The host's public web listener: catalog, installs and sign-in from its cache. */
export function hostApp(
  context: WebAppContext & { host?: HostRuntime },
): express.Express {
  const app = nodeWebApp({ ...context, styles: stylesheet + catalogStyles })
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
  app.use(uploadRoutes(host.cache.store, host.artifacts.uploadHooks()))
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
  app.use(releaseRoutes(host))
  // The Profile Service posts a signed body, read raw before any form parser.
  app.use(deviceCallbackRoutes(host.cache.store, host.devices))
  app.use(express.urlencoded({ extended: false, limit: '16kb' }))
  app.use(
    authRoutes(host.cache.store, () => host.providers(), host.accounts, {
      login: hostLogin(host.cache, host.accounts),
      people: false,
    }),
  )
  app.use(deviceRoutes(host.cache.store, host.accounts, host.devices))
  app.use(installationRoutes(host.cache.store, host.accounts))
  app.use(projectRoutes(host))
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
