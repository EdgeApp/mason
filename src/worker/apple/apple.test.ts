import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'mocha'
import type { StageSigning } from '../../pipeline/assignment.js'
import { cluster, type Cluster } from '../../test/cluster.js'
import {
  FakeAppleConnect,
  fakeConnectKey,
  fakeSigningCertificate,
} from '../../test/fakeAppleConnect.js'
import { FakeMac, fakeXcode } from '../../test/fakeMac.js'
import { Journal } from '../journal.js'
import { zip } from '../../upload/fixtures.test.js'
import {
  archive,
  archiveArgs,
  archiveEnvironment,
  capabilityFailure,
  keepLine,
  type Exec,
} from './archive.js'
import {
  addToSearchList,
  createStageKeychain,
  parseKeychains,
  removeFromSearchList,
  removeStageKeychain,
  stageKeychainPath,
  type Command,
} from './keychain.js'
import { appleIntermediates } from './intermediates.js'
import {
  c99,
  exportOptions,
  installProfiles,
  profileDirectories,
  removeProfiles,
  signingSnapshot,
} from './profiles.js'

// Run outputs are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const TEAM = 'ABCDE12345'
const root = (name: string): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), name))

function signingFixture(
  distribution: StageSigning['distribution'] = 'adHoc',
): StageSigning {
  const made = fakeSigningCertificate(
    `Apple Distribution: Mason Test (${TEAM})`,
    TEAM,
  )
  return {
    team: TEAM,
    distribution,
    platform: distribution === 'developerId' ? 'macos' : 'ios',
    app: 'app.example.signed',
    bundleIds: ['app.example.signed', 'app.example.signed.widgets'],
    identity: {
      name: `Apple Distribution: Mason Test (${TEAM})`,
      sha1: new X509Certificate(made.certificate).fingerprint.replaceAll(
        ':',
        '',
      ),
      certificate: made.certificate,
      privateKey: made.privateKey!,
    },
    profiles: [
      {
        bundleId: 'app.example.signed',
        name: 'Mason AdHoc app.example.signed 202610210000',
        uuid: '11111111-2222-3333-4444-555555555555',
        content: Buffer.from('profile one').toString('base64'),
      },
      {
        bundleId: 'app.example.signed.widgets',
        name: 'Mason AdHoc app.example.signed.widgets 202610210000',
        uuid: '66666666-7777-8888-9999-000000000000',
        content: Buffer.from('profile two').toString('base64'),
      },
    ],
  }
}

/** A `security` and `openssl` that keep a search list and answer find-identity with the stage's identity. */
function fakeSecurity(sha1: () => string): {
  run: Command
  calls: string[][]
  list: string[]
} {
  const state = {
    calls: [] as string[][],
    list: ['/Users/x/Library/Keychains/login.keychain-db'],
  }
  const run: Command = async (file, args) => {
    state.calls.push([path.basename(file), ...args])
    if (path.basename(file) === 'openssl') {
      writeFileSync(args[args.indexOf('-out') + 1]!, 'p12')
      return ''
    }
    if (args[0] === 'list-keychains') {
      if (args.includes('-s')) state.list = args.slice(args.indexOf('-s') + 1)
      return state.list.map((entry) => `    "${entry}"`).join('\n') + '\n'
    }
    if (args[0] === 'find-identity')
      return `  1) ${sha1()} "Apple Distribution: Mason Test"\n     1 identities found\n`
    if (args[0] === 'create-keychain') writeFileSync(args.at(-1)!, 'keychain')
    return ''
  }
  return {
    run,
    calls: state.calls,
    get list() {
      return state.list
    },
  } as never
}

/** A minimal IPA: an app's Info.plist inside Payload. */
function ipa(bundleId: string, version: string, buildNumber: string): Buffer {
  const fields = {
    CFBundleIdentifier: bundleId,
    CFBundleShortVersionString: version,
    CFBundleVersion: buildNumber,
  }
  return zip([
    [
      'Payload/App.app/Info.plist',
      Buffer.from(
        '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' +
          Object.entries(fields)
            .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
            .join('') +
          '</dict></plist>',
      ),
    ],
  ])
}

/** Xcode and the signing tools on a fake Mac: an archive with the app and its widget, an exported IPA, and plists as JSON. */
function fakeXcodebuild(commands: string[][]): Exec {
  return async (file, args, options) => {
    commands.push([file, ...args])
    const name = path.basename(file)
    if (name === 'xcrun' && args[1] === 'archive') {
      const archivePath = args[args.indexOf('-archivePath') + 1]!
      const app = path.join(archivePath, 'Products', 'Applications', 'App.app')
      mkdirSync(path.join(app, 'PlugIns', 'Widgets.appex'), { recursive: true })
      mkdirSync(path.join(archivePath, 'dSYMs'), { recursive: true })
      writeFileSync(
        path.join(app, 'Info.plist'),
        JSON.stringify({ CFBundleIdentifier: 'app.example.signed' }),
      )
      writeFileSync(
        path.join(app, 'PlugIns', 'Widgets.appex', 'Info.plist'),
        JSON.stringify({ CFBundleIdentifier: 'app.example.signed.widgets' }),
      )
      options.onLine?.('** ARCHIVE SUCCEEDED **')
      return { code: 0, output: '' }
    }
    if (name === 'xcrun' && args[1] === '-exportArchive') {
      writeFileSync(
        path.join(args[args.indexOf('-exportPath') + 1]!, 'App.ipa'),
        ipa('app.example.signed', '1.0', '7'),
      )
      return { code: 0, output: '' }
    }
    if (name === 'plutil') {
      const text = readFileSync(args.at(-1)!, 'utf8')
      return {
        code: 0,
        output: text.includes('<plist>')
          ? text.slice(text.indexOf('<plist>') + 7, text.indexOf('</plist>'))
          : text,
      }
    }
    if (name === 'codesign')
      return {
        code: 0,
        output: `<?xml version="1.0"?><plist>${JSON.stringify({ 'aps-environment': 'production' })}</plist>`,
      }
    if (name === 'ditto') {
      writeFileSync(args.at(-1)!, 'zip')
      return { code: 0, output: '' }
    }
    if (name === 'xcrun' && args[0] === 'stapler')
      return { code: 0, output: 'The staple and validate action worked!' }
    return { code: 1, output: `unexpected ${name}` }
  }
}

describe('Apple signing on a worker', function () {
  this.timeout(180_000)
  ;(process.platform === 'darwin' ? it : it.skip)(
    'U14.5 a stage keychain with the real security tool: appended to the search list and removed, another program’s entry kept, the default keychain untouched',
    async () => {
      const security = (args: string[]): string =>
        execFileSync('/usr/bin/security', args, { encoding: 'utf8' })
      const before = parseKeychains(security(['list-keychains', '-d', 'user']))
      const defaultBefore = security(['default-keychain', '-d', 'user'])
      const dir = root('keychain-')
      const signing = signingFixture()
      const keychain = stageKeychainPath(dir, 'job/ship/1')
      const other = path.join(dir, 'other-program.keychain-db')
      try {
        await createStageKeychain(keychain, signing.identity)
        const during = parseKeychains(
          security(['list-keychains', '-d', 'user']),
        )
        assert.equal(during.at(-1), keychain)
        assert.deepEqual(during.slice(0, -1), before)
        assert.match(
          security(['find-identity', '-p', 'codesigning', keychain]),
          new RegExp(signing.identity.sha1, 'i'),
        )
        // Apple's intermediates are in the stage keychain itself.
        const authorities = security([
          'find-certificate',
          '-a',
          '-Z',
          keychain,
        ]).match(/^SHA-1 hash:/gm)
        assert.equal(authorities?.length, appleIntermediates.length + 1)
        // Another program adds its keychain while the stage runs.
        security(['create-keychain', '-p', 'other', other])
        security([
          'list-keychains',
          '-d',
          'user',
          '-s',
          ...parseKeychains(security(['list-keychains', '-d', 'user'])),
          other,
        ])
        await removeStageKeychain(keychain)
        const left = parseKeychains(security(['list-keychains', '-d', 'user']))
        assert(!left.includes(keychain))
        assert(left.includes(other))
        assert(!existsSync(keychain))
      } finally {
        await removeStageKeychain(keychain).catch(() => undefined)
        await removeFromSearchList(other)
        try {
          security(['delete-keychain', other])
        } catch {
          // already gone
        }
      }
      assert.deepEqual(
        parseKeychains(security(['list-keychains', '-d', 'user'])),
        before,
      )
      assert.equal(security(['default-keychain', '-d', 'user']), defaultBefore)
    },
  )

  it('U14.5 search-list edits re-read the list and touch only the stage’s own entry; a failed import leaves nothing', async () => {
    const fake = fakeSecurity(() => 'ABC')
    await addToSearchList('/k/stage.keychain-db', fake.run)
    await addToSearchList('/k/stage.keychain-db', fake.run)
    fake.list.push('/k/someone-else.keychain-db')
    await removeFromSearchList('/k/stage.keychain-db', fake.run)
    await removeFromSearchList('/k/stage.keychain-db', fake.run)
    assert.deepEqual(fake.list, [
      '/Users/x/Library/Keychains/login.keychain-db',
      '/k/someone-else.keychain-db',
    ])
    const dir = root('keychain-fake-')
    const keychain = stageKeychainPath(dir, 'job/ship/2')
    const wrong = fakeSecurity(() => 'NOT THE ONE')
    await assert.rejects(
      createStageKeychain(keychain, signingFixture().identity, wrong.run),
      /did not import/,
    )
    assert(wrong.calls.some((call) => call[1] === 'delete-keychain'))
    const added = wrong.calls.find((call) => call[1] === 'add-certificates')!
    assert.equal(added.length, 4 + appleIntermediates.length)
    // The authorities' files are gone with the keychain.
    assert(added.slice(4).every((file) => !existsSync(file)))
    assert(!wrong.list.includes(keychain))
  })

  it('U14.6 profiles by UUID where Xcode reads them, export options per distribution, and per-target build settings', () => {
    const home = root('home-')
    const signing = signingFixture()
    const existing = path.join(
      profileDirectories(home)[0]!,
      `${signing.profiles[1]!.uuid}.mobileprovision`,
    )
    mkdirSync(path.dirname(existing), { recursive: true })
    writeFileSync(existing, 'installed by hand')
    const added = installProfiles(signing, home)
    assert.equal(added.length, 3)
    assert(!added.includes(existing))
    assert.equal(
      readFileSync(
        path.join(
          profileDirectories(home)[1]!,
          `${signing.profiles[0]!.uuid}.mobileprovision`,
        ),
        'utf8',
      ),
      'profile one',
    )
    removeProfiles(added)
    assert.equal(readFileSync(existing, 'utf8'), 'installed by hand')
    assert.deepEqual(readdirSync(profileDirectories(home)[1]!), [])
    assert.throws(
      () =>
        installProfiles(
          { ...signing, profiles: [{ ...signing.profiles[0]!, uuid: '../x' }] },
          home,
        ),
      /invalid UUID/,
    )
    const plists = Object.fromEntries(
      (
        [
          'development',
          'adHoc',
          'appStore',
          'developerId',
          'macAppStore',
        ] as const
      ).map((d) => [d, exportOptions(signingFixture(d))]),
    )
    assert.match(
      plists.adHoc!,
      /<key>method<\/key><string>release-testing<\/string>/,
    )
    assert.match(plists.adHoc!, /<key>thinning<\/key>/)
    assert.match(plists.appStore!, /app-store-connect/)
    assert.match(plists.development!, /debugging/)
    assert.match(plists.developerId!, /developer-id/)
    assert.match(
      plists.appStore!,
      /<key>manageAppVersionAndBuildNumber<\/key><false\/>/,
    )
    assert.match(
      plists.appStore!,
      /<key>app\.example\.signed\.widgets<\/key><string>Mason AdHoc app\.example\.signed\.widgets 202610210000<\/string>/,
    )
    const snapshot = signingSnapshot(
      signing,
      '/k/stage.keychain-db',
      '/tmp/ExportOptions.plist',
    )
    assert.equal(
      snapshot.buildSettings.MASON_PROFILE_app_example_signed_widgets,
      signing.profiles[1]!.name,
    )
    assert.equal(
      snapshot.buildSettings.PROVISIONING_PROFILE_SPECIFIER,
      '$(MASON_PROFILE_$(PRODUCT_BUNDLE_IDENTIFIER:c99extidentifier))',
    )
    assert.equal(
      snapshot.buildSettings.OTHER_CODE_SIGN_FLAGS,
      '--keychain /k/stage.keychain-db',
    )
    assert.equal(c99('9app.x-y'), '_9app_x_y')
  })

  it('U14.6/U14.9 archives and exports with the stage’s signing, condenses the log, retries once after capabilities were added, and runs no Ruby, Bundler or Fastlane', async () => {
    const dir = root('archive-')
    const scratch = root('archive-scratch-')
    const commands: string[][] = []
    const environments: Array<NodeJS.ProcessEnv | undefined> = []
    let failOnce = true
    const exec: Exec = async (file, args, options) => {
      commands.push([file, ...args])
      if (path.basename(file) === 'xcrun') environments.push(options.env)
      const name = path.basename(file)
      const say = (lines: string[]): void => {
        for (const line of lines) options.onLine?.(line)
      }
      if (name === 'xcrun' && args[1] === 'archive') {
        if (failOnce) {
          failOnce = false
          const xcent = path.join(
            args[args.indexOf('-derivedDataPath') + 1]!,
            'Build',
            'App.app.xcent',
          )
          mkdirSync(path.dirname(xcent), { recursive: true })
          writeFileSync(
            xcent,
            JSON.stringify({
              'application-identifier': `${TEAM}.app.example.signed`,
              'aps-environment': 'production',
            }),
          )
          say([
            'CompileSwift normal arm64 App.swift',
            'error: Provisioning profile "Mason AdHoc" doesn\'t include the aps-environment entitlement.',
            '** ARCHIVE FAILED **',
          ])
          return {
            code: 65,
            output: "doesn't include the aps-environment entitlement",
          }
        }
        const archivePath = args[args.indexOf('-archivePath') + 1]!
        const app = path.join(
          archivePath,
          'Products',
          'Applications',
          'App.app',
        )
        mkdirSync(path.join(app, 'PlugIns', 'Widgets.appex'), {
          recursive: true,
        })
        mkdirSync(path.join(archivePath, 'dSYMs'), { recursive: true })
        writeFileSync(
          path.join(app, 'Info.plist'),
          JSON.stringify({ CFBundleIdentifier: 'app.example.signed' }),
        )
        writeFileSync(
          path.join(app, 'PlugIns', 'Widgets.appex', 'Info.plist'),
          JSON.stringify({ CFBundleIdentifier: 'app.example.signed.widgets' }),
        )
        say([
          'CompileSwift normal arm64 App.swift',
          'Signing Identity: "Apple Distribution: Mason Test"',
          'warning: deprecated API',
          '** ARCHIVE SUCCEEDED **',
        ])
        return { code: 0, output: '' }
      }
      if (name === 'xcrun' && args[1] === '-exportArchive') {
        writeFileSync(
          path.join(args[args.indexOf('-exportPath') + 1]!, 'App.ipa'),
          'ipa',
        )
        say(['Exported App to: out', '** EXPORT SUCCEEDED **'])
        return { code: 0, output: '' }
      }
      if (name === 'plutil') {
        const text = readFileSync(args.at(-1)!, 'utf8')
        const json = text.includes('<plist>')
          ? text.slice(text.indexOf('<plist>') + 7, text.indexOf('</plist>'))
          : text
        return { code: 0, output: json }
      }
      if (name === 'codesign')
        return {
          code: 0,
          output: `<?xml version="1.0"?><plist>${JSON.stringify({ 'aps-environment': 'production', 'com.apple.security.application-groups': ['group.example'] })}</plist>`,
        }
      if (name === 'ditto') {
        writeFileSync(args.at(-1)!, 'zip')
        return { code: 0, output: '' }
      }
      return { code: 1, output: `unexpected ${name}` }
    }
    const logs: string[] = []
    const reported: Array<Record<string, unknown>> = []
    const reinstalled: number[] = []
    const kept: string[] = []
    const signing = signingFixture()
    const result = await archive(
      {
        dir,
        scratch,
        signing,
        keychain: '/k/stage.keychain-db',
        exportOptions: '/k/ExportOptions.plist',
        exec,
        log: (text) => logs.push(text),
        entitlements: async (values) => {
          reported.push(values)
          return reported.length === 1
            ? { changed: true, profiles: signing.profiles }
            : { changed: false }
        },
        reinstall: (profiles) => reinstalled.push(profiles.length),
        keep: async (name) => {
          kept.push(name)
        },
      },
      {
        workspace: 'ios/App.xcworkspace',
        scheme: 'App',
        version: '1.4.2',
        buildNumber: '26102101',
        env: { TS_BUILD_INFO: '{"app":"app.example.signed"}' },
      },
    )
    // The stage's environment reaches every xcodebuild: both archives and the export.
    assert.equal(environments.length, 3)
    for (const env of environments)
      assert.deepEqual(env, { TS_BUILD_INFO: '{"app":"app.example.signed"}' })
    assert.equal(
      result.ipa,
      path.join(dir, 'build', 'mason-archive', 'App.ipa'),
    )
    assert.equal(
      result.dsyms,
      path.join(dir, 'build', 'mason-archive', 'App.dSYMs.zip'),
    )
    assert.match(result.archive, /App\.xcarchive$/)
    assert.deepEqual(Object.keys(reported[0]!), ['app.example.signed'])
    assert.deepEqual(Object.keys(reported[1]!).sort(), [
      'app.example.signed',
      'app.example.signed.widgets',
    ])
    assert.deepEqual(reinstalled, [2])
    const archives = commands.filter((command) => command[2] === 'archive')
    assert.equal(archives.length, 2)
    const args = archives[1]!.slice(2)
    for (const setting of [
      'CODE_SIGN_STYLE=Manual',
      `DEVELOPMENT_TEAM=${TEAM}`,
      'MARKETING_VERSION=1.4.2',
      'CURRENT_PROJECT_VERSION=26102101',
      'OTHER_CODE_SIGN_FLAGS=--keychain /k/stage.keychain-db',
      `MASON_PROFILE_app_example_signed_widgets=${signing.profiles[1]!.name}`,
    ])
      assert(args.includes(setting), setting)
    // Only the lines a person needs reach the stage log; all of them are in the file.
    const log = logs.join('')
    assert.doesNotMatch(log, /CompileSwift/)
    assert.match(log, /Signing Identity/)
    assert.match(log, /\*\* EXPORT SUCCEEDED \*\*/)
    assert.match(
      readFileSync(
        path.join(dir, 'build', 'mason-archive', 'xcodebuild-archive.log'),
        'utf8',
      ),
      /CompileSwift/,
    )
    // U14.9: nothing on the worker ran Ruby, Bundler or Fastlane.
    assert(
      !commands.some((command) =>
        /ruby|bundle|fastlane|gem$/.test(command.join(' ')),
      ),
    )
    // A failure that is not about capabilities fails at once and keeps the full log.
    await assert.rejects(
      archive(
        {
          dir,
          scratch,
          signing,
          keychain: '/k',
          exportOptions: '/k/e',
          exec: async () => ({ code: 70, output: 'error: no such scheme' }),
          log: () => undefined,
          entitlements: async () => ({ changed: false }),
          reinstall: () => undefined,
          keep: async (name) => {
            kept.push(name)
          },
        },
        { project: 'App.xcodeproj', scheme: 'App' },
      ),
      /xcodebuild archive failed \(exit 70\)/,
    )
    assert.deepEqual(kept, ['xcodebuild-archive'])
    assert.throws(
      () => archiveArgs({ scheme: 'App' }, signing, '/k', '/a', '/d'),
      /project or a workspace/,
    )
    assert.deepEqual(archiveEnvironment(undefined), {})
    for (const bad of [[], { 'A-B': 'x' }, { A: 1 }, 'x'])
      assert.throws(() => archiveEnvironment(bad), /ctx\.apple\.archive env/)
    await assert.rejects(
      archive(
        {
          dir,
          scratch,
          signing,
          keychain: '/k',
          exportOptions: '/e',
          exec,
          log: () => undefined,
          entitlements: async () => ({ changed: false }),
          reinstall: () => undefined,
        },
        { scheme: 'App', project: 'x', output: '../../elsewhere' },
      ),
      /stay in the workspace/,
    )
    assert(keepLine('** BUILD FAILED **'))
    assert(!keepLine('Ld /path/App normal'))
    assert(
      capabilityFailure(
        'Provisioning profile "x" doesn\'t include the com.apple.developer.healthkit entitlement',
      ),
    )
  })

  describe('on a cluster', () => {
    let c: Cluster
    let apple: FakeAppleConnect
    const homes = new Map<string, string>()
    const securities = new Map<string, ReturnType<typeof fakeSecurity>>()
    let sha1 = ''
    const xcodeCalls: string[][] = []
    const key = fakeConnectKey()
    before(async () => {
      apple = new FakeAppleConnect(key, TEAM)
      await apple.start()
      const dir = root('apple-cluster-')
      const macs = ['signer', 'plain'].map((name) => {
        const mac = new FakeMac(path.join(dir, `${name}-mac`))
        fakeXcode(path.join(mac.applications, 'Xcode.app'), '26.0.1', '17A400')
        homes.set(name, path.join(dir, `${name}-home`))
        securities.set(
          name,
          fakeSecurity(() => sha1),
        )
        return mac
      })
      c = await cluster(path.join(dir, 'cluster'), {
        master: { testEndpoints: true },
        workers: ['signer', 'plain'].map((name, index) => ({
          name,
          type: 'mac-xcode',
          ...(name === 'signer' ? { labels: ['apple-signing'] } : {}),
          workerOptions: {
            applications: macs[index]!.applications,
            systemRun: macs[index]!.run,
            helper: macs[index]!.helper,
            appleCommand: securities.get(name)!.run,
            home: homes.get(name)!,
            appleExec: fakeXcodebuild(xcodeCalls),
            applePollMs: 10,
          },
        })),
      })
      const master = c.master.master!
      const admin = { role: 'admin' as const, label: 'test' }
      await master.settings.set(admin, 'nodeTypes', { 'mac-xcode': {} })
      await master.settings.set(admin, 'apple', {
        teams: { [TEAM]: key },
        endpoints: apple.endpoints,
      })
      const made = fakeSigningCertificate(
        `Apple Distribution: Mason Test (${TEAM})`,
        TEAM,
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
          path.join(dir, 'identity.pem'),
          '-out',
          path.join(dir, 'identity.p12'),
          '-passout',
          'pass:pw',
        ],
        { stdio: 'ignore' },
      )
      apple.addCertificate(made.certificate)
      const cert = await master.appleSigning.certificates.importP12(
        TEAM,
        readFileSync(path.join(dir, 'identity.p12')),
        'pw',
      )
      sha1 = cert.sha1
      const repo = c.repo('fixtures/signed')
      repo.commit({
        'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { mode: { type: 'string', default: 'signing' } } }, () => {})
  m.stage('sign', { on: { type: 'mac-xcode' }, apple: { distribution: 'adHoc', app: 'app.example.signed' }, run: sign })
}
export async function sign(ctx: Stage) {
  const { existsSync, writeFileSync } = await import('node:fs')
  const path = await import('node:path')
  const signing = ctx.apple.signing
  if (ctx.run.params.mode === 'ship') {
    const built = await ctx.apple.archive({ project: 'App.xcodeproj', scheme: 'App', version: '1.0', buildNumber: '7' })
    const testflight = await ctx.apple.testflight({ path: path.relative(ctx.workspace, built.ipa!), groups: ['Internal'], whatToTest: 'Fixture' })
    writeFileSync('App.dmg', 'disk image')
    const notarized = await ctx.apple.notarize({ path: 'App.dmg' })
    return { built: path.basename(built.ipa!), testflight, notarized }
  }
  return { ...signing, keychainExists: existsSync(signing.keychain), exportExists: existsSync(signing.exportOptions) }
}
`,
      })
      master.saveProject(admin, 'signed', {
        repository: repo.url,
        rules: [{ pattern: '*', mode: 'request' }],
        signingLabel: 'apple-signing',
        apps: [
          {
            bundleId: 'app.example.signed',
            name: 'Signed',
            platforms: ['ios'],
            apple: {
              team: TEAM,
              bundleIds: ['app.example.signed', 'app.example.signed.widgets'],
            },
          },
        ],
      })
      await c.until(
        () =>
          ['signer', 'plain'].every(
            (name) =>
              master.scheduler.inventoryOf(c.fingerprint(name))?.system != null,
          ),
        20_000,
        'inventories',
      )
    })
    after(async () => {
      await c?.close()
      await apple?.close()
    })

    it('U14.4 an unprepared Mac signs with what the stage brings, only on a node with the project’s signing label, and keeps nothing afterwards', async () => {
      const runs = []
      for (let i = 0; i < 2; i++) {
        const created = await c.api('POST', '/api/v2/runs', {
          project: 'signed',
          branch: 'master',
        })
        assert.equal(created.status, 202, created.text)
        runs.push(
          await c.until(
            () => {
              const run = c.master.master!.run(created.json.id) as Json
              return ['succeeded', 'failed'].includes(run.status)
                ? run
                : undefined
            },
            60_000,
            'the signed run',
          ),
        )
      }
      for (const run of runs) {
        assert.equal(
          run.status,
          'succeeded',
          c.master.master!.scheduler.logs(run.id),
        )
        const stage = run.stages.find((entry: Json) => entry.name === 'sign')
        assert.equal(stage.workerName ?? stage.worker, 'signer')
        const output = stage.output
        assert.equal(output.teamId, TEAM)
        assert.equal(output.keychainExists, true)
        assert.equal(output.exportExists, true)
        assert.deepEqual(Object.keys(output.profiles).sort(), [
          'app.example.signed',
          'app.example.signed.widgets',
        ])
        assert.equal(
          output.buildSettings.MASON_PROFILE_app_example_signed,
          output.profiles['app.example.signed'],
        )
      }
      // The ad hoc and App Store profiles were made when the app ID was saved, and both runs reused them.
      assert.equal(
        apple.calls.filter(
          (call) => call.path === '/v1/profiles' && call.method === 'POST',
        ).length,
        4,
      )
      // The signer removed its keychain and profiles; the plain node never saw signing material.
      const signer = securities.get('signer')!
      assert(
        signer.calls.filter((call) => call[1] === 'delete-keychain').length >=
          2,
      )
      assert.equal(signer.list.length, 1)
      assert.equal(securities.get('plain')!.calls.length, 0)
      for (const dirName of profileDirectories(homes.get('signer')!))
        assert.deepEqual(readdirSync(dirName), [])
      assert(!existsSync(profileDirectories(homes.get('plain')!)[0]!))
      // The journal keeps no private key.
      const journal = readFileSync(
        path.join(c.workers.get('signer')!.dir, 'worker.sqlite'),
      )
      assert(!journal.includes(Buffer.from('BEGIN PRIVATE KEY')))
    })

    it('U14.7/U14.8 a stage archives, sends TestFlight and notarizes through the master, and reports capabilities from its archive', async () => {
      apple.apps.push({
        type: 'apps',
        id: 'APP1',
        attributes: { bundleId: 'app.example.signed' },
      })
      apple.groups.push({
        type: 'betaGroups',
        id: 'GROUP1',
        app: 'APP1',
        attributes: { name: 'Internal', isInternalGroup: true },
      })
      const created = await c.api('POST', '/api/v2/runs', {
        project: 'signed',
        branch: 'master',
        params: { mode: 'ship' },
      })
      assert.equal(created.status, 202, created.text)
      const run = await c.until(
        () => {
          const value = c.master.master!.run(created.json.id) as Json
          return ['succeeded', 'failed'].includes(value.status)
            ? value
            : undefined
        },
        60_000,
        'the shipping run',
      )
      const log = c.master.master!.scheduler.logs(run.id)
      assert.equal(run.status, 'succeeded', log)
      const output = run.stages.find(
        (entry: Json) => entry.name === 'sign',
      ).output
      assert.equal(output.built, 'App.ipa')
      assert.deepEqual(
        {
          version: output.testflight.version,
          buildNumber: output.testflight.buildNumber,
          state: output.testflight.state,
        },
        { version: '1.0', buildNumber: '7', state: 'VALID' },
      )
      assert.equal(output.notarized.status, 'accepted')
      assert(xcodeCalls.some((call) => call[1] === 'stapler'))
      // The archive's entitlements added push to both bundle IDs on Apple's side.
      assert(
        [...apple.capabilities.values()].every((types) =>
          types.includes('PUSH_NOTIFICATIONS'),
        ),
      )
      assert.match(log!, /capabilities added from the archive’s entitlements/)
      assert(
        !xcodeCalls.some((call) => /ruby|bundle|fastlane/.test(call.join(' '))),
      )
    })

    it('U14.11 saving an app ID sets it up with Apple at once; a new key or certificate checks it again', async () => {
      const master = c.master.master!
      const notices = (): string[] =>
        master.appleSigning
          .notices()
          .filter((line) => line.includes('app.example.signed'))
      const record =
        'App Store Connect has no app record for app.example.signed; create it there before sending builds to TestFlight'
      const noDevelopment = `Team ${TEAM} has no development certificate, so app.example.signed has no development profiles yet`
      await c.until(
        () => notices().length === 2,
        5000,
        'the app ID’s Apple notices',
      )
      assert.deepEqual(notices().sort(), [record, noDevelopment].sort())
      // The distributions the team has a certificate for were made for every bundle ID.
      for (const bundleId of [
        'app.example.signed',
        'app.example.signed.widgets',
      ])
        assert(
          master.appleSigning.profiles
            .list()
            .some(
              (profile) =>
                profile.bundleId === bundleId &&
                profile.distribution === 'appStore',
            ),
          bundleId,
        )
      // The app record made in App Store Connect is seen once the key is saved again.
      apple.apps.push({
        type: 'apps',
        id: 'APPSIGNED',
        attributes: { bundleId: 'app.example.signed' },
      })
      await master.settings.set({ role: 'admin', label: 'test' }, 'apple', {
        teams: { [TEAM]: key },
        endpoints: apple.endpoints,
      })
      await c.until(
        () => notices().length === 1,
        5000,
        'the app record notice gone',
      )
      assert.deepEqual(notices(), [noDevelopment])
      // Two setups of a new app ID at once make each profile once.
      const posts = (): number =>
        apple.calls.filter(
          (call) =>
            call.method === 'POST' &&
            call.path === '/v1/profiles' &&
            JSON.stringify(call.body).includes('app.example.twice'),
        ).length
      master.projects.addApp({ role: 'admin', label: 'test' }, 'signed', {
        bundleId: 'app.example.twice',
        name: 'Twice',
        platforms: ['ios'],
        apple: { team: TEAM },
      })
      master.setupApple((app) => app.bundleId === 'app.example.twice')
      await c.until(
        () =>
          master.appleSigning.profiles
            .list()
            .filter((profile) => profile.bundleId === 'app.example.twice')
            .length >= 2,
        5000,
        'the new app ID’s profiles',
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(posts(), 2)
    })

    it('U14.2 the Apple certificates and profiles API: import, create, list without keys, remove', async () => {
      const made = fakeSigningCertificate(
        `Apple Development: Mason Test (${TEAM})`,
        TEAM,
      )
      const dir = root('api-p12-')
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
          path.join(dir, 'identity.pem'),
          '-out',
          path.join(dir, 'identity.p12'),
          '-passout',
          'pass:pw',
        ],
        { stdio: 'ignore' },
      )
      apple.addCertificate(made.certificate)
      const imported = await c.api('POST', '/api/v2/apple/certificates', {
        team: TEAM,
        p12: readFileSync(path.join(dir, 'identity.p12')).toString('base64'),
        password: 'pw',
      })
      assert.equal(imported.status, 201, imported.text)
      assert.equal(imported.json.kind, 'development')
      // The team's app IDs missing development profiles get them now.
      await c.until(
        () =>
          !c.master
            .master!.appleSigning.notices()
            .some((line) => line.includes('app.example.signed')),
        5000,
        'the development profiles',
      )
      assert(
        c.master
          .master!.appleSigning.profiles.list()
          .some(
            (profile) =>
              profile.bundleId === 'app.example.signed.widgets' &&
              profile.distribution === 'development',
          ),
      )
      const createdCert = await c.api('POST', '/api/v2/apple/certificates', {
        team: TEAM,
        create: 'distribution',
      })
      assert.equal(createdCert.status, 201, createdCert.text)
      const listed = await c.api('GET', '/api/v2/apple/certificates')
      assert(listed.json.length >= 3)
      assert(!listed.text.includes('PRIVATE KEY'))
      const profiles = await c.api('GET', '/api/v2/apple/profiles')
      assert(
        profiles.json.some(
          (profile: Json) => profile.bundleId === 'app.example.signed.widgets',
        ),
      )
      assert(!profiles.text.includes('"content"'))
      for (const [body, error] of [
        [{ team: 'bad' }, /team is an Apple team ID/],
        [{ team: TEAM, p12: 'AA==' }, /needs its password/],
        [
          { team: TEAM, match: { repository: 'x' } },
          /needs the repository and its passphrase/,
        ],
        [{ team: TEAM }, /Give a \.p12/],
      ] as const) {
        const refused = await c.api('POST', '/api/v2/apple/certificates', body)
        assert.equal(refused.status, 400)
        assert.match(refused.json.error, error)
      }
      const matchRefused = await c.api('POST', '/api/v2/apple/certificates', {
        team: TEAM,
        match: { repository: path.join(dir, 'none'), passphrase: 'p' },
      })
      assert.equal(matchRefused.status, 400)
      assert.equal(
        (await c.api('DELETE', '/api/v2/apple/certificates/424242')).status,
        404,
      )
      assert.equal(
        (
          await c.api(
            'DELETE',
            `/api/v2/apple/certificates/${imported.json.id}`,
          )
        ).status,
        200,
      )
    })

    it('U14.5 crash recovery removes a keychain and profiles a stage held when the worker stopped', async () => {
      await c.stopWorker('signer')
      const dir = c.workers.get('signer')?.dir ?? path.join(c.root, 'signer')
      const profile = path.join(
        profileDirectories(homes.get('signer')!)[0]!,
        'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE.mobileprovision',
      )
      writeFileSync(profile, 'left behind')
      const keychain = path.join(
        dir,
        'keychains',
        'mason-stage-crashed.keychain-db',
      )
      mkdirSync(path.dirname(keychain), { recursive: true })
      writeFileSync(keychain, 'left behind')
      const journal = new Journal(
        new DatabaseSync(path.join(dir, 'worker.sqlite')),
      )
      journal.setSigning('crashed/sign/1', { keychain, profiles: [profile] })
      journal.db.close()
      securities.get('signer')!.list.push(keychain)
      await c.startWorker({
        name: 'signer',
        type: 'mac-xcode',
        labels: ['apple-signing'],
        workerOptions: {
          appleCommand: securities.get('signer')!.run,
          home: homes.get('signer')!,
          systemRun: new FakeMac(root('again-')).run,
          appleExec: fakeXcodebuild(xcodeCalls),
          applePollMs: 10,
        },
      })
      await c.until(() => !existsSync(profile), 10_000, 'the profile removed')
      assert(!existsSync(keychain))
      assert(!securities.get('signer')!.list.includes(keychain))
    })
  })
})
