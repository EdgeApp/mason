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

/** A variant name: 1 to 32 letters, digits, `.`, `_` or `-`, starting with a letter or digit. */
const variantPattern = '[A-Za-z0-9][A-Za-z0-9._-]{0,31}'
const variantRegex = new RegExp(`^${variantPattern}$`)

/**
 * A published build's variant: `''`, the default, or a short name such as
 * `arm64-v8a` (`variantPattern`). A missing value is the default.
 */
export const asVariant = (value: unknown): string => {
  if (value == null || value === '') return ''
  if (typeof value !== 'string' || !variantRegex.test(value))
    throw new Error(
      'A variant is 1 to 32 letters, digits, ".", "_" or "-", starting with a letter or digit',
    )
  return value
}

/** The refusal of a second file for a variant a run already published. */
export function alreadyPublished(variant: string): string {
  return `${variant === '' ? 'The default variant' : variant} is already published for this run`
}

/**
 * Why a publication's build number is not one of its run's: with a block of
 * 1 it must be the reserved number itself (any format); with a larger block
 * an integer from the reserved number to the block's last.
 */
export function outsideBlock(
  number: string,
  first: string,
  block: number,
): string | undefined {
  if (block <= 1)
    return number === first
      ? undefined
      : `The build number ${number} is not the reserved ${first}`
  const last = (BigInt(first) + BigInt(block - 1)).toString()
  if (/^\d+$/.test(number)) {
    const offset = BigInt(number) - BigInt(first)
    if (offset >= 0n && offset < BigInt(block)) return undefined
  }
  return `${number} is outside the run's block ${first}–${last}`
}

/**
 * A stored package's file name: its reservation, `-<variant>` for a named
 * variant, and `-<16 hex>` from its digest (absent on builds stored before),
 * so two files for one variant never share a name.
 */
export const fileKeyPattern = new RegExp(
  `^[a-f0-9]{32}(-${variantPattern})?(-[a-f0-9]{16})?\\.(ipa|apk|dmg|exe|msi)$`,
)

/** Why a CocoaPods version is not one Mason installs: it must be exact, `1.16.2`. */
export function inexactCocoapods(version: unknown): string | undefined {
  return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version)
    ? undefined
    : "CocoaPods needs an exact version, such as '1.16.2'"
}

export const asDigest: Cleaner<string> = (value) => {
  const out = asString(value)
  if (!/^[a-f0-9]{64}$/.test(out)) throw new Error('Invalid digest')
  return out
}
export const asFileKey: Cleaner<string> = (value) => {
  const out = asString(value)
  if (!fileKeyPattern.test(out)) throw new Error('Invalid file key')
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
  /** The default variant is `''`; `asVariant` gives it for a missing value. */
  variant: asVariant,
  /** The pipeline run that published it; a run's variants are one build. */
  run: asOptional(text(64)),
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
  variant: asOptional(asString, ''),
  run: asOptional(asString),
})
export type Build = ReturnType<typeof asBuild>
