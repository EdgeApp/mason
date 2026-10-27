/**
 * The cloud providers pools use. DigitalOcean is the first: its API token
 * lives only in the master's `cloud` settings.
 */

export interface MachineSpec {
  name: string
  region: string
  size: string
  /** A base image slug, or a snapshot's provider ID. */
  image: string
  tags: string[]
  /** First-boot data: the installer and the pairing file. */
  userData: string
}

export interface ProviderMachine {
  id: string
  name: string
  status: 'new' | 'active' | 'off' | 'archive'
  /** The public address once assigned; tests add a port. */
  address?: string
  port?: number
  tags: string[]
}

export interface ProviderSnapshot {
  id: string
  name: string
  sizeGb: number
  createdAt: number
}

/** Why a provider call failed: quota, rate limit, a region down, the token, or something else. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'quota'
      | 'rate'
      | 'unavailable'
      | 'auth'
      | 'missing'
      | 'other',
  ) {
    super(message)
  }
}

export interface CloudProvider {
  create(spec: MachineSpec): Promise<ProviderMachine>
  get(id: string): Promise<ProviderMachine | undefined>
  /** Machines carrying a tag. */
  list(tag: string): Promise<ProviderMachine[]>
  powerOff(id: string): Promise<void>
  /** Takes a snapshot and waits until it is complete. */
  snapshot(id: string, name: string): Promise<ProviderSnapshot>
  destroy(id: string): Promise<void>
  snapshots(): Promise<ProviderSnapshot[]>
  hasSnapshot(id: string): Promise<boolean>
  deleteSnapshot(id: string): Promise<void>
  /** A size's price in dollars per hour. */
  priceHourly(size: string): Promise<number>
  /** Ensures a firewall that admits `port` only from `sources` to machines tagged `tag`. */
  firewall(
    name: string,
    port: number,
    sources: string[],
    tag: string,
  ): Promise<void>
}

/** Snapshot storage, dollars per GB per month. */
export const SNAPSHOT_GB_MONTH = 0.06

interface Droplet {
  id: number
  name: string
  status: ProviderMachine['status']
  tags?: string[]
  networks?: { v4?: Array<{ ip_address: string; type: string }> }
}

export class DigitalOcean implements CloudProvider {
  private prices: Map<string, number> | undefined
  constructor(
    private readonly token: string,
    private readonly api = 'https://api.digitalocean.com/v2',
    private readonly wait = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private async call<T>(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.api}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body == null ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      })
    } catch (error) {
      throw new ProviderError(
        `DigitalOcean is unreachable: ${(error as Error).message}`,
        'unavailable',
      )
    }
    if (response.status === 204) return undefined as T
    const text = await response.text()
    const parsed = text === '' ? {} : (JSON.parse(text) as { message?: string })
    if (response.ok) return parsed as T
    const message =
      `DigitalOcean ${method} ${route.split('?')[0]}: ${response.status} ${parsed.message ?? ''}`.trim()
    if (response.status === 401 || response.status === 403)
      throw new ProviderError(message, 'auth')
    if (response.status === 404) throw new ProviderError(message, 'missing')
    if (response.status === 429) throw new ProviderError(message, 'rate')
    if (response.status === 422 && /limit|quota/i.test(parsed.message ?? ''))
      throw new ProviderError(message, 'quota')
    if (response.status >= 500) throw new ProviderError(message, 'unavailable')
    throw new ProviderError(message, 'other')
  }

  private machine(droplet: Droplet): ProviderMachine {
    const address = droplet.networks?.v4?.find(
      (network) => network.type === 'public',
    )?.ip_address
    return {
      id: String(droplet.id),
      name: droplet.name,
      status: droplet.status,
      tags: droplet.tags ?? [],
      ...(address == null ? {} : { address }),
    }
  }

  async create(spec: MachineSpec): Promise<ProviderMachine> {
    const image = /^\d+$/.test(spec.image) ? Number(spec.image) : spec.image
    const { droplet } = await this.call<{ droplet: Droplet }>(
      'POST',
      '/droplets',
      {
        name: spec.name,
        region: spec.region,
        size: spec.size,
        image,
        tags: spec.tags,
        user_data: spec.userData,
        ipv6: false,
        monitoring: false,
      },
    )
    return this.machine(droplet)
  }

  async get(id: string): Promise<ProviderMachine | undefined> {
    try {
      return this.machine(
        (await this.call<{ droplet: Droplet }>('GET', `/droplets/${id}`))
          .droplet,
      )
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'missing')
        return undefined
      throw error
    }
  }

  async list(tag: string): Promise<ProviderMachine[]> {
    const out: ProviderMachine[] = []
    for (let page = 1; ; page++) {
      const { droplets, links } = await this.call<{
        droplets: Droplet[]
        links?: { pages?: { next?: string } }
      }>(
        'GET',
        `/droplets?tag_name=${encodeURIComponent(tag)}&per_page=200&page=${page}`,
      )
      out.push(...droplets.map((droplet) => this.machine(droplet)))
      if (links?.pages?.next == null) return out
    }
  }

  private async action(id: string, body: object): Promise<void> {
    const { action } = await this.call<{ action: { id: number } }>(
      'POST',
      `/droplets/${id}/actions`,
      body,
    )
    for (let i = 0; i < 720; i++) {
      const { action: state } = await this.call<{ action: { status: string } }>(
        'GET',
        `/actions/${action.id}`,
      )
      if (state.status === 'completed') return
      if (state.status === 'errored')
        throw new ProviderError(
          `DigitalOcean action ${JSON.stringify(body)} failed`,
          'other',
        )
      await this.wait(5000)
    }
    throw new ProviderError(
      `DigitalOcean action ${JSON.stringify(body)} did not finish`,
      'unavailable',
    )
  }

  async powerOff(id: string): Promise<void> {
    await this.action(id, { type: 'power_off' })
  }

  async snapshot(id: string, name: string): Promise<ProviderSnapshot> {
    await this.action(id, { type: 'snapshot', name })
    const { snapshots } = await this.call<{
      snapshots: Array<{
        id: number | string
        name: string
        size_gigabytes: number
        created_at: string
      }>
    }>('GET', `/droplets/${id}/snapshots?per_page=200`)
    const made = snapshots.filter((snapshot) => snapshot.name === name).pop()
    if (made == null)
      throw new ProviderError(
        `Snapshot ${name} is missing after it completed`,
        'other',
      )
    return {
      id: String(made.id),
      name: made.name,
      sizeGb: made.size_gigabytes,
      createdAt: Date.parse(made.created_at),
    }
  }

  async destroy(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/droplets/${id}`)
    } catch (error) {
      if (!(error instanceof ProviderError && error.kind === 'missing'))
        throw error
    }
  }

  async snapshots(): Promise<ProviderSnapshot[]> {
    const out: ProviderSnapshot[] = []
    for (let page = 1; ; page++) {
      const { snapshots, links } = await this.call<{
        snapshots: Array<{
          id: string
          name: string
          size_gigabytes: number
          created_at: string
        }>
        links?: { pages?: { next?: string } }
      }>('GET', `/snapshots?resource_type=droplet&per_page=200&page=${page}`)
      out.push(
        ...snapshots.map((snapshot) => ({
          id: String(snapshot.id),
          name: snapshot.name,
          sizeGb: snapshot.size_gigabytes,
          createdAt: Date.parse(snapshot.created_at),
        })),
      )
      if (links?.pages?.next == null) return out
    }
  }

  async hasSnapshot(id: string): Promise<boolean> {
    try {
      await this.call('GET', `/snapshots/${id}`)
      return true
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'missing')
        return false
      throw error
    }
  }

  async deleteSnapshot(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/snapshots/${id}`)
    } catch (error) {
      if (!(error instanceof ProviderError && error.kind === 'missing'))
        throw error
    }
  }

  async priceHourly(size: string): Promise<number> {
    if (this.prices == null) {
      const { sizes } = await this.call<{
        sizes: Array<{ slug: string; price_hourly: number }>
      }>('GET', '/sizes?per_page=200')
      this.prices = new Map(
        sizes.map((entry) => [entry.slug, entry.price_hourly]),
      )
    }
    const price = this.prices.get(size)
    if (price == null)
      throw new ProviderError(`DigitalOcean has no size ${size}`, 'other')
    return price
  }

  async firewall(
    name: string,
    port: number,
    sources: string[],
    tag: string,
  ): Promise<void> {
    const body = {
      name,
      inbound_rules: [
        {
          protocol: 'tcp',
          ports: String(port),
          sources: { addresses: sources },
        },
      ],
      outbound_rules: [
        {
          protocol: 'tcp',
          ports: 'all',
          destinations: { addresses: ['0.0.0.0/0', '::/0'] },
        },
        {
          protocol: 'udp',
          ports: 'all',
          destinations: { addresses: ['0.0.0.0/0', '::/0'] },
        },
        {
          protocol: 'icmp',
          destinations: { addresses: ['0.0.0.0/0', '::/0'] },
        },
      ],
      tags: [tag],
    }
    // DigitalOcean refuses a firewall for a tag no resource has yet; creating
    // a tag that exists is harmless.
    await this.call('POST', '/tags', { name: tag })
    const { firewalls } = await this.call<{
      firewalls: Array<{ id: string; name: string }>
    }>('GET', '/firewalls?per_page=200')
    const existing = firewalls.find((firewall) => firewall.name === name)
    if (existing == null) await this.call('POST', '/firewalls', body)
    else await this.call('PUT', `/firewalls/${existing.id}`, body)
  }
}
