import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { localOperator } from '../master/roles.js'

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'pages-'))

/** A run's graph of about 8 KB, as a large workflow's is. */
const GRAPH = 8000

/** The proof project, a person with an email and a kept Masonfile. */
function seed(c: Cluster): number {
  const master = c.master.master!
  master.saveProject(localOperator, 'proof', {
    name: 'Proof',
    repository: 'https://github.com/EdgeApp/proof',
  })
  const project = master.projects.get('proof').id
  master.people.create(localOperator, {
    name: 'Proof Person',
    emails: ['proof@example.test'],
    role: 'developer',
  })
  const commit = 'a'.repeat(40)
  master.database.db
    .prepare(
      "INSERT INTO masonfiles(key,project_id,commit_sha,file,text,created_at) VALUES(?,?,?,'Masonfile.ts','export function setup() {}',?)",
    )
    .run(`${project}:${commit}`, project, commit, master.database.now())
  master.database.change('masonfile', `${project}:${commit}`)
  return project
}

/** Commits runs `from` to `from + count - 1`, each with its own graph, in one transaction. */
function addRuns(c: Cluster, from: number, count: number, bytes = GRAPH): void {
  const master = c.master.master!
  const db = master.database.db
  const project = master.projects.get('proof').id
  master.database.transaction(() => {
    for (let n = from; n < from + count; n++) {
      db.prepare(
        "INSERT INTO graphs(key,project_id,branch,commit_sha,workflow,graph,created) VALUES(?,?,'master',?,'build',?,?)",
      ).run(
        `graph-${n}`,
        project,
        'b'.repeat(40),
        JSON.stringify({ workflow: 'build', note: 'x'.repeat(bytes) }),
        master.database.now(),
      )
      db.prepare(
        "INSERT INTO jobs(id,project_id,workflow,number,branch,trigger,status,created,request,graph_key) VALUES(?,?,'build',?,'master','request','succeeded',?,'{}',?)",
      ).run(`run-${n}`, project, 1000 + n, master.database.now(), `graph-${n}`)
      master.database.change('job', `run-${n}`)
    }
  })
}

/** Counts in the host's cache. */
function held(host: RunningNode, sql: string): number {
  return Number((host.host!.cache.db.prepare(sql).get() as { n: number }).n)
}

describe('Host syncs larger than one link message', function () {
  this.timeout(120_000)

  describe('with the page budget as shipped', () => {
    let c: Cluster
    let host: RunningNode
    const lines: string[] = []
    before(async () => {
      c = await cluster(path.join(root(), 'cluster'), {
        masterOptions: { log: (line) => lines.push(line) },
      })
      host = await c.startHost('host')
      seed(c)
    })
    after(async () => {
      await c?.close()
    })

    it('sends a burst of changes over 1 MiB as several events; the host takes every one and stays online', async () => {
      await c.until(
        () =>
          held(host, 'SELECT COUNT(*) n FROM masonfiles') === 1 || undefined,
        10_000,
        'the seed on the host',
      )
      const revision = c.master.master!.changes.revision()
      addRuns(c, 0, 220)
      const burst = c.master.master!.changes.since(revision)
      assert(Buffer.byteLength(JSON.stringify(burst)) > 1024 * 1024)
      await c.until(
        () =>
          host.host!.cache.revision() === c.master.master!.changes.revision() ||
          undefined,
        20_000,
        'the host at the master’s revision',
      )
      assert.equal(
        held(host, "SELECT COUNT(*) n FROM jobs WHERE id LIKE 'run-%'"),
        220,
      )
      assert(host.host!.online())
      assert.deepEqual(
        lines.filter((line) => /could not be sent|full sync/.test(line)),
        [],
      )
    })
  })

  describe('with a small page budget', () => {
    let c: Cluster
    let host: RunningNode
    const lines: string[] = []
    before(async () => {
      c = await cluster(path.join(root(), 'cluster'), {
        masterOptions: {
          log: (line) => lines.push(line),
          syncPageBytes: 4096,
        },
      })
      host = await c.startHost('host')
      seed(c)
      addRuns(c, 0, 30, 1000)
      await c.until(
        () =>
          host.host!.cache.revision() === c.master.master!.changes.revision() ||
          undefined,
        20_000,
        'the seed on the host',
      )
    })
    after(async () => {
      await c?.close()
    })

    it('takes a snapshot pushed after the change log was emptied through the opening sync, never as page-sized events', async () => {
      const master = c.master.master!
      const project = master.projects.get('proof').id
      // compact() empties the log after seven days with no change: the
      // master's revision then reads 0, and a host past it gets a snapshot.
      master.database.db.exec('DELETE FROM change_log')
      assert.equal(master.changes.revision(), 0)
      await c.drop('host', 300)
      await c.until(() => host.host!.online() || undefined, 20_000, 'online')
      lines.length = 0
      master.projects.save(localOperator, 'proof', { name: 'Proof renamed' })
      await c.until(
        () => lines.some((line) => /need a full sync/.test(line)) || undefined,
        10_000,
        'the full sync',
      )
      await c.until(
        () =>
          (host.host!.online() &&
            host.host!.cache.revision() === master.changes.revision()) ||
          undefined,
        20_000,
        'the host relinked and synced',
      )
      assert.equal(
        held(host, "SELECT COUNT(*) n FROM jobs WHERE id LIKE 'run-%'"),
        30,
      )
      assert.equal(held(host, 'SELECT COUNT(*) n FROM host_keys'), 1)
      assert.equal(held(host, 'SELECT COUNT(*) n FROM account_emails'), 1)
      assert.equal(held(host, 'SELECT COUNT(*) n FROM masonfiles'), 1)
      assert.equal(
        (
          host
            .host!.cache.db.prepare('SELECT name FROM projects WHERE id=?')
            .get(project) as { name: string }
        ).name,
        'Proof renamed',
      )
    })

    it('stops sending to a host when one row is larger than a link message, logs it, and keeps running', async () => {
      const master = c.master.master!
      lines.length = 0
      // A row too large for a link message on its own (over 1 MiB).
      addRuns(c, 100, 1, 1100 * 1024)
      await c.until(
        () => lines.some((line) => /could not be sent/.test(line)) || undefined,
        10_000,
        'the refused send',
      )
      assert.match(
        lines.find((line) => /could not be sent/.test(line))!,
        /^Changes for host host could not be sent: job run-100 is larger than a link message$/,
      )
      assert.notEqual(host.host!.cache.revision(), master.changes.revision())
      // The master is still answering.
      assert.equal((await c.api('GET', '/api/v2/node')).status, 200)
      master.database.db.prepare("DELETE FROM jobs WHERE id='run-100'").run()
      master.database.change('job', 'run-100', 'delete')
    })
  })
})
