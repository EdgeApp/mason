import assert from 'node:assert/strict'
import { version } from '../../version.js'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { cluster, type Cluster } from '../../test/cluster.js'
import { stageDemand } from '../scheduler.js'
import { FakeCloud } from '../../test/fakeCloud.js'

// Runs are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const admin = { role: 'admin' as const, label: 'paul' }

describe('A master whose only nodes are cloud machines', function () {
  this.timeout(120_000)
  let c: Cluster
  let cloud: FakeCloud

  before(async () => {
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'cloud-only-'),
    )
    cloud = new FakeCloud(dir)
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [],
      masterOptions: {
        cloud: {
          provider: () => cloud,
          publicAddress: async () => '203.0.113.7',
          // The master's GitHub release, without the network.
          github: () => ({ repository: 'EdgeApp/mason', version }),
          releaseAssets: async () => [
            `mason-${version}-linux-x64.tar.gz`,
            'install.sh',
          ],
          tickMs: 200,
          pairTimeoutMs: 20_000,
        },
      },
    })
    const master = c.master.master!
    await master.settings.set(admin, 'host', {
      origin: 'https://builds.example.test',
    })
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
    await master.settings.set(admin, 'cloudAccounts', {
      accounts: [
        {
          id: 'do',
          name: 'DigitalOcean',
          provider: 'digitalocean',
          key: 'dop_v1_' + 'c'.repeat(64),
        },
      ],
    })
    await master.settings.set(admin, 'cloud', {
      pools: [
        {
          name: 'linux',
          type: 'linux',
          account: 'do',
          region: 'sfo3',
          size: 's-1vcpu-1gb',
          image: 'ubuntu-24-04-x64',
        },
      ],
    })
    const repo = c.repo('fixtures/cloud-only')
    repo.commit({
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  // Any of these: the pool's linux machine takes it by the second.
  m.stage('hello', { on: [{ os: 'windows' }, 'linux'], run: hello })
}
export async function hello(ctx: Stage) {
  return { node: ctx.node.name }
}
`,
    })
    master.saveProject(admin, 'cloud-only', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
    })
  })
  after(async () => {
    await c?.close()
    await cloud?.close()
  })

  it('U3.6 starts a pool machine for a setup when no worker is connected, then runs the stage there', async () => {
    const created = await c.api('POST', '/api/v2/runs', {
      project: 'cloud-only',
      branch: 'master',
    })
    assert.equal(created.status, 202, created.text)
    const id = created.json.id as string
    const run = (): Json => c.master.master!.run(id)
    const setup = await c.until(
      () => {
        const value = run()
        const stage = value.stages.find(
          (entry: Json) => entry.name === '@setup',
        )
        // After the first check of the GitHub release, the pool starts one.
        return /Starting a linux machine|Waiting for a linux machine/.test(
          stage?.reason ?? '',
        )
          ? stage
          : undefined
      },
      10_000,
      'the setup waiting for a machine',
    )
    assert.match(
      setup.reason,
      /Starting a linux machine|Waiting for a linux machine to start/,
    )
    const done = await c.until(
      () =>
        ['succeeded', 'failed'].includes(run().status) ? run() : undefined,
      60_000,
      'the run',
    )
    assert.equal(done.status, 'succeeded', JSON.stringify(done.stages))
    assert.equal(cloud.created.length, 1)
  })

  it('U3.7 a selector list stops at the first pool serving it, by the real pool answers', async () => {
    const master = c.master.master!
    const linux = {
      name: 'linux',
      type: 'linux',
      account: 'do',
      region: 'sfo3',
      size: 's-1vcpu-1gb',
      image: 'ubuntu-24-04-x64',
    }
    // The linux pool is full with its one machine; a spare pool could start one.
    await master.settings.set(admin, 'cloud', {
      pools: [
        { ...linux, maxNodes: 1 },
        { ...linux, name: 'spare', type: 'spare' },
      ],
    })
    const created = cloud.created.length
    const stage = {
      name: 'list',
      on: ['linux', 'spare'],
    } as unknown as Parameters<typeof stageDemand>[0]
    const full = master.pools.demand('linux')
    assert.equal(full?.serving, true, full?.reason)
    assert.equal(
      stageDemand(stage, (type) => master.pools.demand(type)),
      'The linux pool is at its 1-machine limit',
    )
    assert.equal(cloud.created.length, created)
    // A type no pool backs is passed over; the spare pool starts its machine.
    assert.equal(
      stageDemand({ ...stage, on: ['nope', 'spare'] } as typeof stage, (type) =>
        master.pools.demand(type),
      ),
      'Starting a spare machine',
    )
    await c.until(
      () => cloud.created.length > created || undefined,
      10_000,
      'the spare machine',
    )
    // A stage that needs Xcode never asks a Linux pool for a machine.
    const machines = cloud.created.length
    assert.equal(master.pools.makesMacs('linux'), false)
    assert.equal(
      stageDemand(
        { ...stage, tools: { cocoapods: '1.16.2' } } as typeof stage,
        (type) => master.pools.demand(type),
        (type) => master.pools.makesMacs(type),
      ),
      undefined,
    )
    assert.equal(cloud.created.length, machines)
    await master.settings.set(admin, 'cloud', { pools: [linux] })
  })
})
