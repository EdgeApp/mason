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
export function plistIdentity(data: Buffer): PackageIdentity {
  let dictionary: unknown
  if (data.subarray(0, 8).toString() === 'bplist00') {
    setMaxObjectSize(1024 * 1024)
    setMaxObjectCount(16384)
    dictionary = parseBuffer<unknown>(data)[0]
  } else {
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
    const out: Record<string, string> = Object.create(null)
    for (let i = 0; i < fields.length; i += 2) {
      const keyNodes = asObject({
        key: asArray(asObject({ '#text': asString })),
      })(fields[i]).key
      if (keyNodes.length !== 1) throw new Error('Invalid plist key')
      const key = keyNodes[0]!['#text']
      if (
        ![
          'CFBundleIdentifier',
          'CFBundleShortVersionString',
          'CFBundleVersion',
        ].includes(key)
      )
        continue
      if (Object.hasOwn(out, key)) throw new Error('Duplicate plist key')
      const value = asObject({
        string: asArray(asObject({ '#text': asString })),
      })(fields[i + 1]).string
      if (value.length !== 1) throw new Error('Invalid plist value')
      out[key] = value[0]!['#text']
    }
    dictionary = out
  }
  const fields = asObject({
    CFBundleIdentifier: text(256),
    CFBundleShortVersionString: text(80),
    CFBundleVersion: text(80),
  })(dictionary)
  for (const key of [
    'CFBundleIdentifier',
    'CFBundleShortVersionString',
    'CFBundleVersion',
  ])
    if (!Object.hasOwn(dictionary as object, key))
      throw new Error('Invalid plist identity')
  return asPackageIdentity({
    bundleId: fields.CFBundleIdentifier,
    version: fields.CFBundleShortVersionString,
    buildNumber: fields.CFBundleVersion,
  })
}
