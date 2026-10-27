import { chmodSync, rmSync } from 'node:fs'
import path from 'node:path'
import { baseEnvironment } from '../../builder/config.js'
import {
  download,
  fetchText,
  step,
  writeMarker,
  type InstallContext,
} from './common.js'

function target(context: InstallContext): string {
  const cpu = context.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (context.os === 'macos') return `${cpu}-apple-darwin`
  if (context.os === 'windows') return `${cpu}-pc-windows-msvc`
  return `${cpu}-unknown-linux-gnu`
}

/**
 * Rust through `rustup-init`, verified by its published SHA-256, with
 * `RUSTUP_HOME` and `CARGO_HOME` inside the tools directory and the
 * toolchain pinned to `version` (`1.82.0`, `stable`).
 */
export async function installRust(
  version: string,
  context: InstallContext,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version))
    throw new Error('Invalid Rust toolchain')
  const url = `${context.sources.rust}/rustup/dist/${target(context)}/rustup-init`
  const digest = (await fetchText(`${url}.sha256`, context.signal))
    .trim()
    .split(/\s+/)[0]!
  const dir = path.join(context.toolsDir, 'rust', version)
  // rustup records its homes' paths, so it installs in place; the marker comes last.
  rmSync(dir, { recursive: true, force: true })
  const init = path.join(dir, 'rustup-init')
  try {
    await download(url, init, { algorithm: 'sha256', digest }, context)
    chmodSync(init, 0o700)
    await step(
      init,
      [
        '-y',
        '--no-modify-path',
        '--profile',
        'minimal',
        '--default-toolchain',
        version,
      ],
      context,
      {
        ...baseEnvironment(),
        RUSTUP_HOME: path.join(dir, 'rustup'),
        CARGO_HOME: path.join(dir, 'cargo'),
      },
    )
    rmSync(init, { force: true })
    writeMarker(dir, {
      tool: 'rust',
      version,
      digest,
      source: url,
      installed: Date.now(),
    })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  context.log(`Installed Rust ${version}\n`)
  return version
}

export function rustEnvironment(dir: string): {
  path: string[]
  env: Record<string, string>
} {
  return {
    path: [path.join(dir, 'cargo', 'bin')],
    env: {
      RUSTUP_HOME: path.join(dir, 'rustup'),
      CARGO_HOME: path.join(dir, 'cargo'),
    },
  }
}
