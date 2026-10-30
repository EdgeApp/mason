import express, { Router, type Response } from 'express'
import { rejectRawPassword } from '../auth/passwordProtocol.js'
import { cookie } from '../auth/routes.js'
import { AlreadyConfigured, createFirstAdmin } from '../setup/setup.js'
import { actorOf, apiErrors, authenticate, json, NotFound } from './api.js'
import { MASTER_SESSION_COOKIE, SetupGate, SignInRefused } from './auth.js'
import { Forbidden } from './roles.js'
import type { Master } from './runtime.js'
import { clientAddress } from './forward.js'

const cookieOptions = (expires: number): express.CookieOptions => ({
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/',
  expires: new Date(expires),
})

/** Maps sign-in refusals: locked or throttled is 429 with when to retry. */
const errors: express.ErrorRequestHandler = (error, req, res, next) => {
  if (error instanceof SignInRefused) {
    res.status(error.retryAt == null ? 401 : 429).json({
      error: error.message,
      ...(error.retryAt == null ? {} : { retryAt: error.retryAt }),
    })
    return
  }
  if (error instanceof AlreadyConfigured)
    return apiErrors(new NotFound(error.message), req, res, next)
  apiErrors(error, req, res, next)
}

/**
 * Master sign-in (`/api/v2/session`), first-run setup (`/api/setup`, gated
 * by the setup code until the first account exists) and the people and
 * groups API (`/api/v2/people`, `/api/v2/groups`).
 */
export function accountsApi(
  master: Master,
  options: {
    setupCode: () => string | undefined
    onConfigured?: () => void
    /** Restores an unconfigured master from its backup; it restarts with that data. */
    restore?: (input: {
      repository: string
      branch?: string
      key: string
      date?: string
    }) => Promise<unknown>
  },
): Router {
  const router = Router()
  const body = express.json({ limit: '64kb' })
  const gate = new SetupGate(options.setupCode, master.database.now)
  // Sign-in and setup are for browsers on the master's own listener, never forwarded.
  const direct: express.RequestHandler = (req, _res, next) => {
    next(
      master.forwarder.forwarded(req)
        ? new Forbidden('Sign in on the master itself')
        : undefined,
    )
  }
  const signedIn = (res: Response, token: string, expires: number): void => {
    res.cookie(MASTER_SESSION_COOKIE, token, cookieOptions(expires))
  }

  router.get(
    '/api/setup',
    direct,
    json(() => ({
      configured: master.configured(),
      ...(master.configured() ? {} : { waitUntil: gate.waitUntil() }),
    })),
  )
  router.post(
    '/api/setup',
    direct,
    body,
    json(async (req, res) => {
      if (master.configured()) throw new AlreadyConfigured()
      gate.check((req.body as { code?: unknown } | null)?.code)
      const input = (req.body ?? {}) as Record<string, unknown>
      rejectRawPassword(input)
      const created = await createFirstAdmin(master.database, master.keys, {
        username: input.username,
        clientHash: input.clientHash,
        clientParameters: input.clientParameters,
        apiKey: false,
      })
      options.onConfigured?.()
      const { token, session } = master.auth.start(
        created.accountId,
        clientAddress(req),
      )
      signedIn(res, token, session.expiresAt)
      res.status(201)
      return { accountId: created.accountId, username: created.username }
    }),
  )

  router.post(
    '/api/setup/restore',
    direct,
    body,
    json(async (req, res) => {
      if (master.configured()) throw new AlreadyConfigured()
      if (options.restore == null)
        throw new NotFound('Restore is not available')
      const input = (req.body ?? {}) as Record<string, unknown>
      gate.check(input.code)
      const text = (value: unknown): string | undefined =>
        typeof value === 'string' && value !== '' ? value : undefined
      const result = await options.restore({
        repository: String(input.repository ?? ''),
        key: String(input.key ?? ''),
        ...(text(input.branch) == null ? {} : { branch: text(input.branch)! }),
        ...(text(input.date) == null ? {} : { date: text(input.date)! }),
      })
      res.status(202)
      return result
    }),
  )
  router.post(
    '/api/v2/session/parameters',
    direct,
    body,
    json((req) =>
      master.auth.parameters(
        (req.body as { username?: unknown } | null)?.username,
      ),
    ),
  )
  router.post(
    '/api/v2/session',
    direct,
    body,
    json(async (req, res) => {
      const { token, session } = await master.auth.signIn(
        req.body,
        clientAddress(req),
      )
      signedIn(res, token, session.expiresAt)
      return { name: session.name, role: session.role, csrf: session.csrf }
    }),
  )
  router.get(
    '/api/v2/session',
    direct,
    json((req) => {
      const session = master.auth.session(cookie(req, MASTER_SESSION_COOKIE))
      if (session == null) throw new SignInRefused('Not signed in')
      return {
        accountId: session.accountId,
        name: session.name,
        role: session.role,
        csrf: session.csrf,
      }
    }),
  )
  router.delete(
    '/api/v2/session',
    direct,
    body,
    authenticate(master),
    json((req, res) => {
      master.auth.signOut(cookie(req, MASTER_SESSION_COOKIE))
      res.clearCookie(MASTER_SESSION_COOKIE, { path: '/', secure: true })
      return null
    }),
  )
  router.use(['/api/setup', '/api/v2/session'], errors)

  const auth = authenticate(master)
  router.use(['/api/v2/people', '/api/v2/groups'], body, auth)
  const id = (value: unknown): number => {
    const out = Number(value)
    if (!Number.isSafeInteger(out) || out < 1) throw new NotFound('Not found')
    return out
  }
  router.get(
    '/api/v2/people',
    json((_req, res) => master.people.list(actorOf(res))),
  )
  router.post(
    '/api/v2/people',
    json(async (req, res) => {
      res.status(201)
      return await master.people.create(actorOf(res), req.body)
    }),
  )
  router.get(
    '/api/v2/people/:id',
    json((req, res) => master.people.get(actorOf(res), id(req.params.id))),
  )
  router.put(
    '/api/v2/people/:id',
    json(
      async (req, res) =>
        await master.people.update(actorOf(res), id(req.params.id), req.body),
    ),
  )
  router.delete(
    '/api/v2/people/:id',
    json((req, res) => {
      master.people.remove(actorOf(res), id(req.params.id))
      return null
    }),
  )
  router.get(
    '/api/v2/groups',
    json((_req, res) => master.people.groups(actorOf(res))),
  )
  router.post(
    '/api/v2/groups',
    json((req, res) => {
      res.status(201)
      return master.people.createGroup(actorOf(res), req.body)
    }),
  )
  router.put(
    '/api/v2/groups/:id',
    json((req, res) =>
      master.people.updateGroup(actorOf(res), id(req.params.id), req.body),
    ),
  )
  router.delete(
    '/api/v2/groups/:id',
    json((req, res) => {
      master.people.removeGroup(actorOf(res), id(req.params.id))
      return null
    }),
  )
  router.use(['/api/v2/people', '/api/v2/groups'], errors)
  return router
}
