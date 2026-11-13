import express, { Router, type Request, type Response } from 'express'
import { identifierOf } from '../auth/passwordProtocol.js'
import {
  authLimiter,
  cookie,
  cookieOptions,
  csrf,
  passwordRefusal,
  passwordSignIn,
  sameOrigin,
  SESSION_COOKIE,
  sessionContext,
  type PasswordRelay,
} from '../auth/routes.js'
import { accountEmails } from '../master/people.js'
import { permissionsOf } from '../master/permissions.js'
import { releaseInfo } from '../node/nodeInfo.js'
import type { WebAppContext } from '../node/webApp.js'
import {
  SESSION_PARAMETERS_PATH,
  SESSION_PATH,
  type ErrorBody,
  type NodeInfo,
  type SessionInfo,
  type SignInReply,
} from '../shared/api/index.js'
import { isRole, type Role } from '../shared/permissions.js'
import { version } from '../version.js'
import type { HostRuntime } from './runtime.js'

/**
 * The host's `GET /api/v2/node`: it answers while the host waits for its
 * master (before its first sync, or with no runtime yet) and in maintenance,
 * so the web app can say so.
 */
export function hostNodeInfo(
  host: HostRuntime | undefined,
  context: WebAppContext,
): NodeInfo {
  const setting = host?.cache.host()
  const master = host?.cache.setting<{ origin?: unknown }>('master')?.origin
  return {
    role: 'host',
    version,
    ...(typeof master === 'string' ? { masterOrigin: master } : {}),
    ...(setting == null ? {} : { hostOrigin: setting.origin }),
    setupNeeded: false,
    signIn: {
      password: host != null,
      providers: (host?.cache.signInMethods() ?? []).map(({ id, name }) => ({
        id,
        name,
      })),
    },
    state:
      host == null || setting == null
        ? 'waitingForMaster'
        : host.maintenance()
          ? 'maintenance'
          : 'ok',
    testEndpoints: context.testEndpoints,
    ...releaseInfo(),
  }
}

const refuse = (res: Response, status: number, body: ErrorBody): void => {
  res.status(status).json(body)
}

/**
 * The session routes the web app calls, answered by the host itself with
 * its `__Host-mason-session` cookie, never forwarded: reading the session
 * and signing out need only the cache, and a password sign-in is relayed to
 * the master as `/auth/password*` relay it. Sign-in posts must come from
 * the host's own origin, and sign-out also carries the session's CSRF proof.
 */
export function hostSessionApi(
  host: HostRuntime,
  password: PasswordRelay,
): Router {
  const router = Router()
  const store = host.cache.store
  const body = express.json({ limit: '4kb' })
  /** The signed-in person, as the master's session route describes them. */
  const describe = (
    accountId: number,
    csrfToken: string,
  ): SessionInfo | undefined => {
    const row = host.cache.db
      .prepare('SELECT name,role FROM accounts WHERE id=?')
      .get(accountId) as { name: string; role: string } | undefined
    if (row == null || !isRole(row.role)) return undefined
    const role: Role = row.role
    return {
      accountId,
      name: row.name,
      role,
      csrf: csrfToken,
      permissions: permissionsOf(role),
      emails: accountEmails(host.cache.db, accountId),
    }
  }
  /** A refused relay: 503 without the master, 429 for a lock, else 401. */
  const refused = (res: Response, error: unknown): void => {
    const { status, body: reply } = passwordRefusal(error)
    refuse(res, status === 401 && reply.retryAt != null ? 429 : status, reply)
  }
  const fromHere = (req: Request, res: Response): boolean => {
    try {
      sameOrigin(req, store.config.origin)
      return true
    } catch (error) {
      refuse(res, 403, { error: (error as Error).message })
      return false
    }
  }

  router.use(
    SESSION_PATH,
    authLimiter(() => store.now()),
    (_req, res, next) => {
      // As the host's pages: nothing to sign in to until the first sync, or past the grace window.
      if (host.cache.host() == null)
        refuse(res, 503, { error: 'This Mason host is waiting for its master' })
      else if (host.maintenance())
        refuse(res, 503, {
          error:
            'This Mason host has not reached its master for too long to serve builds safely',
        })
      else next()
    },
  )
  router.get(SESSION_PATH, (req, res) => {
    const context = sessionContext(req, host.accounts)
    const info =
      context == null
        ? undefined
        : describe(context.account.id, context.session.csrf)
    if (info == null) refuse(res, 401, { error: 'Not signed in' })
    else res.json(info)
  })
  router.post(SESSION_PARAMETERS_PATH, body, async (req, res) => {
    if (!fromHere(req, res)) return
    try {
      res.json(await password.parameters(identifierOf(req.body)))
    } catch (error) {
      refused(res, error)
    }
  })
  router.post(SESSION_PATH, body, async (req, res) => {
    if (!fromHere(req, res)) return
    try {
      const { session } = await passwordSignIn(req, res, store, password)
      const info = describe(session.account_id, session.csrf)
      if (info == null) {
        // A role this host does not know (its master is newer): end the
        // session it cannot describe, and refuse as for any sign-in.
        store.db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash)
        res.clearCookie(SESSION_COOKIE, cookieOptions)
        refuse(res, 401, {
          error: 'This host does not know this account’s role; update the host',
        })
        return
      }
      const reply: SignInReply = {
        name: info.name,
        role: info.role,
        csrf: info.csrf,
      }
      res.json(reply)
    } catch (error) {
      refused(res, error)
    }
  })
  router.delete(SESSION_PATH, body, (req, res) => {
    const context = sessionContext(req, host.accounts)
    if (context == null) {
      refuse(res, 401, { error: 'Not signed in' })
      return
    }
    try {
      csrf(req, store, context.session)
    } catch (error) {
      refuse(res, 403, { error: (error as Error).message })
      return
    }
    host.accounts.logout(cookie(req, SESSION_COOKIE)!)
    res.clearCookie(SESSION_COOKIE, cookieOptions)
    res.json(null)
  })
  return router
}
