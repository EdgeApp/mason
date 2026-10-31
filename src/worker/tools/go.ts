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

interface GoRelease {
  version: string
  stable: boolean
  files: Array<{
    filename: string
    os: string
    arch: string
    sha256: string
    kind: string
  }>
}

/**
 * Go from go.dev's release list, verified against the sha256 it publishes.
 * `version` is a minor (`1.23`) or an exact version (`1.23.4`).
 */
export async function installGo(
  version: string,
  context: InstallContext,
): Promise<string> {
  if (!/^\d+\.\d+(\.\d+)?$/.test(version)) throw new Error('Invalid Go version')
  const os =
    context.os === 'macos'
      ? 'darwin'
      : context.os === 'windows'
        ? 'windows'
        : 'linux'
  const arch = context.arch === 'arm64' ? 'arm64' : 'amd64'
  const releases = JSON.parse(
    await fetchText(
      `${context.sources.go}/?mode=json&include=all`,
      context.signal,
    ),
  ) as GoRelease[]
  const builds = releases
    .filter((release) => release.stable)
    .flatMap((release) => {
      const file = release.files.find(
        (entry) =>
          entry.os === os && entry.arch === arch && entry.kind === 'archive',
      )
      return file == null
        ? []
        : [{ version: release.version.replace(/^go/, ''), file }]
    })
    .filter((build) => prefixMatch(version, build.version))
    .sort((a, b) => compareVersions(a.version, b.version))
  const build = builds.pop()
  if (build == null) throw new Error(`No Go release matches ${version}`)
  if (!/^[\w.-]+$/.test(build.file.filename))
    throw new Error(`Unexpected Go archive name ${build.file.filename}`)
  const final = path.join(context.toolsDir, 'go', build.version)
  const stage = staging(final)
  try {
    const archive = path.join(stage.dir, build.file.filename)
    await download(
      `${context.sources.go}/${build.file.filename}`,
      archive,
      { algorithm: 'sha256', digest: build.file.sha256 },
      context,
    )
    await extract(archive, stage.dir, 1)
    rmSync(archive, { force: true })
    writeMarker(stage.dir, {
      tool: 'go',
      version: build.version,
      digest: build.file.sha256,
      source: `${context.sources.go}/${build.file.filename}`,
      installed: Date.now(),
    })
    stage.commit()
  } catch (error) {
    stage.discard()
    throw error
  }
  context.log(`Installed Go ${build.version}\n`)
  return build.version
}

/** A stage's environment for an installed Go: `GOROOT`, its `bin` first, and no toolchain switching. */
export function goEnvironment(dir: string): {
  path: string[]
  env: Record<string, string>
} {
  return {
    path: [path.join(dir, 'bin')],
    env: { GOROOT: dir, GOTOOLCHAIN: 'local' },
  }
}
