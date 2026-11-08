import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'mocha'
import { LinkError, type Link } from '../link/link.js'
import type { Sync } from '../master/changes.js'
import { HostRuntime } from './runtime.js'

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
