import type { Accounts, Account, Session } from '../auth/accounts.js'
import type { Identity } from '../auth/providerConfig.js'
import type { Projected } from '../master/changes.js'
import type { HostCache } from './cache.js'

export class SignInRefused extends Error {
  override name = 'SignInRefused'
}

/**
 * Host sign-in: the provider must assert a verified email that matches an
 * enabled account, or, when that method admits testers, the master creates
 * one. The session is recorded on the host.
 */
export function hostLogin(
  cache: HostCache,
  accounts: Accounts,
  admit?: (identity: Identity) => Promise<{ account: Projected }>,
): (
  identity: Identity,
  previousToken: string | undefined,
) => Promise<{ token: string; session: Session; account: Account }> {
  const accountFor = (email: string): { id: number } | undefined =>
    cache.db
      .prepare(
        'SELECT a.id FROM account_emails x JOIN accounts a ON a.id=x.account_id WHERE x.email=? AND x.confirmed=1 AND a.disabled=0',
      )
      .get(email) as { id: number } | undefined
  return async (identity, previousToken) => {
    if (
      !cache.signInMethods().some((method) => method.id === identity.provider)
    )
      throw new SignInRefused(`${identity.provider} sign-in is not enabled`)
    if (!identity.emailVerified || identity.email == null)
      throw new SignInRefused('The provider did not confirm a verified email')
    const email = identity.email
    let found = accountFor(email)
    if (found == null) {
      if (!cache.admitsTesters(identity.provider) || admit == null)
        throw new SignInRefused(
          `No Mason account has ${identity.email} for ${identity.provider}`,
        )
      try {
        cache.ensureAccount((await admit(identity)).account)
      } catch (error) {
        throw new SignInRefused(
          error instanceof SignInRefused
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Sign-in failed',
        )
      }
      found = accountFor(email)
      if (found == null)
        throw new SignInRefused(
          `No Mason account has ${identity.email} for ${identity.provider}`,
        )
    }
    return cache.store.transaction(() => {
      cache.db
        .prepare(
          'INSERT INTO identities(account_id,provider,issuer,subject,email,email_verified) VALUES(?,?,?,?,?,1) ON CONFLICT(provider,issuer,subject) DO UPDATE SET account_id=excluded.account_id,email=excluded.email,email_verified=1',
        )
        .run(
          found.id,
          identity.provider,
          identity.issuer,
          identity.subject,
          identity.email ?? null,
        )
      return accounts.startSession(found.id, previousToken)
    })
  }
}
