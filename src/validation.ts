import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
} from 'cleaners'

export type Cleaner<T> = (value: unknown) => T
export function strict<T>(
  fields: Record<string, Cleaner<unknown>>,
  clean: Cleaner<T>,
): Cleaner<T> {
  return (value) => {
    if (value == null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Expected an object')
    for (const key of Object.keys(value)) {
      if (
        !Object.hasOwn(fields, key) ||
        ['__proto__', 'prototype', 'constructor'].includes(key)
      )
        throw new Error('Unknown field')
    }
    return clean(value)
  }
}
export function object<T extends Record<string, unknown>>(fields: {
  [K in keyof T]: Cleaner<T[K]>
}): Cleaner<T> {
  return strict(fields, asObject(fields))
}
export function text(max = 256, min = 1): Cleaner<string> {
  return (value) => {
    const out = asString(value)
    if (
      out.length < min ||
      out.length > max ||
      /[\u0000-\u001f\u007f]/.test(out)
    )
      throw new Error('Invalid text')
    return out
  }
}
export function integer(
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): Cleaner<number> {
  return (value) => {
    const out = asNumber(value)
    if (!Number.isSafeInteger(out) || out < min || out > max)
      throw new Error('Invalid integer')
    return out
  }
}
export function oneOf<const T extends readonly string[]>(
  options: T,
): Cleaner<T[number]> {
  return (value) => {
    const out = asString(value)
    if (!options.includes(out)) throw new Error('Invalid choice')
    return out as T[number]
  }
}
export const asId = integer(1)
export const asFlag = (value: unknown): number => {
  const out = integer(0, 1)(value)
  return out
}
export const asPlatform = oneOf(['ios', 'android', 'macos', 'windows'] as const)
export type Platform = ReturnType<typeof asPlatform>
export const asFormat = oneOf(['ipa', 'apk', 'dmg', 'exe', 'msi'] as const)
export type Format = ReturnType<typeof asFormat>
export const formats: Record<Platform, readonly Format[]> = {
  ios: ['ipa'],
  android: ['apk'],
  macos: ['dmg'],
  windows: ['exe', 'msi'],
}
export const asDigest: Cleaner<string> = (value) => {
  const out = asString(value)
  if (!/^[a-f0-9]{64}$/.test(out)) throw new Error('Invalid digest')
  return out
}
export const asFileKey: Cleaner<string> = (value) => {
  const out = asString(value)
  if (!/^[a-f0-9]{32}\.(ipa|apk|dmg|exe|msi)$/.test(out))
    throw new Error('Invalid file key')
  return out
}
export const asHttps: Cleaner<string> = (value) => {
  const out = text(2048)(value)
  const url = new URL(out)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('Expected HTTPS URL')
  return text(2048)(url.href)
}
export const asOrigin: Cleaner<string> = (value) => {
  const url = new URL(asHttps(value))
  if (url.pathname !== '/' || url.search)
    throw new Error('Expected HTTPS origin')
  return url.origin
}
export const asAppInput = object({
  slug: text(160),
  name: text(120),
  position: integer(),
  enabled: asOptional(asBoolean, true),
})
export const asChannelInput = object({
  appId: asId,
  platform: asPlatform,
  key: text(256),
  allowedFormats: asArray(asFormat),
  enabled: asOptional(asBoolean, true),
})
export const asApp = asObject({
  id: asId,
  slug: text(160),
  name: text(120),
  position: integer(),
  enabled: asFlag,
})
export const asChannel = asObject({
  id: asId,
  app_id: asId,
  platform: asPlatform,
  channel_key: text(256),
  formats: asString,
  enabled: asFlag,
})
export const asPublication = object({
  channelId: asId,
  branch: text(256),
  commit: text(128),
  version: text(80),
  buildNumber: text(80),
  bundleId: text(256),
  format: asFormat,
  digest: asDigest,
  size: integer(1),
  changelog: asOptional(asString, ''),
  source: asOptional(text(80), 'api'),
  customFields: asOptional(asString, '{}'),
})
export type Publication = ReturnType<typeof asPublication>
export const asBuild = asObject({
  id: asId,
  app_id: asId,
  channel_id: asId,
  platform: asPlatform,
  branch: text(256),
  commit_hash: text(128),
  version: text(80),
  build_number: text(80),
  bundle_id: text(256),
  format: asFormat,
  digest: asDigest,
  size: integer(1),
  file_key: asFileKey,
  published_at: integer(),
  expires_at: integer(),
  state: oneOf(['ready', 'deleting', 'deleted'] as const),
  deleted_at: asOptional(integer()),
  changelog: asString,
  source: text(80),
  custom_fields: asString,
})
export type Build = ReturnType<typeof asBuild>
