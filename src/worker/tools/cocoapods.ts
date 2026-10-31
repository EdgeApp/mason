import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { baseEnvironment } from '../../builder/config.js'
import {
  download,
  extract,
  readMarker,
  staging,
  step,
  writeMarker,
  type InstallContext,
} from './common.js'
import { inexactCocoapods } from '../../validation.js'
import { portableRuby, rubyBottle } from './versions.js'

/**
 * The portable Ruby CocoaPods runs on, installed once under
 * `<tools>/portable-ruby/<version>`, apart from the `ruby` tool's builds.
 */
async function installPortableRuby(context: InstallContext): Promise<string> {
  const final = path.join(
    context.toolsDir,
    'portable-ruby',
    portableRuby.version,
  )
  if (readMarker(final) != null) return final
  const file = rubyBottle(context.arch)
  const digest =
    context.sources.portableRubyDigests?.[file] ?? portableRuby.digests[file]
  if (digest == null) throw new Error(`No pinned digest for ${file}`)
  const stage = staging(final)
  try {
    const archive = path.join(stage.dir, file)
    const source = `${context.sources.portableRuby}/${portableRuby.version}/${file}`
    await download(source, archive, { algorithm: 'sha256', digest }, context)
    // A Homebrew bottle holds portable-ruby/<version>/{bin,lib,…}.
    await extract(archive, stage.dir, 2)
    rmSync(archive, { force: true })
    writeMarker(stage.dir, {
      tool: 'portable-ruby',
      version: portableRuby.version,
      digest,
      source,
      installed: Date.now(),
    })
    stage.commit()
  } catch (error) {
    stage.discard()
    throw error
  }
  context.log(`Installed portable Ruby ${portableRuby.version}\n`)
  return final
}

/** The environment that runs an installed CocoaPods, with its own Ruby and gems. */
export function cocoapodsEnvironment(
  toolsDir: string,
  version: string,
): { path: string[]; env: Record<string, string> } {
  const gems = path.join(toolsDir, 'cocoapods', version)
  return {
    path: [
      path.join(gems, 'bin'),
      path.join(toolsDir, 'portable-ruby', portableRuby.version, 'bin'),
    ],
    env: { GEM_HOME: gems, GEM_PATH: gems },
  }
}

/**
 * Installs an exact CocoaPods version with `gem`, into the tools directory:
 * no Homebrew and no administrator, so it works on any Mac Mason runs on.
 * Native gems (`ffi`) compile with the Xcode at `context.developerDir`, the
 * one the stage asked for. Only CocoaPods itself is pinned: its dependencies
 * resolve from RubyGems at install time, and the marker records them.
 */
export async function installCocoapods(
  version: string,
  context: InstallContext,
): Promise<string> {
  if (context.os !== 'macos')
    throw new Error('CocoaPods installs on macOS only')
  const inexact = inexactCocoapods(version)
  if (inexact != null) throw new Error(inexact)
  // Installs wait their turn: a repeat request finds the version there,
  // perhaps in use by a running stage, and leaves it alone.
  const final = path.join(context.toolsDir, 'cocoapods', version)
  if (readMarker(final) != null) return version
  const ruby = await installPortableRuby(context)
  const stage = staging(final)
  try {
    const base = baseEnvironment()
    await step(
      path.join(ruby, 'bin', 'gem'),
      [
        'install',
        'cocoapods',
        '-v',
        version,
        '--no-document',
        '--install-dir',
        stage.dir,
        '--bindir',
        path.join(stage.dir, 'bin'),
      ],
      context,
      {
        ...base,
        GEM_HOME: stage.dir,
        GEM_PATH: stage.dir,
        PATH: [path.join(ruby, 'bin'), base.PATH].join(path.delimiter),
        ...(context.developerDir == null
          ? {}
          : { DEVELOPER_DIR: context.developerDir }),
      },
    )
    if (!existsSync(path.join(stage.dir, 'bin', 'pod')))
      throw new Error(`gem installed no pod for CocoaPods ${version}`)
    writeMarker(stage.dir, {
      tool: 'cocoapods',
      version,
      digest: '',
      source: `rubygems cocoapods ${version}`,
      installed: Date.now(),
      resolved: existsSync(path.join(stage.dir, 'gems'))
        ? readdirSync(path.join(stage.dir, 'gems')).sort()
        : [],
    })
    stage.commit()
  } catch (error) {
    stage.discard()
    throw error
  }
  context.log(`Installed CocoaPods ${version}\n`)
  return version
}
