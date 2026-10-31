import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { baseEnvironment } from '../../builder/config.js'
import { brewPath } from '../system/index.js'
import {
  download,
  extract,
  readMarker,
  step,
  writeMarker,
  type InstallContext,
} from './common.js'
import { compareVersions, prefixMatch } from './versions.js'

const run = promisify(execFile)

/** The ruby-build release Mason builds Ruby with; it checks each Ruby and OpenSSL tarball it downloads. */
export const RUBY_BUILD = {
  tag: 'v20261013',
  sha256: '9e683b1d8efe337ae27c31f995641e22761af603bb0f783d22c5d2f99252758c',
}

/** ruby-build, downloaded once per node and checked against the pinned digest. */
async function rubyBuild(context: InstallContext): Promise<string> {
  const dir = path.join(context.toolsDir, 'ruby-build', RUBY_BUILD.tag)
  const bin = path.join(dir, 'bin', 'ruby-build')
  if (readMarker(dir)?.digest === RUBY_BUILD.sha256 && existsSync(bin))
    return bin
  rmSync(dir, { recursive: true, force: true })
  const url = `${context.sources.rubyBuild}/${RUBY_BUILD.tag}.tar.gz`
  const archive = path.join(dir, 'ruby-build.tar.gz')
  try {
    await download(
      url,
      archive,
      { algorithm: 'sha256', digest: RUBY_BUILD.sha256 },
      context,
    )
    await extract(archive, dir, 1)
    rmSync(archive, { force: true })
    writeMarker(dir, {
      tool: 'ruby-build',
      version: RUBY_BUILD.tag,
      digest: RUBY_BUILD.sha256,
      source: url,
      installed: Date.now(),
    })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return bin
}

/** ruby-build's environment: the node's Homebrew, where it finds OpenSSL and libyaml on macOS. */
function buildEnvironment(): NodeJS.ProcessEnv {
  const env = baseEnvironment()
  const brew = brewPath()
  return brew == null
    ? env
    : {
        ...env,
        PATH: [path.dirname(brew), env.PATH ?? ''].join(path.delimiter),
      }
}

/**
 * CRuby built from source with a pinned ruby-build, once per version per
 * node: `version` is a minor (`3.3`) or an exact version (`3.3.5`) that
 * ruby-build defines. It needs a C compiler and libyaml (the Command Line
 * Tools and Homebrew's libyaml on macOS; build-essential and libyaml-dev on
 * Linux). Gems install into that Ruby's own directory, so each version keeps
 * its own CocoaPods, Bundler and Fastlane.
 */
export async function installRuby(
  version: string,
  context: InstallContext,
): Promise<string> {
  if (!/^\d+\.\d+(\.\d+)?$/.test(version))
    throw new Error('Invalid Ruby version')
  const bin = await rubyBuild(context)
  const env = buildEnvironment()
  const { stdout } = await run(bin, ['--definitions'], {
    env,
    maxBuffer: 4 * 1024 * 1024,
  })
  const resolved = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\d+\.\d+$/.test(line))
    .filter((line) => prefixMatch(version, line))
    .sort(compareVersions)
    .pop()
  if (resolved == null)
    throw new Error(`ruby-build ${RUBY_BUILD.tag} defines no Ruby ${version}`)
  // Ruby records its prefix when built, so it builds in place; the marker comes last.
  const dir = path.join(context.toolsDir, 'ruby', resolved)
  rmSync(dir, { recursive: true, force: true })
  const tmp = path.join(context.toolsDir, 'ruby-build', 'tmp')
  const cache = path.join(context.toolsDir, 'ruby-build', 'cache')
  mkdirSync(tmp, { recursive: true })
  mkdirSync(cache, { recursive: true })
  try {
    await step(bin, [resolved, dir], context, {
      ...env,
      TMPDIR: tmp,
      RUBY_BUILD_CACHE_PATH: cache,
    })
    writeMarker(dir, {
      tool: 'ruby',
      version: resolved,
      digest: RUBY_BUILD.sha256,
      source: `ruby-build ${RUBY_BUILD.tag}`,
      installed: Date.now(),
    })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  context.log(`Installed Ruby ${resolved}\n`)
  return resolved
}

/** A stage's environment for an installed Ruby: its `bin` (Ruby and its gems' commands) first. */
export function rubyEnvironment(dir: string): {
  path: string[]
  env: Record<string, string>
} {
  return { path: [path.join(dir, 'bin')], env: {} }
}
