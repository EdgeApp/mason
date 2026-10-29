import { randomBytes } from 'node:crypto'
import { createCertificate, certificateHash } from '../../node/certificate.js'
import type { MasterDatabase } from '../database.js'
import type { Link } from '../../link/link.js'
import { version as masonVersion } from '../../version.js'
import type { NodeRegistry } from '../nodes.js'
import type { CloudAccount } from './accounts.js'
import {
  DigitalOcean,
  ProviderError,
  type CloudProvider,
  type ProviderMachine,
} from './digitalocean.js'
import { SpaceError } from './spaces.js'

/**
 * Mason hosts the master makes on DigitalOcean. Each is a row in
 * `cloud_hosts`, and reconciling a row is idempotent: the droplet it records
 * (or the one droplet tagged for it) is adopted, a host that already answers
 * is simply reconnected, and only a host that has no droplet at all gets one.
 * A master restored from a backup on another computer therefore adopts its
 * host instead of making a second one.
 */

export type HostState =
  | 'creating'
  | 'installing'
  | 'pairing'
  | 'ready'
  | 'updating'
  | 'error'
  | 'removing'
  | 'removed'

export interface CloudHostRow {
  name: string
  account: string
  provider: string
  region: string
  size: string
  image: string
  dns_domain: string | null
  dns_name: string | null
  provider_id: string | null
  address: string | null
  /** The link port, when the provider reports one (tests). */
  port: number | null
  dns_record_id: string | null
  dns_owned: number
  fingerprint: string | null
  /** The pairing certificate's hash and one-time secret, until it pairs. */
  pairing_hash: string | null
  pairing_secret: string | null
  /** The origin this host set in the master's host settings. */
  origin: string | null
  state: HostState
  error: string | null
  version: string | null
  /** When its DNS name first answered with a trusted certificate. */
  certificate_at: number | null
  /** Its DigitalOcean Space for builds, and the key limited to it. */
  space_bucket: string | null
  space_region: string | null
  space_key_id: string | null
  space_secret: string | null
  space_owned: number
  space_key_owned: number
  /** An administrator asked for the host's storage to be the Space. */
  space_pending: number
  created_at: number
  updated_at: number
}

/** A host to make, as the form or API sends it. */
export interface HostInput {
  name: string
  account: string
  region: string
  size: string
  image?: string
  dns?: { domain: string; name: string }
  /** Store builds in a new DigitalOcean Space. */
  space?: { bucket: string; region: string }
}

export interface CloudHostsOptions {
  master: MasterDatabase
  registry: NodeRegistry
  account: (id: string) => CloudAccount | undefined
  /** A provider for a key; DigitalOcean by default. */
  provider?: (token: string) => CloudProvider
  /** The release a new host installs from GitHub. */
  github: () => { repository: string; version: string } | undefined
  /** The master's `host` settings, read and written. */
  hostSettings: {
    get(): { origin?: string } | undefined
    set(origin: string | undefined): Promise<void>
  }
  /** The master's public address, for the link port's firewall rule. */
  publicAddress?: () => Promise<string | undefined>
  /** This master's short id, in its hosts' tags and firewall names. */
  masterId: string
  /** A DNS step for hosts with a DNS name; none by default. */
  dns?: CloudHostDns
  /** The Space step for hosts that store builds in one; none by default. */
  space?: CloudHostSpace
  /** Whether an origin answers with a certificate this computer trusts. */
  trusted?: (origin: string) => Promise<boolean>
  linkPort?: number
  /** The release its hosts follow: the master's own by default. */
  version?: string
  /** How long a host has to come back on the release it was asked for. */
  updateTimeoutMs?: number
  tickMs?: number
  /** How soon a host still being made is reconciled again. */
  settleMs?: number
  log?: (line: string) => void
}

/** The Space part of reconciling a host. */
export interface CloudHostSpace {
  /** Keeps the host's key and bucket; returns why the host is in error, if it is. */
  reconcile(
    row: CloudHostRow,
    provider: CloudProvider,
    keyName: string,
  ): Promise<string | undefined>
  remove(
    row: CloudHostRow,
    provider: CloudProvider,
    options: { deleteSpace: boolean; keyName: string },
  ): Promise<void>
}

/** The DNS part of reconciling a host. */
export interface CloudHostDns {
  /** Makes or adopts the host's record; returns why the host is in error, if it is. */
  reconcile(
    row: CloudHostRow,
    provider: CloudProvider,
  ): Promise<string | undefined>
  remove(row: CloudHostRow, provider: CloudProvider): Promise<void>
}

export class MissingHost extends Error {
  constructor(name: string) {
    super(`No cloud host named ${name}`)
  }
}

const slug = /^[a-z0-9][a-z0-9-]{0,39}$/
/** States a host passes through while it is made. */
const settlingStates: HostState[] = ['creating', 'installing', 'pairing']
const TAG = 'mason-host'
/** Hosts are x86-64 Linux droplets. */
const hostPlatform = 'linux-x64'

/** The cloud-init script a new host boots with. */
export function hostUserData(options: {
  repository: string
  version: string
  pairing: string
  /** The host's DNS name, for a Let's Encrypt certificate; its address otherwise. */
  dnsName?: string
  linkPort: number
}): string {
  // Without a DNS name, Caddy serves the droplet's address with its own CA.
  const site =
    options.dnsName == null
      ? `https://$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address) {\n\ttls internal\n\treverse_proxy 127.0.0.1:9200\n}`
      : `${options.dnsName} {\n\treverse_proxy 127.0.0.1:9200\n}`
  return `#!/bin/bash
# A Mason host's first boot. Running it again changes nothing. MASON_HOST_ROOT
# (empty on a droplet) is the filesystem root, for testing the script.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
root=\${MASON_HOST_ROOT:-}
apt=(apt-get -o DPkg::Lock::Timeout=600 -y -qq)
curl -fsSL https://github.com/${options.repository}/releases/latest/download/install.sh -o "$root/root/mason-install.sh"
bash "$root/root/mason-install.sh" --version ${options.version}
rm -f "$root/root/mason-install.sh"
if ! command -v caddy >/dev/null; then
  "\${apt[@]}" install debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o "$root/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > "$root/etc/apt/sources.list.d/caddy-stable.list"
  "\${apt[@]}" update
  "\${apt[@]}" install caddy
fi
if [ ! -f "$root/var/lib/mason/.mason/identity.key" ]; then
  umask 077
  cat > "$root/root/mason-pairing.json" <<'MASON_PAIRING'
${options.pairing}
MASON_PAIRING
  umask 022
  mason host --install --pairing-file "$root/root/mason-pairing.json" --listen 127.0.0.1 --port 9200 --web-plain --link-listen 0.0.0.0 --link-port ${options.linkPort}
fi
rm -f "$root/root/mason-pairing.json"
cat > "$root/etc/caddy/Caddyfile" <<MASON_CADDY
${site}
MASON_CADDY
systemctl reload caddy || systemctl restart caddy
# Mason ${options.version} host (${hostPlatform})
`
}

/** Validates a host to make. */
export function asHostInput(value: unknown): HostInput {
  const input = (value ?? {}) as Record<string, unknown>
  const text = (field: string, pattern: RegExp): string => {
    const out = input[field]
    if (typeof out !== 'string' || !pattern.test(out))
      throw new Error(`host.${field} is invalid`)
    return out
  }
  // A form's "No DNS" sends no domain.
  const dns =
    input.dns == null ||
    (input.dns as { domain?: unknown }).domain == null ||
    (input.dns as { domain?: unknown }).domain === ''
      ? undefined
      : (input.dns as Record<string, unknown>)
  if (dns != null) {
    if (
      typeof dns.domain !== 'string' ||
      !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
        dns.domain,
      )
    )
      throw new Error('host.dns.domain is a domain name')
    if (
      typeof dns.name !== 'string' ||
      !/^(@|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)$/.test(
        dns.name,
      )
    )
      throw new Error('host.dns.name is a record name in the domain, or @')
  }
  return {
    name: text('name', slug),
    account: text('account', slug),
    region: text('region', /^[a-z0-9-]{2,20}$/),
    size: text('size', /^[a-z0-9-]{2,40}$/),
    image:
      input.image == null || input.image === ''
        ? 'ubuntu-24-04-x64'
        : text('image', /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/),
    ...(dns == null
      ? {}
      : { dns: { domain: dns.domain as string, name: dns.name as string } }),
    ...(input.space == null ||
    (input.space as { bucket?: unknown }).bucket == null ||
    (input.space as { bucket?: unknown }).bucket === ''
      ? {}
      : { space: asSpaceInput(input.space) }),
  }
}

/** A Space to make for a host: a bucket name and a Spaces region. */
export function asSpaceInput(value: unknown): {
  bucket: string
  region: string
} {
  const input = (value ?? {}) as Record<string, unknown>
  if (
    typeof input.bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket)
  )
    throw new Error(
      'space.bucket is a Space name: 3 to 63 lowercase letters, digits and dashes',
    )
  if (typeof input.region !== 'string' || !/^[a-z]{3}[0-9]$/.test(input.region))
    throw new Error('space.region is a Spaces region such as sfo3')
  return { bucket: input.bucket, region: input.region }
}

/** The host's DNS name, `name.domain` (or the domain for `@`). */
export function fqdn(
  row: Pick<CloudHostRow, 'dns_domain' | 'dns_name'>,
): string | undefined {
  if (row.dns_domain == null || row.dns_name == null) return undefined
  return row.dns_name === '@'
    ? row.dns_domain
    : `${row.dns_name}.${row.dns_domain}`
}

/** Whether an HTTPS origin answers with a certificate this computer's CAs trust. */
async function trustedOrigin(origin: string): Promise<boolean> {
  try {
    await fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
    return true
  } catch {
    return false
  }
}

export class CloudHosts {
  private timer: NodeJS.Timeout | undefined
  private readonly running = new Map<string, Promise<CloudHostRow>>()
  private readonly providers = new Map<string, CloudProvider>()
  private stopped = false
  private readonly asking = new Set<string>()
  private readonly updateTimers = new Map<string, NodeJS.Timeout>()
  private readonly onConnected = (fingerprint: string, link: Link): void => {
    const row = this.list().find((host) => host.fingerprint === fingerprint)
    if (row != null) void this.follow(row, link)
  }

  constructor(private readonly options: CloudHostsOptions) {}

  /** The release this master's hosts run: its own. */
  private get target(): string {
    return this.options.version ?? masonVersion
  }

  private get db(): MasterDatabase['db'] {
    return this.options.master.db
  }
  private now(): number {
    return this.options.master.now()
  }
  private log(line: string): void {
    this.options.log?.(line)
  }

  /** The tag and firewall name of one of this master's hosts. */
  private tag(name: string): string {
    return `${TAG}-${this.options.masterId}-${name}`
  }

  provider(account: string): CloudProvider | undefined {
    const key = this.options.account(account)?.key
    if (key == null) return undefined
    let provider = this.providers.get(key)
    if (provider == null) {
      provider = (
        this.options.provider ??
        ((token: string): CloudProvider => new DigitalOcean(token))
      )(key)
      this.providers.set(key, provider)
    }
    return provider
  }

  list(): CloudHostRow[] {
    return this.db
      .prepare(
        "SELECT * FROM cloud_hosts WHERE state<>'removed' ORDER BY created_at",
      )
      .all() as unknown as CloudHostRow[]
  }
  get(name: string): CloudHostRow | undefined {
    return this.db
      .prepare("SELECT * FROM cloud_hosts WHERE name=? AND state<>'removed'")
      .get(name) as CloudHostRow | undefined
  }
  /** What uses an account, for the Cloud page's refusal to remove it. */
  usedBy(account: string): string[] {
    return this.list()
      .filter((row) => row.account === account)
      .map((row) => `host ${row.name}`)
  }

  private update(name: string, fields: Partial<CloudHostRow>): void {
    const entries = Object.entries({ ...fields, updated_at: this.now() })
    this.db
      .prepare(
        `UPDATE cloud_hosts SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE name=? AND state<>'removed'`,
      )
      .run(
        ...(entries.map(([, value]) => value ?? null) as Array<
          string | number | null
        >),
        name,
      )
  }

  /** Records a new host and starts making it; a master has one host. */
  async create(value: unknown): Promise<CloudHostRow> {
    const input = asHostInput(value)
    const account = this.options.account(input.account)
    if (account == null)
      throw new Error(`No cloud account named ${input.account}`)
    if (account.provider !== 'digitalocean')
      throw new Error(`Account ${input.account} is not a DigitalOcean account`)
    if (this.list().length > 0)
      throw new Error(`This master already has a host: ${this.list()[0]!.name}`)
    if (this.options.github() == null)
      throw new Error(
        'A cloud host installs the master’s release from GitHub, and this master has none',
      )
    if (input.dns != null) {
      const domains = (await this.provider(input.account)?.domains?.()) ?? []
      if (!domains.includes(input.dns.domain))
        throw new Error(`The account's DNS holds no domain ${input.dns.domain}`)
    }
    const now = this.now()
    this.db
      .prepare("DELETE FROM cloud_hosts WHERE name=? AND state='removed'")
      .run(input.name)
    this.db
      .prepare(
        "INSERT INTO cloud_hosts(name,account,provider,region,size,image,dns_domain,dns_name,dns_owned,space_bucket,space_region,space_pending,state,created_at,updated_at) VALUES(?,?,'digitalocean',?,?,?,?,?,0,?,?,?,'creating',?,?)",
      )
      .run(
        input.name,
        input.account,
        input.region,
        input.size,
        input.image ?? 'ubuntu-24-04-x64',
        input.dns?.domain ?? null,
        input.dns?.name ?? null,
        input.space?.bucket ?? null,
        input.space?.region ?? null,
        input.space == null ? 0 : 1,
        now,
        now,
      )
    void this.reconcile(input.name).catch(() => undefined)
    return this.get(input.name)!
  }

  start(): void {
    this.options.registry.on('connected', this.onConnected)
    void this.reconcileAll().finally(() => {
      if (this.stopped) return
      this.timer = setInterval(() => {
        void this.reconcileAll()
      }, this.options.tickMs ?? 600_000)
      this.timer.unref()
    })
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.options.registry.off('connected', this.onConnected)
    for (const timer of this.updateTimers.values()) clearTimeout(timer)
    clearInterval(this.timer)
    for (const timer of this.settling.values()) clearTimeout(timer)
    await Promise.allSettled([...this.running.values()])
  }

  async reconcileAll(): Promise<void> {
    for (const row of this.list())
      if (row.state !== 'removing')
        await this.reconcile(row.name).catch((error: unknown) =>
          this.log(
            `Reconciling host ${row.name} failed: ${(error as Error).message}`,
          ),
        )
  }

  /** Reconciles one host; a reconcile already under way for it is shared. */
  reconcile(name: string): Promise<CloudHostRow> {
    const running = this.running.get(name)
    if (running != null) return running
    const work = this.pass(name).finally(() => this.running.delete(name))
    this.running.set(name, work)
    // A host still being made is checked again soon, not at the next tick.
    void work.then(
      (row) => {
        clearTimeout(this.settling.get(name))
        if (this.stopped || !settlingStates.includes(row.state)) return
        const timer = setTimeout(() => {
          void this.reconcile(name).catch(() => undefined)
        }, this.options.settleMs ?? 20_000)
        timer.unref()
        this.settling.set(name, timer)
      },
      () => undefined,
    )
    return work
  }
  private readonly settling = new Map<string, NodeJS.Timeout>()

  private async pass(name: string): Promise<CloudHostRow> {
    const row = this.get(name)
    if (row == null) throw new MissingHost(name)
    const provider = this.provider(row.account)
    if (provider == null) {
      this.update(name, {
        state: 'error',
        error: `Its cloud account ${row.account} is gone`,
      })
      return this.get(name)!
    }
    try {
      // 1. The droplet: the recorded one, else the one tagged for this host, else a new one.
      let machine: ProviderMachine | undefined
      let created = false
      if (row.provider_id != null) machine = await provider.get(row.provider_id)
      if (machine == null) {
        const tagged = await provider.list(this.tag(name))
        if (tagged.length > 1)
          throw new HostError(
            `${tagged.length} droplets are tagged ${this.tag(name)}; remove the extra ones by hand`,
          )
        machine = tagged[0]
      }
      if (machine == null) {
        machine = await this.makeDroplet(row, provider)
        created = true
      }
      if (machine.id !== row.provider_id)
        this.update(name, {
          provider_id: machine.id,
          ...(created ? {} : { state: 'installing' }),
        })
      if (machine.address != null && machine.address !== row.address)
        this.update(name, { address: machine.address })
      if (machine.port != null && machine.port !== row.port)
        this.update(name, { port: machine.port })
      if (machine.address == null) {
        this.update(name, { state: 'installing', error: null })
        return this.get(name)!
      }
      // 2. The firewall: the web ports from anywhere, the link port from the master only.
      await this.firewall(name, provider)
      // 3. DNS, when the host has a name.
      const current = this.get(name)!
      if (current.dns_domain != null && this.options.dns != null) {
        const problem = await this.options.dns.reconcile(current, provider)
        if (problem != null) {
          this.update(name, { state: 'error', error: problem })
          return this.get(name)!
        }
      }
      // The Space, before the host pairs, so its first sync carries the storage.
      const spaced = this.get(name)!
      if (spaced.space_bucket != null && this.options.space != null) {
        const problem = await this.options.space.reconcile(
          spaced,
          provider,
          this.tag(name),
        )
        if (problem != null) {
          this.update(name, { state: 'error', error: problem })
          return this.get(name)!
        }
      }
      // 4. The host: reconnected when paired, paired when it boots with our material.
      await this.host(this.get(name)!)
      // 5. The master's host settings point at it, unless an administrator chose otherwise.
      const ready = this.get(name)!
      if (ready.state === 'ready') {
        await this.settings(ready)
        await this.certificate(ready)
      }
      return this.get(name)!
    } catch (error) {
      const message =
        error instanceof HostError ||
        error instanceof ProviderError ||
        error instanceof SpaceError
          ? error.message
          : `Reconcile failed: ${(error as Error).message}`
      this.update(name, { state: 'error', error: message })
      this.log(`Host ${name}: ${message}`)
      return this.get(name)!
    }
  }

  private async makeDroplet(
    row: CloudHostRow,
    provider: CloudProvider,
  ): Promise<ProviderMachine> {
    const github = this.options.github()
    if (github == null)
      throw new HostError(
        'A cloud host installs the master’s release from GitHub, and this master has none',
      )
    const certificate = createCertificate([`mason-host-${row.name}`])
    const secret = randomBytes(32).toString('base64url')
    const dnsName = fqdn(row)
    const machine = await provider.create({
      name: `mason-host-${row.name}`,
      region: row.region,
      size: row.size,
      image: row.image,
      tags: [TAG, this.tag(row.name)],
      userData: hostUserData({
        repository: github.repository,
        version: github.version,
        pairing: JSON.stringify({
          cert: certificate.cert,
          key: certificate.key,
          secret,
        }),
        ...(dnsName == null ? {} : { dnsName }),
        linkPort: this.options.linkPort ?? 9310,
      }),
    })
    this.update(row.name, {
      provider_id: machine.id,
      pairing_hash: certificateHash(certificate.cert),
      pairing_secret: secret,
      state: 'installing',
      error: null,
      version: github.version,
    })
    this.log(`Created droplet ${machine.name} for host ${row.name}`)
    return machine
  }

  private readonly firewallFor = new Map<string, string>()
  private async firewall(name: string, provider: CloudProvider): Promise<void> {
    const master =
      (await this.options.publicAddress?.().catch(() => undefined)) ?? undefined
    const key = `${name}:${master ?? ''}`
    if (this.firewallFor.get(name) === key) return
    await provider.firewall(
      this.tag(name),
      [
        { port: 80, sources: ['0.0.0.0/0', '::/0'] },
        { port: 443, sources: ['0.0.0.0/0', '::/0'] },
        ...(master == null
          ? []
          : [{ port: this.options.linkPort ?? 9310, sources: [master] }]),
      ],
      this.tag(name),
    )
    this.firewallFor.set(name, key)
  }

  private async host(row: CloudHostRow): Promise<void> {
    const registry = this.options.registry
    if (row.fingerprint != null && registry.get(row.fingerprint) != null) {
      const link = registry.link(row.fingerprint)
      if (link != null) await this.follow(row, link)
      // Restarting into the release it was asked for; the timeout watches it.
      else if (row.state === 'updating') {
        this.watch(row)
        return
      } else if (row.pairing_secret == null)
        // Adopted, not answering: nothing is remade, a person looks.
        this.update(row.name, {
          state: 'error',
          error: 'The host is not answering on its link',
        })
      return
    }
    if (row.pairing_hash == null || row.pairing_secret == null) {
      this.update(row.name, {
        state: 'error',
        error:
          'The host is not answering and its pairing material is gone; pair it by hand or remove it',
      })
      return
    }
    this.update(row.name, { state: 'pairing' })
    try {
      const node = await registry.addMachine(
        `${row.address}:${row.port ?? this.options.linkPort ?? 9310}`,
        row.pairing_hash,
        row.pairing_secret,
        'host',
      )
      this.update(row.name, {
        fingerprint: node.fingerprint,
        pairing_hash: null,
        pairing_secret: null,
        state: 'ready',
        error: null,
      })
      this.log(`Host ${row.name} paired as ${node.fingerprint}`)
      const link = registry.link(node.fingerprint)
      if (link != null) await this.follow(this.get(row.name)!, link)
    } catch (error) {
      // Still installing: the next reconcile tries again.
      this.update(row.name, { state: 'installing', error: null })
      this.log(
        `Host ${row.name} is not paired yet: ${(error as Error).message}`,
      )
    }
  }

  /**
   * Keeps a linked host on the master's release. On it, the host is ready.
   * On another, the master asks it over the link to update (no SSH: its
   * root updater installs the release and restarts it); it is `updating`
   * until it links again on that release, or in error after the timeout.
   * A host that cannot update itself stays ready, with the reason.
   */
  private async follow(row: CloudHostRow, link: Link): Promise<void> {
    const target = this.target
    const running = link.peer?.version
    if (running === target) {
      if (
        row.state !== 'ready' ||
        row.version !== target ||
        row.error != null
      ) {
        clearTimeout(this.updateTimers.get(row.name))
        this.updateTimers.delete(row.name)
        if (row.state === 'updating')
          this.log(`Host ${row.name} is back on ${target}`)
        this.update(row.name, { state: 'ready', error: null, version: target })
      }
      return
    }
    if (row.state === 'updating' && row.version === target) {
      this.watch(row)
      return
    }
    if (row.error === notBack(target)) return
    if (this.asking.has(row.name)) return
    this.asking.add(row.name)
    try {
      this.update(row.name, {
        state: 'updating',
        version: target,
        error: null,
      })
      await link.request('node.update', { version: target })
      this.log(
        `Asked host ${row.name} to update from ${running ?? 'an unknown release'} to ${target}`,
      )
      // A wait for an earlier release ends with this request.
      clearTimeout(this.updateTimers.get(row.name))
      this.updateTimers.delete(row.name)
      this.watch(this.get(row.name)!)
    } catch (error) {
      const message = `It cannot update itself to ${target}: ${(error as Error).message}`
      this.update(row.name, {
        state: 'ready',
        version: running ?? null,
        error: message,
      })
      this.log(`Host ${row.name}: ${message}`)
    } finally {
      this.asking.delete(row.name)
    }
  }

  /**
   * An updating host is in error once the timeout passes since it was asked,
   * also across a restart of the master.
   */
  private watch(row: CloudHostRow): void {
    if (this.updateTimers.has(row.name) || row.version == null) return
    const target = row.version
    const timer = setTimeout(
      () => {
        this.updateTimers.delete(row.name)
        const now = this.get(row.name)
        if (now?.state !== 'updating' || now.version !== target) return
        this.update(row.name, { state: 'error', error: notBack(target) })
        this.log(`Host ${row.name}: ${notBack(target)}`)
      },
      Math.max(
        0,
        row.updated_at +
          (this.options.updateTimeoutMs ?? 20 * 60_000) -
          this.now(),
      ),
    )
    timer.unref()
    this.updateTimers.set(row.name, timer)
  }

  /** Notes when the host's DNS name first answers with a trusted certificate. */
  private async certificate(row: CloudHostRow): Promise<void> {
    const name = fqdn(row)
    if (name == null || row.certificate_at != null) return
    const trusted = await (this.options.trusted ?? trustedOrigin)(
      `https://${name}`,
    )
    if (trusted) this.update(row.name, { certificate_at: this.now() })
  }

  /** The origin this host serves: its DNS name, or its address. */
  originOf(row: CloudHostRow): string | undefined {
    const name = fqdn(row)
    if (name != null) return `https://${name}`
    return row.address == null ? undefined : `https://${row.address}`
  }

  private async settings(row: CloudHostRow): Promise<void> {
    const origin = this.originOf(row)
    if (origin == null) return
    const current = this.options.hostSettings.get()?.origin
    // An origin an administrator set is theirs; only ours, or none, is replaced.
    if (current != null && current !== row.origin && current !== origin) return
    if (current !== origin) await this.options.hostSettings.set(origin)
    if (row.origin !== origin) this.update(row.name, { origin })
  }

  /**
   * Gives a host a new DigitalOcean Space for its builds: an administrator's
   * choice, so its storage switches to the Space once it exists.
   */
  async setSpace(name: string, value: unknown): Promise<CloudHostRow> {
    const row = this.get(name)
    if (row == null) throw new MissingHost(name)
    const space = asSpaceInput(value)
    this.update(name, {
      space_bucket: space.bucket,
      space_region: space.region,
      space_pending: 1,
      // Another bucket needs a key that can use it.
      ...(row.space_bucket === space.bucket
        ? {}
        : { space_owned: 0, space_key_id: null, space_secret: null }),
    })
    return await this.reconcile(name)
  }

  /**
   * Destroys the host's droplet, firewall and owned DNS record, and unpairs
   * it. Its Space and builds stay unless `deleteSpace`; the key Mason made
   * for it goes.
   */
  async remove(
    name: string,
    confirm: unknown,
    options: { deleteSpace?: boolean } = {},
  ): Promise<void> {
    const row = this.get(name)
    if (row == null) throw new MissingHost(name)
    if (confirm !== name)
      throw new Error(`Type the host's name, ${name}, to remove it`)
    this.update(name, { state: 'removing' })
    const provider = this.provider(row.account)
    if (provider != null) {
      if (row.provider_id != null) await provider.destroy(row.provider_id)
      for (const machine of await provider.list(this.tag(name)))
        await provider.destroy(machine.id)
      await provider.deleteFirewall?.(this.tag(name))
      if (this.options.dns != null) await this.options.dns.remove(row, provider)
      if (this.options.space != null)
        await this.options.space.remove(row, provider, {
          deleteSpace: options.deleteSpace === true,
          keyName: this.tag(name),
        })
    }
    if (
      row.fingerprint != null &&
      this.options.registry.get(row.fingerprint) != null
    )
      this.options.registry.remove(row.fingerprint)
    if (
      row.origin != null &&
      this.options.hostSettings.get()?.origin === row.origin
    )
      await this.options.hostSettings.set(undefined)
    this.firewallFor.delete(name)
    this.update(name, { state: 'removed' })
    this.log(`Removed host ${name}`)
  }
}

class HostError extends Error {}

const notBack = (version: string): string =>
  `It did not come back on ${version}`
