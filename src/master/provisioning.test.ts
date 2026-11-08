import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'mocha'
import { SESSION_COOKIE } from '../auth/routes.js'
import { verifyCms } from '../devices/cms.js'
import { Devices, DEVICE_COOKIE } from '../devices/store.js'
import { HostRuntime } from '../host/runtime.js'
import { nodeMain, type MainIO } from '../node/main.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { insertBuild } from '../store.js'
import { cluster, type Cluster } from '../test/cluster.js'
import {
  FakeAppleConnect,
  fakeConnectKey,
  fakeSigningCertificate,
} from '../test/fakeAppleConnect.js'
import { plist, zip } from '../upload/fixtures.test.js'
import type { AppleService } from '../apple/service.js'
import { MasterDatabase } from './database.js'
import { Jobs, type JobView } from './jobs.js'
import { Projects } from './projects.js'
import { MAX_DEVICE_BRANCHES, Provisioning } from './provisioning.js'
import { localOperator } from './roles.js'

// Rows are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const TEAM = 'ABCDE12345'
const APP = 'app.example.phone'
const udidA = 'A'.repeat(39) + '1'
const udidB = 'A'.repeat(39) + '2'
const udidC = 'A'.repeat(39) + '3'
const commitA = 'a'.repeat(40)
const admin = localOperator

describe('Devices across nodes', function () {
  this.timeout(180_000)
  let root: string
  let c: Cluster
  let host: RunningNode
  let apple: FakeAppleConnect
  let tester: { id: number }
  const openssl = (args: string[]): void => {
    execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
  }
  /** A payload signed by the fixture "Apple" device CA, as an iPhone's Profile Service response is. */
  const sign = (xml: string): Buffer => {
    writeFileSync(path.join(root, 'data.plist'), xml, { mode: 0o600 })
    openssl([
      'cms',
      '-sign',
      '-binary',
      '-nodetach',
      '-in',
      'data.plist',
      '-signer',
      'leaf.pem',
      '-inkey',
      'leaf.key',
      '-certfile',
      'ca.pem',
      '-outform',
      'DER',
      '-out',
      'signed.der',
    ])
    return readFileSync(path.join(root, 'signed.der'))
  }
  const answer = (token: string, udid: string): string =>
    `<plist version="1.0"><dict><key>CHALLENGE</key><string>${token}</string><key>UDID</key><string>${udid}</string><key>PRODUCT</key><string>iPhone14,5</string><key>VERSION</key><string>26.0</string></dict></plist>`
  const hostUrl = (): string =>
    host.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  const session = (): { cookie: string; csrf: string } => {
    const started = host.host!.accounts.startSession(tester.id)
    return {
      cookie: `${SESSION_COOKIE}=${started.token}`,
      csrf: started.session.csrf,
    }
  }
  type Reply = Awaited<ReturnType<typeof pinnedFetch>>
  const hostRequest = async (
    route: string,
    init: Omit<NonNullable<Parameters<typeof pinnedFetch>[1]>, 'headers'> & {
      cookie?: string
      headers?: Record<string, string>
    } = {},
  ): Promise<Reply> => {
    const { cookie, headers, ...rest } = init
    return await pinnedFetch(
      hostUrl() + route,
      {
        redirect: 'manual',
        ...rest,
        headers: { ...(cookie == null ? {} : { cookie }), ...headers },
      },
      host.web!.certificate!.pin,
    )
  }
  const form = async (
    route: string,
    who: { cookie: string; csrf: string },
    fields: Record<string, string> = {},
    cookie = '',
  ): Promise<Reply> =>
    await hostRequest(route, {
      method: 'POST',
      cookie: who.cookie + cookie,
      headers: {
        origin: hostUrl(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf: who.csrf, ...fields }),
    })
  /** Registers a device on the host the way an iPhone does: profile, then signed callback. */
  const register = async (
    udid: string,
  ): Promise<{ token: string; callback: Reply }> => {
    const profile = await form('/devices/profile', session())
    assert.equal(profile.status, 200, await profile.clone().text())
    const token = /<key>Challenge<\/key><string>([^<]+)<\/string>/.exec(
      await profile.text(),
    )![1]!
    const callback = await hostRequest(`/devices/callback/${token}`, {
      method: 'POST',
      body: new Uint8Array(sign(answer(token, udid))),
    })
    return { token, callback }
  }
  const db = (): import('node:sqlite').DatabaseSync =>
    c.master.master!.database.db

  before(async () => {
    root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'provisioning-'),
    )
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '2',
      '-subj',
      '/CN=Apple Fixture Device CA',
    ])
    openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'leaf.key',
      '-out',
      'leaf.csr',
      '-subj',
      '/CN=Fixture Device',
    ])
    openssl([
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'leaf.pem',
      '-days',
      '1',
    ])
    const key = fakeConnectKey()
    apple = new FakeAppleConnect(key, TEAM)
    await apple.start()
    c = await cluster(path.join(root, 'cluster'), {
      master: { testEndpoints: true },
      masterOptions: { appleSleep: async (): Promise<void> => undefined },
    })
    host = await c.startHost('host', { testEndpoints: true })
    const master = c.master.master!
    await master.settings.set(admin, 'host', { origin: hostUrl() })
    await master.settings.set(admin, 'apple', {
      teams: { [TEAM]: key },
      endpoints: apple.endpoints,
    })
    host.host!.setTrustRoot(readFileSync(path.join(root, 'ca.pem'), 'utf8'))
    // A distribution certificate Apple knows, and the app's ad hoc profile made before any device registers.
    const made = fakeSigningCertificate(
      `Apple Distribution: Fake Team (${TEAM})`,
      TEAM,
    )
    writeFileSync(
      path.join(root, 'identity.pem'),
      made.privateKey! + made.certificate,
    )
    openssl([
      'pkcs12',
      '-export',
      '-in',
      'identity.pem',
      '-out',
      'identity.p12',
      '-passout',
      'pass:pw',
    ])
    apple.addCertificate(made.certificate)
    await master.appleSigning.certificates.importP12(
      TEAM,
      readFileSync(path.join(root, 'identity.p12')),
      'pw',
    )
    const repo = c.repo('fixtures/phones')
    repo.commit({ 'Masonfile.ts': 'export function setup() {}' })
    master.saveProject(admin, 'phones', {
      repository: repo.url,
      rules: [
        { pattern: 'main', mode: 'automatic' },
        { pattern: '*', mode: 'request' },
      ],
      apps: [
        {
          bundleId: APP,
          name: 'Phone',
          platforms: ['ios'],
          apple: { team: TEAM },
        },
      ],
    })
    const project = master.projects.get('phones')
    db()
      .prepare(
        'INSERT INTO automatic_branches(project_id,branch,observed_commit,last_checked) VALUES(?,?,?,?)',
      )
      .run(project.id, 'main', commitA, Date.now())
    // Its last push setup recorded a build that runs for a new device.
    db()
      .prepare(
        "UPDATE automatic_branches SET device_registered=1 WHERE branch='main'",
      )
      .run()
    await master.appleSigning.profiles.ensure({
      team: TEAM,
      bundleId: APP,
      distribution: 'adHoc',
      platform: 'ios',
    })
    tester = await master.people.create(admin, {
      emails: ['person15@example.test', 'tess@example.test'],
      name: 'Tess',
      role: 'tester',
    })
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(tester.id),
      2000,
      'the tester on the host',
    )
  })
  after(async () => {
    await c?.close()
    await apple?.close()
  })

  it('U15.1/U15.2/U15.3 a device registered on the host reaches the master, which registers it with Apple, makes the ad hoc profile again and queues the automatic branch', async () => {
    const before = apple.calls.filter(
      (call) => call.path === '/v1/profiles' && call.method === 'POST',
    ).length
    const { token, callback } = await register(udidA)
    assert.equal(callback.status, 301, await callback.clone().text())
    assert.equal(
      callback.headers.get('location'),
      `${hostUrl()}/devices/complete/${token}`,
    )
    const waiting = await hostRequest(`/devices/complete/${token}`, {
      cookie: session().cookie,
    })
    assert.match(await waiting.text(), /Registering device|Device registered/)
    // The registration went through the outbox; the master registered it with Apple.
    const device = await c.until(
      () =>
        db()
          .prepare("SELECT * FROM devices WHERE udid=? AND status='registered'")
          .get(udidA) as Json,
      10_000,
      'the device registered',
    )
    assert(
      db()
        .prepare(
          'SELECT 1 FROM account_devices WHERE account_id=? AND device_id=?',
        )
        .get(tester.id, device.id),
    )
    assert(
      apple.calls.some(
        (call) =>
          call.path === '/v1/devices' &&
          call.method === 'POST' &&
          call.body!.data.attributes.udid === udidA,
      ),
    )
    const posts = apple.calls.filter(
      (call) => call.path === '/v1/profiles' && call.method === 'POST',
    )
    assert.equal(posts.length, before + 1)
    assert(posts.at(-1)!.body!.data.relationships.devices.data.length >= 1)
    assert.equal(
      apple.calls.filter((call) => call.method === 'DELETE').length,
      1,
    )
    const job = db()
      .prepare(
        "SELECT branch,requested_commit,trigger FROM jobs WHERE trigger='deviceRegistered'",
      )
      .get() as Json
    assert.deepEqual(
      { ...job },
      {
        branch: 'main',
        requested_commit: commitA,
        trigger: 'deviceRegistered',
      },
    )
    // The device comes back to the host, and the page says so.
    await c.until(
      () =>
        host
          .host!.cache.db.prepare(
            "SELECT 1 FROM devices WHERE udid=? AND status='registered'",
          )
          .get(udidA),
      2000,
      'the device on the host',
    )
    const done = await hostRequest(`/devices/complete/${token}`, {
      cookie: session().cookie,
    })
    assert.match(await done.text(), /You've registered the following device/)
    // A used link is refused, and a second device does not queue the waiting branch again.
    const reused = await hostRequest(`/devices/callback/${token}`, {
      method: 'POST',
      body: new Uint8Array(sign(answer(token, udidA))),
    })
    assert.equal(reused.status, 400)
    assert.equal((await register(udidB)).callback.status, 301)
    await c.until(
      () =>
        db()
          .prepare("SELECT 1 FROM devices WHERE udid=? AND status='registered'")
          .get(udidB),
      10_000,
      'the second device',
    )
    assert.equal(
      Number(
        (
          db()
            .prepare(
              "SELECT COUNT(*) n FROM jobs WHERE trigger='deviceRegistered'",
            )
            .get() as Json
        ).n,
      ),
      1,
    )
    // No Apple credential reached the host.
    assert.equal(host.host!.cache.setting('apple'), undefined)
    assert.equal(
      (
        await hostRequest(`/devices/complete/${'x'.repeat(43)}`, {
          cookie: session().cookie,
        })
      ).status,
      410,
    )
  })

  it('U15.3 retries Apple at most three times, then shows an error the tester can retry', async () => {
    const master = c.master.master!
    apple.failDevices = 100
    master.hosts.deliver(
      {
        id: 'device-retry-1',
        kind: 'device',
        payload: {
          udid: udidC,
          product: 'iPhone14,5',
          model: 'iPhone 13',
          osVersion: '26.0',
          accountId: tester.id,
          name: 'Retry phone',
        },
      },
      c.fingerprint('host'),
    )
    // Each pass tries Apple once; after the third failure the device shows the error.
    const status = (): string =>
      String(
        (
          db()
            .prepare('SELECT status FROM devices WHERE udid=?')
            .get(udidC) as Json
        ).status,
      )
    for (let pass = 0; pass < 6 && status() !== 'error'; pass++)
      await master.provisioning.poke()
    const failed = db()
      .prepare('SELECT status,message FROM devices WHERE udid=?')
      .get(udidC) as Json
    assert.equal(failed.status, 'error')
    assert.match(failed.message, /Apple is busy/)
    assert.equal(
      apple.calls.filter(
        (call) =>
          call.method === 'POST' &&
          call.path === '/v1/devices' &&
          call.body!.data.attributes.udid === udidC,
      ).length,
      // Three attempts, each retried five times by the App Store Connect client.
      3 * 5,
    )
    apple.failDevices = 0
    master.hosts.deliver(
      {
        id: 'device-retry-2',
        kind: 'device',
        payload: { action: 'retry', udid: udidC, accountId: tester.id },
      },
      c.fingerprint('host'),
    )
    await master.provisioning.poke()
    assert.equal(
      (
        db()
          .prepare('SELECT status FROM devices WHERE udid=?')
          .get(udidC) as Json
      ).status,
      'registered',
    )
    assert.throws(
      () =>
        master.hosts.deliver(
          {
            id: 'device-retry-3',
            kind: 'device',
            payload: { action: 'explode', udid: udidC, accountId: tester.id },
          },
          c.fingerprint('host'),
        ),
      /Unknown device action/,
    )
    // A change for someone else's device does nothing.
    master.hosts.deliver(
      {
        id: 'device-retry-4',
        kind: 'device',
        payload: { action: 'remove', udid: udidC, accountId: 424242 },
      },
      c.fingerprint('host'),
    )
  })

  it('U15.9 a device goes only to apps of its class: an Apple TV for an iOS-only project is refused and queues nothing; with a tvOS app it lands on the tvOS profiles only', async () => {
    const master = c.master.master!
    const jobs = (): number =>
      Number(
        (
          db()
            .prepare(
              "SELECT COUNT(*) n FROM jobs WHERE trigger='deviceRegistered'",
            )
            .get() as Json
        ).n,
      )
    db().prepare("DELETE FROM jobs WHERE trigger='deviceRegistered'").run()
    const udidTv = 'A'.repeat(39) + '9'
    master.hosts.deliver(
      {
        id: 'device-tv-1',
        kind: 'device',
        payload: {
          udid: udidTv,
          product: 'AppleTV11,1',
          model: 'Apple TV 4K',
          osVersion: '26.0',
          accountId: tester.id,
          name: 'Living Room',
        },
      },
      c.fingerprint('host'),
    )
    await master.provisioning.poke()
    const tv = db()
      .prepare('SELECT status,message FROM devices WHERE udid=?')
      .get(udidTv) as Json
    assert.equal(tv.status, 'error')
    assert.match(
      tv.message,
      /No Apple team with an App Store Connect key signs an app for this device \(AppleTV11,1\)/,
    )
    assert(
      !apple.calls.some(
        (call) =>
          call.path === '/v1/devices' &&
          call.method === 'POST' &&
          call.body!.data.attributes.udid === udidTv,
      ),
    )
    assert.equal(jobs(), 0)
    // With a tvOS app of the team, the Apple TV goes to Apple and onto the tvOS ad hoc profile only.
    master.saveProject(admin, 'tvs', {
      repository: c.repo('fixtures/tvs').url,
      rules: [{ pattern: 'main', mode: 'automatic' }],
      apps: [
        {
          bundleId: 'app.example.tv',
          name: 'TV',
          platforms: ['tvos'],
          apple: { team: TEAM },
        },
      ],
    })
    await master.appleSigning.profiles.ensure({
      team: TEAM,
      bundleId: 'app.example.tv',
      distribution: 'adHoc',
      platform: 'tvos',
    })
    apple.deviceClasses.set(udidTv, 'APPLE_TV')
    const profilePosts = (type: string): Json[] =>
      apple.calls.filter(
        (call) =>
          call.path === '/v1/profiles' &&
          call.method === 'POST' &&
          call.body!.data.attributes.profileType === type,
      )
    const iosBefore = profilePosts('IOS_APP_ADHOC').length
    master.hosts.deliver(
      {
        id: 'device-tv-2',
        kind: 'device',
        payload: { action: 'retry', udid: udidTv, accountId: tester.id },
      },
      c.fingerprint('host'),
    )
    await master.provisioning.poke()
    assert.equal(
      (
        db()
          .prepare('SELECT status FROM devices WHERE udid=?')
          .get(udidTv) as Json
      ).status,
      'registered',
    )
    const registered = apple.devices.find(
      (device) => device.attributes.udid === udidTv,
    )!
    assert.equal(registered.attributes.platform, 'IOS')
    assert.deepEqual(
      profilePosts('TVOS_APP_ADHOC')
        .at(-1)!
        .body!.data.relationships.devices.data.map(
          (entry: { id: string }) => entry.id,
        ),
      [registered.id],
    )
    assert.equal(profilePosts('IOS_APP_ADHOC').length, iosBefore)
    master.projects.remove(admin, 'tvs')
  })

  it('U15.4/U15.1 prepare-for-device on the host makes a job pinned to the build’s branch and commit; renames and removals go to the master', async () => {
    const master = c.master.master!
    const appId = Number(
      (db().prepare('SELECT id FROM apps WHERE slug=?').get(APP) as Json).id,
    )
    const channel = Number(
      (
        db()
          .prepare("SELECT id FROM channels WHERE app_id=? AND platform='ios'")
          .get(appId) as Json
      ).id,
    )
    const build = insertBuild(
      db(),
      {
        channelId: channel,
        branch: 'release',
        commit: 'b'.repeat(40),
        version: '1.0',
        buildNumber: '9',
        bundleId: APP,
        format: 'ipa',
        size: 10,
        digest: 'c'.repeat(64),
        changelog: '',
        source: 'test',
        customFields: '{}',
      },
      'f'.repeat(32) + '.ipa',
      { now: Date.now(), retentionDays: 14 },
    )
    master.database.change('build', build.id)
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM builds WHERE id=?')
          .get(build.id),
      2000,
      'the build on the host',
    )
    // A tester prepares only a build of an app shared with her.
    const group = master.people.createGroup(admin, {
      name: 'Prepare testers',
      apps: [appId],
      members: [tester.id],
    })
    await c.until(
      () =>
        host
          .host!.cache.db.prepare(
            'SELECT 1 FROM group_members WHERE group_id=?',
          )
          .get(group.id),
      2000,
      'the group on the host',
    )
    const device = db()
      .prepare('SELECT id FROM devices WHERE udid=?')
      .get(udidA) as Json
    const prepared = await form(
      `/builds/${build.id}/prepare`,
      session(),
      {},
      `; ${DEVICE_COOKIE}=${device.id}`,
    )
    assert.equal(prepared.status, 200)
    assert.match(await prepared.text(), /Preparing build/)
    const job = await c.until(
      () =>
        db()
          .prepare(
            "SELECT branch,requested_commit FROM jobs WHERE trigger='request' AND branch='release'",
          )
          .get() as Json,
      10_000,
      'the pinned job',
    )
    assert.equal(job.requested_commit, 'b'.repeat(40))
    assert.equal(
      (db().prepare('SELECT status FROM device_build_requests').get() as Json)
        .status,
      'queued',
    )
    // Without a selected device the tester is sent to register one.
    assert.equal(
      (await form(`/builds/${build.id}/prepare`, session())).headers.get(
        'location',
      ),
      '/devices',
    )
    const renamed = await form(`/devices/${device.id}/rename`, session(), {
      name: 'Work phone',
    })
    assert.equal(renamed.status, 303)
    await c.until(
      () =>
        (
          db()
            .prepare('SELECT name FROM account_devices WHERE device_id=?')
            .get(device.id) as Json
        )?.name === 'Work phone',
      10_000,
      'the rename on the master',
    )
    const listing = await hostRequest('/devices', { cookie: session().cookie })
    assert.match(await listing.text(), /Your devices/)
    assert.equal(
      (await form(`/devices/${device.id}/remove`, session())).status,
      303,
    )
    await c.until(
      () =>
        db()
          .prepare(
            'SELECT 1 FROM account_devices WHERE device_id=? AND account_id=?',
          )
          .get(device.id, tester.id) == null,
      10_000,
      'the removal on the master',
    )
  })

  it('U15.5 an ad hoc IPA published through a grant records its devices and expiry for the master and the host', async () => {
    const master = c.master.master!
    const profileXml = `<plist version="1.0"><dict><key>ProvisionedDevices</key><array><string>${udidB}</string></array><key>TeamIdentifier</key><array><string>${TEAM}</string></array><key>ExpirationDate</key><date>${new Date(Date.now() + 86_400_000).toISOString()}</date><key>Entitlements</key><dict><key>get-task-allow</key><false/><key>application-identifier</key><string>${TEAM}.${APP}</string></dict></dict></plist>`
    const info = plist()
      .toString()
      .replace('test.example.app', APP)
      .replace('>42<', '>77<')
    const ipa = zip([
      ['Payload/Phone.app/Info.plist', Buffer.from(info)],
      ['Payload/Phone.app/embedded.mobileprovision', sign(profileXml)],
    ])
    // As a stage publishes: a reservation for the run, a grant, then the file to the host.
    const run = master.jobs.request(localOperator, {
      app: 'phones',
      branch: 'release',
    })
    // The build records the run's commit; this suite's runs never resolve one.
    db()
      .prepare('UPDATE jobs SET commit_sha=? WHERE id=?')
      .run('d'.repeat(40), run.id)
    const job = db()
      .prepare('SELECT id,project_id FROM jobs WHERE id=?')
      .get(run.id) as Json
    master.artifacts.reserve(
      { job: job.id, stage: 'publish', attempt: 7, project: job.project_id },
      [APP],
      { [APP]: '77' },
    )
    const granted = master.artifacts.grant(
      { job: job.id, stage: 'publish', attempt: 7 },
      {
        app: APP,
        platform: 'ios',
        format: 'ipa',
        digest: createHash('sha256').update(ipa).digest('hex'),
        size: ipa.length,
        version: '1.2.3',
      },
    )
    const upload = await pinnedFetch(
      granted.url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${granted.grant}`,
        },
        body: ipa,
      },
      granted.pin,
    )
    assert.equal(upload.status, 201, await upload.clone().text())
    const build = db()
      .prepare("SELECT id FROM builds WHERE bundle_id=? AND build_number='77'")
      .get(APP) as Json
    const provisioning = db()
      .prepare('SELECT devices,team FROM build_provisioning WHERE build_id=?')
      .get(build.id) as Json
    assert.deepEqual(JSON.parse(provisioning.devices), [udidB])
    assert.equal(provisioning.team, TEAM)
    await c.until(
      () =>
        host
          .host!.cache.db.prepare(
            'SELECT 1 FROM build_provisioning WHERE build_id=?',
          )
          .get(build.id),
      2000,
      'the profile on the host',
    )
    const devices = new Devices(host.host!.cache.store)
    const hostBuild = host.host!.cache.store.build(Number(build.id))!
    const registered = host
      .host!.cache.db.prepare('SELECT * FROM devices WHERE udid=?')
      .get(udidB) as Json
    assert.equal(devices.eligible(hostBuild, { ...registered }), true)
    assert.equal(
      devices.eligible(hostBuild, { ...registered, udid: udidA }),
      false,
    )
    // A profile for another app is refused by the master.
    assert.throws(
      () =>
        (
          master.artifacts as unknown as {
            recordProvisioning(build: unknown, value: unknown): void
          }
        ).recordProvisioning(
          { id: build.id, bundle_id: APP },
          { devices: [udidB], expiresAt: 1, team: TEAM, appId: 'other.app' },
        ),
      /does not match the build/,
    )
  })

  it('U15.7 an extra Profile Service root is refused and ignored without --test-endpoints, and trusted with it', async () => {
    const pem = readFileSync(path.join(root, 'ca.pem'), 'utf8')
    const lines: string[] = []
    const plainDir = mkdtempSync(path.join(root, 'plain-host-'))
    const plain = new HostRuntime({
      dir: plainDir,
      link: (): undefined => undefined,
      log: (line): void => {
        lines.push(line)
      },
    })
    assert.throws(() => plain.setTrustRoot(pem), /--test-endpoints \(400\)/)
    await plain.stop()
    // A root stored earlier is ignored, with a warning, so the fixture's signature does not verify.
    writeFileSync(path.join(plainDir, 'device-trust-extra.pem'), pem)
    const again = new HostRuntime({
      dir: plainDir,
      link: (): undefined => undefined,
      log: (line): void => {
        lines.push(line)
      },
    })
    assert.match(
      lines.join('\n'),
      /Ignoring the extra Profile Service trust root/,
    )
    const trust = again.cache.store.config.devices!.trustStoreFile
    await assert.rejects(
      verifyCms(sign(answer('x'.repeat(43), udidA)), trust, true),
    )
    await again.stop()
    const testDir = mkdtempSync(path.join(root, 'test-host-'))
    const trusting = new HostRuntime({
      dir: testDir,
      link: (): undefined => undefined,
      testEndpoints: true,
    })
    assert.throws(
      () => trusting.setTrustRoot('not a certificate'),
      /PEM certificate/,
    )
    trusting.setTrustRoot(pem)
    assert(
      await verifyCms(
        sign(answer('x'.repeat(43), udidA)),
        trusting.cache.store.config.devices!.trustStoreFile,
        true,
      ),
    )
    await trusting.stop()
    // The CLI sets it on a running host started with the flag.
    const out: string[] = []
    const io = {
      out: (line: string) => out.push(line),
      err: (line: string) => out.push(line),
      system: (): never => {
        throw new Error('unused')
      },
      stopped: async () => undefined,
      program: () => [],
    } as unknown as MainIO
    writeFileSync(path.join(root, 'root.pem'), pem)
    assert.equal(
      await nodeMain(
        [
          'host',
          'trust-root',
          '--file',
          path.join(root, 'root.pem'),
          '--data',
          host.dir,
        ],
        io,
      ),
      0,
    )
    assert.equal(
      await nodeMain(['host', 'trust-root', '--data', host.dir], io),
      1,
    )
    assert.match(out.join('\n'), /now also trusts|Usage: mason host trust-root/)
  })

  it('U15.6 no code path runs Bundler, Fastlane or the profile shim; only the Ruby and CocoaPods installers run Ruby', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name)
        if (statSync(file).isDirectory()) walk(file)
        else if (/\.(ts|rb|sh)$/.test(name) && !name.endsWith('.test.ts'))
          files.push(file)
      }
    }
    walk(path.resolve('src'))
    assert(!files.some((file) => file.endsWith('.rb')))
    // `ruby` is also a tool a stage may ask Mason to install (built by
    // ruby-build, a shell script): its name may appear, but nothing runs it.
    const runsRuby =
      /\b\w*(?:exec|spawn|run|step)\w*\(\s*['"`][^'"`]*\bruby['"`]|['"`]ruby['"`]\s*,\s*\[/i
    const offending = files.filter((file) => {
      const text = readFileSync(file, 'utf8')
      return (
        runsRuby.test(text) ||
        /['"`](bundle|fastlane)['"`]|bundle exec|apple-provision|bundle-profiles|Spaceship/.test(
          text,
        )
      )
    })
    assert.deepEqual(offending, [])
    // The Ruby installer runs only ruby-build.
    const installer = readFileSync(
      path.resolve('src/worker/tools/ruby.ts'),
      'utf8',
    )
    assert.deepEqual(
      [...installer.matchAll(/\b(?:run|step)\(\s*([\w.]+)/g)].map((m) => m[1]),
      ['bin', 'bin'],
    )
    // The CocoaPods installer runs its gem install with its own Ruby, never
    // Bundler or Fastlane.
    assert.doesNotMatch(
      readFileSync(path.resolve('src/worker/tools/cocoapods.ts'), 'utf8'),
      /['"`](bundle|fastlane)['"`]|bundle exec|Spaceship/,
    )
    assert.equal(createHash('sha256').update('').digest('hex').length, 64)
  })
})

describe('Builds for a new device', () => {
  it('U15.8 queues only branches whose build runs for a new device: the default branch, exact rules, then the most recently set up, at most 20', () => {
    const master = new MasterDatabase(new DatabaseSync(':memory:'))
    const projects = new Projects(master)
    const jobs = new Jobs(master, projects)
    const provisioning = new Provisioning({
      master,
      apple: {} as AppleService,
      projects,
      jobs,
      scheduler: {
        deviceRegistered: (): JobView[] => [],
        poke: (): void => undefined,
      },
    })
    const sha = (n: number): string => n.toString(16).padStart(40, 'd')
    const branch = (n: number): string => `b${String(n).padStart(2, '0')}`
    /** Branches b00…, observed; `device` maps those whose build runs for a device to when that was recorded. */
    const seed = (
      slug: string,
      count: number,
      device: (n: number) => number | null,
    ): void => {
      projects.save(localOperator, slug, {
        repository: `https://github.com/a/${slug}`,
        defaultBranch: 'b29',
      })
      projects.setRules(localOperator, slug, [
        { pattern: 'b00', mode: 'request' },
        { pattern: 'b25', mode: 'automatic' },
        { pattern: '**', mode: 'automatic' },
      ])
      const id = projects.get(slug).id
      for (let n = 0; n < count; n++)
        master.db
          .prepare(
            'INSERT INTO automatic_branches(project_id,branch,observed_commit,device_registered) VALUES(?,?,?,?)',
          )
          .run(id, branch(n), sha(n), device(n))
    }
    // Thirty observed branches; only b07's build runs for a new device.
    seed('one', 30, (n) => (n === 7 ? 1 : null))
    // All but b28 would build, set up in branch order: b00 is no longer
    // automatic and b27 is busy.
    seed('many', 30, (n) => (n === 28 ? null : n + 1))
    jobs.create(projects.get('many'), 'b27', 'request')
    provisioning.queueBuilds([projects.get('one'), projects.get('many')])
    const queued = (slug: string): unknown[][] =>
      master.db
        .prepare(
          "SELECT j.branch,j.requested_commit FROM jobs j JOIN projects p ON p.id=j.project_id WHERE p.slug=? AND j.trigger='deviceRegistered' ORDER BY j.number",
        )
        .all(slug)
        .map((row) => [row.branch, row.requested_commit])
    assert.deepEqual(queued('one'), [['b07', sha(7)]])
    const many = queued('many')
    assert.equal(many.length, MAX_DEVICE_BRANCHES)
    assert.deepEqual(
      many.map(([name]) => name),
      [
        'b29',
        'b25',
        'b26',
        ...Array.from({ length: 17 }, (_, i) => branch(24 - i)),
      ],
    )
    assert.deepEqual(many[0], ['b29', sha(29)])
  })
})
