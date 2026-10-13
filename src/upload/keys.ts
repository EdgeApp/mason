import { asArray, asObject, asString } from 'cleaners'
import { randomBytes } from 'node:crypto'
import { sameSecret } from '../auth/accounts.js'
import { Store, digest } from '../store.js'
import {
  asFlag,
  asId,
  asOrigin,
  integer,
  object,
  oneOf,
  text,
  type Cleaner,
} from '../validation.js'

export const roles = ['upload', 'admin'] as const
export type Role = (typeof roles)[number]
export const asKeyId: Cleaner<string> = (value) => {
  const id = asString(value)
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid API key ID')
  return id
}
export const asApiToken: Cleaner<string> = (value) => {
  const token = asString(value)
  if (!/^mason_v1_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error('Invalid API token')
  return token
}
export const asScopes: Cleaner<'all' | number[]> = (value) => {
  if (value === 'all') return value
  const apps = asArray(asId)(value)
  if (
    apps.length === 0 ||
    apps.length > 1000 ||
    new Set(apps).size !== apps.length
  )
    throw new Error('Invalid app scopes')
  return apps
}
const asKey = asObject({
  id: asKeyId,
  hash: text(64),
  name: text(120),
  apps: asString,
  created_at: integer(),
  expires_at: (value: unknown): number | undefined =>
    value === null ? undefined : integer()(value),
  revoked: asFlag,
  role: oneOf(roles),
})
const asCredentialFields = object({
  schemaVersion: (value: unknown): number => {
    if (value !== 1) throw new Error('Unsupported credential version')
    return 1
  },
  origin: asOrigin,
  id: asKeyId,
  name: text(120),
  token: asApiToken,
  expiresAt: (value: unknown): number | null =>
    value === null ? null : integer()(value),
})
export function asCredentials(
  value: unknown,
): ReturnType<typeof asCredentialFields> {
  const out = asCredentialFields(value)
  if (out.id !== out.token.slice(9, 41))
    throw new Error('Credential ID does not match token')
  return out
}
export type Credentials = ReturnType<typeof asCredentials>
export interface Key {
  id: string
  name: string
  apps: 'all' | number[]
  createdAt: number
  expiresAt?: number
  revoked: boolean
  role: Role
}
function publicKey(key: ReturnType<typeof asKey>): Key {
  return {
    id: key.id,
    name: key.name,
    apps: asScopes(JSON.parse(key.apps)),
    createdAt: key.created_at,
    expiresAt: key.expires_at,
    revoked: key.revoked === 1,
    role: key.role,
  }
}
export class ApiKeys {
  constructor(readonly store: Store) {}
  /** Admin keys manage apps, channels and upload keys; they cannot upload. */
  create(
    name: string,
    scopes: unknown,
    expiresAt?: number,
    role: Role = 'upload',
  ): Credentials {
    name = text(120)(name)
    role = oneOf(roles)(role)
    const apps = role === 'admin' ? 'all' : asScopes(scopes)
    if (expiresAt != null) integer(this.store.now() + 1)(expiresAt)
    const known = new Set(this.store.apps().map((app) => app.id))
    if (apps !== 'all' && apps.some((app) => !known.has(app)))
      throw new Error('Unknown app scope')
    const id = randomBytes(16).toString('hex'),
      token = `mason_v1_${id}.${randomBytes(32).toString('base64url')}`
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'INSERT INTO api_keys(id,hash,name,apps,created_at,expires_at,role) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          id,
          digest(token),
          name,
          JSON.stringify(apps),
          this.store.now(),
          expiresAt ?? null,
          role,
        )
      this.store.db
        .prepare('INSERT INTO audit(action,target,at) VALUES(?,?,?)')
        .run(
          role === 'admin' ? 'key.create.admin' : 'key.create',
          id,
          this.store.now(),
        )
    })
    return {
      schemaVersion: 1,
      origin: this.store.config.origin,
      id,
      name,
      token,
      expiresAt: expiresAt ?? null,
    }
  }
  list(): Key[] {
    return this.store.db
      .prepare(
        'SELECT * FROM api_keys ORDER BY created_at DESC,id LIMIT 1000',
      )
      .all()
      .map((row) => publicKey(asKey(row)))
  }
  authenticate(value: unknown, appId: number): Key {
    appId = asId(appId)
    const key = this.verify(value, 'upload')
    if (key.apps !== 'all' && !key.apps.includes(appId))
      throw new Error('API key does not permit this app')
    return key
  }
  authenticateAdmin(value: unknown): Key {
    return this.verify(value, 'admin')
  }
  private verify(value: unknown, role: Role): Key {
    const token = asApiToken(value),
      id = token.slice(9, 41)
    const row = this.store.db
      .prepare('SELECT * FROM api_keys WHERE id=?')
      .get(id)
    // Both known and unknown IDs perform a fixed-size comparison.
    const key = row == null ? undefined : asKey(row)
    const matches = sameSecret(digest(token), key?.hash ?? '0'.repeat(64))
    if (
      key == null ||
      !matches ||
      key.revoked ||
      key.role !== role ||
      (key.expires_at != null && key.expires_at <= this.store.now())
    )
      throw new Error('Invalid API key')
    return publicKey(key)
  }
  revoke(id: string): void {
    id = asKeyId(id)
    this.store.transaction(() => {
      asKey(
        this.store.db.prepare('SELECT * FROM api_keys WHERE id=?').get(id),
      )
      this.store.db
        .prepare('UPDATE api_keys SET revoked=1 WHERE id=?')
        .run(id)
      this.store.db
        .prepare('INSERT INTO audit(action,target,at) VALUES(?,?,?)')
        .run('key.revoke', id, this.store.now())
    })
  }
}
