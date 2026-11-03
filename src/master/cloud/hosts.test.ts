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
import { cloudView, nodesView, type CloudHostView } from '../../view/admin.js'
import { clusterCheck, formatCheck } from '../clusterCheck.js'
import { localOperator } from '../roles.js'
import type { CloudProvider } from './digitalocean.js'
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

  it('M2.13 a host is made only in an account whose key an administrator entered', async () => {
    const master = c.master.master!
    const manager = master.keys.create(localOperator, {
      role: 'manager',
      name: 'accounts manager',
    }).token
    const refusal =
      /An administrator must re-enter the key of account (\S+) before a host is made in it/
    // A manager's own account, however it is named.
    const added = await c.api(
      'POST',
      '/api/v2/cloud/accounts',
      {
        id: 'company-do',
        name: 'Company DO',
        provider: 'digitalocean',
        key: 'dop_v1_' + 'a'.repeat(64),
      },
      manager,
    )
    assert.equal(added.status, 201, added.text)
    assert.equal(added.json.adminKeyed, false)
    const theirs = await c.api('POST', '/api/v2/cloud/hosts', {
      ...host,
      account: 'company-do',
    })
    assert.equal(theirs.status, 409)
    assert.match(theirs.json.error, refusal)
    // A manager re-keys the account before any host is made in it.
    const accounts = (key: unknown): unknown => ({
      accounts: [
        { id: 'do', name: 'DigitalOcean', provider: 'digitalocean', key },
        { id: 'mac', name: 'NoMac', provider: 'nomac', key: { keep: true } },
        {
          id: 'company-do',
          name: 'Company DO',
          provider: 'digitalocean',
          key: { keep: true },
        },
      ],
    })
    assert.equal(
      (
        await c.api(
          'PUT',
          '/api/v2/settings/cloudAccounts',
          accounts('dop_v1_' + 'b'.repeat(64)),
          manager,
        )
      ).status,
      200,
    )
    assert.equal(master.cloudAccounts.get('do')!.adminKeyed, undefined)
    const rekeyed = await c.api('POST', '/api/v2/cloud/hosts', host)
    assert.equal(rekeyed.status, 409)
    assert.match(rekeyed.json.error, /account do before/)
    assert.equal(master.cloudHosts.list().length, 0, 'nothing made')
    // Keeping the key, even an administrator's save does not vouch for it.
    await c.api(
      'PUT',
      '/api/v2/settings/cloudAccounts',
      accounts({ keep: true }),
    )
    assert.equal(master.cloudAccounts.get('do')!.adminKeyed, undefined)
    // An administrator enters the key again.
    assert.equal(
      (await c.api('PUT', '/api/v2/settings/cloudAccounts', accounts(KEY)))
        .status,
      200,
    )
    assert.equal(master.cloudAccounts.get('do')!.adminKeyed, true)
    assert.equal(
      (await c.api('DELETE', '/api/v2/cloud/accounts/company-do')).status,
      200,
    )
    const page = await c.api('GET', '/api/v2/cloud/accounts')
    assert.deepEqual(
      page.json.map((account: { id: string; adminKeyed: boolean }) => [
        account.id,
        account.adminKeyed,
      ]),
      [
        ['do', true],
        ['mac', true],
      ],
    )
  })

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

  it('M2.11 a manager cannot make, reconcile or remove the host, nor re-key the account it was made in', async () => {
    const master = c.master.master!
    const manager = master.keys.create(localOperator, {
      role: 'manager',
      name: 'hosts manager',
    }).token
    const origin = (): unknown =>
      (master.settings.value('host') as { origin?: string } | undefined)?.origin
    const before = origin()
    assert.notEqual(before, undefined)
    for (const [verb, route, body] of [
      ['POST', '/api/v2/cloud/hosts', { ...host, name: 'mine' }],
      ['POST', '/api/v2/cloud/hosts/e2e/reconcile', {}],
      ['DELETE', '/api/v2/cloud/hosts/e2e', { confirm: 'e2e' }],
    ] as const) {
      const reply = await c.api(verb, route, body, manager)
      assert.equal(reply.status, 403, `${verb} ${route}: ${reply.text}`)
    }
    assert.equal(row().state, 'ready')
    assert.equal(master.cloudHosts.get('mine'), undefined)
    assert.equal(origin(), before, 'the host origin is unchanged')
    const accounts = (key: unknown): unknown => ({
      accounts: [
        { id: 'do', name: 'DigitalOcean', provider: 'digitalocean', key },
        {
          id: 'mac',
          name: 'NoMac',
          provider: 'nomac',
          key: { keep: true },
        },
      ],
    })
    const rekey = await c.api(
      'PUT',
      '/api/v2/settings/cloudAccounts',
      accounts('dop_v1_' + 'f'.repeat(64)),
      manager,
    )
    assert.equal(rekey.status, 403)
    assert.match(rekey.json.error, /makes the host; only an administrator/)
    // Keeping its key, a manager may still change the other accounts.
    assert.equal(
      (
        await c.api(
          'PUT',
          '/api/v2/settings/cloudAccounts',
          accounts({ keep: true }),
          manager,
        )
      ).status,
      200,
    )
    assert.equal(
      (await c.api('POST', '/api/v2/cloud/hosts/e2e/reconcile', {})).status,
      200,
      'an administrator may',
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

describe('A host made while its account changes', function () {
  this.timeout(60_000)
  const ADMIN = 'dop_v1_' + 'd'.repeat(64)
  const MANAGER = 'dop_v1_' + 'a'.repeat(64)
  let c: Cluster
  /** The tokens droplets were made with. */
  const made: string[] = []
  let duringLookup = async (): Promise<void> => undefined
  let lookup = async (): Promise<string[]> => {
    await duringLookup()
    return ['example.com']
  }
  before(async () => {
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'hosts-race-'),
    )
    const provider = (token: string): CloudProvider =>
      ({
        // The lookup's own promise, so a test can end it at an exact moment.
        domains: (): Promise<string[]> => lookup(),
        get: async () => undefined,
        list: async () => [],
        create: async (spec: { name: string }) => {
          made.push(token)
          return { id: '1', name: spec.name }
        },
        destroy: async () => undefined,
        firewall: async () => undefined,
      }) as unknown as CloudProvider
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [],
      masterOptions: {
        cloudHosts: {
          provider,
          publicAddress: async () => '203.0.113.7',
          tickMs: 3_600_000,
          settleMs: 3_600_000,
        },
      },
    })
    await c.master.master!.settings.set(localOperator, 'cloudAccounts', {
      accounts: [
        {
          id: 'do',
          name: 'DigitalOcean',
          provider: 'digitalocean',
          key: ADMIN,
        },
      ],
    })
  })
  after(async () => {
    await c?.close()
  })
  const spec = {
    name: 'e2e',
    account: 'do',
    region: 'sfo3',
    size: 's-1vcpu-1gb',
    dns: { domain: 'example.com', name: 'builds' },
  }

  it('M2.16 a key a manager swaps in during the DNS lookup makes no host, and no droplet with their key', async () => {
    const master = c.master.master!
    const manager = master.keys.create(localOperator, {
      role: 'manager',
      name: 'race manager',
    }).token
    let swap: { status: number } | undefined
    duringLookup = async (): Promise<void> => {
      duringLookup = async (): Promise<void> => undefined
      swap = await c.api(
        'PUT',
        '/api/v2/cloud/accounts/do/key',
        { key: MANAGER },
        manager,
      )
    }
    const created = await c.api('POST', '/api/v2/cloud/hosts', spec)
    assert.equal(swap?.status, 200, 'the account held no host yet')
    assert.equal(created.status, 409, created.text)
    assert.match(created.json.error, /re-enter the key of account do/)
    assert.equal(master.cloudHosts.list().length, 0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(made, [])
  })

  it('M2.17 an administrator replaces the key on the Cloud page; a host whose key changed anyway is not reconciled with it', async () => {
    const master = c.master.master!
    const page = cloudView({
      accounts: master.cloudAccounts.list(localOperator),
      canChange: true,
      now: 0,
    })
    assert.match(page, /No administrator entered this key/)
    assert.match(
      page,
      /data-path="\/api\/v2\/cloud\/accounts\/do\/key" data-method="PUT"/,
    )
    const replaced = await c.api('PUT', '/api/v2/cloud/accounts/do/key', {
      key: ` ${ADMIN}\n`,
    })
    assert.equal(replaced.status, 200, replaced.text)
    assert.equal(replaced.json.adminKeyed, true)
    assert.equal(master.cloudAccounts.get('do')!.key, ADMIN)
    assert.match(
      cloudView({
        accounts: master.cloudAccounts.list(localOperator),
        canChange: true,
        now: 0,
      }),
      /entered by an administrator, so a host may be made in it/,
    )
    assert.equal(
      (await c.api('PUT', '/api/v2/cloud/accounts/none/key', { key: ADMIN }))
        .status,
      404,
    )
    const created = await c.api('POST', '/api/v2/cloud/hosts', spec)
    assert.equal(created.status, 201, created.text)
    await c.until(() => made.length === 1, 10_000, 'the droplet')
    assert.deepEqual(made, [ADMIN])
    // As a write racing the guard could leave it: another key, not vouched for.
    const row = master.database.db
      .prepare("SELECT value FROM settings WHERE area='cloudAccounts'")
      .get() as { value: string }
    master.database.db
      .prepare("UPDATE settings SET value=? WHERE area='cloudAccounts'")
      .run(
        JSON.stringify({
          accounts: (
            JSON.parse(row.value) as {
              accounts: Array<Record<string, unknown>>
            }
          ).accounts.map((account) => ({
            id: account.id,
            name: account.name,
            provider: account.provider,
            key: MANAGER,
          })),
        }),
      )
    master.database.db.prepare('UPDATE cloud_hosts SET provider_id=NULL').run()
    const reconciled = await c.api(
      'POST',
      '/api/v2/cloud/hosts/e2e/reconcile',
      {},
    )
    assert.equal(reconciled.json.state, 'error')
    assert.match(reconciled.json.error, /re-enter the key of account do/)
    assert.deepEqual(made, [ADMIN], 'nothing made with the other key')
  })

  it('M2.18 a manager’s key change validated before the host is recorded cannot land after it', async () => {
    const master = c.master.master!
    await master.cloudHosts.remove('e2e', 'e2e')
    await master.settings.set(localOperator, 'cloudAccounts', {
      accounts: [
        {
          id: 'do',
          name: 'DigitalOcean',
          provider: 'digitalocean',
          key: ADMIN,
        },
      ],
    })
    made.length = 0
    let release = (): void => undefined
    const plain = lookup
    lookup = (): Promise<string[]> =>
      new Promise<string[]>((resolve) => {
        release = (): void => resolve(['example.com'])
      })
    const creating = master.cloudHosts.create({ ...spec, name: 'h2' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The lookup ends, and the manager's write is validated before the host is recorded.
    release()
    const swapping = master.settings.set(
      { role: 'manager', label: 'manager' },
      'cloudAccounts',
      {
        accounts: [
          {
            id: 'do',
            name: 'DigitalOcean',
            provider: 'digitalocean',
            key: MANAGER,
          },
        ],
      },
    )
    const [created, swapped] = await Promise.allSettled([creating, swapping])
    lookup = plain
    await new Promise((resolve) => setTimeout(resolve, 200))
    const key = master.cloudAccounts.get('do')!.key
    if (created.status === 'fulfilled') {
      assert.equal(swapped.status, 'rejected', 'the host’s account is kept')
      assert.equal(key, ADMIN)
    } else assert.match(String(created.reason), /re-enter the key/)
    assert(!made.includes(MANAGER), 'nothing made with the manager’s key')
    if (master.cloudHosts.get('h2') != null)
      await master.cloudHosts.remove('h2', 'h2')
  })

  it('M2.19 a manager entering the same key again keeps an administrator’s vouching', async () => {
    const master = c.master.master!
    await master.settings.set(localOperator, 'cloudAccounts', {
      accounts: [
        {
          id: 'do',
          name: 'DigitalOcean',
          provider: 'digitalocean',
          key: ADMIN,
        },
      ],
    })
    assert.equal(
      (await c.api('POST', '/api/v2/cloud/hosts', { ...spec, name: 'h3' }))
        .status,
      201,
    )
    const manager = master.keys.create(localOperator, {
      role: 'manager',
      name: 'same key manager',
    }).token
    const same = await c.api(
      'PUT',
      '/api/v2/cloud/accounts/do/key',
      { key: ADMIN },
      manager,
    )
    assert.equal(same.status, 200, same.text)
    assert.equal(same.json.adminKeyed, true)
    const checked = await c.api('POST', '/api/v2/cloud/hosts/h3/reconcile', {})
    assert.notEqual(checked.json.state, 'error', checked.text)
    assert.equal(
      (
        await c.api(
          'PUT',
          '/api/v2/cloud/accounts/do/key',
          { key: MANAGER },
          manager,
        )
      ).status,
      403,
    )
  })
})
