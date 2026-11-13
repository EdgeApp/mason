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

// Replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

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

describe('Apple setup when the master stops', function () {
  this.timeout(60_000)
  it('U8.14 stop() waits for a team setup that has started, and starts no app setup after it', async () => {
    const appleId = 'stop@example.com'
    const password = 'Apple-Password-9'
    const connectKey = fakeConnectKey()
    const apple = new FakeApple(appleId, password)
    const web = new FakeAppleWebSession()
    const connect = new FakeAppleConnect(connectKey, 'ABCDE12345')
    await apple.start()
    await connect.start()
    apple.web = web
    apple.twoFactor = false
    web.teams[0]!.publicProviderId = connectKey.issuerId
    web.nextKeys.push({
      keyId: connectKey.keyId,
      privateKey: connectKey.privateKey,
    })
    const c = await cluster(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'apple-stop-'),
      ),
      {
        workers: [],
        master: { testEndpoints: true },
        masterOptions: { appleEndpoints: apple.endpoints },
      },
    )
    try {
      const master = c.master.master!
      const admin = { role: 'admin' as const, label: 'paul' }
      await master.settings.set(admin, 'apple', {
        endpoints: connect.endpoints,
      })
      let release = (): void => undefined
      web.hold = {
        path: /^\/iris\/v1\/apiKeys$/,
        until: new Promise((resolve) => {
          release = resolve
        }),
      }
      assert.equal(
        (await master.appleSignIn(admin, appleId, password)).state,
        'signedIn',
      )
      await c.until(
        () =>
          web.calls.includes('GET /iris/v1/apiKeys') &&
          master.appleTeamsInSetup().includes('ABCDE12345'),
        20_000,
        'the team setup',
      )
      const state: { stopped: boolean; certificate?: unknown } = {
        stopped: false,
      }
      const stopping = master.stop().then(() => {
        state.stopped = true
        state.certificate = master.appleSigning.certificates.current(
          'ABCDE12345',
          'distribution',
        )
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(state.stopped, false)
      web.hold = undefined
      release()
      await stopping
      // The setup finished before stop() did; no app setup followed it.
      assert(state.certificate != null)
      assert.equal(web.keys.length, 1)
    } finally {
      await c.close()
      await connect.close()
      await apple.close()
    }
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

  /** Settings → Apple as a manager reads it: the page is the web app's. */
  let settingsToken: string | undefined
  const settingsPage = async (): Promise<Json> => {
    const master = c.master.master!
    if (settingsToken == null) {
      const person = (
        await master.people.create(localOperator, {
          emails: ['manager.person@example.test', 'manager@example.test'],
          name: 'manager person',
          role: 'manager',
        })
      ).id
      settingsToken = master.auth.start(person, '127.0.0.1').token
    }
    const get = async (route: string): ReturnType<typeof pinnedFetch> =>
      await pinnedFetch(
        `${c.master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')}${route}`,
        { headers: { cookie: `${MASTER_SESSION_COOKIE}=${settingsToken}` } },
        c.master.web!.certificate!.pin,
      )
    const page = await get('/settings')
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<div id="root"><\/div>/)
    const signing = await get('/api/v2/apple/signing')
    assert.equal(signing.status, 200)
    return await signing.json()
  }
  const setups = (): Array<{ target: string; via: string }> =>
    c.master
      .master!.database.db.prepare(
        "SELECT target,via FROM audit WHERE action='apple.setup' ORDER BY id",
      )
      .all() as Array<{ target: string; via: string }>
  /** A sign-in Apple asks no code for, as from a trusted device. */
  const signInTrusted = async (): Promise<void> => {
    apple.twoFactor = false
    try {
      const status = await c.master.master!.appleSignIn(
        admin,
        appleId,
        password,
      )
      assert.equal(status.state, 'signedIn')
    } finally {
      apple.twoFactor = true
    }
  }
  /** Waits for the sign-in's background setup to read the teams, and a little more. */
  const settled = async (from: number): Promise<void> => {
    await c.until(
      () =>
        web.calls
          .slice(from)
          .includes('POST /services-account/QH65B2/account/listTeams.action'),
      20_000,
      'the teams read',
    )
    await c.until(
      () => c.master.master!.appleTeamsInSetup().length === 0,
      20_000,
      'the team setups',
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const distribution = (team: string): CertificateView | undefined =>
    c.master.master!.appleSigning.certificates.current(team, 'distribution')
  const signingNotices = (): string[] =>
    c.master
      .master!.notices()
      .filter((notice) => /^(Signing for|Mason could not read)/.test(notice))

  it('U8.7 signing in with a code sets the team up in the background; a failure is a notice until a setup succeeds; Settings shows it', async () => {
    const master = c.master.master!
    const before = await c.api('GET', '/api/v2/apple/setup')
    assert.equal(before.status, 400)
    assert.match(before.text, /Sign in with the Apple ID first/)
    // Apple's certificate limit stops the first setup.
    connect.refuseCertificates =
      'You already have a current Distribution certificate or a pending certificate request.'
    connect.addCertificate(
      fakeSigningCertificate(
        'Apple Distribution: Old (ABCDE12345)',
        'ABCDE12345',
      ).certificate,
    )
    assert.equal(
      (await master.appleSignIn(admin, appleId, password)).state,
      'needsCode',
    )
    assert.equal(web.calls.length, 0)
    // The code's answer does not wait for the setup, which Apple holds.
    let release = (): void => undefined
    web.hold = {
      path: /listTeams/,
      until: new Promise((resolve) => {
        release = resolve
      }),
    }
    const signedIn = await c.api('POST', '/api/v2/apple/session/code', {
      code: apple.code,
    })
    assert.equal(signedIn.status, 200, signedIn.text)
    assert.equal(signedIn.json.state, 'signedIn')
    await c.until(
      () =>
        web.calls.includes(
          'POST /services-account/QH65B2/account/listTeams.action',
        ),
      20_000,
      'the setup starting',
    )
    assert.equal(web.keys.length, 0)
    web.hold = undefined
    release()

    const notice = await c.until(
      () => signingNotices()[0],
      20_000,
      'the setup notice',
    )
    assert.match(
      notice,
      /^Signing for Example Team \(ABCDE12345\) is not set up: Apple allows no more distribution certificates for Example Team: [^"]*Apple Distribution: Old \(ABCDE12345\)[^"]* \(expires \d{4}-\d{2}-\d{2}\)\. Revoke one .*then check signing again\.$/,
    )
    // The key was made and stored before Apple refused the certificate.
    assert.equal(web.keys.length, 1)
    assert.equal(distribution('ABCDE12345'), undefined)
    assert.deepEqual(setups(), [])
    const failed = await settingsPage()
    // The team's failure is shown with its own button to set it up again.
    assert.match(
      failed.failures.ABCDE12345,
      /^Signing for Example Team \(ABCDE12345\) is not set up: Apple allows no more/,
    )
    assert(
      failed.setup.teams.some(
        (team: Json) =>
          team.id === 'ABCDE12345' && team.name === 'Example Team',
      ),
    )
    // Its key may be stored, but it holds no distribution certificate.
    assert.equal(
      (failed.setup.configured as Json[]).find(
        (team) => team.id === 'ABCDE12345',
      )?.certificate,
      undefined,
    )
    connect.refuseCertificates = undefined

    // Checking again goes through the same setup, and clears the notice.
    const made = await c.api('POST', '/api/v2/apple/setup', { team: '' })
    assert.equal(made.status, 200, made.text)
    assert.deepEqual(made.json, {
      team: { id: 'ABCDE12345', name: 'Example Team' },
      key: 'kept',
      keyId: connectKey.keyId,
      certificate: 'created',
    })
    assert.deepEqual(signingNotices(), [])
    const stored = master.settings.value('apple') as {
      appleId: string
      teams: Record<string, { keyId: string; issuerId: string; name: string }>
    }
    assert.equal(stored.appleId, appleId)
    assert.equal(stored.teams.ABCDE12345!.issuerId, connectKey.issuerId)
    assert.equal(stored.teams.ABCDE12345!.name, 'Example Team')
    const shown = await c.api('GET', '/api/v2/settings/apple')
    assert(!shown.text.includes('PRIVATE KEY'))
    assert(distribution('ABCDE12345') != null)
    const again = await c.api('POST', '/api/v2/apple/setup', {
      team: 'ABCDE12345',
    })
    assert.equal(again.json.key, 'kept')
    assert.equal(again.json.certificate, 'kept')
    assert.equal(web.keys.length, 1)
    assert.equal(setups().length, 2)
    assert(setups().every((row) => row.target === 'ABCDE12345'))

    const developer = master.keys.create(admin, { role: 'developer' }).token
    for (const [method, body] of [
      ['GET', undefined],
      ['POST', {}],
    ] as const)
      assert.equal(
        (await c.api(method, '/api/v2/apple/setup', body, developer)).status,
        403,
      )

    // The Settings page says what is set up, and offers checking again.
    const signing = await settingsPage()
    assert.deepEqual(signing.setup.teams, [
      { id: 'ABCDE12345', name: 'Example Team' },
    ])
    assert.match(signing.setup.keyName, /^Mason /)
    const team = signing.setup.configured.find(
      (entry: Json) => entry.id === 'ABCDE12345',
    )
    assert.equal(team.name, 'Example Team')
    assert.equal(team.keyId, 'FAKEKEY123')
    assert.equal(
      team.certificate.name,
      'Apple Distribution: Fake Team (ABCDE12345)',
    )
    assert.equal(typeof team.certificate.expiresAt, 'number')
    assert.deepEqual(signing.failures, {})
    // Signed in, the Apple ID form is filled in for signing in again.
    assert.equal(signing.signedIn, true)
    assert.equal(signing.appleId, 'builds@example.com')
    // A website that refuses is shown, not a broken page.
    web.refuse = 403
    assert.match((await settingsPage()).setup.error, /Apple refused/)
    web.refuse = undefined
  })

  it('U8.8 signing in again leaves a team with a stored key alone', async () => {
    const from = web.calls.length
    const audited = setups().length
    await signInTrusted()
    await settled(from)
    assert(!web.calls.slice(from).some((call) => call.includes('/iris/')))
    assert.equal(setups().length, audited)
    assert.equal(web.keys.length, 1)
  })

  it('U8.9 signing in without a code sets the only team up once, though it signs in twice at once, audited as the person who signed in', async () => {
    const master = c.master.master!
    // A master restored without the team's key or certificate.
    master.appleSigning.certificates.remove(distribution('ABCDE12345')!.id)
    await master.settings.set(admin, 'apple', { teams: null })
    const next = { ...connectKey, keyId: 'FAKEKEY456' }
    connect.teamKeys.push({ team: 'ABCDE12345', key: next })
    web.nextKeys.push({ keyId: next.keyId, privateKey: next.privateKey })
    await master.apple.signOut()
    const from = web.calls.length
    const made = web.keys.length
    apple.twoFactor = false
    const both = await Promise.all([
      master.appleSignIn(admin, appleId, password),
      master.appleSignIn(admin, appleId, password),
    ]).finally(() => {
      apple.twoFactor = true
    })
    assert.deepEqual(
      both.map((status) => status.state),
      ['signedIn', 'signedIn'],
    )
    await settled(from)
    await c.until(
      () =>
        web.calls
          .slice(from)
          .filter(
            (call) =>
              call === 'POST /services-account/QH65B2/account/listTeams.action',
          ).length >= 4,
      20_000,
      'both setups',
    )
    await c.until(
      () => master.appleTeamsInSetup().length === 0,
      20_000,
      'the team setups',
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    // One key and one certificate, whichever setup made them.
    assert.equal(web.keys.length, made + 1)
    assert.equal(
      master.appleSigning.certificates
        .list()
        .filter(
          (entry) =>
            entry.team === 'ABCDE12345' && entry.kind === 'distribution',
        ).length,
      1,
    )
    assert(distribution('ABCDE12345') != null)
    const stored = master.settings.value('apple') as {
      teams: Record<string, { keyId: string }>
    }
    assert.equal(stored.teams.ABCDE12345!.keyId, 'FAKEKEY456')
    // The old key named for this master was revoked for the new one.
    assert.equal(
      web.keys.find((key) => key.id === connectKey.keyId)!.active,
      false,
    )
    assert.deepEqual(
      { ...setups().at(-1) },
      { target: 'ABCDE12345', via: 'paul' },
    )
    assert.deepEqual(signingNotices(), [])
  })

  it('U8.10 of several teams, only those this master uses are set up by themselves and another from its button; a failed one is set up again at the next sign-in; one the Apple ID left is forgotten', async () => {
    const master = c.master.master!
    const other = { ...fakeConnectKey(), keyId: 'OTHERKEY12' }
    web.teams.push({
      providerId: 2,
      publicProviderId: other.issuerId,
      name: 'Other Team',
      teamId: 'ZYXWV98765',
    })
    connect.teamKeys.push({ team: 'ZYXWV98765', key: other })
    const first = { ...connectKey, keyId: 'FAKEKEY789' }
    connect.teamKeys.push({ team: 'ABCDE12345', key: first })
    web.nextKeys.push(
      { keyId: other.keyId, privateKey: other.privateKey },
      { keyId: first.keyId, privateKey: first.privateKey },
    )
    master.appleSigning.certificates.remove(distribution('ABCDE12345')!.id)
    await master.settings.set(admin, 'apple', { teams: null })
    const audited = setups().length
    const stored = (): Record<string, { keyId: string; issuerId: string }> =>
      (
        master.settings.value('apple') as {
          teams?: Record<string, { keyId: string; issuerId: string }>
        }
      ).teams ?? {}
    // Neither team is one this master uses yet: nothing is made.
    let from = web.calls.length
    await signInTrusted()
    await settled(from)
    assert(!web.calls.slice(from).some((call) => call.includes('/iris/')))
    assert.deepEqual(stored(), {})
    let signing = await settingsPage()
    // Each team is offered, not set up, with its own Set up button.
    assert.deepEqual(
      (signing.setup.teams as Json[]).map((team) => team.id).sort(),
      ['ABCDE12345', 'ZYXWV98765'],
    )
    assert.deepEqual(signing.setup.configured, [])

    // An app ID assigned to a team makes it one this master uses.
    master.projects.save(admin, 'edge', {
      name: 'Edge',
      repository: 'https://github.com/a/edge',
    })
    master.projects.addApp(admin, 'edge', {
      bundleId: 'app.example.other',
      name: 'Other',
      platforms: ['ios'],
      apple: { team: 'ZYXWV98765' },
    })
    from = web.calls.length
    await signInTrusted()
    await settled(from)
    assert.equal(stored().ZYXWV98765!.keyId, 'OTHERKEY12')
    assert.equal(stored().ZYXWV98765!.issuerId, other.issuerId)
    assert.equal(stored().ABCDE12345, undefined)
    assert.equal(
      distribution('ZYXWV98765')!.name,
      'Apple Distribution: Fake Team (ZYXWV98765)',
    )
    // The other team's button sets it up.
    const made = await c.api('POST', '/api/v2/apple/setup', {
      team: 'ABCDE12345',
    })
    assert.equal(made.status, 200, made.text)
    assert.equal(made.json.key, 'replaced')
    assert.equal(stored().ABCDE12345!.keyId, 'FAKEKEY789')
    assert(distribution('ABCDE12345') != null)
    assert.deepEqual(
      setups()
        .slice(audited)
        .map((row) => row.target),
      ['ZYXWV98765', 'ABCDE12345'],
    )
    signing = await settingsPage()
    assert.deepEqual(
      (signing.setup.configured as Json[]).map((team) => team.name).sort(),
      ['Example Team', 'Other Team'],
    )
    assert.deepEqual(signing.failures, {})
    // With several teams, checking again names one.
    const unnamed = await c.api('POST', '/api/v2/apple/setup', {})
    assert.equal(unnamed.status, 400)
    assert.match(unnamed.text, /Choose the team to set up/)

    // A team whose last setup failed is tried again, though its key is stored.
    master.appleSigning.certificates.remove(distribution('ZYXWV98765')!.id)
    master.appleSigning.setupFailed(
      { id: 'ZYXWV98765', name: 'Other Team' },
      'Apple was down',
    )
    assert.deepEqual(signingNotices(), [
      'Signing for Other Team (ZYXWV98765) is not set up: Apple was down',
    ])
    from = web.calls.length
    await signInTrusted()
    await settled(from)
    assert(distribution('ZYXWV98765') != null)
    assert.deepEqual(signingNotices(), [])
    assert.equal(setups().at(-1)!.target, 'ZYXWV98765')
    assert.equal(stored().ZYXWV98765!.keyId, 'OTHERKEY12')

    // A team the Apple ID no longer belongs to leaves no notice behind.
    master.appleSigning.setupFailed(
      { id: 'GONE123456', name: 'Gone Team' },
      'Apple was down',
    )
    assert.equal(signingNotices().length, 1)
    from = web.calls.length
    await signInTrusted()
    await settled(from)
    assert.deepEqual(signingNotices(), [])
  })

  it('U8.11 a sign-in whose teams cannot be read says so until they can', async () => {
    const master = c.master.master!
    web.refuse = 403
    await signInTrusted()
    await c.until(() => signingNotices().length > 0, 20_000, 'the teams notice')
    assert.match(
      signingNotices()[0]!,
      /^Mason could not read the Apple ID’s teams to set signing up: Apple refused/,
    )
    web.refuse = undefined
    // Settings shows it, though Apple answers again, until a sign-in reads the teams.
    assert.match(
      (await settingsPage()).failures[''],
      /^Mason could not read the Apple ID’s teams/,
    )
    const from = web.calls.length
    await signInTrusted()
    await settled(from)
    assert.deepEqual(signingNotices(), [])
    assert.equal(master.apple.status().state, 'signedIn')
  })

  it('U8.12 a 401 from App Store Connect ends the session; a 403 does not', async () => {
    const master = c.master.master!
    // A 403 is the Apple ID's role or the team's API access.
    web.refuse = 403
    await assert.rejects(
      master.appleSetup.teams(),
      /must be the team’s Account Holder or an Admin/,
    )
    assert.equal(master.apple.status().state, 'signedIn')
    // Apple no longer takes the session: it is expired, and says sign in again.
    web.refuse = 401
    const refused = await c.api('GET', '/api/v2/apple/setup')
    assert.equal(refused.status, 400)
    assert.match(refused.text, /sign in with the Apple ID again/)
    const session = await c.api('GET', '/api/v2/apple/session')
    assert.equal(session.json.state, 'expired')
    assert.match(session.json.notice, /has lapsed: sign in again/)
    assert.match(session.json.error, /401 from \/olympus\/v1\/session/)
    assert(master.notices().some((notice) => /has lapsed/.test(notice)))
    const lapsed = await settingsPage()
    assert.equal(lapsed.signedIn, false)
    assert.equal(lapsed.setup, undefined)
    // A sign-in whose setup Apple answers 401 ends the same way, with no team notice.
    await signInTrusted()
    await c.until(
      () => master.apple.status().state === 'expired',
      20_000,
      'the session expired',
    )
    assert.deepEqual(signingNotices(), [])
    web.refuse = undefined

    // A session that ends during the first team's setup stops the rest.
    for (const team of [
      { id: 'ABCDE12345', name: 'Example Team' },
      { id: 'ZYXWV98765', name: 'Other Team' },
    ])
      master.appleSigning.setupFailed(team, 'Apple was down')
    web.refuse = 401
    web.refusePath = /^\/iris\//
    const from = web.calls.length
    // The master logs to the console.
    const logs: string[] = []
    const log = console.log
    console.log = (line: unknown): void => {
      logs.push(String(line))
    }
    try {
      await signInTrusted()
      await c.until(
        () => master.apple.status().state === 'expired',
        20_000,
        'the session expired during the setup',
      )
      await c.until(
        () => master.appleTeamsInSetup().length === 0,
        20_000,
        'the team setup',
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
    } finally {
      console.log = log
    }
    assert.deepEqual(
      web.calls.slice(from).filter((call) => call.startsWith('GET /iris/')),
      ['GET /iris/v1/apiKeys'],
    )
    // Said once, not again for each team left.
    assert.deepEqual(
      logs.filter((line) => /^Apple setup/.test(line)),
      [
        'Apple setup of Example Team (ABCDE12345) failed: The Apple session ended: sign in with the Apple ID again',
        'Apple setup stopped: the Apple ID session ended',
      ],
    )
    web.refuse = undefined
    web.refusePath = undefined
  })

  it('U14.14 a capability the API cannot enable goes through the developer site with the signed-in Apple ID’s session; signed out, it names the remedy', async () => {
    const master = c.master.master!
    apple.portal = { origin: connect.origin, cookie: connect.portalCookie! }
    await master.settings.set(admin, 'apple', {
      teams: { ABCDE12345: { ...connectKey, name: 'Example Team' } },
    })
    // The sign-in's own setup may make the team a key; it is one the fake trusts.
    web.nextKeys.push({
      keyId: connectKey.keyId,
      privateKey: connectKey.privateKey,
    })
    const from = web.calls.length
    await signInTrusted()
    await settled(from)
    const sync = async (): Promise<boolean> =>
      await master.appleSigning.profiles.syncCapabilities(
        'ABCDE12345',
        'app.example.ages',
        { 'com.apple.developer.declared-age-range': true },
        { platform: 'ios', distribution: 'adHoc' },
      )
    assert.equal(await sync(), true)
    const bundle = [...connect.bundleIds.values()].find(
      (item) => item.attributes.identifier === 'app.example.ages',
    )!
    assert.deepEqual(connect.capabilities.get(bundle.id), [
      'DECLARED_AGE_RANGE',
    ])
    // No CSRF tokens yet: the bundle ID was read on the site first, and the
    // tokens its answer carried were kept with the session and sent.
    const portal = (): string[] =>
      connect.calls
        .filter((call) => call.path.startsWith('/services-account/'))
        .map((call) => `${call.method} ${call.path}`)
    assert.deepEqual(portal(), [
      `POST /services-account/v1/bundleIds/${bundle.id}`,
      `PATCH /services-account/v1/bundleIds/${bundle.id}`,
    ])
    assert(master.apple.portalTokens())
    // Held now, they go with the next PATCH at once.
    assert.equal(
      await master.appleSigning.profiles.syncCapabilities(
        'ABCDE12345',
        'app.example.ages',
        { 'com.apple.developer.weatherkit': true },
        { platform: 'ios', distribution: 'adHoc' },
      ),
      true,
    )
    assert.deepEqual(portal().slice(2), [
      `PATCH /services-account/v1/bundleIds/${bundle.id}`,
    ])
    // Signed out, nothing reaches Apple and the failure says what to do.
    await master.apple.signOut()
    connect.capabilities.delete(bundle.id)
    await assert.rejects(
      sync(),
      /enable Declared Age Range for app\.example\.ages in the Apple Developer portal, or sign the Apple ID in on the master$/,
    )
    apple.portal = undefined
  })
})
