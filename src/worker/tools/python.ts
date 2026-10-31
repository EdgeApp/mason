import { rmSync } from 'node:fs'
import path from 'node:path'
import {
  download,
  extract,
  fetchText,
  staging,
  writeMarker,
  type InstallContext,
} from './common.js'
import { compareVersions, prefixMatch } from './versions.js'

function triple(context: InstallContext): string {
  const cpu = context.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (context.os === 'macos') return `${cpu}-apple-darwin`
  if (context.os === 'linux') return `${cpu}-unknown-linux-gnu`
  throw new Error('Mason installs Python on macOS and Linux')
}

/**
 * CPython from python-build-standalone's current release (the relocatable
 * builds uv and mise use), verified against the release's `SHA256SUMS`.
 * `version` is a minor (`3.12`) or an exact version the release carries.
 */
export async function installPython(
  version: string,
  context: InstallContext,
): Promise<string> {
  if (!/^\d+\.\d+(\.\d+)?$/.test(version))
    throw new Error('Invalid Python version')
  const latest = JSON.parse(
    await fetchText(
      `${context.sources.python}/latest-release.json`,
      context.signal,
    ),
  ) as { tag?: unknown; asset_url_prefix?: unknown }
  const prefix = String(latest.asset_url_prefix ?? '')
  if (!/^https?:\/\//.test(prefix))
    throw new Error('The Python release index names no download location')
  const sums = await fetchText(`${prefix}/SHA256SUMS`, context.signal)
  const name = new RegExp(
    `^cpython-(\\d+\\.\\d+\\.\\d+)\\+\\d+-${triple(context)}-install_only\\.tar\\.gz$`,
  )
  const builds = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .flatMap(([digest, file]) => {
      const match = name.exec(file ?? '')
      return match == null || !/^[0-9a-f]{64}$/.test(digest ?? '')
        ? []
        : [{ digest: digest!, file: file!, version: match[1]! }]
    })
    .filter((build) => prefixMatch(version, build.version))
    .sort((a, b) => compareVersions(a.version, b.version))
  const build = builds.pop()
  if (build == null)
    throw new Error(
      `Python ${version} is not in python-build-standalone ${String(latest.tag)}`,
    )
  const final = path.join(context.toolsDir, 'python', build.version)
  const stage = staging(final)
  try {
    const archive = path.join(stage.dir, build.file)
    await download(
      `${prefix}/${encodeURIComponent(build.file)}`,
      archive,
      { algorithm: 'sha256', digest: build.digest },
      context,
    )
    await extract(archive, stage.dir, 1)
    rmSync(archive, { force: true })
    writeMarker(stage.dir, {
      tool: 'python',
      version: build.version,
      digest: build.digest,
      source: `${prefix}/${build.file}`,
      installed: Date.now(),
    })
    stage.commit()
  } catch (error) {
    stage.discard()
    throw error
  }
  context.log(`Installed Python ${build.version}\n`)
  return build.version
}

/** A stage's environment for an installed Python: its `bin` first, no user site-packages. */
export function pythonEnvironment(dir: string): {
  path: string[]
  env: Record<string, string>
} {
  return { path: [path.join(dir, 'bin')], env: { PYTHONNOUSERSITE: '1' } }
}
