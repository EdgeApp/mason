import { asProvider, type ProviderConfig } from '../auth/providerConfig.js'
import { asOrigin, integer } from '../validation.js'
import type { SettingsArea, SettingValue } from './settings.js'

/** Where the host is served, and how long it serves from its cache without the master. */
export interface HostSetting {
  /** The public `https` origin people and webhooks use. */
  origin: string
  /** An origin cloud machines reach the host at, when it differs. */
  workerOrigin?: string
  offlineGraceHours: number
}

export const hostArea: SettingsArea = {
  validate: (input): SettingValue => {
    const value = (input ?? {}) as Record<string, unknown>
    const origin = asOrigin(value.origin)
    const grace =
      value.offlineGraceHours == null
        ? 72
        : integer(1, 24 * 30)(value.offlineGraceHours)
    return {
      origin,
      ...(value.workerOrigin == null
        ? {}
        : { workerOrigin: asOrigin(value.workerOrigin) }),
      offlineGraceHours: grace,
    }
  },
}

export type SignInMethod = ProviderConfig & { enabled: boolean }

export const methodsOf = (value: SettingValue | undefined): SignInMethod[] =>
  ((value?.methods ?? []) as SignInMethod[]).filter(
    (method) => method != null && typeof method === 'object',
  )

/**
 * Sign-in methods the host offers: OIDC or OAuth providers with their client
 * settings. The client secret is write-only; `{ keep: true }` reuses the stored
 * one. A disabled method stays configured but is not offered.
 */
export const signInArea: SettingsArea = {
  validate: (input, previous): SettingValue => {
    const value = (input ?? {}) as { methods?: unknown }
    if (value.methods != null && !Array.isArray(value.methods))
      throw new Error('signIn.methods is a list of sign-in methods')
    const stored = methodsOf(previous)
    const methods: SignInMethod[] = []
    for (const raw of (value.methods ?? []) as Array<Record<string, unknown>>) {
      if (raw == null || typeof raw !== 'object')
        throw new Error('A sign-in method is an object')
      const { enabled, clientSecret, ...rest } = raw
      let secret = clientSecret
      if (
        secret != null &&
        typeof secret === 'object' &&
        (secret as { keep?: unknown }).keep === true
      ) {
        secret = stored.find((method) => method.id === rest.id)?.clientSecret
        if (secret == null)
          throw new Error(
            `No stored client secret to keep for ${String(rest.id)}`,
          )
      }
      if (enabled != null && typeof enabled !== 'boolean')
        throw new Error('enabled is true or false')
      const provider = asProvider({ ...rest, clientSecret: secret })
      if (methods.some((method) => method.id === provider.id))
        throw new Error(`Sign-in method ${provider.id} is listed twice`)
      methods.push({ ...provider, enabled: enabled !== false })
    }
    return { methods }
  },
  redact: (value): SettingValue => ({
    methods: methodsOf(value).map((method) => ({
      ...method,
      clientSecret: { set: true },
    })),
  }),
}

/**
 * What the host receives of a published setting: every field of `host`, and
 * only the enabled sign-in methods of `signIn` — a disabled method's secret
 * never leaves the master.
 */
export function hostProjection(
  area: string,
  value: SettingValue,
): SettingValue {
  // Which cloud account made the storage key is the master's business.
  if (area === 'storage') {
    const rest = { ...value }
    delete rest.managed
    return rest
  }
  if (area !== 'signIn') return value
  return { methods: methodsOf(value).filter((method) => method.enabled) }
}

/** Where the host keeps builds and saved artifacts: its disk, or S3-compatible storage. */
export interface StorageSetting {
  driver: 'disk' | 's3'
  s3?: {
    endpoint: string
    bucket: string
    region: string
    accessKeyId: string
    secretAccessKey: string
  }
  /** A Space Mason made: the cloud account and the key it made for it. */
  managed?: { account: string; keyId: string }
}

function asManaged(value: unknown): { account: string; keyId: string } {
  const managed = (value ?? {}) as Record<string, unknown>
  if (
    typeof managed.account !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,39}$/.test(managed.account) ||
    typeof managed.keyId !== 'string' ||
    !/^[A-Za-z0-9]{8,128}$/.test(managed.keyId)
  )
    throw new Error('storage.managed names a cloud account and a key id')
  return { account: managed.account, keyId: managed.keyId }
}

/**
 * The `storage` settings area: `disk`, or `s3` with an https endpoint, a
 * bucket, a region and credentials whose secret is write-only. The host
 * receives it through the change log; nothing else does.
 */
export const storageArea: SettingsArea = {
  validate: (input, previous): SettingValue => {
    const value = (input ?? {}) as {
      driver?: unknown
      s3?: Record<string, unknown>
      managed?: unknown
    }
    const driver = value.driver ?? 'disk'
    if (driver === 'disk') return { driver: 'disk' }
    if (driver !== 's3') throw new Error('storage.driver is disk or s3')
    const s3 = value.s3 ?? {}
    const endpoint = asOrigin(s3.endpoint)
    const text = (field: string, pattern: RegExp): string => {
      const out = s3[field]
      if (typeof out !== 'string' || !pattern.test(out))
        throw new Error(`storage.s3.${field} is required`)
      return out
    }
    let secret: unknown = s3.secretAccessKey
    if (
      secret != null &&
      typeof secret === 'object' &&
      (secret as { keep?: unknown }).keep === true
    ) {
      secret = (previous?.s3 as { secretAccessKey?: unknown } | undefined)
        ?.secretAccessKey
      if (secret == null) throw new Error('No stored secretAccessKey to keep')
    }
    if (typeof secret !== 'string' || secret.length < 8 || secret.length > 200)
      throw new Error('storage.s3.secretAccessKey is required')
    const accessKeyId = text('accessKeyId', /^[A-Za-z0-9]{8,128}$/)
    // A Space Mason made keeps its account and key id while it uses that key.
    const managed =
      value.managed != null
        ? asManaged(value.managed)
        : (previous?.managed as StorageSetting['managed'])?.keyId ===
            accessKeyId
          ? (previous!.managed as StorageSetting['managed'])
          : undefined
    return {
      driver: 's3',
      s3: {
        endpoint,
        bucket: text('bucket', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
        region: text('region', /^[a-z0-9-]{2,40}$/),
        accessKeyId,
        secretAccessKey: secret,
      },
      ...(managed == null ? {} : { managed }),
    }
  },
  redact: (value): SettingValue =>
    value.s3 == null
      ? value
      : {
          ...value,
          s3: { ...(value.s3 as object), secretAccessKey: { set: true } },
        },
}
