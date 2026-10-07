import { asObject, asOptional, asString } from 'cleaners'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Store, digest } from '../store.js'
import {
  asFlag,
  asId,
  asHttps,
  integer,
  text,
  type Cleaner,
} from '../validation.js'
import {
  asEmail,
  asIdentity,
  asProviderId,
  type Identity,
} from './providerConfig.js'

const nullable =
  <T>(clean: Cleaner<T>): Cleaner<T | undefined> =>
  (value) =>
    value === null ? undefined : asOptional(clean)(value)
export const asAccount = asObject({
  id: asId,
  name: text(120),
  email: nullable(asEmail),
  is_admin: asFlag,
  is_tester: asFlag,
  disabled: asFlag,
  permission_version: integer(),
  created_at: integer(),
})
export type Account = ReturnType<typeof asAccount>
export const asSession = asObject({
  hash: asString,
  account_id: asId,
  permission_version: integer(),
  csrf: asString,
  created_at: integer(),
  expires_at: integer(),
})
export type Session = ReturnType<typeof asSession>
export const asInvitation = asObject({
  id: asId,
  provider: asProviderId,
  issuer: asHttps,
  email: asEmail,
  creator: asId,
  created_at: integer(),
  expires_at: integer(),
  revoked: asFlag,
  claimed_account: nullable(asId),
})
export const randomToken = (): string => randomBytes(32).toString('base64url')
export function sameSecret(left: string, right: string): boolean {
  return timingSafeEqual(
    Buffer.from(digest(left), 'hex'),
    Buffer.from(digest(right), 'hex'),
  )
}
export class Accounts {
  constructor(readonly store: Store) {}
  account(id: number): Account {
    return asAccount(
      this.store.db
        .prepare('SELECT * FROM accounts WHERE id=?')
        .get(asId(id)),
    )
  }
  list(): Account[] {
    return this.store.db
      .prepare(
        'SELECT * FROM accounts ORDER BY created_at DESC,id DESC LIMIT 500',
      )
      .all()
      .map(asAccount)
  }
  login(
    value: unknown,
    previousToken?: string,
  ): { token: string; session: Session; account: Account } {
    const identity = asIdentity(value)
    return this.store.transaction(() => {
      const found = this.store.db
        .prepare(
          'SELECT account_id FROM identities WHERE provider=? AND issuer=? AND subject=?',
        )
        .get(identity.provider, identity.issuer, identity.subject)
      let id: number
      if (found == null) {
        id = asId(
          Number(
            this.store.db
              .prepare(
                'INSERT INTO accounts(name,email,created_at) VALUES(?,?,?)',
              )
              .run(identity.name, identity.email ?? null, this.store.now())
              .lastInsertRowid,
          ),
        )
        this.store.db
          .prepare(
            'INSERT INTO identities(account_id,provider,issuer,subject,email,email_verified) VALUES(?,?,?,?,?,?)',
          )
          .run(
            id,
            identity.provider,
            identity.issuer,
            identity.subject,
            identity.email ?? null,
            Number(identity.emailVerified),
          )
      } else {
        id = asObject({ account_id: asId })(found).account_id
        if (this.account(id).disabled) throw new Error('Account is disabled')
        this.store.db
          .prepare(
            'UPDATE identities SET email=?,email_verified=? WHERE account_id=? AND provider=? AND issuer=? AND subject=?',
          )
          .run(
            identity.email ?? null,
            Number(identity.emailVerified),
            id,
            identity.provider,
            identity.issuer,
            identity.subject,
          )
        this.store.db
          .prepare('UPDATE accounts SET name=?,email=? WHERE id=?')
          .run(identity.name, identity.email ?? null, id)
      }
      this.claimInvitation(identity, id)
      if (previousToken != null)
        this.store.db
          .prepare('DELETE FROM sessions WHERE hash=?')
          .run(digest(previousToken))
      const account = this.account(id)
      const token = randomToken()
      const session = {
        hash: digest(token),
        account_id: id,
        permission_version: account.permission_version,
        csrf: randomToken(),
        created_at: this.store.now(),
        expires_at:
          this.store.now() + this.store.config.sessionDays * 86400000,
      }
      this.store.db
        .prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)')
        .run(
          session.hash,
          id,
          session.permission_version,
          session.csrf,
          session.created_at,
          session.expires_at,
        )
      this.audit(id, 'login', String(id))
      return { token, session, account }
    })
  }
  private claimInvitation(identity: Identity, id: number): void {
    if (!identity.emailVerified || identity.email == null) return
    const row = this.store.db
      .prepare(
        'SELECT * FROM invitations WHERE provider=? AND issuer=? AND email=? AND revoked=0 AND claimed_account IS NULL AND expires_at>?',
      )
      .get(
        identity.provider,
        identity.issuer,
        identity.email,
        this.store.now(),
      )
    if (row == null) return
    const invite = asInvitation(row)
    this.store.db
      .prepare(
        'UPDATE invitations SET claimed_account=? WHERE id=? AND claimed_account IS NULL',
      )
      .run(id, invite.id)
    this.store.db
      .prepare(
        'UPDATE accounts SET is_tester=1,permission_version=permission_version+1 WHERE id=?',
      )
      .run(id)
    this.store.db.prepare('DELETE FROM sessions WHERE account_id=?').run(id)
    this.audit(id, 'invitation.claim', String(invite.id))
  }
  session(
    token: string | undefined,
  ): { account: Account; session: Session } | undefined {
    if (token == null || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    return this.sessionHash(digest(token))
  }
  sessionHash(
    hash: string,
  ): { account: Account; session: Session } | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM sessions WHERE hash=? AND expires_at>?')
      .get(hash, this.store.now())
    if (row == null) return undefined
    const session = asSession(row)
    const account = this.account(session.account_id)
    if (
      account.disabled ||
      account.permission_version !== session.permission_version
    )
      return undefined
    return { account, session }
  }
  logout(token: string): void {
    const context = this.session(token)
    if (context == null) return
    this.store.transaction(() => {
      this.store.db
        .prepare('DELETE FROM sessions WHERE hash=?')
        .run(context.session.hash)
      this.audit(context.account.id, 'logout', String(context.account.id))
    })
  }
  requireAdmin(id: number): Account {
    const account = this.account(id)
    if (!account.is_admin || account.disabled)
      throw new Error('Administrator required')
    return account
  }
  setTester(actor: number, target: number, enabled: boolean): void {
    this.store.transaction(() => {
      this.requireAdmin(actor)
      this.account(target)
      this.store.db
        .prepare(
          'UPDATE accounts SET is_tester=?,permission_version=permission_version+1 WHERE id=?',
        )
        .run(Number(enabled), target)
      this.store.db
        .prepare('DELETE FROM sessions WHERE account_id=?')
        .run(target)
      this.audit(
        actor,
        enabled ? 'tester.grant' : 'tester.revoke',
        String(target),
      )
    })
  }
  setAdmin(target: number, enabled: boolean): void {
    this.store.transaction(() => this.changeAdmin(target, enabled))
  }
  private changeAdmin(target: number, enabled: boolean): void {
    const account = this.account(target)
    if (account.disabled) throw new Error('Account is disabled')
    if (!enabled && account.is_admin) {
      const count = asObject({ total: integer() })(
        this.store.db
          .prepare(
            'SELECT COUNT(*) total FROM accounts WHERE is_admin=1 AND disabled=0',
          )
          .get(),
      ).total
      if (count <= 1) throw new Error('Cannot remove the final administrator')
    }
    this.store.db
      .prepare(
        'UPDATE accounts SET is_admin=?,permission_version=permission_version+1 WHERE id=?',
      )
      .run(Number(enabled), target)
    this.store.db
      .prepare('DELETE FROM sessions WHERE account_id=?')
      .run(target)
    this.audit(
      undefined,
      enabled ? 'admin.grant' : 'admin.revoke',
      String(target),
    )
  }
  /** Local operator only: match a previously authenticated, verified identity. */
  promote(provider: string, subject: string, email: string): number {
    const configured = this.store.config.providers.find(
      (item) => item.id === asProviderId(provider),
    )
    if (configured == null) throw new Error('Unknown provider')
    return this.store.transaction(() => {
      const row = asObject({ account_id: asId })(
        this.store.db
          .prepare(
            'SELECT account_id FROM identities WHERE provider=? AND issuer=? AND subject=? AND email=? AND email_verified=1',
          )
          .get(
            provider,
            configured.issuer,
            text(256)(subject),
            asEmail(email),
          ),
      )
      this.changeAdmin(row.account_id, true)
      return row.account_id
    })
  }
  identities(accountId?: number): Array<{
    account_id: number
    provider: string
    issuer: string
    subject: string
    email?: string
    email_verified: number
  }> {
    return this.store.db
      .prepare(
        'SELECT account_id,provider,issuer,subject,email,email_verified FROM identities WHERE (? IS NULL OR account_id=?) ORDER BY account_id LIMIT 1000',
      )
      .all(accountId == null ? null : asId(accountId), accountId ?? null)
      .map(
        asObject({
          account_id: asId,
          provider: asProviderId,
          issuer: asHttps,
          subject: text(256),
          email: nullable(asEmail),
          email_verified: asFlag,
        }),
      )
  }
  prune(): void {
    this.store.transaction(() => {
      this.store.db
        .prepare('DELETE FROM sessions WHERE expires_at<=?')
        .run(this.store.now())
      this.store.db
        .prepare('DELETE FROM install_grants WHERE expires_at<=?')
        .run(this.store.now())
      this.store.db
        .prepare('DELETE FROM oauth_transactions WHERE expires_at<=?')
        .run(this.store.now())
    })
  }
  invite(actor: number, provider: string, email: string, days = 30): number {
    provider = asProviderId(provider)
    email = asEmail(email)
    days = integer(1, 365)(days)
    const providerConfig = this.store.config.providers.find(
      (item) => item.id === provider,
    )
    if (providerConfig == null) throw new Error('Unknown provider')
    return this.store.transaction(() => {
      this.requireAdmin(actor)
      this.store.db
        .prepare(
          'UPDATE invitations SET revoked=1 WHERE provider=? AND issuer=? AND email=? AND expires_at<=? AND claimed_account IS NULL',
        )
        .run(provider, providerConfig.issuer, email, this.store.now())
      const id = asId(
        Number(
          this.store.db
            .prepare(
              'INSERT INTO invitations(provider,issuer,email,creator,created_at,expires_at) VALUES(?,?,?,?,?,?)',
            )
            .run(
              provider,
              providerConfig.issuer,
              email,
              actor,
              this.store.now(),
              this.store.now() + days * 86400000,
            ).lastInsertRowid,
        ),
      )
      this.audit(actor, 'invitation.create', String(id))
      return id
    })
  }
  revokeInvitation(actor: number, id: number): void {
    this.store.transaction(() => {
      this.requireAdmin(actor)
      asInvitation(
        this.store.db
          .prepare('SELECT * FROM invitations WHERE id=?')
          .get(asId(id)),
      )
      this.store.db
        .prepare('UPDATE invitations SET revoked=1 WHERE id=?')
        .run(id)
      this.audit(actor, 'invitation.revoke', String(id))
    })
  }
  invitations(): Array<ReturnType<typeof asInvitation>> {
    return this.store.db
      .prepare(
        'SELECT * FROM invitations ORDER BY created_at DESC,id DESC LIMIT 500',
      )
      .all()
      .map(asInvitation)
  }
  audit(actor: number | undefined, action: string, target: string): void {
    this.store.db
      .prepare('INSERT INTO audit(actor,action,target,at) VALUES(?,?,?,?)')
      .run(
        actor ?? null,
        text(80)(action),
        text(256)(target),
        this.store.now(),
      )
  }
}
