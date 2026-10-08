import { asBoolean, asObject, asOptional } from 'cleaners'
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs'
import { Worker } from 'node:worker_threads'
import { open as openZip, type Entry, type ZipFile } from 'yauzl'
import { noSymlinks } from '../config.js'
import { type Format, object, text } from '../validation.js'
import { asPackageIdentity, type PackageIdentity } from './plist.js'

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json }
export type CustomFields = Record<string, Json> | Json[]
export function customFields(value: string): CustomFields {
  if (Buffer.byteLength(value) > 65536)
    throw new Error('Custom metadata too large')
  let count = 0
  function clean(input: unknown, depth = 0): Json {
    if (++count > 4096 || depth > 12)
      throw new Error('Custom metadata too complex')
    if (
      input === null ||
      typeof input === 'boolean' ||
      typeof input === 'string' ||
      (typeof input === 'number' && Number.isFinite(input))
    )
      return input
    if (Array.isArray(input))
      return input.map((value) => clean(value, depth + 1))
    if (typeof input !== 'object' || input == null)
      throw new Error('Invalid custom metadata')
    const out: Record<string, Json> = Object.create(null)
    for (const [key, value] of Object.entries(input)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error('Invalid custom key')
      out[text(256)(key)] = clean(value, depth + 1)
    }
    return out
  }
  const parsed = clean(JSON.parse(value))
  if (parsed == null || typeof parsed !== 'object')
    throw new Error('Expected custom metadata object or array')
  return parsed
}
const asPublisher = object({
  bundleId: text(256),
  version: text(80),
  buildNumber: text(80),
  buildTime: asOptional((value: unknown): string => {
    const stamp = text(40)(value)
    if (
      !/^\d{4}-\d\d-\d\dT/.test(stamp) ||
      !Number.isFinite(Date.parse(stamp))
    )
      throw new Error('Invalid build time')
    return new Date(stamp).toISOString()
  }),
})
async function zippedMetadata(
  file: string,
  format: 'ipa' | 'apk',
): Promise<Buffer> {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    openZip(
      file,
      {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zip) => (error != null ? reject(error) : resolve(zip!)),
    ),
  )
  try {
    if (zip.entryCount > 100000) throw new Error('Too many ZIP entries')
    let selected: Entry | undefined,
      count = 0
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', (entry: Entry) => {
        try {
          if (++count > 100000 || entry.fileName.length > 4096)
            throw new Error('Invalid ZIP directory')
          const matches =
            format === 'apk'
              ? entry.fileName === 'AndroidManifest.xml'
              : /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry.fileName)
          if (matches) {
            if (
              selected != null ||
              entry.uncompressedSize > 1024 * 1024 ||
              entry.isEncrypted()
            )
              throw new Error('Invalid package metadata entry')
            selected = entry
          }
          zip.readEntry()
        } catch (error) {
          reject(error)
        }
      })
      zip.readEntry()
    })
    if (selected == null) throw new Error('Package metadata missing')
    const stream = await new Promise<NodeJS.ReadableStream>(
      (resolve, reject) =>
        zip.openReadStream(selected!, (error, stream) =>
          error != null ? reject(error) : resolve(stream!),
        ),
    )
    const parts: Buffer[] = []
    let size = 0
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > 1024 * 1024) throw new Error('Package metadata too large')
      parts.push(bytes)
    }
    return Buffer.concat(parts)
  } finally {
    zip.close()
  }
}
export async function parseInWorker(
  buffer: Buffer,
  format: 'ipa' | 'apk',
): Promise<PackageIdentity> {
  return await new Promise<PackageIdentity>((resolve, reject) => {
    const worker = new Worker(
      new URL('../../lib/upload/metadataWorker.js', import.meta.url),
      {
        workerData: { buffer, format },
        resourceLimits: {
          maxOldGenerationSizeMb: 32,
          maxYoungGenerationSizeMb: 8,
          stackSizeMb: 2,
        },
        stdout: true,
        stderr: true,
      },
    )
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error('Package metadata timeout'))
    }, 3000)
    worker.once('message', (message: unknown) => {
      clearTimeout(timer)
      void worker.terminate()
      try {
        const result = asObject({
          ok: asBoolean,
          identity: asOptional(asPackageIdentity),
        })(message)
        if (!result.ok || result.identity == null)
          throw new Error('Invalid package identity')
        resolve(result.identity)
      } catch {
        reject(new Error('Invalid package identity'))
      }
    })
    worker.once('error', () => {
      clearTimeout(timer)
      reject(new Error('Package metadata parser failed'))
    })
    worker.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('Package metadata parser stopped'))
    })
  })
}
export async function packageIdentity(
  file: string,
  format: Format,
  custom: CustomFields,
): Promise<PackageIdentity> {
  noSymlinks(file)
  const publisher =
    Array.isArray(custom) || custom.mason == null ? undefined : asPublisher(custom.mason)
  if (format === 'ipa' || format === 'apk') {
    const actual = await parseInWorker(
      await zippedMetadata(file, format),
      format,
    )
    if (
      publisher != null &&
      (publisher.bundleId !== actual.bundleId ||
        publisher.version !== actual.version ||
        publisher.buildNumber !== actual.buildNumber)
    )
      throw new Error('Publisher metadata disagrees with package')
    return actual
  }
  if (publisher == null)
    throw new Error('Publisher identity required for desktop packages')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd),
      head = Buffer.alloc(64)
    if (
      !stat.isFile() ||
      readSync(fd, head, 0, head.length, 0) !== head.length
    )
      throw new Error('Invalid desktop package')
    if (format === 'dmg') {
      const footer = Buffer.alloc(4)
      if (
        stat.size < 512 ||
        readSync(fd, footer, 0, 4, stat.size - 512) !== 4 ||
        footer.toString() !== 'koly'
      )
        throw new Error('Expected UDIF disk image')
    } else if (format === 'msi') {
      if (
        !head.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
      )
        throw new Error('Expected Windows installer')
    } else {
      const position = head.readUInt32LE(60),
        signature = Buffer.alloc(4)
      if (
        head.subarray(0, 2).toString() !== 'MZ' ||
        position > 1024 * 1024 ||
        readSync(fd, signature, 0, 4, position) !== 4 ||
        !signature.equals(Buffer.from('50450000', 'hex'))
      )
        throw new Error('Expected PE executable')
    }
  } finally {
    closeSync(fd)
  }
  // The authenticated publisher supplies identity; signature verification is
  // performed by the build runner, never by executing an uploaded installer.
  return asPackageIdentity(publisher)
}
