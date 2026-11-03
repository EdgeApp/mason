import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { StageSigning } from '../../pipeline/assignment.js'

export interface ArchiveOptions {
  project?: string
  workspace?: string
  scheme: string
  configuration?: string
  destination?: string
  version?: string
  buildNumber?: string
  sdk?: string
  xcargs?: string[]
  output?: string
  /** Added to xcodebuild's environment, which the project's build scripts see. */
  env?: Record<string, string>
}
export interface ArchiveResult {
  archive: string
  ipa?: string
  app?: string
  pkg?: string
  dsyms: string
}

/** A process run for the archive: arguments, environment, and each output line. */
export type Exec = (
  file: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    onLine?: (line: string) => void
  },
) => Promise<{ code: number; output: string }>

/** What `ctx.apple.archive` needs from the worker. */
export interface ArchiveContext {
  /** The stage's workspace. */
  dir: string
  /** A private scratch directory for DerivedData. */
  scratch: string
  signing: StageSigning
  keychain: string
  exportOptions: string
  exec: Exec
  log: (text: string) => void
  /**
   * Reports entitlements per bundle ID; the master answers with new
   * profiles when it added capabilities. `failed`: signing failed for a
   * missing capability, so a key Mason does not know fails the stage.
   */
  entitlements: (
    values: Record<string, Record<string, unknown>>,
    options?: { failed?: boolean },
  ) => Promise<{ changed: boolean; profiles?: StageSigning['profiles'] }>
  /** Installs replacement profiles after the master made them again. */
  reinstall: (profiles: StageSigning['profiles']) => void
  /** Keeps a full log as a run artifact, when the stage can save artifacts. */
  keep?: (name: string, file: string) => Promise<void>
}

/**
 * Workspace, scheme, configuration, destination and SDK. The archive and
 * the settings read share these, so both resolve the same target.
 */
export function targetArgs(
  options: ArchiveOptions,
  signing: StageSigning,
): string[] {
  if ((options.project == null) === (options.workspace == null))
    throw new Error(
      'ctx.apple.archive needs a project or a workspace, not both',
    )
  return [
    ...(options.workspace != null
      ? ['-workspace', options.workspace]
      : ['-project', options.project!]),
    '-scheme',
    options.scheme,
    '-configuration',
    options.configuration ?? 'Release',
    '-destination',
    options.destination ??
      (signing.platform === 'macos'
        ? 'generic/platform=macOS'
        : signing.platform === 'tvos'
          ? 'generic/platform=tvOS'
          : 'generic/platform=iOS'),
    // The tvOS SDK goes with the default destination only; a stage that
    // names its own destination names its SDK too, if it needs one.
    ...(options.sdk != null
      ? ['-sdk', options.sdk]
      : signing.platform === 'tvos' && options.destination == null
        ? ['-sdk', 'appletvos']
        : []),
  ]
}

/** The `xcodebuild archive` arguments: the stage's signing, version and build number, nothing edited in the project. */
export function archiveArgs(
  options: ArchiveOptions,
  signing: StageSigning,
  keychain: string,
  archivePath: string,
  derivedData: string,
): string[] {
  return [
    'archive',
    ...targetArgs(options, signing),
    '-archivePath',
    archivePath,
    '-derivedDataPath',
    derivedData,
    'CODE_SIGN_STYLE=Manual',
    `DEVELOPMENT_TEAM=${signing.team}`,
    `CODE_SIGN_IDENTITY=${signing.identity.name}`,
    `OTHER_CODE_SIGN_FLAGS=--keychain ${keychain}`,
    'PROVISIONING_PROFILE_SPECIFIER=$(MASON_PROFILE_$(PRODUCT_BUNDLE_IDENTIFIER:c99extidentifier))',
    ...signing.profiles.map(
      (profile) =>
        `MASON_PROFILE_${profile.bundleId.replace(/[^A-Za-z0-9_]/g, '_')}=${profile.name}`,
    ),
    ...(options.version == null
      ? []
      : [`MARKETING_VERSION=${options.version}`]),
    ...(options.buildNumber == null
      ? []
      : [`CURRENT_PROJECT_VERSION=${options.buildNumber}`]),
    ...(options.xcargs ?? []),
  ]
}

/** The lines of Xcode's output a person needs: errors, warnings, signing and the result. */
export function keepLine(line: string): boolean {
  return /(error|warning):|\*\* (ARCHIVE|EXPORT|BUILD) (SUCCEEDED|FAILED) \*\*|^(Signing Identity|Provisioning Profile):|^CodeSign |^Exported |^The following build commands failed/.test(
    line.trim(),
  )
}

/** A failure caused by a profile without a capability the target's entitlements need. */
export function capabilityFailure(output: string): boolean {
  return /doesn['’]t (include|support) the .*(entitlement|capability)|Provisioning profile .* doesn['’]t (include|match)/i.test(
    output,
  )
}

/** One target's resolved settings that name its entitlements file. */
export interface EntitlementTarget {
  bundleId: string
  entitlements: string
  srcroot: string
}

/**
 * Targets in `xcodebuild -showBuildSettings` output. A block that starts
 * `Build settings for action` is one target; settings from the command
 * line are not. A target with no bundle identifier is left out.
 */
export function entitlementTargets(output: string): EntitlementTarget[] {
  const targets: EntitlementTarget[] = []
  let settings: Record<string, string> | undefined
  const finish = (): void => {
    if (settings == null) return
    const bundleId = (settings.PRODUCT_BUNDLE_IDENTIFIER ?? '').trim()
    if (bundleId !== '')
      targets.push({
        bundleId,
        entitlements: settings.CODE_SIGN_ENTITLEMENTS ?? '',
        srcroot: settings.SRCROOT ?? '',
      })
    settings = undefined
  }
  for (const line of output.replaceAll('\r\n', '\n').split('\n')) {
    if (line.startsWith('Build settings for action ')) {
      finish()
      settings = {}
      continue
    }
    // Command-line settings are not a target, and they follow the last one.
    if (line.startsWith('Build settings ')) {
      finish()
      continue
    }
    if (settings == null) continue
    const match = /^ {4}([A-Za-z0-9_]+) = (.*)$/.exec(line)
    if (match != null) settings[match[1]!] = match[2] ?? ''
  }
  finish()
  return targets
}

/**
 * The entitlements file a target names, inside the workspace. `$(SRCROOT)`
 * and `${SRCROOT}` expand to that target's `SRCROOT`. An empty name, or a
 * path that leaves the workspace, is left out.
 */
export function entitlementFile(
  entitlements: string,
  srcroot: string,
  workspace: string,
): string | undefined {
  const named = entitlements.trim()
  if (named === '') return undefined
  const root = srcroot.trim()
  const expanded = named
    .replaceAll('$(SRCROOT)', root)
    .replaceAll('${SRCROOT}', root)
  const file = path.resolve(path.resolve(workspace, root), expanded)
  const dir = path.resolve(workspace)
  if (file !== dir && !file.startsWith(dir + path.sep)) return undefined
  return file
}

/** Files below a directory, by extension, skipping what cannot be read. */
function find(
  dir: string,
  test: (name: string) => boolean,
  depth = 8,
): string[] {
  if (depth < 0 || !existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    if (test(name)) out.push(file)
    // An app's own extensions are inside it, so matches are searched too.
    if (statSync(file, { throwIfNoEntry: false })?.isDirectory() === true)
      out.push(...find(file, test, depth - 1))
  }
  return out
}

/** A plist as JSON, through `plutil`. */
async function plist(
  context: ArchiveContext,
  file: string,
): Promise<Record<string, unknown> | undefined> {
  const out = await context.exec(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', file],
    {
      cwd: context.dir,
    },
  )
  if (out.code !== 0) return undefined
  try {
    return JSON.parse(out.output) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Entitlements Xcode generated for each target, by bundle ID, from a failed build's `.xcent` files. */
async function buildEntitlements(
  context: ArchiveContext,
  derivedData: string,
): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const file of find(derivedData, (name) => name.endsWith('.xcent'))) {
    const values = await plist(context, file)
    const identifier = values?.['application-identifier']
    if (values == null || typeof identifier !== 'string') continue
    out[identifier.replace(/^[A-Z0-9]{10}\./, '')] = values
  }
  return out
}

/** Entitlements of each signed app and extension in an archive, by bundle ID. */
async function archiveEntitlements(
  context: ArchiveContext,
  archive: string,
): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {}
  const bundles = find(path.join(archive, 'Products'), (name) =>
    /\.(app|appex)$/.test(name),
  )
  for (const bundle of bundles) {
    const info = await plist(
      context,
      existsSync(path.join(bundle, 'Contents', 'Info.plist'))
        ? path.join(bundle, 'Contents', 'Info.plist')
        : path.join(bundle, 'Info.plist'),
    )
    const identifier = info?.CFBundleIdentifier
    if (typeof identifier !== 'string') continue
    const signed = await context.exec(
      '/usr/bin/codesign',
      ['-d', '--entitlements', '-', '--xml', bundle],
      { cwd: context.dir },
    )
    if (signed.code !== 0 || !signed.output.includes('<plist')) continue
    const start = signed.output.indexOf('<?xml')
    const xml = signed.output.slice(
      start >= 0 ? start : signed.output.indexOf('<plist'),
    )
    const file = path.join(
      context.scratch,
      `entitlements-${Object.keys(out).length}.plist`,
    )
    writeFileSync(file, xml)
    const values = await plist(context, file)
    if (values != null) out[identifier] = values
  }
  return out
}

/** The entitlements a profile grants, from the CMS envelope Apple signs it in. */
async function profileGrants(
  context: ArchiveContext,
  profile: StageSigning['profiles'][number],
): Promise<Record<string, unknown> | undefined> {
  const file = path.join(context.scratch, `${profile.uuid}.mobileprovision`)
  writeFileSync(file, Buffer.from(profile.content, 'base64'))
  const decoded = await context.exec(
    '/usr/bin/security',
    ['cms', '-D', '-i', file, '-o', `${file}.plist`],
    { cwd: context.dir },
  )
  if (decoded.code !== 0) return undefined
  const extracted = await context.exec(
    '/usr/bin/plutil',
    ['-extract', 'Entitlements', 'json', '-o', '-', `${file}.plist`],
    { cwd: context.dir },
  )
  if (extracted.code !== 0) return undefined
  try {
    return JSON.parse(extracted.output) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Of each bundle's entitlements, the keys its profile does not grant; a
 * bundle whose profile grants them all, or that has none of its own, is
 * left out. A profile that cannot be read grants nothing.
 */
async function ungranted(
  context: ArchiveContext,
  values: Record<string, Record<string, unknown>>,
  profiles: StageSigning['profiles'],
): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [bundleId, entitlements] of Object.entries(values)) {
    const profile = profiles.find((entry) => entry.bundleId === bundleId)
    const granted =
      profile == null ? undefined : await profileGrants(context, profile)
    const left = Object.fromEntries(
      Object.entries(entitlements).filter(([key]) => !(key in (granted ?? {}))),
    )
    if (Object.keys(left).length > 0) out[bundleId] = left
  }
  return out
}

/** The environment a stage adds for xcodebuild: names a shell accepts, string values. */
export function archiveEnvironment(value: unknown): Record<string, string> {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('ctx.apple.archive env maps names to strings')
  for (const [name, entry] of Object.entries(value))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== 'string')
      throw new Error(
        `ctx.apple.archive env: ${name} is not a name with a string value`,
      )
  return value as Record<string, string>
}

/** Runs `xcodebuild`, keeping its full output in a file and its useful lines in the stage log. */
async function xcodebuild(
  context: ArchiveContext,
  args: string[],
  logFile: string,
  env: Record<string, string>,
): Promise<{ code: number; output: string }> {
  const full = createWriteStream(logFile)
  try {
    return await context.exec('/usr/bin/xcrun', ['xcodebuild', ...args], {
      cwd: context.dir,
      env,
      onLine: (line) => {
        full.write(line + '\n')
        if (keepLine(line)) context.log(line + '\n')
      },
    })
  } finally {
    await new Promise((resolve) => full.end(resolve))
  }
}

/**
 * Entitlements each target's project file names, from
 * `xcodebuild -showBuildSettings`. The archive's signing check can fail
 * before Xcode writes a `.xcent`, so the file has to be read first. Signing
 * settings are left off this invocation: they name the profile the archive
 * is about to test. A failure here does not stop the archive.
 */
async function projectEntitlements(
  context: ArchiveContext,
  options: ArchiveOptions,
  out: string,
  env: Record<string, string>,
): Promise<Record<string, Record<string, unknown>>> {
  const settingsArgs = [
    '-showBuildSettings',
    ...targetArgs(options, context.signing),
  ]
  let result: { code: number; output: string }
  try {
    result = await xcodebuild(
      context,
      settingsArgs,
      path.join(out, 'xcodebuild-settings.log'),
      env,
    )
  } catch (error) {
    context.log(
      `xcodebuild -showBuildSettings could not be read (${error instanceof Error ? error.message : 'failed'}); archiving with the profiles already installed\n`,
    )
    return {}
  }
  if (result.code !== 0) {
    context.log(
      'xcodebuild -showBuildSettings failed; archiving with the profiles already installed\n',
    )
    return {}
  }
  const values: Record<string, Record<string, unknown>> = {}
  for (const target of entitlementTargets(result.output)) {
    if (values[target.bundleId] != null) continue
    const file = entitlementFile(
      target.entitlements,
      target.srcroot,
      context.dir,
    )
    if (file == null) continue
    const read = await plist(context, file)
    if (read == null) continue
    values[target.bundleId] = read
  }
  return values
}

/**
 * `ctx.apple.archive`: `xcodebuild archive` and `-exportArchive` with the
 * stage's signing. Each target's entitlements are read before the archive
 * and sent to the master, which keeps the bundle IDs' capabilities in step.
 * When a build still fails because a profile lacked a capability, the
 * generated `.xcent` files are sent the same way, the master makes the
 * profiles again, and the archive is tried once more.
 */
export async function archive(
  context: ArchiveContext,
  options: ArchiveOptions,
): Promise<ArchiveResult> {
  if (typeof options.scheme !== 'string' || options.scheme === '')
    throw new Error('ctx.apple.archive needs a scheme')
  const env = archiveEnvironment(options.env)
  const out = path.resolve(context.dir, options.output ?? 'build/mason-archive')
  if (!out.startsWith(context.dir + path.sep) && out !== context.dir)
    throw new Error('The archive output must stay in the workspace')
  mkdirSync(out, { recursive: true })
  const derivedData = path.join(context.scratch, 'DerivedData')
  const archivePath = path.join(out, `${options.scheme}.xcarchive`)
  const archiveLog = path.join(out, 'xcodebuild-archive.log')
  let profiles = context.signing.profiles
  const preset = await projectEntitlements(context, options, out, env)
  if (Object.keys(preset).length > 0) {
    const answer = await context.entitlements(preset, { failed: true })
    if (answer.changed && answer.profiles != null) {
      context.log(
        'The master added the capabilities these entitlements need and made new profiles\n',
      )
      profiles = answer.profiles
      context.reinstall(profiles)
    }
  }
  for (let attempt = 1; ; attempt++) {
    const args = archiveArgs(
      options,
      { ...context.signing, profiles },
      context.keychain,
      archivePath,
      derivedData,
    )
    context.log(
      `xcodebuild archive -scheme ${options.scheme} (full output in ${path.relative(context.dir, archiveLog)})\n`,
    )
    const result = await xcodebuild(context, args, archiveLog, env)
    if (result.code === 0) break
    if (attempt === 1 && capabilityFailure(result.output)) {
      const values = await buildEntitlements(context, derivedData)
      const answer = await context.entitlements(values, { failed: true })
      if (answer.changed && answer.profiles != null) {
        context.log(
          'The master added the capabilities these entitlements need and made new profiles; archiving again\n',
        )
        profiles = answer.profiles
        context.reinstall(profiles)
        continue
      }
    }
    await context
      .keep?.('xcodebuild-archive', archiveLog)
      .catch(() => undefined)
    throw new Error(`xcodebuild archive failed (exit ${result.code})`)
  }
  // Capabilities follow the archive's entitlements, ready for the next
  // build: only the keys the bundle's own profile does not grant already.
  const values = await ungranted(
    context,
    await archiveEntitlements(context, archivePath),
    profiles,
  )
  if (Object.keys(values).length > 0) {
    const synced = await context.entitlements(values)
    if (synced.changed && synced.profiles != null) {
      profiles = synced.profiles
      context.reinstall(profiles)
    }
  }
  const exportLog = path.join(out, 'xcodebuild-export.log')
  const exported = await xcodebuild(
    context,
    [
      '-exportArchive',
      '-archivePath',
      archivePath,
      '-exportPath',
      out,
      '-exportOptionsPlist',
      context.exportOptions,
    ],
    exportLog,
    env,
  )
  if (exported.code !== 0) {
    await context.keep?.('xcodebuild-export', exportLog).catch(() => undefined)
    throw new Error(`xcodebuild -exportArchive failed (exit ${exported.code})`)
  }
  const dsyms = path.join(out, `${options.scheme}.dSYMs.zip`)
  const dsymDir = path.join(archivePath, 'dSYMs')
  if (existsSync(dsymDir))
    await context.exec(
      '/usr/bin/ditto',
      ['-c', '-k', '--keepParent', dsymDir, dsyms],
      {
        cwd: context.dir,
      },
    )
  const first = (extension: string): string | undefined =>
    readdirSync(out)
      .filter((name) => name.endsWith(extension))
      .map((name) => path.join(out, name))[0]
  const ipa = first('.ipa')
  const app = first('.app')
  const pkg = first('.pkg')
  return {
    archive: archivePath,
    ...(ipa == null ? {} : { ipa }),
    ...(app == null ? {} : { app }),
    ...(pkg == null ? {} : { pkg }),
    dsyms,
  }
}
