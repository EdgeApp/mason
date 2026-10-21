import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { controlRequest } from '../node/control.js'
import { nodeMain, type MainIO } from '../node/main.js'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { version } from '../version.js'
import {
  clusterCheck,
  formatCheck,
  type ClusterReport,
} from './clusterCheck.js'
import type { Master } from './runtime.js'

describe('Cluster check', function () {
  this.timeout(120_000)
  let c: Cluster
  let host: RunningNode
  before(async () => {
    const root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'check-'),
    )
    c = await cluster(path.join(root, 'cluster'), { workers: [{ name: 'w' }] })
    host = await c.startHost('host')
  })
  after(async () => {
    await c?.close()
  })

  it('U19.1 is green when every node is linked, current and caught up, and names what is not', async () => {
    const master = c.master.master!
    let report: ClusterReport | undefined
    for (let tries = 0; tries < 100; tries++) {
      report = (await controlRequest(
        c.master.dir,
        'cluster.check',
      )) as ClusterReport
      if (report.green) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert(report!.green, formatCheck(report!))
    assert.deepEqual(
      report!.nodes.map((node) => [node.role, node.name]).sort(),
      [
        ['host', 'host'],
        ['worker', 'w'],
      ],
    )
    const hostCheck = report!.nodes.find((node) => node.role === 'host')!
    assert.deepEqual(hostCheck.cache, {
      revision: report!.master.revision,
      lag: 0,
      outbox: 0,
      refused: 0,
    })
    assert.equal(hostCheck.version, version)
    assert.match(formatCheck(report!), /All green\./)
    // A quarantined worker and a waiting outbox message are named.
    const worker = master.registry.list().find((node) => node.name === 'w')!
    master.database.db
      .prepare('UPDATE worker_inventory SET quarantine=? WHERE fingerprint=?')
      .run('a process outlived its stage', worker.fingerprint)
    host.host!.outbox.enqueue('prepare', { build: 1, device: 1 })
    // `mason cluster check` prints the report and fails while something needs a person.
    const out: string[] = []
    const io = {
      out: (line: string): void => void out.push(line),
      err: (): void => undefined,
    } as unknown as MainIO
    const failing = await clusterCheck(master)
    assert.equal(
      await nodeMain(['cluster', 'check', '--data', c.master.dir], io),
      1,
    )
    assert.match(out.join('\n'), /is quarantined/)
    assert.equal(
      await nodeMain(
        ['cluster', 'check', '--json', '--data', c.master.dir],
        io,
      ),
      1,
    )
    assert.equal((JSON.parse(out.at(-1)!) as ClusterReport).green, false)
    assert(!failing.green)
    assert.deepEqual(
      failing.nodes.find((node) => node.name === 'w')!.problems,
      ['is quarantined: a process outlived its stage'],
    )
    const text = formatCheck(failing)
    assert.match(text, /✗ worker w/)
    assert.match(text, /Something needs a person\./)
  })

  it('U19.1 reports lag, outbox depth, refused messages, versions, unlinked nodes and hosts that do not answer', async () => {
    const node = (
      name: string,
      role: 'worker' | 'host',
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      name,
      role,
      fingerprint: name,
      host: '192.0.2.1',
      ...extra,
    })
    const links = new Map<string, unknown>([
      [
        'lagging',
        {
          request: async (): Promise<unknown> => ({
            revision: 7,
            outbox: 2,
            refused: 1,
            version: '0.0.1',
          }),
        },
      ],
      [
        'silent',
        {
          request: async (): Promise<never> => {
            throw new Error('host.status timed out')
          },
        },
      ],
      ['worker', {}],
    ])
    const fake = {
      changes: { revision: () => 10 },
      registry: {
        list: () => [
          node('lagging', 'host'),
          node('silent', 'host', { version }),
          node('worker', 'worker', { version: '0.0.2' }),
          node('gone', 'worker'),
          node('local', 'worker', { host: 'in-process', version }),
        ],
        link: (fingerprint: string) => links.get(fingerprint),
      },
      database: {
        db: {
          prepare: (): { get: (fingerprint: string) => unknown } => ({
            get: (fingerprint: string): unknown =>
              fingerprint === 'local'
                ? { quarantine: null, updated: 1000 }
                : undefined,
          }),
        },
      },
    } as unknown as Master
    const report = await clusterCheck(fake, 50)
    const problems = Object.fromEntries(
      report.nodes.map((entry) => [entry.name, entry.problems]),
    )
    assert.deepEqual(problems, {
      lagging: [
        `runs Mason 0.0.1, the master ${version}`,
        'is 3 changes behind',
        'has 2 outbox messages waiting',
        'has 1 refused outbox messages',
      ],
      silent: ['did not answer: host.status timed out'],
      worker: [
        `runs Mason 0.0.2, the master ${version}`,
        'has sent no inventory',
      ],
      gone: ['not linked', 'has sent no inventory'],
      local: [],
    })
    assert(!report.green)
    const text = formatCheck(report, 6000)
    assert.match(text, /NOT LINKED/)
    assert.match(text, /cache 7 \(3 behind\), outbox 2, refused 1/)
    assert.match(text, /inventory 5s ago/)
    assert.match(
      formatCheck({ master: { version, revision: 0 }, nodes: [], green: true }),
      /No nodes are paired\.\nAll green\./,
    )
  })
})
