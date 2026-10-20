import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { beforeEach, afterEach, describe, it } from 'mocha'
import { asConfig } from '../config.js'
import { Store } from '../store.js'
import { Accounts } from './accounts.js'
import { teamStationSubjectOf } from './teamStationSubject.js'
import { rewriteTeamStationSubjects } from './rewriteTeamStationSubjects.js'

const vectors = JSON.parse(
  readFileSync(
    path.resolve('src/auth/teamStationSubject.vectors.json'),
    'utf8',
  ),
) as {
  accepted: Array<{ value: string; userId: string }>
  rejected: unknown[]
}
describe('TeamStation subject derivation', () => {
  it('matches every applicable shared vector and refuses non-legacy subjects', () => {
    for (const vector of vectors.accepted) {
      if (BigInt(vector.value) <= 9007199254740991n)
        assert.equal(teamStationSubjectOf(vector.value), vector.userId)
      else assert.throws(() => teamStationSubjectOf(vector.value))
    }
    for (const bad of [
      '0',
      '-1',
      '01',
      '1.5',
      '1\n',
      ' 1',
      '9007199254740992',
      ...vectors.rejected,
    ]) {
      // Decimal strings are invalid canonical IDs but are this converter's input.
      if (
        typeof bad === 'string' &&
        bad.trim() === bad &&
        /^[1-9][0-9]*$/.test(bad) &&
        BigInt(bad) <= 9007199254740991n
      )
        continue
      assert.throws(() => teamStationSubjectOf(bad as string))
    }
  })
})

const provider = {
  id: 'teamstation',
  name: 'TeamStation',
  type: 'oidc',
  issuer: 'https://identity.example.test/oauth',
  clientId: 'fixture',
  clientSecret: 'fixture-secret',
}
describe('TeamStation identity subject rewrite', () => {
  let store: Store, accounts: Accounts, root: string
  beforeEach(() => {
    assert(process.env.MASON_TEST_ROOT)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'subjects-'))
    store = new Store(
      asConfig({
        origin: 'https://builds.example.test',
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
        providers: [provider, { ...provider, id: 'other' }],
      }),
    )
    accounts = new Accounts(store)
  })
  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const login = (subject: string, extra = {}): ReturnType<Accounts['login']> =>
    accounts.login({
      provider: provider.id,
      issuer: provider.issuer,
      subject,
      name: 'Hank Aaron',
      email: 'fixture@example.test',
      emailVerified: true,
      ...extra,
    })
  const table = (name: string): Array<Record<string, unknown>> =>
    store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()
  it('previews without mutation, preserves permissions and sessions, and allows sign-in to the same account', () => {
    const first = login('1')
    const second = login('9007199254740991')
    accounts.setAdmin(first.account.id, true)
    login('2', { provider: 'other' })
    login('3', { issuer: 'https://previous.example.test/oauth' })
    for (const subject of [
      '0',
      '01',
      '-1',
      '9007199254740992',
      teamStationSubjectOf('4'),
    ])
      login(subject)
    const preserved = Object.fromEntries(
      ['accounts', 'sessions', 'audit', 'invitations'].map((name) => [
        name,
        table(name),
      ]),
    )
    const original = table('identities')
    const preview = rewriteTeamStationSubjects(store, 'teamstation', false)
    assert.equal(preview.changed, 2)
    assert.deepEqual(table('identities'), original)
    assert.deepEqual(
      rewriteTeamStationSubjects(store, 'teamstation', true),
      preview,
    )
    for (const [name, rows] of Object.entries(preserved))
      assert.deepEqual(table(name), rows)
    assert.equal(
      accounts.login({
        provider: provider.id,
        issuer: provider.issuer,
        subject: teamStationSubjectOf('1'),
        name: 'Hank Aaron',
        emailVerified: false,
      }).account.id,
      first.account.id,
    )
    assert.equal(accounts.session(second.token)?.account.id, second.account.id)
    assert.equal(
      rewriteTeamStationSubjects(store, 'teamstation', true).changed,
      0,
    )
    assert.throws(
      () => rewriteTeamStationSubjects(store, 'unknown', true),
      /Unknown/,
    )
    assert.throws(
      () => rewriteTeamStationSubjects(store, 'INVALID', true),
      /provider/,
    )
  })
  it('keeps both colliding identities while committing unrelated changes and is repeatable', () => {
    const old = login('7'),
      existing = login(teamStationSubjectOf('7'))
    login('8')
    const result = rewriteTeamStationSubjects(store, 'teamstation', true)
    assert.equal(result.changed, 1)
    assert.deepEqual(result.collisions, [
      { accountId: old.account.id, existingAccountId: existing.account.id },
    ])
    assert.equal(accounts.identities(old.account.id)[0]!.subject, '7')
    assert.equal(
      rewriteTeamStationSubjects(store, 'teamstation', true).changed,
      0,
    )
  })
  it('rolls back every rewritten subject if an unrelated database failure occurs', () => {
    login('11')
    login('12')
    const before = table('identities')
    store.db.exec(
      "CREATE TRIGGER reject_fixture BEFORE UPDATE OF subject ON identities WHEN OLD.subject='12' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    )
    assert.throws(
      () => rewriteTeamStationSubjects(store, 'teamstation', true),
      /fixture failure/,
    )
    assert.deepEqual(table('identities'), before)
  })
  it('runs the real CLI in dry-run/apply modes and exits nonzero after committing noncolliding rows', () => {
    const old = login('21'),
      existing = login(teamStationSubjectOf('21'))
    login('22')
    const file = path.join(root, 'config.json')
    writeFileSync(file, JSON.stringify(store.config), { mode: 0o600 })
    const cli = (...flags: string[]): SpawnSyncReturns<string> =>
      spawnSync(
        process.execPath,
        [
          'lib/cli.js',
          'rewrite-teamstation-subjects',
          '--config',
          file,
          ...flags,
        ],
        { encoding: 'utf8' },
      )
    const dry = cli('--provider', 'teamstation')
    assert.equal(dry.status, 1)
    assert.match(dry.stdout, /^\$ mason rewrite-teamstation-subjects/)
    assert.equal(
      accounts.identities().filter((row) => row.subject === '22').length,
      1,
    )
    const applied = cli('--provider', 'teamstation', '--apply')
    assert.equal(applied.status, 1)
    const result = JSON.parse(applied.stdout.trim().split('\n')[1]!)
    assert.equal(result.changed, 1)
    assert.deepEqual(result.collisions, [
      { accountId: old.account.id, existingAccountId: existing.account.id },
    ])
    assert.equal(
      JSON.parse(
        cli('--provider', 'teamstation', '--apply')
          .stdout.trim()
          .split('\n')[1]!,
      ).changed,
      0,
    )
    assert.equal(cli('--provider', 'unknown').status, 1)
    for (const flags of [
      [],
      ['--provider'],
      ['--provider', 'teamstation', '--wrong'],
      ['--provider', 'teamstation', '--apply', '--extra'],
    ])
      assert.equal(cli(...flags).status, 1)
    assert.equal(cli('--provider', 'other').status, 0)
  })
})
