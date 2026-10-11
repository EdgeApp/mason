import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { parseBuffer, setMaxObjectCount, setMaxObjectSize } from 'bplist-parser'

/** Bounded plist decoding without DTDs, entities or ambiguous dictionary keys. */
export function decodePlist(bytes: Buffer): Record<string, unknown> {
  if (bytes.length > 1024 * 1024) throw new Error('Property list too large')
  if (bytes.subarray(0, 8).toString() === 'bplist00') {
    setMaxObjectCount(16384)
    setMaxObjectSize(1024 * 1024)
    const root: unknown = parseBuffer<unknown>(bytes)[0]
    if (root == null || typeof root !== 'object' || Array.isArray(root))
      throw new Error('Invalid dictionary')
    return root as Record<string, unknown>
  }
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (
    /<!ENTITY|<!DOCTYPE[^>]*\[/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  )
    throw new Error('Invalid plist')
  type Node = Record<string, Node[] | string>
  const parsed = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: true,
    parseTagValue: false,
    processEntities: true,
  }).parse(xml) as Node[]
  function value(node: Node, depth = 0): unknown {
    if (depth > 12) throw new Error('Property list too deep')
    for (const [tag, raw] of Object.entries(node)) {
      if (tag === 'dict') {
        const entries = raw as Node[]
        const out: Record<string, unknown> = Object.create(null)
        if (entries.length % 2) throw new Error('Invalid dictionary')
        for (let i = 0; i < entries.length; i += 2) {
          const key = value(entries[i]!, depth + 1)
          if (
            typeof key !== 'string' ||
            Object.hasOwn(out, key) ||
            ['__proto__', 'prototype', 'constructor'].includes(key)
          )
            throw new Error('Invalid key')
          out[key] = value(entries[i + 1]!, depth + 1)
        }
        return out
      }
      if (tag === 'array')
        return (raw as Node[]).map((n) => value(n, depth + 1))
      if (tag === 'true') return true
      if (tag === 'false') return false
      if (['string', 'key', 'date', 'data', 'integer'].includes(tag)) {
        const entries = raw as Node[]
        const txt =
          entries.length === 0 ? '' : entries.map((n) => n['#text']).join('')
        return tag === 'integer' ? Number(txt) : txt
      }
    }
    throw new Error('Unsupported plist value')
  }
  const root = parsed.find((n) => Object.hasOwn(n, 'plist'))?.plist as
    | Node[]
    | undefined
  if (root?.length !== 1) throw new Error('Invalid plist root')
  const out = value(root[0]!)
  if (out == null || typeof out !== 'object' || Array.isArray(out))
    throw new Error('Invalid dictionary')
  return out as Record<string, unknown>
}
