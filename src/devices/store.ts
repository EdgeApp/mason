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
export class Devices {
  constructor(readonly store: Store) {}
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
      if (!context || !(context.account.is_admin || context.account.is_tester))
        throw new Error('Tester access required')
      if (
        this.list(context.account.id).length >= 20 &&
        !this.list(context.account.id).some((d) => d.udid === identifier)
      )
        throw new Error('Device limit reached')
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
          'SELECT count(*) n FROM device_build_requests WHERE account_id=? AND created_at>?',
        )
        .get(accountId, this.store.now() - 3600000)?.n,
    )
    if (recent >= 20)
      throw new Error('Too many build preparation requests; try again later')
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO device_build_requests(account_id,device_id,build_id,created_at) VALUES(?,?,?,?)`,
      )
      .run(accountId, deviceId, buildId, this.store.now())
  }
}
