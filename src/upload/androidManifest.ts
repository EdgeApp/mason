import { text } from '../validation.js'

/** Reads only bounded Android binary XML manifest attributes; never loads code/resources. */
export function androidManifest(data: Buffer): {
  bundleId: string
  version: string
  buildNumber: string
} {
  function need(offset: number, size: number, end = data.length): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > end
    )
      throw new Error('Malformed Android manifest')
  }
  need(0, 8)
  if (
    data.readUInt16LE(0) !== 3 ||
    data.readUInt16LE(2) !== 8 ||
    data.readUInt32LE(4) !== data.length
  )
    throw new Error('Expected Android binary XML')
  let strings: string[] | undefined
  const utf8 = new TextDecoder('utf-8', { fatal: true }),
    utf16 = new TextDecoder('utf-16le', { fatal: true })
  function string(index: number): string {
    const value = strings?.[index]
    if (value == null) throw new Error('Invalid string reference')
    return value
  }
  for (let offset = 8; offset < data.length; ) {
    need(offset, 8)
    const kind = data.readUInt16LE(offset),
      header = data.readUInt16LE(offset + 2),
      size = data.readUInt32LE(offset + 4),
      end = offset + size
    if (header < 8 || size < header) throw new Error('Invalid XML chunk')
    need(offset, size)
    if (kind === 1) {
      if (strings != null || header < 28) throw new Error('Invalid string pool')
      const count = data.readUInt32LE(offset + 8),
        styles = data.readUInt32LE(offset + 12),
        flags = data.readUInt32LE(offset + 16),
        start = data.readUInt32LE(offset + 20)
      if (
        count > 65536 ||
        styles > 65536 ||
        start < header + (count + styles) * 4
      )
        throw new Error('Invalid string table')
      need(offset + header, (count + styles) * 4, end)
      need(offset + start, 0, end)
      strings = []
      for (let i = 0; i < count; i++) {
        let cursor = offset + start + data.readUInt32LE(offset + header + i * 4)
        function length(bytes: number): number {
          need(cursor, bytes, end)
          let value = bytes === 1 ? data[cursor]! : data.readUInt16LE(cursor)
          cursor += bytes
          const high = bytes === 1 ? 0x80 : 0x8000
          if (value & high) {
            need(cursor, bytes, end)
            value =
              (value & (high - 1)) * (bytes === 1 ? 256 : 65536) +
              (bytes === 1 ? data[cursor]! : data.readUInt16LE(cursor))
            cursor += bytes
          }
          return value
        }
        let value: string
        if (flags & 0x100) {
          length(1)
          const bytes = length(1)
          need(cursor, bytes + 1, end)
          if (data[cursor + bytes] !== 0) throw new Error('Unterminated string')
          value = utf8.decode(data.subarray(cursor, cursor + bytes))
        } else {
          const chars = length(2)
          need(cursor, chars * 2 + 2, end)
          if (data.readUInt16LE(cursor + chars * 2) !== 0)
            throw new Error('Unterminated string')
          value = utf16.decode(data.subarray(cursor, cursor + chars * 2))
        }
        strings.push(value)
      }
    } else if (kind === 0x102) {
      if (header < 16) throw new Error('Invalid XML node')
      need(offset + header, 20, end)
      const base = offset + header,
        name = string(data.readUInt32LE(base + 4))
      if (name === 'manifest') {
        const attributeStart = data.readUInt16LE(base + 8),
          attributeSize = data.readUInt16LE(base + 10),
          count = data.readUInt16LE(base + 12)
        if (attributeStart < 20 || attributeSize < 20 || count > 1024)
          throw new Error('Invalid attributes')
        need(base + attributeStart, count * attributeSize, end)
        const fields = new Map<string, string>()
        for (let i = 0; i < count; i++) {
          const at = base + attributeStart + i * attributeSize,
            ns = data.readUInt32LE(at),
            key = string(data.readUInt32LE(at + 4)),
            raw = data.readUInt32LE(at + 8),
            type = data[at + 15]!,
            value = data.readUInt32LE(at + 16)
          if (
            ![
              'package',
              'versionName',
              'versionCode',
              'versionCodeMajor',
            ].includes(key)
          )
            continue
          if (
            key === 'package'
              ? ns !== 0xffffffff
              : ns === 0xffffffff ||
                string(ns) !== 'http://schemas.android.com/apk/res/android'
          )
            throw new Error('Invalid manifest namespace')
          if (fields.has(key) || data.readUInt16LE(at + 12) !== 8)
            throw new Error('Duplicate manifest attribute')
          const parsed =
            raw !== 0xffffffff
              ? string(raw)
              : type === 3
                ? string(value)
                : type === 0x10 || type === 0x11
                  ? String(value)
                  : undefined
          if (parsed == null)
            throw new Error('Resource-based manifest versions are unsupported')
          fields.set(key, parsed)
        }
        const bundleId = text(256)(fields.get('package')),
          version = text(80)(fields.get('versionName')),
          buildNumber = text(80)(fields.get('versionCode'))
        if (
          !/^\d+$/.test(buildNumber) ||
          Number(buildNumber) < 1 ||
          (fields.has('versionCodeMajor') &&
            fields.get('versionCodeMajor') !== '0')
        )
          throw new Error('Unsupported Android build number')
        return { bundleId, version, buildNumber }
      }
    }
    offset = end
  }
  throw new Error('Manifest identity missing')
}
