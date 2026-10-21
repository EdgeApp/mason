import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { baseEnvironment } from '../../builder/config.js'
import type { XcodeInstall } from '../tools/versions.js'

/** Runs a read-only system command as the worker's user; never throws. */
export type SystemRun = (
  command: string,
  args: string[],
  options?: { env?: Record<string, string>; timeoutMs?: number; cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>

export const systemRun: SystemRun = async (command, args, options = {}) =>
  await new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        env: { ...baseEnvironment(), ...options.env },
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 32 * 1024 * 1024,
        ...(options.cwd == null ? {} : { cwd: options.cwd }),
      },
      (error, stdout, stderr) => {
        const code =
          error == null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? Number((error as { code: number }).code)
              : 127
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })

export interface SimulatorRuntime {
  /** `iOS 26.1`, as node types and stages name it. */
  name: string
  version: string
  build: string
  /** CoreSimulator's runtime identifier. */
  identifier: string
  /** The disk image's UUID, for runtimes that can be deleted. */
  image?: string
}

/** What a node has beyond its tools directory: system software and settings. */
export interface SystemInventory {
  commandLineTools?: boolean
  rosetta?: boolean
  /** Undefined when Homebrew is not installed. */
  brew?: { formulae: string[]; casks: string[] }
  /** Undefined when the node has no dpkg (or rpm, for dnf). */
  apt?: string[]
  dnf?: string[]
  docker?: boolean
  settings?: {
    noSleep: boolean
    devToolsSecurity: boolean
    automationMode: boolean
  }
  runtimes: SimulatorRuntime[]
  /** Whether each installed Xcode launches on this macOS, by path. */
  launches: Record<string, { ok: boolean; error?: string }>
  /** Reported only: whether someone is logged in at the console (automatic login is the owner's choice). */
  guiSession?: boolean
}

const platformNames: Record<string, string> = {
  'com.apple.platform.iphonesimulator': 'iOS',
  'com.apple.platform.appletvsimulator': 'tvOS',
  'com.apple.platform.watchsimulator': 'watchOS',
  'com.apple.platform.xrsimulator': 'visionOS',
}

export const developerDir = (app: string): string =>
  path.join(app, 'Contents', 'Developer')

export function brewPath(): string | undefined {
  return ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((file) =>
    existsSync(file),
  )
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

/** Installed simulator runtimes, through the node's default Xcode. */
export async function scanRuntimes(
  run: SystemRun,
  env: Record<string, string> = {},
): Promise<SimulatorRuntime[]> {
  const listed = await run('xcrun', ['simctl', 'list', 'runtimes', '-j'], {
    env,
  })
  if (listed.code !== 0) return []
  const images = await run('xcrun', ['simctl', 'runtime', 'list', '-j'], {
    env,
  })
  const byIdentifier = new Map<string, string>()
  if (images.code === 0)
    try {
      for (const [uuid, image] of Object.entries(
        JSON.parse(images.stdout) as Record<
          string,
          { runtimeIdentifier?: string; deletable?: boolean }
        >,
      ))
        if (image.runtimeIdentifier != null && image.deletable !== false)
          byIdentifier.set(image.runtimeIdentifier, uuid)
    } catch {
      // No deletable images listed.
    }
  try {
    const runtimes = (
      JSON.parse(listed.stdout) as {
        runtimes?: Array<{
          name?: string
          version?: string
          buildversion?: string
          identifier?: string
          platform?: string
          isAvailable?: boolean
        }>
      }
    ).runtimes
    return (runtimes ?? [])
      .filter((runtime) => runtime.isAvailable !== false)
      .map((runtime) => {
        const identifier = String(runtime.identifier ?? '')
        const image = byIdentifier.get(identifier)
        return {
          name:
            runtime.name ??
            `${platformNames[runtime.platform ?? ''] ?? runtime.platform} ${runtime.version}`,
          version: String(runtime.version ?? ''),
          build: String(runtime.buildversion ?? ''),
          identifier,
          ...(image == null ? {} : { image }),
        }
      })
  } catch {
    return []
  }
}

const launchCache = new Map<
  string,
  { mtime: number; ok: boolean; error?: string }
>()

/** Whether an Xcode runs on this macOS: `xcodebuild -version` succeeds with it selected. */
export async function xcodeLaunches(
  install: XcodeInstall,
  run: SystemRun,
): Promise<{ ok: boolean; error?: string }> {
  let mtime = 0
  try {
    mtime = statSync(path.join(install.path, 'Contents', 'Info.plist')).mtimeMs
  } catch {
    // A bundle without Info.plist does not launch.
  }
  const cached = launchCache.get(install.path)
  if (cached?.mtime === mtime) return cached
  const result = await run('xcodebuild', ['-version'], {
    env: { DEVELOPER_DIR: developerDir(install.path) },
    timeoutMs: 60_000,
  })
  const entry = {
    mtime,
    ok: result.code === 0,
    ...(result.code === 0
      ? {}
      : {
          error:
            lines(result.stderr + '\n' + result.stdout)[0] ??
            `xcodebuild exited with ${result.code}`,
        }),
  }
  launchCache.set(install.path, entry)
  return entry
}

export async function systemInventory(options: {
  os: string
  arch: string
  xcodes: XcodeInstall[]
  run?: SystemRun
}): Promise<SystemInventory> {
  const run = options.run ?? systemRun
  const launches: SystemInventory['launches'] = {}
  for (const install of options.xcodes)
    launches[install.path] = await xcodeLaunches(install, run)
  if (options.os === 'macos') {
    const brew = brewPath()
    const formulae =
      brew == null ? undefined : await run(brew, ['list', '--formula', '-1'])
    const casks =
      brew == null ? undefined : await run(brew, ['list', '--cask', '-1'])
    const [clt, rosetta, sleep, devTools, automation, console] =
      await Promise.all([
        run('pkgutil', ['--pkg-info=com.apple.pkg.CLTools_Executables']),
        options.arch === 'arm64'
          ? run('/usr/bin/arch', ['-x86_64', '/usr/bin/true'])
          : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
        run('pmset', ['-g']),
        run('DevToolsSecurity', ['-status']),
        run('automationmodetool', []),
        run('stat', ['-f', '%Su', '/dev/console']),
      ])
    return {
      commandLineTools: clt.code === 0,
      rosetta: rosetta.code === 0,
      ...(formulae == null || casks == null
        ? {}
        : {
            brew: {
              formulae: lines(formulae.stdout),
              casks: lines(casks.stdout),
            },
          }),
      settings: {
        noSleep: /^\s*sleep\s+0\b/m.test(sleep.stdout),
        devToolsSecurity: /enabled/i.test(devTools.stdout + devTools.stderr),
        automationMode: /DOES NOT REQUIRE/i.test(
          automation.stdout + automation.stderr,
        ),
      },
      runtimes: await scanRuntimes(run),
      launches,
      guiSession:
        console.code === 0 && console.stdout.trim() === os.userInfo().username,
    }
  }
  const [dpkg, rpm, docker] = await Promise.all([
    run('dpkg-query', ['-W', '-f=${Package}\n']),
    run('rpm', ['-qa', '--qf', '%{NAME}\n']),
    run('docker', ['--version']),
  ])
  return {
    ...(dpkg.code === 0 ? { apt: lines(dpkg.stdout) } : {}),
    ...(rpm.code === 0 && dpkg.code !== 0 ? { dnf: lines(rpm.stdout) } : {}),
    docker: docker.code === 0,
    runtimes: [],
    launches,
  }
}
