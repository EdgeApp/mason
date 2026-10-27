import { execFile } from 'node:child_process'
import { createHash, sign, verify, type KeyObject } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
  relink(manifest.version, path.join(layout.prefix, 'current'))
  mkdirSync(layout.bindir, { recursive: true })
  relink(
    path.join(layout.prefix, 'current', 'mason'),
    path.join(layout.bindir, 'mason'),
  )
  return dest
}
