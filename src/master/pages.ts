import type express from 'express'
import { cookie } from '../auth/routes.js'
import {
  pageFallback,
  pageRoutes,
  type PageAnswer,
  type PageNode,
  type PageSubject,
} from '../node/webRoutes.js'
import type { Role } from '../shared/permissions.js'
import { MASTER_SESSION_COOKIE, sessionActor } from './auth.js'
import type { Master } from './runtime.js'
import { ProjectNotFound, type Project } from './projects.js'
import { masterCatalogStatus } from './catalogPages.js'
import { appVisibleTo } from './reads.js'

/**
 * The master's pages, from the web app's route table: who is signed in,
 * where sign-in is, and whether what a page names exists here.
 */
function masterPageNode(master: Master): PageNode {
  const session = (
    req: express.Request,
  ): ReturnType<Master['auth']['session']> =>
    master.auth.session(cookie(req, MASTER_SESSION_COOKIE))
  /** The enabled project at `:slug`, if any: a disabled one is 404, as on the host. */
  const projectAt = (req: express.Request): Project | undefined => {
    let project
    try {
      project = master.projects.get(String(req.params.slug))
    } catch (error) {
      if (!(error instanceof ProjectNotFound)) throw error
      return undefined
    }
    return project.enabled ? project : undefined
  }
  const check = (
    subject: PageSubject,
    req: express.Request,
    role: Role | undefined,
  ): PageAnswer | Promise<PageAnswer> => {
    switch (subject) {
      case 'home':
        // First-run setup and restore are the web app's, wherever opened.
        if (!master.configured()) return 200
        if (role == null) return { redirect: '/sign-in' }
        // Projects & apps for developers and up (the web app sends an
        // administrator who has not confirmed the backup key to Backups once
        // per browser session); a tester's home is Install apps, from the host.
        return role === 'tester' ? check('catalog', req, role) : 200
      case 'signIn':
        return !master.configured() || role != null ? { redirect: '/' } : 200
      case 'invite':
        // The web app reads the token from the fragment, then drops it.
        return master.configured() ? 200 : { redirect: '/' }
      case 'project':
        return projectAt(req) == null ? 404 : 200
      case 'app': {
        const app = projectAt(req)?.apps.find(
          (entry) => entry.bundleId === String(req.params.appId),
        )
        const current = session(req)
        return app != null &&
          current != null &&
          master.database.db
            .prepare('SELECT 1 FROM apps WHERE id=? AND enabled=1')
            .get(app.id) != null &&
          appVisibleTo(master, sessionActor(current))(app.id)
          ? 200
          : 404
      }
      case 'run':
        return master.jobs.job(String(req.params.id)) == null ? 404 : 200
      case 'group': {
        const id = String(req.params.id)
        return /^[1-9]\d{0,15}$/.test(id) &&
          master.people.group(Number(id)) != null
          ? 200
          : 404
      }
      case 'catalog':
      case 'devices':
        return masterCatalogStatus(master, session, subject, req)
    }
  }
  return {
    node: 'master',
    role: (req) => session(req)?.role,
    signIn: () => (master.configured() ? '/sign-in' : '/'),
    check,
  }
}

/** The master's pages: each address of the web app answers its shell. */
export function masterPages(app: express.Express, master: Master): void {
  const node = masterPageNode(master)
  app.use(pageRoutes(node))
  app.use(pageFallback(node))
}
