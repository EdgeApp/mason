import { createHmac, sign, timingSafeEqual, type KeyObject } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import path from 'node:path'
import {
  LinkError,
  type Link,
  type MethodTable,
  type Stream,
} from '../link/link.js'
import type { Changes, Sync } from './changes.js'
import type { MasterDatabase } from './database.js'
import type { Jobs } from './jobs.js'
import { repositoryName } from './mirrors.js'
import type { NodeRegistry } from './nodes.js'
import type { Projects } from './projects.js'
import type { Releases } from './releases.js'
import type { Artifacts, HostAccess } from './artifacts.js'
import type { Format } from '../validation.js'
import { ruleFor } from './rules.js'

/** The only writes a host makes to the master. */
export const outboxKinds = ['device', 'prepare', 'artifact'] as const
export type OutboxKind = (typeof outboxKinds)[number]

export interface WebhookResult {
  status: 'scheduled' | 'unchanged' | 'ignored' | 'ok' | 'refused'
  job?: string
  /** For a refused delivery: the HTTP status the host answers with, and why. */
  http?: 401 | 404 | 422
  reason?: string
}

const refused = (http: 401 | 404 | 422, reason: string): WebhookResult => ({
  status: 'refused',
  http,
  reason,
})

/**
 * The master's side of its host links: it answers a host's sync with the
 * changes since its revision (or a snapshot), pushes new changes as they
 * commit, verifies the GitHub deliveries the host relays, records the host's
 * outbox messages once each, and serves the current release's files.
 */
export class HostLinks {
  /** The revision each connected host has been sent. */
  private readonly sent = new Map<string, number>()
  /** Each host's own web listener, as it reported it: where nodes fetch a mirrored Xcode. */
  private readonly webs = new Map<string, { url: string; pin?: string }>()
  private pending: NodeJS.Timeout | undefined
  private readonly listener = (entity: string): void => {
    if (entity in this.options.changes.entities) this.schedule()
  }

  constructor(
    private readonly options: {
      master: MasterDatabase
      registry: NodeRegistry
      changes: Changes
      projects: Projects
      jobs: Jobs
      releases: Releases
      /** Signs download grants for the host's Xcode mirror. */
      privateKey: KeyObject
      /** The host's public origins, from the `host` setting. */
      origins: () => { origin?: string; workerOrigin?: string }
      /** Publication: what the host's staged uploads and saved artifacts become. */
      artifacts?: Artifacts
      /** How long writes are gathered before a push; well under a second. */
      pushMs?: number
      /** Called after a device or a prepare request arrives, to provision it. */
      onDevices?: () => void
      /** Runs a request the host forwards to the master's API. */
      forward?: (params: unknown, stream: Stream) => Promise<void>
      /** Password sign-in on the host, checked by the master. */
      password?: {
        parameters: (username: unknown) => unknown
        verify: (value: unknown, address: string) => Promise<number>
      }
    },
  ) {}

  start(): void {
    this.options.master.listeners.add(this.listener)
  }
  stop(): void {
    this.options.master.listeners.delete(this.listener)
    clearTimeout(this.pending)
  }

  private schedule(): void {
    if (this.pending != null) return
    this.pending = setTimeout(() => {
      this.pending = undefined
      this.push()
    }, this.options.pushMs ?? 50)
    this.pending.unref()
  }

  /** Sends every connected host what changed since its last revision. */
  push(): void {
    for (const node of this.options.registry.list()) {
      if (node.role !== 'host') continue
      const link = this.options.registry.link(node.fingerprint)
      const revision = this.sent.get(node.fingerprint)
      if (link == null || link.closed || revision == null) continue
      const sync = this.options.changes.since(revision)
      if (sync.revision === revision) continue
      try {
        link.event('changes', sync)
        this.sent.set(node.fingerprint, sync.revision)
      } catch {
        // The host syncs again when its link reopens.
        this.sent.delete(node.fingerprint)
      }
    }
  }

  /** The host a request came from, by the fingerprint its handshake proved. */
  private host(link: Link): string {
    const fingerprint = link.peer?.fingerprint
    const node =
      fingerprint == null ? undefined : this.options.registry.get(fingerprint)
    if (node?.role !== 'host' || link.peerRole !== 'host')
      throw new LinkError('Only a host asks for this', 'not_allowed')
    return node.fingerprint
  }

  /** Verifies a GitHub delivery with the project's webhook secret and schedules a push under its branch rules. */
  webhook(params: unknown): WebhookResult {
    const {
      project: slug,
      event,
      signature,
      body,
    } = (params ?? {}) as Record<string, unknown>
    let project
    try {
      project = this.options.projects.get(String(slug))
    } catch {
      return refused(404, 'Unknown project')
    }
    const secret = this.options.projects.webhookSecret(project.id)
    if (secret == null)
      return refused(401, 'This project has no webhook secret')
    const raw = Buffer.from(String(body ?? ''), 'base64')
    const expected = Buffer.from(
      `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    )
    const given = Buffer.from(String(signature ?? ''))
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return refused(401, 'The delivery signature does not verify')
    if (event === 'ping') return { status: 'ok' }
    if (event !== 'push') return { status: 'ignored' }
    let payload: {
      ref?: unknown
      after?: unknown
      deleted?: unknown
      repository?: { full_name?: unknown }
    }
    try {
      payload = JSON.parse(raw.toString('utf8')) as typeof payload
    } catch {
      return refused(422, 'The delivery is not JSON')
    }
    if (
      typeof payload.repository?.full_name !== 'string' ||
      payload.repository.full_name.toLowerCase() !==
        repositoryName(project.repository).toLowerCase()
    )
      return refused(422, 'The delivery is for another repository')
    const branch = /^refs\/heads\/(.+)$/.exec(String(payload.ref ?? ''))?.[1]
    const commit = String(payload.after ?? '')
    if (
      branch == null ||
      payload.deleted === true ||
      !/^[0-9a-f]{40}$/.test(commit) ||
      /^0+$/.test(commit)
    )
      return { status: 'ignored' }
    if (ruleFor(project.rules, branch)?.mode !== 'automatic')
      return { status: 'ignored' }
    const job = this.options.jobs.automatic(project, branch, commit)
    return job == null
      ? { status: 'unchanged' }
      : { status: 'scheduled', job: job.id }
  }

  /** Records one outbox message; a redelivery returns the same receipt and changes nothing. */
  deliver(
    params: unknown,
    fingerprint: string,
  ): { receipt: string; duplicate: boolean } {
    const { id, kind, payload } = (params ?? {}) as {
      id?: unknown
      kind?: unknown
      payload?: unknown
    }
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id))
      throw new LinkError('An outbox message needs an idempotency ID', 'failed')
    if (!(outboxKinds as readonly unknown[]).includes(kind))
      throw new LinkError(`${String(kind)} is not an outbox message`, 'failed')
    const db = this.options.master.db
    return this.options.master.transaction(() => {
      if (db.prepare('SELECT 1 FROM host_receipts WHERE id=?').get(id) != null)
        return { receipt: id, duplicate: true }
      if (kind === 'device') this.device(payload)
      else if (kind === 'prepare') this.prepare(payload)
      else this.artifact(payload)
      db.prepare(
        'INSERT INTO host_receipts(id,kind,host,payload,received_at) VALUES(?,?,?,?,?)',
      ).run(
        id,
        String(kind),
        fingerprint,
        JSON.stringify(payload ?? null),
        this.options.master.now(),
      )
      // Devices and prepare requests are provisioned once the receipt is written.
      if (kind === 'device' || kind === 'prepare')
        setImmediate(() => this.options.onDevices?.())
      return { receipt: id, duplicate: false }
    })
  }

  /** A device the host registered, with the account it belongs to. */
  private device(payload: unknown): void {
    const value = (payload ?? {}) as Record<string, unknown>
    const text = (field: string, max = 200): string => {
      const out = value[field]
      if (typeof out !== 'string' || out.length === 0 || out.length > max)
        throw new LinkError(`device.${field} is required`, 'failed')
      return out
    }
    const udid = text('udid', 100)
    const account = Number(value.accountId)
    if (!Number.isSafeInteger(account))
      throw new LinkError('device.accountId is required', 'failed')
    const db = this.options.master.db
    const now = this.options.master.now()
    const action = value.action ?? 'register'
    if (action !== 'register') {
      // A change a tester made on the host to a device of theirs.
      const row = db
        .prepare(
          'SELECT d.id FROM devices d JOIN account_devices a ON a.device_id=d.id WHERE d.udid=? AND a.account_id=?',
        )
        .get(udid, account) as { id: number } | undefined
      if (row == null) return
      if (action === 'rename')
        db.prepare(
          'UPDATE account_devices SET name=? WHERE account_id=? AND device_id=?',
        ).run(text('name', 120), account, row.id)
      else if (action === 'retry')
        db.prepare(
          "UPDATE devices SET status='pending',message='',updated_at=? WHERE id=? AND status='error'",
        ).run(now, row.id)
      else if (action === 'remove')
        db.prepare(
          'DELETE FROM account_devices WHERE account_id=? AND device_id=?',
        ).run(account, row.id)
      else
        throw new LinkError(`Unknown device action ${String(action)}`, 'failed')
      this.options.master.change('device', row.id)
      this.options.master.change('account', account)
      return
    }
    db.prepare(
      "INSERT INTO devices(udid,product,model,os_version,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?) ON CONFLICT(udid) DO UPDATE SET product=excluded.product,model=excluded.model,os_version=excluded.os_version,updated_at=excluded.updated_at",
    ).run(udid, text('product'), text('model'), text('osVersion'), now, now)
    const device = Number(
      (
        db.prepare('SELECT id FROM devices WHERE udid=?').get(udid) as {
          id: number
        }
      ).id,
    )
    db.prepare(
      'INSERT INTO account_devices(account_id,device_id,name,created_at) VALUES(?,?,?,?) ON CONFLICT(account_id,device_id) DO UPDATE SET name=excluded.name',
    ).run(account, device, text('name'), now)
    this.options.master.change('device', device)
    this.options.master.change('account', account)
  }

  /** A staged upload, a saved artifact, or a deleted file, from the host's outbox. */
  private artifact(payload: unknown): void {
    const artifacts = this.options.artifacts
    if (artifacts == null)
      throw new LinkError('Artifacts are unavailable', 'failed')
    const value = (payload ?? {}) as { action?: unknown } & Record<
      string,
      unknown
    >
    if (value.action === 'staged')
      artifacts.staged(value as unknown as Parameters<Artifacts['staged']>[0])
    else if (value.action === 'saved')
      artifacts.saved(value as unknown as Parameters<Artifacts['saved']>[0])
    else if (value.action === 'deleted')
      artifacts.deleted(value as Parameters<Artifacts['deleted']>[0])
    else throw new LinkError('Unknown artifact message', 'failed')
  }

  /** "Prepare for this device": the master queues the build request; the device milestone turns it into a pinned job. */
  private prepare(payload: unknown): void {
    const value = (payload ?? {}) as Record<string, unknown>
    const [account, device, build] = [
      value.accountId,
      value.deviceId,
      value.buildId,
    ].map(Number)
    if (![account, device, build].every((n) => Number.isSafeInteger(n)))
      throw new LinkError(
        'prepare needs accountId, deviceId and buildId',
        'failed',
      )
    this.options.master.db
      .prepare(
        'INSERT OR IGNORE INTO device_build_requests(account_id,device_id,build_id,created_at) VALUES(?,?,?,?)',
      )
      .run(account!, device!, build!, this.options.master.now())
  }

  /**
   * Asks the host something about its storage: undefined when the cluster has
   * no host; an error when it has one that is not connected.
   */
  async askHost<T>(
    method: string,
    params: unknown,
    timeoutMs = 30_000,
  ): Promise<T | undefined> {
    if (!this.options.registry.list().some((node) => node.role === 'host'))
      return undefined
    const host = this.connectedHost()
    if (host == null) throw new Error('the host is not connected')
    return (await host.link.request(method, params, timeoutMs)) as T
  }

  /** A connected host and its link, for relaying an Xcode to its mirror. */
  private connectedHost(): { fingerprint: string; link: Link } | undefined {
    for (const node of this.options.registry.list()) {
      const link = this.options.registry.link(node.fingerprint)
      if (
        node.role === 'host' &&
        link != null &&
        !link.closed &&
        this.sent.has(node.fingerprint)
      )
        return { fingerprint: node.fingerprint, link }
    }
    return undefined
  }

  /**
   * How workers reach the host: the worker origin (or the public origin),
   * with the pin the host reported when it serves its own certificate.
   */
  access(): HostAccess | undefined {
    const origins = this.options.origins()
    const origin = origins.workerOrigin ?? origins.origin
    if (origin == null) return undefined
    const pin = [...this.webs.values()].find((web) => web.pin != null)?.pin
    return { origin, ...(pin == null ? {} : { pin }) }
  }

  mirrored(version: string): boolean {
    return (
      this.options.master.db
        .prepare('SELECT 1 FROM xcode_mirrors WHERE version=?')
        .get(version) != null
    )
  }

  /**
   * Relays a node's first download of an Xcode to the host's storage. The
   * node's stream carries the `.xip`; the host verifies the digest.
   */
  async mirror(
    params: { version: string; sha256: string; size: number },
    from: Stream,
  ): Promise<void> {
    if (
      !/^\d+(?:\.\d+){0,2}(?:-beta\d*|-rc\d*)?$/.test(params.version) ||
      !/^[0-9a-f]{64}$/.test(params.sha256)
    )
      throw new Error('Invalid mirror request')
    if (this.mirrored(params.version)) throw new Error('Already mirrored')
    const host = this.connectedHost()
    if (host == null) throw new Error('No host is connected')
    const to = host.link.openStream('mirror.put', params)
    const done = new Promise<void>((resolve, reject) => {
      to.once('end', () => resolve())
      to.once('abort', (reason: string) => reject(new Error(reason)))
    })
    done.catch(() => undefined)
    await new Promise<void>((resolve, reject) => {
      // Chunks are written in order; the host's window paces the node.
      let chain = Promise.resolve()
      from.on('data', (chunk: Buffer) => {
        chain = chain.then(async () => await to.write(chunk))
      })
      from.once('end', () => {
        chain.then(() => {
          to.end()
          resolve()
        }, reject)
      })
      from.once('abort', (reason: string) => {
        to.abort(reason)
        reject(new Error(reason))
      })
    })
    await done
    this.options.master.db
      .prepare(
        'INSERT OR REPLACE INTO xcode_mirrors(version,sha256,size,at) VALUES(?,?,?,?)',
      )
      .run(
        params.version,
        params.sha256,
        params.size,
        this.options.master.now(),
      )
  }

  /**
   * When Apple's session has lapsed: a download of the mirrored `.xip` from
   * the host over HTTPS, with a grant the master signed for that one version
   * for an hour, pinned when the node reaches the host's own listener.
   */
  mirrorAuthorization(
    version: string,
  ): { url: string; cookie: string; pin?: string } | undefined {
    if (!this.mirrored(version)) return undefined
    const host = this.connectedHost()
    if (host == null) return undefined
    const web = this.webs.get(host.fingerprint)
    const origins = this.options.origins()
    const base =
      web?.pin != null ? web.url : (origins.workerOrigin ?? origins.origin)
    if (base == null) return undefined
    const claims = Buffer.from(
      JSON.stringify({
        version,
        expires: this.options.master.now() + 3_600_000,
      }),
    ).toString('base64url')
    const signature = sign(
      null,
      Buffer.from(`mason-xcode-grant-v1\n${claims}`),
      this.options.privateKey,
    ).toString('base64url')
    return {
      url: `${base}/xcode/Xcode-${version}.xip?grant=${claims}.${signature}`,
      cookie: '',
      ...(web?.pin != null && web.url === base ? { pin: web.pin } : {}),
    }
  }

  methods(): MethodTable {
    return {
      requests: {
        'host.sync': (params, link): Sync => {
          const fingerprint = this.host(link)
          const web = (params as { web?: { url?: unknown; pin?: unknown } })
            ?.web
          if (typeof web?.url === 'string' && /^https?:\/\//.test(web.url))
            this.webs.set(fingerprint, {
              url: web.url.replace(/\/$/, ''),
              ...(typeof web.pin === 'string' ? { pin: web.pin } : {}),
            })
          const revision = Number(
            (params as { revision?: unknown })?.revision ?? 0,
          )
          const sync = this.options.changes.since(
            Number.isSafeInteger(revision) ? revision : 0,
          )
          this.sent.set(fingerprint, sync.revision)
          return sync
        },
        'webhook.github': (params, link): WebhookResult => {
          this.host(link)
          return this.webhook(params)
        },
        /** A username's hashing parameters, for the host's sign-in page. */
        'auth.parameters': (params, link): unknown => {
          this.host(link)
          if (this.options.password == null)
            throw new LinkError('Password sign-in is unavailable', 'failed')
          return this.options.password.parameters(
            (params as { username?: unknown } | null)?.username,
          )
        },
        /** Checks a password the host received; answers only whose it is. */
        'auth.password': async (
          params,
          link,
        ): Promise<{ accountId: number }> => {
          this.host(link)
          if (this.options.password == null)
            throw new LinkError('Password sign-in is unavailable', 'failed')
          const { username, clientHash, address } = (params ?? {}) as Record<
            string,
            unknown
          >
          try {
            return {
              accountId: await this.options.password.verify(
                { username, clientHash },
                `host:${String(address ?? '')}`,
              ),
            }
          } catch (error) {
            const refused = error as Error & { retryAt?: number }
            throw new LinkError(
              JSON.stringify({
                error: refused.message,
                ...(refused.retryAt == null
                  ? {}
                  : { retryAt: refused.retryAt }),
              }),
              'not_allowed',
            )
          }
        },
        'outbox.deliver': (
          params,
          link,
        ): { receipt: string; duplicate: boolean } =>
          this.deliver(params, this.host(link)),
        /** A staged pipeline upload, published at once while the link is up. */
        'artifacts.staged': (params, link): unknown => {
          this.host(link)
          if (this.options.artifacts == null)
            throw new LinkError('Artifacts are unavailable', 'failed')
          try {
            return this.options.artifacts.staged(
              params as Parameters<Artifacts['staged']>[0],
            )
          } catch (error) {
            throw new LinkError((error as Error).message, 'failed')
          }
        },
        /** A Zealot-API upload the host staged, published through the master. */
        'artifacts.zealot': (params, link): unknown => {
          this.host(link)
          if (this.options.artifacts == null)
            throw new LinkError('Artifacts are unavailable', 'failed')
          try {
            return this.options.artifacts.zealot(
              params as Parameters<Artifacts['zealot']>[0] & { format: Format },
            )
          } catch (error) {
            throw new LinkError((error as Error).message, 'failed')
          }
        },
      },
      streams: {
        /** A request the host forwards to the master's API (`api.forward`). */
        'api.forward': async (stream, params, link): Promise<void> => {
          try {
            this.host(link)
          } catch (error) {
            stream.abort((error as Error).message)
            return
          }
          if (this.options.forward == null) {
            stream.abort('The master does not forward requests')
            return
          }
          await this.options.forward(params, stream)
        },
        /** A file of the current release, for the host to serve `/install.sh` and the tarballs. */
        'release.get': async (stream, params, link): Promise<void> => {
          try {
            this.host(link)
            const version = this.options.releases.current()
            const name = String((params as { file?: unknown })?.file ?? '')
            if (version == null) throw new Error('No current release')
            if (
              !(name in this.options.releases.files(version)) &&
              name !== 'SHA256SUMS'
            )
              throw new Error('Not a file of the current release')
            const file = path.join(this.options.releases.root, version, name)
            if (!existsSync(file))
              throw new Error('The release file is not stored')
            for await (const chunk of createReadStream(file))
              await stream.write(chunk as Buffer)
            stream.end()
          } catch (error) {
            stream.abort((error as Error).message)
          }
        },
      },
    }
  }
}
