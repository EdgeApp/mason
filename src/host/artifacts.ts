import { execFile } from 'node:child_process'
import { createHash, randomBytes, type KeyObject } from 'node:crypto'
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import express, { Router, type Request, type Response } from 'express'
import { sessionContext } from '../auth/routes.js'
import { baseEnvironment } from '../builder/config.js'
import type { Link } from '../link/link.js'
import {
  formatsFor,
  InvalidClaims,
  verifyClaims,
  type DownloadClaims,
  type GrantClaims,
  type UploadClaims,
} from '../master/artifacts.js'
import type { StorageSetting } from '../master/hostSettings.js'
import { digest } from '../store.js'
import { packageIdentity } from '../upload/metadata.js'
import { inspectProvisioning } from '../devices/provisioning.js'
import type { Build, Format } from '../validation.js'
import type { HostCache } from './cache.js'
import type { Outbox } from './outbox.js'
import { DiskStorage, S3Storage, type StorageDriver } from './storage.js'

const run = promisify(execFile)
const RUN_BYTES = 2 * 1024 ** 3
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The host's builds and saved artifacts: kept through the storage driver the
 * master's `storage` setting names (its disk, or S3-compatible storage),
 * each object read back from the driver it was written with. On disk, builds
 * stay flat in `<storage>/files`, the layout the store counts and prunes, and
 * a run's artifacts (keys under `runs/`) go in `<storage>/runs`.
 */
export class HostObjects {
  /** An S3 driver per storage setting, by the setting's JSON. */
  private readonly s3 = new Map<string, S3Storage>()
  /** The S3 setting used last, for objects recorded before stores were. */
  private lastS3: string | undefined
  private readonly disk: DiskStorage
  private readonly runs: DiskStorage

  constructor(
    private readonly cache: HostCache,
    storage: string,
    private readonly fetchImpl?: typeof fetch,
  ) {
    mkdirSync(path.join(storage, 'files'), { recursive: true, mode: 0o700 })
    this.disk = new DiskStorage(path.join(storage, 'files'))
    this.runs = new DiskStorage(storage)
    cache.db.exec(`CREATE TABLE IF NOT EXISTS host_objects(
      key TEXT PRIMARY KEY, driver TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT`)
    // Each S3 object names the bucket and key it was written with, so a later
    // storage change still serves it from there.
    cache.db.exec(`CREATE TABLE IF NOT EXISTS host_object_stores(
      id INTEGER PRIMARY KEY, config TEXT NOT NULL UNIQUE) STRICT`)
    const columns = cache.db
      .prepare('PRAGMA table_info(host_objects)')
      .all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'store'))
      cache.db.exec('ALTER TABLE host_objects ADD COLUMN store INTEGER')
  }

  /** The disk driver for a key: a run's artifacts beside the build files. */
  private diskFor(key: string): StorageDriver {
    return key.startsWith('runs/') ? this.runs : this.disk
  }

  /** The S3 driver for a storage setting's `s3` value, as JSON. */
  private s3Driver(config: string): S3Storage {
    let driver = this.s3.get(config)
    if (driver == null) {
      const s3 = JSON.parse(config) as NonNullable<StorageSetting['s3']>
      driver = new S3Storage(
        {
          ...s3,
          // A bucket name cannot prefix an IP address or localhost, so those use path-style URLs.
          pathStyle:
            /^https?:\/\/(\d+\.\d+\.\d+\.\d+|localhost|\[[0-9a-f:]+\])(:\d+)?$/i.test(
              s3.endpoint,
            ),
        },
        this.fetchImpl,
      )
      this.s3.set(config, driver)
    }
    return driver
  }

  /** The `storage` setting's S3 value as JSON, when it names S3. */
  private currentS3(): string | undefined {
    const setting = this.cache.setting<StorageSetting>('storage')
    if (setting?.driver !== 's3' || setting.s3 == null) return undefined
    const config = JSON.stringify(setting.s3)
    this.lastS3 = config
    return config
  }

  /** The driver the `storage` setting names now, for a key. */
  current(object = ''): StorageDriver {
    const config = this.currentS3()
    return config == null ? this.diskFor(object) : this.s3Driver(config)
  }

  private driverOf(key: string): StorageDriver {
    const row = this.cache.db
      .prepare(
        'SELECT o.driver, s.config FROM host_objects o LEFT JOIN host_object_stores s ON s.id=o.store WHERE o.key=?',
      )
      .get(key) as { driver: string; config: string | null } | undefined
    if (row?.driver !== 's3') return this.diskFor(key)
    if (row.config != null) return this.s3Driver(row.config)
    // Recorded before stores were: the current S3 storage, or the last one.
    const config = this.currentS3() ?? this.lastS3
    return config == null ? this.diskFor(key) : this.s3Driver(config)
  }

  async put(key: string, file: string, sha256: string): Promise<void> {
    const config = this.currentS3()
    const driver = config == null ? this.diskFor(key) : this.s3Driver(config)
    await driver.put(key, file)
    let store: number | null = null
    if (config != null) {
      this.cache.db
        .prepare('INSERT OR IGNORE INTO host_object_stores(config) VALUES(?)')
        .run(config)
      store = (
        this.cache.db
          .prepare('SELECT id FROM host_object_stores WHERE config=?')
          .get(config) as { id: number }
      ).id
    }
    this.cache.db
      .prepare(
        'INSERT OR REPLACE INTO host_objects(key,driver,size,digest,created_at,store) VALUES(?,?,?,?,?,?)',
      )
      .run(
        key,
        driver.kind,
        statSync(file).size,
        sha256,
        this.cache.now(),
        store,
      )
  }
  async head(key: string): Promise<{ size: number } | undefined> {
    return await this.driverOf(key).head(key)
  }
  async get(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{ stream: Readable; size: number } | undefined> {
    return await this.driverOf(key).get(key, range)
  }
  async delete(key: string): Promise<void> {
    await this.driverOf(key).delete(key)
    this.cache.db.prepare('DELETE FROM host_objects WHERE key=?').run(key)
  }

  /** The stores whose S3 settings name this bucket at this endpoint. */
  private storesOf(store: { bucket: string; endpoint: string }): number[] {
    return (
      this.cache.db
        .prepare('SELECT id,config FROM host_object_stores')
        .all() as Array<{ id: number; config: string }>
    )
      .filter((row) => {
        try {
          const s3 = JSON.parse(row.config) as {
            bucket?: unknown
            endpoint?: unknown
          }
          return s3.bucket === store.bucket && s3.endpoint === store.endpoint
        } catch {
          return false
        }
      })
      .map((row) => row.id)
  }

  /** The keys of the files written to a store. */
  keys(store: { bucket: string; endpoint: string }): string[] {
    const ids = this.storesOf(store)
    if (ids.length === 0) return []
    return (
      this.cache.db
        .prepare(
          `SELECT key FROM host_objects WHERE store IN (${ids.map(() => '?').join(',')}) ORDER BY key`,
        )
        .all(...ids) as Array<{ key: string }>
    ).map((row) => row.key)
  }

  /** Drops the records of a store's files and the store; the files themselves stay where they are. */
  forget(store: { bucket: string; endpoint: string }): number {
    const ids = this.storesOf(store)
    let removed = 0
    for (const id of ids) {
      const keys = (
        this.cache.db
          .prepare('SELECT key FROM host_objects WHERE store=?')
          .all(id) as Array<{ key: string }>
      ).map((row) => row.key)
      // Saved artifacts the host listed from that store go with it.
      for (const key of keys)
        try {
          this.cache.db
            .prepare('DELETE FROM host_artifacts WHERE storage_key=?')
            .run(key)
        } catch {}
      removed += Number(
        this.cache.db.prepare('DELETE FROM host_objects WHERE store=?').run(id)
          .changes,
      )
      this.cache.db.prepare('DELETE FROM host_object_stores WHERE id=?').run(id)
    }
    return removed
  }

  /** Files and bytes per store, and on the host's disk. */
  usage(): Array<{
    bucket?: string
    endpoint?: string
    files: number
    bytes: number
  }> {
    const rows = this.cache.db
      .prepare(
        'SELECT o.driver, s.config, count(*) AS files, coalesce(sum(o.size),0) AS bytes FROM host_objects o LEFT JOIN host_object_stores s ON s.id=o.store GROUP BY o.driver, s.config',
      )
      .all() as Array<{
      driver: string
      config: string | null
      files: number
      bytes: number
    }>
    // Files written before stores were recorded name no store: left out.
    return rows
      .filter((row) => row.driver !== 's3' || row.config != null)
      .map((row) => {
        if (row.driver !== 's3' || row.config == null)
          return { files: Number(row.files), bytes: Number(row.bytes) }
        const s3 = JSON.parse(row.config) as {
          bucket: string
          endpoint: string
        }
        return {
          bucket: s3.bucket,
          endpoint: s3.endpoint,
          files: Number(row.files),
          bytes: Number(row.bytes),
        }
      })
  }
}

/** Streams a request body to a file, hashing it, up to a limit. */
async function receive(
  req: Request,
  file: string,
  limit: number,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      size += chunk.length
      if (size > limit) {
        callback(new Refused(413, 'The upload is larger than allowed'))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    await pipeline(
      req,
      counter,
      createWriteStream(file, { flags: 'wx', mode: 0o600 }),
    )
  } catch (error) {
    rmSync(file, { force: true })
    throw error instanceof Refused
      ? error
      : new Refused(400, 'The upload was interrupted')
  }
  return { size, sha256: hash.digest('hex') }
}

export interface ArtifactRoutesOptions {
  cache: HostCache
  objects: HostObjects
  outbox: Outbox
  dir: string
  link: () => Link | undefined
  online: () => boolean
  masterKey: () => KeyObject | undefined
}

/**
 * Uploads from stages, downloads by grant, saved artifacts and the report
 * viewer.
 */
export class HostArtifacts {
  constructor(private readonly options: ArtifactRoutesOptions) {
    options.cache.db.exec(`CREATE TABLE IF NOT EXISTS host_staged(
      reservation TEXT PRIMARY KEY, digest TEXT NOT NULL, staged_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS host_artifacts(
      run TEXT NOT NULL, name TEXT NOT NULL, stage TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
      digest TEXT NOT NULL, visible_to TEXT, entry TEXT, storage_key TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(run, name)) STRICT`)
  }

  private key(): KeyObject {
    const key = this.options.masterKey()
    if (key == null)
      throw new Refused(503, 'This host is not paired with a master')
    return key
  }

  private claims<T extends UploadClaims | GrantClaims | DownloadClaims>(
    token: unknown,
    kind: T['kind'],
  ): T {
    try {
      return verifyClaims<T>(token, this.key(), kind, this.options.cache.now())
    } catch (error) {
      if (error instanceof InvalidClaims) throw new Refused(401, error.message)
      throw error
    }
  }

  /** Tells the master about a staged upload: at once while the link is up, through the outbox otherwise. */
  private async confirm(
    payload: Record<string, unknown>,
  ): Promise<Build | undefined> {
    const link = this.options.link()
    if (this.options.online() && link != null)
      try {
        return (await link.request('artifacts.staged', payload)) as Build
      } catch (error) {
        if (!link.closed) throw new Refused(409, (error as Error).message)
      }
    this.options.outbox.enqueue('artifact', { action: 'staged', ...payload })
    void this.options.outbox.flush(this.options.link())
    return undefined
  }

  /**
   * `POST /api/artifacts/:reservation`: a stage's publication, with a grant
   * (the master named its digest and size) or, while the master is away,
   * with the stage's token and the upload fields.
   */
  async publication(req: Request, res: Response): Promise<void> {
    const reservation = String(req.params.reservation)
    if (!/^[0-9a-f]{32}$/.test(reservation))
      throw new Refused(404, 'Unknown reservation')
    const authorization = /^Bearer (\S+)$/.exec(
      req.get('authorization') ?? '',
    )?.[1]
    let expected: {
      app: string
      platform: string
      format: Format
      version: string
      buildNumber: string
      digest?: string
      size?: number
      limit: number
    }
    if (authorization != null) {
      const grant = this.claims<GrantClaims>(authorization, 'grant')
      if (grant.reservation !== reservation)
        throw new Refused(401, 'The grant is for another reservation')
      expected = { ...grant, limit: grant.size }
    } else {
      const token = this.claims<UploadClaims>(req.get('x-mason-token'), 'stage')
      const listed = token.reservations.find(
        (entry) => entry.id === reservation,
      )
      if (listed == null)
        throw new Refused(403, 'The reservation is not in the stage’s token')
      const format = String(req.get('x-mason-format') ?? '') as Format
      if (!(formatsFor[listed.platform] ?? []).includes(format))
        throw new Refused(400, `A ${listed.platform} build is not ${format}`)
      const buildNumber = String(req.get('x-mason-build-number') ?? '')
      if (buildNumber !== listed.buildNumber)
        throw new Refused(
          400,
          `The build number ${buildNumber} is not the reserved ${listed.buildNumber}`,
        )
      expected = {
        app: listed.app,
        platform: listed.platform,
        format,
        version: String(req.get('x-mason-version') ?? ''),
        buildNumber,
        limit: token.bytes,
      }
    }
    const used = this.options.cache.db
      .prepare('SELECT digest FROM host_staged WHERE reservation=?')
      .get(reservation) as { digest: string } | undefined
    const staging = path.join(
      this.options.dir,
      'storage',
      'staging',
      `${reservation}-${randomBytes(4).toString('hex')}.${expected.format}`,
    )
    const received = await receive(req, staging, expected.limit)
    try {
      if (
        expected.digest != null &&
        (received.sha256 !== expected.digest || received.size !== expected.size)
      )
        throw new Refused(400, 'The file does not match its grant')
      if (used != null && used.digest !== received.sha256)
        throw new Refused(409, 'The reservation is already used')
      // IPA and APK identity comes from the package; a desktop package's from the publication and its app.
      const desktop = !['ipa', 'apk'].includes(expected.format)
      let identity
      try {
        identity = await packageIdentity(
          staging,
          expected.format,
          desktop
            ? {
                mason: {
                  bundleId: expected.app,
                  version: expected.version,
                  buildNumber: expected.buildNumber,
                },
              }
            : {},
        )
      } catch (error) {
        throw new Refused(400, (error as Error).message)
      }
      if (identity.bundleId !== expected.app)
        throw new Refused(400, 'The package is not the reservation’s app')
      if (identity.buildNumber !== expected.buildNumber)
        throw new Refused(
          400,
          `The package's build number ${identity.buildNumber} is not the reserved ${expected.buildNumber}`,
        )
      // An ad hoc IPA's devices and expiry go with it, so the host offers it only to those devices.
      const devices = this.options.cache.store.config.devices
      const provisioning =
        expected.format === 'ipa' && devices != null
          ? await inspectProvisioning(
              staging,
              devices.trustStoreFile,
              devices.openssl,
            ).catch(() => undefined)
          : undefined
      if (provisioning != null && provisioning.appId !== identity.bundleId)
        throw new Refused(400, 'The provisioning profile is for another app')
      const fileKey = `${reservation}.${expected.format}`
      await this.options.objects.put(fileKey, staging, received.sha256)
      this.options.cache.db
        .prepare(
          'INSERT OR REPLACE INTO host_staged(reservation,digest,staged_at) VALUES(?,?,?)',
        )
        .run(reservation, received.sha256, this.options.cache.now())
      const changelog = req.get('x-mason-changelog')
      const build = await this.confirm({
        reservation,
        digest: received.sha256,
        size: received.size,
        format: expected.format,
        version: identity.version,
        buildNumber: identity.buildNumber,
        bundleId: identity.bundleId,
        fileKey,
        ...(changelog == null
          ? {}
          : { changelog: decodeURIComponent(changelog) }),
        ...(provisioning == null ? {} : { provisioning }),
      })
      const origin = this.options.cache.store.config.origin
      if (build == null) {
        res.status(202).json({
          staged: true,
          reservation,
          visible: false,
          url: `${origin}/`,
        })
        return
      }
      res.status(201).json({
        buildId: build.id,
        url: `${origin}/apps/${build.app_id}`,
        installUrl: `${origin}/apps/${build.app_id}/branches/${Buffer.from(build.branch).toString('base64url')}?platform=${build.platform}`,
        visible: true,
      })
    } finally {
      rmSync(staging, { force: true })
    }
  }

  /** `POST /api/runs/:run/artifacts/:name`: a saved artifact (a tar.gz of the stage's files), with the stage token. */
  async save(req: Request, res: Response): Promise<void> {
    const runId = String(req.params.run)
    const name = String(req.params.name)
    if (!NAME.test(name))
      throw new Refused(
        400,
        'An artifact name is 1–100 letters, digits, dots, dashes or underscores',
      )
    const token = this.claims<UploadClaims>(req.get('x-mason-token'), 'stage')
    if (token.run !== runId)
      throw new Refused(403, 'The token is for another run')
    const kind = String(req.get('x-mason-kind') ?? 'file')
    if (!['file', 'report', 'log', 'data'].includes(kind))
      throw new Refused(400, 'Unknown artifact kind')
    const visibleTo = req.get('x-mason-visible-to')
    if (visibleTo != null && visibleTo !== 'testers')
      throw new Refused(400, 'visibleTo is testers')
    const entry =
      req.get('x-mason-entry') ?? (kind === 'report' ? 'index.html' : undefined)
    if (
      entry != null &&
      (entry.split('/').includes('..') || entry.startsWith('/'))
    )
      throw new Refused(400, 'Invalid report entry')
    const staging = path.join(
      this.options.dir,
      'storage',
      'staging',
      `${runId}-${name}-${randomBytes(4).toString('hex')}.tar.gz`,
    )
    const received = await receive(
      req,
      staging,
      Math.min(token.bytes, RUN_BYTES),
    )
    const storageKey = `runs/${runId}/${name}.tar.gz`
    try {
      await this.options.objects.put(storageKey, staging, received.sha256)
      // A report's files are kept one by one so the viewer serves each.
      if (kind === 'report') {
        const unpacked = `${staging}.d`
        mkdirSync(unpacked, { recursive: true, mode: 0o700 })
        try {
          await run('tar', ['-xzf', staging, '-C', unpacked], {
            env: baseEnvironment(),
          })
          const walk = async (dir: string, prefix: string): Promise<void> => {
            for (const entryName of readdirSync(path.join(unpacked, dir), {
              withFileTypes: true,
            })) {
              const relative =
                dir === '' ? entryName.name : `${dir}/${entryName.name}`
              if (entryName.isDirectory()) await walk(relative, prefix)
              else if (entryName.isFile()) {
                const file = path.join(unpacked, relative)
                const served =
                  base === '' ? relative : relative.slice(base.length + 1)
                await this.options.objects.put(
                  `${prefix}/${served}`,
                  file,
                  digest(Buffer.from(served)),
                )
              }
            }
          }
          // Files saved under one folder (`report/**`) are served from inside it.
          const top = readdirSync(unpacked, { withFileTypes: true })
          const base =
            top.length === 1 && top[0]!.isDirectory() ? top[0]!.name : ''
          await walk(base, `runs/${runId}/${name}/files`)
        } finally {
          rmSync(unpacked, { recursive: true, force: true })
        }
      }
    } finally {
      rmSync(staging, { force: true })
    }
    const record = {
      run: runId,
      stage: token.stage,
      name,
      kind,
      size: received.size,
      digest: received.sha256,
      ...(visibleTo == null ? {} : { visibleTo }),
      ...(entry == null ? {} : { entry }),
      storageKey,
    }
    this.options.cache.db
      .prepare(
        'INSERT OR REPLACE INTO host_artifacts(run,name,stage,kind,size,digest,visible_to,entry,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        runId,
        name,
        token.stage,
        kind,
        received.size,
        received.sha256,
        visibleTo ?? null,
        entry ?? null,
        storageKey,
        this.options.cache.now(),
      )
    this.options.outbox.enqueue('artifact', { action: 'saved', ...record })
    void this.options.outbox.flush(this.options.link())
    res.status(201).json({ name, size: received.size, digest: received.sha256 })
  }

  /** `GET /api/artifacts/download?grant=`: one stored object the master granted. */
  async download(req: Request, res: Response): Promise<void> {
    const claims = this.claims<DownloadClaims>(req.query.grant, 'download')
    const found = await this.options.objects.get(claims.key)
    if (found == null)
      throw new Refused(404, 'The artifact is no longer stored')
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(found.size),
      'X-Mason-Digest': claims.digest,
    })
    await pipeline(found.stream, res)
  }

  routes(accounts: Parameters<typeof sessionContext>[1]): Router {
    const router = Router()
    const handle =
      (
        body: (req: Request, res: Response) => Promise<void>,
      ): express.RequestHandler =>
      (req, res) => {
        body(req, res).catch((error: unknown) => {
          if (res.headersSent) {
            res.destroy()
            return
          }
          const known = error instanceof Refused
          res
            .status(known ? error.status : 500)
            .json({ error: known ? error.message : 'The request failed' })
        })
      }
    router.post(
      '/api/artifacts/:reservation',
      handle(async (req, res) => await this.publication(req, res)),
    )
    router.post(
      '/api/runs/:run/artifacts/:name',
      handle(async (req, res) => await this.save(req, res)),
    )
    router.get(
      '/api/artifacts/download',
      handle(async (req, res) => await this.download(req, res)),
    )
    const lookup = (
      req: Request,
    ): { storage_key: string; kind: string; entry: string | null } => {
      const context = sessionContext(req, accounts)
      if (context == null) throw new Refused(401, 'Sign in required')
      const row = this.options.cache.db
        .prepare(
          'SELECT storage_key,kind,entry,visible_to FROM host_artifacts WHERE run=? AND name=?',
        )
        .get(String(req.params.run), String(req.params.name)) as
        | {
            storage_key: string
            kind: string
            entry: string | null
            visible_to: string | null
          }
        | undefined
      const role = (
        this.options.cache.db
          .prepare('SELECT role FROM accounts WHERE id=?')
          .get(context.account.id) as { role: string }
      ).role
      if (row == null || (role === 'tester' && row.visible_to !== 'testers'))
        throw new Refused(404, 'No such artifact')
      return row
    }
    router.get(
      '/api/runs/:run/artifacts',
      handle(async (req, res) => {
        const context = sessionContext(req, accounts)
        if (context == null) throw new Refused(401, 'Sign in required')
        const role = (
          this.options.cache.db
            .prepare('SELECT role FROM accounts WHERE id=?')
            .get(context.account.id) as { role: string }
        ).role
        const rows = this.options.cache.db
          .prepare(
            'SELECT name,stage,kind,size,digest,visible_to,entry,created_at FROM host_artifacts WHERE run=? ORDER BY name',
          )
          .all(String(req.params.run)) as Array<Record<string, unknown>>
        res.json(
          rows.filter(
            (row) => role !== 'tester' || row.visible_to === 'testers',
          ),
        )
      }),
    )
    router.get(
      '/runs/:run/artifacts/:name',
      handle(async (req, res) => {
        const row = lookup(req)
        const found = await this.options.objects.get(row.storage_key)
        if (found == null)
          throw new Refused(404, 'The artifact is no longer stored')
        res.set({
          'Content-Type': 'application/gzip',
          'Content-Disposition': `attachment; filename="${String(req.params.name)}.tar.gz"`,
          'Content-Length': String(found.size),
        })
        await pipeline(found.stream, res)
      }),
    )
    // The report viewer: a saved HTML report under its run, sandboxed so it can neither script the host nor read its cookies.
    router.get(
      /^\/runs\/([^/]+)\/artifacts\/([^/]+)\/view(?:\/(.*))?$/,
      handle(async (req, res) => {
        req.params.run = String((req.params as Record<string, string>)[0])
        req.params.name = String((req.params as Record<string, string>)[1])
        const row = lookup(req)
        if (row.kind !== 'report') throw new Refused(404, 'Not a report')
        const file =
          String((req.params as Record<string, string>)[2] ?? '') ||
          row.entry ||
          'index.html'
        if (
          file
            .split('/')
            .some((part) => part === '..' || part === '' || part === '.')
        )
          throw new Refused(404, 'No such file')
        const found = await this.options.objects.get(
          `runs/${req.params.run}/${req.params.name}/files/${file}`,
        )
        if (found == null) throw new Refused(404, 'No such file')
        const types: Record<string, string> = {
          html: 'text/html',
          css: 'text/css',
          js: 'text/javascript',
          json: 'application/json',
          png: 'image/png',
          svg: 'image/svg+xml',
          txt: 'text/plain',
          xml: 'application/xml',
        }
        res.set({
          'Content-Type':
            types[file.split('.').pop() ?? ''] ?? 'application/octet-stream',
          'Content-Security-Policy':
            "sandbox; default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
          'Content-Length': String(found.size),
        })
        await pipeline(found.stream, res)
      }),
    )
    return router
  }

  /** Builds the master marked `deleting` and saved artifacts it expired: the files go, then the outbox says so once. */
  async cleanup(): Promise<void> {
    const db = this.options.cache.db
    for (const row of db
      .prepare("SELECT id,file_key FROM builds WHERE state='deleting'")
      .all() as Array<{ id: number; file_key: string }>) {
      await this.options.objects.delete(row.file_key)
      db.prepare("UPDATE builds SET state='deleted' WHERE id=?").run(row.id)
      this.options.outbox.enqueue('artifact', {
        action: 'deleted',
        build: row.id,
      })
    }
    for (const row of db
      .prepare(
        'SELECT job_id,name,storage_key FROM run_artifacts WHERE deleting=1',
      )
      .all() as Array<{ job_id: string; name: string; storage_key: string }>) {
      await this.options.objects.delete(row.storage_key)
      for (const key of db
        .prepare('SELECT key FROM host_objects WHERE key LIKE ?')
        .all(`runs/${row.job_id}/${row.name}/files/%`) as Array<{
        key: string
      }>)
        await this.options.objects.delete(key.key)
      db.prepare('DELETE FROM host_artifacts WHERE run=? AND name=?').run(
        row.job_id,
        row.name,
      )
      db.prepare(
        'UPDATE run_artifacts SET deleting=2 WHERE job_id=? AND name=?',
      ).run(row.job_id, row.name)
      this.options.outbox.enqueue('artifact', {
        action: 'deleted',
        run: row.job_id,
        name: row.name,
      })
    }
    void this.options.outbox.flush(this.options.link())
  }
}
