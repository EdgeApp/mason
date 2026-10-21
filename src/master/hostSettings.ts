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

const methodsOf = (value: SettingValue | undefined): SignInMethod[] =>
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
  if (area !== 'signIn') return value
  return { methods: methodsOf(value).filter((method) => method.enabled) }
}
