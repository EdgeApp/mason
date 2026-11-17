import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { clusterCheck } from '../master/clusterCheck.js'
import { localOperator } from '../master/roles.js'
import { Link, LinkError } from '../link/link.js'
import type { Sync } from '../master/changes.js'

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

/**
 * Watches the host's page requests (every Link here is in this process):
 * counts `host.syncPage` and, while `hold` is set, keeps each one waiting
 * on it. Restore with the function it returns.
 */
function watchPages(): {
  pages: () => number
  hold: (until?: Promise<void>) => void
  restore: () => void
} {
  const original = Link.prototype.request
  let pages = 0
  let held: Promise<void> | undefined
  Link.prototype.request = async function (
    this: Link,
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (method === 'host.syncPage') {
      pages++
      if (held != null) await held
    }
    return await original.call(this, method, params, timeoutMs)
  }
  return {
    pages: () => pages,
    hold: (until): void => {
      held = until
    },
    restore: (): void => {
      Link.prototype.request = original
    },
  }
}

/** Empties what host cache schema 11 makes the next sync refill, and asks for a snapshot. */
function resetAsSchema11(host: RunningNode): void {
  host.host!.cache.db.exec(`
    DELETE FROM host_keys; DELETE FROM account_emails; DELETE FROM masonfiles;
    UPDATE projects SET details=NULL;
    UPDATE host_meta SET value='0' WHERE key IN ('revision','keys_synced');
    INSERT INTO host_meta(key,value) VALUES('sync_from','0')
      ON CONFLICT(key) DO UPDATE SET value='0';`)
}

/** The pages the master holds, by token. */
function paged(c: Cluster): Map<string, unknown> {
  return (c.master.master!.hosts as unknown as { paged: Map<string, unknown> })
    .paged
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
    let clock = Date.now()
    before(async () => {
      c = await cluster(path.join(root(), 'cluster'), {
        masterOptions: {
          log: (line) => lines.push(line),
          now: () => clock,
        },
      })
      host = await c.startHost('host')
      // A host setting, so the host serves its catalog.
      await c.master.master!.settings.set(localOperator, 'host', {
        origin: 'https://host.example',
      })
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

    it('brings a host whose cache schema reset its revision online from a snapshot over 1 MiB, in pages', async () => {
      const master = c.master.master!
      const project = master.projects.get('proof').id
      const snapshot = master.changes.since(0)
      assert(Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024)
      const watch = watchPages()
      let release: (() => void) | undefined
      watch.hold(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      try {
        resetAsSchema11(host)
        await c.drop('host', 300)
        await c.until(() => watch.pages() > 0 || undefined, 10_000, 'a page')
        // While it fetches, the host counts as connected.
        assert.equal(host.host!.online(), false)
        const status = (await master.hosts.askHost('host.status', {})) as {
          revision: number
        }
        assert.equal(status.revision, 0)
        // Linked but still syncing: mason cluster check says so.
        const syncing = (await clusterCheck(master)).nodes.find(
          (node) => node.role === 'host',
        )!
        assert(
          syncing.problems.includes(
            'has not finished its opening sync with the master',
          ),
          syncing.problems.join('; '),
        )
        release!()
        await c.until(() => host.host!.online() || undefined, 20_000, 'online')
      } finally {
        release?.()
        watch.restore()
      }
      assert(watch.pages() >= 2, `${watch.pages()} pages`)
      const meta = (key: string): unknown =>
        host
          .host!.cache.db.prepare('SELECT value FROM host_meta WHERE key=?')
          .get(key)?.value
      assert.equal(meta('sync_from'), undefined)
      assert.equal(meta('keys_synced'), '1')
      assert.equal(host.host!.cache.revision(), master.changes.revision())
      assert.equal(held(host, 'SELECT COUNT(*) n FROM host_keys'), 1)
      assert.equal(held(host, 'SELECT COUNT(*) n FROM account_emails'), 1)
      assert.equal(held(host, 'SELECT COUNT(*) n FROM masonfiles'), 1)
      assert.equal(
        held(
          host,
          `SELECT COUNT(*) n FROM projects WHERE id=${project} AND details IS NOT NULL`,
        ),
        1,
      )
      assert.equal(
        held(host, "SELECT COUNT(*) n FROM jobs WHERE id LIKE 'run-%'"),
        220,
      )
      assert.equal(paged(c).size, 0)
      const report = await clusterCheck(master)
      assert.deepEqual(
        report.nodes.find((node) => node.role === 'host')!.problems,
        [],
      )
      assert(report.green)
    })

    it('answers a relayed request that needs a newer copy with the host’s “catching up” while its opening sync fetches pages', async () => {
      const master = c.master.master!
      const account = Number(
        (
          master.database.db
            .prepare("SELECT id FROM accounts WHERE name='Proof Person'")
            .get() as { id: number }
        ).id,
      )
      const watch = watchPages()
      let release: (() => void) | undefined
      watch.hold(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      try {
        resetAsSchema11(host)
        await c.drop('host', 300)
        await c.until(() => watch.pages() > 0 || undefined, 10_000, 'a page')
        const started = Date.now()
        const answer = await master.hosts.askHost('catalog.apps', {
          accountId: account,
          session: {
            id: 'a'.repeat(64),
            expiresAt: Date.now() + 60_000,
            permissionVersion: 999,
          },
        })
        assert.deepEqual(answer, {
          refused: {
            status: 503,
            message:
              'The host is catching up with the master; try again shortly',
          },
        })
        assert(Date.now() - started < 10_000, `${Date.now() - started} ms`)
        assert.equal(host.host!.online(), false)
        release!()
        await c.until(() => host.host!.online() || undefined, 20_000, 'online')
      } finally {
        release?.()
        watch.restore()
      }
    })

    it('sends a row larger than a page but within a link message alone, by push and by the opening sync', async () => {
      const master = c.master.master!
      addRuns(c, 900, 1, 800 * 1024)
      await c.until(
        () =>
          host.host!.cache.revision() === master.changes.revision() ||
          undefined,
        10_000,
        'the large run pushed',
      )
      assert.equal(
        held(host, "SELECT COUNT(*) n FROM jobs WHERE id='run-900'"),
        1,
      )
      resetAsSchema11(host)
      await c.drop('host', 300)
      await c.until(() => host.host!.online() || undefined, 20_000, 'online')
      assert.equal(
        held(host, "SELECT COUNT(*) n FROM jobs WHERE id='run-900'"),
        1,
      )
      assert.deepEqual(
        lines.filter((line) => /could not be sent/.test(line)),
        [],
      )
      master.database.db.prepare("DELETE FROM jobs WHERE id='run-900'").run()
      master.database.change('job', 'run-900', 'delete')
    })

    it('keeps a slow host’s pages while it keeps asking, though the fetch outlasts five minutes', async () => {
      const link = host.host!.options.link()!
      const first = (await link.request('host.sync', {
        revision: 0,
        pages: true,
      })) as Sync
      assert(first.page != null && first.page.count >= 3)
      for (let index = 1; index < first.page.count; index++) {
        clock += 4 * 60_000
        const page = (await link.request('host.syncPage', {
          token: first.page.token,
          index,
        })) as Sync
        assert.equal(page.kind, 'snapshot')
      }
      assert.equal(paged(c).size, 0)
    })

    it('lets go of the pages of a sync the host gave up on, so its pushes go at once', async () => {
      const master = c.master.master!
      const original = Link.prototype.request
      let failed = false
      Link.prototype.request = async function (
        this: Link,
        method: string,
        params?: unknown,
        timeoutMs?: number,
      ): Promise<unknown> {
        if (method === 'host.syncPage' && !failed) {
          failed = true
          throw new LinkError('host.syncPage timed out', 'timeout')
        }
        return await original.call(this, method, params, timeoutMs)
      }
      try {
        resetAsSchema11(host)
        await c.drop('host', 300)
        await c.until(() => host.host!.online() || undefined, 20_000, 'online')
      } finally {
        Link.prototype.request = original
      }
      assert(failed)
      assert.equal(paged(c).size, 0)
      master.projects.save(localOperator, 'proof', { name: 'After retry' })
      await c.until(
        () =>
          host.host!.cache.revision() === master.changes.revision() ||
          undefined,
        1000,
        'the change within a second',
      )
    })

    it('fetches an on-demand catch-up over 1 MiB in pages', async () => {
      const master = c.master.master!
      const hosts = master.hosts as unknown as { push: () => void }
      hosts.push = (): void => undefined
      const watch = watchPages()
      try {
        addRuns(c, 300, 220)
        assert.notEqual(host.host!.cache.revision(), master.changes.revision())
        await host.host!.catchUp()
        assert.equal(host.host!.cache.revision(), master.changes.revision())
        assert(watch.pages() >= 2, `${watch.pages()} pages`)
        assert.equal(
          held(host, 'SELECT COUNT(*) n FROM jobs WHERE number >= 1300'),
          220,
        )
      } finally {
        watch.restore()
        delete (hosts as { push?: unknown }).push
      }
    })

    it('refuses a page it does not hold for that link, and lets go of pages whose link closed or whose time ran out', async () => {
      const master = c.master.master!
      const link = host.host!.options.link()!
      const first = (await link.request('host.sync', {
        revision: 0,
        pages: true,
      })) as Sync
      assert(first.page != null && first.page.count > 1)
      const token = first.page.token
      for (const params of [
        { token: 'nope', index: 1 },
        { token, index: first.page.count },
        { token, index: 0 },
      ])
        await assert.rejects(
          link.request('host.syncPage', params),
          (error: unknown) =>
            error instanceof LinkError &&
            error.message === 'No such sync page' &&
            error.code === 'refused',
        )
      // Another link, though it carries the host's identity.
      const theirs = master.registry.link(c.fingerprint('host'))!
      const other = {
        closed: false,
        peer: theirs.peer,
        peerRole: theirs.peerRole,
      } as unknown as Link
      assert.throws(
        () =>
          master.hosts.methods().requests!['host.syncPage']!(
            { token, index: 1 },
            other,
          ),
        /No such sync page/,
      )
      // While the page is held the host's pushes wait; once its time has run
      // out they go again.
      master.projects.save(localOperator, 'proof', { name: 'Held' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.notEqual(host.host!.cache.revision(), master.changes.revision())
      clock += 6 * 60_000
      // Any sweep lets go of the expired pages and sends the held change, with
      // no new write: here a refused page request from the host.
      await assert.rejects(
        link.request('host.syncPage', { token: 'nope', index: 1 }),
      )
      await c.until(
        () =>
          host.host!.cache.revision() === master.changes.revision() ||
          undefined,
        10_000,
        'pushes again',
      )
      assert.equal(paged(c).size, 0)
      // Pages held for a link that closes are let go as it closes.
      await link.request('host.sync', { revision: 0, pages: true })
      assert.equal(paged(c).size, 1)
      await c.drop('host', 300, async () => {
        assert.equal(paged(c).size, 0)
      })
      await c.until(() => host.host!.online() || undefined, 10_000, 'online')
    })
  })

  describe('with a short page hold and a master clock that stands still', () => {
    let c: Cluster
    let host: RunningNode
    before(async () => {
      const frozen = Date.now()
      c = await cluster(path.join(root(), 'cluster'), {
        masterOptions: {
          syncPageBytes: 4096,
          pageHoldMs: 300,
          now: () => frozen,
        },
      })
      host = await c.startHost('host')
      seed(c)
      addRuns(c, 0, 10, 1000)
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

    it('lets go of an unasked paged sync on its own timer, whatever the master’s clock reads, and sends the held change', async () => {
      const master = c.master.master!
      const link = host.host!.options.link()!
      const first = (await link.request('host.sync', {
        revision: 0,
        pages: true,
      })) as Sync
      assert(first.page != null)
      assert.equal(paged(c).size, 1)
      master.projects.save(localOperator, 'proof', { name: 'Held then sent' })
      await c.until(
        () =>
          (paged(c).size === 0 &&
            host.host!.cache.revision() === master.changes.revision()) ||
          undefined,
        5000,
        'the held change after the hold',
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
      const watch = watchPages()
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
      watch.restore()
      // Its opening sync took the snapshot in pages.
      assert(watch.pages() >= 2, `${watch.pages()} pages`)
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

    it('gives a host that asks for no pages the whole sync, holding nothing', async () => {
      const master = c.master.master!
      const link = host.host!.options.link()!
      const whole = (await link.request('host.sync', { revision: 0 })) as Sync
      assert.equal(whole.page, undefined)
      assert.equal(whole.kind, 'snapshot')
      assert(Buffer.byteLength(JSON.stringify(whole)) > 4096)
      assert.equal(paged(c).size, 0)
      master.projects.save(localOperator, 'proof', { name: 'Proof again' })
      await c.until(
        () =>
          host.host!.cache.revision() === master.changes.revision() ||
          undefined,
        10_000,
        'the change pushed',
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
