import { asObject, asString } from 'cleaners'
import {
  Accounts,
  randomToken,
  type Account,
  type Session,
} from '../auth/accounts.js'
import { Store, digest } from '../store.js'
import { asId, integer, oneOf, text, type Build } from '../validation.js'
import { randomUUID } from 'node:crypto'
import { models } from './models.js'
import { escape } from '../view.js'

const states = ['pending', 'processing', 'registered', 'error'] as const
export const asDevice = asObject({
  id: asId,
  udid: asString,
  product: asString,
  model: asString,
  os_version: asString,
  status: oneOf(states),
  message: asString,
  created_at: integer(),
  updated_at: integer(),
})
export type Device = ReturnType<typeof asDevice>
export const DEVICE_COOKIE = '__Host-mason-device'
export function udid(value: unknown): string {
  const out = text(40)(value).toUpperCase()
  if (!/^(?:[A-F0-9]{40}|[A-F0-9]{8}-[A-F0-9]{16})$/.test(out))
    throw new Error('Invalid device identifier')
  return out
}
export function friendlyName(
  product: string,
  account: Pick<Account, 'name' | 'email'>,
): string {
  const model =
    models[product] ??
    (product.startsWith('iPad')
      ? 'iPad'
      : product.startsWith('iPod')
        ? 'iPod'
        : 'iPhone')
  return `${model} of ${(account.email ?? account.name).replace(/\.[^.@]+$/, '')}`.slice(
    0,
    120,
  )
}
/**
 * On a host, registrations and changes go to the master through the
 * outbox; the device rows come back through replication.
 */
export interface DeviceRelay {
  enqueue(kind: 'device' | 'prepare', payload: Record<string, unknown>): void
}
export class Devices {
  constructor(
    readonly store: Store,
    readonly relay?: DeviceRelay,
  ) {
    if (relay != null)
      store.db.exec(
        'CREATE TABLE IF NOT EXISTS host_device_registrations(hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL, udid TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT',
      )
  }
  /** Testers and every role above them may register devices. */
  allowed(account: Account): boolean {
    if (account.is_admin || account.is_tester) return true
    try {
      const row = this.store.db
        .prepare('SELECT role FROM accounts WHERE id=?')
        .get(account.id) as { role?: unknown } | undefined
      return typeof row?.role === 'string'
    } catch {
      // A distribution database without roles.
      return false
    }
  }
  /** On a host: the device a registration link sent to the master, until it comes back. */
  registration(token: string, accountId: number): string | undefined {
    if (this.relay == null) return undefined
    const row = this.store.db
      .prepare(
        'SELECT udid FROM host_device_registrations WHERE hash=? AND account_id=?',
      )
      .get(digest(token), accountId) as { udid: string } | undefined
    return row?.udid
  }
  list(accountId: number): Array<Device & { name: string }> {
    return this.store.db
      .prepare(
        'SELECT d.*,a.name FROM devices d JOIN account_devices a ON a.device_id=d.id WHERE a.account_id=? ORDER BY a.created_at DESC,d.id DESC',
      )
      .all(accountId)
      .map((r) => ({ ...asDevice(r), name: asString(r.name) }))
  }
  selected(
    accountId: number,
    rawCookie: string | undefined,
  ): Device | undefined {
    const id = /(?:^|;\s*)__Host-mason-device=(\d+)(?:;|$)/.exec(
      rawCookie ?? '',
    )?.[1]
    return this.list(accountId).find((d) => String(d.id) === id)
  }
  challenge(session: Session): string {
    return this.store.transaction(() => {
      this.store.db
        .prepare('DELETE FROM device_challenges WHERE expires_at<=?')
        .run(this.store.now())
      const count = Number(
        this.store.db
          .prepare(
            'SELECT count(*) n FROM device_challenges WHERE account_id=? AND device_id IS NULL',
          )
          .get(session.account_id)?.n,
      )
      if (count >= 10) throw new Error('Too many pending registration requests')
      const token = randomToken()
      this.store.db
        .prepare(
          'INSERT INTO device_challenges(hash,account_id,session_hash,expires_at) VALUES(?,?,?,?)',
        )
        .run(
          digest(token),
          session.account_id,
          session.hash,
          Math.min(session.expires_at, this.store.now() + 20 * 60000),
        )
      return token
    })
  }
  receive(token: string, attributes: Record<string, unknown>): Device {
    if (attributes.CHALLENGE !== token)
      throw new Error('Registration challenge mismatch')
    const identifier = udid(attributes.UDID),
      product = text(80)(attributes.PRODUCT),
      version = text(80)(attributes.VERSION)
    if (!/^(?:iPhone|iPad|iPod)\d+,\d+$/.test(product))
      throw new Error('Use an iPhone or iPad for registration')
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare(
          'SELECT * FROM device_challenges WHERE hash=? AND expires_at>? AND device_id IS NULL',
        )
        .get(digest(token), this.store.now())
      if (!row) throw new Error('Expired or used registration')
      const context = new Accounts(this.store).sessionHash(
        asString(row.session_hash),
      )
      if (!context || !this.allowed(context.account))
        throw new Error('Tester access required')
      if (
        this.list(context.account.id).length >= 20 &&
        !this.list(context.account.id).some((d) => d.udid === identifier)
      )
        throw new Error('Device limit reached')
      if (this.relay != null) {
        // The master owns the device rows: the registration goes to it.
        if (this.registration(token, context.account.id) != null)
          throw new Error('Expired or used registration')
        this.store.db
          .prepare(
            'INSERT INTO host_device_registrations(hash,account_id,udid,created_at) VALUES(?,?,?,?)',
          )
          .run(digest(token), context.account.id, identifier, this.store.now())
        this.relay.enqueue('device', {
          udid: identifier,
          product,
          model: models[product] ?? product,
          osVersion: version,
          accountId: context.account.id,
          name: friendlyName(product, context.account),
        })
        return {
          id: 0,
          udid: identifier,
          product,
          model: models[product] ?? product,
          os_version: version,
          status: 'pending',
          message: '',
          created_at: this.store.now(),
          updated_at: this.store.now(),
        }
      }
      this.store.db
        .prepare(
          `INSERT INTO devices(udid,product,model,os_version,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(udid) DO UPDATE SET product=excluded.product,model=excluded.model,os_version=excluded.os_version,updated_at=excluded.updated_at`,
        )
        .run(
          identifier,
          product,
          models[product] ?? product,
          version,
          this.store.now(),
          this.store.now(),
        )
      const device = asDevice(
        this.store.db
          .prepare('SELECT * FROM devices WHERE udid=?')
          .get(identifier),
      )
      this.store.db
        .prepare('INSERT OR IGNORE INTO account_devices VALUES(?,?,?,?)')
        .run(
          context.account.id,
          device.id,
          friendlyName(product, context.account),
          this.store.now(),
        )
      this.store.db
        .prepare('UPDATE device_challenges SET device_id=? WHERE hash=?')
        .run(device.id, digest(token))
      new Accounts(this.store).audit(
        context.account.id,
        'device.register',
        String(device.id),
      )
      return device
    })
  }
  profile(token: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid request')
    return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>PayloadType</key><string>Profile Service</string><key>PayloadVersion</key><integer>1</integer><key>PayloadIdentifier</key><string>app.mason.device-registration</string><key>PayloadUUID</key><string>${randomUUID()}</string><key>PayloadDisplayName</key><string>Mason Device Registration</string><key>PayloadOrganization</key><string>Mason</string><key>PayloadDescription</key><string>Share your device identifier, model and OS version with Mason so you can install test apps. This does not enroll your device in management.</string><key>PayloadContent</key><dict><key>URL</key><string>${escape(this.store.config.origin + '/devices/callback/' + token)}</string><key>Challenge</key><string>${escape(token)}</string><key>DeviceAttributes</key><array><string>UDID</string><string>PRODUCT</string><string>VERSION</string></array></dict></dict></plist>`
  }
  eligible(build: Build, device: Device | undefined): boolean {
    if (this.store.config.devices == null || build.platform !== 'ios')
      return true
    if (!device || device.status !== 'registered') return false
    const profile = this.store.db
      .prepare(
        'SELECT * FROM build_provisioning WHERE build_id=? AND expires_at>?',
      )
      .get(build.id, this.store.now())
    return (
      profile != null &&
      (JSON.parse(asString(profile.devices)) as string[]).includes(device.udid)
    )
  }
  requestBuild(accountId: number, deviceId: number, buildId: number): void {
    const d = this.list(accountId).find((d) => d.id === deviceId),
      b = this.store.build(buildId)
    if (!d || !b || b.platform !== 'ios')
      throw new Error('Device or build unavailable')
    const recent = Number(
      this.store.db
        .prepare(
          this.relay == null
            ? 'SELECT count(*) n FROM device_build_requests WHERE account_id=? AND created_at>?'
            : "SELECT count(*) n FROM host_outbox WHERE kind='prepare' AND json_extract(payload,'$.accountId')=? AND created_at>?",
        )
        .get(accountId, this.store.now() - 3600000)?.n,
    )
    if (recent >= 20)
      throw new Error('Too many build preparation requests; try again later')
    if (this.relay != null) {
      this.relay.enqueue('prepare', { accountId, deviceId, buildId })
      return
    }
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO device_build_requests(account_id,device_id,build_id,created_at) VALUES(?,?,?,?)`,
      )
      .run(accountId, deviceId, buildId, this.store.now())
  }
  /** Renames, retries or removes one of an account's devices; on a host, through the master. */
  act(
    accountId: number,
    device: Device,
    action: 'rename' | 'retry' | 'remove',
    name?: string,
  ): void {
    if (this.relay != null) {
      this.relay.enqueue('device', {
        action,
        udid: device.udid,
        accountId,
        ...(name == null ? {} : { name }),
      })
      return
    }
    if (action === 'rename')
      this.store.db
        .prepare(
          'UPDATE account_devices SET name=? WHERE account_id=? AND device_id=?',
        )
        .run(text(120)(name), accountId, device.id)
    else if (action === 'retry')
      this.store.db
        .prepare(
          "UPDATE devices SET status='pending',message='',updated_at=? WHERE id=? AND status='error'",
        )
        .run(this.store.now(), device.id)
    else
      this.store.db
        .prepare(
          'DELETE FROM account_devices WHERE account_id=? AND device_id=?',
        )
        .run(accountId, device.id)
  }
}
