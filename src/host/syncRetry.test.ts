import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'mocha'
import { LinkError, type Link } from '../link/link.js'
import type { Sync } from '../master/changes.js'
import { HostRuntime } from './runtime.js'

/** A run row the host cache takes. */
const jobRow = (id: string): Record<string, unknown> => ({
  id,
  project_id: 1,
  workflow: 'build',
  number: 1,
  branch: 'master',
  trigger: 'request',
  status: 'succeeded',
  created: 1,
  params: '{}',
  actor: 'paul',
})

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'sync-'))

/** A link whose host.sync answers fail until `failures` of them have been tried. */
function flakyLink(failures: number): {
  link: Link
  calls: () => number
} {
  let calls = 0
  const link = {
    closed: false,
    request: async (method: string): Promise<Sync> => {
      if (method !== 'host.sync') throw new Error(method)
      calls++
      if (calls <= failures)
        throw new LinkError('host.sync timed out', 'timeout')
      return { kind: 'changes', revision: 4, changes: [] }
    },
  }
  return { link: link as unknown as Link, calls: () => calls }
}

/** Waits up to two seconds for `done`, or fails with `message`. */
async function until(done: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!done()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('Host opening sync', () => {
  it('retries a failed sync while the link stays open', async () => {
    const { link, calls } = flakyLink(2)
    const logs: string[] = []
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link,
      log: (line: string): void => {
        logs.push(line)
      },
      syncRetryMs: (): number => 5,
    })
    try {
      await host.connected()
      assert.equal(host.online(), true)
      assert.equal(host.cache.revision(), 4)
      assert.equal(calls(), 3)
      assert.deepEqual(logs, [
        'Sync with the master failed: host.sync timed out',
        'Sync with the master failed: host.sync timed out',
      ])
      await host.connected()
      assert.equal(calls(), 3)
    } finally {
      await host.stop()
    }
  })

  it('retries from the revision the cache held before the first attempt', async () => {
    const asked: unknown[] = []
    const link = {
      closed: false,
      request: async (method: string, params: unknown): Promise<Sync> => {
        if (method !== 'host.sync') throw new Error(method)
        asked.push((params as { revision: number }).revision)
        if (asked.length > 1)
          return { kind: 'changes', revision: 9, changes: [] }
        // The master counted this failed answer as sent, so it pushes what
        // came after it before the retry.
        await host.methods().events!.changes!(
          { kind: 'changes', revision: 8, changes: [] },
          link as unknown as Link,
        )
        throw new LinkError('host.sync timed out', 'timeout')
      },
    }
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link as unknown as Link,
      syncRetryMs: (): number => 5,
    })
    try {
      await host.connected()
      assert.deepEqual(asked, [0, 0])
      assert.equal(host.online(), true)
      assert.equal(host.cache.revision(), 9)
    } finally {
      await host.stop()
    }
  })

  it('asks a replacement link from where the failed sync asked', async () => {
    const asked: unknown[] = []
    let current: Link | undefined
    const first = {
      closed: false,
      request: async (_method: string, params: unknown): Promise<Sync> => {
        asked.push((params as { revision: number }).revision)
        await host.methods().events!.changes!(
          { kind: 'changes', revision: 8, changes: [] },
          first as unknown as Link,
        )
        throw new LinkError('host.sync timed out', 'timeout')
      },
    }
    const second = {
      closed: false,
      request: async (_method: string, params: unknown): Promise<Sync> => {
        asked.push((params as { revision: number }).revision)
        return { kind: 'changes', revision: 9, changes: [] }
      },
    }
    current = first as unknown as Link
    const host = new HostRuntime({
      dir: root(),
      link: (): Link | undefined => current,
      syncRetryMs: (): number => 60_000,
    })
    try {
      const pending = host.connected()
      await until(() => asked.length >= 1, 'the sync was not tried')
      first.closed = true
      current = second as unknown as Link
      await Promise.all([pending, host.connected()])
      assert.deepEqual(asked, [0, 0])
      assert.equal(host.online(), true)
      assert.equal(host.cache.revision(), 9)
    } finally {
      await host.stop()
    }
  })

  it('asks from where the failed sync asked after a restart', async () => {
    const dir = root()
    const asked: unknown[] = []
    const failing = {
      closed: false,
      request: async (_method: string, params: unknown): Promise<Sync> => {
        asked.push((params as { revision: number }).revision)
        await before.methods().events!.changes!(
          { kind: 'changes', revision: 8, changes: [] },
          failing as unknown as Link,
        )
        throw new LinkError('host.sync timed out', 'timeout')
      },
    }
    const before = new HostRuntime({
      dir,
      link: (): Link => failing as unknown as Link,
      syncRetryMs: (): number => 60_000,
    })
    const pending = before.connected()
    try {
      await until(() => asked.length >= 1, 'the sync was not tried')
    } finally {
      await before.stop()
    }
    await pending
    const answering = {
      closed: false,
      request: async (_method: string, params: unknown): Promise<Sync> => {
        asked.push((params as { revision: number }).revision)
        return { kind: 'changes', revision: 9, changes: [] }
      },
    }
    const after = new HostRuntime({
      dir,
      link: (): Link => answering as unknown as Link,
    })
    try {
      await after.connected()
      assert.deepEqual(asked, [0, 0])
      assert.equal(after.online(), true)
      // The applied sync ended the range: the next one starts from here.
      assert.equal(after.cache.syncFrom(), 9)
    } finally {
      await after.stop()
    }
  })

  it('repairs a failed on-demand sync from where it asked, on the same link', async () => {
    const asked: Array<{ revision: number; opening: boolean }> = []
    let failNext = false
    const link = {
      closed: false,
      request: async (
        method: string,
        params: unknown,
        timeout: number,
      ): Promise<Sync> => {
        if (method !== 'host.sync') throw new Error(method)
        const { revision } = params as { revision: number }
        // The opening sync waits five minutes; an on-demand one 30 seconds.
        asked.push({ revision, opening: timeout > 30_000 })
        if (!failNext)
          return { kind: 'changes', revision: asked.length * 4, changes: [] }
        failNext = false
        // The master counted this answer as sent and pushed what followed.
        await host.methods().events!.changes!(
          { kind: 'changes', revision: 20, changes: [] },
          link as unknown as Link,
        )
        throw new LinkError('Message too large', 'failed')
      },
    }
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link as unknown as Link,
      syncRetryMs: (): number => 5,
    })
    try {
      await host.connected()
      assert.equal(host.cache.revision(), 4)
      failNext = true
      await assert.rejects(host.catchUp(), /Message too large/)
      await until(() => host.online(), 'the opening sync did not repair')
      assert.deepEqual(asked, [
        { revision: 0, opening: true },
        { revision: 4, opening: false },
        { revision: 4, opening: true },
      ])
    } finally {
      await host.stop()
    }
  })

  it('repairs an on-demand sync that fails while the opening sync is flushing', async () => {
    const asked: Array<{ revision: number; opening: boolean }> = []
    let answerOpening: ((sync: Sync) => void) | undefined
    let failOnDemand: ((error: Error) => void) | undefined
    let releaseFlush: (() => void) | undefined
    const link = {
      closed: false,
      request: (
        method: string,
        params: unknown,
        timeout: number,
      ): Promise<unknown> => {
        // The flush is held until the on-demand sync has failed.
        if (method === 'outbox.deliver')
          return new Promise((resolve) => {
            releaseFlush = (): void => resolve({ receipt: 'r1' })
          })
        if (method !== 'host.sync') throw new Error(method)
        const opening = timeout > 30_000
        asked.push({
          revision: (params as { revision: number }).revision,
          opening,
        })
        if (asked.length > 2)
          return Promise.resolve({ kind: 'changes', revision: 9, changes: [] })
        return new Promise((resolve, reject) => {
          if (opening) answerOpening = resolve
          else failOnDemand = reject
        })
      },
    }
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link as unknown as Link,
      syncRetryMs: (): number => 5,
    })
    try {
      host.outbox.enqueue('device', { udid: 'u1' })
      const opening = host.connected()
      await until(() => answerOpening != null, 'the opening sync was not asked')
      answerOpening!({ kind: 'changes', revision: 4, changes: [] })
      await until(() => releaseFlush != null, 'the opening sync did not flush')
      // Synced and flushing: an on-demand sync asks at once.
      const onDemand = host.catchUp()
      await until(
        () => failOnDemand != null,
        'the on-demand sync was not asked',
      )
      assert.deepEqual(asked, [
        { revision: 0, opening: true },
        { revision: 4, opening: false },
      ])
      failOnDemand!(new LinkError('Message too large', 'failed'))
      await assert.rejects(onDemand, /Message too large/)
      // The opening sync, still flushing, sees its link no longer synced and
      // asks again from where the on-demand sync asked.
      releaseFlush!()
      await opening
      assert.equal(host.online(), true)
      assert.deepEqual(asked.at(-1), { revision: 4, opening: true })
      assert.equal(asked.length, 3)
      assert.equal(host.cache.revision(), 9)
    } finally {
      await host.stop()
    }
  })

  it('fetches a sync answered in pages, in order, and applies one snapshot from them', async () => {
    const asked: string[] = []
    const page = (index: number, runs: string[]): Sync => ({
      kind: 'snapshot',
      revision: 12,
      entities: Object.fromEntries([
        ['job', runs.map((id) => ({ row: jobRow(id) }))],
        ...(index === 0 ? [['key', []]] : []),
      ]),
    })
    const link = {
      closed: false,
      request: async (method: string, params: unknown): Promise<Sync> => {
        const { index, pages } = params as { index?: number; pages?: boolean }
        asked.push(
          method === 'host.sync' ? `host.sync pages=${pages}` : `page ${index}`,
        )
        if (method === 'host.sync')
          return { ...page(0, ['a', 'b']), page: { token: 't1', count: 3 } }
        if (method === 'host.syncPage')
          return page(index!, index === 1 ? ['c'] : ['d', 'e'])
        throw new Error(method)
      },
    }
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link as unknown as Link,
      syncRetryMs: (): number => 5,
    })
    try {
      await host.connected()
      assert.deepEqual(asked, ['host.sync pages=true', 'page 1', 'page 2'])
      assert.equal(host.online(), true)
      assert.equal(host.cache.revision(), 12)
      assert.deepEqual(
        host.cache.db
          .prepare('SELECT id FROM jobs ORDER BY id')
          .all()
          .map((row) => row.id),
        ['a', 'b', 'c', 'd', 'e'],
      )
      assert.equal(
        host.cache.db
          .prepare("SELECT value FROM host_meta WHERE key='keys_synced'")
          .get()?.value,
        '1',
      )
    } finally {
      await host.stop()
    }
  })

  it('keeps a push that arrives with the last page, applying it after the older sync', async () => {
    const ref: { host?: HostRuntime } = {}
    const link = {
      closed: false,
      request: async (method: string, params: unknown): Promise<Sync> => {
        if (method === 'host.sync')
          return {
            kind: 'snapshot',
            revision: 12,
            entities: { job: [{ row: jobRow('a') }], key: [] },
            page: { token: 't', count: 2 },
          }
        // The master released the hold as it served this page: the held
        // change reaches the host in the same tick, before the page is used.
        ref.host!.methods().events!.changes!(
          {
            kind: 'changes',
            revision: 13,
            changes: [
              {
                revision: 13,
                entity: 'job',
                key: 'c',
                operation: 'put',
                value: { row: jobRow('c') },
              },
            ],
          },
          link as unknown as Link,
        )
        assert.equal((params as { index: number }).index, 1)
        return {
          kind: 'snapshot',
          revision: 12,
          entities: { job: [{ row: jobRow('b') }] },
        }
      },
    }
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link as unknown as Link,
      syncRetryMs: (): number => 5,
    })
    ref.host = host
    try {
      await host.connected()
      assert.equal(host.cache.revision(), 13)
      assert.deepEqual(
        host.cache.db
          .prepare('SELECT id FROM jobs ORDER BY id')
          .all()
          .map((row) => row.id),
        ['a', 'b', 'c'],
      )
    } finally {
      await host.stop()
    }
  })

  it('asks again from the same revision when a page fails', async () => {
    const asked: string[] = []
    let failed = false
    const link = {
      closed: false,
      request: async (method: string, params: unknown): Promise<Sync> => {
        const { index, revision } = params as {
          index?: number
          revision?: number
        }
        asked.push(
          method === 'host.sync' ? `host.sync ${revision}` : `page ${index}`,
        )
        if (method === 'host.sync')
          return {
            kind: 'changes',
            revision: 5,
            changes: [],
            page: { token: 't', count: 2 },
          }
        if (!failed) {
          failed = true
          throw new LinkError('No such sync page', 'refused')
        }
        return { kind: 'changes', revision: 8, changes: [] }
      },
    }
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link as unknown as Link,
      syncRetryMs: (): number => 5,
    })
    try {
      await host.connected()
      assert.deepEqual(asked, [
        'host.sync 0',
        'page 1',
        'host.sync 0',
        'page 1',
      ])
      assert.equal(host.online(), true)
      assert.equal(host.cache.revision(), 8)
    } finally {
      await host.stop()
    }
  })

  it('makes an on-demand sync wait for the opening sync’s pages before it asks', async () => {
    const asked: string[] = []
    let releasePage: (() => void) | undefined
    const link = {
      closed: false,
      request: async (
        method: string,
        params: unknown,
        timeout: number,
      ): Promise<Sync> => {
        const { index } = params as { index?: number }
        const opening = timeout > 30_000
        asked.push(
          method === 'host.sync'
            ? `${opening ? 'opening' : 'on-demand'} host.sync`
            : `page ${index}`,
        )
        if (method === 'host.sync')
          return opening
            ? {
                kind: 'changes',
                revision: 6,
                changes: [],
                page: { token: 't', count: 3 },
              }
            : { kind: 'changes', revision: 7, changes: [] }
        if (index === 1)
          await new Promise<void>((resolve) => {
            releasePage = resolve
          })
        return { kind: 'changes', revision: 6, changes: [] }
      },
    }
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link as unknown as Link,
      syncRetryMs: (): number => 5,
    })
    try {
      const opening = host.connected()
      await until(() => releasePage != null, 'page 1 was not asked')
      const onDemand = host.catchUp()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.deepEqual(asked, ['opening host.sync', 'page 1'])
      releasePage!()
      await Promise.all([opening, onDemand])
      assert.deepEqual(asked, [
        'opening host.sync',
        'page 1',
        'page 2',
        'on-demand host.sync',
      ])
      assert.equal(host.cache.revision(), 7)
    } finally {
      await host.stop()
    }
  })

  it('makes an on-demand sync wait for an unfinished opening sync and never ask meanwhile', async () => {
    const asked: string[] = []
    let openings = 0
    let retry: (() => void) | undefined
    const link = {
      closed: false,
      request: async (
        method: string,
        _params: unknown,
        timeout: number,
      ): Promise<Sync> => {
        const opening = timeout > 30_000
        asked.push(`${opening ? 'opening' : 'on-demand'} ${method}`)
        if (opening) {
          openings++
          if (openings === 1)
            throw new LinkError('host.sync timed out', 'timeout')
        }
        return { kind: 'changes', revision: 9, changes: [] }
      },
    }
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link as unknown as Link,
      // The opening sync's backoff waits for the test.
      syncRetryMs: (): number => 60_000,
    })
    try {
      const opening = host.connected()
      await until(() => openings === 1, 'the opening sync was not asked')
      // Let the failure reach the backoff pause.
      await new Promise((resolve) => setTimeout(resolve, 20))
      // In the opening sync's backoff: the catch-up settles at once without
      // asking, which would give up the opening's pages.
      const started = Date.now()
      assert.equal(await host.catchUp(), false)
      assert(Date.now() - started < 1000)
      assert.deepEqual(asked, ['opening host.sync'])
      retry = (): void => void host.connected()
      retry()
      await opening
      assert.deepEqual(asked, ['opening host.sync', 'opening host.sync'])
      assert.equal(host.online(), true)
      // Once synced, a catch-up asks.
      assert.equal(await host.catchUp(), true)
      assert.deepEqual(asked.at(-1), 'on-demand host.sync')
    } finally {
      await host.stop()
    }
  })

  it('settles a catch-up while the opening sync keeps failing', async () => {
    let openings = 0
    const link = {
      closed: false,
      request: async (
        method: string,
        _params: unknown,
        timeout: number,
      ): Promise<Sync> => {
        if (method !== 'host.sync') throw new Error(method)
        if (timeout > 30_000) {
          openings++
          throw new LinkError('The master is restarting', 'failed')
        }
        return { kind: 'changes', revision: 3, changes: [] }
      },
    }
    let onDemand = 0
    const counting = link.request
    link.request = async (method, params, timeout): Promise<Sync> => {
      if (timeout <= 30_000) onDemand++
      return await counting(method, params, timeout)
    }
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link as unknown as Link,
      syncRetryMs: (): number => 5,
      catchUpWaitMs: 50,
    })
    try {
      void host.connected()
      await until(() => openings >= 3, 'the opening sync did not retry')
      // It settles within its wait, without asking for a sync of its own.
      await host.catchUp()
      assert.equal(onDemand, 0)
      assert.equal(host.cache.revision(), 0)
      assert.equal(host.online(), false)
    } finally {
      await host.stop()
    }
  })

  it('stops retrying when the link is gone', async () => {
    let current: Link | undefined
    let calls = 0
    current = {
      closed: false,
      request: async (): Promise<Sync> => {
        calls++
        throw new LinkError('The master is restarting')
      },
    } as unknown as Link
    const host = new HostRuntime({
      dir: root(),
      link: (): Link | undefined => current,
      syncRetryMs: (): number => 20,
    })
    try {
      const pending = host.connected()
      await until(() => calls >= 1, 'the sync was not tried')
      current = undefined
      await pending
      const tried = calls
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(calls, tried)
    } finally {
      await host.stop()
    }
  })

  it('stops retrying when the host stops', async () => {
    let calls = 0
    const link = {
      closed: false,
      request: async (): Promise<Sync> => {
        calls++
        throw new LinkError('The master is restarting')
      },
    } as unknown as Link
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => link,
      syncRetryMs: (): number => 60_000,
    })
    const pending = host.connected()
    try {
      await until(() => calls >= 1, 'the sync was not tried')
    } finally {
      await host.stop()
    }
    await pending
    assert.equal(calls, 1)
  })

  it('syncs a replacement link without waiting out the backoff', async () => {
    let tried = 0
    let current: Link = {
      closed: false,
      request: async (): Promise<Sync> => {
        tried++
        throw new LinkError('The master is restarting')
      },
    } as unknown as Link
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => current,
      syncRetryMs: (): number => 60_000,
    })
    try {
      const pending = host.connected()
      await until(() => tried >= 1, 'the sync was not tried')
      current = {
        closed: false,
        request: async (): Promise<Sync> => ({
          kind: 'changes',
          revision: 2,
          changes: [],
        }),
      } as unknown as Link
      await host.connected()
      assert.equal(host.online(), true)
      assert.equal(host.cache.revision(), 2)
      await pending
    } finally {
      await host.stop()
    }
  })

  it('syncs a link that replaces the one whose flush is running', async () => {
    let release: ((error: Error) => void) | undefined
    const first = {
      closed: false,
      request: async (method: string): Promise<unknown> => {
        if (method === 'host.sync')
          return { kind: 'changes', revision: 3, changes: [] }
        return await new Promise((_resolve, reject) => {
          release = reject
        })
      },
    }
    const asked: string[] = []
    const second = {
      closed: false,
      request: async (method: string): Promise<unknown> => {
        asked.push(method)
        if (method === 'host.sync')
          return { kind: 'changes', revision: 7, changes: [] }
        return { receipt: 'r1' }
      },
    }
    let current = first as unknown as Link
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => current,
      syncRetryMs: (): number => 60_000,
    })
    try {
      host.outbox.enqueue('device', { udid: 'u1' })
      const pending = host.connected()
      await until(() => release != null, 'the outbox was not flushed')
      current = second as unknown as Link
      first.closed = true
      const again = host.connected()
      release!(new LinkError('Link closed', 'closed'))
      await Promise.all([pending, again])
      assert.deepEqual(asked, ['host.sync', 'outbox.deliver'])
      assert.equal(host.online(), true)
      assert.equal(host.cache.revision(), 7)
      assert.deepEqual(host.outbox.pending(), [])
    } finally {
      await host.stop()
    }
  })

  it('syncs a link that replaces the one forwarding webhooks', async () => {
    let release: ((error: Error) => void) | undefined
    const first = {
      closed: false,
      request: async (method: string): Promise<unknown> => {
        if (method === 'host.sync')
          return { kind: 'changes', revision: 3, changes: [] }
        return await new Promise((_resolve, reject) => {
          release = reject
        })
      },
    }
    const asked: string[] = []
    const second = {
      closed: false,
      request: async (method: string): Promise<unknown> => {
        asked.push(method)
        if (method === 'host.sync')
          return { kind: 'changes', revision: 7, changes: [] }
        return { status: 'accepted' }
      },
    }
    let current = first as unknown as Link
    const host = new HostRuntime({
      dir: root(),
      link: (): Link => current,
      syncRetryMs: (): number => 60_000,
    })
    try {
      host.cache.db
        .prepare(
          'INSERT INTO host_webhooks(project,branch,event,signature,body,received_at) VALUES(?,?,?,?,?,?)',
        )
        .run('app', 'master', 'push', 'sha256=0', Buffer.from('{}'), 1)
      const pending = host.connected()
      await until(() => release != null, 'the webhooks were not forwarded')
      current = second as unknown as Link
      first.closed = true
      const again = host.connected()
      release!(new LinkError('Link closed', 'closed'))
      await Promise.all([pending, again])
      assert.deepEqual(asked, ['host.sync', 'webhook.github'])
      assert.equal(host.online(), true)
      assert.equal(host.cache.revision(), 7)
      assert.deepEqual(host.webhooks.queued(), [])
    } finally {
      await host.stop()
    }
  })
})
