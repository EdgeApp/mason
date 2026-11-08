import { createHmac, randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { Accounts, Session } from '../auth/accounts.js'
import { randomToken } from '../auth/accounts.js'
import {
  installDelivery,
  Installations,
  type FileDelivery,
} from '../catalog/install.js'
import {
  CatalogRefused,
  StoreCatalogSource,
  type CatalogAnswer,
  type DeviceAction,
} from '../catalog/source.js'
import type { DeviceRelay } from '../devices/store.js'
import type { MethodTable, Stream } from '../link/link.js'
import { asId, asPlatform } from '../validation.js'
import { refusal } from './builds.js'
import type { HostCache } from './cache.js'

type Params = Record<string, unknown>

const optionalId = (value: unknown): number | undefined =>
  value == null ? undefined : asId(value)

/** An origin as the master names itself: scheme, host and port only. */
function asOrigin(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string') throw new Error('Invalid origin')
  const url = new URL(value)
  if (!/^https?:$/.test(url.protocol) || url.origin !== value)
    throw new Error('Invalid origin')
  return value
}

/**
 * Install apps and Devices for the master: the host answers each
 * `catalog.*` and `devices.*` request from its cache for the account the
 * master's session authenticated. Grants and registration requests hang
 * off a relay session, one per master session, keyed by an HMAC of the
 * master session's digest with a secret of the host's. A relay session
 * never signs a browser in on the host; it ends when the master session
 * signs out, and with its account's permission version.
 */
export class HostCatalog {
  constructor(
    private readonly options: {
      cache: HostCache
      accounts: Accounts
      devices: DeviceRelay
      /** Throws a 503 refusal before the first sync and past the grace window. */
      ready: () => void
      /** Brings the cache up to the master now: a session newer than it waits for this. */
      catchUp?: () => Promise<void>
    },
  ) {}

  private get db(): HostCache['db'] {
    return this.options.cache.db
  }

  /** The host's secret for relay session keys, made once. */
  private secret(): string {
    const read = (): string | undefined =>
      (
        this.db
          .prepare("SELECT value FROM host_meta WHERE key='relay_secret'")
          .get() as { value: string } | undefined
      )?.value
    const found = read()
    if (found != null) return found
    this.db
      .prepare(
        "INSERT OR IGNORE INTO host_meta(key,value) VALUES('relay_secret',?)",
      )
      .run(randomBytes(32).toString('base64url'))
    return read()!
  }

  /** The relay session's key for a master session's digest. */
  relayHash(id: string): string {
    return createHmac('sha256', this.secret()).update(id).digest('hex')
  }

  /**
   * Creates or refreshes the relay session for the master session the
   * request names, with that session's expiry and permission version.
   */
  relaySession(accountId: number, value: unknown): Session {
    const input = (value ?? {}) as Params
    const { id, expiresAt, permissionVersion } = input
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{64}$/.test(id) ||
      !Number.isSafeInteger(expiresAt) ||
      !Number.isSafeInteger(permissionVersion)
    )
      throw new CatalogRefused(400, 'A master session is required')
    const store = this.options.cache.store
    const hash = this.relayHash(id)
    store.transaction(() => {
      if (
        this.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId) ==
        null
      )
        throw new CatalogRefused(403, 'This account is not on the host yet')
      const existing = this.db
        .prepare('SELECT account_id,relayed FROM sessions WHERE hash=?')
        .get(hash) as { account_id: number; relayed: number } | undefined
      if (existing == null)
        this.db
          .prepare(
            'INSERT INTO sessions(hash,account_id,permission_version,csrf,created_at,expires_at,relayed) VALUES(?,?,?,?,?,?,1)',
          )
          .run(
            hash,
            accountId,
            Number(permissionVersion),
            randomToken(),
            store.now(),
            Number(expiresAt),
          )
      else if (existing.account_id !== accountId || existing.relayed !== 1)
        throw new CatalogRefused(403, 'That session is not this account’s')
      else
        this.db
          .prepare(
            'UPDATE sessions SET permission_version=?,expires_at=? WHERE hash=?',
          )
          .run(Number(permissionVersion), Number(expiresAt), hash)
    })
    const context = this.options.accounts.sessionHash(hash)
    if (context == null) throw new CatalogRefused(403, 'Tester access required')
    return context.session
  }

  /**
   * A master session can be newer than this host's copy of its account (a
   * role changed, and the person signed in again before the host synced):
   * catch up first, and if the copy is still behind, say so rather than
   * refuse the person.
   */
  private async current(accountId: number, value: unknown): Promise<void> {
    const wanted = Number((value as Params | null)?.permissionVersion)
    const cached = (): number =>
      Number(
        (
          this.db
            .prepare('SELECT permission_version FROM accounts WHERE id=?')
            .get(accountId) as { permission_version: number } | undefined
        )?.permission_version ?? -1,
      )
    if (!Number.isSafeInteger(wanted) || cached() >= wanted) return
    await this.options.catchUp?.()
    if (cached() < wanted)
      throw new CatalogRefused(
        503,
        'The host is catching up with the master; try again shortly',
      )
  }

  /** Ends a master session's relay session: its grants and registration requests go with it. */
  endSession(id: unknown): void {
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) return
    this.db
      .prepare('DELETE FROM sessions WHERE hash=? AND relayed=1')
      .run(this.relayHash(id))
  }

  /** The live master sessions a sync is listing, and when its first page came. */
  private live: { hashes: Set<string>; since: number } | undefined

  /**
   * One page of the master's live sessions. After the last, ends every relay
   * session none of them stands for, except one made since the list began.
   */
  liveSessions(value: unknown): void {
    const { sessions, first, last } = (value ?? {}) as Params
    if (!Array.isArray(sessions)) return
    if (first === true)
      this.live = { hashes: new Set(), since: this.options.cache.store.now() }
    const live = this.live
    if (live == null) return
    for (const id of sessions)
      if (typeof id === 'string' && /^[0-9a-f]{64}$/.test(id))
        live.hashes.add(this.relayHash(id))
    if (last !== true) return
    this.live = undefined
    const stale = this.db
      .prepare('SELECT hash FROM sessions WHERE relayed=1 AND created_at<?')
      .all(live.since) as Array<{ hash: string }>
    const drop = this.db.prepare('DELETE FROM sessions WHERE hash=?')
    for (const { hash } of stale) if (!live.hashes.has(hash)) drop.run(hash)
  }

  private async answer<T>(
    params: unknown,
    run: (
      source: StoreCatalogSource,
      accountId: number,
      input: Params,
    ) => Promise<T>,
  ): Promise<CatalogAnswer<T>> {
    try {
      this.options.ready()
      const input = (params ?? {}) as Params
      const accountId = asId(input.accountId)
      await this.current(accountId, input.session)
      const session = this.relaySession(accountId, input.session)
      const source = new StoreCatalogSource(this.options.cache.store, {
        session,
        relay: this.options.devices,
        grants: input.grants !== false,
      })
      return { ok: await run(source, accountId, input) }
    } catch (error) {
      if (error instanceof CatalogRefused)
        return { refused: { status: error.status, message: error.message } }
      const { status, error: message } = refusal(error)
      return {
        refused:
          status === 500
            ? { status: 400, message: (error as Error).message }
            : { status, message },
      }
    }
  }

  /** The link requests the host answers for the master's catalog pages. */
  requests(): NonNullable<MethodTable['requests']> {
    return {
      'catalog.apps': async (params) =>
        await this.answer(params, (source, account) => source.apps(account)),
      'catalog.app': async (params) =>
        await this.answer(params, (source, account, input) =>
          source.app(account, asId(input.appId)),
        ),
      'catalog.branch': async (params) =>
        await this.answer(params, (source, account, input) =>
          source.branch(
            account,
            asId(input.appId),
            String(input.branchKey),
            asPlatform(input.platform),
            optionalId(input.deviceId),
          ),
        ),
      'catalog.install': async (params) =>
        await this.answer(params, (source, account, input) =>
          source.install(
            account,
            asId(input.buildId),
            optionalId(input.deviceId),
          ),
        ),
      'catalog.prepare': async (params) =>
        await this.answer(params, (source, account, input) =>
          source.prepare(account, asId(input.buildId), asId(input.deviceId)),
        ),
      /** The master session signed out or expired. */
      'catalog.endSession': (params): { ok: true } => {
        this.endSession((params as Params | null)?.session)
        return { ok: true }
      },
      'catalog.liveSessions': (params): { ok: true } => {
        this.liveSessions(params)
        return { ok: true }
      },
      'devices.list': async (params) =>
        await this.answer(params, (source, account, input) =>
          source.devices(account, optionalId(input.deviceId)),
        ),
      'devices.profile': async (params) =>
        await this.answer(params, (source, account, input) =>
          source.deviceProfile(account, asOrigin(input.origin)),
        ),
      'devices.action': async (params) =>
        await this.answer(params, (source, account, input) =>
          source.deviceAction(
            account,
            asId(input.id),
            String(input.action) as DeviceAction,
            typeof input.name === 'string' ? input.name : undefined,
          ),
        ),
      'devices.complete': async (params) =>
        await this.answer(params, (source, account, input) =>
          source.complete(account, String(input.token)),
        ),
    }
  }

  /**
   * `catalog.installFile`: a grant's manifest or package for the master,
   * as one JSON line `{ status, headers }` and then its text or bytes, each
   * chunk paced by the master's credit. A grant carries no session.
   */
  async stream(stream: Stream, params: unknown): Promise<void> {
    let source: Readable | undefined
    stream.once('abort', () => source?.destroy())
    try {
      const input = (params ?? {}) as Params
      let delivery: FileDelivery
      try {
        this.options.ready()
        const part = input.part === 'manifest.plist' ? input.part : 'artifact'
        const origin = asOrigin(input.origin)
        delivery = await installDelivery(
          this.options.cache.store,
          new Installations(this.options.cache.store),
          String(input.token),
          part,
          {
            method: input.method === 'HEAD' ? 'HEAD' : 'GET',
            ...(typeof input.range === 'string' ? { range: input.range } : {}),
            ...(typeof input.ifRange === 'string'
              ? { ifRange: input.ifRange }
              : {}),
            ...(origin == null ? {} : { origin }),
          },
        )
      } catch (error) {
        const { status, error: message } = refusal(error)
        delivery = {
          status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: message }),
        }
      }
      if (delivery.open != null)
        try {
          source = await delivery.open()
        } catch {
          delivery.release?.()
          delivery = {
            status: 404,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: 'Build is no longer available',
          }
        }
      const body =
        delivery.body == null ? undefined : Buffer.from(delivery.body)
      await stream.write(
        Buffer.from(
          JSON.stringify({
            status: delivery.status,
            headers: {
              ...delivery.headers,
              ...(body == null
                ? {}
                : { 'Content-Length': String(body.length) }),
            },
          }) + '\n',
        ),
      )
      if (body != null) await stream.write(body)
      if (source != null)
        for await (const chunk of source) await stream.write(chunk as Buffer)
      stream.end()
    } catch (error) {
      source?.destroy()
      stream.abort((error as Error).message)
    }
  }
}
