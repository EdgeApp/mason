import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { androidManifest } from './androidManifest.js'
import {
  desktop,
  manifest,
  packageFields,
  plist,
  zip,
} from './fixtures.test.js'
import { customFields, packageIdentity, parseInWorker } from './metadata.js'
import { plistIdentity } from './plist.js'
let root: string
function file(bytes: Buffer): string {
  const name = path.join(root, 'fixture')
  writeFileSync(name, bytes)
  return name
}
describe('Bounded package identity parsing', () => {
  beforeEach(() => {
    assert(process.env.MASON_TEST_ROOT)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'metadata-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  it('reads XML and binary IPA plists in isolated workers and compares publisher claims', async () => {
    for (const binary of [false, true]) {
      assert.deepEqual(plistIdentity(plist(binary)), packageFields)
      const name = file(
        zip([['Payload/Example.app/Info.plist', plist(binary)]]),
      )
      assert.deepEqual(
        await packageIdentity(name, 'ipa', {}),
        packageFields,
      )
      assert.deepEqual(
        await packageIdentity(name, 'ipa', {
          mason: { ...packageFields, buildTime: '2026-01-02T00:00:00Z' },
        }),
        packageFields,
      )
      await assert.rejects(
        packageIdentity(name, 'ipa', {
          mason: { ...packageFields, version: 'wrong' },
        }),
      )
      await assert.rejects(
        packageIdentity(name, 'ipa', {
          mason: { ...packageFields, buildTime: 'invalid' },
        }),
      )
    }
    for (const value of [
      'invalid',
      '<plist><dict/></plist>',
      plist()
        .toString()
        .replace('<string>42</string>', '<integer>42</integer>'),
      plist()
        .toString()
        .replace(
          '</dict>',
          '<key>CFBundleVersion</key><string>42</string></dict>',
        ),
      '<!DOCTYPE plist [<!ENTITY a "hello">]><plist/>',
    ])
      assert.throws(() => plistIdentity(Buffer.from(value)))
    const extra = plist()
      .toString()
      .replace('</dict>', '<key>Other</key><array/></dict>')
    assert.deepEqual(plistIdentity(Buffer.from(extra)), packageFields)
    await assert.rejects(
      parseInWorker(Buffer.from('bplist00-invalid'), 'ipa'),
    )
    await assert.rejects(
      parseInWorker(Buffer.alloc(1024 * 1024 + 1), 'ipa'),
    )
  })
  it('reads Android UTF8/UTF16 string pools and typed manifest versions', async () => {
    for (const utf16 of [false, true]) {
      const bytes = manifest(utf16, true)
      assert.deepEqual(androidManifest(bytes), packageFields)
      assert.deepEqual(
        await packageIdentity(
          file(zip([['AndroidManifest.xml', bytes]])),
          'apk',
          {},
        ),
        packageFields,
      )
    }
    const bytes = manifest(),
      base = 8 + bytes.readUInt32LE(12)
    const mutate = (at: number, value: number, width = 4): Buffer => {
      const copy = Buffer.from(bytes)
      if (width === 4) copy.writeUInt32LE(value, at)
      else if (width === 2) copy.writeUInt16LE(value, at)
      else copy[at] = value
      return copy
    }
    for (const bad of [
      Buffer.alloc(0),
      mutate(0, 2, 2),
      mutate(4, 1),
      mutate(10, 2, 2),
      mutate(12, 1),
      mutate(16, 65537),
      mutate(28, 1),
      mutate(36, 999999),
      mutate(base + 2, 8, 2),
      mutate(base + 20, 999),
      mutate(base + 24, 1, 2),
      mutate(base + 26, 1, 2),
      mutate(base + 28, 1025, 2),
      mutate(base + 36, 4),
      mutate(base + 56, 0xffffffff),
      mutate(base + 60, 1),
      mutate(base + 48, 1, 2),
      mutate(base + 51, 1, 1),
      mutate(base + 92, 0),
    ])
      assert.throws(() => androidManifest(bad))
    const raw = Buffer.from(bytes)
    raw.writeUInt32LE(5, base + 44)
    assert.deepEqual(androidManifest(raw), packageFields)
    const noManifest = Buffer.from(bytes)
    noManifest.writeUInt32LE(1, base + 20)
    assert.throws(() => androidManifest(noManifest))
    const unterminated = Buffer.from(bytes)
    unterminated[8 + bytes.readUInt32LE(28) + 2 + 'manifest'.length] = 1
    assert.throws(() => androidManifest(unterminated))
  })
  it('rejects missing, duplicate, encrypted, oversized, traversal and malformed ZIP metadata', async () => {
    for (const bytes of [
      Buffer.from('not zip'),
      zip([]),
      zip([['Other', plist()]]),
      zip([
        ['Payload/A.app/Info.plist', plist()],
        ['Payload/B.app/Info.plist', plist()],
      ]),
      zip([['Payload/A.app/Info.plist', plist()]], 1),
      zip([['Payload/A.app/Info.plist', Buffer.alloc(1024 * 1024 + 1)]]),
      zip([['../Info.plist', plist()]]),
    ])
      await assert.rejects(packageIdentity(file(bytes), 'ipa', {}))
    const name = file(zip([['Payload/A.app/Info.plist', plist()]])),
      link = path.join(root, 'link')
    symlinkSync(name, link)
    await assert.rejects(packageIdentity(link, 'ipa', {}))
  })
  it('checks desktop file signatures and requires explicit publisher identity', async () => {
    for (const format of ['dmg', 'msi', 'exe'] as const) {
      const name = file(desktop(format))
      assert.deepEqual(
        await packageIdentity(name, format, { mason: packageFields }),
        packageFields,
      )
      await assert.rejects(packageIdentity(name, format, {}))
      await assert.rejects(
        packageIdentity(file(Buffer.alloc(1024)), format, {
          mason: packageFields,
        }),
      )
      await assert.rejects(
        packageIdentity(file(Buffer.alloc(10)), format, {
          mason: packageFields,
        }),
      )
    }
  })
  it('accepts Zealot arrays while bounding custom JSON and rejecting pollution or deep nesting', () => {
    assert.equal(
      JSON.stringify(customFields('{"value":[null,true,1,"x"]}')),
      '{"value":[null,true,1,"x"]}',
    )
    for (const value of [
      'null',
      '"text"',
      '{"constructor":{}}',
      '{"__proto__":{}}',
      '{"value":1e999}',
      '{"x":' + '['.repeat(13) + '0' + ']'.repeat(13) + '}',
      JSON.stringify({ many: Array(4097).fill(0) }),
      JSON.stringify({ value: 'x'.repeat(65536) }),
    ])
      assert.throws(() => customFields(value))
  })
})
