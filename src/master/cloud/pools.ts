import { randomBytes } from 'node:crypto'
import { createCertificate, certificateHash } from '../../node/certificate.js'
import type { MasterDatabase } from '../database.js'
import type { NodeRegistry } from '../nodes.js'
import type { SettingsArea, SettingValue } from '../settings.js'
import {
  DigitalOcean,
  ProviderError,
  SNAPSHOT_GB_MONTH,
  type CloudProvider,
} from './digitalocean.js'

/** One pool: machines of one node type, made on demand and reused like in-house computers. */
export interface PoolSetting {
  name: string
  /** The node type its machines serve. */
  type: string
  provider: 'digitalocean'
  region: string
  size: string
  /** The base image a machine starts from when the pool has no snapshot. */
  image: string
  labels: string[]
  maxNodes: number
  slots: number
  ttlMinutes: number
  maxHoursPerNode: number
}

export interface CloudSetting {
  token?: string
  /** Dollars per calendar month across all pools. */
  monthlyBudget: number
  pools: PoolSetting[]
}

const slug = /^[a-z0-9][a-z0-9-]{0,39}$/

function asPool(value: unknown): PoolSetting {
  const input = (value ?? {}) as Record<string, unknown>
  const text = (
    field: string,
    pattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/,
  ): string => {
    const out = input[field]
    if (typeof out !== 'string' || !pattern.test(out))
      throw new Error(`pool.${field} is invalid`)
    return out
  }
  const count = (
    field: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const out = input[field] ?? fallback
    if (
      typeof out !== 'number' ||
      !Number.isInteger(out) ||
      out < min ||
      out > max
    )
      throw new Error(`pool.${field} is a whole number from ${min} to ${max}`)
    return out
  }
  if ((input.provider ?? 'digitalocean') !== 'digitalocean')
    throw new Error('pool.provider is digitalocean')
  const labels = input.labels ?? []
  if (
    !Array.isArray(labels) ||
    labels.some((label) => typeof label !== 'string' || !slug.test(label))
  )
    throw new Error('pool.labels is a list of labels')
  return {
    name: text('name', slug),
    type: text('type', slug),
    provider: 'digitalocean',
    region: text('region', /^[a-z0-9-]{2,20}$/),
    size: text('size', /^[a-z0-9-]{2,40}$/),
    image: text('image'),
    labels: labels as string[],
    maxNodes: count('maxNodes', 1, 1, 50),
    slots: count('slots', 1, 1, 64),
    ttlMinutes: count('ttlMinutes', 60, 1, 24 * 60),
    maxHoursPerNode: count('maxHoursPerNode', 24, 1, 24 * 30),
  }
}

/** The `cloud` settings area: the provider token (write-only), the monthly budget and the pools. */
export const cloudArea: SettingsArea = {
  validate: (input, previous): SettingValue => {
    const value = (input ?? {}) as Record<string, unknown>
    let token: unknown = value.token
    if (
      token != null &&
      typeof token === 'object' &&
      (token as { keep?: unknown }).keep === true
    ) {
      token = previous?.token
      if (token == null) throw new Error('No stored token to keep')
    }
    if (
      token != null &&
      (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(token))
    )
      throw new Error('token is a DigitalOcean API token')
    const budget = value.monthlyBudget ?? 200
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0)
      throw new Error('monthlyBudget is a number of dollars')
    if (value.pools != null && !Array.isArray(value.pools))
      throw new Error('pools is a list')
    const pools = ((value.pools ?? []) as unknown[]).map(asPool)
    const names = new Set<string>()
    for (const pool of pools) {
      if (names.has(pool.name))
        throw new Error(`Pool ${pool.name} is listed twice`)
      names.add(pool.name)
    }
    if (pools.length > 0 && token == null)
      throw new Error('Pools need a provider token')
    return { ...(token == null ? {} : { token }), monthlyBudget: budget, pools }
  },
  secrets: ['token'],
}

interface MachineRow {
  id: number
  pool: string
  provider_id: string | null
  address: string | null
  port: number | null
  fingerprint: string | null
  state:
    | 'creating'
    | 'pairing'
    | 'ready'
    | 'retiring'
    | 'snapshotting'
    | 'destroyed'
  created_at: number
  ready_at: number | null
  last_used: number | null
  destroyed_at: number | null
  from_snapshot: number | null
  size: string
  error: string | null
}

export interface PoolsOptions {
  master: MasterDatabase
  registry: NodeRegistry
  /** The `cloud` setting. */
  setting: () => CloudSetting | undefined
  /** A provider for a token; DigitalOcean by default. */
  provider?: (token: string) => CloudProvider
  /** Whether a worker is running or preparing a stage. */
  busy: (fingerprint: string) => boolean
  /** The release a new machine installs, from the host. */
  release: () => string | undefined
  /** The platforms a stored release has tarballs for, `linux-x64`. */
  releasePlatforms?: (version: string) => string[]
  /** Where machines download the installer: the host's worker origin or origin. */
  hostOrigin: () => string | undefined
  /** The master's public address, for the firewall rule. */
  publicAddress?: () => Promise<string | undefined>
  /** The link port machines listen on. */
  linkPort?: number
  tickMs?: number
  /** How long a machine may take to boot and pair. */
  pairTimeoutMs?: number
  log?: (line: string) => void
}

const TAG = 'mason-pool'
/** Cloud machines are x86-64 Linux droplets. */
const machinePlatform = 'linux-x64'
const SNAPSHOT_PREFIX = 'mason-pool-'

const monthStart = (now: number): number => {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}
const monthEnd = (now: number): number => {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

/**
 * Cloud node pools: a node type backed by machines the master creates when
 * a stage needs one and none is free, reuses across stages up to `slots` at
 * a time, and retires after `ttlMinutes` idle by scrubbing, snapshotting and
 * destroying them; the next machine starts from that snapshot.
 */
export class Pools {
  private timer: NodeJS.Timeout | undefined
  private ticking: Promise<void> | undefined
  private stopped = false
  /** Pairing material of machines still booting, by machine ID; never stored. */
  private readonly pending = new Map<
    number,
    { certificateHash: string; secret: string }
  >()
  /** Pools waiting after a provider failure, until a time, with the reason. */
  private readonly backoff = new Map<
    string,
    { until: number; reason: string }
  >()
  private readonly retiring = new Set<number>()
  private firewallFor: string | undefined
  private providers = new Map<string, CloudProvider>()

  constructor(private readonly options: PoolsOptions) {}

  private get db(): MasterDatabase['db'] {
    return this.options.master.db
  }
  private now(): number {
    return this.options.master.now()
  }
  private log(line: string): void {
    this.options.log?.(line)
  }

  private provider(): CloudProvider | undefined {
    const token = this.options.setting()?.token
    if (token == null) return undefined
    let provider = this.providers.get(token)
    if (provider == null) {
      provider = (
        this.options.provider ??
        ((value: string): CloudProvider => new DigitalOcean(value))
      )(token)
      this.providers.set(token, provider)
    }
    return provider
  }

  pools(): PoolSetting[] {
    return this.options.setting()?.pools ?? []
  }
  pool(name: string): PoolSetting | undefined {
    return this.pools().find((pool) => pool.name === name)
  }
  forType(type: string): PoolSetting | undefined {
    return this.pools().find((pool) => pool.type === type)
  }

  machines(pool?: string): MachineRow[] {
    return (pool == null
      ? this.db
          .prepare(
            "SELECT * FROM cloud_machines WHERE state<>'destroyed' ORDER BY id",
          )
          .all()
      : this.db
          .prepare(
            "SELECT * FROM cloud_machines WHERE pool=? AND state<>'destroyed' ORDER BY id",
          )
          .all(pool)) as unknown as MachineRow[]
  }

  /** A machine that is retiring takes no new stage. */
  draining(fingerprint: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM cloud_machines WHERE fingerprint=? AND state IN ('retiring','snapshotting')",
        )
        .get(fingerprint) != null
    )
  }

  start(): void {
    void this.reconcile()
      .catch((error: unknown) =>
        this.log(`Cloud reconciliation failed: ${(error as Error).message}`),
      )
      .finally(() => {
        if (this.stopped) return
        this.timer = setInterval(() => {
          void this.tick()
        }, this.options.tickMs ?? 15_000)
        this.timer.unref()
      })
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    await this.ticking
  }

  /** This month's spend: machine time at each size's price, plus snapshot storage. */
  async spend(now = this.now()): Promise<number> {
    const provider = this.provider()
    if (provider == null) return 0
    const start = monthStart(now)
    const end = Math.min(now, monthEnd(now))
    let total = 0
    for (const row of this.db
      .prepare(
        'SELECT size,created_at,destroyed_at FROM cloud_machines WHERE created_at<? AND (destroyed_at IS NULL OR destroyed_at>?)',
      )
      .all(end, start) as Array<{
      size: string
      created_at: number
      destroyed_at: number | null
    }>) {
      const hours =
        (Math.min(row.destroyed_at ?? end, end) -
          Math.max(row.created_at, start)) /
        3_600_000
      total += Math.max(0, hours) * (await provider.priceHourly(row.size))
    }
    const month = monthEnd(now) - start
    for (const row of this.db
      .prepare(
        'SELECT size_gb,created_at,deleted_at FROM cloud_snapshots WHERE created_at<? AND (deleted_at IS NULL OR deleted_at>?)',
      )
      .all(end, start) as Array<{
      size_gb: number
      created_at: number
      deleted_at: number | null
    }>) {
      const share =
        (Math.min(row.deleted_at ?? end, end) -
          Math.max(row.created_at, start)) /
        month
      total += Math.max(0, share) * row.size_gb * SNAPSHOT_GB_MONTH
    }
    return total
  }

  private spent: { at: number; dollars: number } | undefined
  private budgetReason(): string | undefined {
    const budget = this.options.setting()?.monthlyBudget ?? 200
    if (this.spent != null && this.spent.dollars >= budget)
      return `The monthly cloud budget of $${budget} is spent`
    return undefined
  }
  /** The budget warning, for the master's notices. */
  notice(): string | undefined {
    const budget = this.options.setting()?.monthlyBudget ?? 200
    if (this.spent == null || budget === 0) return this.budgetReason()
    if (this.spent.dollars >= budget) return this.budgetReason()
    if (this.spent.dollars >= 0.8 * budget)
      return `Cloud spend this month is $${this.spent.dollars.toFixed(2)} of the $${budget} budget`
    return undefined
  }

  /**
   * A stage of `type` found no free node. Starts a machine when the type has
   * a pool with room; answers why the stage waits otherwise.
   */
  demand(type: string): string | undefined {
    const pool = this.forType(type)
    if (pool == null) return undefined
    const backoff = this.backoff.get(pool.name)
    if (backoff != null && backoff.until > this.now()) return backoff.reason
    const budget = this.budgetReason()
    if (budget != null) return budget
    const release = this.options.release()
    if (release == null)
      return 'The release store is empty: add the release machines install with mason releases add'
    // The copy beside a master's own install holds only its platform.
    if (
      this.options.releasePlatforms != null &&
      !this.options.releasePlatforms(release).includes(machinePlatform)
    )
      return `Release ${release} has no ${machinePlatform} tarball for ${pool.name} machines: store the whole release with mason releases fetch v${release}`
    if (this.options.hostOrigin() == null)
      return 'Cloud machines install from the host: set the host setting first'
    const machines = this.machines(pool.name)
    if (
      machines.some(
        (machine) =>
          machine.state === 'creating' || machine.state === 'pairing',
      )
    )
      return `Waiting for a ${pool.name} machine to start`
    if (
      machines.filter(
        (machine) =>
          machine.state !== 'retiring' && machine.state !== 'snapshotting',
      ).length >= pool.maxNodes
    )
      return `The ${pool.name} pool is at its ${pool.maxNodes}-machine limit`
    void this.create(pool)
    return `Starting a ${pool.name} machine`
  }

  /** First-boot data: install Mason from the host, then pair with the material the master made. */
  userData(
    origin: string,
    version: string,
    pairing: string,
    slots: number,
  ): string {
    const port = this.options.linkPort ?? 9310
    return `#!/bin/bash
set -euo pipefail
curl -fsSL ${origin}/install.sh -o /root/mason-install.sh
bash /root/mason-install.sh --from ${origin}
rm -f /root/mason-install.sh
umask 077
cat > /root/mason-pairing.json <<'MASON_PAIRING'
${pairing}
MASON_PAIRING
mason worker --install --pairing-file /root/mason-pairing.json --link-port ${port} --listen 0.0.0.0 --slots ${slots}
# Mason ${version}
`
  }

  private async create(pool: PoolSetting): Promise<void> {
    const provider = this.provider()
    if (provider == null) return
    const now = this.now()
    const id = Number(
      this.db
        .prepare(
          "INSERT INTO cloud_machines(pool,state,size,created_at) VALUES(?,'creating',?,?)",
        )
        .run(pool.name, pool.size, now).lastInsertRowid,
    )
    const name = `mason-${pool.name}-${id}`
    const certificate = createCertificate([name])
    const secret = randomBytes(32).toString('base64url')
    this.pending.set(id, {
      certificateHash: certificateHash(certificate.cert),
      secret,
    })
    const pairing = JSON.stringify({
      cert: certificate.cert,
      key: certificate.key,
      secret,
    })
    try {
      // The pool's snapshot when the provider still has it; the base image otherwise.
      let snapshot = this.db
        .prepare(
          'SELECT id,provider_id FROM cloud_snapshots WHERE pool=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
        )
        .get(pool.name) as { id: number; provider_id: string } | undefined
      if (
        snapshot != null &&
        !(await provider.hasSnapshot(snapshot.provider_id))
      ) {
        this.db
          .prepare('UPDATE cloud_snapshots SET deleted_at=? WHERE id=?')
          .run(this.now(), snapshot.id)
        this.log(
          `The ${pool.name} snapshot is gone; starting from the base image`,
        )
        snapshot = undefined
      }
      const machine = await provider.create({
        name,
        region: pool.region,
        size: pool.size,
        image: snapshot?.provider_id ?? pool.image,
        tags: [TAG, `${TAG}-${pool.name}`],
        userData: this.userData(
          this.options.hostOrigin()!,
          this.options.release()!,
          pairing,
          pool.slots,
        ),
      })
      this.db
        .prepare(
          "UPDATE cloud_machines SET provider_id=?,state='pairing',from_snapshot=? WHERE id=?",
        )
        .run(machine.id, snapshot?.id ?? null, id)
      this.log(
        `Created ${name} from ${snapshot == null ? pool.image : `snapshot ${snapshot.provider_id}`}`,
      )
    } catch (error) {
      this.pending.delete(id)
      this.db
        .prepare(
          "UPDATE cloud_machines SET state='destroyed',destroyed_at=?,error=? WHERE id=?",
        )
        .run(this.now(), (error as Error).message, id)
      const reason =
        error instanceof ProviderError
          ? `The cloud provider refused a new ${pool.name} machine (${error.kind}): ${error.message}`
          : `Could not create a ${pool.name} machine: ${(error as Error).message}`
      this.backoff.set(pool.name, { until: this.now() + 60_000, reason })
      this.log(reason)
    }
  }

  /** Pairs a machine once it has an address; gives up after the boot timeout and drops a bad snapshot. */
  private async pair(row: MachineRow, provider: CloudProvider): Promise<void> {
    const material = this.pending.get(row.id)
    const pool = this.pool(row.pool)
    if (material == null || pool == null || row.provider_id == null) {
      await this.discard(
        row,
        provider,
        'Its pairing material is gone (the master restarted)',
      )
      return
    }
    if (
      this.now() - row.created_at >
      (this.options.pairTimeoutMs ?? 15 * 60_000)
    ) {
      if (row.from_snapshot != null) {
        this.db
          .prepare('UPDATE cloud_snapshots SET deleted_at=? WHERE id=?')
          .run(this.now(), row.from_snapshot)
        const stored = this.db
          .prepare('SELECT provider_id FROM cloud_snapshots WHERE id=?')
          .get(row.from_snapshot) as { provider_id: string }
        await provider.deleteSnapshot(stored.provider_id).catch(() => undefined)
        this.log(
          `The ${row.pool} snapshot did not boot or pair; the next machine starts from the base image`,
        )
      }
      await this.discard(row, provider, 'It did not pair in time')
      return
    }
    const machine = await provider.get(row.provider_id)
    if (machine == null) {
      await this.discard(row, provider, 'The provider no longer has it')
      return
    }
    if (machine.status !== 'active' || machine.address == null) return
    const address = `${machine.address}:${machine.port ?? this.options.linkPort ?? 9310}`
    try {
      const node = await this.options.registry.addMachine(
        address,
        material.certificateHash,
        material.secret,
      )
      this.pending.delete(row.id)
      await this.options.registry.assign(node.fingerprint, {
        name: machine.name,
        type: pool.type,
        labels: pool.labels,
        slots: pool.slots,
      })
      this.db
        .prepare(
          "UPDATE cloud_machines SET state='ready',fingerprint=?,address=?,ready_at=?,last_used=? WHERE id=?",
        )
        .run(node.fingerprint, address, this.now(), this.now(), row.id)
      this.log(
        `${machine.name} paired as ${node.fingerprint} in ${Math.round((this.now() - row.created_at) / 1000)} s`,
      )
    } catch (error) {
      // Still booting or installing; the next pass tries again.
      this.log(`${machine.name} is not paired yet: ${(error as Error).message}`)
    }
  }

  private async discard(
    row: MachineRow,
    provider: CloudProvider,
    why: string,
  ): Promise<void> {
    this.pending.delete(row.id)
    if (row.provider_id != null)
      await provider.destroy(row.provider_id).catch(() => undefined)
    if (row.fingerprint != null) this.options.registry.remove(row.fingerprint)
    this.db
      .prepare(
        "UPDATE cloud_machines SET state='destroyed',destroyed_at=?,error=? WHERE id=?",
      )
      .run(this.now(), why, row.id)
    this.log(`Destroyed machine ${row.id}: ${why}`)
  }

  /**
   * Retires a machine: drains it, has the worker remove its identity,
   * pairing, stage directories and keychains (and checks none remain),
   * powers it off, snapshots it, destroys it and deletes the pool's previous
   * snapshot. A failed snapshot still destroys the machine and keeps the
   * previous snapshot.
   */
  async retire(row: MachineRow, why: string): Promise<void> {
    const provider = this.provider()
    if (
      provider == null ||
      row.provider_id == null ||
      this.retiring.has(row.id)
    )
      return
    this.retiring.add(row.id)
    try {
      this.db
        .prepare("UPDATE cloud_machines SET state='retiring' WHERE id=?")
        .run(row.id)
      this.log(`Retiring ${row.pool} machine ${row.id}: ${why}`)
      let clean = false
      const link =
        row.fingerprint == null
          ? undefined
          : this.options.registry.link(row.fingerprint)
      if (link != null)
        try {
          const scrub = (await link.request('node.scrub', {}, 120_000)) as {
            remaining: string[]
          }
          clean = scrub.remaining.length === 0
          if (!clean)
            this.log(
              `Machine ${row.id} kept ${scrub.remaining.join(', ')}; it is not snapshotted`,
            )
        } catch (error) {
          this.log(
            `Machine ${row.id} did not scrub: ${(error as Error).message}`,
          )
        }
      if (row.fingerprint != null) this.options.registry.remove(row.fingerprint)
      await provider.powerOff(row.provider_id).catch(() => undefined)
      if (clean) {
        this.db
          .prepare("UPDATE cloud_machines SET state='snapshotting' WHERE id=?")
          .run(row.id)
        try {
          const snapshot = await provider.snapshot(
            row.provider_id,
            `${SNAPSHOT_PREFIX}${row.pool}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`,
          )
          const previous = this.db
            .prepare(
              'SELECT id,provider_id FROM cloud_snapshots WHERE pool=? AND deleted_at IS NULL',
            )
            .all(row.pool) as Array<{ id: number; provider_id: string }>
          this.db
            .prepare(
              'INSERT INTO cloud_snapshots(pool,provider_id,source_machine,size_gb,version,created_at) VALUES(?,?,?,?,?,?)',
            )
            .run(
              row.pool,
              snapshot.id,
              row.id,
              snapshot.sizeGb,
              this.options.release() ?? '',
              this.now(),
            )
          for (const old of previous) {
            await provider
              .deleteSnapshot(old.provider_id)
              .catch(() => undefined)
            this.db
              .prepare('UPDATE cloud_snapshots SET deleted_at=? WHERE id=?')
              .run(this.now(), old.id)
          }
        } catch (error) {
          this.log(
            `Snapshot of machine ${row.id} failed; the previous snapshot stays: ${(error as Error).message}`,
          )
        }
      }
      await provider.destroy(row.provider_id)
      this.db
        .prepare(
          "UPDATE cloud_machines SET state='destroyed',destroyed_at=? WHERE id=?",
        )
        .run(this.now(), row.id)
    } finally {
      this.retiring.delete(row.id)
    }
  }

  /** One pass: pair booting machines, track use, retire idle ones, keep the firewall and budget current. */
  tick(): Promise<void> {
    return (this.ticking ??= this.pass()
      .catch((error: unknown) =>
        this.log(`Cloud pass failed: ${(error as Error).message}`),
      )
      .finally(() => {
        this.ticking = undefined
      }))
  }

  private async pass(): Promise<void> {
    const provider = this.provider()
    if (provider == null || this.stopped) return
    this.spent = { at: this.now(), dollars: await this.spend() }
    const overBudget = this.budgetReason() != null
    await this.firewall(provider)
    for (const row of this.machines()) {
      if (this.stopped) return
      if (row.state === 'creating') continue
      if (row.state === 'pairing') {
        await this.pair(row, provider)
        continue
      }
      if (row.state !== 'ready' || row.fingerprint == null) continue
      const pool = this.pool(row.pool)
      if (this.options.busy(row.fingerprint)) {
        this.db
          .prepare('UPDATE cloud_machines SET last_used=? WHERE id=?')
          .run(this.now(), row.id)
        continue
      }
      const idle =
        this.now() - (row.last_used ?? row.ready_at ?? row.created_at)
      const age = this.now() - (row.ready_at ?? row.created_at)
      if (pool == null) await this.retire(row, 'Its pool is gone')
      else if (overBudget) await this.retire(row, 'The monthly budget is spent')
      else if (idle >= pool.ttlMinutes * 60_000)
        await this.retire(row, `Idle for ${pool.ttlMinutes} minutes`)
      else if (age >= pool.maxHoursPerNode * 3_600_000)
        await this.retire(row, `Up for ${pool.maxHoursPerNode} hours`)
    }
  }

  /** The link port admits only the master's current public address. */
  private async firewall(provider: CloudProvider): Promise<void> {
    if (this.options.publicAddress == null || this.pools().length === 0) return
    const address = await this.options.publicAddress().catch(() => undefined)
    if (address == null || address === this.firewallFor) return
    await provider.firewall(
      'mason-pools',
      this.options.linkPort ?? 9310,
      [address],
      TAG,
    )
    this.firewallFor = address
    this.log(`Cloud firewall admits the link port from ${address}`)
  }

  /**
   * On startup: destroys tagged machines and deletes snapshots the master has
   * no record of, and drops machines that were booting when it stopped (their
   * pairing material was never stored).
   */
  async reconcile(): Promise<{ machines: number; snapshots: number }> {
    const provider = this.provider()
    if (provider == null) return { machines: 0, snapshots: 0 }
    let machines = 0
    let snapshots = 0
    const known = new Map(this.machines().map((row) => [row.provider_id, row]))
    for (const machine of await provider.list(TAG)) {
      const row = known.get(machine.id)
      if (row == null) {
        await provider.destroy(machine.id)
        machines++
        this.log(`Destroyed ${machine.name}: the master has no record of it`)
      }
    }
    for (const row of this.machines())
      if (row.state === 'creating' || row.state === 'pairing') {
        await this.discard(
          row,
          provider,
          'The master restarted while it booted',
        )
        machines++
      } else if (
        row.provider_id != null &&
        (await provider.get(row.provider_id)) == null
      ) {
        this.db
          .prepare(
            "UPDATE cloud_machines SET state='destroyed',destroyed_at=? WHERE id=?",
          )
          .run(this.now(), row.id)
      }
    const recorded = new Set(
      (
        this.db
          .prepare(
            'SELECT provider_id FROM cloud_snapshots WHERE deleted_at IS NULL',
          )
          .all() as Array<{ provider_id: string }>
      ).map((row) => row.provider_id),
    )
    for (const snapshot of await provider.snapshots())
      if (
        snapshot.name.startsWith(SNAPSHOT_PREFIX) &&
        !recorded.has(snapshot.id)
      ) {
        await provider.deleteSnapshot(snapshot.id)
        snapshots++
        this.log(
          `Deleted snapshot ${snapshot.name}: the master has no record of it`,
        )
      }
    return { machines, snapshots }
  }

  /** Machines and snapshots, for the API and `mason status`. */
  view(): { machines: MachineRow[]; snapshots: unknown[] } {
    return {
      machines: this.machines(),
      snapshots: this.db
        .prepare(
          'SELECT * FROM cloud_snapshots WHERE deleted_at IS NULL ORDER BY id',
        )
        .all(),
    }
  }
}
