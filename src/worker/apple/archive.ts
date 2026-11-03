import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
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
   * `before`: the archive has not signed yet, so what the master cannot
   * enable only warns.
   */
  entitlements: (
    values: Record<string, Record<string, unknown>>,
    options?: { failed?: boolean; before?: boolean },
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

/**
 * Each target's build settings in `xcodebuild -showBuildSettings` output,
 * as xcodebuild evaluated them. A block that starts `Build settings for
 * action` is one target and ends at the next line that is not a setting.
 * The settings from the command line, which xcodebuild prints before the
 * targets, and its other unindented lines are not a target.
 */
export function targetSettings(output: string): Array<Record<string, string>> {
  const targets: Array<Record<string, string>> = []
  let settings: Record<string, string> | undefined
  for (const line of output.replaceAll('\r\n', '\n').split('\n')) {
    if (line.startsWith('Build settings for action ')) {
      settings = {}
      targets.push(settings)
      continue
    }
    const match = /^ {4}([A-Za-z0-9_]+) = (.*)$/.exec(line)
    if (match != null) {
      if (settings != null) settings[match[1]!] = match[2]!
    } else if (line.trim() !== '' && !/^\s/.test(line)) settings = undefined
  }
  return targets
}

/** A path with its symbolic links resolved, or as it is when it does not exist. */
function real(file: string): string {
  try {
    return realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}

/**
 * The entitlements file a target names, inside the workspace.
 * `CODE_SIGN_ENTITLEMENTS` is evaluated already; a relative path is from
 * the target's `SRCROOT`. An empty name, or a file that leaves the
 * workspace, is left out.
 */
export function entitlementFile(
  entitlements: string,
  srcroot: string,
  workspace: string,
): string | undefined {
  const named = entitlements.trim()
  if (named === '') return undefined
  const file = real(path.resolve(workspace, srcroot.trim(), named))
  const dir = real(workspace)
  if (!file.startsWith(dir + path.sep)) return undefined
  return file
}

/**
 * Entitlements with the build settings they name, `$(NAME)` or `${NAME}`,
 * replaced by the target's values, as Xcode does when it signs. A key
 * whose value still names a setting (one the read did not print, such as
 * `$(TeamIdentifierPrefix)`, or one with an operator) is left out and
 * listed apart: its value is not known until the build.
 */
export function expandEntitlements(
  values: Record<string, unknown>,
  settings: Record<string, string>,
): { values: Record<string, unknown>; unresolved: string[] } {
  const reference = /\$(?:\(([A-Za-z0-9_]+)\)|\{([A-Za-z0-9_]+)\})/g
  let resolved = true
  const expand = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const text = value.replace(
        reference,
        (whole, round?: string, curly?: string) =>
          settings[(round ?? curly)!] ?? whole,
      )
      if (/\$[({]/.test(text)) resolved = false
      return text
    }
    if (Array.isArray(value)) return value.map(expand)
    if (value != null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, expand(item)]),
      )
    return value
  }
  const out: Record<string, unknown> = {}
  const unresolved: string[] = []
  for (const [key, value] of Object.entries(values)) {
    resolved = true
    const expanded = expand(value)
    if (resolved) out[key] = expanded
    else unresolved.push(key)
  }
  return { values: out, unresolved }
}

/** The SDK a platform's device builds use. */
const platformSdk = {
  ios: 'iphoneos',
  macos: 'macosx',
  tvos: 'appletvos',
} as const

/**
 * The scheme's settings read: the archive's workspace, scheme,
 * configuration, destination and SDK, its DerivedData (where packages
 * resolve) and the stage's own `xcargs`, without the signing settings.
 */
export function schemeSettingsArgs(
  options: ArchiveOptions,
  signing: StageSigning,
  derivedData: string,
): string[] {
  return [
    '-showBuildSettings',
    ...targetArgs(options, signing),
    '-derivedDataPath',
    derivedData,
    ...(options.xcargs ?? []),
  ]
}

/**
 * Every target of one project, for the targets a scheme builds only as
 * dependencies (extensions, watch apps): the archive's configuration and
 * SDK, and the stage's `xcargs`. xcodebuild takes `-derivedDataPath` only
 * with a scheme, so the same DerivedData is named as a user default.
 */
export function projectSettingsArgs(
  project: string,
  options: ArchiveOptions,
  signing: StageSigning,
  derivedData: string,
): string[] {
  return [
    '-showBuildSettings',
    '-project',
    project,
    '-alltargets',
    '-configuration',
    options.configuration ?? 'Release',
    ...(options.sdk != null
      ? ['-sdk', options.sdk]
      : options.destination != null
        ? ['-destination', options.destination]
        : ['-sdk', platformSdk[signing.platform]]),
    `-IDECustomDerivedDataLocation=${derivedData}`,
    ...(options.xcargs ?? []),
  ]
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
 * Entitlements of each target the stage signs, from the file its build
 * settings name, with those settings expanded. The archive's signing check
 * can fail before Xcode writes a `.xcent`, so the files are read first.
 * The scheme's targets come from one settings read; when they leave out a
 * bundle ID the stage signs, every target of their projects is read too.
 * Signing settings are left off: they name the profiles the archive is
 * about to test.
 */
async function projectEntitlements(
  context: ArchiveContext,
  options: ArchiveOptions,
  out: string,
  env: Record<string, string>,
  derivedData: string,
): Promise<Record<string, Record<string, unknown>>> {
  const signed = new Set(context.signing.bundleIds)
  const read = async (
    args: string[],
    log: string,
  ): Promise<Array<Record<string, string>>> => {
    const result = await xcodebuild(context, args, path.join(out, log), env)
    if (result.code !== 0)
      throw new Error(
        `xcodebuild -showBuildSettings failed (exit ${result.code})`,
      )
    return targetSettings(result.output)
  }
  const targets = await read(
    schemeSettingsArgs(options, context.signing, derivedData),
    'xcodebuild-settings.log',
  )
  const named = new Set(targets.map((entry) => entry.PRODUCT_BUNDLE_IDENTIFIER))
  if ([...signed].some((bundleId) => !named.has(bundleId))) {
    const projects = new Set(
      targets
        .map((entry) => entry.PROJECT_FILE_PATH ?? '')
        .filter((project) => project !== ''),
    )
    for (const [index, project] of [...projects].entries()) {
      try {
        targets.push(
          ...(await read(
            projectSettingsArgs(project, options, context.signing, derivedData),
            `xcodebuild-settings-${index + 1}.log`,
          )),
        )
      } catch (error) {
        context.log(
          `${path.basename(project)}: ${(error as Error).message}; reading the scheme’s own targets only\n`,
        )
      }
    }
  }
  const values: Record<string, Record<string, unknown>> = {}
  for (const settings of targets) {
    const bundleId = (settings.PRODUCT_BUNDLE_IDENTIFIER ?? '').trim()
    if (!signed.has(bundleId) || values[bundleId] != null) continue
    const file = entitlementFile(
      settings.CODE_SIGN_ENTITLEMENTS ?? '',
      settings.SRCROOT ?? '',
      context.dir,
    )
    if (file == null) continue
    const entitlements = await plist(context, file)
    if (entitlements == null) continue
    const expanded = expandEntitlements(entitlements, settings)
    if (expanded.unresolved.length > 0)
      context.log(
        `${bundleId}: ${expanded.unresolved.join(', ')} ${expanded.unresolved.length === 1 ? 'names a build setting' : 'name build settings'} known only to the build, checked after it signs\n`,
      )
    values[bundleId] = expanded.values
  }
  return values
}

/**
 * `ctx.apple.archive`: `xcodebuild archive` and `-exportArchive` with the
 * stage's signing. Before the archive, the entitlements of each signed
 * target that its installed profile does not grant go to the master, which
 * keeps the bundle IDs' capabilities in step; a failure there only warns.
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
  // Only what the installed profiles do not grant goes to the master, and
  // what it cannot enable only warns: the profiles may sign it already. A
  // failure here leaves the archive, and its retry, to those profiles.
  let early: Awaited<ReturnType<ArchiveContext['entitlements']>> | undefined
  try {
    const needed = await ungranted(
      context,
      await projectEntitlements(context, options, out, env, derivedData),
      profiles,
    )
    if (Object.keys(needed).length > 0)
      early = await context.entitlements(needed, { before: true })
  } catch (error) {
    context.log(
      `The project’s entitlements were not checked before the archive (${(error as Error).message}); archiving with the profiles already installed\n`,
    )
  }
  if (early?.changed === true && early.profiles != null) {
    context.log(
      'The master added the capabilities these entitlements need and made new profiles\n',
    )
    profiles = early.profiles
    context.reinstall(profiles)
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
