import { asArray, asObject, asOptional } from 'cleaners'
import { asClientHash, rejectRawPassword } from '../auth/passwordProtocol.js'
import { asUsername } from '../setup/setup.js'
import { integer, text } from '../validation.js'
import { Conflict, NotFound } from './api.js'
import type { MasterDatabase } from './database.js'
import { createPasswordRecord } from './passwords.js'
import { allow } from './permissions.js'
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
  /** The person's email: any enabled sign-in method that verifies it signs them in. */
  email?: string
  /** Addresses for single methods, for someone whose address there differs. */
  addresses: Record<string, string>
  groups: number[]
  permissionVersion: number
  createdAt: number
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
/** `{ method: address }`, with `null` removing a method's address. */
const asAddresses = (value: unknown): Record<string, string | null> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('addresses maps sign-in methods to email addresses')
  const out: Record<string, string | null> = {}
  for (const [method, address] of Object.entries(value))
    out[asMethod(method)] = address === null ? null : asAddress(address)
  return out
}
const asPassword = asObject({
  clientHash: asClientHash,
  clientParameters: (value: unknown): unknown => value,
})
const asPersonInput = asObject({
  name: asOptional(text(120)),
  username: asOptional(asUsername),
  role: asOptional(asRole),
  disabled: asOptional((value: unknown): boolean => {
    if (typeof value !== 'boolean') throw new Error('disabled is true or false')
    return value
  }),
  email: asOptional(asAddress),
  addresses: asOptional(asAddresses),
  password: asOptional(asPassword),
})

/** The address row that matches every sign-in method. */
const ANY_METHOD = '*'
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
    const addresses: Record<string, string> = {}
    let email: string | undefined
    for (const entry of this.db
      .prepare(
        'SELECT method,email FROM account_addresses WHERE account_id=? ORDER BY method',
      )
      .all(id))
      if (entry.method === ANY_METHOD) email = String(entry.email)
      else addresses[String(entry.method)] = String(entry.email)
    return {
      id: Number(row.id),
      name: String(row.name),
      ...(row.username == null ? {} : { username: String(row.username) }),
      role: asRole(row.role),
      disabled: Number(row.disabled) === 1,
      password: row.password != null,
      ...(email == null ? {} : { email }),
      addresses,
      groups: this.db
        .prepare(
          'SELECT group_id FROM group_members WHERE account_id=? ORDER BY group_id',
        )
        .all(id)
        .map((entry) => Number(entry.group_id)),
      permissionVersion: Number(row.permission_version),
      createdAt: Number(row.created_at),
    }
  }

  /** Adds a person: a name, a role, and their sign-in addresses or a master password. */
  async create(actor: Actor, value: unknown): Promise<Person> {
    allow(actor, 'people.change')
    refuseRawPassword(value)
    const input = asPersonInput(value)
    if (input.name == null && input.username == null)
      throw new Error('A person needs a name or a username')
    const email = input.email
    if (email == null) throw new Error('A person needs an email address')
    const record =
      input.password == null
        ? null
        : await createPasswordRecord(
            input.password.clientHash,
            input.password.clientParameters,
          )
    if (record != null && input.username == null)
      throw new Error('A master password needs a username')
    const id = this.master.transaction(() => {
      this.usernameFree(input.username)
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
      this.setAddresses(id, {
        ...input.addresses,
        [ANY_METHOD]: email,
      })
      this.master.audit(actor, 'person.create', String(id))
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
  async update(actor: Actor, id: number, value: unknown): Promise<Person> {
    const selfPassword =
      actor.accountId === id &&
      Object.keys((value as object | null) ?? {}).every(
        (field) => field === 'password',
      )
    if (!selfPassword) allow(actor, 'people.change')
    refuseRawPassword(value)
    const input = asPersonInput(value)
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
      if (input.username != null && input.username !== before.username)
        this.usernameFree(input.username)
      if (record != null && (input.username ?? before.username) == null)
        throw new Error('A master password needs a username')
      this.db
        .prepare(
          'UPDATE accounts SET name=?,username=?,role=?,is_admin=?,is_tester=?,disabled=?,password=COALESCE(?,password),permission_version=permission_version+1 WHERE id=?',
        )
        .run(
          input.name ?? before.name,
          input.username ?? before.username ?? null,
          role,
          Number(role === 'admin'),
          Number(role === 'tester'),
          Number(disabled),
          record ?? null,
          id,
        )
      if (input.addresses != null) this.setAddresses(id, input.addresses)
      if (input.email != null)
        this.setAddresses(id, { [ANY_METHOD]: input.email })
      this.master.audit(actor, 'person.update', String(id))
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
      this.db
        .prepare('DELETE FROM account_addresses WHERE account_id=?')
        .run(id)
      const groups = this.db
        .prepare('SELECT group_id FROM group_members WHERE account_id=?')
        .all(id)
      this.db.prepare('DELETE FROM group_members WHERE account_id=?').run(id)
      this.db
        .prepare(
          'UPDATE accounts SET username=NULL,password=NULL,disabled=1,removed_at=?,permission_version=permission_version+1 WHERE id=?',
        )
        .run(this.master.now(), id)
      for (const key of this.db
        .prepare('SELECT id FROM api_keys WHERE creator=? AND revoked=0')
        .all(id)) {
        this.db
          .prepare('UPDATE api_keys SET revoked=1 WHERE id=?')
          .run(String(key.id))
        this.master.change('api_key', String(key.id))
      }
      this.master.audit(actor, 'person.remove', String(id))
      this.master.change('account', id)
      for (const group of groups)
        this.master.change('group', Number(group.group_id))
    })
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

  private setAddresses(
    id: number,
    addresses: Record<string, string | null>,
  ): void {
    for (const [method, address] of Object.entries(addresses)) {
      this.db
        .prepare(
          'DELETE FROM account_addresses WHERE account_id=? AND method=?',
        )
        .run(id, method)
      if (address == null) continue
      // An email matches every method, so it may not be anyone else's address anywhere.
      if (
        this.db
          .prepare(
            method === ANY_METHOD
              ? 'SELECT 1 FROM account_addresses WHERE ?1 IS NOT NULL AND email=?2 AND account_id!=?3'
              : "SELECT 1 FROM account_addresses WHERE (method=?1 OR method='*') AND email=?2 AND account_id!=?3",
          )
          .get(method, address, id) != null
      )
        throw new Conflict(
          method === ANY_METHOD
            ? 'Another person has that email address'
            : `Another person has that ${method} address`,
        )
      this.db
        .prepare(
          'INSERT INTO account_addresses(account_id,method,email) VALUES(?,?,?)',
        )
        .run(id, method, address)
    }
  }

  private usernameFree(username: string | undefined): void {
    if (
      username != null &&
      this.db
        .prepare('SELECT 1 FROM accounts WHERE username=? COLLATE NOCASE')
        .get(username) != null
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
