import { asObject, asOptional, asString } from 'cleaners'
import {
  Router,
  type Request,
  type Response,
  type RequestHandler,
} from 'express'
import { Store, digest } from '../store.js'
import { asId, integer, object, text } from '../validation.js'
import { escape, page } from '../view.js'
import {
  Accounts,
  randomToken,
  sameSecret,
  type Account,
  type Session,
} from './accounts.js'
import { Providers } from './providers.js'
import { asProviderId, type Identity } from './providerConfig.js'

export const SESSION_COOKIE = '__Host-mason-session'
const FLOW_COOKIE = '__Host-mason-oauth'
const cookieOptions = {
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
  const proof = asObject({ csrf: asString })(req.body).csrf
  if (!sameSecret(proof, session.csrf)) throw new Error('Invalid request proof')
}
export function sessionContext(
  req: Request,
  accounts: Accounts,
): { account: Account; session: Session } | undefined {
  return accounts.session(cookie(req, SESSION_COOKIE))
}
const hidden = (session: Session): string =>
  `<input type="hidden" name="csrf" value="${escape(session.csrf)}">`
export function navigation(session: Session, account: Account): string {
  return `${account.is_admin ? '<a href="/people">People</a>' : ''}<a class="button register-device" href="/devices">Register Device</a><form method="post" action="/auth/logout">${hidden(session)}<button class="secondary">Sign out</button></form>`
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
  /** Who an identity signs in as; the legacy server creates accounts, a host only matches its cache. */
  login?: (
    identity: Identity,
    previousToken: string | undefined,
  ) => { token: string; session: Session; account: Account }
  /** Whether the People pages are served (not on a host: accounts are managed on the master). */
  people?: boolean
}

export function authRoutes(
  store: Store,
  providersOrCurrent: Providers | (() => Providers),
  accounts = new Accounts(store),
  options: AuthOptions = {},
): Router {
  const router = Router()
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
    if (
      configured().length === 1 &&
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
      if (provider.type === 'oauth2' && provider.switchParameters == null) {
        res.send(
          page(
            'Switch account unavailable',
            `<section class="card"><p>This provider does not have an account switching method configured. Ask this Mason server's administrator to configure it.</p></section>`,
            navigation(context.session, context.account),
          ),
        )
        return
      }
      res.send(
        page(
          'Switch account',
          `<section class="card"><p>You are signed in as ${escape(context.account.name)}. Continue to choose an account with ${escape(provider.name)}.</p><form method="post" action="/auth/switch/${escape(id)}">${hidden(context.session)}<input type="hidden" name="return" value="${escape(destination)}"><button>Continue and switch account</button></form></section>`,
          navigation(context.session, context.account),
        ),
      )
      return
    }
    if (confirmed) {
      if (context == null) throw new Error('Sign in again')
      csrf(req, store, context.session)
    }
    const state = randomToken(),
      verifier = randomToken(),
      nonce = randomToken(),
      browser = randomToken()
    const target = await current().authorize(
      id,
      { state, verifier, nonce },
      confirmed,
    )
    store.transaction(() => {
      store.db
        .prepare('DELETE FROM oauth_transactions WHERE expires_at<=?')
        .run(store.now())
      store.db
        .prepare('INSERT INTO oauth_transactions VALUES(?,?,?,?,?,?,?,?,?)')
        .run(
          digest(state),
          digest(browser),
          id,
          provider.issuer,
          verifier,
          nonce,
          destination,
          store.now() + 600000,
          cookie(req, SESSION_COOKIE) == null
            ? null
            : digest(cookie(req, SESSION_COOKIE)!),
        )
    })
    res.cookie(FLOW_COOKIE, browser, { ...cookieOptions, maxAge: 600000 })
    if (confirmed) {
      // A link avoids browsers applying form-action to an external redirect.
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
    const provider = current().provider(id)
    const state = text(128)(req.query.state)
    const browser = cookie(req, FLOW_COOKIE)
    if (browser == null) throw new Error('Missing browser transaction')
    const transaction = store.transaction(() => {
      const row = asObject({
        hash: asString,
        browser_hash: asString,
        provider: asString,
        issuer: asString,
        verifier: asString,
        nonce: asString,
        return_path: asString,
        expires_at: integer(),
        previous_session: (value: unknown): string | undefined =>
          value === null ? undefined : asString(value),
      })(
        store.db
          .prepare(
            'SELECT * FROM oauth_transactions WHERE hash=? AND expires_at>?',
          )
          .get(digest(state), store.now()),
      )
      if (
        row.provider !== id ||
        row.issuer !== provider.issuer ||
        !sameSecret(row.browser_hash, digest(browser))
      )
        throw new Error('Wrong browser transaction')
      const current = cookie(req, SESSION_COOKIE)
      if (
        row.previous_session !== (current == null ? undefined : digest(current))
      )
        throw new Error('Account changed during login')
      store.db
        .prepare('DELETE FROM oauth_transactions WHERE hash=?')
        .run(row.hash)
      return row
    })
    res.clearCookie(FLOW_COOKIE, cookieOptions)
    const callback = new URL(current().redirectUri(id))
    for (const [key, value] of new URL(req.originalUrl, store.config.origin)
      .searchParams)
      callback.searchParams.append(key, value)
    const identity = await current().identity(id, callback, {
      state,
      verifier: transaction.verifier,
      nonce: transaction.nonce,
    })
    const login =
      options.login ??
      ((
        found: Identity,
        token: string | undefined,
      ): ReturnType<Accounts['login']> => accounts.login(found, token))
    const result = login(identity, cookie(req, SESSION_COOKIE))
    res.cookie(SESSION_COOKIE, result.token, {
      ...cookieOptions,
      maxAge: result.session.expires_at - store.now(),
    })
    res.redirect(303, returnPath(transaction.return_path))
  })
  router.post('/auth/logout', (req, res) => {
    const context = sessionContext(req, accounts)
    if (context == null) throw new Error('Sign in required')
    csrf(req, store, context.session)
    accounts.logout(cookie(req, SESSION_COOKIE)!)
    res.clearCookie(SESSION_COOKIE, cookieOptions)
    res.redirect(303, '/auth/login?signed_out=1')
  })
  if (options.people === false) return router
  router.get('/people', (req, res) => {
    const context = sessionContext(req, accounts)
    if (context == null || !context.account.is_admin) {
      res
        .status(403)
        .send(page('Access denied', '<p>Administrator access is required.</p>'))
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
      page(
        'People',
        `<section class="card"><h2>Preapprove a tester</h2><p>They can sign in for the first time using a verified email address from the selected provider. This does not send an email.</p><form method="post" action="/people/invitations">${hidden(context.session)}<label for="provider">Sign-in provider</label><select id="provider" name="provider">${choices}</select><label for="email">Email address</label><input id="email" name="email" type="email" required><label for="days">Expires in days</label><input id="days" name="days" type="number" min="1" max="365" value="30" required><p><button>Preapprove tester</button></p></form></section><section class="card"><h2>Accounts</h2>${rows}</section><section class="card"><h2>Preapprovals</h2>${invites || '<p>No preapprovals yet.</p>'}</section>`,
        navigation(context.session, context.account),
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
      page(
        'Tester preapproved',
        `<section class="card"><p>The account can sign in with its verified email before the preapproval expires.</p><p>Share this sign-in link:</p><p><a href="${escape(store.config.origin + '/auth/login')}">${escape(store.config.origin + '/auth/login')}</a></p><a href="/people">Back to People</a></section>`,
        navigation(context.session, context.account),
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
