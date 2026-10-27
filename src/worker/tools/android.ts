import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { baseEnvironment } from '../../builder/config.js'
import {
  download,
  extract,
  fetchText,
  step,
  writeMarker,
  type InstallContext,
} from './common.js'

/** Thrown when a node type has no administrator's acceptance of the SDK licences. */
export class LicencesNotAccepted extends Error {}

const asList = <T>(value: T | T[] | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value]

/** `<data>/tools/android/sdk`: one SDK root for every package. */
export const sdkRoot = (toolsDir: string): string =>
  path.join(toolsDir, 'android', 'sdk')

/** Packages present in an SDK root, named as sdkmanager names them. */
export function installedPackages(root: string): string[] {
  const out: string[] = []
  const list = (dir: string): string[] => {
    try {
      return readdirSync(path.join(root, dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }
  for (const group of [
    'platforms',
    'build-tools',
    'ndk',
    'cmake',
    'cmdline-tools',
  ])
    for (const name of list(group)) out.push(`${group};${name}`)
  if (existsSync(path.join(root, 'platform-tools'))) out.push('platform-tools')
  return out.sort()
}

/** The command-line tools archive for this OS, and its published SHA-1, from Google's repository manifest. */
async function commandLineTools(
  context: InstallContext,
): Promise<{ url: string; sha1: string }> {
  const xml = await fetchText(
    `${context.sources.android}/repository2-3.xml`,
    context.signal,
  )
  const parsed = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  }).parse(xml) as Record<string, unknown>
  // The root element (the XML declaration parses as an object too).
  const repository = Object.values(parsed).find(
    (value) =>
      value != null && typeof value === 'object' && 'remotePackage' in value,
  ) as { remotePackage?: unknown } | undefined
  if (repository == null)
    throw new Error('The Android repository manifest has no packages')
  const host = context.os === 'macos' ? 'macosx' : context.os
  const cpu = context.arch === 'arm64' ? 'aarch64' : 'x64'
  for (const pkg of asList(
    repository.remotePackage as Array<Record<string, unknown>>,
  )) {
    if (pkg['@_path'] !== 'cmdline-tools;latest') continue
    const archives = asList(
      (pkg.archives as { archive?: unknown } | undefined)?.archive as Array<
        Record<string, unknown>
      >,
    ).filter((archive) => archive['host-os'] === host)
    // An archive built for this CPU first; one with no host-arch fits any.
    const archive =
      archives.find((entry) => entry['host-arch'] === cpu) ??
      archives.find((entry) => entry['host-arch'] == null)
    if (archive == null) continue
    const complete = archive.complete as {
      url: string
      checksum: string | { '#text': string }
    }
    const sha1 =
      typeof complete.checksum === 'string'
        ? complete.checksum
        : complete.checksum['#text']
    return { url: `${context.sources.android}/${complete.url}`, sha1 }
  }
  throw new Error(
    `The Android repository lists no command-line tools for ${host}`,
  )
}

/**
 * The Android command-line tools (verified against the repository's
 * published checksum) and the `sdkmanager` packages a stage names.
 * Licences are accepted only when the node's type records an administrator's
 * acceptance; otherwise the install fails naming the type.
 */
export async function installAndroid(
  packages: string[],
  context: InstallContext & {
    nodeType: string
    acceptLicences: boolean
    javaHome?: string
  },
): Promise<string[]> {
  if (
    packages.some(
      (pkg) =>
        !/^[A-Za-z0-9][A-Za-z0-9;._-]{0,99}$/.test(pkg) || pkg.includes('..'),
    )
  )
    throw new Error('Invalid Android package name')
  if (!context.acceptLicences)
    throw new LicencesNotAccepted(
      `Android SDK licences are not accepted for node type ${context.nodeType === '' ? '(none)' : context.nodeType}; an administrator accepts them in the nodeTypes settings`,
    )
  const root = sdkRoot(context.toolsDir)
  const latest = path.join(root, 'cmdline-tools', 'latest')
  const sdkmanager = path.join(latest, 'bin', 'sdkmanager')
  if (!existsSync(sdkmanager)) {
    const { url, sha1 } = await commandLineTools(context)
    const archive = path.join(root, 'commandlinetools.zip')
    await download(url, archive, { algorithm: 'sha1', digest: sha1 }, context)
    const unpacked = path.join(root, 'cmdline-tools.unpacking')
    rmSync(unpacked, { recursive: true, force: true })
    await extract(archive, unpacked)
    rmSync(latest, { recursive: true, force: true })
    mkdirSync(path.dirname(latest), { recursive: true })
    renameSync(path.join(unpacked, 'cmdline-tools'), latest)
    rmSync(unpacked, { recursive: true, force: true })
    rmSync(archive, { force: true })
    writeMarker(latest, {
      tool: 'android',
      version: 'cmdline-tools;latest',
      digest: sha1,
      source: url,
      installed: Date.now(),
    })
  }
  const env = {
    ...baseEnvironment(),
    ANDROID_HOME: root,
    ...(context.javaHome == null ? {} : { JAVA_HOME: context.javaHome }),
  }
  await step(
    sdkmanager,
    [`--sdk_root=${root}`, '--licenses'],
    context,
    env,
    'y\n'.repeat(50),
  )
  const missing = packages.filter(
    (pkg) => !installedPackages(root).includes(pkg),
  )
  if (missing.length > 0)
    await step(
      sdkmanager,
      [`--sdk_root=${root}`, ...missing],
      context,
      env,
      'y\n'.repeat(50),
    )
  const still = packages.filter((pkg) => !installedPackages(root).includes(pkg))
  if (still.length > 0)
    throw new Error(`sdkmanager did not install ${still.join(', ')}`)
  context.log(`Installed Android packages ${packages.join(', ')}\n`)
  return installedPackages(root)
}

export function androidEnvironment(toolsDir: string): {
  path: string[]
  env: Record<string, string>
} {
  const root = sdkRoot(toolsDir)
  return {
    path: [
      path.join(root, 'cmdline-tools', 'latest', 'bin'),
      path.join(root, 'platform-tools'),
    ],
    env: { ANDROID_HOME: root, ANDROID_SDK_ROOT: root },
  }
}
