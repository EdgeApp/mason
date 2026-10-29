import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { nodeMain, type MainIO } from '../../node/main.js'
import { cluster, type Cluster } from '../../test/cluster.js'
import { FakeCloud } from '../../test/fakeCloud.js'
import { nodesView, type CloudHostView } from '../../view/admin.js'
import { clusterCheck, formatCheck } from '../clusterCheck.js'
import { localOperator } from '../roles.js'
import type { CloudHostRow } from './hosts.js'

// API replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const KEY = 'dop_v1_' + 'd'.repeat(64)
/** A master's short id, as it names its cloud resources. */
const idOf = (fingerprint: string): string =>
  createHash('sha256').update(fingerprint).digest('hex').slice(0, 10)
const host = {
  name: 'e2e',
  account: 'do',
  region: 'sfo3',
  size: 's-1vcpu-1gb',
}

describe('Mason hosts on DigitalOcean', function () {
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
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'hosts-'),
    )
    cloud = new FakeCloud(dir)
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [],
      masterOptions: {
        cloudHosts: {
          provider: () => cloud,
          publicAddress: async () => '203.0.113.7',
          // Reconciled by hand here, besides a host settling on its own.
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
          key: 'nmk_' + 'e'.repeat(40),
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
  /** Reconciles until the host reaches a state, as the master's timer would. */
  const until = async (state: string): Promise<Json> => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const reply = await reconcile()
      if (reply.state === state) return reply
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for host e2e ${state}: ${JSON.stringify(reply)}`,
        )
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  it('U4.8 a provider failure leaves the host in error with the reason, and the next reconcile tries again', async () => {
    assert.equal(
      (await c.api('POST', '/api/v2/cloud/hosts', { ...host, account: 'mac' }))
        .json.error,
      'Account mac is not a DigitalOcean account',
    )
    assert.equal(
      (await c.api('POST', '/api/v2/cloud/hosts', { ...host, account: 'none' }))
        .json.error,
      'No cloud account named none',
    )
    cloud.failCreate = 'quota'
    const created = await c.api('POST', '/api/v2/cloud/hosts', host)
    assert.equal(created.status, 201, created.text)
    assert.equal(created.json.state, 'creating')
    assert.equal(created.json.pairing_secret, undefined)
    const failed = await c.until(
      () => (row().state === 'error' ? row() : undefined),
      10_000,
      'the error',
    )
    assert.equal(failed.error, 'Fake quota')
    // A master has one host.
    assert.match(
      (await c.api('POST', '/api/v2/cloud/hosts', { ...host, name: 'second' }))
        .json.error,
      /already has a host: e2e/,
    )
    cloud.failCreate = undefined
  })

  it('U4.1/U4.6 reconcile makes the droplet, opens its firewall, pairs the host and points the host setting at it', async () => {
    // One reconcile; the host then settles by itself while it is being made.
    await reconcile()
    await c.until(
      () => (row().state === 'ready' ? true : undefined),
      30_000,
      'the host settling by itself',
    )
    const ready = await until('ready')
    assert.equal(cloud.created.length, 1)
    const spec = cloud.created[0]!
    assert.equal(spec.name, 'mason-host-e2e')
    const tag = `mason-host-${idOf(c.master.identity.fingerprint)}-e2e`
    assert.deepEqual(spec.tags, ['mason-host', tag])
    assert.match(
      spec.userData,
      /bash "\$root\/root\/mason-install.sh" --version /,
    )
    assert.match(spec.userData, /mason host --install --pairing-file/)
    assert.deepEqual(
      cloud.firewalls
        .filter((rule) => rule.name === tag)
        .map((rule) => [rule.port, rule.sources]),
      [
        [80, ['0.0.0.0/0', '::/0']],
        [443, ['0.0.0.0/0', '::/0']],
        [9310, ['203.0.113.7']],
      ],
    )
    const node = c.master.master!.registry.get(ready.fingerprint)!
    assert.equal(node.role, 'host')
    assert.equal(ready.pairing, false, 'the pairing secret is spent')
    assert.equal(row().pairing_secret, null)
    assert.equal(ready.origin, 'https://127.0.0.1')
    assert.equal(
      (c.master.master!.settings.value('host') as { origin: string }).origin,
      'https://127.0.0.1',
    )
    // An origin an administrator chose is kept.
    await c.master.master!.settings.set(localOperator, 'host', {
      origin: 'https://builds.example.com',
    })
    await reconcile()
    assert.equal(
      (c.master.master!.settings.value('host') as { origin: string }).origin,
      'https://builds.example.com',
    )
    await c.master.master!.settings.set(localOperator, 'host', {
      origin: 'https://127.0.0.1',
    })
    // An account a host uses cannot be removed.
    assert.match(
      (await c.api('DELETE', '/api/v2/cloud/accounts/do')).json.error,
      /used by host e2e/,
    )
    const listed = await c.api('GET', '/api/v2/cloud/hosts')
    assert.deepEqual(
      listed.json.map((entry: Json) => [entry.name, entry.state]),
      [['e2e', 'ready']],
    )
  })

  it('U4.2 adopts the droplet by its recorded id, then by its tag, and refuses two tagged droplets', async () => {
    await reconcile()
    assert.equal(cloud.created.length, 1, 'no create for a recorded droplet')
    const db = c.master.master!.database.db
    db.prepare("UPDATE cloud_hosts SET provider_id=NULL WHERE name='e2e'").run()
    assert.equal((await reconcile()).state, 'ready')
    assert.equal(cloud.created.length, 1, 'no create for a tagged droplet')
    assert.equal(row().provider_id, '1')
    // Another master's host of the same name in the account is never adopted.
    await cloud.create({
      ...cloud.created[0]!,
      name: 'theirs',
      tags: ['mason-host', 'mason-host-0123456789-e2e'],
    })
    db.prepare("UPDATE cloud_hosts SET provider_id=NULL WHERE name='e2e'").run()
    assert.equal((await reconcile()).state, 'ready')
    assert.equal(row().provider_id, '1')
    // A second droplet with the host's tag.
    const extra = await cloud.create({ ...cloud.created[0]!, name: 'stray' })
    db.prepare("UPDATE cloud_hosts SET provider_id=NULL WHERE name='e2e'").run()
    const refused = await reconcile()
    assert.equal(refused.state, 'error')
    assert.equal(
      refused.error,
      `2 droplets are tagged mason-host-${idOf(c.master.identity.fingerprint)}-e2e; remove the extra ones by hand`,
    )
    assert.equal(cloud.created.length, 3)
    await cloud.destroy(extra.id)
    assert.equal((await reconcile()).state, 'ready')
  })

  it('mason cloud hosts lists and reconciles', async () => {
    const listed = io()
    assert.equal(
      await nodeMain(
        ['cloud', 'hosts', 'list', '--data', c.master.dir],
        listed,
      ),
      0,
    )
    assert.match(
      listed.lines[0]!,
      /^e2e {2}ready {2}sfo3 s-1vcpu-1gb {2}127\.0\.0\.1$/,
    )
    const json = io()
    await nodeMain(
      ['cloud', 'hosts', 'list', '--json', '--data', c.master.dir],
      json,
    )
    assert.equal((JSON.parse(json.lines[0]!) as Json[])[0].name, 'e2e')
    const again = io()
    assert.equal(
      await nodeMain(
        ['cloud', 'hosts', 'reconcile', 'e2e', '--data', c.master.dir],
        again,
      ),
      0,
    )
    const bad = io()
    assert.equal(
      await nodeMain(['cloud', 'hosts', 'frob', '--data', c.master.dir], bad),
      1,
    )
    const add = io()
    const file = path.join(c.root, 'host.json')
    writeFileSync(file, JSON.stringify({ ...host, name: 'other' }))
    assert.equal(
      await nodeMain(
        ['cloud', 'hosts', 'add', '--file', file, '--data', c.master.dir],
        add,
      ),
      1,
    )
    assert.match(add.lines.join('\n'), /already has a host: e2e/)
  })

  /** The master's release and update timeout, as `mason update` would change them. */
  const follows = (): { version?: string; updateTimeoutMs?: number } =>
    (
      c.master.master!.cloudHosts as unknown as {
        options: { version?: string; updateTimeoutMs?: number }
      }
    ).options
  const panel = (): string =>
    nodesView({
      nodes: [],
      types: {},
      pools: [],
      budget: { monthly: 0 },
      canChange: true,
      cloudHosts: [
        {
          ...row(),
          labels: [],
          dnsName: undefined,
          certificate: undefined,
          space: undefined,
        } as CloudHostView,
      ],
    })

  it('U2.2 a host that cannot update itself stays ready and says why', async () => {
    const running = row().version
    follows().version = '99.0.0'
    try {
      const refused = await reconcile()
      assert.equal(refused.state, 'ready')
      assert.equal(refused.version, running)
      assert.match(
        refused.error,
        /^It cannot update itself to 99\.0\.0: .*updates only by hand.*sudo mason update/,
      )
      const report = await clusterCheck(c.master.master!)
      assert(report.nodes[0]!.problems.includes(refused.error))
      assert.match(formatCheck(report), /Something needs a person/)
      assert.match(panel(), /updates only by hand/)
    } finally {
      follows().version = undefined
    }
    // On the master's release again, the reason goes.
    const back = await reconcile()
    assert.equal(back.state, 'ready')
    assert.equal(back.error, null)
  })

  it('U2.1/U2.3 a host on another release is asked over its link, shows updating, and is ready when it links again on the release', async () => {
    cloud.updater = true
    const fingerprint = row().fingerprint!
    const request = path.join(
      cloud.machines.get(row().provider_id!)!.dir,
      'data',
      'update-request.json',
    )
    const running = row().version!
    follows().version = '99.0.0'
    const updating = await reconcile()
    assert.equal(updating.state, 'updating')
    assert.equal(updating.version, '99.0.0')
    assert.equal(updating.error, null)
    assert.equal(
      (JSON.parse(readFileSync(request, 'utf8')) as Json).version,
      '99.0.0',
    )
    assert.equal(statSync(request).mode & 0o777, 0o600)
    // Asked once: another reconcile while it updates leaves it be.
    rmSync(request)
    assert.equal((await reconcile()).state, 'updating')
    assert(!existsSync(request))
    const report = await clusterCheck(c.master.master!)
    assert.equal(report.nodes[0]!.updating, '99.0.0')
    assert.deepEqual(report.nodes[0]!.problems, [])
    assert(!report.green)
    assert.match(
      formatCheck(report),
      /… host {3}\S+ .*updating to 99\.0\.0[\s\S]*Updating \S+ to the master’s release; check again in a few minutes\.$/,
    )
    assert.match(panel(), /data-state="updating"/)
    assert.match(panel(), /Updating to Mason 99\.0\.0, as the master asked/)
    // The updater restarts the host into the release; the master's dialer links it again.
    follows().version = running
    c.master.master!.registry.link(fingerprint)!.close()
    await c.until(
      () => (row().state === 'ready' ? row() : undefined),
      30_000,
      'the host linking again on the release',
    )
    assert.equal(row().version, running)
    assert.equal(row().error, null)
    // Its cache may still be catching up; it is no longer updating or behind.
    const after = (await clusterCheck(c.master.master!)).nodes[0]!
    assert.equal(after.updating, undefined)
    assert.deepEqual(
      after.problems.filter((problem) => !/changes behind/.test(problem)),
      [],
    )
  })

  it('U2.2 a host that does not come back on the release in time is in error, and not asked again', async () => {
    follows().version = '98.0.0'
    follows().updateTimeoutMs = 200
    try {
      assert.equal((await reconcile()).state, 'updating')
      const late = await c.until(
        () => (row().state === 'error' ? row() : undefined),
        10_000,
        'the update timeout',
      )
      assert.equal(late.error, 'It did not come back on 98.0.0')
      const request = path.join(
        cloud.machines.get(row().provider_id!)!.dir,
        'data',
        'update-request.json',
      )
      rmSync(request)
      const still = await reconcile()
      assert.equal(still.state, 'error')
      assert(!existsSync(request), 'not asked again')
    } finally {
      follows().version = undefined
      follows().updateTimeoutMs = undefined
      cloud.updater = false
    }
    assert.equal((await reconcile()).state, 'ready')
    assert.equal(row().error, null)
  })

  it('U4.3 an adopted droplet whose host does not answer is in error, never remade', async () => {
    await cloud.powerOff(row().provider_id!)
    await c.until(
      () => c.master.master!.registry.link(row().fingerprint!) == null,
      10_000,
      'the host link closed',
    )
    const stuck = await reconcile()
    assert.equal(stuck.state, 'error')
    assert.equal(stuck.error, 'The host is not answering on its link')
    assert.equal(cloud.created.length, 3)
    const failed = io()
    assert.equal(
      await nodeMain(
        ['cloud', 'hosts', 'reconcile', 'e2e', '--data', c.master.dir],
        failed,
      ),
      1,
    )
  })

  it('U3.1b with a cloud node beside it, the host is still the one host, and lists and API show only hosts', async () => {
    const side = await c.api('POST', '/api/v2/cloud/nodes', {
      name: 'side-node',
      account: 'do',
      region: 'sfo3',
      size: 's-1vcpu-1gb',
      type: 'linux-x86',
    })
    assert.equal(side.status, 201, side.text)
    assert.match(
      (await c.api('POST', '/api/v2/cloud/hosts', { ...host, name: 'other' }))
        .json.error,
      /already has a host: e2e/,
    )
    assert.match(
      (
        await c.api('POST', '/api/v2/cloud/nodes', {
          name: 'e2e',
          account: 'do',
          region: 'sfo3',
          size: 's-1vcpu-1gb',
          type: 'linux-x86',
        })
      ).json.error,
      /already has a host named e2e/,
    )
    assert.deepEqual(
      (await c.api('GET', '/api/v2/cloud/hosts')).json.map(
        (entry: Json) => entry.name,
      ),
      ['e2e'],
    )
    const listed = io()
    await nodeMain(['cloud', 'hosts', 'list', '--data', c.master.dir], listed)
    assert.deepEqual(
      listed.lines.map((line) => line.split(' ')[0]),
      ['e2e'],
    )
    assert.deepEqual(c.master.master!.cloudHosts.usedBy('do'), [
      'host e2e',
      'node side-node',
    ])
    assert.match(
      (await c.api('DELETE', '/api/v2/cloud/accounts/do')).json.error,
      /used by host e2e, node side-node/,
    )
    assert.equal(
      (
        await c.api('DELETE', '/api/v2/cloud/nodes/side-node', {
          confirm: 'side-node',
        })
      ).status,
      200,
    )
  })

  it('U4.7 remove needs the typed name, then destroys the droplet and firewall, unpairs and clears the host setting', async () => {
    const before = row()
    const refused = await c.api('DELETE', '/api/v2/cloud/hosts/e2e', {
      confirm: 'nope',
    })
    assert.equal(refused.status, 400)
    assert.match(refused.json.error, /Type the host's name, e2e, to remove it/)
    assert.equal(
      (await c.api('DELETE', '/api/v2/cloud/hosts/none', { confirm: 'none' }))
        .status,
      404,
    )
    const removed = await c.api('DELETE', '/api/v2/cloud/hosts/e2e', {
      confirm: 'e2e',
    })
    assert.equal(removed.status, 200, removed.text)
    assert(cloud.deleted.includes(before.provider_id!))
    assert(
      cloud.deletedFirewalls.includes(
        `mason-host-${idOf(c.master.identity.fingerprint)}-e2e`,
      ),
    )
    assert.equal(c.master.master!.registry.get(before.fingerprint!), undefined)
    assert.equal(c.master.master!.settings.value('host'), undefined)
    assert.equal(c.master.master!.cloudHosts.get('e2e'), undefined)
    assert.deepEqual((await c.api('GET', '/api/v2/cloud/hosts')).json, [])
    assert.equal(
      (await c.api('POST', '/api/v2/cloud/hosts/e2e/reconcile', {})).status,
      404,
    )
    // The name can be used again, and the CLI removes by name.
    cloud.failCreate = 'quota'
    assert.equal((await c.api('POST', '/api/v2/cloud/hosts', host)).status, 201)
    await c.until(
      () => (row().state === 'error' ? row() : undefined),
      10_000,
      'the error',
    )
    cloud.failCreate = undefined
    const cli = io()
    assert.equal(
      await nodeMain(
        ['cloud', 'hosts', 'remove', 'e2e', '--data', c.master.dir],
        cli,
      ),
      0,
    )
    assert.deepEqual(cli.lines, ['Removed host e2e'])
  })
})
