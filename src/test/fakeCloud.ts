import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  ProviderError,
  type CloudProvider,
  type MachineSpec,
  type ProviderMachine,
  type ProviderSnapshot,
  type Catalog,
  type FirewallRule,
  type SpacesGrant,
} from '../master/cloud/digitalocean.js'
import { PAIRING_FILE } from '../node/identity.js'
import { startNode, type RunningNode } from '../node/serve.js'
import { quietMac } from './fakeMac.js'
import type { FakeSpaces, FakeSpacesKey } from './fakeSpaces.js'

interface FakeMachine extends ProviderMachine {
  spec: MachineSpec
  node?: RunningNode
  dir: string
}

/**
 * A cloud provider in this process: creating a machine boots a real worker
 * from the pairing file in its first-boot data, listening on a local port.
 */
export class FakeCloud implements CloudProvider {
  readonly machines = new Map<string, FakeMachine>()
  readonly snapshotList = new Map<string, ProviderSnapshot & { from: string }>()
  readonly firewalls: Array<{
    name: string
    port: number
    sources: string[]
    tag: string
  }> = []
  readonly created: MachineSpec[] = []
  readonly deleted: string[] = []
  /** Make the next calls fail like the provider would. */
  failCreate: ProviderError['kind'] | undefined
  failSnapshot = false
  /** How long a machine stays `new` after its worker starts, as a slow boot. */
  bootDelayMs = 0
  /** Whether hosts have the root updater `--install` writes. */
  updater = false
  /** Snapshots that boot but never pair (a broken image). */
  readonly broken = new Set<string>()
  private next = 1

  constructor(private readonly root: string) {}

  /** The pairing material inside first-boot data. */
  static pairing(userData: string): {
    cert: string
    key: string
    secret: string
  } {
    const match = /<<'MASON_PAIRING'\n([\s\S]*?)\nMASON_PAIRING/.exec(userData)
    if (match == null) throw new Error('No pairing file in the first-boot data')
    return JSON.parse(match[1]!) as {
      cert: string
      key: string
      secret: string
    }
  }

  async create(spec: MachineSpec): Promise<ProviderMachine> {
    if (this.failCreate != null)
      throw new ProviderError(`Fake ${this.failCreate}`, this.failCreate)
    const id = String(this.next++)
    const dir = mkdtempSync(path.join(this.root, `machine-${id}-`))
    const machine: FakeMachine = {
      id,
      name: spec.name,
      status: 'new',
      tags: spec.tags,
      spec,
      dir,
    }
    this.machines.set(id, machine)
    this.created.push(spec)
    // Boots in the background, as a droplet does.
    void this.boot(machine)
    return { id, name: spec.name, status: 'new', tags: spec.tags }
  }

  private async boot(machine: FakeMachine): Promise<void> {
    const data = path.join(machine.dir, 'data')
    mkdirSync(data, { mode: 0o700 })
    if (!this.broken.has(machine.spec.image))
      // What `mason worker --install --pairing-file` leaves for the service's first start.
      writeFileSync(
        path.join(data, PAIRING_FILE),
        JSON.stringify(FakeCloud.pairing(machine.spec.userData)),
        { mode: 0o600 },
      )
    // A droplet tagged as a Mason host boots a host; any other, a worker.
    const host = machine.spec.tags.includes('mason-host')
    machine.node = await startNode(
      host
        ? {
            role: 'host',
            data,
            port: 0,
            linkPort: 0,
            listen: '127.0.0.1',
            heartbeatMs: 0,
            updaterExists: (): boolean => this.updater,
          }
        : {
            role: 'worker',
            data,
            linkPort: 0,
            listen: '127.0.0.1',
            heartbeatMs: 0,
            updaterExists: (): boolean => this.updater,
            workerOptions: { flushMs: 50, systemRun: quietMac() },
          },
      () => undefined,
    )
    if (this.bootDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.bootDelayMs))
    machine.status = 'active'
    machine.address = '127.0.0.1'
    machine.port = machine.node.link!.port
  }

  async get(id: string): Promise<ProviderMachine | undefined> {
    const machine = this.machines.get(id)
    if (machine == null) return undefined
    return {
      id,
      name: machine.name,
      status: machine.status,
      tags: machine.tags,
      ...(machine.address == null ? {} : { address: machine.address }),
      ...(machine.port == null ? {} : { port: machine.port }),
    }
  }

  async list(tag: string): Promise<ProviderMachine[]> {
    return [...this.machines.values()]
      .filter((machine) => machine.tags.includes(tag))
      .map((machine) => ({ ...machine }))
  }

  async powerOff(id: string): Promise<void> {
    const machine = this.machines.get(id)
    if (machine == null) return
    machine.status = 'off'
    await machine.node?.close()
    machine.node = undefined
  }

  async snapshot(id: string, name: string): Promise<ProviderSnapshot> {
    if (this.failSnapshot)
      throw new ProviderError('Fake snapshot failure', 'other')
    const snapshot = {
      id: `snap-${this.next++}`,
      name,
      sizeGb: 25,
      createdAt: Date.now(),
      from: id,
    }
    this.snapshotList.set(snapshot.id, snapshot)
    return snapshot
  }

  async destroy(id: string): Promise<void> {
    const machine = this.machines.get(id)
    await machine?.node?.close()
    this.machines.delete(id)
    this.deleted.push(id)
  }

  async snapshots(): Promise<ProviderSnapshot[]> {
    return [...this.snapshotList.values()]
  }
  async hasSnapshot(id: string): Promise<boolean> {
    return this.snapshotList.has(id)
  }
  async deleteSnapshot(id: string): Promise<void> {
    this.snapshotList.delete(id)
  }
  /** Asked for by the pool form. */
  catalogCalls = 0
  async catalog(): Promise<Catalog> {
    this.catalogCalls++
    return {
      regions: [
        { slug: 'nyc3', name: 'New York 3' },
        { slug: 'sfo3', name: 'San Francisco 3' },
      ],
      sizes: [
        {
          slug: 's-1vcpu-1gb',
          description: 'Basic',
          priceMonthly: 6,
          regions: ['nyc3', 'sfo3'],
        },
        {
          slug: 's-2vcpu-4gb',
          description: 'Basic',
          priceMonthly: 24,
          regions: ['sfo3'],
        },
      ],
      images: [{ slug: 'ubuntu-24-04-x64', name: 'Ubuntu 24.04 (LTS) x64' }],
    }
  }

  async priceHourly(): Promise<number> {
    return 0.01
  }
  async firewall(
    name: string,
    rules: FirewallRule[],
    tag: string,
  ): Promise<void> {
    for (const rule of rules)
      this.firewalls.push({ name, port: rule.port, sources: rule.sources, tag })
  }
  readonly deletedFirewalls: string[] = []
  async deleteFirewall(name: string): Promise<void> {
    this.deletedFirewalls.push(name)
  }

  /** The domains the fake account's DNS holds. */
  readonly domains_ = new Set<string>()
  /** A records by domain: id, record name and address. */
  private readonly dns = new Map<
    string,
    Array<{ id: string; name: string; data: string }>
  >()
  private nextRecord = 1
  /** Changing DNS calls, in order. */
  readonly dnsCalls: string[] = []
  async domains(): Promise<string[]> {
    return [...this.domains_]
  }
  /** Records for a full name, as the provider lists them. */
  records(domain: string, fqdn: string): Array<{ id: string; data: string }> {
    return (this.dns.get(domain) ?? [])
      .filter(
        (record) =>
          (record.name === '@' ? domain : `${record.name}.${domain}`) === fqdn,
      )
      .map((record) => ({ id: record.id, data: record.data }))
  }
  async dnsRecords(
    domain: string,
    fqdn: string,
  ): Promise<Array<{ id: string; data: string }>> {
    this.dnsCalls.push('list')
    return this.records(domain, fqdn)
  }
  /** Adds a record as a person would, outside Mason. */
  addRecord(domain: string, name: string, data: string): string {
    const id = String(this.nextRecord++)
    this.dns.set(domain, [...(this.dns.get(domain) ?? []), { id, name, data }])
    return id
  }
  setRecord(domain: string, id: string, data: string): void {
    for (const record of this.dns.get(domain) ?? [])
      if (record.id === id) record.data = data
  }
  removeRecord(domain: string, id: string): void {
    this.dns.set(
      domain,
      (this.dns.get(domain) ?? []).filter((record) => record.id !== id),
    )
  }
  async createDnsRecord(
    domain: string,
    name: string,
    data: string,
  ): Promise<{ id: string; data: string }> {
    this.dnsCalls.push(`create ${name} ${data}`)
    return { id: this.addRecord(domain, name, data), data }
  }
  async updateDnsRecord(
    domain: string,
    id: string,
    data: string,
  ): Promise<void> {
    this.dnsCalls.push(`update ${id} ${data}`)
    this.setRecord(domain, id, data)
  }
  async deleteDnsRecord(domain: string, id: string): Promise<void> {
    this.dnsCalls.push(`delete ${id}`)
    this.removeRecord(domain, id)
  }

  /** The account's Spaces, when a test gives it some. */
  spaces: FakeSpaces | undefined
  /** Spaces key calls, in order. */
  readonly spacesCalls: string[] = []
  async spacesKeys(): Promise<Array<{ id: string; name: string }>> {
    return [...(this.spaces?.keys ?? new Map()).entries()].map(
      ([id, key]: [string, FakeSpacesKey]) => ({ id, name: key.name }),
    )
  }
  async createSpacesKey(
    name: string,
    grants: SpacesGrant[],
  ): Promise<{ id: string; secret: string }> {
    if (this.spaces == null) throw new ProviderError('No Spaces', 'missing')
    this.spacesCalls.push(`create ${name}`)
    // DigitalOcean grants a key only on a bucket that exists.
    if (
      grants.some(
        (grant) =>
          grant.bucket !== '' && !this.spaces!.buckets.has(grant.bucket),
      )
    )
      throw new ProviderError(
        'DigitalOcean POST /spaces/keys: 403 invalid grant',
        'auth',
      )
    const secret = `secret-${name}-${this.spacesCalls.length}`
    const all = grants.some(
      (grant) => grant.permission === 'fullaccess' && grant.bucket === '',
    )
    const id = this.spaces.addKey({
      name,
      secret,
      grants: all ? 'all' : grants.map((grant) => grant.bucket),
    })
    return { id, secret }
  }
  async deleteSpacesKey(id: string): Promise<void> {
    this.spacesCalls.push(`delete ${this.spaces?.keys.get(id)?.name ?? id}`)
    this.spaces?.keys.delete(id)
  }

  /** Stops every machine still running. */
  async close(): Promise<void> {
    for (const machine of this.machines.values()) await machine.node?.close()
  }
}
