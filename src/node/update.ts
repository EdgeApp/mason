import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { compareSemver } from '../release/install.js'
import { UPDATE_REQUEST, updaterUnit } from './service.js'
import { writePrivate } from './dataDir.js'

/**
 * Updates over the link. The master asks a node for a version; the node, which
 * never runs as root, only writes the version in its data directory, and the
 * root updater unit `--install` set up (`mason-<role>-update.path`) runs
 * `mason update --request` with it.
 */

const releaseVersion = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/

/** A release version as `install.sh --version` takes it, or an error. */
export function asReleaseVersion(value: unknown): string {
  if (typeof value !== 'string' || !releaseVersion.test(value))
    throw new Error('An update names a release version such as 0.2.1')
  return value
}

/**
 * Orders two release versions as semver does: by x.y.z, then a prerelease
 * before its release, then prerelease identifiers (numeric ones by value).
 */
export function compareRelease(a: string, b: string): number {
  const core = compareSemver(a, b)
  if (core !== 0) return core
  const [x, y] = [a, b].map((value) => value.split('-').slice(1).join('-'))
  if (x === y) return 0
  if (x === '') return 1
  if (y === '') return -1
  const [xs, ys] = [x!.split('.'), y!.split('.')]
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const [p, q] = [xs[i], ys[i]]
    if (p == null) return -1
    if (q == null) return 1
    if (p === q) continue
    const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (m && n) return Number(p) - Number(q)
    if (m !== n) return m ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/**
 * Reads and removes an update request: the version to install, or undefined
 * when this is that version already. The request is gone before anything
 * else happens, so the path unit cannot start the updater again with it.
 */
export function takeUpdateRequest(
  file: string,
  running: string,
): string | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`No update request at ${file}`)
  }
  rmSync(file, { force: true })
  let version: string
  try {
    version = asReleaseVersion(
      (JSON.parse(text) as { version?: unknown }).version,
    )
  } catch (error) {
    throw new Error(
      `The update request is not a release version: ${(error as Error).message}`,
    )
  }
  if (version === running) return undefined
  if (compareRelease(version, running) < 0)
    throw new Error(
      `The update request asks for ${version}, older than the running ${running}; Mason does not go back by request`,
    )
  return version
}

/** Whether `--install` set up this role's updater on this machine. */
export function hasUpdater(
  role: string,
  exists: (file: string) => boolean = existsSync,
): boolean {
  return exists(`/etc/systemd/system/${updaterUnit(role)}.path`)
}

/**
 * The node's answer to the master's `node.update`: the request written for
 * the updater, or why this node cannot update itself.
 */
export function requestUpdate(
  data: string,
  role: string,
  value: unknown,
  options: { now?: () => number; exists?: (file: string) => boolean } = {},
): { requested: string } {
  const version = asReleaseVersion(value)
  if (!hasUpdater(role, options.exists))
    throw new Error(
      'This node updates only by hand: it was installed before updates over the link. Run sudo mason update on it once, or recreate it',
    )
  writePrivate(
    path.join(data, UPDATE_REQUEST),
    JSON.stringify({ version, at: (options.now ?? Date.now)() }) + '\n',
  )
  return { requested: version }
}
