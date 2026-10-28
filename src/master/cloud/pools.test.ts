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
import { pinnedFetch } from '../../node/pinnedFetch.js'
import { MASTER_SESSION_COOKIE } from '../auth.js'
import { poolInput } from '../cloudApi.js'
import { version } from '../../version.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'cloud-'))
const admin = { role: 'admin' as const, label: 'paul' }
const TOKEN = 'dop_v1_' + 'f'.repeat(40)
const MINUTE = 60_000
/** A master's short id, as it names its cloud resources. */
const idOf = (fingerprint: string): string =>
  createHash('sha256').update(fingerprint).digest('hex').slice(0, 10)

describe('Cloud node pools', function () {
  this.timeout(120_000)
  let c: Cluster
  let cloud: FakeCloud
  let offset = 0
  let address = '203.0.113.7'
  let assets: () => Promise<string[]> = async () => []
  const pool = (
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    name: 'linux-cloud',
    type: 'linux-cloud',
    account: 'do',
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
          releaseAssets: async () => await assets(),
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

  it('U11.1/U3.1 validates pools against cloud accounts and keeps the provider key on the master', async () => {
    const settings = c.master.master!.settings
    await assert.rejects(
      settings.set(admin, 'cloud', { pools: [pool()] }),
      /no cloud account named do/,
    )
    await settings.set(admin, 'cloudAccounts', {
      accounts: [
        {
          id: 'do',
          name: 'DigitalOcean',
          provider: 'digitalocean',
          key: TOKEN,
        },
        {
          id: 'mac',
          name: 'NoMac',
          provider: 'nomac',
          key: 'nmk_' + 'a'.repeat(40),
        },
      ],
    })
    await assert.rejects(
      settings.set(admin, 'cloud', { pools: [pool({ account: undefined })] }),
      /pool.account names a cloud account/,
    )
    await assert.rejects(
      settings.set(admin, 'cloud', { pools: [pool({ account: 'mac' })] }),
      /not a DigitalOcean account/,
    )
    await assert.rejects(
      settings.set(admin, 'cloud', { pools: [pool({ maxNodes: 0 })] }),
      /maxNodes/,
    )
    await assert.rejects(
      settings.set(admin, 'cloud', { pools: [pool({ provider: 'aws' })] }),
      /digitalocean/,
    )
    await assert.rejects(
      settings.set(admin, 'cloud', { pools: [pool(), pool()] }),
      /twice/,
    )
    await assert.rejects(
      settings.set(admin, 'cloud', { token: TOKEN, pools: [] }),
      /cloud accounts now/,
    )
    await settings.set(admin, 'cloud', { monthlyBudget: 200, pools: [pool()] })
    const shown = settings.get(admin, 'cloud') as Json
    assert.equal(shown.token, undefined)
    assert.equal(shown.pools[0].account, 'do')
    // The account a pool uses cannot be removed.
    await assert.rejects(
      settings.set(admin, 'cloudAccounts', {
        accounts: [
          { id: 'mac', name: 'NoMac', provider: 'nomac', key: { keep: true } },
        ],
      }),
      /Account do is used by pool linux-cloud/,
    )
    const db = c.master.master!.database.db
    const logged = JSON.stringify(db.prepare('SELECT * FROM change_log').all())
    assert(!logged.includes(TOKEN))
    assert(!JSON.stringify(c.master.master!.changes.snapshot()).includes(TOKEN))
    assert(
      !JSON.stringify(settings.get(admin, 'cloudAccounts')).includes(TOKEN),
    )
  })

  it('U11.2/U11.3 makes one machine per demand up to maxNodes and pairs it by the master’s certificate and secret', async () => {
    // Two branches, so the runs do not queue behind each other; a slow boot
    // keeps the first machine pairing while the second stage asks for one.
    cloud.bootDelayMs = 3000
    const [first, second] = [await run(), await run('other')]
    await wait(() => machines().length === 1, 10_000, 'a machine').catch(
      (error: Error) => {
        throw new Error(
          `${error.message}\n${JSON.stringify(c.master.master!.run(first))}\n${c.master.master!.scheduler.logs(first) ?? ''}`,
        )
      },
    )
    const spec = cloud.created[0]!
    const id = idOf(c.master.identity.fingerprint)
    assert.deepEqual(spec.tags, [
      'mason-pool',
      `mason-pool-${id}`,
      `mason-pool-${id}-linux-cloud`,
    ])
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
    cloud.bootDelayMs = 0
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
    const id = idOf(c.master.identity.fingerprint)
    assert.deepEqual(cloud.firewalls.at(-1), {
      name: `mason-pools-${id}`,
      port: 9310,
      sources: ['203.0.113.7'],
      tag: `mason-pool-${id}`,
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

  it('U11.5 deletes its own tagged machines and snapshots it has no record of, keeping its own and other masters’', async () => {
    const id = idOf(c.master.identity.fingerprint)
    const stray = await cloud
      .create({
        name: 'stray',
        region: 'nyc3',
        size: 's',
        image: 'x',
        tags: ['mason-pool', `mason-pool-${id}`],
        userData: "<<'MASON_PAIRING'\n{}\nMASON_PAIRING",
      })
      .catch(() => undefined)
    void stray
    // Another master's pool machine in the same account.
    const theirs = await cloud
      .create({
        name: 'theirs',
        region: 'nyc3',
        size: 's',
        image: 'x',
        tags: ['mason-pool', 'mason-pool-0123456789'],
        userData: "<<'MASON_PAIRING'\n{}\nMASON_PAIRING",
      })
      .catch(() => undefined)
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
      name: `mason-pool-${id}-old`,
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
    // Another master's snapshot, and one from before snapshots named their master.
    for (const [key, name] of [
      ['snap-theirs', 'mason-pool-0123456789-android-2026'],
      ['snap-legacy', 'mason-pool-android-2026'],
    ] as const)
      cloud.snapshotList.set(key, {
        id: key,
        name,
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
    assert(theirs == null || cloud.machines.has(theirs.id))
    assert(cloud.snapshotList.has('snap-theirs'))
    assert(cloud.snapshotList.has('snap-legacy'))
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

  it('U3.2/U3.3 with no host, machines install the master’s release from GitHub once its assets list a linux-x64 tarball', async () => {
    const master = c.master.master!
    // Earlier machines retire first, so the stage needs a new one.
    offset += 6 * MINUTE
    await wait(
      () => machines().length === 0,
      15_000,
      'earlier machines retired',
    )
    const db = master.database.db
    const host = db
      .prepare("SELECT value FROM settings WHERE area='host'")
      .get() as { value: string }
    db.prepare("DELETE FROM settings WHERE area='host'").run()
    try {
      let asked = 0
      assets = async (): Promise<string[]> => {
        asked++
        throw new Error('GitHub answered 503')
      }
      const id = await run()
      const reason = async (pattern: RegExp, label: string): Promise<Json> =>
        await wait(
          () => {
            const value = master.run(id) as Json
            return pattern.test(stage(value)?.reason ?? '')
              ? stage(value)
              : undefined
          },
          10_000,
          label,
        )
      await reason(
        /Cannot read release v.* on GitHub: GitHub answered 503/,
        'the GitHub failure',
      )
      assert(asked >= 1)
      // A failure is asked again after a minute; a release without linux-x64 waits.
      assets = async (): Promise<string[]> => [
        `mason-${version}-darwin-arm64.tar.gz`,
        'install.sh',
      ]
      offset += MINUTE + 1000
      await reason(
        /has no linux-x64 tarball for linux-cloud machines/,
        'the missing tarball',
      )
      const created = cloud.created.length
      assets = async (): Promise<string[]> => [
        `mason-${version}-linux-x64.tar.gz`,
        'install.sh',
      ]
      offset += 11 * MINUTE
      assert.equal((await finish(id)).status, 'succeeded')
      assert.equal(cloud.created.length, created + 1)
      const spec = cloud.created.at(-1)!
      assert.match(
        spec.userData,
        new RegExp(
          `curl -fsSL https://github.com/[\\w.-]+/[\\w.-]+/releases/latest/download/install.sh -o /root/mason-install.sh\nbash /root/mason-install.sh --version ${version.replaceAll('.', '\\.')}\n`,
        ),
      )
      assert.match(
        spec.userData,
        new RegExp(`# Mason ${version.replaceAll('.', '\\.')}`),
      )
      offset += 6 * MINUTE
      await wait(() => machines().length === 0, 15_000, 'retired')
    } finally {
      db.prepare(
        "INSERT INTO settings(area,value,updated_at,updated_by) VALUES('host',?,0,'test')",
      ).run(host.value)
    }
  })

  it('U3.4/U3.5 the Pools panel offers the provider’s regions, sizes and images; pools are added, edited and removed through the API', async () => {
    const master = c.master.master!
    const admin = c.admin
    const paul = master.people
      .list({ role: 'admin', label: 'pools' })
      .find((person) => person.username === 'paul')!
    const { token } = master.auth.start(paul.id, '127.0.0.1')
    const page = async (): Promise<string> =>
      await (
        await pinnedFetch(
          c.master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:') + '/nodes',
          { headers: { cookie: `${MASTER_SESSION_COOKIE}=${token}` } },
          c.master.web!.certificate!.pin,
        )
      ).text()
    const nodes = await page()
    assert.match(nodes, /<h2>.*Cloud pools<\/h2>/)
    assert.match(nodes, /Add a pool on DigitalOcean/)
    assert.match(
      nodes,
      /<option value="sfo3"[^>]*>San Francisco 3 \(sfo3\)<\/option>/,
    )
    assert.match(
      nodes,
      /<option value="s-2vcpu-4gb"[^>]*>s-2vcpu-4gb · Basic · \$24\/month<\/option>/,
    )
    assert.match(nodes, /<option value="ubuntu-24-04-x64"/)
    assert.match(nodes, /id="pool-linux-cloud"/)
    // The catalog is asked once for ten minutes.
    const calls = cloud.catalogCalls
    await page()
    assert.equal(cloud.catalogCalls, calls)
    // A form's text fields are typed for the area.
    assert.deepEqual(
      poolInput({
        maxNodes: '2',
        slots: '',
        labels: 'docker, gpu ,',
        name: 'x',
      }),
      {
        maxNodes: 2,
        slots: undefined,
        labels: ['docker', 'gpu'],
        name: 'x',
      },
    )
    assert.deepEqual(poolInput(undefined), {})
    const form = {
      account: 'do',
      name: 'big',
      type: 'linux-big',
      region: 'sfo3',
      size: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      labels: 'docker',
      maxNodes: '2',
      slots: '2',
      ttlMinutes: '5',
      maxHoursPerNode: '12',
    }
    const bad = await c.api(
      'POST',
      '/api/v2/cloud/pools',
      { ...form, maxNodes: '0' },
      admin,
    )
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /pool.maxNodes is a whole number from 1 to 50/)
    const added = await c.api('POST', '/api/v2/cloud/pools', form, admin)
    assert.equal(added.status, 201, added.text)
    assert.deepEqual(added.json, {
      name: 'big',
      type: 'linux-big',
      account: 'do',
      provider: 'digitalocean',
      region: 'sfo3',
      size: 's-2vcpu-4gb',
      image: 'ubuntu-24-04-x64',
      labels: ['docker'],
      maxNodes: 2,
      slots: 2,
      ttlMinutes: 5,
      maxHoursPerNode: 12,
    })
    assert.equal(
      (await c.api('POST', '/api/v2/cloud/pools', form, admin)).status,
      409,
    )
    const listed = await c.api('GET', '/api/v2/cloud/pools', undefined, admin)
    assert.deepEqual(
      listed.json.map((pool: Json) => pool.name),
      ['linux-cloud', 'big'],
    )
    const catalog = await c.api(
      'GET',
      '/api/v2/cloud/accounts/do/catalog',
      undefined,
      admin,
    )
    assert.deepEqual(
      catalog.json.regions.map((region: Json) => region.slug),
      ['nyc3', 'sfo3'],
    )
    assert.equal(
      (
        await c.api(
          'GET',
          '/api/v2/cloud/accounts/none/catalog',
          undefined,
          admin,
        )
      ).status,
      404,
    )
    // A machine of the pool survives an edit, which keeps the pool's name.
    const db = master.database.db
    db.prepare(
      "INSERT INTO cloud_machines(pool,account,state,size,created_at,provider_id) VALUES('big','do','creating','s-2vcpu-4gb',?,'none')",
    ).run(Date.now() + offset)
    const edited = await c.api(
      'PUT',
      '/api/v2/cloud/pools/big',
      { ...form, name: 'renamed', maxNodes: '3' },
      admin,
    )
    assert.equal(edited.status, 200, edited.text)
    assert.equal(edited.json.name, 'big')
    assert.equal(edited.json.maxNodes, 3)
    assert.equal(machines().filter((row) => row.pool === 'big').length, 1)
    assert.equal(
      (await c.api('PUT', '/api/v2/cloud/pools/none', form, admin)).status,
      404,
    )
    // Removing the pool retires its machines.
    db.prepare(
      "INSERT INTO nodes(fingerprint,public_key,certificate_hash,role,host,port,name,added_at) VALUES('mldsa65:gone','','','worker','203.0.113.8',9310,'mason-big-1',0)",
    ).run()
    db.prepare(
      "UPDATE cloud_machines SET state='ready',fingerprint='mldsa65:gone' WHERE pool='big'",
    ).run()
    assert.equal(
      (await c.api('DELETE', '/api/v2/cloud/pools/big', undefined, admin))
        .status,
      200,
    )
    assert.equal(
      (await c.api('DELETE', '/api/v2/cloud/pools/big', undefined, admin))
        .status,
      404,
    )
    await wait(
      () => machines().every((row) => row.pool !== 'big'),
      10_000,
      'the removed pool’s machine retired',
    )
    // An account without a catalog, and a catalog that fails, still render the form.
    const view = await import('../../view/admin.js')
    const html = view.nodesView({
      nodes: [],
      types: {},
      pools: [
        {
          name: 'old',
          type: 'linux',
          account: 'gone',
          region: 'ams3',
          size: 's-1vcpu-1gb',
          image: 'ubuntu-24-04-x64',
          labels: ['a'],
          maxNodes: 1,
          slots: 1,
          ttlMinutes: 5,
          maxHoursPerNode: 1,
          machines: [{ id: 7, state: 'ready', address: '203.0.113.9:9310' }],
        },
      ],
      poolAccounts: [
        { id: 'do', name: 'DigitalOcean', error: 'Could not list regions' },
        {
          id: 'cat',
          name: 'Catalogued',
          catalog: {
            regions: [{ slug: 'sfo3', name: 'SF' }],
            sizes: [],
            images: [],
          },
        },
      ],
      budget: { monthly: 200 },
      canChange: true,
    })
    assert.match(html, /<p class="notice">Could not list regions<\/p>/)
    assert.match(
      html,
      /<input id="new-do-region" name="region" value="" required placeholder="sfo3">/,
    )
    assert.match(html, /203\.0\.113\.9:9310/)
    assert.match(html, /machine · 1 stage at a time/)
    assert.match(
      view.nodesView({
        nodes: [],
        types: {},
        pools: [],
        budget: { monthly: 1 },
        canChange: true,
      }),
      /Add a DigitalOcean account on the <a href="\/cloud">Cloud<\/a> page/,
    )
  })
})
