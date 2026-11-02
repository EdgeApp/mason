import { asArray, asObject, asString, asUnknown } from 'cleaners'
import { parseBuffer, setMaxObjectCount, setMaxObjectSize } from 'bplist-parser'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { text } from '../validation.js'

export const asPackageIdentity = asObject({
  bundleId: text(256),
  version: text(80),
  buildNumber: text(80),
})
export type PackageIdentity = ReturnType<typeof asPackageIdentity>
const identityKeys = [
  'CFBundleIdentifier',
  'CFBundleShortVersionString',
  'CFBundleVersion',
]

/**
 * The fields of an Info.plist (binary or XML) Mason reads: of an XML one,
 * only `keys`, each a string or an array of strings.
 */
function plistFields(data: Buffer, keys: string[]): Record<string, unknown> {
  if (data.subarray(0, 8).toString() === 'bplist00') {
    setMaxObjectSize(1024 * 1024)
    setMaxObjectCount(16384)
    const dictionary = parseBuffer<unknown>(data)[0]
    if (
      dictionary == null ||
      typeof dictionary !== 'object' ||
      Array.isArray(dictionary)
    )
      throw new Error('Invalid binary plist')
    return dictionary as Record<string, unknown>
  }
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(data)
  if (
    /<!ENTITY|<!DOCTYPE[^>]*\[/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  )
    throw new Error('Invalid XML plist')
  const parsed: unknown = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: true,
    parseTagValue: false,
    processEntities: false,
  }).parse(xml)
  const nodes = asArray(asUnknown)(parsed)
  const plist = nodes.find(
    (value) =>
      value != null &&
      typeof value === 'object' &&
      Object.hasOwn(value, 'plist'),
  )
  const entries = asObject({ plist: asArray(asUnknown) })(plist).plist
  const root = entries.find(
    (value) =>
      value != null &&
      typeof value === 'object' &&
      Object.hasOwn(value, 'dict'),
  )
  const fields = asObject({ dict: asArray(asUnknown) })(root).dict
  const asText = asArray(asObject({ '#text': asString }))
  const out: Record<string, unknown> = Object.create(null)
  for (let i = 0; i < fields.length; i += 2) {
    const keyNodes = asObject({ key: asText })(fields[i]).key
    if (keyNodes.length !== 1) throw new Error('Invalid plist key')
    const key = keyNodes[0]!['#text']
    if (!keys.includes(key)) continue
    if (Object.hasOwn(out, key)) throw new Error('Duplicate plist key')
    const node = fields[i + 1]
    if (
      node != null &&
      typeof node === 'object' &&
      Object.hasOwn(node, 'array')
    )
      out[key] = asObject({ array: asArray(asUnknown) })(node).array.map(
        (item) => {
          const value = asObject({ string: asText })(item).string
          if (value.length !== 1) throw new Error('Invalid plist value')
          return value[0]!['#text']
        },
      )
    else {
      const value = asObject({ string: asText })(node).string
      if (value.length !== 1) throw new Error('Invalid plist value')
      out[key] = value[0]!['#text']
    }
  }
  return out
}

function identityOf(dictionary: Record<string, unknown>): PackageIdentity {
  const fields = asObject({
    CFBundleIdentifier: text(256),
    CFBundleShortVersionString: text(80),
    CFBundleVersion: text(80),
  })(dictionary)
  for (const key of identityKeys)
    if (!Object.hasOwn(dictionary, key))
      throw new Error('Invalid plist identity')
  return asPackageIdentity({
    bundleId: fields.CFBundleIdentifier,
    version: fields.CFBundleShortVersionString,
    buildNumber: fields.CFBundleVersion,
  })
}

export function plistIdentity(data: Buffer): PackageIdentity {
  return identityOf(plistFields(data, identityKeys))
}

/**
 * An iPhone Simulator app's identity from its Info.plist, which must say it
 * was built for the simulator (`DTPlatformName` `iphonesimulator`, or
 * without one `iPhoneSimulator` among `CFBundleSupportedPlatforms`) and for
 * no device (no other `DTPlatformName`, no `iPhoneOS` among the supported
 * platforms); an app for devices is refused.
 */
export const NOT_SIMULATOR =
  'The .app is not built for the iPhone Simulator (its Info.plist names another platform)'
export function simulatorIdentity(data: Buffer): PackageIdentity {
  const dictionary = plistFields(data, [
    ...identityKeys,
    'DTPlatformName',
    'CFBundleSupportedPlatforms',
  ])
  // Built for the simulator, and for nothing else: a DTPlatformName of
  // another platform, or iPhoneOS among the supported ones, is a device app.
  const named = dictionary.DTPlatformName
  const supported = Array.isArray(dictionary.CFBundleSupportedPlatforms)
    ? (dictionary.CFBundleSupportedPlatforms as unknown[])
    : []
  if (
    (named != null && named !== 'iphonesimulator') ||
    supported.includes('iPhoneOS') ||
    (named == null && !supported.includes('iPhoneSimulator'))
  )
    throw new Error(NOT_SIMULATOR)
  return identityOf(dictionary)
}
