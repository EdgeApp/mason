import type { Accounts, Account, Session } from '../auth/accounts.js'
import type { Identity } from '../auth/providerConfig.js'
import type { HostCache } from './cache.js'

export class SignInRefused extends Error {
  override name = 'SignInRefused'
}

/**
 * Host sign-in: the provider must assert a verified email that matches,
 * case-insensitively and exactly, an enabled account's address for that same
 * provider, and the provider must be enabled on the master. The identity and
 * the session are recorded on the host only; nothing is written to the master.
 */
export function hostLogin(
  cache: HostCache,
  accounts: Accounts,
): (
  identity: Identity,
  previousToken: string | undefined,
) => { token: string; session: Session; account: Account } {
  return (identity, previousToken) => {
    if (
      !cache.signInMethods().some((method) => method.id === identity.provider)
    )
      throw new SignInRefused(`${identity.provider} sign-in is not enabled`)
    if (!identity.emailVerified || identity.email == null)
      throw new SignInRefused('The provider did not confirm a verified email')
    const found = cache.db
      .prepare(
        'SELECT a.id FROM account_addresses x JOIN accounts a ON a.id=x.account_id WHERE x.method=? AND lower(x.email)=lower(?) AND a.disabled=0',
      )
      .get(identity.provider, identity.email) as { id: number } | undefined
    if (found == null)
      throw new SignInRefused(
        `No Mason account has ${identity.email} for ${identity.provider}`,
      )
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
