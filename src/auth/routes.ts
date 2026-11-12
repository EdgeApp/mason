import { asOptional, asString } from 'cleaners'
import { identifierOf } from './passwordProtocol.js'
import express, {
  Router,
  type Request,
  type Response,
  type RequestHandler,
} from 'express'
import type { SignInFlow } from '../shared/api/index.js'
import { Store } from '../store.js'
import { asId, integer, object, text } from '../validation.js'
import { breadcrumbs, escape, type Crumb } from '../view/html.js'
import { page, shell, type FramedPage, type Viewer } from '../view/shell.js'
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
  // The web app sends the proof in a header; the pages' forms in a field.
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
const hidden = (session: Session): string =>
  `<input type="hidden" name="csrf" value="${escape(session.csrf)}">`
/** Sign out of this server: a form posting `/auth/logout`. */
export function signOutForm(session: Session): string {
  return `<form method="post" action="/auth/logout">${hidden(session)}<button class="secondary">Sign out</button></form>`
}
/** The standalone server's viewer: its administrators, and everyone else as a tester. */
export function standaloneViewer(context: {
  account: Account
  session: Session
}): Viewer {
  return {
    name: context.account.name,
    role: context.account.is_admin ? 'admin' : 'tester',
    node: 'standalone',
    signOut: signOutForm(context.session),
  }
}
/** Draws a signed-in page in a node's shell, for the person the request is from. */
export type Frame = (req: Request, page: FramedPage) => string
/** The standalone server's shell: Install apps, Devices and, for administrators, People. */
export function standaloneFrame(accounts: Accounts): Frame {
  return (req, framed) => {
    const context = sessionContext(req, accounts)
    return shell({
      title: framed.title,
      body: framed.body,
      ...(context == null ? {} : { viewer: standaloneViewer(context) }),
      ...(framed.active == null ? {} : { active: framed.active }),
      ...(framed.scripts == null ? {} : { scripts: framed.scripts }),
      ...(framed.head == null ? {} : { head: framed.head }),
    })
  }
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
/** Answers the web app's shell, with a provider sign-in's state when there is one. */
export type ShellSender = (
  res: Response,
  options?: { status?: number; flow?: SignInFlow },
) => void

export interface AuthOptions {
  /**
   * The web app, on a host: it draws sign-in, invitations and the provider
   * switch's pages. Without it (the standalone server) those are pages.
   */
  shell?: ShellSender
  /** Who an identity signs in as; the legacy server creates accounts, a host only matches its cache. */
  login?: (
    identity: Identity,
    previousToken: string | undefined,
  ) =>
    | { token: string; session: Session; account: Account }
    | Promise<{ token: string; session: Session; account: Account }>
  /** Whether the People pages are served (not on a host: accounts are managed on the master). */
  people?: boolean
  /** Whether the small Your account page is served (not on a host, which has its own). */
  account?: boolean
  /** How signed-in pages are drawn; the standalone server's shell by default. */
  frame?: Frame
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
  accounts = new Accounts(store),
  options: AuthOptions = {},
): Router {
  const router = Router()
  const frame = options.frame ?? standaloneFrame(accounts)
  /** A signed-in page in this node's shell. */
  const framed = (
    req: Request,
    title: string,
    body: string,
    active?: string,
    /** Its breadcrumbs: the standalone server's own pages (a host serves neither). */
    crumbs?: Crumb[],
  ): string =>
    frame(req, {
      title,
      body: `${crumbs == null ? `<h1>${escape(title)}</h1>` : `<div class="page-head"><div>${breadcrumbs({ node: 'standalone' }, crumbs)}<h1>${escape(title)}</h1></div></div>`}${body}`,
      ...(active == null ? {} : { active }),
    })
  const current = (): Providers =>
    typeof providersOrCurrent === 'function'
      ? providersOrCurrent()
      : providersOrCurrent
  // The legacy server lists its configuration's providers; a host lists its cached ones.
  const configured = (): Providers['providers'] =>
    typeof providersOrCurrent === 'function'
      ? providersOrCurrent().providers
      : store.config.providers
  router.use(
    '/auth',
    authLimiter(() => store.now()),
  )
  router.get('/auth/login', (req, res) => {
    const destination = returnPath(req.query.return)
    // The web app hashes the password (Argon2id in its worker) before it leaves.
    if (options.shell != null) {
      options.shell(res)
      return
    }
    if (
      configured().length === 1 &&
      options.password == null &&
      req.query.signed_out !== '1' &&
      sessionContext(req, accounts) == null
    ) {
      res.redirect(
        303,
        `/auth/start/${configured()[0]!.id}?return=${encodeURIComponent(destination)}`,
      )
      return
    }
    const links = configured()
      .map(
        (provider) =>
          `<a class="button" href="/auth/start/${escape(provider.id)}?return=${encodeURIComponent(destination)}">Sign in with ${escape(provider.name)}</a>`,
      )
      .join('')
    res.send(
      page(
        'Sign in',
        `<section class="card"><p>Sign in to request access to app builds. Access is managed by this Mason server.</p><div class="stack">${links || '<p>No sign-in provider is configured.</p>'}</div></section>`,
      ),
    )
  })
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
    // The web app reads the token from the fragment, then drops it.
    if (options.shell != null)
      router.get('/auth/invite', (_req, res) => {
        options.shell!(res)
      })
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
      if (options.shell != null) {
        options.shell(res, {
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
      if (!switchable) {
        res.send(
          framed(
            req,
            'Switch account unavailable',
            `<section class="card"><p>This provider does not have an account switching method configured. Ask this Mason server's administrator to configure it.</p></section>`,
          ),
        )
        return
      }
      res.send(
        framed(
          req,
          'Switch account',
          `<section class="card"><p>You are signed in as ${escape(context.account.name)}. Continue to choose an account with ${escape(provider.name)}.</p><form method="post" action="/auth/switch/${escape(id)}">${hidden(context.session)}<input type="hidden" name="return" value="${escape(destination)}"><button>Continue and switch account</button></form></section>`,
        ),
      )
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
    if (confirmed && options.shell != null)
      options.shell(res, {
        flow: { state: 'chooseAccount', provider: provider.name, target },
      })
    else if (confirmed) {
      res.send(
        page(
          'Choose an account',
          `<section class="card"><a class="button" href="${escape(target)}">Continue to ${escape(provider.name)}</a></section>`,
        ),
      )
    } else res.redirect(303, target)
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
    const login =
      options.login ??
      ((
        found: Identity,
        token: string | undefined,
      ): ReturnType<Accounts['login']> => accounts.login(found, token))
    const result = await login(identity, cookie(req, SESSION_COOKIE))
    res.cookie(SESSION_COOKIE, result.token, {
      ...cookieOptions,
      maxAge: result.session.expires_at - store.now(),
    })
    res.redirect(303, returnPath(destination))
  })
  router.post('/auth/logout', (req, res) => {
    const context = sessionContext(req, accounts)
    if (context == null) throw new Error('Sign in required')
    csrf(req, store, context.session)
    accounts.logout(cookie(req, SESSION_COOKIE)!)
    res.clearCookie(SESSION_COOKIE, cookieOptions)
    res.redirect(303, '/auth/login?signed_out=1')
  })
  if (options.account !== false)
    // Your account on the standalone server: who is signed in, and Sign out.
    router.get('/account', (req, res) => {
      const context = sessionContext(req, accounts)
      if (context == null) {
        res.redirect(
          303,
          '/auth/login?return=' + encodeURIComponent(req.originalUrl),
        )
        return
      }
      res.send(
        framed(
          req,
          'Your account',
          `<section class="card account"><dl class="account-fields"><dt>Full name</dt><dd>${escape(context.account.name)}</dd><dt>Email</dt><dd>${escape(context.account.email ?? 'No email provided')}</dd><dt>Access</dt><dd>${context.account.is_admin ? 'Administrator' : context.account.is_tester ? 'Tester' : 'Waiting for access'}</dd></dl>${signOutForm(context.session)}</section>`,
          'account',
          [{ label: 'Your account', href: '/account' }],
        ),
      )
    })
  if (options.people === false) return router
  router.get('/people', (req, res) => {
    const context = sessionContext(req, accounts)
    if (context == null || !context.account.is_admin) {
      const denied = '<p>Administrator access is required.</p>'
      res
        .status(403)
        .send(
          context == null
            ? page('Access denied', denied)
            : framed(req, 'Access denied', denied),
        )
      return
    }
    const rows = accounts
      .list()
      .map((account) => {
        const identities = accounts
          .identities(account.id)
          .map((identity) => {
            const provider = store.config.providers.find(
              (item) => item.id === identity.provider,
            )
            const email =
              identity.email == null
                ? 'No email provided'
                : `${escape(identity.email)} · ${identity.email_verified ? 'Verified email' : 'Unverified email — confirm this person before granting access'}`
            return `<p>${email}</p><small>Sign-in provider: ${escape(provider?.name ?? identity.provider)} (${escape(identity.provider)})</small><details><summary>Identity details</summary><small>Issuer: ${escape(identity.issuer)}</small><small>Account reference: ${escape(identity.subject)}</small></details>`
          })
          .join('')
        return `<div class="row"><div><strong>${escape(account.name)}</strong>${identities || '<p>No sign-in identity available</p>'}<small>${account.disabled ? 'Disabled' : account.is_admin ? 'Administrator' : account.is_tester ? 'Tester' : 'Waiting for access'}</small></div>${account.is_admin ? '' : `<form method="post" action="/people/${account.id}/tester">${hidden(context.session)}<input type="hidden" name="enabled" value="${account.is_tester ? 'false' : 'true'}"><button class="${account.is_tester ? 'danger' : 'secondary'}">${account.is_tester ? 'Revoke tester' : 'Grant tester'}</button></form>`}</div>`
      })
      .join('')
    const invites = accounts
      .invitations()
      .map(
        (invite) =>
          `<div class="row"><div><strong>${escape(invite.email)}</strong><small>${escape(invite.provider)} · ${invite.revoked ? 'Revoked' : invite.claimed_account != null ? 'Claimed' : invite.expires_at <= store.now() ? 'Expired' : 'Awaiting first sign-in'}</small></div>${invite.revoked || invite.claimed_account != null ? '' : `<form method="post" action="/people/invitations/${invite.id}/revoke">${hidden(context.session)}<button class="secondary">Revoke invitation</button></form>`}</div>`,
      )
      .join('')
    const choices = store.config.providers
      .map(
        (provider) =>
          `<option value="${escape(provider.id)}">${escape(provider.name)}</option>`,
      )
      .join('')
    res.send(
      framed(
        req,
        'People',
        `<section class="card"><h2>Preapprove a tester</h2><p>They can sign in for the first time using a verified email address from the selected provider. This does not send an email.</p><form method="post" action="/people/invitations">${hidden(context.session)}<label for="provider">Sign-in provider</label><select id="provider" name="provider">${choices}</select><label for="email">Email address</label><input id="email" name="email" type="email" required><label for="days">Expires in days</label><input id="days" name="days" type="number" min="1" max="365" value="30" required><p><button>Preapprove tester</button></p></form></section><section class="card"><h2>Accounts</h2>${rows}</section><section class="card"><h2>Preapprovals</h2>${invites || '<p>No preapprovals yet.</p>'}</section>`,
        'people',
        [{ label: 'People', href: '/people' }],
      ),
    )
  })
  router.post('/people/:id/tester', (req, res) => {
    const context = sessionContext(req, accounts)
    if (context == null) throw new Error('Sign in required')
    csrf(req, store, context.session)
    const input = object({
      csrf: asString,
      enabled: (value: unknown): boolean => {
        if (value !== 'true' && value !== 'false')
          throw new Error('Invalid choice')
        return value === 'true'
      },
    })(req.body)
    accounts.setTester(
      context.account.id,
      asId(Number(req.params.id)),
      input.enabled,
    )
    res.redirect(303, '/people')
  })
  router.post('/people/invitations', (req, res) => {
    const context = sessionContext(req, accounts)
    if (context == null) throw new Error('Sign in required')
    csrf(req, store, context.session)
    const input = object({
      csrf: asString,
      provider: asProviderId,
      email: asString,
      days: asString,
    })(req.body)
    accounts.invite(
      context.account.id,
      input.provider,
      input.email,
      integer(1, 365)(Number(input.days)),
    )
    res.send(
      framed(
        req,
        'Tester preapproved',
        `<section class="card"><p>The account can sign in with its verified email before the preapproval expires.</p><p>Share this sign-in link:</p><p><a href="${escape(store.config.origin + '/auth/login')}">${escape(store.config.origin + '/auth/login')}</a></p><a href="/people">Back to People</a></section>`,
        'people',
      ),
    )
  })
  router.post('/people/invitations/:id/revoke', (req, res) => {
    const context = sessionContext(req, accounts)
    if (context == null) throw new Error('Sign in required')
    csrf(req, store, context.session)
    accounts.revokeInvitation(context.account.id, asId(Number(req.params.id)))
    res.redirect(303, '/people')
  })
  return router
}
