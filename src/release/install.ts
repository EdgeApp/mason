import { execFile, execFileSync } from 'node:child_process'
import { createHash, sign, verify, type KeyObject } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { baseEnvironment } from '../builder/config.js'

const run = promisify(execFile)

/** What a release a master pushes says about one tarball; the master signs it. */
export interface ReleaseManifest {
  version: string
  platform: string
  sha256: string
}

const canonical = (manifest: ReleaseManifest): Buffer =>
  Buffer.from(
    `mason-release-v1\n${manifest.version}\n${manifest.platform}\n${manifest.sha256}\n`,
  )

/** Signs a release manifest with the master's ML-DSA key. */
export function signRelease(
  manifest: ReleaseManifest,
  privateKey: KeyObject,
): string {
  return sign(null, canonical(manifest), privateKey).toString('base64')
}

export function verifyRelease(
  manifest: ReleaseManifest,
  signature: string,
  publicKey: KeyObject,
): boolean {
  try {
    return verify(
      null,
      canonical(manifest),
      publicKey,
      Buffer.from(signature, 'base64'),
    )
  } catch {
    return false
  }
}

const parse = (version: string): number[] =>
  version.split(/[.-]/).slice(0, 3).map(Number)

/** Compares x.y.z versions; prerelease suffixes are ignored. */
export function compareSemver(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! - y[i]!
  return 0
}

export const major = (version: string): number => parse(version)[0]!

/** This process's platform as release tarballs name it. */
export function releasePlatform(
  platform = process.platform,
  arch = process.arch,
): string {
  return `${platform === 'darwin' ? 'darwin' : 'linux'}-${arch === 'arm64' ? 'arm64' : 'x64'}`
}

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** How the running Mason was installed. */
export interface RunningInstall {
  /** `system`: under /opt/mason, updated through the helper; `user`: under ~/.mason/app; `checkout`: a source tree. */
  kind: 'system' | 'user' | 'checkout'
  /** The directory holding `lib/`. */
  appRoot: string
  /** The directory holding the versions, for release installs. */
  prefix?: string
}

export function runningInstall(
  appRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
  home = homedir(),
): RunningInstall {
  const release =
    existsSync(path.join(appRoot, 'mason')) &&
    existsSync(path.join(appRoot, '.sha256'))
  if (!release) return { kind: 'checkout', appRoot }
  const prefix = path.dirname(appRoot)
  return {
    kind: prefix.startsWith(home + path.sep) ? 'user' : 'system',
    appRoot,
    prefix,
  }
}

/** The program a service runs: the stable `current` launcher of a release install, else Node and the CLI. */
export function serviceProgram(
  install: RunningInstall,
  execPath: string,
  script: string,
): string[] {
  if (install.kind === 'checkout' || install.prefix == null)
    return [execPath, script]
  return [path.join(install.prefix, 'current', 'mason')]
}

/** A release's directory under the install prefix, or a failed install of one. */
const releaseDirectory = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\.partial)?$/
/** A failed install younger than this may still be one in progress. */
const PARTIAL_AGE_MS = 60 * 60 * 1000

/** The command lines of this computer's processes, or none when `ps` fails. */
export function processCommands(): string[] | undefined {
  try {
    return execFileSync('ps', ['axww', '-o', 'command='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).split('\n')
  } catch {
    return undefined
  }
}

/**
 * Removes installed releases under `prefix` but the last two: the ones in
 * `keep` (the release now current and the one that ran before it), topped
 * up with the most recently installed others when `keep` names fewer than
 * two. A release a running process uses stays too, as does every release
 * when the processes cannot be listed. Failed installs (`.partial`) go once
 * they are an hour old. Only directories holding a release's `mason` and
 * `.sha256` are touched. It never throws: what it cannot remove is listed
 * as failed. Removed names are oldest first.
 */
export function pruneReleases(
  prefix: string,
  keep: string[],
  options: { commands?: string[] | undefined; now?: number } = {},
): { removed: string[]; failed: string[] } {
  const removed: string[] = []
  const failed: string[] = []
  let entries
  try {
    entries = readdirSync(prefix, { withFileTypes: true })
  } catch {
    return { removed, failed }
  }
  const at = (name: string): number | undefined => {
    try {
      return statSync(path.join(prefix, name)).mtimeMs
    } catch {
      return undefined
    }
  }
  const now = options.now ?? Date.now()
  const candidates = entries
    .filter((entry) => entry.isDirectory() && releaseDirectory.test(entry.name))
    .map((entry) => ({ name: entry.name, at: at(entry.name) }))
    .filter((entry): entry is { name: string; at: number } => entry.at != null)
  const partials = candidates.filter(
    (entry) =>
      entry.name.endsWith('.partial') && now - entry.at > PARTIAL_AGE_MS,
  )
  const installed = candidates
    .filter(
      (entry) =>
        !entry.name.endsWith('.partial') &&
        existsSync(path.join(prefix, entry.name, 'mason')) &&
        existsSync(path.join(prefix, entry.name, '.sha256')),
    )
    .sort((a, b) => b.at - a.at)
  const commands = 'commands' in options ? options.commands : processCommands()
  let real = prefix
  try {
    real = realpathSync(prefix)
  } catch {}
  const running = (name: string): boolean =>
    commands == null ||
    commands.some(
      (line) =>
        line.includes(`${real}/${name}/`) ||
        line.includes(`${prefix}/${name}/`),
    )
  const kept = new Set(
    keep.filter((name) => installed.some((entry) => entry.name === name)),
  )
  for (const release of installed) if (kept.size < 2) kept.add(release.name)
  const old = [
    ...partials,
    ...installed.filter(
      (entry) => !kept.has(entry.name) && !running(entry.name),
    ),
  ].sort((a, b) => a.at - b.at)
  for (const { name } of old)
    try {
      rmSync(path.join(prefix, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      failed.push(name)
    }
  return { removed, failed }
}

/** The release `<prefix>/current` points at, if any. */
export function currentRelease(prefix: string): string | undefined {
  try {
    return path.basename(readlinkSync(path.join(prefix, 'current')))
  } catch {
    return undefined
  }
}

/**
 * Installs a verified release tarball beside the running version in
 * `<prefix>/<version>` and repoints `<prefix>/current` and the `mason`
 * link. A version already installed with the same digest is left as is.
 */
export async function installTarball(
  tarball: string,
  layout: { prefix: string; bindir: string },
  manifest: ReleaseManifest,
): Promise<string> {
  const digest = await fileSha256(tarball)
  if (digest !== manifest.sha256)
    throw new Error('The release tarball does not match its signed digest')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))
    throw new Error('Invalid release version')
  const dest = path.join(layout.prefix, manifest.version)
  const marker = path.join(dest, '.sha256')
  if (!(existsSync(marker) && readFileSync(marker, 'utf8').trim() === digest)) {
    const partial = `${dest}.partial`
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })
    await run('tar', ['-xzf', tarball, '-C', partial, '--strip-components=1'], {
      env: baseEnvironment(),
    })
    if (
      !existsSync(path.join(partial, 'mason')) ||
      !existsSync(path.join(partial, 'lib', 'cli.js'))
    )
      throw new Error('The tarball is not a Mason release')
    writeFileSync(path.join(partial, '.sha256'), digest + '\n')
    rmSync(dest, { recursive: true, force: true })
    renameSync(partial, dest)
  }
  const relink = (target: string, link: string): void => {
    const temporary = `${link}.${process.pid}`
    rmSync(temporary, { force: true })
    symlinkSync(target, temporary)
    renameSync(temporary, link)
  }
  const previous = currentRelease(layout.prefix)
  relink(manifest.version, path.join(layout.prefix, 'current'))
  mkdirSync(layout.bindir, { recursive: true })
  relink(
    path.join(layout.prefix, 'current', 'mason'),
    path.join(layout.bindir, 'mason'),
  )
  // Only the new release and the one before it stay installed; pruning
  // never fails an install that is already live.
  pruneReleases(layout.prefix, [
    manifest.version,
    ...(previous == null ? [] : [previous]),
  ])
  return dest
}
