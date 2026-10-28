import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { cluster, type Cluster } from '../../test/cluster.js'
import { FakeCloud } from '../../test/fakeCloud.js'
import { nodesView } from '../../view/admin.js'
import { localOperator } from '../roles.js'
import type { CloudHostRow } from './hosts.js'

// API replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const host = {
  name: 'e2e',
  account: 'do',
  region: 'sfo3',
  size: 's-1vcpu-1gb',
  dns: { domain: 'example.com', name: 'builds' },
}

describe('DNS records for cloud hosts', function () {
  this.timeout(120_000)
  let c: Cluster
  let cloud: FakeCloud
  let trusted = false

  before(async () => {
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'dns-'),
    )
    cloud = new FakeCloud(dir)
    cloud.domains_.add('example.com')
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [],
      masterOptions: {
        cloudHosts: {
          provider: () => cloud,
          publicAddress: async () => '203.0.113.7',
          tickMs: 3_600_000,
          trusted: async () => trusted,
        },
      },
    })
    await c.master.master!.settings.set(localOperator, 'cloudAccounts', {
      accounts: [
        {
          id: 'do',
          name: 'DigitalOcean',
          provider: 'digitalocean',
          key: 'dop_v1_' + 'f'.repeat(64),
        },
      ],
    })
  })
  after(async () => {
    await c?.close()
    await cloud?.close()
  })

  const row = (): CloudHostRow => c.master.master!.cloudHosts.get('e2e')!
  const reconcile = async (): Promise<Json> => {
    const reply = await c.api('POST', '/api/v2/cloud/hosts/e2e/reconcile', {})
    assert.equal(reply.status, 200, reply.text)
    return reply.json
  }
  const settle = async (state: string): Promise<Json> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const reply = await reconcile()
      if (reply.state === state) return reply
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for ${state}: ${JSON.stringify(reply)}`,
        )
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const records = (): Json[] =>
    cloud.records('example.com', 'builds.example.com')

  it('U5.5 a domain the account’s DNS does not hold is refused when the host is added', async () => {
    const refused = await c.api('POST', '/api/v2/cloud/hosts', {
      ...host,
      dns: { domain: 'elsewhere.org', name: 'builds' },
    })
    assert.equal(refused.status, 400)
    assert.equal(
      refused.json.error,
      "The account's DNS holds no domain elsewhere.org",
    )
    assert.equal(cloud.created.length, 0)
    assert.deepEqual((await c.api('GET', '/api/v2/cloud/hosts')).json, [])
  })

  it('U5.1/U5.6 a new host gets its own A record and its DNS name as origin, and waits for its certificate', async () => {
    const made = await c.api('POST', '/api/v2/cloud/hosts', host)
    assert.equal(made.status, 201, made.text)
    const ready = await settle('ready')
    assert.equal(ready.origin, 'https://builds.example.com')
    assert.deepEqual(
      records().map((record) => record.data),
      ['127.0.0.1'],
    )
    assert.equal(row().dns_owned, 1)
    assert.match(cloud.created.at(-1)!.userData, /^builds\.example\.com \{$/m)
    assert.equal(ready.certificate, 'waiting')
    const view = (): string =>
      nodesView({
        nodes: [],
        types: {},
        pools: [],
        cloudHosts: [
          {
            name: 'e2e',
            state: 'ready',
            account: 'do',
            region: 'sfo3',
            size: 's-1vcpu-1gb',
            address: row().address,
            origin: row().origin,
            dnsName: 'builds.example.com',
            certificate: row().certificate_at == null ? 'waiting' : 'trusted',
            error: null,
          },
        ],
        budget: { monthly: 200 },
        canChange: true,
      })
    assert.match(view(), /Waiting for its certificate/)
    trusted = true
    assert.equal((await reconcile()).certificate, 'trusted')
    assert.doesNotMatch(view(), /Waiting for its certificate/)
    // Reconciling again changes no record.
    const before = cloud.dnsCalls.length
    await reconcile()
    assert.deepEqual(
      cloud.dnsCalls.slice(before).filter((call) => call !== 'list'),
      [],
    )
  })

  it('U5.3 a record Mason made is made again when deleted by hand, and updated when it points at an old address', async () => {
    cloud.removeRecord('example.com', row().dns_record_id!)
    await reconcile()
    assert.deepEqual(
      records().map((record) => record.data),
      ['127.0.0.1'],
    )
    assert.equal(row().dns_owned, 1)
    // As after the droplet was remade at another address.
    cloud.setRecord('example.com', row().dns_record_id!, '198.51.100.4')
    await reconcile()
    assert.deepEqual(
      records().map((record) => record.data),
      ['127.0.0.1'],
    )
    assert(cloud.dnsCalls.includes(`update ${row().dns_record_id} 127.0.0.1`))
  })

  it('U5.4 a record Mason did not make that points elsewhere is left alone and named', async () => {
    cloud.removeRecord('example.com', row().dns_record_id!)
    cloud.addRecord('example.com', 'builds', '203.0.113.10')
    const failed = await reconcile()
    assert.equal(failed.state, 'error')
    assert.equal(
      failed.error,
      'builds.example.com points at 203.0.113.10, not this host',
    )
    assert.deepEqual(
      records().map((record) => record.data),
      ['203.0.113.10'],
    )
  })

  it('U5.2 a record that already holds the address is adopted, not owned, and kept when the host goes', async () => {
    const foreign = records()[0]
    cloud.setRecord('example.com', foreign.id, '127.0.0.1')
    const ready = await reconcile()
    assert.equal(ready.state, 'ready')
    assert.equal(row().dns_record_id, foreign.id)
    assert.equal(row().dns_owned, 0)
    assert.equal(
      (await c.api('DELETE', '/api/v2/cloud/hosts/e2e', { confirm: 'e2e' }))
        .status,
      200,
    )
    assert.deepEqual(
      records().map((record) => record.id),
      [foreign.id],
    )
  })

  it('removing a host deletes the record Mason made', async () => {
    cloud.removeRecord('example.com', records()[0].id)
    assert.equal((await c.api('POST', '/api/v2/cloud/hosts', host)).status, 201)
    await settle('ready')
    assert.equal(records().length, 1)
    await c.api('DELETE', '/api/v2/cloud/hosts/e2e', { confirm: 'e2e' })
    assert.deepEqual(records(), [])
  })

  it('a host with no DNS chosen on the form is made without a record', async () => {
    const plain = await c.api('POST', '/api/v2/cloud/hosts', {
      ...host,
      dns: { domain: '', name: 'ignored' },
    })
    assert.equal(plain.status, 201, plain.text)
    assert.equal(plain.json.dns_domain, null)
    assert.equal(plain.json.certificate, 'internal')
    await c.api('DELETE', '/api/v2/cloud/hosts/e2e', { confirm: 'e2e' })
  })
})
