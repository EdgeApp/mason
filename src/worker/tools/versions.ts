/** Version matching shared by the master's assignment and the worker's installers. */

export interface XcodeInstall {
  version: string
  build: string
  path: string
  beta: boolean
  /** Whether it runs on the node's macOS; unknown until the node has checked. */
  launches?: boolean
  launchError?: string
}

const parts = (version: string): number[] =>
  version.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : 0))

/** Compares dotted versions numerically: `1.10 > 1.9`. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Whether `version` is `spec` exactly or starts with it at a dot: `24` matches `24.11.1`. */
export function prefixMatch(spec: string, version: string): boolean {
  return (
    version === spec ||
    version.startsWith(`${spec}.`) ||
    version.startsWith(`${spec}+`)
  )
}

/** The newest installed version a spec such as `24` or `24.11.1` accepts. */
export function newestMatch(
  spec: string,
  installed: string[],
): string | undefined {
  return installed
    .filter((version) => prefixMatch(spec, version))
    .sort(compareVersions)
    .pop()
}

function satisfies(condition: string, version: string): boolean {
  const match = /^(>=|<=|>|<|=)?(.+)$/.exec(condition)!
  const [, op, target] = match
  const d = compareVersions(version, target!)
  switch (op) {
    case '>=':
      return d >= 0
    case '<=':
      return d <= 0
    case '>':
      return d > 0
    case '<':
      return d < 0
    default:
      return prefixMatch(target!, version)
  }
}

/** The Xcode a spec selects among the installed ones that launch on the node. */
export function launchingXcode(
  spec: string,
  installs: XcodeInstall[],
): XcodeInstall | undefined {
  return selectXcode(
    spec,
    installs.filter((install) => install.launches !== false),
  )
}

/**
 * The newest installed Xcode a stage's `xcode` asks for: `latest`, `latest-beta`,
 * an exact version or prefix (`26.1`), a build number (`17B55`), or a range
 * (`>=26.0 <27`).
 */
export function selectXcode(
  spec: string,
  installs: XcodeInstall[],
): XcodeInstall | undefined {
  const newest = (list: XcodeInstall[]): XcodeInstall | undefined =>
    [...list]
      .sort(
        (a, b) =>
          compareVersions(a.version, b.version) ||
          Number(b.beta) - Number(a.beta),
      )
      .pop()
  if (spec === 'latest')
    return newest(installs.filter((install) => !install.beta))
  if (spec === 'latest-beta') return newest(installs)
  const byBuild = installs.filter((install) => install.build === spec)
  if (byBuild.length > 0) return newest(byBuild)
  const conditions = spec.trim().split(/\s+/)
  return newest(
    installs.filter(
      (install) =>
        !install.beta &&
        conditions.every((condition) => satisfies(condition, install.version)),
    ),
  )
}

const rubyVersion = '3.4.5'

/** The file name of Homebrew's portable Ruby bottle for a Mac's architecture. */
export function rubyBottle(arch: string): string {
  return `portable-ruby-${rubyVersion}.${arch === 'arm64' ? 'arm64_big_sur' : 'el_capitan'}.bottle.tar.gz`
}

/** The portable Ruby CocoaPods installs with: Homebrew's release, its bottles' SHA-256 pinned. */
export const portableRuby = {
  version: rubyVersion,
  digests: {
    [rubyBottle('arm64')]:
      '20fa657858e44a4b39171d6e4111f8a9716eb62a78ebbd1491d94f90bb7b830a',
    [rubyBottle('x64')]:
      '0c78b38f22fb9b42df6918db00e6f5a80d5b35164f910ffe4c89159326ae98cf',
  } as Record<string, string>,
}
