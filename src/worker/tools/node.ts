import { rmSync } from 'node:fs'
import path from 'node:path'
import { compareVersions, prefixMatch } from './versions.js'
import {
  download,
  extract,
  fetchText,
  staging,
  writeMarker,
  type InstallContext,
} from './common.js'

/**
 * Node.js from the official release tarball, verified against the release's
 * `SHASUMS256.txt`. `version` is a major (`24`) or an exact version.
 */
export async function installNode(
  version: string,
  context: InstallContext,
): Promise<string> {
  const index = JSON.parse(
    await fetchText(`${context.sources.node}/index.json`, context.signal),
  ) as Array<{
    version: string
  }>
  const resolved = index
    .map((entry) => entry.version.replace(/^v/, ''))
    .filter((entry) => prefixMatch(version, entry))
    .sort(compareVersions)
    .pop()
  if (resolved == null) throw new Error(`No Node.js release matches ${version}`)
  const platform =
    context.os === 'macos'
      ? 'darwin'
      : context.os === 'windows'
        ? 'win'
        : 'linux'
  const name = `node-v${resolved}-${platform}-${context.arch}.tar.gz`
  const base = `${context.sources.node}/v${resolved}`
  const sums = await fetchText(`${base}/SHASUMS256.txt`, context.signal)
  const line = sums
    .split('\n')
    .find((entry) => entry.trim().endsWith(`  ${name}`))
  if (line == null)
    throw new Error(
      `SHASUMS256.txt of Node.js ${resolved} does not list ${name}`,
    )
  const digest = line.trim().split(/\s+/)[0]!
  const final = path.join(context.toolsDir, 'node', resolved)
  const stage = staging(final)
  try {
    const archive = path.join(stage.dir, name)
    await download(
      `${base}/${name}`,
      archive,
      { algorithm: 'sha256', digest },
      context,
    )
    await extract(archive, stage.dir, 1)
    rmSync(archive, { force: true })
    writeMarker(stage.dir, {
      tool: 'node',
      version: resolved,
      digest,
      source: `${base}/${name}`,
      installed: Date.now(),
    })
    stage.commit()
  } catch (error) {
    stage.discard()
    throw error
  }
  context.log(`Installed Node.js ${resolved}\n`)
  return resolved
}

/**
 * A stage's environment for an installed Node.js: its `bin` on `PATH`, and
 * `NODE_BINARY`, which React Native's Xcode build phases run.
 */
export function nodeEnvironment(dir: string): {
  path: string[]
  env: Record<string, string>
} {
  return {
    path: [path.join(dir, 'bin')],
    env: { NODE_BINARY: path.join(dir, 'bin', 'node') },
  }
}
