import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { asConfig } from '../config.js'
import { Store } from '../store.js'
import { Accounts, sameSecret } from './accounts.js'
import {
  asIdentity,
  asProvider,
  asProviders,
  asProviderId,
} from './providerConfig.js'

const provider = {
  id: 'example',
  name: 'Example',
  type: 'oidc',
  issuer: 'https://identity.example.test/oauth',
  clientId: 'fixture',
  clientSecret: 'fixture-secret',
}
const identity = {
  provider: 'example',
  issuer: provider.issuer,
  subject: '123',
  name: 'Alex Lee',
  email: 'alex@example.test',
  emailVerified: true,
}
let store: Store, accounts: Accounts, root: string, now: number, admin: number
function login(
  subject: string,
  email: string,
  verified = true,
): ReturnType<Accounts['login']> {
  return accounts.login({
    ...identity,
    subject,
    email,
    emailVerified: verified,
  })
}
describe('Mason identities and local access', () => {
  beforeEach(() => {
    assert(process.env.MASON_TEST_ROOT)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'accounts-'))
    now = Date.now()
    store = new Store(
      asConfig({
        origin: 'https://builds.example.test',
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
        providers: [
          provider,
          {
            ...provider,
            id: 'second',
            issuer: 'https://second.example.test/oauth',
          },
        ],
      }),
      () => now,
    )
    accounts = new Accounts(store)
    const first = accounts.login(identity)
    admin = first.account.id
    accounts.setAdmin(admin, true)
  })
  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('uses provider/issuer/subject identities, never an email match, and rotates sessions', () => {
    const first = accounts.login(identity)
    assert.equal(first.account.is_admin, 1)
    const rotated = accounts.login(identity, first.token)
    assert.equal(accounts.session(first.token), undefined)
    assert.equal(accounts.session(rotated.token)?.account.id, admin)
    assert.equal(
      accounts.login({ ...identity, provider: 'second' }).account.is_admin,
      0,
    )
    assert.equal(
      accounts.login({
        ...identity,
        issuer: 'https://different.example.test/oauth',
      }).account.is_admin,
      0,
    )
    assert.equal(
      accounts.login({ ...identity, subject: '456' }).account.is_admin,
      0,
    )
    assert.equal(accounts.list().length, 4)
    assert(sameSecret('a', 'a'))
    assert(!sameSecret('a', 'b'))
    assert.equal(accounts.session(undefined), undefined)
    assert.equal(accounts.session('invalid'), undefined)
    now += 31 * 86400000
    assert.equal(accounts.session(rotated.token), undefined)
  })
  it('claims a verified provider-bound preapproval once and rejects other identities', () => {
    const id = accounts.invite(admin, 'example', ' Jordan@Example.Test ')
    assert.equal(accounts.invitations()[0]?.email, 'jordan@example.test')
    assert.equal(
      login('pending', 'jordan@example.test', false).account.is_tester,
      0,
    )
    assert.equal(login('mismatch', 'else@example.test').account.is_tester, 0)
    assert.equal(
      accounts.login({
        ...identity,
        subject: 'second',
        provider: 'second',
        email: 'jordan@example.test',
      }).account.is_tester,
      0,
    )
    assert.equal(
      accounts.login({
        ...identity,
        subject: 'issuer',
        issuer: 'https://untrusted.example.test/oauth',
        email: 'jordan@example.test',
      }).account.is_tester,
      0,
    )
    const accepted = login('pending', 'jordan@example.test')
    assert.equal(accepted.account.is_tester, 1)
    assert.equal(
      accounts.invitations().find((row) => row.id === id)?.claimed_account,
      accepted.account.id,
    )
    assert.equal(
      login('duplicate', 'jordan@example.test').account.is_tester,
      0,
    )
    assert.throws(() =>
      accounts.invite(admin, 'unknown', 'someone@example.test'),
    )
    assert.throws(() => accounts.invite(admin, 'example', 'broken'))
    assert.throws(() =>
      accounts.invite(admin, 'example', 'someone@example.test', 0),
    )
  })
  it('expires/revokes preapprovals and allows issuing a new expired invitation', () => {
    const id = accounts.invite(admin, 'example', 'expired@example.test', 1)
    assert.throws(() =>
      accounts.invite(admin, 'example', 'expired@example.test'),
    )
    now += 2 * 86400000
    assert.equal(login('late', 'expired@example.test').account.is_tester, 0)
    const replacement = accounts.invite(
      admin,
      'example',
      'expired@example.test',
    )
    assert.notEqual(replacement, id)
    accounts.revokeInvitation(admin, replacement)
    assert.equal(login('later', 'expired@example.test').account.is_tester, 0)
    assert.equal(
      accounts.invitations().find((row) => row.id === replacement)?.revoked,
      1,
    )
    assert.throws(() => accounts.revokeInvitation(admin, 999))
  })
  it('immediately invalidates sessions on revoke and does not revive them after regrant', () => {
    const pending = login('tester', 'tester@example.test')
    accounts.setTester(admin, pending.account.id, true)
    assert.equal(accounts.session(pending.token), undefined)
    const tester = login('tester', 'tester@example.test')
    assert.equal(tester.account.is_tester, 1)
    accounts.setTester(admin, tester.account.id, false)
    assert.equal(accounts.session(tester.token), undefined)
    accounts.setTester(admin, tester.account.id, true)
    assert.equal(accounts.session(tester.token), undefined)
    const latest = login('tester', 'tester@example.test')
    store.db
      .prepare(
        'UPDATE accounts SET permission_version=permission_version+1 WHERE id=?',
      )
      .run(latest.account.id)
    assert.equal(accounts.session(latest.token), undefined)
    assert.throws(() => accounts.setTester(testersId(), admin, true))
    function testersId(): number {
      return latest.account.id
    }
    const active = login('tester', 'tester@example.test')
    accounts.logout(active.token)
    assert.equal(accounts.session(active.token), undefined)
    accounts.logout(active.token)
  })
  it('prevents disabled users and removal of the last enabled administrator', () => {
    assert.throws(() => accounts.setAdmin(admin, false), /final/)
    const other = login('second', 'second@example.test')
    accounts.setAdmin(other.account.id, true)
    accounts.setAdmin(admin, false)
    assert.equal(accounts.account(admin).is_admin, 0)
    assert.throws(
      () => accounts.setTester(admin, other.account.id, true),
      /Administrator/,
    )
    store.db
      .prepare('UPDATE accounts SET disabled=1 WHERE id=?')
      .run(other.account.id)
    assert.equal(accounts.session(other.token), undefined)
    assert.throws(() => login('second', 'second@example.test'), /disabled/)
    assert.throws(() => accounts.setAdmin(other.account.id, true), /disabled/)
    assert.throws(
      () =>
        accounts.invite(other.account.id, 'example', 'third@example.test'),
      /Administrator/,
    )
  })
  it('validates config and identity data at the trust boundary', () => {
    for (const id of ['../bad', 'Two', '', false])
      assert.throws(() => asProviderId(id))
    assert.throws(() => asProviders([provider, provider]))
    assert.throws(() => asProvider({ ...provider, unexpected: true }))
    assert.throws(() => asProvider({ ...provider, type: 'custom' }))
    assert.throws(() => asIdentity({ ...identity, emailVerified: 'true' }))
    assert.throws(() => asIdentity({ ...identity, email: 'invalid' }))
    assert.equal(
      asProvider({
        ...provider,
        type: 'oauth2',
        authorizationEndpoint: 'https://example.test/auth',
        tokenEndpoint: 'https://example.test/token',
        userinfoEndpoint: 'https://example.test/user',
        scopes: ['profile'],
        claims: { subject: 'id' },
      }).type,
      'oauth2',
    )
    assert.equal(
      accounts.login({
        ...identity,
        subject: 'no-email',
        email: undefined,
        emailVerified: false,
      }).account.email,
      undefined,
    )
  })
})
