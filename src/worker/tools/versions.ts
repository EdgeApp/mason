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
