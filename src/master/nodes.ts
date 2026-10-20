import { createPublicKey } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { DatabaseSync } from 'node:sqlite'
import { asArray, asNumber, asObject, asOptional, asString } from 'cleaners'
import { parsePairingKey, type Identity } from '../node/identity.js'
import { handshake, HandshakeRefused } from '../link/handshake.js'
import { CLOSE, Link, type MethodTable } from '../link/link.js'
import { dialWire, parseAddress, type Address } from '../link/network.js'
import type { Wire } from '../link/wire.js'
import { version as masonVersion } from '../version.js'
import { migrateMaster } from './schema.js'

export interface NodeRecord {
  id: number
  fingerprint: string
  role: 'worker' | 'host'
  host: string
  port: number
  name: string
  type: string
  labels: string[]
  /** Stages it runs at once. */
  slots: number
  /** Absolute directories custom workspace paths may name on this node. */
  workspaceRoots: string[]
  version: string
  addedAt: number
  lastSeen?: number
  connected: boolean
}

const asRow = asObject({
  id: asNumber,
  fingerprint: asString,
  public_key: asString,
  certificate_hash: asString,
  role: asString,
  host: asString,
  port: asNumber,
  name: asString,
  type: asString,
  labels: asString,
  slots: asOptional(asNumber, 1),
  workspace_roots: asOptional(asString, '[]'),
  version: asString,
  added_at: asNumber,
  last_seen: (value: unknown): number | undefined =>
    value === null ? undefined : asNumber(value),
  removed: asNumber,
})
type Row = ReturnType<typeof asRow>

/** Host recorded for the worker running inside the master's process. */
export const IN_PROCESS = 'in-process'

export interface NodeRegistryOptions {
  /** Methods the master accepts from a peer of this role. */
  methods(role: 'worker' | 'host'): MethodTable
  heartbeatMs?: number
  redialBaseMs?: number
  redialMaxMs?: number
  dialTimeoutMs?: number
  now?: () => number
}

/**
 * The master's nodes: pairing, the links it dials to every paired node, and
 * redialing with jittered, capped backoff while a node is away.
 */
export class NodeRegistry extends EventEmitter {
  private links = new Map<string, Link>()
  private timers = new Map<string, NodeJS.Timeout>()
  private attempts = new Map<string, number>()
  private dialing = new Set<string>()
  private stopped = false
  private readonly now: () => number
  constructor(
    readonly db: DatabaseSync,
    readonly identity: Identity,
    private readonly options: NodeRegistryOptions,
  ) {
    super()
    migrateMaster(db)
    this.now = options.now ?? Date.now
  }

  private rows(): Row[] {
    return this.db
      .prepare('SELECT * FROM nodes WHERE removed=0 ORDER BY id')
      .all()
      .map(asRow)
  }
  private row(fingerprint: string): Row | undefined {
    const found = this.db
      .prepare('SELECT * FROM nodes WHERE fingerprint=?')
      .get(fingerprint)
    return found == null ? undefined : asRow(found)
  }
  private record(row: Row): NodeRecord {
    return {
      id: row.id,
      fingerprint: row.fingerprint,
      role: row.role as 'worker' | 'host',
      host: row.host,
      port: row.port,
      name: row.name,
      type: row.type,
      labels: asArray(asString)(JSON.parse(row.labels)),
      slots: row.slots,
      workspaceRoots: asArray(asString)(JSON.parse(row.workspace_roots)),
      version: row.version,
      addedAt: row.added_at,
      ...(row.last_seen == null ? {} : { lastSeen: row.last_seen }),
      connected: this.links.get(row.fingerprint)?.closed === false,
    }
  }

  list(): NodeRecord[] {
    return this.rows().map((row) => this.record(row))
  }
  get(fingerprint: string): NodeRecord | undefined {
    const row = this.row(fingerprint)
    return row == null || row.removed ? undefined : this.record(row)
  }
  link(fingerprint: string): Link | undefined {
    const link = this.links.get(fingerprint)
    return link?.closed === false ? link : undefined
  }

  /** Dials every paired node. */
  start(): void {
    this.stopped = false
    for (const row of this.rows())
      if (row.host !== IN_PROCESS) void this.dial(row.fingerprint)
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const link of this.links.values()) link.close(CLOSE.normal)
    this.links.clear()
  }

  /**
   * Add node: dials the address, checks its certificate against the pairing
   * key before sending anything, proves the secret, and records the node.
   */
  async add(addressText: string, keyText: string): Promise<NodeRecord> {
    const key = parsePairingKey(keyText)
    const address = parseAddress(addressText)
    const existing = this.row(key.fingerprint)
    if (existing != null && !existing.removed)
      throw new Error('This node is already paired')
    const { wire, exporter } = await dialWire(
      address,
      key.certificateHash,
      this.options.dialTimeoutMs,
    )
    let role: 'worker' | 'host' = 'worker'
    try {
      const peer = await handshake(wire, {
        identity: this.identity,
        role: 'master',
        exporter,
        dialer: true,
        pairingSecret: key.secret,
        acceptHello(hello) {
          if (hello.fingerprint !== key.fingerprint)
            throw new HandshakeRefused('Wrong node')
          role = hello.role as 'worker' | 'host'
        },
      })
      const publicKey = peer.publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64')
      const now = this.now()
      this.db
        .prepare(
          `INSERT INTO nodes(fingerprint,public_key,certificate_hash,role,host,port,name,added_at,last_seen,version)
           VALUES(?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(fingerprint) DO UPDATE SET public_key=excluded.public_key,certificate_hash=excluded.certificate_hash,
             role=excluded.role,host=excluded.host,port=excluded.port,name=excluded.name,added_at=excluded.added_at,
             last_seen=excluded.last_seen,version=excluded.version,removed=0,type='',labels='[]'`,
        )
        .run(
          peer.fingerprint,
          publicKey,
          key.certificateHash,
          role,
          address.host,
          address.port,
          peer.hostname,
          now,
          now,
          peer.version,
        )
      await this.attach(peer.fingerprint, wire, role, peer.version)
      return this.get(peer.fingerprint)!
    } catch (error) {
      wire.close(CLOSE.refused)
      throw error
    }
  }

  /** Records and links the worker running in the master's process, which runs the master's Mason. */
  async attachLocal(
    wire: Wire,
    fingerprint: string,
    name: string,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO nodes(fingerprint,public_key,certificate_hash,role,host,port,name,added_at,last_seen,version)
         VALUES(?,'','','worker',?,0,?,?,?,?)
         ON CONFLICT(fingerprint) DO UPDATE SET last_seen=excluded.last_seen,version=excluded.version,removed=0`,
      )
      .run(fingerprint, IN_PROCESS, name, this.now(), this.now(), masonVersion)
    await this.attach(fingerprint, wire, 'worker', masonVersion)
  }

  /** Changes a node's name, type and labels and sends them to it; slots and workspace roots stay on the master. */
  async assign(
    fingerprint: string,
    value: {
      name?: string
      type?: string
      labels?: string[]
      slots?: number
      workspaceRoots?: string[]
    },
  ): Promise<NodeRecord> {
    const row = this.row(fingerprint)
    if (row == null || row.removed) throw new Error('No such node')
    if (value.slots != null) {
      if (
        !Number.isSafeInteger(value.slots) ||
        value.slots < 1 ||
        value.slots > 64
      )
        throw new Error('slots is 1–64')
      this.db
        .prepare('UPDATE nodes SET slots=? WHERE fingerprint=?')
        .run(value.slots, fingerprint)
    }
    if (value.workspaceRoots != null) {
      const roots = asArray(asString)(value.workspaceRoots)
      if (
        roots.some(
          (root) => !root.startsWith('/') || root.split('/').includes('..'),
        )
      )
        throw new Error('Workspace roots are absolute paths')
      this.db
        .prepare('UPDATE nodes SET workspace_roots=? WHERE fingerprint=?')
        .run(JSON.stringify(roots), fingerprint)
    }
    const assigned = asObject({
      name: asOptional(asString, row.name),
      type: asOptional(asString, row.type),
      labels: asOptional(
        asArray(asString),
        asArray(asString)(JSON.parse(row.labels)),
      ),
    })(value)
    this.db
      .prepare('UPDATE nodes SET name=?,type=?,labels=? WHERE fingerprint=?')
      .run(
        assigned.name,
        assigned.type,
        JSON.stringify(assigned.labels),
        fingerprint,
      )
    await this.link(fingerprint)
      ?.request('node.configure', assigned)
      .catch(() => undefined)
    return this.get(fingerprint)!
  }

  /** Closes the node's link, tells it it was removed, and stops dialing it. */
  remove(fingerprint: string): void {
    const row = this.row(fingerprint)
    if (row == null || row.removed) throw new Error('No such node')
    this.db
      .prepare('UPDATE nodes SET removed=1 WHERE fingerprint=?')
      .run(fingerprint)
    clearTimeout(this.timers.get(fingerprint))
    this.timers.delete(fingerprint)
    const link = this.links.get(fingerprint)
    this.links.delete(fingerprint)
    if (link != null && !link.closed) {
      try {
        link.event('node.removed')
      } finally {
        // Let the event reach the node before the link closes.
        setTimeout(() => link.close(CLOSE.removed), 200).unref()
      }
    }
    this.emit('removed', fingerprint)
  }

  private async attach(
    fingerprint: string,
    wire: Wire,
    role: 'worker' | 'host',
    peerVersion: string,
  ): Promise<void> {
    const link = new Link(wire, {
      localRole: 'master',
      peerRole: role,
      dialer: true,
      methods: this.options.methods(role),
      heartbeatMs: wire.ping == null ? 0 : (this.options.heartbeatMs ?? 15000),
      peer: { fingerprint, version: peerVersion },
    })
    this.links.get(fingerprint)?.close(CLOSE.replaced)
    this.links.set(fingerprint, link)
    this.attempts.delete(fingerprint)
    this.db
      .prepare('UPDATE nodes SET last_seen=?,version=? WHERE fingerprint=?')
      .run(this.now(), peerVersion, fingerprint)
    link.on('close', () => {
      if (this.links.get(fingerprint) === link) this.links.delete(fingerprint)
      this.emit('disconnected', fingerprint)
      if (wire.ping != null) this.schedule(fingerprint)
    })
    const row = this.row(fingerprint)!
    await link
      .request('node.configure', {
        name: row.name,
        type: row.type,
        labels: asArray(asString)(JSON.parse(row.labels)),
      })
      .catch(() => undefined)
    this.emit('connected', fingerprint, link)
  }

  /** Jittered exponential backoff, capped. */
  redialDelay(attempt: number): number {
    const base = this.options.redialBaseMs ?? 1000
    const max = this.options.redialMaxMs ?? 60000
    const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1))
    return Math.min(max, Math.round(raw * (0.75 + Math.random() * 0.5)))
  }

  private schedule(fingerprint: string): void {
    if (this.stopped || this.timers.has(fingerprint)) return
    const row = this.row(fingerprint)
    if (row == null || row.removed) return
    const attempt = (this.attempts.get(fingerprint) ?? 0) + 1
    this.attempts.set(fingerprint, attempt)
    const timer = setTimeout(() => {
      this.timers.delete(fingerprint)
      void this.dial(fingerprint)
    }, this.redialDelay(attempt))
    timer.unref()
    this.timers.set(fingerprint, timer)
  }

  /** Dials a paired node, pinning its recorded certificate and key. */
  async dial(fingerprint: string): Promise<boolean> {
    if (
      this.stopped ||
      this.dialing.has(fingerprint) ||
      this.link(fingerprint) != null
    )
      return false
    const row = this.row(fingerprint)
    if (row == null || row.removed || row.host === IN_PROCESS) return false
    this.dialing.add(fingerprint)
    const address: Address = { host: row.host, port: row.port }
    try {
      const { wire, exporter } = await dialWire(
        address,
        row.certificate_hash,
        this.options.dialTimeoutMs,
      )
      try {
        const stored = createPublicKey({
          key: Buffer.from(row.public_key, 'base64'),
          format: 'der',
          type: 'spki',
        })
        const peer = await handshake(wire, {
          identity: this.identity,
          role: 'master',
          exporter,
          dialer: true,
          acceptHello(hello, publicKey) {
            if (
              hello.fingerprint !== fingerprint ||
              !publicKey
                .export({ type: 'spki', format: 'der' })
                .equals(stored.export({ type: 'spki', format: 'der' }))
            )
              throw new HandshakeRefused('Wrong node')
          },
        })
        if (this.stopped || this.row(fingerprint)?.removed) {
          wire.close(CLOSE.normal)
          return false
        }
        await this.attach(
          fingerprint,
          wire,
          row.role as 'worker' | 'host',
          peer.version,
        )
        return true
      } catch (error) {
        wire.close(CLOSE.refused)
        throw error
      }
    } catch {
      this.schedule(fingerprint)
      return false
    } finally {
      this.dialing.delete(fingerprint)
    }
  }
}
