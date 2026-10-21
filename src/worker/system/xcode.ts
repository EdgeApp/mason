import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { NodeInfo } from '../../../types/mason/index.js'
import type { SystemRun } from './index.js'

export type StageXcode = NonNullable<NodeInfo['xcode']>

/**
 * Readies a stage's Xcode: runs first launch through the helper when
 * `-checkFirstLaunchStatus` asks for it, then logs `xcodebuild -version`,
 * the path and the SDKs, which become `ctx.node.xcode`.
 */
export async function prepareXcode(
  developerDir: string,
  options: {
    run: SystemRun
    helper: (op: string, args: Record<string, unknown>) => Promise<unknown>
    log: (text: string) => void
  },
): Promise<StageXcode> {
  const app = path.dirname(path.dirname(developerDir))
  const env = { DEVELOPER_DIR: developerDir }
  const status = await options.run('xcodebuild', ['-checkFirstLaunchStatus'], {
    env,
  })
  if (status.code !== 0) {
    options.log(`Running first launch for ${app}\n`)
    await options.helper('xcode.firstLaunch', { path: app })
  }
  const version = await options.run('xcodebuild', ['-version'], { env })
  if (version.code !== 0)
    throw new Error(
      `${app} does not launch: ${(version.stderr || version.stdout).trim()}`,
    )
  const sdks = await options.run('xcodebuild', ['-showsdks', '-json'], { env })
  let names: string[] = []
  try {
    names = (
      JSON.parse(sdks.stdout) as Array<{ canonicalName?: string }>
    ).flatMap((sdk) => (sdk.canonicalName == null ? [] : [sdk.canonicalName]))
  } catch {
    // An Xcode without `-showsdks -json` reports none.
  }
  const text = version.stdout.trim()
  options.log(`${text}\nXcode: ${app}\nSDKs: ${names.join(', ') || '(none)'}\n`)
  return {
    version: /^Xcode\s+(\S+)/m.exec(text)?.[1] ?? '',
    build: /^Build version\s+(\S+)/m.exec(text)?.[1] ?? '',
    path: app,
    sdks: names,
  }
}

/** A device set private to one stage, so simulators from different stages and Xcodes do not collide. */
export function simulatorSet(privateDir: string): string {
  const dir = path.join(privateDir, 'simulators')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Shuts down and deletes the stage's simulators, then the set itself. */
export async function removeSimulatorSet(
  dir: string,
  run: SystemRun,
  env: Record<string, string>,
): Promise<void> {
  await run('xcrun', ['simctl', '--set', dir, 'shutdown', 'all'], { env })
  await run('xcrun', ['simctl', '--set', dir, 'delete', 'all'], { env })
  rmSync(dir, { recursive: true, force: true })
}
