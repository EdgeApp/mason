import { Devices, type Device } from '../devices/store.js'
import { asObject, asString } from 'cleaners'
import { Router } from 'express'
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
import { csrf, navigation, sessionContext } from '../auth/routes.js'
import { Store, digest } from '../store.js'
import { asId, integer, type Build, type Format } from '../validation.js'
import { escape, page } from '../view.js'

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
  manifest(build: Build, token: string): string {
    if (build.format !== 'ipa') throw new Error('Not an iOS application')
    return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${escape(this.url(token, 'artifact'))}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${escape(build.bundle_id)}</string><key>bundle-version</key><string>${escape(build.build_number)}</string><key>kind</key><string>software</string><key>title</key><string>${escape(this.store.apps().find((app) => app.id === build.app_id)!.name)}</string></dict></dict></array></dict></plist>`
  }
  url(token: string, resource: 'manifest.plist' | 'artifact'): string {
    return `${this.store.config.origin}/install/${token}/${resource}`
  }
  iosUrl(token: string): string {
    return (
      'itms-services://?action=download-manifest&url=' +
      encodeURIComponent(this.url(token, 'manifest.plist'))
    )
  }
}
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
const mime: Record<Format, string> = {
  ipa: 'application/octet-stream',
  apk: 'application/vnd.android.package-archive',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  msi: 'application/octet-stream',
}
export function installationRoutes(
  store: Store,
  accounts = new Accounts(store),
): Router {
  const router = Router(),
    installs = new Installations(store)
  router.post('/builds/:id/install', (req, res) => {
    const context = sessionContext(req, accounts)
    if (context == null) {
      res.status(401).send('Sign in required')
      return
    }
    csrf(req, store, context.session)
    const build = store.build(asId(Number(req.params.id)))
    const devices = new Devices(store)
    const selected = devices.selected(context.account.id, req.headers.cookie)
    if (build != null && !devices.eligible(build, selected)) {
      res
        .status(409)
        .send(
          page(
            'Prepare your device',
            selected == null
              ? '<section class="card"><p>Register or select your iPhone or iPad before installing this build.</p><a class="button register-device" href="/devices">Register Device</a></section>'
              : `<section class="card"><p>This build does not yet include your device. Mason can prepare a new build of this branch and commit.</p><form method="post" action="/builds/${build.id}/prepare"><input type="hidden" name="csrf" value="${escape(context.session.csrf)}"><button>Prepare for this device</button></form></section>`,
            navigation(context.session, context.account),
          ),
        )
      return
    }
    const result = installs.create(
      asId(Number(req.params.id)),
      context.session,
      selected,
    )
    if (result.build.format !== 'ipa') {
      res.redirect(303, installs.url(result.token, 'artifact'))
      return
    }
    const url = installs.iosUrl(result.token)
    res.send(
      page(
        'Install app',
        `<section class="card"><p>Tap Install on iOS, then confirm the installation on your device.</p><a class="button" data-install href="${escape(url)}">Install on iOS</a><p>This installation link expires within one hour.</p></section>`,
        navigation(context.session, context.account),
        true,
      ),
    )
  })
  router.get('/install/:token/manifest.plist', (req, res) => {
    const build = installs.build(req.params.token)
    if (build == null || build.format !== 'ipa') {
      res.status(404).send('Installation link is unavailable or expired')
      return
    }
    res
      .type('application/xml')
      .send(installs.manifest(build, String(req.params.token)))
  })
  router.get('/install/:token/artifact', async (req, res) => {
    const build = installs.build(req.params.token)
    if (build == null) {
      res.status(404).send('Installation link is unavailable or expired')
      return
    }
    // A host keeps builds through its storage driver (disk or S3); a standalone server on its disk.
    const objects = store.objects
    let fd: number | undefined
    let open: (range?: { start: number; end: number }) => Promise<Readable>
    if (objects != null) {
      const head = await objects.head(build.file_key).catch(() => undefined)
      if (head == null || head.size !== build.size) {
        res.status(404).send('Build is no longer available')
        return
      }
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
        if (!stat.isFile() || stat.size !== build.size) {
          throw new Error('Unavailable file')
        }
      } catch {
        if (fd != null) closeSync(fd)
        res.status(404).send('Build is no longer available')
        return
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
    const etag = `"${build.digest}"`
    res.set({
      'Content-Type': mime[build.format],
      'Content-Disposition': `attachment; filename="build-${build.id}.${build.format}"`,
      'Accept-Ranges': 'bytes',
      ETag: etag,
    })
    let range: ReturnType<typeof byteRange>
    try {
      range = byteRange(
        req.get('if-range') != null && req.get('if-range') !== etag
          ? undefined
          : req.get('range'),
        build.size,
      )
    } catch {
      if (fd != null) closeSync(fd)
      res.status(416).set('Content-Range', `bytes */${build.size}`).end()
      return
    }
    if (range != null)
      res
        .status(206)
        .set('Content-Range', `bytes ${range.start}-${range.end}/${build.size}`)
    res.set(
      'Content-Length',
      String(range == null ? build.size : range.end - range.start + 1),
    )
    if (req.method === 'HEAD') {
      if (fd != null) closeSync(fd)
      res.end()
      return
    }
    try {
      await pipeline(await open(range), res)
    } catch {
      res.destroy()
    }
  })
  return router
}
