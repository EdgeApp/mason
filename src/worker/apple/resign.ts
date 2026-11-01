import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { StageSigning } from '../../pipeline/assignment.js'
import type { ArchiveContext } from './archive.js'

export interface ResignOptions {
  /** An `.ipa`, `.xcarchive` or `.app` in the workspace. */
  path: string
  /** The `.ipa` to write; beside the input, `<name>-<distribution>.ipa`, by default. */
  output?: string
  /** Entitlements plists in the workspace, by bundle ID; they win over the input's own. */
  entitlements?: Record<string, string>
  version?: string
  buildNumber?: string
}
export interface ResignResult {
  ipa: string
  /** Every bundle signed, deepest first, by its path in the `.ipa`. */
  bundles: Array<{ path: string; bundleId?: string; profile?: string }>
}

/** What `ctx.apple.resign` needs from the worker: the archive's, without export options. */
export type ResignContext = Omit<ArchiveContext, 'exportOptions'> & {
  /** The node's platform; this process's by default. */
  platform?: NodeJS.Platform
}

const CODESIGN = '/usr/bin/codesign'
const DITTO = '/usr/bin/ditto'
const PLUTIL = '/usr/bin/plutil'
const SECURITY = '/usr/bin/security'
const XATTR = '/usr/bin/xattr'

type Kind = 'app' | 'extension' | 'framework' | 'library'
interface Bundle {
  path: string
  kind: Kind
  bundleId?: string
}
type Plist = Record<string, unknown>
interface Profile {
  bundleId: string
  name: string
  uuid: string
  content: Buffer
  team: string
  entitlements: Plist
}

const takesProfile = (bundle: Bundle): boolean =>
  bundle.kind === 'app' || bundle.kind === 'extension'

const sorted = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).sort() : []

/**
 * A bundle and everything inside it that is signed separately, deepest
 * first, so each outer signature seals the inner ones: frameworks, dylibs
 * and test bundles in `Frameworks`, extensions in `PlugIns` and
 * `Extensions`, watch apps and app clips. Symlinks are never followed.
 */
export function signables(bundle: string, kind: Kind = 'app'): Bundle[] {
  const out: Bundle[] = []
  const take = (sub: string, test: RegExp, inner: Kind): void => {
    for (const name of sorted(path.join(bundle, sub))) {
      if (!test.test(name)) continue
      const file = path.join(bundle, sub, name)
      const info = lstatSync(file)
      if (inner === 'library') {
        if (info.isFile()) out.push({ path: file, kind: inner })
      } else if (info.isDirectory()) out.push(...signables(file, inner))
    }
  }
  take('Frameworks', /\.(framework|xctest)$/, 'framework')
  take('Frameworks', /\.dylib$/, 'library')
  take('PlugIns', /\.appex$/, 'extension')
  take('Extensions', /\.appex$/, 'extension')
  take('Watch', /\.app$/, 'app')
  take('AppClips', /\.app$/, 'app')
  out.push({ path: bundle, kind })
  return out
}

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function plistValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (typeof value === 'number')
    return Number.isInteger(value)
      ? `<integer>${value}</integer>`
      : `<real>${value}</real>`
  if (typeof value === 'string') return `<string>${escape(value)}</string>`
  if (Array.isArray(value))
    return `<array>${value.map(plistValue).join('')}</array>`
  if (value != null && typeof value === 'object')
    return `<dict>${Object.entries(value)
      .map(([key, entry]) => `<key>${escape(key)}</key>${plistValue(entry)}`)
      .join('')}</dict>`
  throw new Error(`An entitlement value cannot be ${String(value)}`)
}

/** Entitlements as an XML property list for `codesign --entitlements`. */
export function entitlementsPlist(values: Plist): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${plistValue(values)}</plist>
`
}

const wildcard = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.includes('*')
    : Array.isArray(value)
      ? value.some(wildcard)
      : value != null && typeof value === 'object'
        ? Object.values(value).some(wildcard)
        : false

/** A profile's entitlements a bundle can carry as they are: wildcards are grants, not entitlements. */
export function profileEntitlements(granted: Plist): Plist {
  return Object.fromEntries(
    Object.entries(granted).filter(([, value]) => !wildcard(value)),
  )
}

/** Values that start with a team ID, which moves to the profile's team. */
const teamPrefixed = new Set([
  'keychain-access-groups',
  'com.apple.security.application-groups',
  'com.apple.developer.ubiquity-kvstore-identifier',
  'com.apple.developer.associated-appclip-app-identifiers',
  'com.apple.developer.parent-application-identifiers',
])
/** Values the profile decides, whatever the build carried. */
const fromProfile = [
  'application-identifier',
  'com.apple.developer.team-identifier',
  'get-task-allow',
  'beta-reports-active',
]

/**
 * A bundle's entitlements rewritten for its profile: the application and
 * team identifiers from the profile, team-prefixed groups moved to its
 * team, `get-task-allow`, `beta-reports-active` and `aps-environment` as
 * the profile grants them, and every key it does not grant dropped (and
 * named, so a missing capability can be added).
 */
export function rewriteEntitlements(
  values: Plist,
  profile: Pick<Profile, 'bundleId' | 'team' | 'entitlements'>,
): { entitlements: Plist; dropped: string[] } {
  const granted = profile.entitlements
  const team = profile.team
  const out: Plist = {}
  const dropped: string[] = []
  const retarget = (value: unknown): unknown =>
    typeof value === 'string'
      ? value.replace(/^[A-Z0-9]{10}\./, `${team}.`)
      : Array.isArray(value)
        ? value.map(retarget)
        : value
  for (const [key, value] of Object.entries(values)) {
    if (fromProfile.includes(key)) continue
    if (!(key in granted)) dropped.push(key)
    else if (key === 'aps-environment') out[key] = granted[key]
    else out[key] = teamPrefixed.has(key) ? retarget(value) : value
  }
  const identifier = granted['application-identifier']
  out['application-identifier'] =
    typeof identifier === 'string' && !identifier.includes('*')
      ? identifier
      : `${team}.${profile.bundleId}`
  out['com.apple.developer.team-identifier'] = team
  for (const key of ['get-task-allow', 'beta-reports-active'])
    if (key in granted) out[key] = granted[key]
  return { entitlements: out, dropped }
}

/** Runs a tool and resolves with its output; a failure carries the output's end. */
async function tool(
  context: ResignContext,
  file: string,
  args: string[],
): Promise<string> {
  const out = await context.exec(file, args, { cwd: context.dir })
  if (out.code !== 0)
    throw new Error(
      `${path.basename(file)} ${args[0]} failed (exit ${out.code}): ${out.output.trim().slice(-4000)}`,
    )
  return out.output
}

async function readPlist(context: ResignContext, file: string): Promise<Plist> {
  const text = await tool(context, PLUTIL, [
    '-convert',
    'json',
    '-o',
    '-',
    file,
  ])
  const value = JSON.parse(text) as unknown
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${file} is not a dictionary`)
  return value as Plist
}

/** The text of a key in a plist, or undefined when it has none. */
async function plistString(
  context: ResignContext,
  file: string,
  key: string,
): Promise<string | undefined> {
  if (!existsSync(file)) return undefined
  const out = await context.exec(
    PLUTIL,
    ['-extract', key, 'raw', '-o', '-', file],
    { cwd: context.dir },
  )
  return out.code === 0 ? out.output.trim() : undefined
}

/** A profile's team and entitlements, from the CMS envelope Apple signs it in. */
async function readProfile(
  context: ResignContext,
  work: string,
  profile: StageSigning['profiles'][number],
): Promise<Profile> {
  const file = path.join(work, `${profile.uuid}.mobileprovision`)
  const decoded = `${file}.plist`
  const content = Buffer.from(profile.content, 'base64')
  writeFileSync(file, content)
  await tool(context, SECURITY, ['cms', '-D', '-i', file, '-o', decoded])
  // Only these parts: a profile's dates and certificates have no JSON form.
  const extract = async (key: string): Promise<unknown> =>
    JSON.parse(
      await tool(context, PLUTIL, [
        '-extract',
        key,
        'json',
        '-o',
        '-',
        decoded,
      ]),
    ) as unknown
  const teams = await extract('TeamIdentifier')
  const team = Array.isArray(teams) ? teams[0] : undefined
  if (typeof team !== 'string')
    throw new Error(`Profile ${profile.name} names no team`)
  return {
    bundleId: profile.bundleId,
    name: profile.name,
    uuid: profile.uuid,
    content,
    team,
    entitlements: (await extract('Entitlements')) as Plist,
  }
}

/** The entitlements a bundle's own signature carries, when it has any. */
async function signedEntitlements(
  context: ResignContext,
  work: string,
  bundle: Bundle,
  index: number,
): Promise<Plist | undefined> {
  const out = await context.exec(
    CODESIGN,
    ['-d', '--entitlements', '-', '--xml', bundle.path],
    { cwd: context.dir },
  )
  const start = out.output.search(/<\?xml|<plist/)
  const end = out.output.lastIndexOf('</plist>')
  if (out.code !== 0 || start < 0 || end < start) return undefined
  const file = path.join(work, `signed-${index}.plist`)
  writeFileSync(file, out.output.slice(start, end + '</plist>'.length))
  const values = await readPlist(context, file)
  return Object.keys(values).length === 0 ? undefined : values
}

function inside(dir: string, file: string, what: string): string {
  const resolved = path.resolve(dir, file)
  if (!resolved.startsWith(dir + path.sep))
    throw new Error(`The re-sign ${what} ${file} must stay in the workspace`)
  return resolved
}

const versionPattern = /^[0-9]+(\.[0-9]+){0,2}$/

function checkOptions(options: ResignOptions): void {
  if (typeof options?.path !== 'string' || options.path === '')
    throw new Error(
      'ctx.apple.resign needs the path of an .ipa, .xcarchive or .app',
    )
  for (const key of ['version', 'buildNumber'] as const) {
    const value = options[key]
    if (
      value != null &&
      (typeof value !== 'string' || !versionPattern.test(value))
    )
      throw new Error(
        `ctx.apple.resign ${key} must be one to three numbers separated by dots`,
      )
  }
  if (options.output != null && !/\.ipa$/.test(String(options.output)))
    throw new Error('ctx.apple.resign writes an .ipa')
  const entitlements = options.entitlements ?? {}
  if (
    typeof entitlements !== 'object' ||
    Array.isArray(entitlements) ||
    Object.values(entitlements).some((file) => typeof file !== 'string')
  )
    throw new Error(
      'ctx.apple.resign entitlements maps bundle IDs to plist paths',
    )
}

/**
 * Puts the input's app at `<root>/Payload/<App>.app`, with an `.ipa`'s or
 * archive's `SwiftSupport` beside `Payload`, and resolves with the app.
 */
async function unpack(
  context: ResignContext,
  input: string,
  root: string,
  work: string,
): Promise<string> {
  const payload = path.join(root, 'Payload')
  mkdirSync(payload, { recursive: true })
  const apps = (dir: string): string[] =>
    sorted(dir).filter(
      (name) =>
        name.endsWith('.app') && lstatSync(path.join(dir, name)).isDirectory(),
    )
  const one = (dir: string, found: string[]): string => {
    if (found.length !== 1)
      throw new Error(
        `${path.basename(input)} must hold exactly one app; found ${found.length === 0 ? 'none' : found.join(', ')}`,
      )
    return path.join(dir, found[0]!)
  }
  const copy = (from: string, to: string): void =>
    cpSync(from, to, { recursive: true, verbatimSymlinks: true })
  const swiftSupport = (dir: string): void => {
    const from = path.join(dir, 'SwiftSupport')
    if (existsSync(from)) copy(from, path.join(root, 'SwiftSupport'))
  }
  const info = statSync(input, { throwIfNoEntry: false })
  if (info == null) throw new Error(`${path.basename(input)} does not exist`)
  if (input.endsWith('.ipa') && info.isFile()) {
    const unzipped = path.join(work, 'unzipped')
    await tool(context, DITTO, ['-x', '-k', input, unzipped])
    const from = path.join(unzipped, 'Payload')
    const app = one(from, apps(from))
    copy(app, path.join(payload, path.basename(app)))
    swiftSupport(unzipped)
  } else if (input.endsWith('.xcarchive') && info.isDirectory()) {
    const from = path.join(input, 'Products', 'Applications')
    const app = one(from, apps(from))
    copy(app, path.join(payload, path.basename(app)))
    swiftSupport(input)
  } else if (input.endsWith('.app') && info.isDirectory())
    copy(input, path.join(payload, path.basename(input)))
  else
    throw new Error(
      `ctx.apple.resign takes an .ipa, .xcarchive or .app, not ${path.basename(input)}`,
    )
  const app = path.join(payload, apps(payload)[0]!)
  // Finder information and other extended attributes fail codesign.
  await tool(context, XATTR, ['-cr', root])
  return app
}

/**
 * `ctx.apple.resign` (Fastlane `resign`): signs an iOS build an earlier
 * stage produced — an `.ipa`, `.xcarchive` or `.app`, unsigned or signed
 * for anything — with this stage's identity and profiles, deepest bundle
 * first, verifies it, and packages an `.ipa` for the stage's distribution.
 * Entitlements come from the call's plist, the input's signature, or the
 * profile, rewritten for the profile; a key the profile lacks goes to the
 * master, which adds the capability and makes new profiles, once.
 */
export async function resign(
  context: ResignContext,
  options: ResignOptions,
): Promise<ResignResult> {
  if ((context.platform ?? process.platform) !== 'darwin')
    throw new Error(
      'ctx.apple.resign runs only on macOS: it signs with Apple’s codesign',
    )
  if (context.signing.platform !== 'ios')
    throw new Error(
      'ctx.apple.resign signs iOS builds; this stage signs for macOS',
    )
  checkOptions(options)
  const input = inside(context.dir, options.path, 'input')
  const distribution = context.signing.distribution
  const output = inside(
    context.dir,
    options.output ??
      path.join(
        path.dirname(options.path),
        `${path.basename(options.path).replace(/\.(ipa|xcarchive|app)$/, '')}-${distribution}.ipa`,
      ),
    'output',
  )
  const entitlementFiles = Object.fromEntries(
    Object.entries(options.entitlements ?? {}).map(([bundleId, file]) => [
      bundleId,
      inside(context.dir, file, 'entitlements'),
    ]),
  )
  mkdirSync(context.scratch, { recursive: true })
  const work = mkdtempSync(path.join(context.scratch, 'resign-'))
  try {
    const root = path.join(work, 'package')
    const app = await unpack(context, input, root, work)
    const bundles = signables(app)
    for (const bundle of bundles)
      bundle.bundleId = await plistString(
        context,
        path.join(bundle.path, 'Info.plist'),
        'CFBundleIdentifier',
      )
    const signed = bundles.filter(takesProfile)
    for (const bundle of signed)
      if (bundle.bundleId == null)
        throw new Error(
          `${path.relative(root, bundle.path)} has no CFBundleIdentifier`,
        )
    const needed = [...new Set(signed.map((bundle) => bundle.bundleId!))]
    const missing = needed.filter(
      (id) =>
        !context.signing.profiles.some((profile) => profile.bundleId === id),
    )
    if (missing.length > 0)
      throw new Error(
        `This build signs ${needed.join(', ')}; the stage has no profile for ${missing.join(', ')}. List every one in the app ID's bundle IDs and the stage's apple.bundleIds`,
      )
    for (const bundle of signed)
      for (const [key, value] of [
        ['CFBundleShortVersionString', options.version],
        ['CFBundleVersion', options.buildNumber],
      ] as const)
        if (value != null)
          await tool(context, PLUTIL, [
            '-replace',
            key,
            '-string',
            value,
            path.join(bundle.path, 'Info.plist'),
          ])
    // What each bundle asks for, before the profile has its say.
    const wanted = new Map<Bundle, Plist | undefined>()
    for (const [index, bundle] of signed.entries()) {
      const file = entitlementFiles[bundle.bundleId!]
      wanted.set(
        bundle,
        file != null
          ? await readPlist(context, file)
          : await signedEntitlements(context, work, bundle, index),
      )
    }
    // One at a time, so the log reads in order.
    const read = async (list: StageSigning['profiles']): Promise<Profile[]> => {
      const out: Profile[] = []
      for (const profile of list)
        if (needed.includes(profile.bundleId))
          out.push(await readProfile(context, work, profile))
      return out
    }
    let profiles = await read(context.signing.profiles)
    const plan = (): Map<Bundle, { entitlements: Plist; dropped: string[] }> =>
      new Map(
        signed.map((bundle) => {
          const profile = profiles.find(
            (entry) => entry.bundleId === bundle.bundleId,
          )!
          return [
            bundle,
            rewriteEntitlements(
              wanted.get(bundle) ?? profileEntitlements(profile.entitlements),
              profile,
            ),
          ]
        }),
      )
    let planned = plan()
    const lacking = signed.filter(
      (bundle) => planned.get(bundle)!.dropped.length > 0,
    )
    if (lacking.length > 0) {
      const answer = await context.entitlements(
        Object.fromEntries(
          lacking.map((bundle) => [bundle.bundleId!, wanted.get(bundle)!]),
        ),
      )
      if (answer.changed && answer.profiles != null) {
        context.log(
          'The master added the capabilities these entitlements need and made new profiles\n',
        )
        context.reinstall(answer.profiles)
        profiles = await read(answer.profiles)
        planned = plan()
      }
      for (const bundle of signed) {
        const { dropped } = planned.get(bundle)!
        if (dropped.length > 0)
          context.log(
            `${bundle.bundleId}: its profile does not grant ${dropped.join(', ')}; signed without them\n`,
          )
      }
    }
    const result: ResignResult['bundles'] = []
    for (const [index, bundle] of bundles.entries()) {
      const relative = path.relative(root, bundle.path)
      const profile = takesProfile(bundle)
        ? profiles.find((entry) => entry.bundleId === bundle.bundleId)!
        : undefined
      const args = [
        '--force',
        '--sign',
        context.signing.identity.sha1,
        '--keychain',
        context.keychain,
        '--timestamp=none',
        '--generate-entitlement-der',
      ]
      if (profile != null) {
        writeFileSync(
          path.join(bundle.path, 'embedded.mobileprovision'),
          profile.content,
        )
        const file = path.join(work, `entitlements-${index}.plist`)
        writeFileSync(
          file,
          entitlementsPlist(planned.get(bundle)!.entitlements),
        )
        args.push('--entitlements', file)
      }
      if (bundle.kind !== 'library') {
        rmSync(path.join(bundle.path, '_CodeSignature'), {
          recursive: true,
          force: true,
        })
        rmSync(path.join(bundle.path, 'CodeResources'), { force: true })
      }
      await tool(context, CODESIGN, [...args, bundle.path])
      context.log(
        `Signed ${relative}${bundle.bundleId == null ? '' : ` (${bundle.bundleId})`}${profile == null ? '' : ` with ${profile.name}`}\n`,
      )
      result.push({
        path: relative,
        ...(bundle.bundleId == null ? {} : { bundleId: bundle.bundleId }),
        ...(profile == null ? {} : { profile: profile.name }),
      })
    }
    await verify(context, app, bundles, profiles)
    rmSync(output, { force: true })
    mkdirSync(path.dirname(output), { recursive: true })
    // Payload (and SwiftSupport) at the top, symlinks kept, no __MACOSX.
    await tool(context, DITTO, [
      '-c',
      '-k',
      '--norsrc',
      '--noextattr',
      '--noqtn',
      '--noacl',
      root,
      output,
    ])
    context.log(
      `Wrote ${path.relative(context.dir, output)} for ${distribution}\n`,
    )
    return { ipa: output, bundles: result }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * `codesign --verify --deep --strict` on the app, then each bundle signed
 * by the stage's team, and each profile in place as it was installed.
 */
async function verify(
  context: ResignContext,
  app: string,
  bundles: Bundle[],
  profiles: Profile[],
): Promise<void> {
  const checked = await context.exec(
    CODESIGN,
    ['--verify', '--deep', '--strict', '--verbose=2', app],
    { cwd: context.dir },
  )
  if (checked.code !== 0)
    throw new Error(
      `The re-signed app does not verify: ${checked.output.trim().slice(-4000)}`,
    )
  for (const bundle of bundles) {
    const shown = await tool(context, CODESIGN, [
      '-d',
      '--verbose=2',
      bundle.path,
    ])
    const team = /^TeamIdentifier=(.*)$/m.exec(shown)?.[1]?.trim()
    if (team !== context.signing.team)
      throw new Error(
        `${path.basename(bundle.path)} is signed for team ${team ?? 'none'}, not ${context.signing.team}`,
      )
    const profile = profiles.find(
      (entry) => takesProfile(bundle) && entry.bundleId === bundle.bundleId,
    )
    if (
      profile != null &&
      !readFileSync(path.join(bundle.path, 'embedded.mobileprovision')).equals(
        profile.content,
      )
    )
      throw new Error(
        `${path.basename(bundle.path)} does not hold profile ${profile.uuid}`,
      )
  }
}
