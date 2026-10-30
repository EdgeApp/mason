import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { lockDataDir, prepareDataDir } from '../node/dataDir.js'
import { claimRole } from '../node/serve.js'
import { HostCache } from './cache.js'

export interface HostImportSummary {
  sessions: number
  identities: number
  files: number
}

/** Copies one directory's files into another, hard-linking when they share a volume. */
function copyFiles(from: string, to: string): number {
  if (!existsSync(from)) return 0
  mkdirSync(to, { recursive: true, mode: 0o700 })
  let count = 0
  for (const name of readdirSync(from)) {
    const source = path.join(from, name)
    if (!statSync(source).isFile()) continue
    const target = path.join(to, name)
    if (existsSync(target)) continue
    try {
      linkSync(source, target)
    } catch {
      copyFileSync(source, target)
    }
    count++
  }
  return count
}

/**
 * `mason host import --data <dir> --distribution <db> [--storage <dir>]`:
 * moves a standalone server's sessions and identities into the host's local
 * tables so people stay signed in, and with `--storage` its build files into
 * the host's storage. It holds the data directory's lock, so it refuses
 * while the host runs.
 */
export function importHost(
  data: string,
  files: { distribution: string; storage?: string },
): HostImportSummary {
  const dir = prepareDataDir(data)
  const lock = lockDataDir(dir)
  try {
    claimRole(dir, 'host')
    const legacy = new DatabaseSync(files.distribution, { readOnly: true })
    const cache = new HostCache(dir)
    try {
      const version = (
        legacy.prepare('PRAGMA user_version').get() as { user_version: number }
      ).user_version
      if (version !== 7 && version !== 8)
        throw new Error(
          `The distribution database is at schema ${version}; migrate it to 8 first`,
        )
      // Sessions belong to accounts the master's sync brings; the rows wait for them.
      cache.db.exec('PRAGMA foreign_keys=OFF')
      const summary = cache.store.transaction(() => {
        const copy = (table: string, columns: string[]): number => {
          let count = 0
          const insert = cache.db.prepare(
            `INSERT OR IGNORE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          )
          for (const row of legacy
            .prepare(`SELECT ${columns.join(',')} FROM ${table}`)
            .all())
            count += Number(
              insert.run(
                ...columns.map(
                  (column) => row[column] as string | number | null,
                ),
              ).changes,
            )
          return count
        }
        return {
          identities: copy('identities', [
            'id',
            'account_id',
            'provider',
            'issuer',
            'subject',
            'email',
            'email_verified',
          ]),
          sessions: copy('sessions', [
            'hash',
            'account_id',
            'permission_version',
            'csrf',
            'created_at',
            'expires_at',
          ]),
          files: 0,
        }
      })
      cache.db.exec('PRAGMA foreign_keys=ON')
      if (files.storage != null)
        summary.files = copyFiles(
          path.join(files.storage, 'files'),
          path.join(dir, 'storage', 'files'),
        )
      return summary
    } finally {
      cache.close()
      legacy.close()
    }
  } finally {
    lock.release()
  }
}
