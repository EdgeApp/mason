import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { asArray, asObject, asOptional, asString } from 'cleaners'
import { integer, text } from '../validation.js'
import { allow, allowRole, scoped } from './permissions.js'
import type { MasterDatabase } from './database.js'
import {
  asRole,
  atLeast,
  Forbidden,
  rank,
  type Actor,
  type Role,
} from './roles.js'

export const keyDigest = (token: string): string =>
  createHash('sha256').update(token).digest('hex')
const digest = keyDigest

/**
 * Where a bearer token's key is found: a `mason_v1_<id>.<secret>` token by
 * its id, an imported 64-hex builder token by its digest, anything else
 * nowhere. Its digest is what the stored hash must equal.
 */
export function tokenLookup(
  token: unknown,
):
  | { by: 'id'; id: string; digest: string }
  | { by: 'hash'; digest: string }
  | undefined {
  if (typeof token !== 'string') return undefined
  if (/^mason_v1_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(token))
    return { by: 'id', id: token.slice(9, 41), digest: digest(token) }
  if (/^[a-f0-9]{64}$/.test(token)) return { by: 'hash', digest: digest(token) }
  return undefined
}

/**
 * A key's role, no higher than its creator's current role. A key with no
 * creator (the local operator's, an imported one, one a key made) keeps its
 * role; one whose creator is disabled, removed or unknown is refused. The
 * master and the host decide keys with this one rule.
 */
export function creatorLimitedRole(
  role: Role,
  creator: number | null | undefined,
  owner: { role: string; disabled: unknown; removed_at?: unknown } | undefined,
): Role {
  if (creator == null) return role
  if (owner == null || Number(owner.disabled) !== 0 || owner.removed_at != null)
    throw new Forbidden('The key’s owner is disabled')
  const limit = asRole(owner.role)
  return rank(limit) < rank(role) ? limit : role
}

/** Whether a token's digest is the stored one, in fixed time for known and unknown keys alike. */
export function digestMatches(
  given: string,
  stored: string | undefined,
): boolean {
  const known = stored != null && /^[a-f0-9]{64}$/.test(stored)
  return (
    timingSafeEqual(
      Buffer.from(given, 'hex'),
      Buffer.from(known ? stored : '0'.repeat(64), 'hex'),
    ) && known
  )
}

export interface MasterKey {
  id: string
  name: string
  role: Role
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
  return {
    id: row.id,
    name: row.name,
    role: asRole(row.role),
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
  role: asRole,
  projects: asOptional(asArray(text(160)), []),
  branches: asOptional(asArray(text(200)), []),
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
    if (rank(request.role) > rank(actor.role))
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
    if (request.expiresAt != null && request.expiresAt <= this.master.now())
      throw new Error('Expiry is in the past')
    const id = randomBytes(16).toString('hex')
    const token = `mason_v1_${id}.${randomBytes(32).toString('base64url')}`
    const name = request.name ?? `${request.role} key ${id.slice(0, 8)}`
    this.master.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO api_keys(id,hash,name,apps,created_at,expires_at,role,projects,branches,format,creator,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          digest(token),
          name,
          JSON.stringify('all'),
          this.master.now(),
          request.expiresAt ?? null,
          request.role,
          JSON.stringify(request.projects),
          JSON.stringify(request.branches),
          'v1',
          actor.accountId ?? null,
          actor.label,
        )
      this.master.audit(actor, 'key.create', id)
      this.master.change('key', id)
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
      if (rank(key.role) > rank(actor.role))
        throw new Forbidden(
          'A key with a higher role can only be revoked by that role',
        )
      this.db.prepare('UPDATE api_keys SET revoked=1 WHERE id=?').run(id)
      this.master.audit(actor, 'key.revoke', id)
      this.master.change('key', id)
    })
  }

  /**
   * The key a bearer token belongs to: `mason_v1_<id>.<secret>`, or an
   * imported 64-hex builder token. Revoked and expired keys are refused.
   */
  authenticate(token: unknown): MasterKey | undefined {
    const lookup = tokenLookup(token)
    if (lookup == null) return undefined
    const row =
      lookup.by === 'id'
        ? this.db
            .prepare("SELECT * FROM api_keys WHERE id=? AND format='v1'")
            .get(lookup.id)
        : this.db
            .prepare("SELECT * FROM api_keys WHERE hash=? AND format='builder'")
            .get(lookup.digest)
    const stored = row == null ? undefined : asRow(row)
    // The comparison runs before the missing row is noticed: known and
    // unknown keys take the same time.
    const matches = digestMatches(lookup.digest, stored?.hash)
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
    const row = this.db
      .prepare(
        'SELECT k.creator,a.role,a.disabled,a.removed_at FROM api_keys k LEFT JOIN accounts a ON a.id=k.creator WHERE k.id=?',
      )
      .get(key.id) as
      | {
          creator: number | null
          role: string | null
          disabled: number | null
          removed_at: number | null
        }
      | undefined
    const role = creatorLimitedRole(
      key.role,
      row?.creator,
      row?.role == null
        ? undefined
        : {
            role: row.role,
            disabled: row.disabled,
            removed_at: row.removed_at,
          },
    )
    return {
      role,
      keyId: key.id,
      label: `key:${key.id}`,
      scopes: { projects: key.projects, branches: key.branches },
    }
  }
}
export { atLeast }
