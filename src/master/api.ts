import express, {
  Router,
  type ErrorRequestHandler,
  type Request,
  type Response,
} from 'express'
import { LinkError } from '../link/link.js'
import { HandshakeRefused } from '../link/handshake.js'
import { PinMismatch } from '../link/network.js'
import { MasterKeys } from './keys.js'
import { cookie } from '../auth/routes.js'
import {
  checkCsrf,
  MASTER_SESSION_COOKIE,
  sessionActor,
  type MasterAuth,
} from './auth.js'
import type { MasterDatabase } from './database.js'
import { isRunAction, isRunRead, type Forwarder } from './forward.js'
import type { NodeRegistry } from './nodes.js'
import { allow } from './permissions.js'
import { asRole, Forbidden, type Actor } from './roles.js'
import { methodsOf } from './hostSettings.js'
import { Settings, UnknownArea } from './settings.js'

export class NotFound extends Error {}
export class Conflict extends Error {}
export class Unauthorized extends Error {
  constructor() {
    super('An API key is required')
  }
}

export interface ApiContext {
  keys: MasterKeys
  /** Sessions and forwarded host identities, beside bearer keys. */
  credentials?: Credentials
  settings: Settings
  registry: NodeRegistry
  /** What the master knows about a node beyond its record: inventory and update state. */
  nodeDetails?: (fingerprint: string) => Record<string, unknown>
  /** The master's Apple ID session for Xcode downloads. */
  apple?: {
    status(): unknown
    signIn(actor: Actor, appleId: unknown, password: unknown): Promise<unknown>
    code(actor: Actor, code: unknown): Promise<unknown>
  }
}

/** The caller of an API request; set by `authenticate`. */
export function actorOf(res: Response): Actor {
  const actor = res.locals.actor as Actor | undefined
  if (actor == null) throw new Unauthorized()
  return actor
}

/** What `authenticate` checks requests against. */
export interface Credentials {
  keys: MasterKeys
  /** Master sessions; without it only bearer keys are accepted. */
  auth?: MasterAuth
  /** The API socket for requests the host forwards. */
  forwarder?: Forwarder
  database?: MasterDatabase
}

/**
 * Bearer API keys, master sessions (with the CSRF proof on any request
 * that changes something), and, on the API socket only, a host session's
 * account for the four run actions: accepted while the account is enabled
 * and its permission version unchanged, audited as through the host.
 */
export function authenticate(
  credentials: Credentials | MasterKeys,
): express.RequestHandler {
  const { keys, auth, forwarder, database } =
    credentials instanceof MasterKeys ? { keys: credentials } : credentials
  return (req, res, next) => {
    const header = req.get('authorization')
    if (header != null) {
      const match = /^Bearer (\S+)$/.exec(header)
      const key = match == null ? undefined : keys.authenticate(match[1])
      if (key == null) {
        res.status(401).json({ error: 'An API key is required' })
        return
      }
      try {
        res.locals.actor = keys.actor(key)
      } catch (error) {
        res.status(403).json({ error: (error as Error).message })
        return
      }
      next()
      return
    }
    const asserted = forwarder?.asserted(req)
    if (asserted != null && database != null) {
      const row = database.db
        .prepare(
          'SELECT role,disabled,removed_at,permission_version FROM accounts WHERE id=?',
        )
        .get(asserted.accountId) as Record<string, unknown> | undefined
      if (
        row == null ||
        Number(row.disabled) !== 0 ||
        row.removed_at != null ||
        Number(row.permission_version) !== asserted.permissionVersion ||
        (!isRunAction(req.method, req.originalUrl) &&
          !isRunRead(req.method, req.originalUrl))
      ) {
        res.status(403).json({ error: 'The host session is not allowed this' })
        return
      }
      res.locals.actor = {
        role: asRole(row.role),
        accountId: asserted.accountId,
        label: `host:${asserted.accountId}`,
      } satisfies Actor
      next()
      return
    }
    const session =
      forwarder?.forwarded(req) === true
        ? undefined
        : auth?.session(cookie(req, MASTER_SESSION_COOKIE))
    if (session == null) {
      res.status(401).json({ error: 'Sign in or use an API key' })
      return
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method))
      try {
        checkCsrf(req, session)
      } catch (error) {
        res.status(403).json({ error: (error as Error).message })
        return
      }
    res.locals.actor = sessionActor(session)
    next()
  }
}

type Route = (req: Request, res: Response) => Promise<unknown> | unknown

/** Wraps a handler so its result is sent as JSON and its errors mapped. */
export const json =
  (route: Route): express.RequestHandler =>
  (req, res, next) => {
    Promise.resolve(route(req, res)).then((result) => {
      if (!res.headersSent) res.json(result ?? null)
    }, next)
  }

export const apiErrors: ErrorRequestHandler = (error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : 'Request failed'
  const status =
    error instanceof Unauthorized
      ? 401
      : error instanceof Forbidden
        ? 403
        : error instanceof NotFound || error instanceof UnknownArea
          ? 404
          : error instanceof Conflict
            ? 409
            : error instanceof HandshakeRefused ||
                error instanceof PinMismatch ||
                error instanceof LinkError
              ? 502
              : (error as { type?: string }).type === 'entity.too.large'
                ? 413
                : 400
  res.status(status).json({ error: message })
}

/** `/api/v2`: the master's API. */
export function masterApi(context: ApiContext): Router {
  const router = Router()
  router.use(
    '/api/v2',
    express.json({ limit: '1mb' }),
    authenticate(context.credentials ?? context.keys),
  )

  router.get(
    '/api/v2/settings/:area',
    json((req, res) =>
      context.settings.get(actorOf(res), String(req.params.area)),
    ),
  )
  router.put(
    '/api/v2/settings/:area',
    json((req, res) =>
      context.settings.set(actorOf(res), String(req.params.area), req.body),
    ),
  )
  // Merge routes: a Settings card changes its part of an area, and the rest
  // is kept as stored, read at the moment of the save.
  const keepSecrets = (
    methods: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> =>
    methods.map((method) => ({ ...method, clientSecret: { keep: true } }))
  router.put(
    '/api/v2/settings/signIn/methods/:id',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      const id = String(req.params.id)
      const stored = methodsOf(context.settings.value('signIn'))
      const others = keepSecrets(
        stored.filter((method) => method.id !== id) as unknown as Array<
          Record<string, unknown>
        >,
      )
      const at = stored.findIndex((entry) => entry.id === id)
      const body = { ...(req.body as Record<string, unknown>) }
      // The Add forms send create, so an existing method is not replaced by mistake.
      if (body.create != null && at >= 0)
        throw new Error(`A sign-in method named ${id} already exists`)
      delete body.create
      // Fields the card does not show (account switching) stay as stored, for the same type.
      const kept: Record<string, unknown> =
        at < 0 || stored[at]!.type !== body.type
          ? {}
          : { ...(stored[at] as unknown as Record<string, unknown>) }
      delete kept.clientSecret
      const method = { ...kept, ...body, id }
      const methods = [...others]
      methods.splice(at < 0 ? methods.length : at, 0, method)
      return await context.settings.set(actorOf(res), 'signIn', { methods })
    }),
  )
  router.delete(
    '/api/v2/settings/signIn/methods/:id',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      const id = String(req.params.id)
      const stored = methodsOf(context.settings.value('signIn'))
      if (!stored.some((method) => method.id === id))
        throw new NotFound(`No sign-in method ${id}`)
      return await context.settings.set(actorOf(res), 'signIn', {
        methods: keepSecrets(
          stored.filter((method) => method.id !== id) as unknown as Array<
            Record<string, unknown>
          >,
        ),
      })
    }),
  )
  // Node types: one type's card at a time. The validator takes licence
  // acceptance as a boolean and keeps the stored { by, at } only on true, so
  // every type that holds one is sent with true.
  const storedTypes = (): Record<string, Record<string, unknown>> => {
    const stored = (context.settings.value('nodeTypes') ?? {}) as Record<
      string,
      Record<string, unknown>
    >
    const out: Record<string, Record<string, unknown>> = {}
    for (const [name, value] of Object.entries(stored)) {
      const type: Record<string, unknown> = { ...value }
      delete type.androidLicensesAccepted
      if (value.androidLicensesAccepted != null)
        type.androidLicensesAccepted = true
      out[name] = type
    }
    return out
  }
  router.put(
    '/api/v2/settings/nodeTypes/:type',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      const name = String(req.params.type)
      const types = storedTypes()
      const edited: Record<string, unknown> = {
        ...(req.body as Record<string, unknown>),
      }
      // The Add form sends create, so an existing type is not replaced by mistake.
      if (edited.create != null && types[name] != null)
        throw new Error(`A node type named ${name} already exists`)
      delete edited.create
      delete edited.name
      delete edited.androidLicensesAccepted
      if (types[name]?.androidLicensesAccepted === true)
        edited.androidLicensesAccepted = true
      types[name] = edited
      return await context.settings.set(actorOf(res), 'nodeTypes', types)
    }),
  )
  router.delete(
    '/api/v2/settings/nodeTypes/:type',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      const name = String(req.params.type)
      const types = storedTypes()
      if (types[name] == null) throw new NotFound(`No node type ${name}`)
      delete types[name]
      return await context.settings.set(actorOf(res), 'nodeTypes', types)
    }),
  )
  router.put(
    '/api/v2/settings/cloud/budget',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      const budget = (req.body as { monthlyBudget?: unknown } | undefined)
        ?.monthlyBudget
      if (typeof budget !== 'number' || !Number.isFinite(budget))
        throw new Error('monthlyBudget is a number of dollars')
      return await context.settings.set(actorOf(res), 'cloud', {
        ...(context.settings.value('cloud') ?? {}),
        monthlyBudget: budget,
      })
    }),
  )

  router.get(
    '/api/v2/keys',
    json((_req, res) => {
      allow(actorOf(res), 'keys.read')
      return context.keys.list()
    }),
  )
  router.post(
    '/api/v2/keys',
    json((req, res) => {
      res.status(201)
      return context.keys.create(actorOf(res), req.body)
    }),
  )
  router.delete(
    '/api/v2/keys/:id',
    json((req, res) => {
      const id = String(req.params.id)
      allow(actorOf(res), 'keys.revoke')
      if (context.keys.get(id) == null) throw new NotFound('No such key')
      context.keys.revoke(actorOf(res), id)
      return null
    }),
  )

  router.get(
    '/api/v2/nodes',
    json((_req, res) => {
      allow(actorOf(res), 'nodes.read')
      return context.registry.list().map((node) => ({
        ...node,
        ...context.nodeDetails?.(node.fingerprint),
      }))
    }),
  )
  router.post(
    '/api/v2/nodes',
    json(async (req, res) => {
      allow(actorOf(res), 'nodes.change')
      const body = (req.body ?? {}) as { address?: unknown; key?: unknown }
      if (typeof body.address !== 'string' || typeof body.key !== 'string')
        throw new Error('Expected {address, key}')
      try {
        const node = await context.registry.add(body.address, body.key)
        res.status(201)
        return node
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'This node is already paired'
        )
          throw new Conflict(error.message)
        throw error
      }
    }),
  )
  router.delete(
    '/api/v2/nodes/:fingerprint',
    json((req, res) => {
      allow(actorOf(res), 'nodes.change')
      const fingerprint = String(req.params.fingerprint)
      if (context.registry.get(fingerprint) == null)
        throw new NotFound('No such node')
      context.registry.remove(fingerprint)
      return null
    }),
  )
  // The Apple ID session: managers and administrators only. The password is
  // write-only and the session never leaves the master.
  const apple = context.apple
  if (apple != null) {
    router.get(
      '/api/v2/apple/session',
      json((_req, res) => {
        allow(actorOf(res), 'apple.change')
        return apple.status()
      }),
    )
    router.post(
      '/api/v2/apple/session',
      json(async (req, res) => {
        const body = (req.body ?? {}) as {
          appleId?: unknown
          password?: unknown
        }
        return await apple.signIn(actorOf(res), body.appleId, body.password)
      }),
    )
    router.post(
      '/api/v2/apple/session/code',
      json(
        async (req, res) =>
          await apple.code(
            actorOf(res),
            (req.body as { code?: unknown } | null)?.code,
          ),
      ),
    )
  }

  router.use('/api/v2', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })
  router.use('/api/v2', apiErrors)
  return router
}
