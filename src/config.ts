import { asProviders } from './auth/providerConfig.js'
import { asOptional } from 'cleaners'
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { asOrigin, integer, object, text } from './validation.js'

export const asConfig = object({
  providers: asOptional(asProviders, []),
  sessionDays: asOptional(integer(1, 90), 30),
  origin: asOrigin,
  database: text(4096),
  storage: text(4096),
  listenHost: asOptional(text(256), '127.0.0.1'),
  port: asOptional(integer(1, 65535), 9200),
  retentionDays: asOptional(integer(1, 365), 14),
  capacityBytes: asOptional(integer(1), 20 * 1024 ** 3),
  freeSpaceBytes: asOptional(integer(), 10 * 1024 ** 3),
  packageBytes: asOptional(integer(1), 2 * 1024 ** 3),
})
export type Config = ReturnType<typeof asConfig>
export function readPrivateJson(file: string): unknown {
  const actual = realpathSync(file)
  const stat = statSync(actual)
  if (
    !stat.isFile() ||
    (stat.mode & 0o777) !== 0o600 ||
    (process.getuid != null && stat.uid !== process.getuid())
  )
    throw new Error('Configuration must be an owner-only regular file')
  if (stat.size > 1024 * 1024) throw new Error('Configuration is too large')
  try {
    return JSON.parse(readFileSync(actual, 'utf8'))
  } catch {
    throw new Error('Invalid configuration JSON')
  }
}
export function loadConfig(file: string): Config {
  const base = path.dirname(realpathSync(file))
  let config: Config
  try {
    config = asConfig(readPrivateJson(file))
  } catch {
    throw new Error('Invalid or insecure Mason configuration')
  }
  return {
    ...config,
    database: path.resolve(base, config.database),
    storage: path.resolve(base, config.storage),
  }
}
/** Existing path components must never resolve through a symlink. */
export function noSymlinks(file: string): void {
  let current = path.resolve(file)
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error('Symlink paths are not allowed')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

/** Dedicated state directories must not be readable or replaceable by other users. */
export function privateDirectory(directory: string): void {
  const target = path.resolve(directory)
  const uid = process.getuid?.()
  const check = (): void => {
    let current = target
    while (true) {
      try {
        const stat = lstatSync(current)
        const trustedOwner =
          uid == null || stat.uid === uid || stat.uid === 0
        const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0
        if (
          !stat.isDirectory() ||
          !trustedOwner ||
          ((stat.mode & 0o022) !== 0 && !stickyRoot) ||
          (current === target &&
            ((stat.mode & 0o777) !== 0o700 ||
              (uid != null && stat.uid !== uid)))
        )
          throw new Error(
            'State directories require private ownership and safe ancestors',
          )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  check()
  mkdirSync(target, { recursive: true, mode: 0o700 })
  check()
}
