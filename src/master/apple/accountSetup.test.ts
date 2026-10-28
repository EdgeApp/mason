import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { pinnedFetch } from '../../node/pinnedFetch.js'
import { cluster, type Cluster } from '../../test/cluster.js'
import { FakeApple } from '../../test/fakeApple.js'
import {
  FakeAppleConnect,
  fakeConnectKey,
  fakeSigningCertificate,
} from '../../test/fakeAppleConnect.js'
import { MASTER_SESSION_COOKIE } from '../auth.js'
import { localOperator } from '../roles.js'
import type {
  CertificateKind,
  CertificateView,
} from '../../apple/certificates.js'
import { FakeAppleWebSession } from '../../test/fakeAppleWebSession.js'
import {
  AppleSetup,
  type AppleSetupOptions,
  AppleWebError,
  AppStoreConnectWeb,
} from './accountSetup.js'

/** Apple setup over the fake website, with the master's key store and certificates in memory. */
function harness(options: { createFails?: Error } = {}): {
  apple: FakeAppleWebSession
  setup: AppleSetup
  keys: Map<
    string,
    { issuerId: string; keyId: string; privateKey: string; name: string }
  >
  certificates: CertificateView[]
} {
  const apple = new FakeAppleWebSession()
  const keys = new Map<
    string,
    { issuerId: string; keyId: string; privateKey: string; name: string }
  >()
  const certificates: CertificateView[] = []
  const setupOptions: AppleSetupOptions = {
    web: () =>
      new AppStoreConnectWeb(apple.request, 'https://asc.example.test'),
    teamKey: (team) => keys.get(team),
    saveTeamKey: async (team, key) => {
      keys.set(team, key)
    },
    certificate: (team, kind) =>
      certificates.find((entry) => entry.team === team && entry.kind === kind),
    createCertificate: async (team: string, kind: CertificateKind) => {
      if (options.createFails != null) throw options.createFails
      const made = {
        id: certificates.length + 1,
        team,
        kind,
        serial: '01',
        name: 'Apple Distribution: Example',
        sha1: 'AA',
        expiresAt: 0,
        source: 'created',
        revoked: false,
      } as CertificateView
      certificates.push(made)
      return made
    },
    appleCertificates: async () => [
      'Apple Distribution: One (expires 2027-01-01)',
      'Apple Distribution: Two (expires 2027-02-01)',
    ],
    fingerprint: 'mldsa65:AbCdEfGh123',
  }
  const setup = new AppleSetup(setupOptions)
  return { apple, setup, keys, certificates }
}

describe('Apple setup from an Apple ID', () => {
  it('U8.1 with one team, makes the key named for this master, stores it, and makes the distribution certificate', async () => {
    const { apple, setup, keys, certificates } = harness()
    assert.equal(setup.keyName, 'Mason AbCdEfGh')
    assert.deepEqual(await setup.teams(), [
      { id: 'ABCDE12345', name: 'Example Team' },
    ])
    const result = await setup.setup()
    assert.equal(result.key, 'created')
    assert.equal(result.certificate, 'created')
    assert.deepEqual(result.team, { id: 'ABCDE12345', name: 'Example Team' })
    const stored = keys.get('ABCDE12345')!
    assert.equal(stored.issuerId, apple.teams[0]!.publicProviderId)
    assert.equal(stored.keyId, result.keyId)
    assert.match(stored.privateKey, /BEGIN PRIVATE KEY/)
    assert.equal(apple.keys[0]!.nickname, 'Mason AbCdEfGh')
    assert.equal(certificates.length, 1)
    // The only team is already the session's: no switch.
    assert(!apple.calls.includes('POST /olympus/v1/session'))
  })

  it('U8.2 with several teams, nothing is made until one is picked', async () => {
    const { apple, setup, keys } = harness()
    apple.teams.push({
      providerId: 2,
      publicProviderId: 'b2c3d4e5-0000-0000-0000-000000000000',
      name: 'Other Team',
      teamId: 'ZYXWV98765',
    })
    await assert.rejects(setup.setup(), /Choose the team to set up/)
    await assert.rejects(setup.setup('NOTATEAM00'), /not in team NOTATEAM00/)
    assert.equal(apple.keys.length, 0)
    const result = await setup.setup('ZYXWV98765')
    assert.equal(result.team.name, 'Other Team')
    assert(apple.calls.includes('POST /olympus/v1/session'))
    assert.equal(
      keys.get('ZYXWV98765')!.issuerId,
      'b2c3d4e5-0000-0000-0000-000000000000',
    )
    assert.equal(apple.keys[0]!.team, 2)
    assert(keys.has('ZYXWV98765'))
    apple.teams.length = 0
    await assert.rejects(setup.setup(), /belongs to no developer team/)
  })

  it('U8.3 setting up again makes nothing; a key named for this master without its stored key is replaced', async () => {
    const { apple, setup, keys, certificates } = harness()
    const first = await setup.setup()
    const again = await setup.setup()
    assert.equal(again.key, 'kept')
    assert.equal(again.certificate, 'kept')
    assert.equal(apple.keys.length, 1)
    assert.equal(certificates.length, 1)
    // A database restored from before the key was made.
    keys.delete('ABCDE12345')
    const replaced = await setup.setup()
    assert.equal(replaced.key, 'replaced')
    assert.notEqual(replaced.keyId, first.keyId)
    assert.equal(
      apple.keys.find((key) => key.id === first.keyId)!.active,
      false,
    )
    assert.equal(keys.get('ABCDE12345')!.keyId, replaced.keyId)
  })

  it('U8.4 an Apple ID without the role, and a team without API access, stop setup saying what to do', async () => {
    const { apple, setup } = harness()
    apple.refuse = 403
    await assert.rejects(
      setup.setup(),
      /must be the team’s Account Holder or an Admin, and the team must have App Store Connect API access/,
    )
    apple.refuse = 401
    await assert.rejects(setup.setup(), /sign in with the Apple ID again/)
    apple.refuse = 500
    await assert.rejects(
      setup.setup(),
      /App Store Connect GET \/olympus\/v1\/session: 500/,
    )
    const signedOutOptions: AppleSetupOptions = {
      web: () => undefined,
      teamKey: () => undefined,
      saveTeamKey: async () => undefined,
      certificate: () => undefined,
      createCertificate: async () => {
        throw new Error('unused')
      },
      appleCertificates: async () => [],
      fingerprint: 'mldsa65:x',
    }
    const signedOut = new AppleSetup(signedOutOptions)
    await assert.rejects(signedOut.teams(), /Sign in with the Apple ID first/)
  })

  it('U8.5 Apple’s certificate limit is reported with the existing certificates; nothing is revoked', async () => {
    const { apple, setup } = harness({
      createFails: new Error(
        'You already have a current Distribution certificate or a pending certificate request',
      ),
    })
    await assert.rejects(
      setup.setup(),
      (error: unknown) =>
        error instanceof AppleWebError &&
        /Apple allows no more distribution certificates for Example Team: Apple Distribution: One \(expires 2027-01-01\), Apple Distribution: Two/.test(
          error.message,
        ),
    )
    assert(!apple.calls.some((call) => call.startsWith('PATCH')))
    const { setup: other } = harness({ createFails: new Error('network down') })
    await assert.rejects(other.setup(), /network down/)
  })

  it('U8.6 a key entered by hand that still works is left alone', async () => {
    const { apple, setup, keys } = harness()
    // A person made this key in App Store Connect and entered it on the Apple page.
    apple.current = 1
    apple.keys.push({
      id: 'MANUAL1234',
      nickname: 'CI',
      active: true,
      team: 1,
      downloaded: true,
    })
    keys.set('ABCDE12345', {
      issuerId: apple.teams[0]!.publicProviderId,
      keyId: 'MANUAL1234',
      privateKey: 'pem',
      name: 'Example Team',
    })
    const result = await setup.setup()
    assert.equal(result.key, 'kept')
    assert.equal(result.keyId, 'MANUAL1234')
    assert.equal(apple.keys.length, 1)
    // The website's private key is offered once.
    const web = new AppStoreConnectWeb(
      apple.request,
      'https://asc.example.test',
    )
    await assert.rejects(
      web.downloadKey('MANUAL1234'),
      /no longer offers this key’s private key/,
    )
    await assert.rejects(web.downloadKey('NOSUCHKEY0'), /404/)
  })
})

describe('Apple setup on a master', function () {
  this.timeout(60_000)
  const appleId = 'builds@example.com'
  const password = 'Apple-Password-9'
  const admin = { role: 'admin' as const, label: 'paul' }
  const connectKey = fakeConnectKey()
  const apple = new FakeApple(appleId, password)
  const web = new FakeAppleWebSession()
  const connect = new FakeAppleConnect(connectKey, 'ABCDE12345')
  let c: Cluster
  before(async () => {
    await apple.start()
    await connect.start()
    apple.web = web
    web.teams[0]!.publicProviderId = connectKey.issuerId
    web.nextKeys.push({
      keyId: connectKey.keyId,
      privateKey: connectKey.privateKey,
    })
    c = await cluster(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'apple-setup-'),
      ),
      {
        workers: [],
        master: { testEndpoints: true },
        masterOptions: { appleEndpoints: apple.endpoints },
      },
    )
    await c.master.master!.settings.set(admin, 'apple', {
      endpoints: connect.endpoints,
    })
  })
  after(async () => {
    await c?.close()
    await connect.close()
    await apple.close()
  })

  it('U8.7 sets a team up through the API from the signed-in Apple ID, for managers and admins, shown on Settings', async () => {
    const master = c.master.master!
    const before = await c.api('GET', '/api/v2/apple/setup')
    assert.equal(before.status, 400)
    assert.match(before.text, /Sign in with the Apple ID first/)
    await master.appleSignIn(admin, appleId, password)
    await master.appleCode(admin, apple.code)

    const listed = await c.api('GET', '/api/v2/apple/setup')
    assert.equal(listed.status, 200, listed.text)
    assert.deepEqual(listed.json.teams, [
      { id: 'ABCDE12345', name: 'Example Team' },
    ])
    assert.match(listed.json.keyName, /^Mason [A-Za-z0-9_-]{8}$/)
    // Apple's certificate limit names the team's certificates; nothing is stored.
    connect.refuseCertificates =
      'You already have a current Distribution certificate or a pending certificate request.'
    connect.addCertificate(
      fakeSigningCertificate(
        'Apple Distribution: Old (ABCDE12345)',
        'ABCDE12345',
      ).certificate,
    )
    const limited = await c.api('POST', '/api/v2/apple/setup', {})
    assert.equal(limited.status, 400)
    assert.match(
      limited.text,
      /Apple allows no more distribution certificates for Example Team: [^"]*Apple Distribution: Old \(ABCDE12345\)[^"]* \(expires \d{4}-\d{2}-\d{2}\)\. Revoke one/,
    )
    connect.refuseCertificates = undefined

    const made = await c.api('POST', '/api/v2/apple/setup', { team: '' })
    assert.equal(made.status, 200, made.text)
    assert.deepEqual(made.json, {
      team: { id: 'ABCDE12345', name: 'Example Team' },
      key: 'kept',
      keyId: connectKey.keyId,
      certificate: 'created',
    })
    const stored = master.settings.value('apple') as {
      appleId: string
      teams: Record<string, { keyId: string; issuerId: string; name: string }>
    }
    assert.equal(stored.appleId, appleId)
    assert.equal(stored.teams.ABCDE12345!.issuerId, connectKey.issuerId)
    assert.equal(stored.teams.ABCDE12345!.name, 'Example Team')
    const shown = await c.api('GET', '/api/v2/settings/apple')
    assert(!shown.text.includes('PRIVATE KEY'))
    assert(
      master.appleSigning.certificates.current('ABCDE12345', 'distribution') !=
        null,
    )
    const again = await c.api('POST', '/api/v2/apple/setup', {
      team: 'ABCDE12345',
    })
    assert.equal(again.json.key, 'kept')
    assert.equal(again.json.certificate, 'kept')
    assert.equal(web.keys.length, 1)
    assert(
      (
        master.database.db
          .prepare("SELECT target FROM audit WHERE action='apple.setup'")
          .all() as Array<{ target: string }>
      ).every((row) => row.target === 'ABCDE12345'),
    )

    const developer = master.keys.create(admin, { role: 'developer' }).token
    for (const [method, body] of [
      ['GET', undefined],
      ['POST', {}],
    ] as const)
      assert.equal(
        (await c.api(method, '/api/v2/apple/setup', body, developer)).status,
        403,
      )

    // The Settings page offers the team, and says what is set up.
    const person = (
      await master.people.create(localOperator, {
        email: 'manager.person@example.test',
        name: 'manager person',
        role: 'manager',
        addresses: { google: 'manager@example.test' },
      })
    ).id
    const { token } = master.auth.start(person, '127.0.0.1')
    const page = await pinnedFetch(
      `${c.master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')}/settings`,
      { headers: { cookie: `${MASTER_SESSION_COOKIE}=${token}` } },
      c.master.web!.certificate!.pin,
    )
    const html = await page.text()
    assert.match(html, /Signing for a team/)
    assert.match(html, /data-path="\/api\/v2\/apple\/setup"/)
    assert.match(html, /<option value="ABCDE12345">Example Team \(ABCDE12345\)/)
    // What is set up, and checking again rather than setting up anew.
    assert.match(
      html,
      /Signing is set up for Example Team \(<span class="mono">ABCDE12345<\/span>\): App Store Connect API key <span class="mono">Mason [^<]+<\/span> \(<span class="mono">FAKEKEY123<\/span>\), Apple Distribution: Fake Team \(ABCDE12345\), expires \d{4}-\d{2}-\d{2}\./,
    )
    assert.match(html, /Check signing again/)
    assert.doesNotMatch(html, /<summary>Set up again/)
    assert.doesNotMatch(html, /No team is set up yet/)
    // Signed in, the Apple ID form waits behind "Sign in again", filled in.
    assert.match(
      html,
      /<details class="reveal"><summary class="button secondary">[^<]*(<[^>]+>[^<]*)*Sign in again<\/summary><form[^>]*data-path="\/api\/v2\/apple\/session"/,
    )
    assert.match(html, /id="apple-id"[^>]*value="builds@example\.com"/)
    // A website that refuses is shown, not a broken page.
    web.refuse = 403
    const refused = await pinnedFetch(
      `${c.master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')}/settings`,
      { headers: { cookie: `${MASTER_SESSION_COOKIE}=${token}` } },
      c.master.web!.certificate!.pin,
    )
    assert.match(await refused.text(), /class="state-failed">Apple refused/)
    web.refuse = undefined
  })
})
