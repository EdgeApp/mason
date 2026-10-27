import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { createCertificate, certificateHash } from '../../node/certificate.js'
import { loadIdentity } from '../../node/identity.js'
import { startNode } from '../../node/serve.js'
import { cluster, type Cluster } from '../../test/cluster.js'
import { FakeCloud } from '../../test/fakeCloud.js'
import { quietMac } from '../../test/fakeMac.js'
import { ProviderError } from './digitalocean.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'cloud-'))
const admin = { role: 'admin' as const, label: 'paul' }
const TOKEN = 'dop_v1_' + 'f'.repeat(40)
const MINUTE = 60_000

describe('Cloud node pools', function () {
  this.timeout(120_000)
  let c: Cluster
  let cloud: FakeCloud
  let offset = 0
  let address = '203.0.113.7'
  const pool = (
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    name: 'linux-cloud',
    type: 'linux-cloud',
    region: 'nyc3',
    size: 's-1vcpu-1gb',
    image: 'ubuntu-24-04-x64',
    maxNodes: 1,
    slots: 1,
    ttlMinutes: 5,
    ...extra,
  })

  before(async () => {
    const dir = root()
    cloud = new FakeCloud(dir)
    // The master's own worker runs setups; stages on linux-cloud need the pool.
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [],
      coWorker: true,
      masterOptions: {
        now: () => Date.now() + offset,
        cloud: {
          provider: () => cloud,
          publicAddress: async () => address,
          tickMs: 200,
          pairTimeoutMs: 20_000,
          log: (line: string) => {
            if (process.env.MASON_CLOUD_LOG != null) console.error(line)
          },
        },
      },
    })
    const master = c.master.master!
    await master.settings.set(admin, 'host', {
      origin: 'https://builds.example.test',
    })
    // A stored release for machines to install.
    const release = path.join(dir, 'release')
    mkdirSync(release)
    const files: Record<string, string> = {
      'install.sh': '#!/bin/bash\n',
      'mason-0.3.0-linux-x64.tar.gz': 'tarball',
    }
    for (const [name, text] of Object.entries(files))
      writeFileSync(path.join(release, name), text)
    writeFileSync(
      path.join(release, 'SHA256SUMS'),
      Object.entries(files)
        .map(
          ([name, text]) =>
            `${createHash('sha256').update(text).digest('hex')}  ${name}`,
        )
        .join('\n') + '\n',
    )
    await master.releases.add(release)
    master.releases.setCurrent('0.3.0')
    const repo = c.repo('fixtures/cloud')
    repo.commit({
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', {}, () => {})
  m.stage('linux', { on: 'linux-cloud', run: work, workspace: 'reuse' })
}
export async function work(ctx: Stage) {
  const { existsSync, writeFileSync } = await import('node:fs')
  const seen = existsSync('marker')
  writeFileSync('marker', 'x')
  return { node: ctx.node.name, seen }
}
`,
    })
    repo.commit({ 'other.txt': 'x' }, 'other')
    master.saveProject(admin, 'cloud', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
    })
  })
  after(async () => {
    await c?.close()
    await cloud?.close()
  })

  const run = async (branch = 'master'): Promise<string> => {
    const created = await c.api('POST', '/api/v2/runs', {
      project: 'cloud',
      branch,
    })
    assert.equal(created.status, 202, created.text)
    return created.json.id as string
  }
  const finish = async (id: string, ms = 60_000): Promise<Json> =>
    await c.until(
      () => {
        const value = c.master.master!.run(id) as Json
        return ['succeeded', 'failed', 'cancelled'].includes(value.status)
          ? value
          : undefined
      },
      ms,
      `run ${id}`,
    )
  const stage = (value: Json): Json =>
    value.stages.find((entry: Json) => entry.name === 'linux')
  const machines = (): Json[] => c.master.master!.pools.machines()
  /** Waits, and on a timeout shows the machines and runs. */
  const wait = async <T>(
    check: () => T | undefined | false,
    ms: number,
    label: string,
  ): Promise<T> =>
    await c.until(check, ms, label).catch((error: Error) => {
      const runs = (
        c.master.master!.runs({ project: 'cloud', limit: 5 }) as Json[]
      ).map((entry: Json) => {
        const full = c.master.master!.run(entry.id) as Json
        return {
          status: full.status,
          stages: full.stages.map((one: Json) => [
            one.name,
            one.status,
            one.reason,
          ]),
        }
      })
      throw new Error(
        `${error.message}\nmachines ${JSON.stringify(machines())}\nruns ${JSON.stringify(runs)}`,
      )
    })

  it('U11.1 validates pools and keeps the provider token on the master', async () => {
    const settings = c.master.master!.settings
    await assert.rejects(
      settings.set(admin, 'cloud', { pools: [pool()] }),
      /provider token/,
    )
    await assert.rejects(
      settings.set(admin, 'cloud', {
        token: TOKEN,
        pools: [pool({ maxNodes: 0 })],
      }),
      /maxNodes/,
    )
    await assert.rejects(
      settings.set(admin, 'cloud', {
        token: TOKEN,
        pools: [pool({ provider: 'aws' })],
      }),
      /digitalocean/,
    )
    await assert.rejects(
      settings.set(admin, 'cloud', { token: TOKEN, pools: [pool(), pool()] }),
      /twice/,
    )
    await assert.rejects(
      settings.set(admin, 'cloud', { token: 'short', pools: [] }),
      /token/,
    )
    await assert.rejects(
      settings.set(admin, 'cloud', { token: { keep: true }, pools: [] }),
      /No stored token/,
    )
    await settings.set(admin, 'cloud', {
      token: TOKEN,
      monthlyBudget: 200,
      pools: [pool()],
    })
    const shown = settings.get(admin, 'cloud') as Json
    assert.deepEqual(shown.token, { set: true })
    await settings.set(admin, 'cloud', {
      token: { keep: true },
      monthlyBudget: 200,
      pools: [pool()],
    })
    const db = c.master.master!.database.db
    const logged = JSON.stringify(db.prepare('SELECT * FROM change_log').all())
    assert(!logged.includes(TOKEN))
    assert(!JSON.stringify(c.master.master!.changes.snapshot()).includes(TOKEN))
  })

  it('U11.2/U11.3 makes one machine per demand up to maxNodes and pairs it by the master’s certificate and secret', async () => {
    // Two branches, so the runs do not queue behind each other.
    const [first, second] = [await run(), await run('other')]
    await wait(() => machines().length === 1, 10_000, 'a machine').catch(
      (error: Error) => {
        throw new Error(
          `${error.message}\n${JSON.stringify(c.master.master!.run(first))}\n${c.master.master!.scheduler.logs(first) ?? ''}`,
        )
      },
    )
    const spec = cloud.created[0]!
    assert.deepEqual(spec.tags, ['mason-pool', 'mason-pool-linux-cloud'])
    assert.equal(spec.image, 'ubuntu-24-04-x64')
    assert.match(
      spec.userData,
      /curl -fsSL https:\/\/builds\.example\.test\/install\.sh/,
    )
    assert.match(
      spec.userData,
      /mason worker --install --pairing-file \/root\/mason-pairing\.json --link-port 9310 --listen 0\.0\.0\.0 --slots 1/,
    )
    assert.match(spec.userData, /# Mason 0\.3\.0/)
    const pairing = FakeCloud.pairing(spec.userData)
    // Only one machine while the first boots, though two stages want one.
    const waiting = await wait(
      () => {
        const value = c.master.master!.run(second) as Json
        return stage(value)?.reason != null ? stage(value) : undefined
      },
      10_000,
      'the waiting reason',
    )
    assert.match(
      waiting.reason,
      /Waiting for a linux-cloud machine to start|at its 1-machine limit/,
    )
    const done = await finish(first)
    assert.equal(
      done.status,
      'succeeded',
      c.master.master!.scheduler.logs(first),
    )
    const machine = machines()[0]
    assert.equal(machine.state, 'ready')
    const stored = c.master
      .master!.database.db.prepare(
        'SELECT certificate_hash FROM nodes WHERE fingerprint=?',
      )
      .get(machine.fingerprint) as Json
    assert.equal(stored.certificate_hash, certificateHash(pairing.cert))
    // The recorded fingerprint is the machine's own new key, and the pairing file is gone.
    const fake = [...cloud.machines.values()][0]!
    assert.equal(fake.node!.identity.fingerprint, machine.fingerprint)
    assert(!existsSync(path.join(fake.dir, 'data', 'pairing-file.json')))
    const later = await finish(second)
    assert.equal(later.status, 'succeeded')
    assert.equal(cloud.created.length, 1, 'still one machine')
    // The same machine took both stages and kept its workspace.
    assert.equal(stage(later).output.node, stage(done).output.node)
    assert.equal(stage(later).output.seen, true)
  })

  it('U11.3 refuses an endpoint with another certificate, a missing secret and a reused one', async () => {
    const registry = c.master.master!.registry
    const dir = root()
    const other = await startNode(
      {
        role: 'worker',
        data: path.join(dir, 'other'),
        linkPort: 0,
        listen: '127.0.0.1',
        heartbeatMs: 0,
        workerOptions: { systemRun: quietMac() },
      },
      () => undefined,
    )
    try {
      const made = createCertificate(['x'])
      await assert.rejects(
        registry.addMachine(
          `127.0.0.1:${other.link!.port}`,
          certificateHash(made.cert),
          's'.repeat(43),
        ),
      )
      // Its own certificate but no pairing file: no secret to prove.
      await assert.rejects(
        registry.addMachine(
          `127.0.0.1:${other.link!.port}`,
          other.identity.certificateHash,
          's'.repeat(43),
        ),
      )
      assert.equal(registry.get(other.identity.fingerprint), undefined)
    } finally {
      await other.close()
    }
    // A paired machine's secret is spent.
    const machine = machines()[0]
    const spec = cloud.created[0]!
    const fake = [...cloud.machines.values()][0]!
    await assert.rejects(
      registry.addMachine(
        `127.0.0.1:${fake.port!}`,
        certificateHash(FakeCloud.pairing(spec.userData).cert),
        FakeCloud.pairing(spec.userData).secret,
      ),
    )
    assert.equal(machines()[0].fingerprint, machine.fingerprint)
    // Even a valid pairing of a node the master knows is not a new machine.
    const known = loadIdentity(path.join(fake.dir, 'data'))
    assert.equal(known.fingerprint, machine.fingerprint)
  })

  it('U11.4 retires an idle machine: scrubbed, powered off, snapshotted, destroyed; the firewall follows the master', async () => {
    await wait(() => cloud.firewalls.length > 0, 5_000, 'the firewall')
    assert.deepEqual(cloud.firewalls.at(-1), {
      name: 'mason-pools',
      port: 9310,
      sources: ['203.0.113.7'],
      tag: 'mason-pool',
    })
    address = '198.51.100.9'
    await wait(
      () => cloud.firewalls.at(-1)?.sources[0] === '198.51.100.9',
      5_000,
      'the firewall update',
    )
    const [machine] = machines()
    const fake = [...cloud.machines.values()][0]!
    offset += 6 * MINUTE
    await wait(() => machines().length === 0, 15_000, 'the retirement')
    for (const name of [
      'identity.key',
      'tls.crt',
      'pairing.json',
      'master.json',
      'checkouts',
    ])
      assert(!existsSync(path.join(fake.dir, 'data', name)), `${name} remains`)
    assert.equal(c.master.master!.registry.get(machine.fingerprint), undefined)
    assert.deepEqual(cloud.deleted, [fake.id])
    const snapshots = c.master.master!.pools.view().snapshots as Json[]
    assert.equal(snapshots.length, 1)
    assert(cloud.snapshotList.has(snapshots[0].provider_id))
  })

  it('U11.8 starts the next machine from the snapshot with a fresh identity, and a failed snapshot keeps the previous one', async () => {
    const before = (c.master.master!.pools.view().snapshots as Json[])[0]
    const id = await run()
    await wait(
      () => machines()[0]?.state === 'ready',
      20_000,
      'a machine from the snapshot',
    )
    assert.equal(cloud.created.at(-1)!.image, before.provider_id)
    const first = machines()[0].fingerprint
    assert.equal((await finish(id)).status, 'succeeded')
    // Retiring it replaces the snapshot.
    offset += 6 * MINUTE
    await wait(() => machines().length === 0, 15_000, 'the second retirement')
    const replaced = (c.master.master!.pools.view().snapshots as Json[])[0]
    assert.notEqual(replaced.provider_id, before.provider_id)
    assert(!cloud.snapshotList.has(before.provider_id))
    // From that snapshot again: a different key, though the image is the same.
    const again = await run()
    await wait(
      () => machines()[0]?.state === 'ready',
      20_000,
      'another machine',
    )
    assert.notEqual(machines()[0].fingerprint, first)
    assert.equal((await finish(again)).status, 'succeeded')
    cloud.failSnapshot = true
    offset += 6 * MINUTE
    await wait(
      () => machines().length === 0,
      15_000,
      'a retirement whose snapshot fails',
    )
    cloud.failSnapshot = false
    assert.equal(
      (c.master.master!.pools.view().snapshots as Json[])[0].provider_id,
      replaced.provider_id,
    )
    // The snapshot vanished at the provider: the record is dropped and the base image used.
    cloud.snapshotList.delete(replaced.provider_id)
    const fallback = await run()
    await wait(
      () => machines()[0]?.state === 'ready',
      20_000,
      'a machine from the base image',
    ).catch((error: Error) => {
      throw new Error(
        `${error.message}\n${JSON.stringify(c.master.master!.run(fallback))}\n${JSON.stringify(machines())}`,
      )
    })
    assert.equal(cloud.created.at(-1)!.image, 'ubuntu-24-04-x64')
    assert.equal((c.master.master!.pools.view().snapshots as Json[]).length, 0)
    assert.equal((await finish(fallback)).status, 'succeeded')
    // Records survive a master restart.
    const kept = machines()[0]
    await c.restartMaster()
    assert.equal(
      c.master.master!.pools.machines()[0]!.fingerprint,
      kept.fingerprint,
    )
    offset += 6 * MINUTE
    await wait(
      () => c.master.master!.pools.machines().length === 0,
      15_000,
      'retired after restart',
    )
  })

  it('U11.8 drops a snapshot that never pairs and builds from the base image', async () => {
    const snapshot = (c.master.master!.pools.view().snapshots as Json[])[0]
    cloud.broken.add(snapshot.provider_id)
    const id = await run()
    await wait(
      () => cloud.created.at(-1)!.image === snapshot.provider_id,
      10_000,
      'a machine from the broken snapshot',
    )
    offset += 21_000
    await wait(
      () =>
        cloud.created.at(-1)!.image === 'ubuntu-24-04-x64' &&
        machines()[0]?.state === 'ready',
      30_000,
      'the base image',
    )
    assert(!cloud.snapshotList.has(snapshot.provider_id))
    assert.equal((await finish(id)).status, 'succeeded')
    offset += 6 * MINUTE
    await wait(() => machines().length === 0, 15_000, 'retired')
  })

  it('U11.5 deletes tagged machines and snapshots the master has no record of, keeping its own', async () => {
    const stray = await cloud
      .create({
        name: 'stray',
        region: 'nyc3',
        size: 's',
        image: 'x',
        tags: ['mason-pool'],
        userData: "<<'MASON_PAIRING'\n{}\nMASON_PAIRING",
      })
      .catch(() => undefined)
    void stray
    const other = await cloud
      .create({
        name: 'mine',
        region: 'nyc3',
        size: 's',
        image: 'x',
        tags: ['other'],
        userData: '',
      })
      .catch(() => undefined)
    cloud.snapshotList.set('snap-stray', {
      id: 'snap-stray',
      name: 'mason-pool-old',
      sizeGb: 10,
      createdAt: 0,
      from: 'x',
    })
    cloud.snapshotList.set('snap-user', {
      id: 'snap-user',
      name: 'my-backup',
      sizeGb: 10,
      createdAt: 0,
      from: 'x',
    })
    const own = (c.master.master!.pools.view().snapshots as Json[])[0]
    const result = await c.master.master!.pools.reconcile()
    assert.deepEqual(result, { machines: 1, snapshots: 1 })
    assert(!cloud.snapshotList.has('snap-stray'))
    assert(cloud.snapshotList.has('snap-user'))
    assert(cloud.snapshotList.has(own.provider_id))
    assert(other == null || cloud.machines.has(other.id))
  })

  it('U11.6 a provider failure fails only the placement, with the reason, and retries later', async () => {
    cloud.failCreate = 'quota'
    const id = await run()
    const waiting = await wait(
      () => {
        const value = c.master.master!.run(id) as Json
        return /quota/.test(stage(value)?.reason ?? '')
          ? stage(value)
          : undefined
      },
      10_000,
      'the quota reason',
    )
    assert.equal(waiting.status, 'queued')
    cloud.failCreate = undefined
    offset += 61_000
    assert.equal((await finish(id)).status, 'succeeded')
    offset += 6 * MINUTE
    await wait(() => machines().length === 0, 15_000, 'retired')
    assert(new ProviderError('x', 'rate').kind === 'rate')
  })

  it('U11.6 starts no machine while the current release has no linux-x64 tarball', async () => {
    const releases = c.master.master!.releases
    // The copy beside a master's own install: one platform.
    const partial = path.join(root(), 'partial')
    mkdirSync(partial)
    const files: Record<string, string> = {
      'install.sh': '#!/bin/bash\n',
      'mason-0.3.1-darwin-arm64.tar.gz': 'tarball',
    }
    for (const [name, text] of Object.entries(files))
      writeFileSync(path.join(partial, name), text)
    writeFileSync(
      path.join(partial, 'SHA256SUMS'),
      Object.entries(files)
        .map(
          ([name, text]) =>
            `${createHash('sha256').update(text).digest('hex')}  ${name}`,
        )
        .join('\n') + '\n',
    )
    await releases.add(partial)
    releases.setCurrent('0.3.1')
    const created = cloud.created.length
    const id = await run()
    const waiting = await wait(
      () => {
        const value = c.master.master!.run(id) as Json
        return /no linux-x64 tarball/.test(stage(value)?.reason ?? '')
          ? stage(value)
          : undefined
      },
      10_000,
      'the missing platform reason',
    )
    assert.equal(waiting.status, 'queued')
    assert.match(waiting.reason, /mason releases fetch v0\.3\.1/)
    assert.equal(cloud.created.length, created)
    // The whole release current again: the stage gets its machine.
    releases.setCurrent('0.3.0')
    assert.equal((await finish(id)).status, 'succeeded')
    assert.equal(cloud.created.length, created + 1)
    offset += 6 * MINUTE
    await wait(() => machines().length === 0, 15_000, 'retired')
  })

  it('U11.7 counts machine time and snapshot storage per month, warns at 80% and stops at the cap', async () => {
    const pools = c.master.master!.pools
    const db = c.master.master!.database.db
    const now = Date.now() + offset
    const start = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      1,
    )
    db.prepare(
      "INSERT INTO cloud_machines(pool,state,size,created_at,destroyed_at) VALUES('linux-cloud','destroyed','s',?,?)",
    ).run(start - 3_600_000, start + 10 * 3_600_000)
    const spend = await pools.spend(now)
    assert(spend >= 0.1, String(spend))
    await c.master.master!.settings.set(admin, 'cloud', {
      token: { keep: true },
      monthlyBudget: spend / 0.85,
      pools: [pool()],
    })
    offset += 1000
    await wait(
      () => /Cloud spend this month/.test(c.master.master!.notices().join(' ')),
      5_000,
      'the warning',
    )
    await c.master.master!.settings.set(admin, 'cloud', {
      token: { keep: true },
      monthlyBudget: 0.05,
      pools: [pool()],
    })
    const id = await run()
    const waiting = await wait(
      () => {
        const value = c.master.master!.run(id) as Json
        return /budget of \$0\.05 is spent/.test(stage(value)?.reason ?? '')
          ? stage(value)
          : undefined
      },
      10_000,
      'the budget reason',
    )
    assert.equal(waiting.status, 'queued')
    assert.match(
      c.master.master!.notices().join(' '),
      /budget of \$0\.05 is spent/,
    )
    // Raising the cap resumes creation for the waiting stage.
    await c.master.master!.settings.set(admin, 'cloud', {
      token: { keep: true },
      monthlyBudget: 200,
      pools: [pool()],
    })
    offset += 1000
    assert.equal((await finish(id)).status, 'succeeded')
    // A new month starts from nothing spent.
    const next =
      Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth() + 1,
        1,
      ) + 3_600_000
    assert(spend > 0.05)
    assert((await pools.spend(next)) < 0.05)
  })
})
