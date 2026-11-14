import express, { Router, type Response } from 'express'
import { cookie, sameOrigin } from '../auth/routes.js'
import { Conflict } from './api.js'
import { sessionCookieOptions } from './accountsApi.js'
import { MASTER_SESSION_COOKIE, type MasterAuth } from './auth.js'
import { clientAddress } from './forward.js'
import { InvitationRefused, type People } from './people.js'
import type { Settings } from './settings.js'

/**
 * Where an invitation link opens: the host, where testers install builds,
 * else the master's public origin, else the address the admin reached the
 * master at. The token is the fragment, which browsers never send.
 */
export function invitationUrl(
  settings: Settings,
  token: string,
  fallback: string,
): string {
  const host = settings.value('host')?.origin
  const master = settings.value('master')?.origin
  const origin =
    typeof host === 'string'
      ? host
      : typeof master === 'string'
        ? master
        : fallback
  return `${origin}/auth/invite#${token}`
}

/** A refusal for the invitation page's script: a message, never a stack. */
function refused(res: Response, error: unknown): void {
  res
    .status(
      error instanceof InvitationRefused
        ? 404
        : error instanceof Conflict
          ? 409
          : 400,
    )
    .json({ error: (error as Error).message })
}

/**
 * The two requests the invitation page (the web app's) makes on the master:
 * whom the token is for, and using it to set the username and password,
 * which signs the person in to the master.
 */
export function invitationRoutes(master: {
  auth: MasterAuth
  people: People
}): Router {
  const router = Router()
  const json = express.json({ limit: '4kb' })
  router.post('/auth/invite/lookup', json, (req, res) => {
    try {
      // The page may be open at the master's public name or another one.
      sameOrigin(req, undefined)
      res.json(
        master.people.invitation(
          (req.body as { token?: unknown } | null)?.token,
        ),
      )
    } catch (error) {
      refused(res, error)
    }
  })
  router.post('/auth/invite', json, async (req, res) => {
    try {
      sameOrigin(req, undefined)
      const { accountId } = await master.people.acceptInvitation(req.body)
      // The previous session in this browser, if any, ends.
      master.auth.signOut(cookie(req, MASTER_SESSION_COOKIE))
      const { token, session } = master.auth.start(
        accountId,
        clientAddress(req),
      )
      res.cookie(
        MASTER_SESSION_COOKIE,
        token,
        sessionCookieOptions(session.expiresAt),
      )
      res.json({ signedIn: true })
    } catch (error) {
      refused(res, error)
    }
  })
  // A body that is not JSON, or too large.
  router.use('/auth/invite', ((error, _req, res, _next) => {
    refused(res, error)
  }) as express.ErrorRequestHandler)
  return router
}
