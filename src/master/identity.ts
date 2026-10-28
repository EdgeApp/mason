import { createPublicKey } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writePrivate } from '../node/dataDir.js'
import { fingerprint, type Identity } from '../node/identity.js'

/**
 * The master's identity travels with its database. A node remembers its
 * master's public key when it pairs and accepts only that master, so a master
 * restored from a backup must come back with the same key: the identity and
 * the link certificate are kept in `meta` (and so in every backup), and a
 * restore writes them into the data directory before the master starts.
 */

const KEY = 'master_identity'

interface StoredIdentity {
  fingerprint: string
  privateKey: string
  publicKey: string
  cert: string
  key: string
}

/** The data directory's files for each part of the identity. */
const files: Record<Exclude<keyof StoredIdentity, 'fingerprint'>, string> = {
  privateKey: 'identity.key',
  publicKey: 'identity.pub',
  cert: 'tls.crt',
  key: 'tls.key',
}

export class IdentityMismatch extends Error {
  constructor(stored: string, here: string) {
    super(
      `This master's database belongs to master ${stored}, but its data directory holds ${here}. Restore the database with mason setup --restore, which brings its identity with it, or start with the data directory it came from.`,
    )
  }
}

function stored(db: DatabaseSync): StoredIdentity | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(KEY) as
    | { value: string }
    | undefined
  return row == null ? undefined : (JSON.parse(row.value) as StoredIdentity)
}

/**
 * Keeps the master's identity in its database: stored on the first start,
 * checked on every later one. A database holding another master's identity
 * is refused, so two masters never share nodes by a copied file; `replace`
 * (a new key on purpose) stores the new one instead.
 */
export function recordIdentity(
  db: DatabaseSync,
  identity: Identity,
  options: { replace?: boolean } = {},
): void {
  const current = stored(db)
  if (current != null && !options.replace) {
    if (current.fingerprint !== identity.fingerprint)
      throw new IdentityMismatch(current.fingerprint, identity.fingerprint)
    return
  }
  const value: StoredIdentity = {
    fingerprint: identity.fingerprint,
    privateKey: identity.privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string,
    publicKey: identity.publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string,
    cert: identity.cert,
    key: identity.key,
  }
  db.prepare(
    'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(KEY, JSON.stringify(value))
}

/**
 * Writes the identity a master database holds into its data directory,
 * replacing the files there; for a database that was just restored. Returns
 * the restored fingerprint, or undefined when the database holds none (a
 * backup from before identities were kept), leaving the directory alone.
 */
export function restoreIdentity(dir: string): string | undefined {
  const database = path.join(dir, 'master.sqlite')
  if (!existsSync(database)) return undefined
  const db = new DatabaseSync(database, { readOnly: true })
  let identity: StoredIdentity | undefined
  try {
    identity = stored(db)
  } catch {
    // A database without the meta table holds no identity.
    identity = undefined
  } finally {
    db.close()
  }
  if (identity == null) return undefined
  if (fingerprint(createPublicKey(identity.publicKey)) !== identity.fingerprint)
    throw new Error(
      'The restored master identity does not match its fingerprint',
    )
  for (const [part, file] of Object.entries(files))
    writePrivate(path.join(dir, file), identity[part as keyof typeof files])
  return identity.fingerprint
}
