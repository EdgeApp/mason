import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import path from 'node:path'
import { describe, it } from 'mocha'
import { asConfig } from './config.js'
import { createApp, serve } from './server.js'
import { Store } from './store.js'

describe('Mason service', () => {
  it('serves health only, stops cleanly, and fails closed without SQLite', async () => {
    assert(process.env.MASON_TEST_ROOT)
    const root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'server-'))
    const config = asConfig({
      origin: 'https://builds.example.test',
      database: path.join(root, 'state.sqlite'),
      storage: path.join(root, 'packages'),
      freeSpaceBytes: 0,
    })
    const store = new Store(config)
    const app = createApp(store)
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const health = await fetch(origin + '/health')
      assert.equal(health.status, 200)
      assert.equal(health.headers.get('cache-control'), 'no-store')
      assert.equal((await fetch(origin + '/')).status, 404)
      store.close()
      assert.equal((await fetch(origin + '/health')).status, 503)
    } finally {
      server.close()
      await once(server, 'close')
      rmSync(root, { recursive: true, force: true })
    }
  })
  for (const linked of [false, true])
    it(`starts and prunes through the ${linked ? 'release symlink' : 'direct entrypoint'}`, async () => {
      assert(process.env.MASON_TEST_ROOT)
      const root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'cli-'))
      const probe = createServer().listen(0, '127.0.0.1')
      await once(probe, 'listening')
      const port = (probe.address() as AddressInfo).port
      probe.close()
      await once(probe, 'close')
      const config = asConfig({
        origin: 'https://builds.example.test',
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
        port,
        freeSpaceBytes: 0,
      })
      const file = path.join(root, 'config.json')
      writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
      if (linked) symlinkSync(process.cwd(), path.join(root, 'current'))
      const entrypoint = linked
        ? path.join(root, 'current/lib/cli.js')
        : 'lib/cli.js'
      const child = spawn(
        process.execPath,
        [entrypoint, 'serve', '--config', file],
        { stdio: 'pipe' },
      )
      try {
        let ready = false
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok
          } catch {
            /* Wait for listen. */
          }
          if (ready) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        assert(ready)
        const stopped = once(child, 'exit')
        child.kill('SIGTERM')
        await stopped
        assert.equal(child.exitCode, 0)
        const pruned = spawnSync(
          process.execPath,
          [entrypoint, 'prune', '--config', file],
          { encoding: 'utf8' },
        )
        assert.equal(pruned.status, 0, pruned.stderr)
        assert.equal(typeof JSON.parse(pruned.stdout), 'object')
        assert.equal(
          spawnSync(process.execPath, [
            entrypoint,
            'serve',
            '--config',
            path.join(root, 'missing.json'),
          ]).status,
          1,
        )
        const store = new Store(config)
        const server = serve(store)
        await once(server, 'listening')
        server.close()
        await once(server, 'close')
      } finally {
        if (child.exitCode == null) child.kill('SIGTERM')
        rmSync(root, { recursive: true, force: true })
      }
    })
  it('runs retention periodically, reports failures safely and closes failed listeners', async () => {
    assert(process.env.MASON_TEST_ROOT)
    const root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'timer-'))
    const probe = createServer().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = (probe.address() as AddressInfo).port
    probe.close()
    await once(probe, 'close')
    const config = asConfig({
      origin: 'https://builds.example.test',
      database: path.join(root, 'state.sqlite'),
      storage: path.join(root, 'packages'),
      port,
      freeSpaceBytes: 0,
    })
    const store = new Store(config)
    const server = serve(store, 5)
    const original = store.prune.bind(store)
    const error = console.error
    const messages: string[] = []
    try {
      await once(server, 'listening')
      let calls = 0
      store.prune = (): ReturnType<Store['prune']> => {
        calls++
        if (calls === 1) throw new Error('private detail')
        return original()
      }
      console.error = (value: string): void => {
        messages.push(value)
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert(calls >= 2)
      assert.deepEqual(messages, ['Mason retention check failed'])
      const other = new Store(config)
      const failed = serve(other)
      await once(failed, 'error')
      assert.throws(() => other.db.prepare('SELECT 1'))
      const file = path.join(root, 'config.json')
      writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
      const child = spawn(
        process.execPath,
        ['lib/cli.js', 'serve', '--config', file],
        { stdio: 'pipe' },
      )
      await once(child, 'exit')
      assert.equal(child.exitCode, 1)
    } finally {
      console.error = error
      server.close()
      await once(server, 'close')
      rmSync(root, { recursive: true, force: true })
    }
  })
})
