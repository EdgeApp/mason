import type { DatabaseSync } from 'node:sqlite'
import { asObject, asString } from 'cleaners'
import { digest } from '../store.js'
import { integer, text } from '../validation.js'
import { randomToken, sameSecret } from './accounts.js'
import type { Identity } from './providerConfig.js'
import type { Providers } from './providers.js'

/** Where provider sign-ins wait for their callback: a host's cache or the master's database. */
export interface FlowStore {
  readonly db: DatabaseSync
  now(): number
  transaction<T>(body: () => T): T
}

/** How long a browser has to come back from the provider. */
const FLOW_MS = 600000

/**
 * Starts a provider sign-in: a state, PKCE verifier and nonce kept (hashed
 * state) for ten minutes, bound to a browser secret for its cookie and to
 * the session it had. Answers where to send the browser.
 */
export async function beginSignIn(
  store: FlowStore,
  providers: Providers,
  id: string,
  options: {
    destination: string
    previousSession: string | undefined
    switchAccount?: boolean
  },
): Promise<{ target: string; browser: string }> {
  const provider = providers.provider(id)
  const state = randomToken(),
    verifier = randomToken(),
    nonce = randomToken(),
    browser = randomToken()
  const target = await providers.authorize(
    id,
    { state, verifier, nonce },
    options.switchAccount === true,
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
        options.destination,
        store.now() + FLOW_MS,
        options.previousSession == null
          ? null
          : digest(options.previousSession),
      )
  })
  return { target, browser }
}

/**
 * Finishes a provider sign-in from its callback: the transaction its state
 * names is used once, must belong to this browser and provider, and the
 * browser's session must not have changed meanwhile. Answers whom the
 * provider asserted and where the browser was going.
 */
export async function finishSignIn(
  store: FlowStore,
  providers: Providers,
  id: string,
  callback: {
    query: URLSearchParams
    browser: string | undefined
    session: string | undefined
    /** Called once the transaction is used up, before the provider is asked. */
    claimed?: () => void
  },
): Promise<{ identity: Identity; destination: string }> {
  const provider = providers.provider(id)
  const states = callback.query.getAll('state')
  const state = text(128)(states.length === 1 ? states[0] : undefined)
  const browser = callback.browser
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
    if (
      row.previous_session !==
      (callback.session == null ? undefined : digest(callback.session))
    )
      throw new Error('Account changed during login')
    store.db
      .prepare('DELETE FROM oauth_transactions WHERE hash=?')
      .run(row.hash)
    return row
  })
  callback.claimed?.()
  const address = new URL(providers.redirectUri(id))
  for (const [key, value] of callback.query)
    address.searchParams.append(key, value)
  const identity = await providers.identity(id, address, {
    state,
    verifier: transaction.verifier,
    nonce: transaction.nonce,
  })
  return { identity, destination: transaction.return_path }
}
