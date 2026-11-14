import { asOptional } from 'cleaners'
import { identifierOf } from './passwordProtocol.js'
import express, {
  Router,
  type Request,
  type Response,
  type RequestHandler,
} from 'express'
import { Store } from '../store.js'
import { text } from '../validation.js'
import { sendShell } from '../node/webRoutes.js'
import { Accounts, sameSecret, type Account, type Session } from './accounts.js'
import { beginSignIn, finishSignIn } from './flow.js'
import { Providers } from './providers.js'
import { asProviderId, type Identity } from './providerConfig.js'

export const SESSION_COOKIE = '__Host-mason-session'
const FLOW_COOKIE = '__Host-mason-oauth'
export const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
}
export function cookie(req: Request, name: string): string | undefined {
  const entries = (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + '='))
  if (entries.length !== 1) return undefined
  const value = entries[0]!.slice(name.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
}
export function returnPath(value: unknown): string {
  // `text` refuses control characters, which the URL parser drops (`/\t/x` is `//x`).
  const path = asOptional(text(1024), '/')(value)
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\#]/.test(path) ||
    path.startsWith('/auth/')
  )
    throw new Error('Invalid return path')
  return path
}
/** A JSON post from this origin's own page; a token alone is not enough. */
export function sameOrigin(req: Request, origin: string | undefined): void {
  const sent = req.get('origin')
  let host: string | undefined
  try {
    host = sent == null ? undefined : new URL(sent).host
  } catch {
    host = undefined
  }
  if (
    host == null ||
    host !== (origin == null ? req.get('host') : new URL(origin).host)
  )
    throw new Error('Untrusted origin')
}
export function csrf(req: Request, store: Store, session: Session): void {
  const origin = req.get('origin')
  // A no-referrer document sends Origin:null for native HTML form POSTs.
  // Fetch Metadata is browser-controlled; a valid session CSRF token is
  // required below for both paths, including clients that can forge headers.
  const privateForm =
    origin === 'null' &&
    req.get('sec-fetch-site') === 'same-origin' &&
    req.get('host') === new URL(store.config.origin).host
  if (origin !== store.config.origin && !privateForm)
    throw new Error('Untrusted origin')
  // The web app sends the proof in a header; its provider-switch form in a field.
  const proof =
    req.get('x-mason-csrf') ??
    (req.body as { csrf?: unknown } | undefined)?.csrf
  if (typeof proof !== 'string' || !sameSecret(proof, session.csrf))
    throw new Error('Invalid request proof')
}
export function sessionContext(
  req: Request,
  accounts: Accounts,
): { account: Account; session: Session } | undefined {
  return accounts.session(cookie(req, SESSION_COOKIE))
}
export function authLimiter(now: () => number): RequestHandler {
  const clients = new Map<string, { count: number; until: number }>()
  let sweepAt = 0
  return (req, res, next) => {
    const time = now()
    if (time >= sweepAt) {
      for (const [key, row] of clients)
        if (row.until <= time) clients.delete(key)
      sweepAt = time + 1000
    }
    const key = req.ip ?? 'unknown'
    const existing = clients.get(key)
    if (existing == null && clients.size >= 10000) {
      res.status(429).send('Please wait before trying again')
      return
    }
    const row =
      existing != null && existing.until > time
        ? existing
        : { count: 0, until: time + 60000 }
    row.count++
    clients.set(key, row)
    if (row.count > 120) {
      res.status(429).send('Please wait before trying again')
      return
    }
    next()
  }
}
export interface AuthOptions {
  /** Who an identity signs in as: the host matches its cache, admitting through the master. */
  login: (
    identity: Identity,
    previousToken: string | undefined,
  ) =>
    | { token: string; session: Session; account: Account }
    | Promise<{ token: string; session: Session; account: Account }>
  /** Invitation links, checked and used by the master (a host). */
  invitation?: {
    /** Whom a token is for: `{ name, username? }`. */
    lookup: (token: unknown) => Promise<unknown>
    /** Uses a token to set the username and password, and signs the person in. */
    accept: (
      value: Record<string, unknown>,
      address: string,
      previousToken: string | undefined,
    ) => Promise<{ token: string; session: Session }>
  }
  /** Username and password sign-in, checked by the master (a host). */
  password?: {
    /** The hashing parameters for a username or an email. */
    parameters: (identifier: unknown) => Promise<unknown>
    signIn: (
      value: { identifier?: unknown; clientHash?: unknown },
      address: string,
      previousToken: string | undefined,
    ) => Promise<{ token: string; session: Session }>
  }
}

/** Username and password sign-in that the master checks (a host's). */
export type PasswordRelay = NonNullable<AuthOptions['password']>

/**
 * How a refused password relay answers: 503 while the master cannot be
 * asked, else 401 with the master's reason (and, for a lock, `retryAt`).
 */
export function passwordRefusal(error: unknown): {
  status: number
  body: { error: string; retryAt?: number }
} {
  const detail = error as Error & { code?: string; retryAt?: number }
  if (detail.code === 'closed' || detail.code === 'timeout')
    return {
      status: 503,
      body: { error: 'Password sign-in needs the master; try again shortly' },
    }
  let body: { error: string; retryAt?: number } = { error: detail.message }
  try {
    body = JSON.parse(detail.message) as typeof body
  } catch {
    // A plain message.
  }
  return { status: 401, body }
}

/**
 * Relays a sign-in's identifier and client hash to the master, then starts
 * this node's session for the account it answers and sets its cookie.
 */
export async function passwordSignIn(
  req: Request,
  res: Response,
  store: Store,
  password: PasswordRelay,
): Promise<{ token: string; session: Session }> {
  const result = await password.signIn(
    {
      identifier: identifierOf(req.body),
      clientHash: (req.body as { clientHash?: unknown } | null)?.clientHash,
    },
    req.ip ?? '',
    cookie(req, SESSION_COOKIE),
  )
  res.cookie(SESSION_COOKIE, result.token, {
    ...cookieOptions,
    maxAge: result.session.expires_at - store.now(),
  })
  return result
}

export function authRoutes(
  store: Store,
  providersOrCurrent: Providers | (() => Providers),
  accounts: Accounts,
  options: AuthOptions,
): Router {
  const router = Router()
  const current = (): Providers =>
    typeof providersOrCurrent === 'function'
      ? providersOrCurrent()
      : providersOrCurrent
  router.use(
    '/auth',
    authLimiter(() => store.now()),
  )
  if (options.password != null) {
    const password = options.password
    const json = express.json({ limit: '4kb' })
    const refused = (res: Response, error: unknown): void => {
      const { status, body } = passwordRefusal(error)
      res.status(status).json(body)
    }
    router.post('/auth/password/parameters', json, async (req, res) => {
      try {
        res.json(await password.parameters(identifierOf(req.body)))
      } catch (error) {
        refused(res, error)
      }
    })
    router.post('/auth/password', json, async (req, res) => {
      try {
        await passwordSignIn(req, res, store, password)
        res.json({ signedIn: true })
      } catch (error) {
        refused(res, error)
      }
    })
  }
  if (options.invitation != null) {
    const invitation = options.invitation
    const json = express.json({ limit: '4kb' })
    const refused = (res: Response, error: unknown): void => {
      const detail = error as Error & { code?: string }
      if (detail.code === 'closed' || detail.code === 'timeout') {
        res.status(503).json({
          error: 'Invitations need the master; try again shortly',
        })
        return
      }
      let message = detail.message
      try {
        message = (JSON.parse(message) as { error: string }).error
      } catch {
        // A plain message.
      }
      res.status(400).json({ error: message })
    }
    router.post('/auth/invite/lookup', json, async (req, res) => {
      try {
        sameOrigin(req, store.config.origin)
        res.json(
          await invitation.lookup(
            (req.body as { token?: unknown } | null)?.token,
          ),
        )
      } catch (error) {
        refused(res, error)
      }
    })
    router.post('/auth/invite', json, async (req, res) => {
      try {
        sameOrigin(req, store.config.origin)
        const result = await invitation.accept(
          (req.body ?? {}) as Record<string, unknown>,
          req.ip ?? '',
          cookie(req, SESSION_COOKIE),
        )
        res.cookie(SESSION_COOKIE, result.token, {
          ...cookieOptions,
          maxAge: result.session.expires_at - store.now(),
        })
        res.json({ signedIn: true })
      } catch (error) {
        refused(res, error)
      }
    })
  }
  const start = async (
    req: Request,
    res: Response,
    confirmed: boolean,
  ): Promise<void> => {
    const id = asProviderId(req.params.provider)
    const provider = current().provider(id)
    const context = sessionContext(req, accounts)
    const destination = returnPath(
      confirmed ? req.body.return : req.query.return,
    )
    if (context != null && !confirmed) {
      const switchable =
        provider.type !== 'oauth2' || provider.switchParameters != null
      sendShell(res, {
        flow: switchable
          ? {
              state: 'switch',
              name: context.account.name,
              provider: { id, name: provider.name },
              csrf: context.session.csrf,
              return: destination,
            }
          : { state: 'switchUnavailable' },
      })
      return
    }
    if (confirmed) {
      if (context == null) throw new Error('Sign in again')
      csrf(req, store, context.session)
    }
    const { target, browser } = await beginSignIn(store, current(), id, {
      destination,
      previousSession: cookie(req, SESSION_COOKIE),
      switchAccount: confirmed,
    })
    res.cookie(FLOW_COOKIE, browser, { ...cookieOptions, maxAge: 600000 })
    // A link avoids browsers applying form-action to an external redirect.
    if (confirmed)
      sendShell(res, {
        flow: { state: 'chooseAccount', provider: provider.name, target },
      })
    else res.redirect(303, target)
  }
  router.get('/auth/start/:provider', async (req, res) => {
    await start(req, res, false)
  })
  router.post('/auth/switch/:provider', async (req, res) => {
    await start(req, res, true)
  })
  router.get('/auth/callback/:provider', async (req, res) => {
    const id = asProviderId(req.params.provider)
    const { identity, destination } = await finishSignIn(store, current(), id, {
      query: new URL(req.originalUrl, store.config.origin).searchParams,
      browser: cookie(req, FLOW_COOKIE),
      session: cookie(req, SESSION_COOKIE),
      claimed: () => res.clearCookie(FLOW_COOKIE, cookieOptions),
    })
    const result = await options.login(identity, cookie(req, SESSION_COOKIE))
    res.cookie(SESSION_COOKIE, result.token, {
      ...cookieOptions,
      maxAge: result.session.expires_at - store.now(),
    })
    res.redirect(303, returnPath(destination))
  })
  return router
}
