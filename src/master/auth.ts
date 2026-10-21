import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { asObject } from 'cleaners'
import type { Request } from 'express'
import {
  asClientHash,
  rejectRawPassword,
  type ArgonParameters,
} from '../auth/passwordProtocol.js'
import { asUsername } from '../setup/setup.js'
import type { MasterDatabase } from './database.js'
import {
  createPasswordRecord,
  decoyParameters,
  passwordMatches,
  readPasswordRecord,
} from './passwords.js'
import { asRole, type Actor, type Role } from './roles.js'

/** The master's session cookie; host sessions use their own. */
export const MASTER_SESSION_COOKIE = '__Host-mason-master'
const SESSION_MS = 14 * 24 * 60 * 60 * 1000
/** Failures within the window before a lock, per account and per address. */
export const LOCKOUT = {
  account: 5,
  address: 10,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
}

const digest = (token: string): string =>
  createHash('sha256').update(token).digest('hex')
const token = (): string => randomBytes(32).toString('base64url')
const same = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** A refused sign-in: wrong credentials, or locked until a time. */
export class SignInRefused extends Error {
  constructor(
    message: string,
    readonly retryAt?: number,
  ) {
    super(message)
  }
}

export interface MasterSession {
  accountId: number
  name: string
  role: Role
  csrf: string
  expiresAt: number
}

const asSignIn = asObject({ username: asUsername, clientHash: asClientHash })

/**
 * Master sign-in with a client-hash protocol: the browser sends
 * an Argon2id hash of the password, never the password. Unknown usernames
 * get stable decoy parameters, and repeated failures lock the account and
 * the address for a while; a locked attempt is refused without a check.
 */
export class MasterAuth {
  private decoy: Promise<string> | undefined
  constructor(private readonly master: MasterDatabase) {}
  private get db(): MasterDatabase['db'] {
    return this.master.db
  }

  /** The secret the decoy parameters derive from, made once. */
  private decoySecret(): string {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key='decoy_secret'")
      .get() as { value: string } | undefined
    if (row != null) return row.value
    const secret = randomBytes(32).toString('hex')
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES('decoy_secret',?) ON CONFLICT(key) DO NOTHING",
      )
      .run(secret)
    return this.decoySecret()
  }

  /** The client parameters to hash a username's password with. */
  parameters(value: unknown): ArgonParameters {
    const username = asUsername(value)
    const row = this.account(username)
    const record = readPasswordRecord(row?.password as string | undefined)
    return (
      record?.client ??
      decoyParameters(username.toLowerCase(), this.decoySecret())
    )
  }

  private account(username: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        'SELECT * FROM accounts WHERE username=? COLLATE NOCASE AND removed_at IS NULL',
      )
      .get(username)
  }

  /** When a key is locked until, or undefined. */
  private locked(key: string): number | undefined {
    const row = this.db
      .prepare('SELECT locked_until FROM sign_in_failures WHERE key=?')
      .get(key) as { locked_until: number } | undefined
    return row != null && row.locked_until > this.master.now()
      ? row.locked_until
      : undefined
  }

  private fail(key: string, limit: number): void {
    const now = this.master.now()
    const row = this.db
      .prepare('SELECT failures,first_at FROM sign_in_failures WHERE key=?')
      .get(key) as { failures: number; first_at: number } | undefined
    const fresh = row == null || row.first_at <= now - LOCKOUT.windowMs
    const failures = fresh ? 1 : row.failures + 1
    this.db
      .prepare(
        'INSERT INTO sign_in_failures(key,failures,first_at,locked_until) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,first_at=excluded.first_at,locked_until=excluded.locked_until',
      )
      .run(
        key,
        failures,
        fresh ? now : row.first_at,
        failures >= limit ? now + LOCKOUT.lockMs : 0,
      )
  }

  /** Signs a local account in; the session token goes in the cookie. */
  async signIn(
    value: unknown,
    address: string,
  ): Promise<{ token: string; session: MasterSession }> {
    rejectRawPassword(value)
    const input = asSignIn(value)
    const row = this.account(input.username)
    const accountKey = `account:${row?.id ?? `?${input.username.toLowerCase()}`}`
    const addressKey = `address:${address}`
    const until = Math.max(
      this.locked(accountKey) ?? 0,
      this.locked(addressKey) ?? 0,
    )
    if (until > 0)
      throw new SignInRefused(
        'Too many failed sign-ins; try again later',
        until,
      )
    // An unknown username costs the same server hash as a known one.
    const stored =
      row?.password == null
        ? await (this.decoy ??= createPasswordRecord(
            randomBytes(32).toString('hex'),
            decoyParameters(input.username.toLowerCase(), this.decoySecret()),
          ))
        : String(row.password)
    const matches =
      (await passwordMatches(input.clientHash, stored, accountKey)) &&
      row?.password != null &&
      Number(row.disabled) === 0
    if (!matches) {
      this.master.transaction(() => {
        this.fail(accountKey, LOCKOUT.account)
        this.fail(addressKey, LOCKOUT.address)
      })
      throw new SignInRefused('The username or password is wrong')
    }
    const id = Number(row!.id)
    return this.master.transaction(() => {
      this.db
        .prepare('DELETE FROM sign_in_failures WHERE key=?')
        .run(accountKey)
      return this.start(id, address)
    })
  }

  /** Starts a session for an account. */
  start(
    id: number,
    address: string,
  ): { token: string; session: MasterSession } {
    const row = this.db
      .prepare('SELECT name,role,permission_version FROM accounts WHERE id=?')
      .get(id) as { name: string; role: string; permission_version: number }
    const secret = token()
    const csrf = token()
    const expiresAt = this.master.now() + SESSION_MS
    this.db
      .prepare(
        'INSERT INTO master_sessions(hash,account_id,permission_version,csrf,address,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        digest(secret),
        id,
        row.permission_version,
        csrf,
        address,
        this.master.now(),
        expiresAt,
      )
    this.master.audit(
      { role: asRole(row.role), accountId: id, label: `account:${id}` },
      'session.start',
      String(id),
    )
    return {
      token: secret,
      session: {
        accountId: id,
        name: row.name,
        role: asRole(row.role),
        csrf,
        expiresAt,
      },
    }
  }

  /** The live session a token names: unexpired, enabled, and at the account's permission version. */
  session(secret: string | undefined): MasterSession | undefined {
    if (secret == null || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return undefined
    const row = this.db
      .prepare(
        'SELECT s.*,a.name,a.role,a.disabled,a.removed_at,a.permission_version current FROM master_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.hash=?',
      )
      .get(digest(secret)) as Record<string, unknown> | undefined
    if (row == null) return undefined
    if (
      Number(row.expires_at) <= this.master.now() ||
      Number(row.disabled) !== 0 ||
      row.removed_at != null ||
      Number(row.current) !== Number(row.permission_version)
    ) {
      this.db
        .prepare('DELETE FROM master_sessions WHERE hash=?')
        .run(digest(secret))
      return undefined
    }
    return {
      accountId: Number(row.account_id),
      name: String(row.name),
      role: asRole(row.role),
      csrf: String(row.csrf),
      expiresAt: Number(row.expires_at),
    }
  }

  signOut(secret: string | undefined): void {
    if (secret == null) return
    this.db
      .prepare('DELETE FROM master_sessions WHERE hash=?')
      .run(digest(secret))
  }

  /** Sessions past their expiry. */
  prune(): void {
    this.db
      .prepare('DELETE FROM master_sessions WHERE expires_at<=?')
      .run(this.master.now())
    this.db
      .prepare(
        'DELETE FROM sign_in_failures WHERE first_at<=? AND locked_until<=?',
      )
      .run(this.master.now() - LOCKOUT.windowMs, this.master.now())
  }
}

/** The actor a master session acts as. */
export function sessionActor(session: MasterSession): Actor {
  return {
    role: session.role,
    accountId: session.accountId,
    label: `account:${session.accountId}`,
  }
}

/**
 * A state-changing request from a session must come from the master's own
 * pages: the Origin matches the Host it was sent to, and it carries the
 * session's CSRF proof in `X-Mason-CSRF` or a `csrf` form field.
 */
export function checkCsrf(req: Request, session: MasterSession): void {
  const origin = req.get('origin')
  const host = req.get('host')
  let sameOrigin = false
  try {
    sameOrigin = origin != null && host != null && new URL(origin).host === host
  } catch {
    sameOrigin = false
  }
  // A no-referrer page sends `Origin: null` for its own form posts.
  if (
    !sameOrigin &&
    !(origin === 'null' && req.get('sec-fetch-site') === 'same-origin')
  )
    throw new SignInRefused('Untrusted origin')
  const proof =
    req.get('x-mason-csrf') ??
    (req.body as { csrf?: unknown } | undefined)?.csrf
  if (typeof proof !== 'string' || !same(proof, session.csrf))
    throw new SignInRefused('Invalid request proof')
}

/**
 * The first-run setup code. After a wrong code no guess from anyone is
 * checked for 5 s, then 10, 20, 40 … s; a guess during the wait is refused
 * unchecked. A restart makes a new code and a new gate.
 */
export class SetupGate {
  private failures = 0
  private nextAt = 0
  constructor(
    private readonly code: () => string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** When the next guess is checked; 0 when one would be checked now. */
  waitUntil(): number {
    return this.nextAt > this.now() ? this.nextAt : 0
  }

  /** Checks a guess, refusing it unchecked while the wait runs. */
  check(guess: unknown): void {
    const wait = this.waitUntil()
    if (wait > 0)
      throw new SignInRefused('Wait before the next setup code guess', wait)
    const code = this.code()
    if (
      code == null ||
      typeof guess !== 'string' ||
      !/^[0-9]{6}$/.test(guess) ||
      !same(guess, code)
    ) {
      this.failures++
      this.nextAt = this.now() + 5000 * 2 ** (this.failures - 1)
      throw new SignInRefused('That is not the setup code', this.nextAt)
    }
  }
}
