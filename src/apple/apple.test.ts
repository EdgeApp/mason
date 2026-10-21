import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  createCipheriv,
  createPublicKey,
  createVerify,
  pbkdf2Sync,
  randomBytes,
  X509Certificate,
} from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'mocha'
import { LinkError } from '../link/link.js'
import { zip } from '../upload/fixtures.test.js'
import { MasterDatabase } from '../master/database.js'
import { Settings, type SettingValue } from '../master/settings.js'
import {
  FakeAppleConnect,
  fakeConnectKey,
  fakeSigningCertificate,
} from '../test/fakeAppleConnect.js'
import {
  notarize,
  testflight,
  type DistributeContext,
} from '../worker/apple/distribute.js'
import { matchDecrypt, kindOf } from './certificates.js'
import {
  AppStoreConnect,
  AppleApiError,
  asConnectKey,
  connectToken,
} from './connect.js'
import { capabilitiesOf, profileType, type StageProfile } from './profiles.js'
import { appleArea, AppleService } from './service.js'

const TEAM = 'ABCDE12345'
const root = (name: string): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), name))
const instant = async (): Promise<void> => undefined

/** A `.p12` of a fake signing certificate, as Keychain Access exports one. */
function p12(
  name: string,
  password: string,
  days = 365,
): { file: Buffer; sha1: string } {
  const made = fakeSigningCertificate(name, TEAM, { days })
  const dir = mkdtempSync(
    path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'p12-'),
  )
  writeFileSync(
    path.join(dir, 'identity.pem'),
    made.privateKey! + made.certificate,
  )
  execFileSync(
    'openssl',
    [
      'pkcs12',
      '-export',
      '-in',
      'identity.pem',
      '-out',
      'identity.p12',
      '-passout',
      `pass:${password}`,
    ],
    { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] },
  )
  return {
    file: readFileSync(path.join(dir, 'identity.p12')),
    sha1: new X509Certificate(made.certificate).fingerprint.replaceAll(':', ''),
  }
}

/** A minimal IPA: an app's Info.plist inside Payload. */
function ipa(bundleId: string, version: string, buildNumber: string): Buffer {
  const fields = {
    CFBundleIdentifier: bundleId,
    CFBundleShortVersionString: version,
    CFBundleVersion: buildNumber,
  }
  const plist = Buffer.from(
    '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' +
      Object.entries(fields)
        .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
        .join('') +
      '</dict></plist>',
  )
  return zip([['Payload/App.app/Info.plist', plist]])
}

/** Encrypts a file the way Fastlane Match version 2 does. */
function matchEncrypt(data: Buffer, passphrase: string): string {
  const salt = randomBytes(8)
  const material = pbkdf2Sync(passphrase, salt, 10_000, 68, 'sha256')
  const cipher = createCipheriv(
    'aes-256-gcm',
    material.subarray(0, 32),
    material.subarray(32, 44),
  )
  cipher.setAAD(material.subarray(44))
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
  return Buffer.concat([
    Buffer.from('match_encrypted_v2__'),
    salt,
    cipher.getAuthTag(),
    encrypted,
  ]).toString('base64')
}

describe('Apple on the master', function () {
  this.timeout(120_000)
  const key = fakeConnectKey()
  const apple = new FakeAppleConnect(key, TEAM)
  let clock = Date.now()
  let database: MasterDatabase
  let settings: Settings
  let service: AppleService
  before(async () => {
    await apple.start()
    database = new MasterDatabase(new DatabaseSync(':memory:'), () => clock)
    settings = new Settings(database)
    settings.register('apple', appleArea(true))
    const dir = root('apple-master-')
    service = new AppleService(database, {
      setting: (): SettingValue | undefined => settings.value('apple'),
      testEndpoints: true,
      sleep: instant,
      scratch: dir,
      clone: async (repository, branch, into): Promise<void> => {
        execFileSync('git', [
          'clone',
          '-q',
          '--branch',
          branch,
          repository,
          into,
        ])
      },
    })
    await settings.set({ role: 'admin', label: 'test' }, 'apple', {
      teams: { [TEAM]: { ...key, name: 'Fake Team' } },
      endpoints: apple.endpoints,
    })
  })
  after(async () => {
    await apple.close()
  })

  it('U14.1 signs ES256 JWTs for App Store Connect, pages lists, backs off on 429 and never puts the key in an error', async () => {
    const token = connectToken(key, Date.UTC(2026, 9, 21))
    const [header, claims, signature] = token.split('.') as [
      string,
      string,
      string,
    ]
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
      alg: 'ES256',
      kid: key.keyId,
      typ: 'JWT',
    })
    const payload = JSON.parse(
      Buffer.from(claims, 'base64url').toString(),
    ) as Record<string, number | string>
    assert.equal(payload.aud, 'appstoreconnect-v1')
    assert.equal(payload.iss, key.issuerId)
    assert.equal(Number(payload.exp) - Number(payload.iat), 1200)
    assert(
      createVerify('sha256')
        .update(`${header}.${claims}`)
        .verify(
          { key: createPublicKey(key.privateKey), dsaEncoding: 'ieee-p1363' },
          Buffer.from(signature, 'base64url'),
        ),
    )
    const waits: number[] = []
    const client = new AppStoreConnect(key, {
      bases: apple.endpoints,
      now: (): number => clock,
      sleep: async (ms): Promise<void> => {
        waits.push(ms)
      },
    })
    // The token is reused until a minute before it expires.
    assert.equal(client.token(), client.token())
    const first = client.token()
    clock += 20 * 60_000
    assert.notEqual(client.token(), first)
    clock = Date.now()
    for (let i = 0; i < 5; i++)
      apple.addCertificate(
        fakeSigningCertificate(`Apple Development: Page ${i} (${TEAM})`, TEAM)
          .certificate,
      )
    apple.throttle = 1
    const all = await client.all('/v1/certificates')
    assert(all.length >= 5)
    assert.deepEqual(waits, [1000])
    const failing = new AppStoreConnect(key, {
      bases: apple.endpoints,
      sleep: instant,
      attempts: 2,
    })
    apple.throttle = 2
    await assert.rejects(
      failing.request('GET', '/v1/certificates'),
      (error: unknown) => {
        assert(error instanceof AppleApiError && error.status === 429)
        assert.doesNotMatch(error.message, /PRIVATE KEY|Bearer|eyJ/)
        return true
      },
    )
    const stranger = new AppStoreConnect(
      { ...fakeConnectKey(), keyId: key.keyId, issuerId: key.issuerId },
      { bases: apple.endpoints },
    )
    await assert.rejects(
      stranger.request('GET', '/v1/certificates'),
      /HTTP 401: Authentication credentials are missing/,
    )
    await assert.rejects(
      client.request('GET', '/v1/nothing'),
      /HTTP 404: Not found: GET \/v1\/nothing/,
    )
    assert.throws(() => asConnectKey({ ...key, issuerId: 'x' }), /issuer ID/)
    assert.throws(() => asConnectKey({ ...key, keyId: 'short' }), /key ID/)
    assert.throws(() => asConnectKey({ ...key, privateKey: 'nope' }), /\.p8/)
    const rsa = fakeSigningCertificate('x', TEAM).privateKey!
    assert.throws(
      () => asConnectKey({ ...key, privateKey: rsa }),
      /EC \(P-256\)/,
    )
  })

  it('U14.2 imports certificates from a .p12 and a Match repository and creates them with a CSR; keys stay on the master', async () => {
    const distribution = p12(
      `Apple Distribution: Fake Team (${TEAM})`,
      'p12-password',
    )
    const imported = await service.certificates.importP12(
      TEAM,
      distribution.file,
      'p12-password',
    )
    assert.equal(imported.kind, 'distribution')
    assert.equal(imported.sha1, distribution.sha1)
    assert.equal(imported.source, 'p12')
    assert.equal(imported.appleId, undefined)
    assert(!JSON.stringify(imported).includes('PRIVATE KEY'))
    await assert.rejects(
      service.certificates.importP12(TEAM, distribution.file, 'wrong'),
      /password is wrong/,
    )
    await assert.rejects(
      service.certificates.importP12(
        'ZZZZZ99999',
        distribution.file,
        'p12-password',
      ),
      /belongs to team ABCDE12345/,
    )
    // Apple lists it by serial number; the master finds its ID when it syncs.
    apple.addCertificate(service.certificates.identity(imported.id).certificate)
    await service.certificates.sync(TEAM)
    assert.match(
      service.certificates.current(TEAM, 'distribution')!.appleId!,
      /^CERT/,
    )
    // A Match repository: each certificate and its key, encrypted with the passphrase.
    const developerId = fakeSigningCertificate(
      `Developer ID Application: Fake Team (${TEAM})`,
      TEAM,
    )
    const repo = root('match-')
    const keyOnly = path.join(repo, 'key.pem')
    writeFileSync(keyOnly, developerId.privateKey!)
    execFileSync('openssl', [
      'pkcs12',
      '-export',
      '-nocerts',
      '-inkey',
      keyOnly,
      '-out',
      path.join(repo, 'key.p12'),
      '-passout',
      'pass:',
    ])
    mkdirSync(path.join(repo, 'certs', 'developer_id_application'), {
      recursive: true,
    })
    writeFileSync(
      path.join(repo, 'certs', 'developer_id_application', 'LJSF7LJU69.cer'),
      matchEncrypt(
        new X509Certificate(developerId.certificate).raw,
        'match-pass',
      ),
    )
    writeFileSync(
      path.join(repo, 'certs', 'developer_id_application', 'LJSF7LJU69.p12'),
      matchEncrypt(readFileSync(path.join(repo, 'key.p12')), 'match-pass'),
    )
    execFileSync('rm', [keyOnly, path.join(repo, 'key.p12')])
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repo })
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'],
      { cwd: repo },
    )
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'match'],
      { cwd: repo },
    )
    apple.addCertificate(developerId.certificate, 'LJSF7LJU69')
    const fromMatch = await service.certificates.importMatch(
      TEAM,
      repo,
      'match-pass',
    )
    assert.deepEqual(
      fromMatch.map((entry) => [entry.kind, entry.appleId, entry.source]),
      [['developerIdApplication', 'LJSF7LJU69', 'match']],
    )
    await assert.rejects(
      service.certificates.importMatch(TEAM, repo, 'wrong-pass'),
      /passphrase does not open/,
    )
    // Fastlane's own encryption, both versions, opens with Mason's.
    const fixtures = path.resolve('test/fixtures/match')
    const plain = readFileSync(path.join(fixtures, 'plain.txt'), 'utf8')
    for (const version of ['v1', 'v2'])
      assert.equal(
        matchDecrypt(
          readFileSync(path.join(fixtures, `${version}.txt`), 'utf8'),
          'fixture-passphrase',
        ).toString(),
        plain,
      )
    assert.throws(
      () => matchDecrypt(Buffer.from('plain').toString('base64'), 'x'),
      /Not a Fastlane Match file/,
    )
    // Created: a key generated here and a CSR sent to Apple.
    const created = await service.certificates.create(TEAM, 'development')
    assert.equal(created.kind, 'development')
    assert.equal(created.source, 'created')
    const csr = apple.calls.find(
      (call) => call.path === '/v1/certificates' && call.method === 'POST',
    )!
    assert.match(
      String(csr.body!.data.attributes.csrContent),
      /BEGIN CERTIFICATE REQUEST/,
    )
    assert(!JSON.stringify(apple.calls).includes('PRIVATE KEY'))
    assert.throws(() => kindOf('Some Other Cert'), /not a signing certificate/)
    // Nothing the host replicates carries a key: the certificates are not in the change log.
    assert.deepEqual(
      database.db
        .prepare(
          "SELECT entity FROM change_log WHERE entity LIKE '%apple%' OR entity LIKE '%certificate%'",
        )
        .all(),
      [],
    )
    assert(service.notices().length === 0)
    clock += 340 * 86_400_000
    assert.match(service.notices().join('\n'), /expires on/)
    clock = Date.now()
  })

  it('U14.3 makes profiles when missing and again at 14 days, on a new certificate, new capabilities or (ad hoc) new devices, deleting only the old one', async () => {
    apple.devices.push({
      type: 'devices',
      id: 'DEVICE1',
      attributes: { status: 'ENABLED', platform: 'IOS' },
    })
    const posts = (): number =>
      apple.calls.filter(
        (call) => call.path === '/v1/profiles' && call.method === 'POST',
      ).length
    const ensure = async (
      distribution: 'adHoc' | 'appStore',
      bundleId = 'app.example.signed',
    ): Promise<StageProfile> =>
      await service.profiles.ensure({
        team: TEAM,
        bundleId,
        distribution,
        platform: 'ios',
      })
    const first = await ensure('adHoc')
    assert.match(first.name, /^Mason AdHoc app\.example\.signed \d{12}$/)
    assert.equal(posts(), 1)
    // The bundle ID was missing from the account, so it was made.
    assert(
      apple.calls.some(
        (call) => call.path === '/v1/bundleIds' && call.method === 'POST',
      ),
    )
    assert.deepEqual(await ensure('adHoc'), first)
    assert.equal(posts(), 1)
    // A new device changes the ad hoc profile, once the device list is asked again.
    apple.devices.push({
      type: 'devices',
      id: 'DEVICE2',
      attributes: { status: 'ENABLED', platform: 'IOS' },
    })
    const appStore = await ensure('appStore')
    clock += 61 * 60_000
    const second = await ensure('adHoc')
    assert.notEqual(second.uuid, first.uuid)
    // The replaced profile is gone from Apple.
    assert(
      ![...apple.profiles.values()].some(
        (item) => item.attributes.uuid === first.uuid,
      ),
    )
    const deleted = apple.calls
      .filter((call) => call.method === 'DELETE')
      .map((call) => call.path)
    assert.equal(deleted.length, 1)
    // Devices never change an App Store profile.
    assert.deepEqual(await ensure('appStore'), appStore)
    // Expiring within 14 days.
    clock += 352 * 86_400_000
    const renewed = await ensure('appStore')
    assert.notEqual(renewed.uuid, appStore.uuid)
    clock = Date.now() + 2 * 60 * 60_000
    // A newer certificate replaces the profile's.
    // A renewed certificate expires later than the one it replaces.
    const newer = p12(`Apple Distribution: Fake Team (${TEAM})`, 'x', 400)
    const newerCert = await service.certificates.importP12(
      TEAM,
      newer.file,
      'x',
    )
    apple.addCertificate(
      service.certificates.identity(newerCert.id).certificate,
    )
    await service.certificates.sync(TEAM)
    const recertified = await ensure('appStore')
    assert.notEqual(recertified.uuid, renewed.uuid)
    // Capabilities from entitlements: added to the bundle ID, and the profile made again.
    assert.equal(
      await service.profiles.syncCapabilities(TEAM, 'app.example.signed', {
        'aps-environment': 'production',
        'com.apple.security.application-groups': ['group.example'],
        'get-task-allow': false,
      }),
      true,
    )
    assert.equal(
      await service.profiles.syncCapabilities(TEAM, 'app.example.signed', {
        'aps-environment': 'production',
      }),
      false,
    )
    const withPush = await ensure('appStore')
    assert.notEqual(withPush.uuid, recertified.uuid)
    assert.deepEqual(
      capabilitiesOf({ 'aps-environment': 'development', x: 1 }),
      ['PUSH_NOTIFICATIONS'],
    )
    // A profile made by hand is never deleted; only Mason's own IDs are.
    for (const call of apple.calls.filter((entry) => entry.method === 'DELETE'))
      assert.match(call.path, /^\/v1\/profiles\/PROFILE/)
    assert.throws(
      () => profileType('adHoc', 'macos'),
      /no adHoc distribution for macos/,
    )
    assert.equal(profileType('developerId', 'macos'), 'MAC_APP_DIRECT')
    const developerId = await service.profiles.ensure({
      team: TEAM,
      bundleId: 'app.example.mac',
      distribution: 'developerId',
      platform: 'macos',
    })
    assert.match(developerId.name, /^Mason DeveloperID app\.example\.mac /)
    await assert.rejects(
      service.profiles.ensure({
        team: 'NOKEY00000',
        bundleId: 'x.y',
        distribution: 'adHoc',
        platform: 'ios',
      }),
      /no usable distribution certificate|no App Store Connect key/,
    )
  })

  /** The worker's side of TestFlight and notarization, calling the master's handlers directly. */
  const distribute = (
    dir: string,
    drops = 0,
    kept: string[] = [],
  ): DistributeContext => {
    let dropped = 0
    return {
      dir,
      scratch: dir,
      sleep: instant,
      pollMs: 1,
      log: () => undefined,
      exec: async (file, args): Promise<{ code: number; output: string }> => {
        execs.push([file, ...args].join(' '))
        return { code: 0, output: '' }
      },
      keep: async (name): Promise<void> => {
        kept.push(name)
      },
      connected: async () => undefined,
      request: async <T>(
        method: string,
        params: Record<string, unknown>,
      ): Promise<T> => {
        if (method === 'apple.testflight.complete' && dropped < drops) {
          dropped++
          throw new LinkError('The master is not connected', 'closed')
        }
        if (method === 'apple.testflight.start')
          return (await service.testflight.start({
            job: 'job1',
            stage: 'ship',
            team: TEAM,
            bundleId: 'app.example.signed',
            platform: 'ios',
            fileName: String(params.fileName),
            fileSize: Number(params.fileSize),
            version: String(params.version),
            buildNumber: String(params.buildNumber),
            options: params.options as never,
          })) as T
        if (method === 'apple.testflight.complete')
          return (await service.testflight.complete(
            String(params.id),
            'job1',
          )) as T
        if (method === 'apple.testflight.status')
          return (await service.testflight.status(
            String(params.id),
            'job1',
          )) as T
        if (method === 'apple.notary.start')
          return (await service.notary.start({
            job: 'job1',
            stage: 'ship',
            team: TEAM,
            name: String(params.name),
            sha256: String(params.sha256),
          })) as T
        if (method === 'apple.notary.status')
          return (await service.notary.status(String(params.id), 'job1')) as T
        throw new Error(`unexpected ${method}`)
      },
    }
  }
  const execs: string[] = []

  it('U14.7 sends a TestFlight build through the build-upload API: pre-signed parts from the worker, the rest by the master, through a dropped link', async () => {
    const dir = root('testflight-')
    writeFileSync(
      path.join(dir, 'App.ipa'),
      ipa('app.example.signed', '2.1.0', '421'),
    )
    apple.apps.push({
      type: 'apps',
      id: 'APP1',
      attributes: { bundleId: 'app.example.signed' },
    })
    apple.groups.push(
      {
        type: 'betaGroups',
        id: 'GROUP1',
        app: 'APP1',
        attributes: { name: 'Internal', isInternalGroup: true },
      },
      {
        type: 'betaGroups',
        id: 'GROUP2',
        app: 'APP1',
        attributes: { name: 'Coaches', isInternalGroup: false },
      },
    )
    apple.processingPolls = 3
    // Apple answers 503 once while the build processes: the wait goes on.
    apple.failStatus = 1
    const result = await testflight(distribute(dir, 1), {
      path: 'App.ipa',
      whatToTest: 'New sign-in',
      groups: ['Internal', 'Coaches'],
      usesNonExemptEncryption: false,
    })
    assert.equal(result.version, '2.1.0')
    assert.equal(result.buildNumber, '421')
    assert.equal(apple.failStatus, 0)
    assert.equal(result.state, 'VALID')
    const build = apple.builds.get(result.buildId)!
    assert.deepEqual(build.groups, ['GROUP1', 'GROUP2'])
    assert.equal(build.attributes.usesNonExemptEncryption, false)
    assert.equal(build.localizations[0].attributes.whatsNew, 'New sign-in')
    assert.equal(build.autoNotifyEnabled, true)
    assert(
      apple.calls.some((call) => call.path === '/v1/betaAppReviewSubmissions'),
    )
    // The parts reached Apple whole, and the worker never saw the key.
    const parts = [...apple.uploaded.values()]
    assert.equal(
      Buffer.concat(parts).length,
      readFileSync(path.join(dir, 'App.ipa')).length,
    )
    // Asking again after it finished answers the same.
    const upload = [...apple.uploads.keys()][0]!
    assert.deepEqual(await service.testflight.status(upload, 'job1'), {
      state: 'done',
      result,
    })
    await assert.rejects(
      service.testflight.status(upload, 'other-job'),
      /No such TestFlight upload/,
    )
    // An unknown group and a missing app record are refused with Apple-facing reasons.
    writeFileSync(
      path.join(dir, 'Other.ipa'),
      ipa('app.example.signed', '2.1.0', '422'),
    )
    await assert.rejects(
      testflight(distribute(dir), { path: 'Other.ipa', groups: ['Nobody'] }),
      /No beta group named Nobody/,
    )
    await assert.rejects(
      service.testflight.start({
        job: 'job2',
        stage: 's',
        team: TEAM,
        bundleId: 'app.example.none',
        platform: 'ios',
        fileName: 'x.ipa',
        fileSize: 1,
        version: '1',
        buildNumber: '1',
        options: {},
      }),
      /no app record for app\.example\.none/,
    )
    await assert.rejects(
      testflight(distribute(dir), { path: '../outside.ipa' }),
      /outside the workspace/,
    )
    await assert.rejects(
      testflight(distribute(dir), { path: 'App.dmg' }),
      /an \.ipa or a \.pkg/,
    )
    // The app's Info.plist already answered export compliance: Mason leaves it.
    apple.declaredEncryption = false
    const patches = (): number =>
      apple.calls.filter(
        (call) =>
          call.method === 'PATCH' && call.path.startsWith('/v1/builds/'),
      ).length
    const before = patches()
    const declared = await testflight(distribute(dir), {
      path: 'App.ipa',
      groups: ['Internal'],
      usesNonExemptEncryption: false,
    })
    assert.equal(patches(), before)
    assert.deepEqual(apple.builds.get(declared.buildId)!.groups, ['GROUP1'])
    apple.declaredEncryption = undefined
    // Apple rejects the processed upload: the stage fails with Apple's reason.
    apple.rejectUpload = 'Missing required icon file.'
    await assert.rejects(
      testflight(distribute(dir), { path: 'App.ipa', groups: ['Internal'] }),
      /rejected the upload: Missing required icon file\./,
    )
  })

  it('U14.7 reads a .pkg’s version from the app inside it and sends a part again when Apple refuses it once', async () => {
    const dir = root('testflight-pkg-')
    writeFileSync(path.join(dir, 'App.pkg'), randomBytes(512))
    const context = distribute(dir)
    context.exec = async (
      file,
      args,
    ): Promise<{ code: number; output: string }> => {
      if (path.basename(file) === 'pkgutil') {
        const app = path.join(args.at(-1)!, 'Payload', 'Mac.app', 'Contents')
        mkdirSync(app, { recursive: true })
        writeFileSync(
          path.join(app, 'Info.plist'),
          JSON.stringify({
            CFBundleShortVersionString: '3.0',
            CFBundleVersion: '30',
          }),
        )
        return { code: 0, output: '' }
      }
      return { code: 0, output: readFileSync(args.at(-1)!, 'utf8') }
    }
    let refusals = 1
    context.fetch = async (url, init): Promise<Response> => {
      if (refusals-- > 0) return new Response('busy', { status: 503 })
      return await fetch(url, init)
    }
    const result = await testflight(context, {
      path: 'App.pkg',
      waitForProcessing: false,
    })
    assert.equal(result.version, '3.0')
    assert.equal(result.buildNumber, '30')
    assert.equal(result.state, 'PROCESSING')
    const failing = distribute(dir)
    failing.exec = async (): Promise<{ code: number; output: string }> => ({
      code: 1,
      output: '',
    })
    await assert.rejects(
      testflight(failing, { path: 'App.pkg' }),
      /pkgutil could not read/,
    )
    const stubborn = distribute(dir)
    stubborn.fetch = async (): Promise<Response> =>
      new Response('no', { status: 500 })
    writeFileSync(
      path.join(dir, 'Again.ipa'),
      ipa('app.example.signed', '2.1.0', '423'),
    )
    await assert.rejects(
      testflight(stubborn, { path: 'Again.ipa' }),
      /Apple refused a part of the upload: HTTP 500/,
    )
    const { spawnExec } = await import('../worker/apple/exec.js')
    const lines: string[] = []
    const ran = await spawnExec(
      '/bin/sh',
      ['-c', 'echo one; echo two >&2; printf three'],
      { cwd: dir, onLine: (line) => lines.push(line) },
    )
    assert.equal(ran.code, 0)
    assert.deepEqual(lines.sort(), ['one', 'three', 'two'])
    assert.equal(
      (await spawnExec('/bin/sh', ['-c', 'exit 3'], { cwd: dir })).code,
      3,
    )
    await assert.rejects(spawnExec('/no/such/tool', [], { cwd: dir }))
  })

  it('U14.8 notarizes through the notary API with single-submission credentials; a rejection keeps Apple’s log', async () => {
    const dir = root('notary-')
    writeFileSync(path.join(dir, 'App.dmg'), randomBytes(2048))
    execs.length = 0
    // An outage while the submission is checked is waited out.
    apple.failStatus = 1
    const accepted = await notarize(distribute(dir), { path: 'App.dmg' })
    assert.equal(accepted.status, 'accepted')
    assert.equal(apple.failStatus, 0)
    const upload = apple.s3.at(-1)!
    assert.equal(upload.size, 2048)
    assert.equal(upload.headers['x-amz-security-token'], 'fake-session-token')
    assert.deepEqual(execs, [
      `/usr/bin/xcrun stapler staple ${path.join(dir, 'App.dmg')}`,
    ])
    writeFileSync(path.join(dir, 'rejected.dmg'), randomBytes(16))
    const kept: string[] = []
    await assert.rejects(
      notarize(distribute(dir, 0, kept), {
        path: 'rejected.dmg',
        staple: false,
      }),
      /did not notarize it \(Invalid\)/,
    )
    assert.deepEqual(kept, ['notary-log'])
    assert.match(
      readFileSync(path.join(dir, 'notary-log.json'), 'utf8'),
      /not signed/,
    )
    await assert.rejects(
      notarize(distribute(dir), { path: 'App.ipa' }),
      /\.dmg, \.zip or \.pkg/,
    )
    await assert.rejects(
      service.notary.start({
        job: 'j',
        stage: 's',
        team: TEAM,
        name: 'x',
        sha256: 'nope',
      }),
      /SHA-256/,
    )
    await assert.rejects(
      service.notary.status('missing', 'job1'),
      /No such notary submission/,
    )
  })

  it('U14.11 an app ID with an Apple team gets its bundle IDs and each distribution’s profiles at once; a missing key or App Store Connect app record stays a notice until resolved', async () => {
    assert.deepEqual(
      await service.setupApp({
        id: 1,
        bundleId: 'app.example.plain',
        name: 'Plain',
        platforms: ['ios'],
      }),
      [],
    )
    const keyless = {
      id: 2,
      bundleId: 'app.example.keyless',
      name: 'Keyless',
      platforms: ['ios' as const],
      apple: { team: 'ZZZZZ99999', bundleIds: ['app.example.keyless'] },
    }
    assert.deepEqual(await service.setupApp(keyless), [
      'Team ZZZZZ99999 has no App Store Connect key',
    ])
    assert(service.incomplete(keyless))
    const app = {
      id: 3,
      bundleId: 'app.example.setup',
      name: 'Setup',
      platforms: ['ios' as const, 'macos' as const],
      apple: {
        team: TEAM,
        bundleIds: ['app.example.setup', 'app.example.setup.widgets'],
      },
    }
    const problems = await service.setupApp(app)
    assert.deepEqual(problems, [
      'App Store Connect has no app record for app.example.setup; create it there before sending builds to TestFlight',
    ])
    for (const bundleId of app.apple.bundleIds)
      assert(
        [...apple.bundleIds.values()].some(
          (item) => item.attributes.identifier === bundleId,
        ),
        bundleId,
      )
    const made = (bundleId: string): string[] =>
      service.profiles
        .list()
        .filter((profile) => profile.bundleId === bundleId)
        .map((profile) => profile.distribution)
        .sort()
    for (const bundleId of app.apple.bundleIds)
      assert.deepEqual(made(bundleId), [
        'adHoc',
        'appStore',
        'developerId',
        'development',
        'macAppStore',
      ])
    assert(service.notices().includes(problems[0]!))
    // Once the app record exists, setting the app up again clears the notice and makes nothing twice.
    const posts = apple.calls.filter(
      (call) => call.path === '/v1/profiles' && call.method === 'POST',
    ).length
    apple.apps.push({
      type: 'apps',
      id: 'APPSETUP',
      attributes: { bundleId: 'app.example.setup' },
    })
    assert.deepEqual(await service.setupApp(app), [])
    assert(!service.incomplete(app))
    assert.equal(
      apple.calls.filter(
        (call) => call.path === '/v1/profiles' && call.method === 'POST',
      ).length,
      posts,
    )
    assert(
      service
        .notices()
        .includes('Team ZZZZZ99999 has no App Store Connect key'),
    )
    assert(
      !service.notices().some((line) => line.includes('app.example.setup')),
    )
  })

  it('U14.10 Apple base URLs are refused without --test-endpoints and ignored with a warning when already stored', async () => {
    const strict = appleArea(false)
    await assert.rejects(
      Promise.resolve().then(() =>
        strict.validate({ endpoints: { api: 'http://fake' } }, undefined, {
          actor: { role: 'admin', label: 't' },
          now: 0,
        }),
      ),
      /--test-endpoints/,
    )
    const stored = { endpoints: { api: apple.origin } }
    const plain = new AppleService(database, {
      setting: (): SettingValue => stored,
      testEndpoints: false,
    })
    assert.equal(plain.bases().api, 'https://api.appstoreconnect.apple.com')
    assert.match(plain.startupWarnings()[0]!, /Ignoring the Apple base URLs/)
    assert.equal(service.bases().api, apple.origin)
    assert.deepEqual(service.startupWarnings(), [])
    // The private key is write-only and kept when an administrator keeps it.
    const shown = settings.get(
      { role: 'admin', label: 't' },
      'apple',
    ) as Record<string, Record<string, Record<string, unknown>>>
    assert.deepEqual(shown.teams![TEAM]!.privateKey, { set: true })
    await settings.set({ role: 'admin', label: 't' }, 'apple', {
      appleId: 'builds@example.com',
      teams: {
        [TEAM]: {
          issuerId: key.issuerId,
          keyId: key.keyId,
          privateKey: { keep: true },
        },
      },
    })
    assert.equal(service.teams().join(), TEAM)
    await assert.rejects(
      settings.set({ role: 'admin', label: 't' }, 'apple', {
        teams: { NEWTEAM123: { ...key, privateKey: { keep: true } } },
      }),
      /No stored key to keep/,
    )
    await assert.rejects(
      settings.set({ role: 'admin', label: 't' }, 'apple', {
        teams: { bad: key },
      }),
      /not an Apple team ID/,
    )
    await assert.rejects(
      settings.set({ role: 'admin', label: 't' }, 'apple', {
        appleId: 'not an email',
      }),
      /email address/,
    )
    await assert.rejects(
      settings.set({ role: 'admin', label: 't' }, 'apple', { teams: [] }),
      /maps team IDs/,
    )
    await assert.rejects(
      settings.set({ role: 'admin', label: 't' }, 'apple', {
        endpoints: { api: 'ftp://x' },
      }),
      /endpoints\.api is a URL/,
    )
  })
})
