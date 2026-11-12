import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { asArray, asObject, asOptional } from 'cleaners'
import { asClientHash, rejectRawPassword } from '../auth/passwordProtocol.js'
import { asUsername } from '../setup/setup.js'
import { integer, text } from '../validation.js'
import { Conflict, NotFound } from './api.js'
import type { MasterDatabase } from './database.js'
import { createPasswordRecord } from './passwords.js'
import { allow, can } from './permissions.js'
import { asRole, type Actor, type Role } from './roles.js'

/** A person on the master, as the people API shows them. */
export interface Person {
  id: number
  name: string
  username?: string
  role: Role
  disabled: boolean
  /** Whether the account can sign in to the master with a password. */
  password: boolean
  /**
   * The person's email addresses, in order. Any sign-in method that verifies
   * a confirmed one signs them in; the method is not part of the address.
   */
  emails: PersonEmail[]
  groups: number[]
  permissionVersion: number
  createdAt: number
  /** An unused invitation link: when it expires. The link itself is shown once. */
  invitation?: { expiresAt: number }
}

/** One of a person's email addresses. */
export interface PersonEmail {
  email: string
  /** Whether it signs the person in; one they added themselves waits for an admin. */
  confirmed: boolean
}

/** A group: a named set of app IDs a tester sees, and its members. */
export interface Group {
  id: number
  name: string
  apps: Array<{ id: number; slug: string }>
  members: number[]
  createdAt: number
}

const asMethod = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value))
    throw new Error('A sign-in method is a provider ID such as google')
  return value
}
const asAddress = (value: unknown): string => {
  const address = text(320)(value).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+$/.test(address))
    throw new Error('An address is an email address')
  return address
}
/** What a person may change on their own record, here and through the host. */
export const SELF_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'emails',
  'password',
])
/** The most addresses one person keeps. */
const MAX_EMAILS = 10
/** A list of email addresses, lower-cased and without repeats. */
const asEmails = (value: unknown): string[] => {
  if (!Array.isArray(value))
    throw new Error('emails is a list of email addresses')
  const emails = [...new Set(value.map(asAddress))]
  if (emails.length > MAX_EMAILS)
    throw new Error(`A person has at most ${MAX_EMAILS} email addresses`)
  return emails
}
const asPassword = asObject({
  clientHash: asClientHash,
  clientParameters: (value: unknown): unknown => value,
})
const asPersonInput = asObject({
  name: asOptional(text(120)),
  /** `null` clears it. */
  username: (value: unknown): string | null | undefined =>
    value === null ? null : asOptional(asUsername)(value),
  role: asOptional(asRole),
  disabled: asOptional((value: unknown): boolean => {
    if (typeof value !== 'boolean') throw new Error('disabled is true or false')
    return value
  }),
  emails: asOptional(asEmails),
  confirmEmails: asOptional(asEmails),
  password: asOptional(asPassword),
})
/** Refuses the fields `emails` replaced. */
function refuseOldAddressFields(value: unknown): void {
  const input = value as { email?: unknown; addresses?: unknown } | null
  if (input?.email !== undefined || input?.addresses !== undefined)
    throw new Error(
      'email and addresses are gone: send emails, a list of email addresses',
    )
}

/** How long an invitation link lasts unless the admin chooses: a week. */
export const INVITATION_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000
const tokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex')
/** An invitation token: 32 random bytes, base64url. */
const asToken = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new InvitationRefused()
  return value
}
const asAcceptance = asObject({
  username: asOptional((value: unknown) =>
    value === '' ? undefined : asUsername(value),
  ),
  clientHash: asClientHash,
  clientParameters: (value: unknown): unknown => value,
})

/** An invitation link that is unknown, used, revoked or expired. */
export class InvitationRefused extends Error {
  constructor() {
    super('This invitation link is not valid or has expired')
  }
}

/** A password reaches the master only as a client hash. */
function refuseRawPassword(value: unknown): void {
  const password = (value as { password?: unknown } | null)?.password
  rejectRawPassword(typeof password === 'string' ? { password } : password)
}
const asGroupInput = asObject({
  name: asOptional(text(120)),
  apps: asOptional(asArray(integer(1))),
  members: asOptional(asArray(integer(1))),
})

/**
 * An account's email addresses, in order, from `account_emails`: the
 * master's table and the host's copy have the same columns.
 */
export function accountEmails(
  db: Pick<DatabaseSync, 'prepare'>,
  accountId: number,
): PersonEmail[] {
  return db
    .prepare(
      'SELECT email,confirmed FROM account_emails WHERE account_id=? ORDER BY position,email',
    )
    .all(accountId)
    .map((entry) => ({
      email: String(entry.email),
      confirmed: Number(entry.confirmed) === 1,
    }))
}

/** People and the groups that decide what testers see. */
export class People {
  constructor(readonly master: MasterDatabase) {}
  private get db(): MasterDatabase['db'] {
    return this.master.db
  }

  list(actor: Actor): Person[] {
    allow(actor, 'people.read')
    return this.db
      .prepare('SELECT id FROM accounts WHERE removed_at IS NULL ORDER BY id')
      .all()
      .map((row) => this.person(Number(row.id))!)
  }

  get(actor: Actor, id: number): Person {
    if (actor.accountId !== id) allow(actor, 'people.read')
    const person = this.person(id)
    if (person == null) throw new NotFound('No such person')
    return person
  }

  person(id: number): Person | undefined {
    const row = this.db
      .prepare(
        'SELECT id,name,username,role,disabled,password,permission_version,created_at FROM accounts WHERE id=? AND removed_at IS NULL',
      )
      .get(id)
    if (row == null) return undefined
    const emails = accountEmails(this.db, id)
    return {
      id: Number(row.id),
      name: String(row.name),
      ...(row.username == null ? {} : { username: String(row.username) }),
      role: asRole(row.role),
      disabled: Number(row.disabled) === 1,
      password: row.password != null,
      emails,
      groups: this.db
        .prepare(
          'SELECT group_id FROM group_members WHERE account_id=? ORDER BY group_id',
        )
        .all(id)
        .map((entry) => Number(entry.group_id)),
      permissionVersion: Number(row.permission_version),
      createdAt: Number(row.created_at),
      ...((): Pick<Person, 'invitation'> => {
        const invitation = this.db
          .prepare(
            'SELECT expires_at FROM person_invitations WHERE account_id=? AND expires_at>?',
          )
          .get(id, this.master.now())
        return invitation == null
          ? {}
          : { invitation: { expiresAt: Number(invitation.expires_at) } }
      })(),
    }
  }

  /**
   * The account a flagged sign-in method admits. An enabled account with
   * this confirmed address is returned unchanged. A disabled one is refused.
   */
  admit(method: string, identity: { name: string; email: string }): number {
    const provider = asMethod(method)
    const email = asAddress(identity.email)
    const name = identity.name.trim().slice(0, 120) || email
    try {
      return this.insertAdmitted(email, name, provider)
    } catch (error) {
      // Two sign-ins of a new address can insert together; the second finds the first.
      const message = error instanceof Error ? error.message : ''
      if (!message.includes('UNIQUE constraint failed')) throw error
      return this.insertAdmitted(email, name, provider)
    }
  }

  private insertAdmitted(
    email: string,
    name: string,
    provider: string,
  ): number {
    return this.master.transaction(() => {
      // A verified provider email belongs to whoever signs in with it: an
      // unconfirmed claim on it goes, recorded as that sign-in's doing.
      this.dropClaim(email, { role: 'tester', label: `${provider} sign-in` })
      const existing = this.db
        .prepare(
          'SELECT a.id, a.disabled FROM account_emails x JOIN accounts a ON a.id=x.account_id WHERE x.email=? AND x.confirmed=1 LIMIT 1',
        )
        .get(email) as { id: number; disabled: number } | undefined
      if (existing != null) {
        if (existing.disabled === 1) throw new Error('This account is disabled')
        return existing.id
      }
      const id = Number(
        this.db
          .prepare(
            'INSERT INTO accounts(name,role,is_admin,is_tester,disabled,open_admission,created_at) VALUES(?,?,0,1,0,1,?)',
          )
          .run(name, 'tester', this.master.now()).lastInsertRowid,
      )
      this.db
        .prepare(
          'INSERT INTO account_emails(account_id,email,position,confirmed) VALUES(?,?,0,1)',
        )
        .run(id, email)
      this.master.audit(
        { role: 'tester', label: 'sign-in' },
        'person.admit',
        String(id),
      )
      this.master.change('account', id)
      return id
    })
  }

  /** Adds a person: a name, a role, and their email addresses or a master password. */
  async create(actor: Actor, value: unknown): Promise<Person> {
    allow(actor, 'people.change')
    refuseRawPassword(value)
    refuseOldAddressFields(value)
    const input = asPersonInput(value)
    if (input.name == null && input.username == null)
      throw new Error('A person needs a name or a username')
    const emails = input.emails ?? []
    if (input.username == null && emails.length === 0)
      throw new Error('A person needs a username or an email address')
    const record =
      input.password == null
        ? null
        : await createPasswordRecord(
            input.password.clientHash,
            input.password.clientParameters,
          )
    const id = this.master.transaction(() => {
      this.usernameFree(input.username ?? undefined)
      const role = input.role ?? 'tester'
      const id = Number(
        this.db
          .prepare(
            'INSERT INTO accounts(name,username,password,role,is_admin,is_tester,disabled,created_at) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            input.name ?? input.username!,
            input.username ?? null,
            record,
            role,
            Number(role === 'admin'),
            Number(role === 'tester'),
            Number(input.disabled === true),
            this.master.now(),
          ).lastInsertRowid,
      )
      this.setEmails(id, emails, [], true, [], actor)
      this.master.audit(actor, 'person.create', String(id))
      if (record != null)
        this.master.audit(actor, 'person.password', String(id))
      this.master.change('account', id)
      return id
    })
    return this.person(id)!
  }

  /**
   * Changes a person's name, role, disabled state, addresses or password;
   * each bumps their permission version, which ends their sessions. The
   * last enabled admin cannot be disabled or demoted.
   */
  async update(
    actor: Actor,
    id: number,
    value: unknown,
    /** Forwarded by a host, which the master does not trust to confirm an address. */
    options: { viaHost?: boolean } = {},
  ): Promise<Person> {
    // A person may change their own name, emails and password; everything
    // else, and anyone else, needs people.change. An address added through a
    // host waits for an admin on the master, whoever the host says it is.
    const admin = can(actor, 'people.change') && options.viaHost !== true
    const own =
      actor.accountId === id &&
      Object.keys((value as object | null) ?? {}).every((field) =>
        SELF_FIELDS.has(field),
      )
    if (!own) allow(actor, 'people.change')
    refuseRawPassword(value)
    refuseOldAddressFields(value)
    const input = asPersonInput(value)
    if (input.confirmEmails != null) allow(actor, 'people.change')
    if (this.person(id) == null) throw new NotFound('No such person')
    const record =
      input.password == null
        ? undefined
        : await createPasswordRecord(
            input.password.clientHash,
            input.password.clientParameters,
            `account:${id}`,
          )
    this.master.transaction(() => {
      const before = this.person(id)
      if (before == null) throw new NotFound('No such person')
      const role = input.role ?? before.role
      const disabled = input.disabled ?? before.disabled
      if (before.role === 'admin' && !before.disabled)
        if (role !== 'admin' || disabled) this.keepAnAdmin(id)
      const username =
        input.username === undefined ? before.username : input.username
      if (username != null && username !== before.username)
        this.usernameFree(username, id)
      const emails = this.setEmails(
        id,
        input.emails ?? before.emails.map((entry) => entry.email),
        input.confirmEmails ?? [],
        admin,
        before.emails,
        actor,
      )
      const confirmed = this.person(id)!.emails.filter(
        (entry) => entry.confirmed,
      )
      const naming = input.username !== undefined || input.emails !== undefined
      if (naming && username == null && this.person(id)!.emails.length === 0)
        throw new Error('A person needs a username or an email address')
      // A change to the username or the emails may not leave nothing to sign
      // in with: no username and no confirmed email.
      if (naming && username == null && confirmed.length === 0)
        throw new Error(
          'Keep a confirmed email or a username: a person signs in with one',
        )
      // Sessions end when what the person may do changes, or when someone
      // else takes away a confirmed address, which they may have signed in
      // with; an unconfirmed one never signed anyone in.
      const ends =
        role !== before.role ||
        disabled !== before.disabled ||
        record != null ||
        (actor.accountId !== id &&
          before.emails.some(
            (entry) => entry.confirmed && emails.removed.includes(entry.email),
          ))
      this.db
        .prepare(
          'UPDATE accounts SET name=?,username=?,role=?,is_admin=?,is_tester=?,disabled=?,password=COALESCE(?,password),permission_version=permission_version+? WHERE id=?',
        )
        .run(
          input.name ?? before.name,
          username ?? null,
          role,
          Number(role === 'admin'),
          Number(role === 'tester'),
          Number(disabled),
          record ?? null,
          Number(ends),
          id,
        )
      // A disabled person's invitation link stops working, and so does one
      // a password set another way makes needless: revoked once, and
      // audited when a password ended it.
      const revoked = (disabled || record != null) && this.dropInvitation(id)
      this.master.audit(actor, 'person.update', String(id))
      for (const email of emails.added)
        this.master.audit(actor, 'person.email.add', `${id} ${email}`)
      for (const email of emails.removed)
        this.master.audit(actor, 'person.email.remove', `${id} ${email}`)
      if (record != null) {
        this.master.audit(actor, 'person.password', String(id))
        if (revoked)
          this.master.audit(actor, 'person.invite.revoke', String(id))
      }
      this.master.change('account', id)
    })
    return this.person(id)!
  }

  /**
   * Removes a person: their sign-in addresses, password, groups and keys go
   * and the account is disabled; the row stays for the audit history.
   */
  remove(actor: Actor, id: number): void {
    allow(actor, 'people.change')
    this.master.transaction(() => {
      const before = this.person(id)
      if (before == null) throw new NotFound('No such person')
      if (before.role === 'admin' && !before.disabled) this.keepAnAdmin(id)
      this.db.prepare('DELETE FROM account_emails WHERE account_id=?').run(id)
      this.dropInvitation(id)
      const groups = this.db
        .prepare('SELECT group_id FROM group_members WHERE account_id=?')
        .all(id)
      this.db.prepare('DELETE FROM group_members WHERE account_id=?').run(id)
      this.db
        .prepare(
          'UPDATE accounts SET username=NULL,password=NULL,disabled=1,removed_at=?,permission_version=permission_version+1 WHERE id=?',
        )
        .run(this.master.now(), id)
      const keys = this.db
        .prepare('SELECT id FROM api_keys WHERE creator=? AND revoked=0')
        .all(id)
      this.db
        .prepare('UPDATE api_keys SET revoked=1 WHERE creator=? AND revoked=0')
        .run(id)
      for (const key of keys) this.master.change('key', String(key.id))
      this.master.audit(actor, 'person.remove', String(id))
      this.master.change('account', id)
      for (const group of groups)
        this.master.change('group', Number(group.group_id))
    })
  }

  /**
   * Makes a person's invitation link token, valid for `days` (default 7,
   * at most 30) and replacing any earlier one. Only its hash is kept: the
   * token is answered this once.
   */
  invite(
    actor: Actor,
    id: number,
    value: unknown = {},
  ): { token: string; expiresAt: number } {
    allow(actor, 'people.change')
    const days = asOptional(
      integer(1, 30),
      INVITATION_DAYS,
    )((value as { days?: unknown } | null)?.days)
    return this.master.transaction(() => {
      const person = this.person(id)
      if (person == null) throw new NotFound('No such person')
      if (person.disabled)
        throw new Conflict('A disabled person cannot be invited')
      const token = randomBytes(32).toString('base64url')
      const expiresAt = this.master.now() + days * DAY_MS
      this.db
        .prepare(
          'INSERT INTO person_invitations(account_id,token_hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET token_hash=excluded.token_hash,created_by=excluded.created_by,created_at=excluded.created_at,expires_at=excluded.expires_at',
        )
        .run(id, tokenHash(token), actor.label, this.master.now(), expiresAt)
      this.master.audit(actor, 'person.invite', String(id))
      return { token, expiresAt }
    })
  }

  /** Revokes a person's invitation link, if they have one. */
  revokeInvitation(actor: Actor, id: number): void {
    allow(actor, 'people.change')
    this.master.transaction(() => {
      if (this.person(id) == null) throw new NotFound('No such person')
      if (this.dropInvitation(id))
        this.master.audit(actor, 'person.invite.revoke', String(id))
    })
  }

  /**
   * Whom a live invitation token is for: their name, their username if they
   * have one, and whether they must choose one (they have no confirmed email
   * to sign in with instead).
   */
  invitation(value: unknown): {
    name: string
    username?: string
    usernameRequired: boolean
  } {
    const token = asToken(value)
    const row = this.db
      .prepare(
        'SELECT a.id,a.name,a.username FROM person_invitations i JOIN accounts a ON a.id=i.account_id WHERE i.token_hash=? AND i.expires_at>? AND a.disabled=0 AND a.removed_at IS NULL',
      )
      .get(tokenHash(token), this.master.now())
    if (row == null) throw new InvitationRefused()
    return {
      name: String(row.name),
      ...(row.username == null ? {} : { username: String(row.username) }),
      usernameRequired:
        row.username == null && !this.hasConfirmedEmail(Number(row.id)),
    }
  }

  private hasConfirmedEmail(id: number): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM account_emails WHERE account_id=? AND confirmed=1',
        )
        .get(id) != null
    )
  }

  /**
   * Uses an invitation token once: the person keeps their username or
   * chooses one, and their password becomes the client hash the browser
   * made. Their permission version is bumped, which ends their sessions.
   * Answers their account.
   */
  async acceptInvitation(
    value: unknown,
  ): Promise<{ accountId: number; permissionVersion: number }> {
    refuseRawPassword(value)
    const token = asToken((value as { token?: unknown } | null)?.token)
    const input = asAcceptance(value)
    // Checked before the slow hash; checked again, and used, after it.
    this.invitation(token)
    const record = await createPasswordRecord(
      input.clientHash,
      input.clientParameters,
    )
    return this.master.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT i.account_id,a.username,a.role FROM person_invitations i JOIN accounts a ON a.id=i.account_id WHERE i.token_hash=? AND i.expires_at>? AND a.disabled=0 AND a.removed_at IS NULL',
        )
        .get(tokenHash(token), this.master.now())
      if (row == null) throw new InvitationRefused()
      const id = Number(row.account_id)
      const username =
        row.username == null ? input.username : String(row.username)
      if (username == null && !this.hasConfirmedEmail(id))
        throw new Error('Choose a username')
      if (row.username == null) this.usernameFree(username)
      this.dropInvitation(id)
      this.db
        .prepare(
          'UPDATE accounts SET username=?,password=?,permission_version=permission_version+1 WHERE id=?',
        )
        .run(username ?? null, record, id)
      this.master.audit(
        { role: asRole(row.role), accountId: id, label: `account:${id}` },
        'person.invite.accept',
        String(id),
      )
      this.master.change('account', id)
      return {
        accountId: id,
        permissionVersion: this.person(id)!.permissionVersion,
      }
    })
  }

  /** Removes a person's invitation; whether there was one. */
  private dropInvitation(id: number): boolean {
    return (
      Number(
        this.db
          .prepare('DELETE FROM person_invitations WHERE account_id=?')
          .run(id).changes,
      ) > 0
    )
  }

  groups(actor: Actor): Group[] {
    allow(actor, 'groups.read')
    return this.db
      .prepare('SELECT id FROM groups ORDER BY name')
      .all()
      .map((row) => this.group(Number(row.id))!)
  }

  group(id: number): Group | undefined {
    const row = this.db
      .prepare('SELECT id,name,created_at FROM groups WHERE id=?')
      .get(id)
    if (row == null) return undefined
    return {
      id: Number(row.id),
      name: String(row.name),
      apps: this.db
        .prepare(
          'SELECT a.id,a.slug FROM group_apps g JOIN apps a ON a.id=g.app_id WHERE g.group_id=? ORDER BY a.slug',
        )
        .all(id)
        .map((app) => ({ id: Number(app.id), slug: String(app.slug) })),
      members: this.db
        .prepare(
          'SELECT account_id FROM group_members WHERE group_id=? ORDER BY account_id',
        )
        .all(id)
        .map((member) => Number(member.account_id)),
      createdAt: Number(row.created_at),
    }
  }

  createGroup(actor: Actor, value: unknown): Group {
    allow(actor, 'groups.change')
    const input = asGroupInput(value)
    const name = input.name
    if (name == null) throw new Error('A group needs a name')
    const id = this.master.transaction(() => {
      if (
        this.db.prepare('SELECT 1 FROM groups WHERE name=?').get(name) != null
      )
        throw new Conflict('A group with that name exists')
      const id = Number(
        this.db
          .prepare('INSERT INTO groups(name,created_at) VALUES(?,?)')
          .run(name, this.master.now()).lastInsertRowid,
      )
      this.fill(id, input.apps ?? [], input.members ?? [])
      this.master.audit(actor, 'group.create', String(id))
      this.master.change('group', id)
      return id
    })
    return this.group(id)!
  }

  /** Renames a group or replaces its apps or members; a member added or removed has their permission version bumped. */
  updateGroup(actor: Actor, id: number, value: unknown): Group {
    allow(actor, 'groups.change')
    const input = asGroupInput(value)
    this.master.transaction(() => {
      const before = this.group(id)
      if (before == null) throw new NotFound('No such group')
      if (input.name != null && input.name !== before.name) {
        if (
          this.db
            .prepare('SELECT 1 FROM groups WHERE name=?')
            .get(input.name) != null
        )
          throw new Conflict('A group with that name exists')
        this.db
          .prepare('UPDATE groups SET name=? WHERE id=?')
          .run(input.name, id)
      }
      if (input.apps != null) {
        this.db.prepare('DELETE FROM group_apps WHERE group_id=?').run(id)
        this.fill(id, input.apps, [])
      }
      if (input.members != null) {
        const next = new Set(input.members)
        const previous = new Set(before.members)
        this.db.prepare('DELETE FROM group_members WHERE group_id=?').run(id)
        this.fill(id, [], input.members)
        for (const account of [...next, ...previous])
          if (next.has(account) !== previous.has(account)) this.bump(account)
      }
      this.master.audit(actor, 'group.update', String(id))
      this.master.change('group', id)
    })
    return this.group(id)!
  }

  removeGroup(actor: Actor, id: number): void {
    allow(actor, 'groups.change')
    this.master.transaction(() => {
      const before = this.group(id)
      if (before == null) throw new NotFound('No such group')
      this.db.prepare('DELETE FROM groups WHERE id=?').run(id)
      for (const account of before.members) this.bump(account)
      this.master.audit(actor, 'group.remove', String(id))
      this.master.change('group', id, 'delete')
    })
  }

  private fill(group: number, apps: number[], members: number[]): void {
    for (const app of new Set(apps)) {
      if (this.db.prepare('SELECT 1 FROM apps WHERE id=?').get(app) == null)
        throw new Error(`No app with ID ${app}`)
      this.db
        .prepare('INSERT INTO group_apps(group_id,app_id) VALUES(?,?)')
        .run(group, app)
    }
    for (const account of new Set(members)) {
      if (this.person(account) == null)
        throw new Error(`No person with ID ${account}`)
      this.db
        .prepare('INSERT INTO group_members(group_id,account_id) VALUES(?,?)')
        .run(group, account)
    }
  }

  private bump(account: number): void {
    this.db
      .prepare(
        'UPDATE accounts SET permission_version=permission_version+1 WHERE id=?',
      )
      .run(account)
    this.master.change('account', account)
  }

  /**
   * Replaces a person's emails with `emails`, in that order. An address they
   * already had keeps whether it is confirmed; a new one is confirmed when
   * an administrator adds it (`admin`), and waits for one when the person
   * adds it themselves; `confirm` confirms addresses they have. Another
   * person's confirmed address is refused. An administrator's write takes
   * over an address someone else only claimed (unconfirmed).
   */
  private setEmails(
    id: number,
    emails: string[],
    confirm: string[],
    admin: boolean,
    before: PersonEmail[],
    actor: Actor,
  ): { added: string[]; removed: string[] } {
    const had = new Map(before.map((entry) => [entry.email, entry.confirmed]))
    for (const email of confirm)
      if (!emails.includes(email))
        throw new Error(`${email} is not one of this person's addresses`)
    for (const email of emails) {
      if (had.has(email)) continue
      const holder = this.db
        .prepare(
          'SELECT account_id,confirmed FROM account_emails WHERE email=? AND account_id!=?',
        )
        .get(email, id) as { account_id: number; confirmed: number } | undefined
      if (holder == null) continue
      if (!admin || holder.confirmed === 1)
        throw new Conflict('That email address belongs to someone else')
      this.dropClaim(email, actor)
    }
    this.db.prepare('DELETE FROM account_emails WHERE account_id=?').run(id)
    const insert = this.db.prepare(
      'INSERT INTO account_emails(account_id,email,position,confirmed) VALUES(?,?,?,?)',
    )
    emails.forEach((email, position) =>
      insert.run(
        id,
        email,
        position,
        Number((had.get(email) ?? admin) || confirm.includes(email)),
      ),
    )
    return {
      added: emails.filter((email) => !had.has(email)),
      removed: [...had.keys()].filter((email) => !emails.includes(email)),
    }
  }

  /** Drops an unconfirmed claim on an address, which its owner takes over; audited as `actor`'s doing. */
  private dropClaim(email: string, actor: Actor): void {
    const claim = this.db
      .prepare(
        'SELECT account_id FROM account_emails WHERE email=? AND confirmed=0',
      )
      .get(email) as { account_id: number } | undefined
    if (claim == null) return
    this.db
      .prepare('DELETE FROM account_emails WHERE email=? AND confirmed=0')
      .run(email)
    this.master.audit(
      actor,
      'person.email.remove',
      `${claim.account_id} ${email}`,
    )
    this.master.change('account', claim.account_id)
  }

  /** Refuses a username anyone else has, ignoring case; `except` may change its own case. */
  private usernameFree(username: string | undefined, except?: number): void {
    if (
      username != null &&
      this.db
        .prepare(
          'SELECT 1 FROM accounts WHERE username=? COLLATE NOCASE AND id IS NOT ?',
        )
        .get(username, except ?? null) != null
    )
      throw new Conflict('That username is taken')
  }

  /** The master always keeps at least one enabled admin. */
  private keepAnAdmin(except: number): void {
    const others = this.db
      .prepare(
        "SELECT COUNT(*) n FROM accounts WHERE role='admin' AND disabled=0 AND removed_at IS NULL AND id!=?",
      )
      .get(except) as { n: number }
    if (Number(others.n) === 0)
      throw new Conflict(
        'The last enabled admin cannot be disabled, demoted or removed',
      )
  }
}
