import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import {
  mergePages,
  SYNC_ITEM_BYTES,
  syncPages,
  type Change,
  type Projected,
  type Sync,
} from './changes.js'

/** A run's projection with a graph of about `bytes` bytes. */
const run = (id: string, bytes: number): Projected => ({
  row: { id, graph: 'x'.repeat(bytes) },
})
const change = (revision: number, bytes: number): Change => ({
  revision,
  entity: 'job',
  key: `run-${revision}`,
  operation: 'put',
  value: run(`run-${revision}`, bytes),
})
const sizeOf = (page: Sync): number =>
  page.kind === 'snapshot'
    ? Object.values(page.entities)
        .flat()
        .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0)
    : page.changes.reduce(
        (sum, item) => sum + Buffer.byteLength(JSON.stringify(item)),
        0,
      )

describe('A sync in pages', () => {
  it('keeps a sync that fits as one page, itself, and an empty one as one empty page', () => {
    const small: Sync = {
      kind: 'snapshot',
      revision: 4,
      entities: { job: [run('a', 10)], key: [] },
    }
    assert.deepEqual(syncPages(small, 1000), [small])
    const none: Sync = { kind: 'changes', revision: 4, changes: [] }
    assert.deepEqual(syncPages(none, 1000), [none])
    const empty: Sync = { kind: 'snapshot', revision: 0, entities: {} }
    assert.deepEqual(syncPages(empty, 1000), [empty])
  })

  it('splits a snapshot into pages under the budget that merge back into it, every entity present', () => {
    const snapshot: Sync = {
      kind: 'snapshot',
      revision: 90,
      entities: {
        account: [{ row: { id: 1 } }],
        key: [],
        job: Array.from({ length: 40 }, (_, index) => run(`run-${index}`, 300)),
        project: [{ row: { id: 7, details: 'y'.repeat(200) } }],
      },
    }
    const pages = syncPages(snapshot, 2000)
    assert(pages.length > 5)
    for (const page of pages) {
      assert.equal(page.kind, 'snapshot')
      assert.equal(page.revision, 90)
      assert(sizeOf(page) <= 2000)
      assert.equal(page.page, undefined)
    }
    // The first page names every entity, the empty one too.
    assert.deepEqual(
      Object.keys(pages[0]!.kind === 'snapshot' ? pages[0]!.entities : {}),
      ['account', 'key', 'job', 'project'],
    )
    assert.deepEqual(mergePages(pages), snapshot)
  })

  it('splits changes at change boundaries, each page at its last change’s revision and the last at the sync’s', () => {
    const sync: Sync = {
      kind: 'changes',
      revision: 60,
      changes: Array.from({ length: 30 }, (_, index) =>
        change(index + 10, 300),
      ),
    }
    const pages = syncPages(sync, 1500)
    assert(pages.length > 3)
    const revisions = pages.map((page) => page.revision)
    assert.deepEqual(
      revisions.slice(0, -1),
      pages
        .slice(0, -1)
        .map((page) =>
          page.kind === 'changes' ? page.changes.at(-1)!.revision : -1,
        ),
    )
    assert.equal(revisions.at(-1), 60)
    assert.deepEqual(
      revisions,
      [...revisions].sort((a, b) => a - b),
    )
    for (const page of pages) assert(sizeOf(page) <= 1500)
    assert.deepEqual(mergePages(pages), sync)
  })

  it('gives an item larger than a page a page of its own, and refuses only one too large for a link message', () => {
    const sync: Sync = {
      kind: 'changes',
      revision: 9,
      changes: [change(3, 100), change(4, 5000), change(5, 100)],
    }
    const pages = syncPages(sync, 1000)
    assert.deepEqual(
      pages.map((page) =>
        page.kind === 'changes' ? page.changes.map((item) => item.key) : [],
      ),
      [['run-3'], ['run-4'], ['run-5']],
    )
    assert.deepEqual(mergePages(pages), sync)
    const big = 1100 * 1024
    assert.throws(
      () =>
        syncPages({ kind: 'changes', revision: 3, changes: [change(3, big)] }),
      /^Error: job run-3 is larger than a link message$/,
    )
    assert.throws(
      () =>
        syncPages({
          kind: 'snapshot',
          revision: 3,
          entities: { job: [run('a', 10), run('b', big)] },
        }),
      /^Error: job row 1 is larger than a link message$/,
    )
    // Just under the link's limit, it still goes, alone.
    const near = SYNC_ITEM_BYTES - 1024
    const alone = syncPages({
      kind: 'snapshot',
      revision: 3,
      entities: { job: [run('a', 10), run('b', near)] },
    })
    assert.equal(alone.length, 2)
  })
})
