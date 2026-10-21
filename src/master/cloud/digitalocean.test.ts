import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'mocha'
import { DigitalOcean, ProviderError } from './digitalocean.js'

// Request bodies are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** DigitalOcean's API as the pools use it, with one droplet, one snapshot and one firewall. */
class FakeApi {
  server!: Server
  base = ''
  readonly requests: Array<{
    method: string
    path: string
    body: Json
    auth: string
  }> = []
  droplets = new Map<number, Json>()
  snapshots = new Map<string, Json>()
  firewalls: Json[] = []
  tags = new Set<string>()
  actions = new Map<number, { polls: number; error?: boolean }>()
  /** The next response's status and message, once. */
  fail: { status: number; message: string } | undefined
  private next = 100

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        const body = text === '' ? undefined : (JSON.parse(text) as Json)
        const url = new URL(req.url!, 'http://api')
        this.requests.push({
          method: req.method!,
          path: url.pathname + url.search,
          body,
          auth: req.headers.authorization ?? '',
        })
        const send = (status: number, value?: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(value == null ? '' : JSON.stringify(value))
        }
        if (this.fail != null) {
          const failure = this.fail
          this.fail = undefined
          send(failure.status, { id: 'error', message: failure.message })
          return
        }
        const route = `${req.method} ${url.pathname}`
        let match: RegExpExecArray | null
        if (route === 'POST /v2/droplets') {
          const id = this.next++
          const droplet = {
            id,
            name: body.name,
            status: 'new',
            tags: body.tags,
            image: body.image,
            user_data: body.user_data,
          }
          this.droplets.set(id, droplet)
          send(202, { droplet })
        } else if (
          (match = /^GET \/v2\/droplets\/(\d+)$/.exec(route)) != null
        ) {
          const droplet = this.droplets.get(Number(match[1]))
          if (droplet == null)
            send(404, {
              id: 'not_found',
              message: 'The resource you were accessing could not be found.',
            })
          else
            send(200, {
              droplet: {
                ...droplet,
                status: 'active',
                networks: {
                  v4: [
                    { ip_address: '10.0.0.2', type: 'private' },
                    { ip_address: '203.0.113.20', type: 'public' },
                  ],
                },
              },
            })
        } else if (route === 'GET /v2/droplets') {
          const page = Number(url.searchParams.get('page'))
          const all = [...this.droplets.values()].filter((droplet) =>
            droplet.tags.includes(url.searchParams.get('tag_name')),
          )
          send(200, {
            droplets: all.slice(page - 1, page),
            links: page < all.length ? { pages: { next: 'more' } } : {},
          })
        } else if (
          (match = /^POST \/v2\/droplets\/(\d+)\/actions$/.exec(route)) != null
        ) {
          const id = this.next++
          this.actions.set(id, {
            polls: 0,
            ...(body.type === 'power_off' && Number(match[1]) === 999
              ? { error: true }
              : {}),
          })
          // A snapshot named `vanishing` completes but never appears.
          if (body.type === 'snapshot' && body.name !== 'vanishing') {
            const snapshot = {
              id: String(this.next++),
              name: body.name,
              size_gigabytes: 12.5,
              created_at: '2026-10-20T12:00:00Z',
              droplet: Number(match[1]),
            }
            this.snapshots.set(snapshot.id, snapshot)
          }
          send(201, { action: { id, status: 'in-progress' } })
        } else if ((match = /^GET \/v2\/actions\/(\d+)$/.exec(route)) != null) {
          const action = this.actions.get(Number(match[1]))!
          action.polls++
          send(200, {
            action: {
              status: action.error
                ? 'errored'
                : action.polls >= 2
                  ? 'completed'
                  : 'in-progress',
            },
          })
        } else if (
          (match = /^GET \/v2\/droplets\/(\d+)\/snapshots$/.exec(route)) != null
        ) {
          send(200, {
            snapshots: [...this.snapshots.values()].filter(
              (snapshot) => snapshot.droplet === Number(match![1]),
            ),
          })
        } else if (
          (match = /^DELETE \/v2\/droplets\/(\d+)$/.exec(route)) != null
        ) {
          if (!this.droplets.delete(Number(match[1])))
            send(404, { message: 'gone' })
          else send(204)
        } else if (route === 'GET /v2/snapshots') {
          send(200, { snapshots: [...this.snapshots.values()], links: {} })
        } else if (
          (match = /^GET \/v2\/snapshots\/(.+)$/.exec(route)) != null
        ) {
          if (this.snapshots.has(match[1]!))
            send(200, { snapshot: this.snapshots.get(match[1]!) })
          else send(404, { message: 'not found' })
        } else if (
          (match = /^DELETE \/v2\/snapshots\/(.+)$/.exec(route)) != null
        ) {
          if (!this.snapshots.delete(match[1]!))
            send(404, { message: 'not found' })
          else send(204)
        } else if (route === 'GET /v2/sizes') {
          send(200, { sizes: [{ slug: 's-1vcpu-1gb', price_hourly: 0.00893 }] })
        } else if (route === 'GET /v2/firewalls') {
          send(200, { firewalls: this.firewalls })
        } else if (route === 'POST /v2/tags') {
          this.tags.add(String(body.name))
          send(201, { tag: { name: body.name } })
        } else if (route === 'POST /v2/firewalls') {
          // As DigitalOcean does: a firewall's tags must exist.
          if (!(body.tags as string[]).every((tag) => this.tags.has(tag))) {
            send(422, { message: 'tag mason-pool does not exist' })
            return
          }
          this.firewalls.push({ id: 'fw-1', ...body })
          send(202, { firewall: this.firewalls[0] })
        } else if (
          (match = /^PUT \/v2\/firewalls\/(.+)$/.exec(route)) != null
        ) {
          this.firewalls = [{ id: match[1], ...body }]
          send(200, { firewall: this.firewalls[0] })
        } else send(404, { message: `no route ${route}` })
      })
    })
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    )
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v2`
  }
}

describe('DigitalOcean provider', () => {
  const api = new FakeApi()
  let provider: DigitalOcean
  before(async () => {
    await api.start()
    provider = new DigitalOcean('dop_v1_token', api.base, async () => undefined)
  })
  after(() => {
    api.server.close()
  })

  it('U11.2 creates, finds, lists and destroys droplets with the pool’s tags and first-boot data', async () => {
    const made = await provider.create({
      name: 'mason-linux-cloud-1',
      region: 'nyc3',
      size: 's-1vcpu-1gb',
      image: 'ubuntu-24-04-x64',
      tags: ['mason-pool'],
      userData: '#!/bin/bash\n',
    })
    assert.equal(made.status, 'new')
    const created = api.requests.at(-1)!
    assert.equal(created.auth, 'Bearer dop_v1_token')
    assert.deepEqual(created.body, {
      name: 'mason-linux-cloud-1',
      region: 'nyc3',
      size: 's-1vcpu-1gb',
      image: 'ubuntu-24-04-x64',
      tags: ['mason-pool'],
      user_data: '#!/bin/bash\n',
      ipv6: false,
      monitoring: false,
    })
    // A snapshot ID is sent as a number.
    await provider.create({
      name: 'from-snapshot',
      region: 'nyc3',
      size: 's-1vcpu-1gb',
      image: '12345',
      tags: ['mason-pool'],
      userData: '',
    })
    assert.equal(api.requests.at(-1)!.body.image, 12345)
    const found = await provider.get(made.id)
    assert.equal(found?.address, '203.0.113.20')
    assert.equal(found?.status, 'active')
    assert.equal(await provider.get('424242'), undefined)
    assert.deepEqual(
      (await provider.list('mason-pool')).map((machine) => machine.name),
      ['mason-linux-cloud-1', 'from-snapshot'],
    )
    await provider.destroy(made.id)
    await provider.destroy(made.id)
    assert.equal(await provider.get(made.id), undefined)
  })

  it('U11.4 powers off and snapshots through actions it waits for, and manages snapshots', async () => {
    const machine = await provider.create({
      name: 'snap',
      region: 'nyc3',
      size: 's-1vcpu-1gb',
      image: 'x',
      tags: ['mason-pool'],
      userData: '',
    })
    await provider.powerOff(machine.id)
    const snapshot = await provider.snapshot(
      machine.id,
      'mason-pool-linux-cloud-1',
    )
    assert.equal(snapshot.name, 'mason-pool-linux-cloud-1')
    assert.equal(snapshot.sizeGb, 12.5)
    assert.equal(snapshot.createdAt, Date.parse('2026-10-20T12:00:00Z'))
    assert(await provider.hasSnapshot(snapshot.id))
    assert.deepEqual(
      (await provider.snapshots()).map((entry) => entry.name),
      ['mason-pool-linux-cloud-1'],
    )
    await provider.deleteSnapshot(snapshot.id)
    await provider.deleteSnapshot(snapshot.id)
    assert.equal(await provider.hasSnapshot(snapshot.id), false)
    await assert.rejects(
      provider.snapshot(machine.id, 'vanishing'),
      /missing after it completed/,
    )
    api.droplets.set(999, {
      id: 999,
      name: 'broken',
      status: 'active',
      tags: [],
    })
    await assert.rejects(provider.powerOff('999'), /failed/)
  })

  it('U11.7 prices sizes and keeps one firewall for the link port', async () => {
    assert.equal(await provider.priceHourly('s-1vcpu-1gb'), 0.00893)
    await assert.rejects(provider.priceHourly('huge'), /no size huge/)
    await provider.firewall('mason-pools', 9310, ['203.0.113.7'], 'mason-pool')
    assert.equal(api.firewalls.length, 1)
    assert.deepEqual(api.firewalls[0].inbound_rules, [
      {
        protocol: 'tcp',
        ports: '9310',
        sources: { addresses: ['203.0.113.7'] },
      },
    ])
    await provider.firewall('mason-pools', 9310, ['198.51.100.9'], 'mason-pool')
    assert.equal(api.firewalls.length, 1)
    assert.deepEqual(api.firewalls[0].inbound_rules[0].sources, {
      addresses: ['198.51.100.9'],
    })
    assert.deepEqual(api.firewalls[0].tags, ['mason-pool'])
    assert(api.tags.has('mason-pool'))
  })

  it('U11.6 names each provider failure', async () => {
    for (const [status, message, kind] of [
      [401, 'Unable to authenticate you', 'auth'],
      [429, 'Too many requests', 'rate'],
      [422, 'You have reached the droplet limit', 'quota'],
      [503, 'Region nyc3 is unavailable', 'unavailable'],
      [422, 'Name is invalid', 'other'],
    ] as const) {
      api.fail = { status, message }
      await assert.rejects(
        provider.create({
          name: 'x',
          region: 'nyc3',
          size: 's',
          image: 'x',
          tags: [],
          userData: '',
        }),
        (error: unknown) => {
          assert(error instanceof ProviderError)
          assert.equal(error.kind, kind)
          assert.match(error.message, new RegExp(message))
          return true
        },
      )
    }
    const offline = new DigitalOcean('t', 'http://127.0.0.1:1/v2')
    await assert.rejects(
      offline.priceHourly('x'),
      (error: unknown) =>
        error instanceof ProviderError && error.kind === 'unavailable',
    )
  })
})
