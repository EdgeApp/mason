import { Devices, type Device } from '../devices/store.js'
import { asObject, asString } from 'cleaners'
import type { Response } from 'express'
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
} from 'node:fs'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Accounts, randomToken, type Session } from '../auth/accounts.js'
import { Store, digest } from '../store.js'
import {
  asId,
  downloadOnly,
  integer,
  type Build,
  type Format,
} from '../validation.js'
import { escape } from '../view/html.js'

const asGrant = asObject({
  hash: asString,
  build_id: asId,
  session_hash: asString,
  created_at: integer(),
  expires_at: integer(),
  device_id: (v: unknown): number | undefined =>
    v == null ? undefined : asId(v),
})
export class Installations {
  readonly accounts: Accounts
  constructor(readonly store: Store) {
    this.accounts = new Accounts(store)
  }
  create(
    buildId: number,
    session: Session,
    device?: Device,
  ): { token: string; build: Build; expiresAt: number } {
    return this.store.transaction(() => {
      const context = this.accounts.sessionHash(session.hash)
      if (
        context == null ||
        !(context.account.is_admin || context.account.is_tester)
      )
        throw new Error('Tester access required')
      const build = this.store.build(buildId)
      if (
        build == null ||
        !this.store.visible(context.account.id, build.app_id)
      )
        throw new Error('Build unavailable')
      const registry = new Devices(this.store)
      const owned = registry
        .list(context.account.id)
        .find((d) => d.id === device?.id)
      if (!registry.eligible(build, owned))
        throw new Error('Compatible registered device required')
      this.store.db
        .prepare('DELETE FROM install_grants WHERE expires_at<=?')
        .run(this.store.now())
      const token = randomToken(),
        expiresAt = Math.min(
          this.store.now() + 3600000,
          build.expires_at,
          context.session.expires_at,
        )
      this.store.db
        .prepare(
          'INSERT INTO install_grants(hash,build_id,session_hash,created_at,expires_at,device_id) VALUES(?,?,?,?,?,?)',
        )
        .run(
          digest(token),
          build.id,
          session.hash,
          this.store.now(),
          expiresAt,
          device?.id ?? null,
        )
      return { token, build, expiresAt }
    })
  }
  build(token: unknown): Build | undefined {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return undefined
    const row = this.store.db
      .prepare('SELECT * FROM install_grants WHERE hash=? AND expires_at>?')
      .get(digest(token), this.store.now())
    if (row == null) return undefined
    const grant = asGrant(row),
      context = this.accounts.sessionHash(grant.session_hash)
    if (
      context == null ||
      !(context.account.is_admin || context.account.is_tester)
    )
      return undefined
    const found = this.store.build(grant.build_id)
    const build =
      found != null && this.store.visible(context.account.id, found.app_id)
        ? found
        : undefined
    const devices = new Devices(this.store),
      device = devices
        .list(context.account.id)
        .find((d) => d.id === grant.device_id)
    return build != null && devices.eligible(build, device) ? build : undefined
  }
  /** The installer's manifest; its package URL is on `origin`, the server's own by default. */
  manifest(build: Build, token: string, origin?: string): string {
    if (build.format !== 'ipa' || downloadOnly(build) != null)
      throw new Error('Not an iOS application')
    return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${escape(this.url(token, 'artifact', origin))}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${escape(build.bundle_id)}</string><key>bundle-version</key><string>${escape(build.build_number)}</string><key>kind</key><string>software</string><key>title</key><string>${escape(this.store.apps().find((app) => app.id === build.app_id)!.name)}</string></dict></dict></array></dict></plist>`
  }
  url(
    token: string,
    resource: 'manifest.plist' | 'artifact',
    origin = this.store.config.origin,
  ): string {
    return installUrl(origin, token, resource)
  }
  iosUrl(token: string): string {
    return iosInstallUrl(this.store.config.origin, token)
  }
}
/** Where a grant's manifest or package is served on an origin. */
export const installUrl = (
  origin: string,
  token: string,
  resource: 'manifest.plist' | 'artifact',
): string => `${origin}/install/${token}/${resource}`
/** The link that opens iOS's installer on a grant's manifest. */
export const iosInstallUrl = (origin: string, token: string): string =>
  'itms-services://?action=download-manifest&url=' +
  encodeURIComponent(installUrl(origin, token, 'manifest.plist'))
export function byteRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | undefined {
  if (value == null) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (match == null || (match[1] === '' && match[2] === ''))
    throw new Error('Invalid range')
  let start: number, end: number
  if (match[1] === '') {
    const suffix = integer(1)(Number(match[2]))
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = integer()(Number(match[1]))
    end =
      match[2] === ''
        ? size - 1
        : Math.min(integer()(Number(match[2])), size - 1)
  }
  if (start >= size || end < start) throw new Error('Unsatisfiable range')
  return { start, end }
}
/** The Content-Type each package format is served with. */
export const formatTypes: Record<Format, string> = {
  ipa: 'application/octet-stream',
  apk: 'application/vnd.android.package-archive',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  msi: 'application/octet-stream',
  zip: 'application/zip',
}
/** What a request for a grant's file asks: its method, and the ranges it takes. */
export interface FileRequest {
  method: 'GET' | 'HEAD'
  range?: string
  ifRange?: string
  /** The origin a manifest names the package on; the server's own by default. */
  origin?: string
}
/**
 * A grant's file as an answer: its status and headers, and its text or a
 * way to open its bytes. `release` frees what `open` would have used, for
 * an answer whose bytes are not sent.
 */
export interface FileDelivery {
  status: number
  headers: Record<string, string>
  body?: string
  open?: () => Promise<Readable>
  release?: () => void
}
const unavailable = (message: string): FileDelivery => ({
  status: 404,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: message,
})
/**
 * A grant's manifest or package: the manifest only for an iOS app; the
 * package with `ETag`, single ranges (honouring `If-Range`) and `HEAD`. A
 * host keeps builds through its storage driver (disk or S3); a standalone
 * server on its disk, opened once so a swapped file is never followed.
 */
export async function installDelivery(
  store: Store,
  installs: Installations,
  token: string,
  part: 'manifest.plist' | 'artifact',
  request: FileRequest,
): Promise<FileDelivery> {
  const build = installs.build(token)
  if (part === 'manifest.plist') {
    if (build == null || build.format !== 'ipa' || downloadOnly(build) != null)
      return unavailable('Installation link is unavailable or expired')
    return {
      status: 200,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: installs.manifest(build, token, request.origin),
    }
  }
  if (build == null)
    return unavailable('Installation link is unavailable or expired')
  const objects = store.objects
  let fd: number | undefined
  let open: (range?: { start: number; end: number }) => Promise<Readable>
  if (objects != null) {
    const head = await objects.head(build.file_key).catch(() => undefined)
    if (head == null || head.size !== build.size)
      return unavailable('Build is no longer available')
    open = async (range): Promise<Readable> => {
      const found = await objects.get(build.file_key, range)
      if (found == null) throw new Error('Unavailable file')
      return found.stream
    }
  } else {
    try {
      fd = openSync(
        store.filePath(build.file_key),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size !== build.size)
        throw new Error('Unavailable file')
    } catch {
      if (fd != null) closeSync(fd)
      return unavailable('Build is no longer available')
    }
    const local = fd
    open = async (range): Promise<Readable> =>
      createReadStream('', {
        fd: local,
        autoClose: true,
        start: range?.start,
        end: range?.end,
      })
  }
  const release = (): void => {
    if (fd != null) closeSync(fd)
  }
  const etag = `"${build.digest}"`
  const headers: Record<string, string> = {
    'Content-Type': formatTypes[build.format],
    'Content-Disposition': `attachment; filename="build-${build.id}.${build.format}"`,
    'Accept-Ranges': 'bytes',
    ETag: etag,
  }
  let range: ReturnType<typeof byteRange>
  try {
    range = byteRange(
      request.ifRange != null && request.ifRange !== etag
        ? undefined
        : request.range,
      build.size,
    )
  } catch {
    release()
    return {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${build.size}` },
    }
  }
  if (range != null)
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${build.size}`
  headers['Content-Length'] = String(
    range == null ? build.size : range.end - range.start + 1,
  )
  if (request.method === 'HEAD') {
    release()
    return { status: range == null ? 200 : 206, headers }
  }
  return {
    status: range == null ? 200 : 206,
    headers,
    open: async (): Promise<Readable> => await open(range),
    release,
  }
}
/** Sends a grant's file answer: its text, or its bytes once opened. */
export async function sendDelivery(
  res: Response,
  delivery: FileDelivery,
): Promise<void> {
  res.status(delivery.status).set(delivery.headers)
  if (delivery.body != null) {
    res.send(delivery.body)
    return
  }
  if (delivery.open == null) {
    res.end()
    return
  }
  try {
    await pipeline(await delivery.open(), res)
  } catch {
    res.destroy()
  }
}
