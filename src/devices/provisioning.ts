import { asArray, asObject } from 'cleaners'
import { zippedMetadata } from '../upload/metadata.js'
import type { Store } from '../store.js'
import { text } from '../validation.js'
import { verifyCms } from './cms.js'
import { decodePlist } from './plist.js'
import { udid } from './store.js'

export interface Provisioning {
  devices: string[]
  expiresAt: number
  team: string
  appId: string
}
export async function inspectProvisioning(
  file: string,
  trust: string,
  openssl = 'openssl',
): Promise<Provisioning> {
  const bytes = await zippedMetadata(file, 'ipa', true)
  const data = decodePlist(await verifyCms(bytes, trust, false, openssl))
  const out = asObject({
    ProvisionedDevices: asArray(udid),
    TeamIdentifier: asArray(text(80)),
    Entitlements: (v: unknown) => v,
  })(data)
  const entitlement = asObject({
    'get-task-allow': (v: unknown) => v,
    'application-identifier': text(256),
  })(out.Entitlements)
  const expiry =
    data.ExpirationDate instanceof Date
      ? data.ExpirationDate.getTime()
      : Date.parse(String(data.ExpirationDate))
  if (
    !Number.isFinite(expiry) ||
    out.TeamIdentifier.length !== 1 ||
    out.ProvisionedDevices.length === 0 ||
    entitlement['get-task-allow'] !== false ||
    !entitlement['application-identifier'].startsWith(
      out.TeamIdentifier[0]! + '.',
    )
  )
    throw new Error('Expected an ad hoc provisioning profile')
  return {
    devices: [...new Set(out.ProvisionedDevices)],
    expiresAt: expiry,
    team: out.TeamIdentifier[0]!,
    appId: entitlement['application-identifier'].slice(
      out.TeamIdentifier[0]!.length + 1,
    ),
  }
}
export function saveProvisioning(
  store: Store,
  buildId: number,
  p: Provisioning,
): void {
  if (store.build(buildId)?.bundle_id !== p.appId)
    throw new Error('Provisioning profile does not match app')
  store.db
    .prepare(
      'INSERT INTO build_provisioning VALUES(?,?,?,?) ON CONFLICT(build_id) DO UPDATE SET devices=excluded.devices,expires_at=excluded.expires_at,team=excluded.team',
    )
    .run(buildId, JSON.stringify(p.devices), p.expiresAt, p.team)
}
