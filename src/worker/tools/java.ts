import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
  download,
  extract,
  fetchText,
  staging,
  writeMarker,
  type InstallContext,
} from './common.js'
import { prefixMatch } from './versions.js'

interface Asset {
  binary: { package: { link: string; checksum: string; name: string } }
  version: { semver: string }
}

/**
 * The Temurin JDK for a major version (`21`) or exact version, from
 * Adoptium's API, verified against the checksum the API publishes.
 */
export async function installJava(
  version: string,
  context: InstallContext,
): Promise<string> {
  const major = version.split('.')[0]!
  if (!/^\d{1,3}$/.test(major)) throw new Error('Invalid Java version')
  const os = context.os === 'macos' ? 'mac' : context.os
  const arch = context.arch === 'arm64' ? 'aarch64' : 'x64'
  const assets = JSON.parse(
    await fetchText(
      `${context.sources.adoptium}/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`,
      context.signal,
    ),
  ) as Asset[]
  const asset = assets.find((entry) =>
    prefixMatch(version, entry.version.semver.replace(/\+.*$/, '')),
  )
  if (asset == null) throw new Error(`No Temurin JDK matches ${version}`)
  const resolved = asset.version.semver.replace(/\+.*$/, '')
  const final = path.join(context.toolsDir, 'java', resolved)
  const stage = staging(final)
  try {
    const archive = path.join(stage.dir, asset.binary.package.name)
    await download(
      asset.binary.package.link,
      archive,
      { algorithm: 'sha256', digest: asset.binary.package.checksum },
      context,
    )
    await extract(archive, stage.dir, 1)
    rmSync(archive, { force: true })
    writeMarker(stage.dir, {
      tool: 'java',
      version: resolved,
      digest: asset.binary.package.checksum,
      source: asset.binary.package.link,
      installed: Date.now(),
    })
    stage.commit()
  } catch (error) {
    stage.discard()
    throw error
  }
  context.log(`Installed Temurin JDK ${resolved}\n`)
  return resolved
}

/** `JAVA_HOME` of an installed JDK: macOS bundles keep it under `Contents/Home`. */
export function javaHome(dir: string): string {
  const mac = path.join(dir, 'Contents', 'Home')
  return existsSync(mac) ? mac : dir
}

export function javaEnvironment(dir: string): {
  path: string[]
  env: Record<string, string>
} {
  const home = javaHome(dir)
  return { path: [path.join(home, 'bin')], env: { JAVA_HOME: home } }
}
