import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { nodeMain, type MainIO } from '../../node/main.js'
import { pinnedFetch } from '../../node/pinnedFetch.js'
import { cluster, type Cluster } from '../../test/cluster.js'
import { FakeCloud } from '../../test/fakeCloud.js'
import { MASTER_SESSION_COOKIE } from '../auth.js'
import { localOperator } from '../roles.js'
import type { CloudHostRow } from './hosts.js'

// API replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const KEY = 'dop_v1_' + 'e'.repeat(64)
const idOf = (fingerprint: string): string =>
  createHash('sha256').update(fingerprint).digest('hex').slice(0, 10)
const node = {
  name: 'linux-node',
  account: 'do',
  region: 'sfo3',
  size: 's-1vcpu-1gb',
  type: 'linux-x86',
  labels: 'e2e, fast',
}

describe('Permanent cloud nodes on DigitalOcean', function () {
  this.timeout(120_000)
  let c: Cluster
  let cloud: FakeCloud
  const io = (): MainIO & { lines: string[] } => {
    const lines: string[] = []
    return {
      lines,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      system: (): never => {
        throw new Error('unused')
      },
      stopped: async () => undefined,
      program: () => [],
    }
  }

  before(async () => {
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'nodes-'),
    )
    cloud = new FakeCloud(dir)
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [],
      masterOptions: {
        cloudHosts: {
          provider: () => cloud,
          publicAddress: async () => '203.0.113.7',
          tickMs: 3_600_000,
          settleMs: 50,
        },
      },
    })
    await c.master.master!.settings.set(localOperator, 'cloudAccounts', {
      accounts: [
        { id: 'do', name: 'DigitalOcean', provider: 'digitalocean', key: KEY },
        {
          id: 'mac',
          name: 'NoMac',
          provider: 'nomac',
          key: 'nmk_' + 'f'.repeat(40),
        },
      ],
    })
  })
  after(async () => {
    await c?.close()
    await cloud?.close()
  })

  const hosts = (): Json => c.master.master!.cloudHosts
  const row = (name = 'linux-node'): CloudHostRow => hosts().get(name, 'worker')
  const until = async (name: string, state: string): Promise<Json> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const reply = await c.api(
        'POST',
        `/api/v2/cloud/nodes/${name}/reconcile`,
        {},
      )
      assert.equal(reply.status, 200, reply.text)
      if (reply.json.state === state) return reply.json
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for node ${name} ${state}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  /** The master's release, as `mason update` would change it. */
  const follows = (): { version?: string; updateTimeoutMs?: number } =>
    (
      c.master.master!.cloudHosts as unknown as {
        options: { version?: string; updateTimeoutMs?: number }
      }
    ).options

  it('U3.2 a node is a worker droplet: worker first boot, node tags, and a firewall with only the link port from the master', async () => {
    assert.match(
      (await c.api('POST', '/api/v2/cloud/nodes', { ...node, account: 'mac' }))
        .json.error,
      /Account mac is not a DigitalOcean account/,
    )
    assert.match(
      (
        await c.api('POST', '/api/v2/cloud/nodes', {
          ...node,
          type: 'Bad Type',
        })
      ).json.error,
      /node\.type is invalid/,
    )
    const created = await c.api('POST', '/api/v2/cloud/nodes', node)
    assert.equal(created.status, 201, created.text)
    assert.equal(created.json.role, 'worker')
    assert.deepEqual(created.json.labels, ['e2e', 'fast'])
    assert.equal(created.json.pairing_secret, undefined)
    await c.until(
      () => cloud.created.length === 1 || undefined,
      10_000,
      'the droplet',
    )
    const spec = cloud.created[0]!
    const tag = `mason-node-${idOf(c.master.identity.fingerprint)}-linux-node`
    assert.equal(spec.name, 'mason-node-linux-node')
    assert.deepEqual(spec.tags, ['mason-node', tag])
    assert.match(
      spec.userData,
      /mason worker --install --pairing-file "\$root\/root\/mason-pairing\.json" --link-port 9310 --listen 0\.0\.0\.0/,
    )
    assert.doesNotMatch(spec.userData, /caddy|mason host/i)
    await until('linux-node', 'ready')
    assert.deepEqual(
      cloud.firewalls
        .filter((rule) => rule.name === tag)
        .map((rule) => [rule.port, rule.sources]),
      [[9310, ['203.0.113.7']]],
    )
  })

  it('U3.3 it pairs as a worker with its name, type and labels, and never touches DNS, Spaces or the host setting', async () => {
    const ready = row()
    assert.equal(ready.state, 'ready')
    assert.equal(ready.pairing_secret, null)
    const record = c.master.master!.registry.get(ready.fingerprint!)!
    assert.equal(record.role, 'worker')
    assert.equal(record.name, 'linux-node')
    assert.equal(record.type, 'linux-x86')
    assert.deepEqual(record.labels, ['e2e', 'fast'])
    assert.equal(ready.dns_domain, null)
    assert.equal(ready.space_bucket, null)
    assert.equal(ready.origin, null)
    assert.equal(c.master.master!.settings.value('host'), undefined)
    // A second node beside it, and the name is taken across hosts and nodes.
    const second = await c.api('POST', '/api/v2/cloud/nodes', {
      ...node,
      name: 'second-node',
      labels: [],
    })
    assert.equal(second.status, 201, second.text)
    assert.match(
      (
        await c.api('POST', '/api/v2/cloud/hosts', {
          ...node,
          type: undefined,
          labels: undefined,
        })
      ).json.error,
      /already has a node named linux-node/,
    )
    await until('second-node', 'ready')
    assert.deepEqual(
      (await c.api('GET', '/api/v2/cloud/nodes')).json.map(
        (entry: Json) => entry.name,
      ),
      ['linux-node', 'second-node'],
    )
    assert.deepEqual((await c.api('GET', '/api/v2/cloud/hosts')).json, [])
  })

  /** A page as a signed-in administrator sees it. */
  const page = async (route: string): Promise<string> => {
    const master = c.master.master!
    const admin = master.database.db
      .prepare("SELECT id FROM accounts WHERE role='admin' ORDER BY id LIMIT 1")
      .get() as { id: number }
    const { token } = master.auth.start(admin.id, '127.0.0.1')
    const response = await pinnedFetch(
      c.master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:') + route,
      { headers: { cookie: `${MASTER_SESSION_COOKIE}=${token}` } },
      c.master.identity.pin,
    )
    return await response.text()
  }

  it('U3.6b/U6.4b the Nodes and Settings pages render cloud nodes and every card from what is stored', async () => {
    const master = c.master.master!
    // A host row as one made with a DNS name and a Space leaves it.
    master.database.db
      .prepare(
        "INSERT INTO cloud_hosts(name,account,provider,region,size,image,dns_domain,dns_name,address,origin,state,version,space_bucket,space_region,created_at,updated_at) VALUES('page-host','do','digitalocean','sfo3','s-1vcpu-1gb','ubuntu-24-04-x64','example.test','builds','203.0.113.30','https://builds.example.test','ready','0.1.0','mason-page','sfo3',1,1)",
      )
      .run()
    await master.settings.set(localOperator, 'storage', {
      driver: 's3',
      s3: {
        endpoint: 'https://sfo3.digitaloceanspaces.com',
        bucket: 'mason-page',
        region: 'sfo3',
        accessKeyId: 'PAGEKEY123',
        secretAccessKey: 'page-secret-123',
      },
    })
    const nodes = await page('/nodes')
    master.database.db
      .prepare("DELETE FROM cloud_hosts WHERE name='page-host'")
      .run()
    assert.match(
      nodes,
      /id="host-page-host"[\s\S]*?builds\.example\.test[\s\S]*?Builds Space <span class="mono">mason-page<\/span>/,
    )
    assert.match(nodes, /Waiting for its certificate/)
    assert.match(
      nodes,
      /<section class="panel" id="storage"><h3>[\s\S]*?<span class="mono">mason-page<\/span>[^<]*<\/td><td>[^<]*<span class="icon"[^>]*>[^<]*<\/span> New builds go here/,
    )
    assert.match(
      nodes,
      /id="cloud-node-linux-node" data-state="ready"[\s\S]*?linux-x86 · e2e · fast · sfo3/,
    )
    assert.match(nodes, /id="cloud-node-second-node"/)
    assert.match(nodes, /id="add-node-do"/)
    await master.settings.set(localOperator, 'signIn', {
      methods: [
        {
          id: 'google',
          type: 'oidc',
          name: 'Google',
          issuer: 'https://accounts.google.com',
          clientId: 'gid',
          clientSecret: 'g-secret-value',
        },
      ],
    })
    await master.settings.set(localOperator, 'nodeTypes', {
      'linux-x86': { software: { apt: ['jq'], node: '24' } },
    })
    try {
      const settings = await page('/settings')
      assert.match(
        settings,
        /data-path="\/api\/v2\/settings\/signIn\/methods\/google" data-method="PUT"/,
      )
      assert(!settings.includes('g-secret-value'))
      assert(!settings.includes('page-secret-123'))
      assert.match(
        settings,
        /id="node-type-linux-x86"[\s\S]*?name="software\.node" value="24"/,
      )
      assert.match(
        settings,
        /<span class="mono">mason-page<\/span>[^<]*<\/td><td>[^<]*<span class="icon"[^>]*>[^<]*<\/span> New builds go here/,
      )
      assert.match(
        settings,
        /<select id="new-space-account" name="account"><option value="do">DigitalOcean<\/option><\/select>/,
      )
      assert.match(settings, /name="monthlyBudget" value="200"/)
    } finally {
      await master.settings.set(localOperator, 'signIn', { methods: [] })
      await master.settings.set(localOperator, 'nodeTypes', {})
      await master.settings.set(localOperator, 'storage', { driver: 'disk' })
    }
  })

  it('U3.4 a node on another release is left to the worker updater: never sent node.update, it stays ready on the release it runs', async () => {
    cloud.updater = true
    const request = path.join(
      cloud.machines.get(row().provider_id!)!.dir,
      'data',
      'update-request.json',
    )
    const running = row().version!
    follows().version = '99.0.0'
    try {
      const reconciled = await c.api(
        'POST',
        '/api/v2/cloud/nodes/linux-node/reconcile',
        {},
      )
      assert.equal(reconciled.json.state, 'ready', reconciled.text)
      assert.equal(reconciled.json.version, running)
      // Relinking does not ask either.
      c.master.master!.registry.link(row().fingerprint!)!.close()
      await c.until(
        () => c.master.master!.registry.link(row().fingerprint!),
        30_000,
        'the node linking again',
      )
      assert.equal(row().state, 'ready')
      assert(!existsSync(request), 'no update request was written')
    } finally {
      follows().version = undefined
      cloud.updater = false
    }
  })

  it('U3.4b a node whose naming fails after pairing is still recorded, and is named at the next reconcile', async () => {
    const registry = c.master.master!.registry
    const assign = registry.assign.bind(registry)
    let refused = 0
    registry.assign = async (
      ...args: Parameters<typeof assign>
    ): ReturnType<typeof assign> => {
      if (refused++ === 0) throw new Error('The database is locked')
      return await assign(...args)
    }
    try {
      const made = await c.api('POST', '/api/v2/cloud/nodes', {
        ...node,
        name: 'third-node',
        labels: ['late'],
      })
      assert.equal(made.status, 201, made.text)
      const ready = await until('third-node', 'ready')
      assert.notEqual(ready.fingerprint, null)
      assert.equal(ready.pairing, false)
      // The next reconcile names it.
      await c.api('POST', '/api/v2/cloud/nodes/third-node/reconcile', {})
      assert.equal(registry.get(ready.fingerprint)!.name, 'third-node')
      assert.deepEqual(registry.get(ready.fingerprint)!.labels, ['late'])
      assert(refused >= 2)
      // A type an administrator gives it later is kept across reconciles.
      await assign(ready.fingerprint, { type: 'retyped', labels: ['mine'] })
      await c.api('POST', '/api/v2/cloud/nodes/third-node/reconcile', {})
      assert.equal(registry.get(ready.fingerprint)!.type, 'retyped')
      assert.deepEqual(registry.get(ready.fingerprint)!.labels, ['mine'])
      // Offline for a while, it is not marked as an error.
      await cloud.powerOff(row('third-node').provider_id!)
      await c.until(
        () => registry.link(ready.fingerprint) == null || undefined,
        10_000,
        'the node link closed',
      )
      const offline = await c.api(
        'POST',
        '/api/v2/cloud/nodes/third-node/reconcile',
        {},
      )
      assert.equal(offline.json.state, 'ready', offline.text)
      assert.equal(offline.json.error, null)
    } finally {
      registry.assign = assign
    }
    assert.equal(
      (
        await c.api('DELETE', '/api/v2/cloud/nodes/third-node', {
          confirm: 'third-node',
        })
      ).status,
      200,
    )
  })

  it('U3.5 remove needs the typed name, destroys the droplet and firewall and unpairs; the CLI lists, reconciles and removes nodes', async () => {
    const list = io()
    assert.equal(
      await nodeMain(['cloud', 'nodes', 'list', '--data', c.master.dir], list),
      0,
    )
    assert.match(
      list.lines.join('\n'),
      /^linux-node {2}ready {2}sfo3 s-1vcpu-1gb/m,
    )
    const again = io()
    assert.equal(
      await nodeMain(
        ['cloud', 'nodes', 'reconcile', 'second-node', '--data', c.master.dir],
        again,
      ),
      0,
    )
    const before = row()
    const tag = `mason-node-${idOf(c.master.identity.fingerprint)}-linux-node`
    assert.match(
      (
        await c.api('DELETE', '/api/v2/cloud/nodes/linux-node', {
          confirm: 'x',
        })
      ).json.error,
      /Type the node's name, linux-node, to remove it/,
    )
    assert.equal(
      (
        await c.api('DELETE', '/api/v2/cloud/hosts/linux-node', {
          confirm: 'linux-node',
        })
      ).status,
      404,
    )
    const removed = await c.api('DELETE', '/api/v2/cloud/nodes/linux-node', {
      confirm: 'linux-node',
    })
    assert.equal(removed.status, 200, removed.text)
    assert(cloud.deleted.includes(before.provider_id!))
    assert(cloud.deletedFirewalls.includes(tag))
    assert.equal(c.master.master!.registry.get(before.fingerprint!), undefined)
    assert.equal(row(), undefined)
    const cli = io()
    assert.equal(
      await nodeMain(
        ['cloud', 'nodes', 'remove', 'second-node', '--data', c.master.dir],
        cli,
      ),
      0,
    )
    assert.deepEqual(cli.lines, ['Removed node second-node'])
    assert.deepEqual((await c.api('GET', '/api/v2/cloud/nodes')).json, [])
  })
})
