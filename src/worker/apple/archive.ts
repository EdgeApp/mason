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
  /** Reports entitlements per bundle ID; the master answers with new profiles when it added capabilities. */
  entitlements: (
    values: Record<string, Record<string, unknown>>,
  ) => Promise<{ changed: boolean; profiles?: StageSigning['profiles'] }>
  /** Installs replacement profiles after the master made them again. */
  reinstall: (profiles: StageSigning['profiles']) => void
  /** Keeps a full log as a run artifact, when the stage can save artifacts. */
  keep?: (name: string, file: string) => Promise<void>
}

/** The `xcodebuild archive` arguments: the stage's signing, version and build number, nothing edited in the project. */
export function archiveArgs(
  options: ArchiveOptions,
  signing: StageSigning,
  keychain: string,
  archivePath: string,
  derivedData: string,
): string[] {
  if ((options.project == null) === (options.workspace == null))
    throw new Error(
      'ctx.apple.archive needs a project or a workspace, not both',
    )
  return [
    'archive',
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
        : 'generic/platform=iOS'),
    ...(options.sdk == null ? [] : ['-sdk', options.sdk]),
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
 * `ctx.apple.archive`: `xcodebuild archive` and `-exportArchive` with the
 * stage's signing. The archive's entitlements go to the master, which keeps
 * the bundle IDs' capabilities in step; when a build fails because a profile
 * lacked a capability, the master adds it, makes the profiles again, and the
 * archive is tried once more.
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
      const answer = await context.entitlements(values)
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
  // Capabilities follow the archive's entitlements, ready for the next build.
  const values = await archiveEntitlements(context, archivePath)
  const synced = await context.entitlements(values)
  if (synced.changed && synced.profiles != null) {
    profiles = synced.profiles
    context.reinstall(profiles)
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
