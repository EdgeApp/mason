import { createHash, verify, type KeyObject } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { Accounts } from '../auth/accounts.js'
import { Providers } from '../auth/providers.js'
import type { Link, MethodTable, Stream } from '../link/link.js'
import type { Sync } from '../master/changes.js'
import { HostCache } from './cache.js'
import { Outbox } from './outbox.js'
import { Webhooks } from './webhooks.js'
import { HostArtifacts, HostObjects } from './artifacts.js'
import type { DeviceRelay } from '../devices/store.js'

export interface HostOptions {
  dir: string
  /** The master's current link. */
  link: () => Link | undefined
  now?: () => number
  /** How OIDC requests are made; tests trust a fixture provider. */
  transport?: typeof fetch
  log?: (line: string) => void
  /** The paired master's public key, which signs Xcode mirror grants. */
  masterKey?: () => KeyObject | undefined
  /** How S3 requests are made; tests reach a fake S3. */
  storageFetch?: typeof fetch
  /** Whether the host runs with `--test-endpoints`: only then may an extra Profile Service root be trusted. */
  testEndpoints?: boolean
}

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * The host role: its cache of the master's data, kept current over the
 * master's link, and what it serves from it while the master is away.
 */
export class HostRuntime {
  readonly cache: HostCache
  readonly accounts: Accounts
  readonly outbox: Outbox
  /** Device registrations and preparation requests, sent to the master. */
  readonly devices: DeviceRelay
  readonly webhooks: Webhooks
  readonly objects: HostObjects
  readonly artifacts: HostArtifacts
  private synced: Link | undefined
  private offset = 0
  private timer: NodeJS.Timeout | undefined
  private providerCache: { key: string; providers: Providers } | undefined
  private releasing: Promise<void> | undefined
  private stopped = false
  /** The host's own web listener: its URL and, when it serves its own certificate, the pin. */
  web: { url: string; pin?: string } | undefined

  constructor(readonly options: HostOptions) {
    this.cache = new HostCache(options.dir, () => this.now())
    this.accounts = new Accounts(this.cache.store)
    this.outbox = new Outbox(
      this.cache.db,
      () => this.now(),
      (line) => this.options.log?.(line),
    )
    this.objects = new HostObjects(
      this.cache,
      path.join(options.dir, 'storage'),
      options.storageFetch,
    )
    this.cache.store.objects = this.objects
    this.devices = {
      enqueue: (kind, payload): void => {
        this.outbox.enqueue(kind, payload)
        void this.outbox.flush(this.options.link())
      },
    }
    this.trustRoots()
    this.artifacts = new HostArtifacts({
      cache: this.cache,
      objects: this.objects,
      outbox: this.outbox,
      dir: options.dir,
      link: (): Link | undefined => this.options.link(),
      online: (): boolean => this.online(),
      masterKey: (): KeyObject | undefined => this.options.masterKey?.(),
    })
    this.webhooks = new Webhooks({
      db: this.cache.db,
      now: (): number => this.now(),
      link: (): Link | undefined => this.options.link(),
      known: (project): boolean =>
        this.cache.db
          .prepare('SELECT 1 FROM projects WHERE slug=?')
          .get(project) != null,
    })
  }

  /** The host's clock; test endpoints can move it forward. */
  now(): number {
    return (this.options.now ?? Date.now)() + this.offset
  }
  advanceClock(ms: number): void {
    this.offset += ms
  }
  resetClock(): void {
    this.offset = 0
  }

  /** Whether the master's link is open and this host has synced over it. */
  online(): boolean {
    const link = this.options.link()
    return link != null && !link.closed && link === this.synced
  }

  /** Offline past the grace window: the host serves its maintenance page. */
  maintenance(): boolean {
    if (this.online()) return false
    const synced = this.cache.syncedAt()
    if (synced == null) return false
    return (
      this.now() - synced >
      (this.cache.host()?.offlineGraceHours ?? 72) * 3_600_000
    )
  }

  /** The sign-in methods the master enabled, with the host's origin. */
  providers(): Providers {
    const origin = this.cache.store.config.origin
    const methods = this.cache.signInMethods()
    const key = JSON.stringify([origin, methods])
    if (this.providerCache?.key !== key)
      this.providerCache = {
        key,
        providers: new Providers(origin, methods, this.options.transport),
      }
    return this.providerCache.providers
  }

  private get extraRootFile(): string {
    return path.join(this.options.dir, 'device-trust-extra.pem')
  }

  /**
   * Device callbacks verify against Apple's Profile Service roots, plus an
   * extra root only when the host runs with `--test-endpoints`; a stored
   * extra root is otherwise ignored with a warning.
   */
  private trustRoots(): void {
    const apple = readFileSync(
      new URL('../../src/devices/apple-roots.pem', import.meta.url),
      'utf8',
    )
    let extra = ''
    if (existsSync(this.extraRootFile)) {
      if (this.options.testEndpoints === true)
        extra = readFileSync(this.extraRootFile, 'utf8')
      else
        this.options.log?.(
          'Ignoring the extra Profile Service trust root: this host was not started with --test-endpoints',
        )
    }
    const file = path.join(this.options.dir, 'device-trust.pem')
    writeFileSync(file, apple.trimEnd() + '\n' + extra, { mode: 0o600 })
    ;(this.cache.store.config as { devices?: unknown }).devices = {
      trustStoreFile: file,
      openssl: 'openssl',
    }
  }

  /** Trusts one more Profile Service root (a test fixture's); refused without `--test-endpoints`. */
  setTrustRoot(pem: string): void {
    if (this.options.testEndpoints !== true)
      throw new Error(
        'An extra Profile Service trust root can only be set on a host started with --test-endpoints (400)',
      )
    if (!/-----BEGIN CERTIFICATE-----/.test(pem))
      throw new Error('The trust root is a PEM certificate')
    writeFileSync(this.extraRootFile, pem, { mode: 0o600 })
    this.trustRoots()
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.online()) {
        this.cache.touch()
        void this.outbox.flush(this.options.link())
      }
    }, 60_000)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    await this.releasing
    this.cache.close()
  }

  /** On each link open: sync from the cache's revision, then deliver what waited. */
  async connected(): Promise<void> {
    const link = this.options.link()
    if (link == null || this.stopped) return
    const sync = (await link.request(
      'host.sync',
      {
        revision: this.cache.revision(),
        ...(this.web == null ? {} : { web: this.web }),
      },
      5 * 60_000,
    )) as Sync
    if (this.stopped) return
    this.apply(sync)
    this.synced = link
    await this.outbox.flush(link)
    await this.webhooks.flush()
  }

  apply(sync: Sync): void {
    if (this.stopped) return
    this.cache.apply(sync)
    void this.refreshRelease()
    void this.artifacts.cleanup().catch((error: unknown) => {
      this.options.log?.(`Artifact cleanup failed: ${(error as Error).message}`)
    })
  }

  methods(): MethodTable {
    return {
      events: {
        changes: (params): void => {
          this.apply(params as Sync)
        },
      },
      streams: {
        /** An Xcode a node downloaded first, relayed by the master into the host's storage. */
        'mirror.put': async (stream, params): Promise<void> => {
          try {
            await this.storeXcode(params, stream)
            stream.end()
          } catch (error) {
            stream.abort((error as Error).message)
          }
        },
      },
    }
  }

  xcodeFile(version: string): string {
    return path.join(
      this.options.dir,
      'storage',
      'xcode',
      `Xcode-${version}.xip`,
    )
  }

  private async storeXcode(params: unknown, stream: Stream): Promise<void> {
    const { version, sha256 } = (params ?? {}) as {
      version?: unknown
      sha256?: unknown
    }
    if (
      typeof version !== 'string' ||
      !/^\d+(?:\.\d+){0,2}(?:-beta\d*|-rc\d*)?$/.test(version)
    )
      throw new Error('Invalid Xcode version')
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
      throw new Error('Invalid digest')
    const file = this.xcodeFile(version)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const partial = `${file}.partial`
    const out = createWriteStream(partial, { mode: 0o600 })
    const hash = createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        out.write(chunk)
      })
      stream.once('end', () => {
        out.end(() => resolve())
      })
      stream.once('abort', (reason: string) => {
        out.destroy()
        reject(new Error(reason))
      })
    })
    if (hash.digest('hex') !== sha256) {
      rmSync(partial, { force: true })
      throw new Error('The Xcode archive does not match its digest')
    }
    renameSync(partial, file)
    this.options.log?.(`Mirrored Xcode ${version}`)
  }

  /** Whether a grant the master signed allows downloading this Xcode now. */
  granted(version: string, grant: unknown): boolean {
    const key = this.options.masterKey?.()
    if (key == null || typeof grant !== 'string') return false
    const [claims, signature] = grant.split('.')
    if (claims == null || signature == null) return false
    try {
      if (
        !verify(
          null,
          Buffer.from(`mason-xcode-grant-v1\n${claims}`),
          key,
          Buffer.from(signature, 'base64url'),
        )
      )
        return false
      const parsed = JSON.parse(
        Buffer.from(claims, 'base64url').toString(),
      ) as { version?: unknown; expires?: unknown }
      return (
        parsed.version === version &&
        typeof parsed.expires === 'number' &&
        parsed.expires > this.now()
      )
    } catch {
      return false
    }
  }

  private releaseRoot(): string {
    return path.join(this.options.dir, 'storage', 'releases')
  }

  /** The current release's directory once every file is here and verified. */
  currentRelease():
    | { version: string; dir: string; files: Record<string, string> }
    | undefined {
    const row = this.cache.db
      .prepare("SELECT version,files FROM host_release WHERE id='current'")
      .get() as { version: string; files: string } | undefined
    if (row == null) return undefined
    const dir = path.join(this.releaseRoot(), row.version)
    if (!existsSync(path.join(dir, '.complete'))) return undefined
    return {
      version: row.version,
      dir,
      files: JSON.parse(row.files) as Record<string, string>,
    }
  }

  /** Fetches the master's current release, verifying each file, and drops the others. */
  refreshRelease(): Promise<void> {
    return (this.releasing ??= (async (): Promise<void> => {
      const row = this.cache.db
        .prepare("SELECT version,files FROM host_release WHERE id='current'")
        .get() as { version: string; files: string } | undefined
      const root = this.releaseRoot()
      mkdirSync(root, { recursive: true, mode: 0o700 })
      for (const name of readdirSync(root))
        if (name !== row?.version)
          rmSync(path.join(root, name), { recursive: true, force: true })
      if (row == null) return
      const dir = path.join(root, row.version)
      if (existsSync(path.join(dir, '.complete'))) return
      const link = this.options.link()
      if (link == null || link.closed) return
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const files = JSON.parse(row.files) as Record<string, string>
      for (const [name, digest] of [
        ...Object.entries(files),
        ['SHA256SUMS', ''],
      ] as Array<[string, string]>) {
        const target = path.join(dir, name)
        if (
          existsSync(target) &&
          (digest === '' || (await sha256File(target)) === digest)
        )
          continue
        const partial = `${target}.partial`
        const out = createWriteStream(partial, { mode: 0o600 })
        const stream = link.openStream('release.get', { file: name })
        await new Promise<void>((resolve, reject) => {
          stream.on('data', (chunk: Buffer) => out.write(chunk))
          stream.once('end', () => {
            stream.end()
            out.end(() => resolve())
          })
          stream.once('abort', (reason: string) => {
            out.destroy()
            reject(new Error(reason))
          })
        })
        if (digest !== '' && (await sha256File(partial)) !== digest) {
          rmSync(partial, { force: true })
          throw new Error(`${name} does not match the release's digest`)
        }
        renameSync(partial, target)
      }
      writeFileSync(path.join(dir, '.complete'), '')
      this.options.log?.(`Serving Mason ${row.version} at /install.sh`)
    })()
      .catch((error: unknown) => {
        this.options.log?.(
          `Could not fetch the current release: ${(error as Error).message}`,
        )
      })
      .finally(() => {
        this.releasing = undefined
      }))
  }
}
