import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { noSymlinks, privateDirectory } from '../config.js'

/** The node's data directory: `--data`, or `~/.mason`. */
export function resolveDataDir(flag?: string, home = homedir()): string {
  return path.resolve(flag ?? path.join(home, '.mason'))
}

/**
 * Creates the data directory owner-only on first use and refuses one that
 * other users could read or replace, or that is reached through a symlink.
 */
export function prepareDataDir(dir: string): string {
  dir = path.resolve(dir)
  noSymlinks(dir)
  privateDirectory(dir)
  return dir
}

/** Writes an owner-only file, refusing to follow or replace a symlink. */
export function writePrivate(file: string, data: string | Buffer): void {
  noSymlinks(file)
  if (existsSync(file) && !lstatSync(file).isFile())
    throw new Error('Expected a regular file')
  writeFileSync(file, data, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Reads an owner-only regular file. */
export function readPrivate(file: string): string {
  noSymlinks(file)
  const stat = lstatSync(file)
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid != null && stat.uid !== process.getuid())
  )
    throw new Error(`${path.basename(file)} must be an owner-only file`)
  return readFileSync(file, 'utf8')
}

export class LockHeld extends Error {
  constructor(readonly pid: number | undefined) {
    super(
      pid == null
        ? 'Another Mason process is using this data directory'
        : `Another Mason process (PID ${pid}) is using this data directory`,
    )
  }
}

export interface DataDirLock {
  release(): void
}

/**
 * Takes the data directory's exclusive lock. One process, and so one
 * identity, owns a data directory at a time; the holder's PID is recorded
 * for the refusal message.
 */
export function lockDataDir(dir: string): DataDirLock {
  const file = path.join(dir, 'lock')
  const pidFile = path.join(dir, 'lock.pid')
  noSymlinks(file)
  const db = new DatabaseSync(file, { timeout: 0 })
  chmodSync(file, 0o600)
  try {
    db.exec('PRAGMA journal_mode=OFF; PRAGMA locking_mode=EXCLUSIVE')
    db.exec('CREATE TABLE IF NOT EXISTS mutex(value INTEGER)')
    db.exec('BEGIN EXCLUSIVE')
  } catch {
    db.close()
    let pid: number | undefined
    try {
      const value = Number(readPrivate(pidFile).trim())
      if (Number.isSafeInteger(value) && value > 0) pid = value
    } catch {
      pid = undefined
    }
    throw new LockHeld(pid)
  }
  writePrivate(pidFile, String(process.pid))
  let released = false
  return {
    release(): void {
      if (released) return
      released = true
      rmSync(pidFile, { force: true })
      db.close()
    },
  }
}

/** Whether a process currently holds the data directory's lock. */
export function lockHolder(dir: string): { held: boolean; pid?: number } {
  try {
    lockDataDir(dir).release()
    return { held: false }
  } catch (error) {
    if (error instanceof LockHeld)
      return error.pid == null ? { held: true } : { held: true, pid: error.pid }
    throw error
  }
}
