import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, it } from 'mocha'
import type { StageSigning } from '../../pipeline/assignment.js'
import type { Exec } from './archive.js'
import {
  entitlementsPlist,
  profileEntitlements,
  resign,
  rewriteEntitlements,
  signables,
  type ResignContext,
} from './resign.js'

type Plist = Record<string, unknown>
const TEAM = 'ABCDE12345'
const OLD = 'OLDTEAM123'
const APP = 'app.example.signed'
const root = (name: string): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), name))

/** A profile as the fake `security cms` decodes it: its plist as JSON. */
function profile(
  bundleId: string,
  uuid: string,
  entitlements: Plist = {},
  team = TEAM,
): StageSigning['profiles'][number] {
  return {
    bundleId,
    name: `Mason AppStore ${bundleId}`,
    uuid,
    content: Buffer.from(
      JSON.stringify({
        UUID: uuid,
        TeamIdentifier: team === '' ? [] : [team],
        Entitlements: {
          'application-identifier': `${TEAM}.${bundleId}`,
          'com.apple.developer.team-identifier': TEAM,
          'keychain-access-groups': [`${TEAM}.*`],
          'get-task-allow': false,
          'beta-reports-active': true,
          ...entitlements,
        },
      }),
    ).toString('base64'),
  }
}

const groups = {
  'aps-environment': 'production',
  'com.apple.security.application-groups': ['group.example'],
}
function signing(): StageSigning {
  return {
    team: TEAM,
    distribution: 'appStore',
    platform: 'ios',
    app: APP,
    bundleIds: [APP, `${APP}.widgets`, `${APP}.share`, `${APP}.watch`],
    identity: {
      name: `Apple Distribution: Mason Test (${TEAM})`,
      sha1: 'A'.repeat(40),
      certificate: '',
      privateKey: '',
    },
    profiles: [
      profile(APP, '11111111-1111-1111-1111-111111111111', groups),
      profile(`${APP}.widgets`, '22222222-2222-2222-2222-222222222222', groups),
      profile(`${APP}.share`, '33333333-3333-3333-3333-333333333333'),
      profile(`${APP}.watch`, '44444444-4444-4444-4444-444444444444'),
    ],
  }
}

const info = (dir: string, bundleId?: string, extra: Plist = {}): void => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'Info.plist'),
    JSON.stringify({
      ...(bundleId == null ? {} : { CFBundleIdentifier: bundleId }),
      CFBundleShortVersionString: '1.0',
      CFBundleVersion: '1',
      ...extra,
    }),
  )
}

/**
 * An app with two extensions, a watch app, a framework inside a framework,
 * a framework laid out with symlinks, a dylib, and a stale signature.
 */
function appTree(app: string): void {
  info(app, APP)
  writeFileSync(path.join(app, 'App'), 'binary')
  mkdirSync(path.join(app, '_CodeSignature'))
  writeFileSync(path.join(app, '_CodeSignature', 'CodeResources'), 'stale')
  const frameworks = path.join(app, 'Frameworks')
  info(path.join(frameworks, 'Inner.framework'), 'app.example.inner')
  info(
    path.join(frameworks, 'Inner.framework', 'Frameworks', 'Deep.framework'),
    'app.example.deep',
  )
  const lib = path.join(frameworks, 'Lib.framework')
  info(path.join(lib, 'Versions', 'A'), 'app.example.lib')
  writeFileSync(path.join(lib, 'Versions', 'A', 'Lib'), 'binary')
  symlinkSync('A', path.join(lib, 'Versions', 'Current'))
  symlinkSync('Versions/Current/Lib', path.join(lib, 'Lib'))
  symlinkSync('Versions/Current/Info.plist', path.join(lib, 'Info.plist'))
  writeFileSync(path.join(frameworks, 'libswiftCore.dylib'), 'binary')
  // A symlinked bundle is never followed, nor signed twice.
  symlinkSync('Inner.framework', path.join(frameworks, 'Alias.framework'))
  writeFileSync(path.join(frameworks, 'README.txt'), 'not signed')
  info(path.join(app, 'PlugIns', 'Widgets.appex'), `${APP}.widgets`)
  info(path.join(app, 'PlugIns', 'Share.appex'), `${APP}.share`)
  info(path.join(app, 'Watch', 'Watch.app'), `${APP}.watch`)
}

interface Fake {
  exec: Exec
  calls: string[][]
  /** Each `codesign --sign`: the bundle, its entitlements file's text, and whether its profile was embedded first. */
  signed: Array<{ bundle: string; entitlements?: string; embedded?: string }>
  /** Entitlements each bundle's existing signature carries, by bundle name. */
  signatures: Map<string, Plist>
  verifyCode: number
  team: string
  failSign?: string
  tamper?: boolean
}

/** codesign, plutil, ditto, security and xattr on a fake Mac: plists are JSON, zips are directory listings. */
function fakeTools(): Fake {
  const fake: Fake = {
    calls: [],
    signed: [],
    signatures: new Map(),
    verifyCode: 0,
    team: TEAM,
    exec: async (file, args) => {
      fake.calls.push([path.basename(file), ...args])
      const name = path.basename(file)
      const json = (target: string): Plist =>
        JSON.parse(
          readFileSync(target, 'utf8').replace(
            /^[^]*<plist>([^]*)<\/plist>[^]*$/,
            '$1',
          ),
        ) as Plist
      if (name === 'plutil' && args[0] === '-extract') {
        const value = json(args.at(-1)!)[args[1]!]
        if (value === undefined)
          return { code: 1, output: `No value at that key path ${args[1]}` }
        return {
          code: 0,
          output:
            args[2] === 'raw' ? `${String(value)}\n` : JSON.stringify(value),
        }
      }
      if (name === 'plutil' && args[0] === '-convert') {
        const text = readFileSync(args.at(-1)!, 'utf8')
        if (!/^\s*[<{[]/.test(text)) return { code: 1, output: 'not a plist' }
        return { code: 0, output: JSON.stringify(json(args.at(-1)!)) }
      }
      if (name === 'plutil' && args[0] === '-replace') {
        const values = json(args.at(-1)!)
        values[args[1]!] = args[3]
        writeFileSync(args.at(-1)!, JSON.stringify(values))
        return { code: 0, output: '' }
      }
      if (name === 'security' && args[0] === 'cms') {
        cpSync(args[args.indexOf('-i') + 1]!, args[args.indexOf('-o') + 1]!)
        return { code: 0, output: 'security: SecPolicySetValue: warning\n' }
      }
      if (name === 'xattr') return { code: 0, output: '' }
      if (name === 'ditto' && args[0] === '-x') {
        cpSync(`${args[2]!}.tree`, args[3]!, {
          recursive: true,
          verbatimSymlinks: true,
        })
        return { code: 0, output: '' }
      }
      if (name === 'ditto' && args[0] === '-c') {
        const top = args.at(-2)!
        const list = (dir: string): string[] =>
          readdirSync(dir)
            .sort()
            .flatMap((entry) => {
              const at = path.join(dir, entry)
              const relative = path.relative(top, at)
              const stat = lstatSync(at)
              if (stat.isSymbolicLink())
                return [`${relative} -> ${readlinkSync(at)}`]
              return stat.isDirectory()
                ? [relative + '/', ...list(at)]
                : [relative]
            })
        writeFileSync(args.at(-1)!, list(top).join('\n'))
        return { code: 0, output: '' }
      }
      if (
        name === 'codesign' &&
        args[0] === '-d' &&
        args[1] === '--entitlements'
      ) {
        const values = fake.signatures.get(path.basename(args.at(-1)!))
        if (values == null)
          return {
            code: 1,
            output: `${args.at(-1)!}: code object is not signed at all\n`,
          }
        return {
          code: 0,
          output: `Executable=${args.at(-1)!}\n<?xml version="1.0"?><plist>${JSON.stringify(values)}</plist>`,
        }
      }
      if (name === 'codesign' && args[0] === '-d')
        return {
          code: 0,
          output: `Executable=${args.at(-1)!}\nTeamIdentifier=${fake.team}\n`,
        }
      if (name === 'codesign' && args[0] === '--verify') {
        if (fake.tamper === true)
          writeFileSync(
            path.join(
              args.at(-1)!,
              'PlugIns',
              'Share.appex',
              'embedded.mobileprovision',
            ),
            'swapped',
          )
        return {
          code: fake.verifyCode,
          output:
            fake.verifyCode === 0
              ? 'valid on disk\n'
              : `${args.at(-1)!}: a sealed resource is missing or invalid\n`,
        }
      }
      if (name === 'codesign' && args[0] === '--force') {
        const bundle = args.at(-1)!
        if (fake.failSign === path.basename(bundle))
          return { code: 1, output: `${bundle}: errSecInternalComponent\n` }
        const entitlements = args.includes('--entitlements')
          ? readFileSync(args[args.indexOf('--entitlements') + 1]!, 'utf8')
          : undefined
        const embedded = path.join(bundle, 'embedded.mobileprovision')
        fake.signed.push({
          bundle: path.basename(bundle),
          ...(entitlements == null ? {} : { entitlements }),
          ...(existsSync(embedded)
            ? { embedded: readFileSync(embedded, 'utf8') }
            : {}),
        })
        if (lstatSync(bundle).isDirectory()) {
          assert(!existsSync(path.join(bundle, '_CodeSignature')))
          mkdirSync(path.join(bundle, '_CodeSignature'))
          writeFileSync(
            path.join(bundle, '_CodeSignature', 'CodeResources'),
            'sealed',
          )
        }
        return { code: 0, output: `${bundle}: replacing existing signature\n` }
      }
      return { code: 1, output: `unexpected ${name} ${args.join(' ')}` }
    },
  }
  return fake
}

function setup(): {
  dir: string
  scratch: string
  fake: Fake
  logs: string[]
  reported: Array<Record<string, Plist>>
  reinstalled: Array<StageSigning['profiles']>
  context: ResignContext
} {
  const dir = root('resign-')
  const scratch = path.join(root('resign-scratch-'), 'apple')
  const fake = fakeTools()
  const logs: string[] = []
  const reported: Array<Record<string, Plist>> = []
  const reinstalled: Array<StageSigning['profiles']> = []
  return {
    dir,
    scratch,
    fake,
    logs,
    reported,
    reinstalled,
    context: {
      dir,
      scratch,
      signing: signing(),
      keychain: '/k/stage.keychain-db',
      exec: fake.exec,
      log: (text) => logs.push(text),
      entitlements: async (values): Promise<{ changed: boolean }> => {
        reported.push(values)
        return { changed: false }
      },
      reinstall: (profiles) => reinstalled.push(profiles),
      platform: 'darwin',
    },
  }
}

/** An xcarchive with the app tree, stashed by an earlier stage. */
function xcarchive(dir: string, name = 'edge'): string {
  const archive = path.join(dir, 'build', `${name}.xcarchive`)
  appTree(path.join(archive, 'Products', 'Applications', 'App.app'))
  mkdirSync(path.join(archive, 'dSYMs'), { recursive: true })
  return archive
}

const decodePlist = (xml: string): Plist => {
  // The fake's codesign keeps entitlements as written; this reads them back.
  const parse = (text: string): [unknown, string] => {
    text = text.trimStart()
    const tag = /^<(\w+)(\/?)>/.exec(text)!
    const rest = text.slice(tag[0].length)
    if (tag[2] === '/') return [tag[1] === 'true', rest]
    if (tag[1] === 'dict' || tag[1] === 'array') {
      const out: unknown[] = []
      let body = rest
      while (!body.trimStart().startsWith(`</${tag[1]}>`)) {
        const [value, next] = parse(body)
        out.push(value)
        body = next
      }
      body = body.trimStart().slice(`</${tag[1]}>`.length)
      if (tag[1] === 'array') return [out, body]
      const dict: Plist = {}
      for (let i = 0; i < out.length; i += 2)
        dict[out[i] as string] = out[i + 1]
      return [dict, body]
    }
    const end = rest.indexOf(`</${tag[1]}>`)
    const raw = rest
      .slice(0, end)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
    const value = tag[1] === 'integer' || tag[1] === 'real' ? Number(raw) : raw
    return [value, rest.slice(end + tag[1]!.length + 3)]
  }
  const body = xml.slice(xml.indexOf('<plist version="1.0">') + 21)
  return parse(body)[0] as Plist
}

describe('Re-signing an iOS build', function () {
  this.timeout(30_000)

  it('finds every bundle to sign deepest first, never through a symlink', () => {
    const dir = root('signables-')
    const app = path.join(dir, 'App.app')
    appTree(app)
    assert.deepEqual(
      signables(app).map((bundle) => [
        path.relative(dir, bundle.path),
        bundle.kind,
      ]),
      [
        [
          'App.app/Frameworks/Inner.framework/Frameworks/Deep.framework',
          'framework',
        ],
        ['App.app/Frameworks/Inner.framework', 'framework'],
        ['App.app/Frameworks/Lib.framework', 'framework'],
        ['App.app/Frameworks/libswiftCore.dylib', 'library'],
        ['App.app/PlugIns/Share.appex', 'extension'],
        ['App.app/PlugIns/Widgets.appex', 'extension'],
        ['App.app/Watch/Watch.app', 'app'],
        ['App.app', 'app'],
      ],
    )
    // A folder of bundles that is a symlink is not listed through.
    symlinkSync('Watch', path.join(app, 'AppClips'))
    assert.throws(
      () => signables(app),
      /App\.app\/AppClips is a symlink; the folders of bundles to sign must be folders/,
    )
  })

  it('rewrites entitlements for the profile: identifiers and groups to its team, its own grants, nothing it lacks', () => {
    const granted = JSON.parse(
      Buffer.from(profile(APP, 'u', groups).content, 'base64').toString(),
    ).Entitlements as Plist
    const { entitlements, dropped } = rewriteEntitlements(
      {
        'application-identifier': `${OLD}.${APP}`,
        'com.apple.developer.team-identifier': OLD,
        'keychain-access-groups': [`${OLD}.${APP}`, `${OLD}.shared`],
        'com.apple.security.application-groups': ['group.example'],
        'aps-environment': 'development',
        'get-task-allow': true,
        'com.apple.developer.healthkit': true,
      },
      { bundleId: APP, team: TEAM, entitlements: granted },
    )
    assert.deepEqual(entitlements, {
      'application-identifier': `${TEAM}.${APP}`,
      'com.apple.developer.team-identifier': TEAM,
      'keychain-access-groups': [`${TEAM}.${APP}`, `${TEAM}.shared`],
      'com.apple.security.application-groups': ['group.example'],
      'aps-environment': 'production',
      'get-task-allow': false,
      'beta-reports-active': true,
    })
    assert.deepEqual(dropped, ['com.apple.developer.healthkit'])
    // Of a key's values, only those the profile grants are kept, and named.
    const values = rewriteEntitlements(
      {
        'com.apple.security.application-groups': [
          'group.com.old',
          'group.com.new',
        ],
        'com.apple.developer.icloud-container-identifiers': ['iCloud.com.old'],
        'com.apple.developer.icloud-services': ['CloudKit', 'CloudDocuments'],
        'com.apple.developer.ubiquity-kvstore-identifier': `${OLD}.${APP}`,
        'keychain-access-groups': [`${OLD}.${APP}`, 'com.apple.token'],
        'com.apple.developer.associated-domains': ['applinks:example.com'],
        'com.apple.developer.icloud-container-environment': 'Production',
      },
      {
        bundleId: APP,
        team: TEAM,
        entitlements: {
          ...granted,
          'com.apple.security.application-groups': ['group.com.new'],
          'com.apple.developer.icloud-container-identifiers': [
            'iCloud.com.new',
          ],
          'com.apple.developer.icloud-services': ['CloudKit'],
          'com.apple.developer.ubiquity-kvstore-identifier': 'OTHER12345.*',
          'com.apple.developer.associated-domains': '*',
          'com.apple.developer.icloud-container-environment': [
            'Development',
            'Production',
          ],
        },
      },
    )
    assert.deepEqual(values.entitlements, {
      'com.apple.security.application-groups': ['group.com.new'],
      'com.apple.developer.icloud-container-identifiers': [],
      'com.apple.developer.icloud-services': ['CloudKit'],
      'keychain-access-groups': [`${TEAM}.${APP}`],
      'com.apple.developer.associated-domains': ['applinks:example.com'],
      'com.apple.developer.icloud-container-environment': 'Production',
      'application-identifier': `${TEAM}.${APP}`,
      'com.apple.developer.team-identifier': TEAM,
      'get-task-allow': false,
      'beta-reports-active': true,
    })
    assert.deepEqual(values.ungranted, [
      'com.apple.security.application-groups group.com.old',
      'com.apple.developer.icloud-container-identifiers iCloud.com.old',
      'com.apple.developer.icloud-services CloudDocuments',
      `com.apple.developer.ubiquity-kvstore-identifier ${TEAM}.${APP}`,
      'keychain-access-groups com.apple.token',
    ])
    // A legacy App ID prefix, not the team ID, is the profile's own.
    const legacy = rewriteEntitlements(
      { 'keychain-access-groups': [`${OLD}.${APP}`] },
      {
        bundleId: APP,
        team: TEAM,
        entitlements: {
          'application-identifier': `LEGACY1234.${APP}`,
          'keychain-access-groups': ['LEGACY1234.*'],
        },
      },
    )
    assert.deepEqual(legacy.entitlements['keychain-access-groups'], [
      `LEGACY1234.${APP}`,
    ])
    assert.equal(
      legacy.entitlements['application-identifier'],
      `LEGACY1234.${APP}`,
    )
    assert.equal(
      legacy.entitlements['com.apple.developer.team-identifier'],
      TEAM,
    )
    // A wildcard application identifier becomes the bundle's own.
    assert.equal(
      rewriteEntitlements(
        {},
        {
          bundleId: APP,
          team: TEAM,
          entitlements: { 'application-identifier': `${TEAM}.*` },
        },
      ).entitlements['application-identifier'],
      `${TEAM}.${APP}`,
    )
    // A profile's wildcards are grants, not entitlements.
    assert.deepEqual(
      profileEntitlements({
        'application-identifier': `${TEAM}.${APP}`,
        'keychain-access-groups': [`${TEAM}.*`, 'com.apple.token'],
        'com.apple.developer.associated-domains': '*',
        'com.apple.developer.icloud-services': { kind: ['*'] },
        'get-task-allow': false,
      }),
      { 'application-identifier': `${TEAM}.${APP}`, 'get-task-allow': false },
    )
    const xml = entitlementsPlist({
      a: 1,
      b: 1.5,
      c: [true, false],
      d: { e: 'x & <y>' },
    })
    assert.deepEqual(decodePlist(xml), {
      a: 1,
      b: 1.5,
      c: [true, false],
      d: { e: 'x & <y>' },
    })
    assert.match(xml, /<integer>1<\/integer><key>b<\/key><real>1.5<\/real>/)
    assert.throws(() => entitlementsPlist({ a: null }), /cannot be null/)
  })

  it('re-signs an archive deepest first with each bundle’s profile and entitlements, syncs a missing capability with the master, and packages the ipa', async () => {
    const { dir, scratch, fake, logs, reported, reinstalled, context } = setup()
    const archive = xcarchive(dir)
    mkdirSync(path.join(archive, 'SwiftSupport', 'iphoneos'), {
      recursive: true,
    })
    writeFileSync(
      path.join(archive, 'SwiftSupport', 'iphoneos', 'libswiftCore.dylib'),
      'swift',
    )
    // The app's own signature, from another team, asks for HealthKit too.
    fake.signatures.set('App.app', {
      'application-identifier': `${OLD}.${APP}`,
      'keychain-access-groups': [`${OLD}.${APP}`],
      'get-task-allow': true,
      ...groups,
      'com.apple.developer.healthkit': true,
    })
    // An ad hoc signature with no entitlements, and one the call overrides.
    fake.signatures.set('Watch.app', {})
    fake.signatures.set('Widgets.appex', { 'get-task-allow': true })
    mkdirSync(path.join(dir, 'ios'))
    writeFileSync(
      path.join(dir, 'ios', 'Widgets.entitlements'),
      JSON.stringify(groups),
    )
    // The master adds HealthKit and makes the app's profile again.
    const renewed = profile(APP, '55555555-5555-5555-5555-555555555555', {
      ...groups,
      'com.apple.developer.healthkit': true,
    })
    context.entitlements = async (
      values,
    ): Promise<{ changed: boolean; profiles: StageSigning['profiles'] }> => {
      reported.push(values)
      return {
        changed: true,
        profiles: [renewed, ...context.signing.profiles.slice(1)],
      }
    }
    const result = await resign(context, {
      path: 'build/edge.xcarchive',
      entitlements: { [`${APP}.widgets`]: 'ios/Widgets.entitlements' },
      version: '4.12.0',
      buildNumber: '26110101',
    })
    assert.equal(result.ipa, path.join(dir, 'build', 'edge-appStore.ipa'))
    // Deepest first, so each outer signature seals the inner ones.
    assert.deepEqual(
      fake.signed.map((entry) => entry.bundle),
      [
        'Deep.framework',
        'Inner.framework',
        'Lib.framework',
        'libswiftCore.dylib',
        'Share.appex',
        'Widgets.appex',
        'Watch.app',
        'App.app',
      ],
    )
    assert.deepEqual(result.bundles, [
      {
        path: 'Payload/App.app/Frameworks/Inner.framework/Frameworks/Deep.framework',
        bundleId: 'app.example.deep',
      },
      {
        path: 'Payload/App.app/Frameworks/Inner.framework',
        bundleId: 'app.example.inner',
      },
      {
        path: 'Payload/App.app/Frameworks/Lib.framework',
        bundleId: 'app.example.lib',
      },
      { path: 'Payload/App.app/Frameworks/libswiftCore.dylib' },
      {
        path: 'Payload/App.app/PlugIns/Share.appex',
        bundleId: `${APP}.share`,
        profile: `Mason AppStore ${APP}.share`,
      },
      {
        path: 'Payload/App.app/PlugIns/Widgets.appex',
        bundleId: `${APP}.widgets`,
        profile: `Mason AppStore ${APP}.widgets`,
      },
      {
        path: 'Payload/App.app/Watch/Watch.app',
        bundleId: `${APP}.watch`,
        profile: `Mason AppStore ${APP}.watch`,
      },
      {
        path: 'Payload/App.app',
        bundleId: APP,
        profile: `Mason AppStore ${APP}`,
      },
    ])
    // Frameworks and dylibs take no profile and no entitlements.
    for (const entry of fake.signed.slice(0, 4)) {
      assert.equal(entry.entitlements, undefined)
      assert.equal(entry.embedded, undefined)
    }
    const signedAs = (
      bundle: string,
    ): { entitlements: Plist; embedded: Plist } => {
      const entry = fake.signed.find((item) => item.bundle === bundle)!
      return {
        entitlements: decodePlist(entry.entitlements!),
        embedded: JSON.parse(entry.embedded!) as Plist,
      }
    }
    // The app: its signature's entitlements moved to the team, HealthKit kept
    // once the master granted it, signed with the new profile.
    const app = signedAs('App.app')
    assert.deepEqual(app.entitlements, {
      'application-identifier': `${TEAM}.${APP}`,
      'com.apple.developer.team-identifier': TEAM,
      'keychain-access-groups': [`${TEAM}.${APP}`],
      'get-task-allow': false,
      'beta-reports-active': true,
      ...groups,
      'com.apple.developer.healthkit': true,
    })
    assert.equal(app.embedded.UUID, '55555555-5555-5555-5555-555555555555')
    assert.deepEqual(reported, [
      {
        [APP]: {
          'application-identifier': `${OLD}.${APP}`,
          'keychain-access-groups': [`${OLD}.${APP}`],
          'get-task-allow': true,
          ...groups,
          'com.apple.developer.healthkit': true,
        },
      },
    ])
    assert.deepEqual(
      reinstalled.map((profiles) => profiles[0]!.uuid),
      ['55555555-5555-5555-5555-555555555555'],
    )
    // The call's entitlements win over the extension's own signature.
    assert.deepEqual(signedAs('Widgets.appex').entitlements, {
      ...groups,
      'application-identifier': `${TEAM}.${APP}.widgets`,
      'com.apple.developer.team-identifier': TEAM,
      'get-task-allow': false,
      'beta-reports-active': true,
    })
    // Unsigned, or signed without entitlements: the profile's, without wildcards.
    for (const [bundle, id] of [
      ['Share.appex', `${APP}.share`],
      ['Watch.app', `${APP}.watch`],
    ] as const) {
      const signedEntry = signedAs(bundle)
      assert.deepEqual(signedEntry.entitlements, {
        'application-identifier': `${TEAM}.${id}`,
        'com.apple.developer.team-identifier': TEAM,
        'get-task-allow': false,
        'beta-reports-active': true,
      })
      assert.equal(signedEntry.embedded['application-identifier'], undefined)
      assert.equal(
        (signedEntry.embedded.Entitlements as Plist)['application-identifier'],
        `${TEAM}.${id}`,
      )
    }
    // Every codesign names the stage's identity and keychain, with no timestamp.
    for (const call of fake.calls.filter(
      (entry) => entry[0] === 'codesign' && entry[1] === '--force',
    ))
      assert.deepEqual(call.slice(1, 9), [
        '--force',
        '--sign',
        'A'.repeat(40),
        '--keychain',
        '/k/stage.keychain-db',
        '--timestamp=none',
        '--generate-entitlement-der',
        ...(call.includes('--entitlements')
          ? ['--entitlements']
          : [call.at(-1)!]),
      ])
    // Verified deep and strict, and every bundle's team checked.
    assert.deepEqual(
      fake.calls.find((call) => call[1] === '--verify')!.slice(1, 5),
      ['--verify', '--deep', '--strict', '--verbose=2'],
    )
    assert.equal(
      fake.calls.filter((call) => call[1] === '-d' && call[2] === '--verbose=2')
        .length,
      8,
    )
    // Versions set in the app and each extension, not the frameworks.
    assert.equal(fake.calls.filter((call) => call[1] === '-replace').length, 8)
    // The ipa: Payload and SwiftSupport at the top, the framework's symlinks kept.
    const listing = readFileSync(result.ipa, 'utf8').split('\n')
    assert.deepEqual(
      listing.filter((line) => line.replace(/\/$/, '').split('/').length <= 2),
      [
        'Payload/',
        'Payload/App.app/',
        'SwiftSupport/',
        'SwiftSupport/iphoneos/',
      ],
    )
    for (const line of [
      'Payload/App.app/Frameworks/Lib.framework/Lib -> Versions/Current/Lib',
      'Payload/App.app/Frameworks/Lib.framework/Versions/Current -> A',
      'Payload/App.app/Frameworks/Alias.framework -> Inner.framework',
      'Payload/App.app/embedded.mobileprovision',
      'Payload/App.app/_CodeSignature/CodeResources',
      'SwiftSupport/iphoneos/libswiftCore.dylib',
    ])
      assert(listing.includes(line), line)
    assert.deepEqual(
      fake.calls.find((call) => call[0] === 'ditto')!.slice(1, 7),
      ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--noacl'],
    )
    // The input is untouched, the scratch copy gone, and the log has one line per bundle.
    assert(
      !existsSync(
        path.join(
          archive,
          'Products',
          'Applications',
          'App.app',
          'embedded.mobileprovision',
        ),
      ),
    )
    assert.deepEqual(readdirSync(scratch), [])
    assert.equal(logs.filter((line) => line.startsWith('Signed ')).length, 8)
    assert(
      logs.includes(
        `Signed Payload/App.app (${APP}) with Mason AppStore ${APP}\n`,
      ),
    )
    assert(logs.some((line) => /master added the capabilities/.test(line)))
    assert(logs.includes('Wrote build/edge-appStore.ipa for appStore\n'))
  })

  it('re-signs an ipa or an app, dropping what the profile lacks when the master adds nothing', async () => {
    const { dir, fake, logs, reported, reinstalled, context } = setup()
    const tree = path.join(dir, 'App.ipa.tree')
    appTree(path.join(tree, 'Payload', 'App.app'))
    mkdirSync(path.join(tree, 'SwiftSupport'))
    writeFileSync(path.join(dir, 'App.ipa'), 'zip')
    const asked = {
      'com.apple.developer.healthkit': true,
      'com.apple.security.application-groups': ['group.example', 'group.old'],
    }
    fake.signatures.set('App.app', asked)
    const fromIpa = await resign(context, {
      path: 'App.ipa',
      output: 'out/Edge.ipa',
    })
    assert.equal(fromIpa.ipa, path.join(dir, 'out', 'Edge.ipa'))
    assert(
      readFileSync(fromIpa.ipa, 'utf8').split('\n').includes('SwiftSupport/'),
    )
    assert.deepEqual(reported, [{ [APP]: asked }])
    assert(
      logs.includes(
        `${APP}: its profile does not grant the values com.apple.security.application-groups group.old; signed without them\n`,
      ),
    )
    assert.deepEqual(
      decodePlist(fake.signed.at(-1)!.entitlements!)[
        'com.apple.security.application-groups'
      ],
      ['group.example'],
    )
    assert.deepEqual(reinstalled, [])
    assert(
      logs.includes(
        `${APP}: its profile does not grant com.apple.developer.healthkit; signed without them\n`,
      ),
    )
    assert.equal(
      decodePlist(fake.signed.at(-1)!.entitlements!)[
        'com.apple.developer.healthkit'
      ],
      undefined,
    )
    // The extracted ipa had extended attributes cleared before signing,
    // a symlink's own and never its target's.
    assert(fake.calls.some((call) => call[0] === 'xattr' && call[1] === '-crs'))
    // An archive's SwiftSupport that is a symlink is left out.
    const archive = xcarchive(dir, 'linked')
    symlinkSync('/usr/lib', path.join(archive, 'SwiftSupport'))
    const linked = await resign(context, { path: 'build/linked.xcarchive' })
    assert(
      !readFileSync(linked.ipa, 'utf8')
        .split('\n')
        .some((line) => line.startsWith('SwiftSupport')),
    )
    const app = path.join(dir, 'build', 'App.app')
    appTree(app)
    const fromApp = await resign(context, { path: 'build/App.app' })
    assert.equal(fromApp.ipa, path.join(dir, 'build', 'App-appStore.ipa'))
    assert(
      !readFileSync(fromApp.ipa, 'utf8').split('\n').includes('SwiftSupport/'),
    )
    // A tvOS app is laid out as an iOS app, and signed the same way.
    const tv = await resign(
      { ...context, signing: { ...context.signing, platform: 'tvos' } },
      { path: 'build/App.app', output: 'build/TV.ipa' },
    )
    assert.equal(tv.ipa, path.join(dir, 'build', 'TV.ipa'))
    assert(readFileSync(tv.ipa, 'utf8').split('\n').includes('Payload/'))
  })

  it('names the bundle IDs a build needs when the stage lacks a profile, or a bundle has no identifier', async () => {
    const { dir, context } = setup()
    xcarchive(dir)
    context.signing.profiles = context.signing.profiles.filter(
      (entry) =>
        !entry.bundleId.endsWith('.watch') &&
        !entry.bundleId.endsWith('.share'),
    )
    await assert.rejects(resign(context, { path: 'build/edge.xcarchive' }), {
      message: `This build signs ${APP}.share, ${APP}.widgets, ${APP}.watch, ${APP}; the stage has no profile for ${APP}.share, ${APP}.watch. List every one in the app ID's bundle IDs and the stage's apple.bundleIds`,
    })
    const other = setup()
    const archive = xcarchive(other.dir)
    info(
      path.join(
        archive,
        'Products',
        'Applications',
        'App.app',
        'PlugIns',
        'Bare.appex',
      ),
    )
    await assert.rejects(
      resign(other.context, { path: 'build/edge.xcarchive' }),
      /Payload\/App\.app\/PlugIns\/Bare\.appex has no CFBundleIdentifier/,
    )
  })

  it('stops with the tool’s output when codesign fails, the app does not verify, or a bundle is signed for another team or profile', async () => {
    const failing = setup()
    xcarchive(failing.dir)
    failing.fake.failSign = 'Widgets.appex'
    await assert.rejects(
      resign(failing.context, { path: 'build/edge.xcarchive' }),
      /codesign --force failed \(exit 1\): .*Widgets\.appex: errSecInternalComponent/,
    )
    const unverified = setup()
    xcarchive(unverified.dir)
    unverified.fake.verifyCode = 3
    await assert.rejects(
      resign(unverified.context, { path: 'build/edge.xcarchive' }),
      /The re-signed app does not verify: .*a sealed resource is missing or invalid/,
    )
    assert(!existsSync(path.join(unverified.dir, 'build', 'edge-appStore.ipa')))
    assert.deepEqual(readdirSync(unverified.scratch), [])
    const otherTeam = setup()
    xcarchive(otherTeam.dir)
    otherTeam.fake.team = 'not set'
    await assert.rejects(
      resign(otherTeam.context, { path: 'build/edge.xcarchive' }),
      /Deep\.framework is signed for team not set, not ABCDE12345/,
    )
    const swapped = setup()
    xcarchive(swapped.dir)
    swapped.fake.tamper = true
    await assert.rejects(
      resign(swapped.context, { path: 'build/edge.xcarchive' }),
      /Share\.appex does not hold profile 33333333-3333-3333-3333-333333333333/,
    )
    const teamless = setup()
    xcarchive(teamless.dir)
    teamless.context.signing.profiles[0] = profile(
      APP,
      '11111111-1111-1111-1111-111111111111',
      {},
      '',
    )
    await assert.rejects(
      resign(teamless.context, { path: 'build/edge.xcarchive' }),
      /Profile Mason AppStore app\.example\.signed names no team/,
    )
  })

  it('never writes through a symlink inside the app', async () => {
    const outside = root('resign-target-')
    const target = path.join(outside, 'authorized_keys')
    writeFileSync(target, 'keep')
    // A profile's place pointing out of the app is refused before anything is written.
    const out = setup()
    const archive = xcarchive(out.dir)
    const app = path.join(archive, 'Products', 'Applications', 'App.app')
    symlinkSync(target, path.join(app, 'embedded.mobileprovision'))
    await assert.rejects(
      resign(out.context, { path: 'build/edge.xcarchive' }),
      /Payload\/App\.app\/embedded\.mobileprovision is a symlink out of the package \(to .*authorized_keys\)/,
    )
    const climbing = setup()
    const other = xcarchive(climbing.dir)
    symlinkSync(
      '../../../../../escape',
      path.join(other, 'Products', 'Applications', 'App.app', 'Watch', 'up'),
    )
    await assert.rejects(
      resign(climbing.context, { path: 'build/edge.xcarchive' }),
      /Payload\/App\.app\/Watch\/up is a symlink out of the package/,
    )
    assert.equal(readFileSync(target, 'utf8'), 'keep')
    // Links read as text stay in Payload; as the system follows them, the
    // second ends above the package, and an extension folder through it.
    const chained = setup()
    const chainedApp = path.join(
      xcarchive(chained.dir),
      'Products',
      'Applications',
      'App.app',
    )
    const away = path.join(path.dirname(chained.scratch), 'away')
    info(path.join(away, 'Evil.appex'), `${APP}.share`)
    const links = path.join(chainedApp, 'Frameworks', 'Inner.framework')
    symlinkSync('../../..', path.join(links, 'd'))
    symlinkSync('d/../../../..', path.join(links, 'x'))
    symlinkSync(
      'Frameworks/Inner.framework/x/away',
      path.join(chainedApp, 'Extensions'),
    )
    await assert.rejects(
      resign(chained.context, { path: 'build/edge.xcarchive', version: '9.9' }),
      /Payload\/App\.app\/(Extensions|Frameworks\/Inner\.framework\/x) is a symlink out of the package \(to (Frameworks\/Inner\.framework\/x\/away|d\/\.\.\/\.\.\/\.\.\/\.\.)\)/,
    )
    assert.deepEqual(readdirSync(path.join(away, 'Evil.appex')), ['Info.plist'])
    assert.equal(
      JSON.parse(
        readFileSync(path.join(away, 'Evil.appex', 'Info.plist'), 'utf8'),
      ).CFBundleShortVersionString,
      '1.0',
    )
    // One inside the app is replaced by the profile, not written through.
    const inner = setup()
    const kept = xcarchive(inner.dir)
    const innerApp = path.join(kept, 'Products', 'Applications', 'App.app')
    writeFileSync(path.join(innerApp, 'PkgInfo'), 'APPL????')
    symlinkSync('PkgInfo', path.join(innerApp, 'embedded.mobileprovision'))
    const signed = await resign(inner.context, { path: 'build/edge.xcarchive' })
    const listing = readFileSync(signed.ipa, 'utf8').split('\n')
    assert(listing.includes('Payload/App.app/embedded.mobileprovision'))
    assert(listing.includes('Payload/App.app/PkgInfo'))
    assert.equal(
      inner.fake.signed.find((entry) => entry.bundle === 'App.app')!.embedded,
      Buffer.from(
        inner.context.signing.profiles[0]!.content,
        'base64',
      ).toString(),
    )
    // An Info.plist that is written to must be a file, wherever it points.
    const plist = setup()
    const share = path.join(
      xcarchive(plist.dir),
      'Products',
      'Applications',
      'App.app',
      'PlugIns',
      'Share.appex',
    )
    cpSync(path.join(share, 'Info.plist'), path.join(share, 'Real.plist'))
    rmSync(path.join(share, 'Info.plist'))
    symlinkSync('Real.plist', path.join(share, 'Info.plist'))
    await assert.rejects(
      resign(plist.context, { path: 'build/edge.xcarchive', version: '2.0' }),
      /Payload\/App\.app\/PlugIns\/Share\.appex\/Info\.plist is a symlink; an app's or extension's Info\.plist must be a file/,
    )
  })

  it('keeps every folder of an ipa beside Payload, but not a symlink in its place', async () => {
    const { dir, context } = setup()
    const tree = path.join(dir, 'Full.ipa.tree')
    appTree(path.join(tree, 'Payload', 'App.app'))
    for (const name of [
      'SwiftSupport',
      'WatchKitSupport2',
      'MessagesApplicationSupport',
      'Symbols',
      '__MACOSX',
    ]) {
      mkdirSync(path.join(tree, name))
      writeFileSync(path.join(tree, name, 'file'), name)
    }
    writeFileSync(path.join(tree, 'iTunesMetadata.plist'), '{}')
    symlinkSync(root('resign-elsewhere-'), path.join(tree, 'Linked'))
    writeFileSync(path.join(dir, 'Full.ipa'), 'zip')
    const { ipa } = await resign(context, { path: 'Full.ipa' })
    const top = readFileSync(ipa, 'utf8')
      .split('\n')
      .filter((line) => !line.includes('/') || /^[^/]+\/$/.test(line))
    assert.deepEqual(top, [
      'MessagesApplicationSupport/',
      'Payload/',
      'SwiftSupport/',
      'Symbols/',
      'WatchKitSupport2/',
    ])
  })

  it('refuses a non-macOS node, a macOS stage, and paths or options outside what it takes', async () => {
    const { dir, context } = setup()
    xcarchive(dir)
    await assert.rejects(
      resign(
        { ...context, platform: 'linux' },
        { path: 'build/edge.xcarchive' },
      ),
      /runs only on macOS: it signs with Apple’s codesign/,
    )
    await assert.rejects(
      resign(
        { ...context, signing: { ...context.signing, platform: 'macos' } },
        { path: 'build/edge.xcarchive' },
      ),
      /signs iOS and tvOS builds; this stage signs for macOS/,
    )
    const refusals: Array<[unknown, RegExp]> = [
      [{}, /needs the path of an \.ipa, \.xcarchive or \.app/],
      [
        { path: '../edge.xcarchive' },
        /input \.\.\/edge\.xcarchive must stay in the workspace/,
      ],
      [
        { path: 'build/edge.xcarchive', output: '/tmp/edge.ipa' },
        /output \/tmp\/edge\.ipa must stay in the workspace/,
      ],
      [
        { path: 'build/edge.xcarchive', output: 'build/edge.zip' },
        /writes an \.ipa/,
      ],
      [
        { path: 'build/edge.xcarchive', entitlements: { [APP]: '../x.plist' } },
        /entitlements \.\.\/x\.plist must stay in the workspace/,
      ],
      [
        { path: 'build/edge.xcarchive', entitlements: { [APP]: 7 } },
        /entitlements maps bundle IDs to plist paths/,
      ],
      [
        { path: 'build/edge.xcarchive', version: '4.x' },
        /version must be one to three numbers/,
      ],
      [
        { path: 'build/edge.xcarchive', buildNumber: 7 },
        /buildNumber must be one to three numbers/,
      ],
      [
        { path: 'build/missing.xcarchive' },
        /missing\.xcarchive does not exist/,
      ],
      [{ path: 'build' }, /takes an \.ipa, \.xcarchive or \.app, not build/],
    ]
    for (const [options, expected] of refusals)
      await assert.rejects(resign(context, options as never), expected)
    // An archive must hold exactly one app.
    mkdirSync(
      path.join(
        dir,
        'build',
        'two.xcarchive',
        'Products',
        'Applications',
        'A.app',
      ),
      { recursive: true },
    )
    mkdirSync(
      path.join(
        dir,
        'build',
        'two.xcarchive',
        'Products',
        'Applications',
        'B.app',
      ),
    )
    mkdirSync(path.join(dir, 'build', 'none.xcarchive'))
    await assert.rejects(
      resign(context, { path: 'build/two.xcarchive' }),
      /two\.xcarchive must hold exactly one app; found A\.app, B\.app/,
    )
    await assert.rejects(
      resign(context, { path: 'build/none.xcarchive' }),
      /none\.xcarchive must hold exactly one app; found none/,
    )
    writeFileSync(path.join(dir, 'bad.entitlements'), 'binary')
    await assert.rejects(
      resign(context, {
        path: 'build/edge.xcarchive',
        entitlements: { [APP]: 'bad.entitlements' },
      }),
      /plutil -convert failed \(exit 1\): not a plist/,
    )
    // A symlink in the workspace does not take a path out of it.
    const outside = root('resign-outside-')
    symlinkSync(outside, path.join(dir, 'out'))
    xcarchive(outside, 'away')
    symlinkSync(
      path.join(outside, 'build', 'away.xcarchive'),
      path.join(dir, 'build', 'away.xcarchive'),
    )
    for (const [options, expected] of [
      [
        { path: 'build/edge.xcarchive', output: 'out/edge.ipa' },
        /output out\/edge\.ipa must stay in the workspace/,
      ],
      [
        { path: 'build/edge.xcarchive', output: 'out/new/edge.ipa' },
        /output out\/new\/edge\.ipa must stay in the workspace/,
      ],
      [
        { path: 'build/away.xcarchive' },
        /input build\/away\.xcarchive must stay in the workspace/,
      ],
    ] as const)
      await assert.rejects(resign(context, options), expected)
    symlinkSync(
      path.join(outside, 'gone'),
      path.join(dir, 'build', 'dangling.ipa'),
    )
    await assert.rejects(
      resign(context, {
        path: 'build/edge.xcarchive',
        output: 'build/dangling.ipa',
      }),
      /output build\/dangling\.ipa must stay in the workspace/,
    )
    assert.deepEqual(readdirSync(outside).sort(), ['build'])
    // Read as text, k/x is k; as the system follows d first, it is above the workspace.
    mkdirSync(path.join(dir, 'k'))
    symlinkSync('..', path.join(dir, 'k', 'd'))
    symlinkSync('d/..', path.join(dir, 'k', 'x'))
    await assert.rejects(
      resign(context, {
        path: 'build/edge.xcarchive',
        output: 'k/x/escaped.ipa',
      }),
      /output k\/x\/escaped\.ipa must stay in the workspace/,
    )
    assert(!existsSync(path.join(path.dirname(dir), 'escaped.ipa')))
    // Nor does one inside the input: the app is found only within it.
    mkdirSync(path.join(dir, 'build', 'linked.xcarchive'))
    symlinkSync(
      path.join(outside, 'build', 'away.xcarchive', 'Products'),
      path.join(dir, 'build', 'linked.xcarchive', 'Products'),
    )
    await assert.rejects(
      resign(context, { path: 'build/linked.xcarchive' }),
      /linked\.xcarchive must hold exactly one app; found none/,
    )
    const tree = path.join(dir, 'Linked.ipa.tree')
    mkdirSync(tree)
    symlinkSync(
      path.join(outside, 'build', 'away.xcarchive', 'Products', 'Applications'),
      path.join(tree, 'Payload'),
    )
    writeFileSync(path.join(dir, 'Linked.ipa'), 'zip')
    await assert.rejects(
      resign(context, { path: 'Linked.ipa' }),
      /Linked\.ipa must hold exactly one app; found none/,
    )
    writeFileSync(path.join(dir, 'list.entitlements'), '["a"]')
    await assert.rejects(
      resign(context, {
        path: 'build/edge.xcarchive',
        entitlements: { [APP]: 'list.entitlements' },
      }),
      /list\.entitlements is not a dictionary/,
    )
  })
})
