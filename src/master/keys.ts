import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { asArray, asObject, asOptional, asString } from 'cleaners'
import { integer, text } from '../validation.js'
import { allow, allowRole, scoped } from './permissions.js'
import type { MasterDatabase } from './database.js'
import {
  asKeyRole,
  atLeast,
  Forbidden,
  rank,
  type Actor,
  type KeyRole,
} from './roles.js'

const digest = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export interface MasterKey {
  id: string
  name: string
  role: KeyRole
  /** App IDs an upload key may publish to, or all. */
  apps: 'all' | number[]
  projects: string[]
  branches: string[]
  createdAt: number
  expiresAt?: number
  revoked: boolean
  /** `builder` keys are imported 64-hex builder tokens. */
  format: 'v1' | 'builder'
}

const asRow = asObject({
  id: asString,
  hash: asString,
  name: asString,
  apps: asString,
  created_at: integer(),
  expires_at: (value: unknown): number | undefined =>
    value === null ? undefined : integer()(value),
  revoked: integer(0, 1),
  role: asString,
  projects: asString,
  branches: asString,
  format: asString,
})
function publicKey(row: ReturnType<typeof asRow>): MasterKey {
  const apps = JSON.parse(row.apps) as unknown
  return {
    id: row.id,
    name: row.name,
    role: asKeyRole(row.role),
    apps: apps === 'all' ? 'all' : asArray(integer(1))(apps),
    projects: asArray(asString)(JSON.parse(row.projects)),
    branches: asArray(asString)(JSON.parse(row.branches)),
    createdAt: row.created_at,
    ...(row.expires_at == null ? {} : { expiresAt: row.expires_at }),
    revoked: row.revoked === 1,
    format: row.format === 'builder' ? 'builder' : 'v1',
  }
}

export const asKeyRequest = asObject({
  name: asOptional(text(120)),
  role: asKeyRole,
  projects: asOptional(asArray(text(160)), []),
  branches: asOptional(asArray(text(200)), []),
  apps: asOptional(asArray(integer(1)), []),
  expiresAt: asOptional(integer()),
})

/** API keys: one table for every role, distribution and builder keys alike. */
export class MasterKeys {
  constructor(readonly master: MasterDatabase) {}
  private get db(): MasterDatabase['db'] {
    return this.master.db
  }

  /** Creates a key no higher than the creator's role; the token is shown once. */
  create(actor: Actor, value: unknown): MasterKey & { token: string } {
    allowRole(actor, 'keys.create')
    const request = asKeyRequest(value)
    if (request.role !== 'upload' && rank(request.role) > rank(actor.role))
      throw new Forbidden('A key cannot have a higher role than its creator')
    // A scoped key makes keys only within its own projects and branches.
    if (scoped(actor)) {
      const scopes = actor.scopes!
      const within = (mine: string[], theirs: string[]): boolean =>
        mine.length === 0 ||
        (theirs.length !== 0 && theirs.every((entry) => mine.includes(entry)))
      if (
        !within(scopes.projects, request.projects) ||
        !within(scopes.branches, request.branches)
      )
        throw new Forbidden('A key cannot have wider scopes than its creator')
    }
    if (request.role === 'upload' && request.apps.length === 0)
      throw new Error('An upload key names the apps it may publish')
    if (request.role !== 'upload' && request.apps.length !== 0)
      throw new Error('Only upload keys are scoped to apps')
    if (request.expiresAt != null && request.expiresAt <= this.master.now())
      throw new Error('Expiry is in the past')
    const known = new Set(
      this.db
        .prepare('SELECT id FROM apps')
        .all()
        .map((row) => Number(row.id)),
    )
    if (request.apps.some((app) => !known.has(app)))
      throw new Error('Unknown app scope')
    const id = randomBytes(16).toString('hex')
    const token = `mason_v1_${id}.${randomBytes(32).toString('base64url')}`
    const name = request.name ?? `${request.role} key ${id.slice(0, 8)}`
    this.master.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO api_keys(id,hash,name,apps,created_at,expires_at,role,projects,branches,format,creator) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          digest(token),
          name,
          JSON.stringify(request.role === 'upload' ? request.apps : 'all'),
          this.master.now(),
          request.expiresAt ?? null,
          request.role,
          JSON.stringify(request.projects),
          JSON.stringify(request.branches),
          'v1',
          actor.accountId ?? null,
        )
      this.master.audit(actor, 'key.create', id)
      this.master.change('api_key', id)
    })
    return { ...this.get(id)!, token }
  }

  get(id: string): MasterKey | undefined {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE id=?').get(id)
    return row == null ? undefined : publicKey(asRow(row))
  }
  list(): MasterKey[] {
    return this.db
      .prepare('SELECT * FROM api_keys ORDER BY created_at DESC, id LIMIT 1000')
      .all()
      .map((row) => publicKey(asRow(row)))
  }

  revoke(actor: Actor, id: string): void {
    allow(actor, 'keys.revoke')
    this.master.transaction(() => {
      const key = this.get(text(64)(id))
      if (key == null) throw new Error('No such key')
      if (key.role !== 'upload' && rank(key.role) > rank(actor.role))
        throw new Forbidden(
          'A key with a higher role can only be revoked by that role',
        )
      this.db.prepare('UPDATE api_keys SET revoked=1 WHERE id=?').run(id)
      this.master.audit(actor, 'key.revoke', id)
      this.master.change('api_key', id)
    })
  }

  /**
   * The key a bearer token belongs to: `mason_v1_<id>.<secret>`, or an
   * imported 64-hex builder token. Revoked and expired keys are refused.
   */
  authenticate(token: unknown): MasterKey | undefined {
    if (typeof token !== 'string') return undefined
    let row: unknown
    if (/^mason_v1_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(token))
      row = this.db
        .prepare("SELECT * FROM api_keys WHERE id=? AND format='v1'")
        .get(token.slice(9, 41))
    else if (/^[a-f0-9]{64}$/.test(token))
      row = this.db
        .prepare("SELECT * FROM api_keys WHERE hash=? AND format='builder'")
        .get(digest(token))
    else return undefined
    const stored = row == null ? undefined : asRow(row)
    // A fixed-size comparison runs for known and unknown keys alike.
    const matches = timingSafeEqual(
      Buffer.from(digest(token), 'hex'),
      Buffer.from(stored?.hash ?? '0'.repeat(64), 'hex'),
    )
    if (stored == null || !matches) return undefined
    const key = publicKey(stored)
    if (
      key.revoked ||
      (key.expiresAt != null && key.expiresAt <= this.master.now())
    )
      return undefined
    return key
  }

  /**
   * The actor an authenticated key acts as: no higher than its creator's
   * current role, and nothing once the creator is disabled or removed.
   * Keys with no creator (the local operator's, imported ones) act as their
   * own role.
   */
  actor(key: MasterKey): Actor {
    if (key.role === 'upload')
      throw new Forbidden('Upload keys only publish through the upload API')
    let role = key.role
    const creator = this.db
      .prepare(
        'SELECT a.role,a.disabled,a.removed_at FROM api_keys k JOIN accounts a ON a.id=k.creator WHERE k.id=?',
      )
      .get(key.id) as
      | { role: string; disabled: number; removed_at: number | null }
      | undefined
    if (creator != null) {
      if (Number(creator.disabled) !== 0 || creator.removed_at != null)
        throw new Forbidden('The key’s owner is disabled')
      const owner = asKeyRole(creator.role)
      if (owner !== 'upload' && rank(owner) < rank(role)) role = owner
    }
    return {
      role,
      keyId: key.id,
      label: `key:${key.id}`,
      scopes: { projects: key.projects, branches: key.branches },
    }
  }
}
export { atLeast }
