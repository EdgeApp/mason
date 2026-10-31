import { crc32 } from 'node:zlib'
export const packageFields = {
  bundleId: 'test.example.app',
  version: '1.2.3',
  buildNumber: '42',
}
export function plist(binary = false): Buffer {
  const fields = {
    CFBundleIdentifier: packageFields.bundleId,
    CFBundleShortVersionString: packageFields.version,
    CFBundleVersion: packageFields.buildNumber,
  }
  if (!binary)
    return Buffer.from(
      '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' +
        Object.entries(fields)
          .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
          .join('') +
        '</dict></plist>',
    )
  const objects = [
    Buffer.from([0xd3, 1, 2, 3, 4, 5, 6]),
    ...[...Object.keys(fields), ...Object.values(fields)].map((value) =>
      Buffer.concat([
        value.length < 15
          ? Buffer.from([0x50 + value.length])
          : Buffer.from([0x5f, 0x10, value.length]),
        Buffer.from(value),
      ]),
    ),
  ]
  const offsets: number[] = []
  let length = 8
  for (const object of objects) {
    offsets.push(length)
    length += object.length
  }
  const trailer = Buffer.alloc(32)
  trailer[6] = 1
  trailer[7] = 1
  trailer.writeBigUInt64BE(BigInt(objects.length), 8)
  trailer.writeBigUInt64BE(BigInt(length), 24)
  return Buffer.concat([
    Buffer.from('bplist00'),
    ...objects,
    Buffer.from(offsets),
    trailer,
  ])
}
/** A binary AndroidManifest.xml for `packageFields`, with `versionCode` (42 by default). */
export function manifest(
  utf16 = false,
  longString = false,
  versionCode = 42,
): Buffer {
  const strings = [
    'manifest',
    'package',
    'versionName',
    'versionCode',
    'http://schemas.android.com/apk/res/android',
    packageFields.bundleId,
    packageFields.version,
    ...(longString ? ['x'.repeat(130)] : []),
  ]
  const enc = (n: number): Buffer =>
    n < 128 ? Buffer.from([n]) : Buffer.from([0x80 | (n >> 8), n & 255])
  const encoded = strings.map((value) =>
    utf16
      ? Buffer.concat([
          Buffer.from([value.length & 255, value.length >> 8]),
          Buffer.from(value, 'utf16le'),
          Buffer.alloc(2),
        ])
      : Buffer.concat([
          enc(value.length),
          enc(Buffer.byteLength(value)),
          Buffer.from(value),
          Buffer.alloc(1),
        ]),
  )
  const start = 28 + strings.length * 4,
    pool = Buffer.alloc(
      start + encoded.reduce((sum, item) => sum + item.length, 0),
    )
  pool.writeUInt16LE(1)
  pool.writeUInt16LE(28, 2)
  pool.writeUInt32LE(pool.length, 4)
  pool.writeUInt32LE(strings.length, 8)
  pool.writeUInt32LE(utf16 ? 0 : 0x100, 16)
  pool.writeUInt32LE(start, 20)
  let pos = 0
  encoded.forEach((item, i) => {
    pool.writeUInt32LE(pos, 28 + i * 4)
    item.copy(pool, start + pos)
    pos += item.length
  })
  const node = Buffer.alloc(36 + 3 * 20)
  node.writeUInt16LE(0x102)
  node.writeUInt16LE(16, 2)
  node.writeUInt32LE(node.length, 4)
  node.writeUInt32LE(0xffffffff, 16)
  node.writeUInt32LE(0, 20)
  node.writeUInt16LE(20, 24)
  node.writeUInt16LE(20, 26)
  node.writeUInt16LE(3, 28)
  for (let i = 0; i < 3; i++) {
    const at = 36 + i * 20
    node.writeUInt32LE(i === 0 ? 0xffffffff : 4, at)
    node.writeUInt32LE(i + 1, at + 4)
    node.writeUInt32LE(0xffffffff, at + 8)
    node.writeUInt16LE(8, at + 12)
    node[at + 15] = i === 2 ? 0x10 : 3
    node.writeUInt32LE(i === 2 ? versionCode : i + 5, at + 16)
  }
  const head = Buffer.alloc(8)
  head.writeUInt16LE(3)
  head.writeUInt16LE(8, 2)
  head.writeUInt32LE(8 + pool.length + node.length, 4)
  return Buffer.concat([head, pool, node])
}
/** Stored ZIP entries with genuine CRCs and central directory, never executable fixtures. */
export function zip(entries: Array<[string, Buffer]>, flags = 0): Buffer {
  const files: Buffer[] = [],
    directory: Buffer[] = []
  let offset = 0
  for (const [name, body] of entries) {
    const filename = Buffer.from(name),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt32LE(crc32(body), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(filename.length, 26)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt32LE(crc32(body), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(filename.length, 28)
    central.writeUInt32LE(offset, 42)
    files.push(local, filename, body)
    directory.push(central, filename)
    offset += local.length + filename.length + body.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(
    directory.reduce((sum, item) => sum + item.length, 0),
    12,
  )
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...files, ...directory, end])
}
export function desktop(format: 'dmg' | 'msi' | 'exe'): Buffer {
  const file = Buffer.alloc(1024)
  if (format === 'dmg') file.write('koly', 512)
  else if (format === 'msi') Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(file)
  else {
    file.write('MZ')
    file.writeUInt32LE(64, 60)
    file.write('PE\0\0', 64)
  }
  return file
}
