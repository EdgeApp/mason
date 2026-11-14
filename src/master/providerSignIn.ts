import { Router, type Request, type Response } from 'express'
import { beginSignIn, finishSignIn } from '../auth/flow.js'
import {
  asProviderId,
  type Identity,
  type ProviderConfig,
} from '../auth/providerConfig.js'
import { Providers } from '../auth/providers.js'
import { authLimiter, cookie, returnPath } from '../auth/routes.js'
import { sendShell } from '../node/webRoutes.js'
import { sessionCookieOptions } from './accountsApi.js'
import { MASTER_SESSION_COOKIE, type MasterAuth } from './auth.js'
import type { MasterDatabase } from './database.js'
import { clientAddress } from './forward.js'
import { methodsOf } from './hostSettings.js'
import { asRole } from './roles.js'
import type { Settings } from './settings.js'

/** The browser's half of a provider sign-in on the master; the host's has its own name. */
export const MASTER_FLOW_COOKIE = '__Host-mason-master-oauth'

/** A provider sign-in the master turns down, with a reason the person may see. */
export class ProviderRefused extends Error {
  override name = 'ProviderRefused'
}

/**
 * Provider sign-in on the master's own pages: the enabled sign-in methods,
 * with callbacks at the master's public origin (the `master` setting). With
 * no origin set the master offers only username and password.
 */
export class ProviderSignIn {
  private cache: { key: string; providers: Providers } | undefined
  constructor(
    private readonly options: {
      database: MasterDatabase
      settings: Settings
      auth: MasterAuth
      /** How the master reaches providers; a fixture in tests. */
      transport?: typeof fetch
    },
  ) {}

  /** The master's public origin, when one is set. */
  origin(): string | undefined {
    const origin = this.options.settings.value('master')?.origin
    return typeof origin === 'string' ? origin : undefined
  }

  /** The enabled sign-in methods. */
  methods(): ProviderConfig[] {
    return methodsOf(this.options.settings.value('signIn'))
      .filter((method) => method.enabled)
      .map(({ enabled: _enabled, ...provider }) => provider as ProviderConfig)
  }

  /** The methods offered on the master: none without its origin. */
  offered(): ProviderConfig[] {
    return this.origin() == null ? [] : this.methods()
  }

  /** The providers with the master's callbacks, or undefined without its origin. */
  providers(): Providers | undefined {
    const origin = this.origin()
    if (origin == null) return undefined
    const methods = this.methods()
    const key = JSON.stringify([origin, methods])
    if (this.cache?.key !== key)
      this.cache = {
        key,
        providers: new Providers(origin, methods, this.options.transport),
      }
    return this.cache.providers
  }

  /**
   * Whom an identity signs in as: the provider must be enabled and assert a
   * verified email that is, ignoring case, one of an enabled person's
   * confirmed emails. Nothing about the identity is stored.
   */
  account(identity: Identity): number {
    if (!this.methods().some((method) => method.id === identity.provider))
      throw new ProviderRefused(`${identity.provider} sign-in is not enabled`)
    if (!identity.emailVerified || identity.email == null)
      throw new ProviderRefused('The provider did not confirm a verified email')
    const found = this.options.database.db
      .prepare(
        'SELECT a.id,a.role FROM account_emails x JOIN accounts a ON a.id=x.account_id WHERE x.email=? AND x.confirmed=1 AND a.disabled=0 AND a.removed_at IS NULL LIMIT 1',
      )
      .get(identity.email) as { id: number; role: string } | undefined
    if (found == null)
      throw new ProviderRefused(
        `No Mason account has ${identity.email} for ${identity.provider}`,
      )
    const id = Number(found.id)
    this.options.database.audit(
      { role: asRole(found.role), accountId: id, label: `account:${id}` },
      'session.provider',
      identity.provider,
    )
    return id
  }
}

/** Why a sign-in failed, as the web app shows it: a refusal's own reason, otherwise nothing that could leak. */
function failed(res: Response, error: unknown): void {
  sendShell(res, {
    status: error instanceof ProviderRefused ? 403 : 400,
    flow: {
      state: 'failed',
      message:
        error instanceof ProviderRefused
          ? error.message
          : 'The sign-in is invalid or has expired.',
    },
  })
}

/**
 * `/auth/start/:provider` and `/auth/callback/:provider` on the master. The
 * browser makes every redirect; the master only calls the provider's token
 * and user-info endpoints. The flow runs on the master's origin, so a
 * browser that opened the master at another address is sent there first.
 */
export function providerSignInRoutes(master: {
  configured: () => boolean
  database: MasterDatabase
  auth: MasterAuth
  providerSignIn: ProviderSignIn
}): Router {
  const router = Router()
  const signIn = master.providerSignIn
  router.use(
    '/auth',
    authLimiter(() => master.database.now()),
  )
  const available = (req: Request, res: Response): Providers | undefined => {
    const providers = signIn.providers()
    if (!master.configured() || providers == null) {
      sendShell(res, { status: 404, flow: { state: 'unavailable' } })
      return undefined
    }
    providers.provider(asProviderId(req.params.provider))
    return providers
  }
  router.get('/auth/start/:provider', async (req, res) => {
    try {
      const providers = available(req, res)
      if (providers == null) return
      const id = asProviderId(req.params.provider)
      if (req.get('host') !== new URL(providers.origin).host) {
        res.redirect(303, providers.origin + req.originalUrl)
        return
      }
      const previous = cookie(req, MASTER_SESSION_COOKIE)
      if (master.auth.session(previous) != null) {
        res.redirect(303, '/')
        return
      }
      const { target, browser } = await beginSignIn(
        master.database,
        providers,
        id,
        {
          destination: returnPath(req.query.return),
          previousSession: undefined,
        },
      )
      res.cookie(MASTER_FLOW_COOKIE, browser, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 600000,
      })
      res.redirect(303, target)
    } catch (error) {
      failed(res, error)
    }
  })
  router.get('/auth/callback/:provider', async (req, res) => {
    try {
      const providers = available(req, res)
      if (providers == null) return
      const { identity, destination } = await finishSignIn(
        master.database,
        providers,
        asProviderId(req.params.provider),
        {
          query: new URL(req.originalUrl, providers.origin).searchParams,
          browser: cookie(req, MASTER_FLOW_COOKIE),
          session: undefined,
          claimed: () =>
            res.clearCookie(MASTER_FLOW_COOKIE, {
              httpOnly: true,
              secure: true,
              sameSite: 'lax',
              path: '/',
            }),
        },
      )
      const id = signIn.account(identity)
      const { token, session } = master.auth.start(id, clientAddress(req))
      res.cookie(
        MASTER_SESSION_COOKIE,
        token,
        sessionCookieOptions(session.expiresAt),
      )
      // The session cookie is SameSite=Strict: a redirect continuing the
      // provider's cross-site navigation would arrive without it, so the web
      // app moves on from the master's own origin.
      sendShell(res, {
        flow: { state: 'signedIn', next: returnPath(destination) },
      })
    } catch (error) {
      failed(res, error)
    }
  })
  return router
}
