import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  ProviderError,
  type CloudProvider,
  type MachineSpec,
  type ProviderMachine,
  type ProviderSnapshot,
} from '../master/cloud/digitalocean.js'
import { PAIRING_FILE } from '../node/identity.js'
import { startNode, type RunningNode } from '../node/serve.js'
import { quietMac } from './fakeMac.js'

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
    machine.node = await startNode(
      {
        role: 'worker',
        data,
        linkPort: 0,
        listen: '127.0.0.1',
        heartbeatMs: 0,
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
  async priceHourly(): Promise<number> {
    return 0.01
  }
  async firewall(
    name: string,
    port: number,
    sources: string[],
    tag: string,
  ): Promise<void> {
    this.firewalls.push({ name, port, sources, tag })
  }

  /** Stops every machine still running. */
  async close(): Promise<void> {
    for (const machine of this.machines.values()) await machine.node?.close()
  }
}
