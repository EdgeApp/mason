import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { DeviceWorker, asWorkerConfig, type WorkerConfig } from './worker.js'

interface Report {
  devices: Array<{ id: number; status: string; message: string }>
  requests: Array<{ id: number; status: string; message: string }>
}
interface BuildRequest {
  id: number
  device_id: number
  app: string
  branch: string
  commit_hash: string
}

describe('Provisioning worker lifecycle without a device runtime', () => {
  let root: string, config: WorkerConfig, configFile: string
  let worker: DeviceWorker | undefined
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    root = mkdtempSync(
      path.join(process.env.MASON_TEST_ROOT!, 'worker-lifecycle-'),
    )
    chmodSync(root, 0o700)
    const save = (name: string, value: unknown): string => {
      const file = path.join(root, name)
      writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
      return file
    }
    const bundle = path.join(root, 'fake-bundle')
    writeFileSync(
      bundle,
      `#!${process.execPath}
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(process.argv.at(-1)));
if (request.apps.length !== 0) process.exit(2);
console.log(JSON.stringify({ revision: '0000000000000001', devices: [], profiles: [], udids: [] }));
`,
      { mode: 0o700 },
    )
    config = asWorkerConfig({
      origin: 'https://127.0.0.1:1',
      tokenFile: save('token.json', { token: 'a'.repeat(64) }),
      builderConfigFile: save('builder.json', {
        workspace: path.join(root, 'builder'),
        listenHost: '127.0.0.1',
        port: 9300,
      }),
      stateDirectory: path.join(root, 'state'),
      bundle,
      gemfile: path.join(root, 'Gemfile'),
      bundlePath: path.join(root, 'gems'),
      apple: {
        teamId: 'FIXTURE',
        certificateId: 'FIXTURE',
        loginFile: save('login.json', {}),
      },
    })
    configFile = save('worker.json', config)
  })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    await worker?.close()
    worker = undefined
    rmSync(root, { recursive: true, force: true })
  })
  it('bootstraps through the real CLI process and preserves private state on restart', async () => {
    const result = spawnSync(
      process.execPath,
      ['lib/cli.js', 'devices-bootstrap', '--config', configFile],
      { encoding: 'utf8', timeout: 10000 },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      profiles: 0,
      devices: 0,
      configured: true,
    })
    const state = JSON.parse(
      readFileSync(path.join(config.stateDirectory, 'state.json'), 'utf8'),
    )
    assert.equal(state.configuredRevision, '0000000000000001')
    worker = new DeviceWorker(config, undefined, 3600000, async () => ({
      devices: [],
      requests: [],
    }))
    await worker.poll()
    await worker.close()
    worker = undefined
  })
  it('bounds failed provisioning attempts and preserves a durable error for retry', async () => {
    const remote = {
      devices: [
        {
          id: 1,
          udid: '0'.repeat(40),
          product: 'iPhone14,5',
          model: 'iPhone13',
          os_version: '26.0',
          status: 'pending',
          message: '',
          created_at: 1,
          updated_at: 1,
          name: 'Fixture device',
        },
      ],
      requests: [],
    }
    let attempts = 0
    const reports: Report[] = []
    worker = new DeviceWorker(
      config,
      async () => {
        attempts++
        throw new Error('private diagnostic')
      },
      3600000,
      async (method, body) => {
        if (method === 'GET') return remote
        reports.push(body as Report)
        return { ok: true }
      },
    )
    for (let i = 0; i < 5; i++) await worker.poll()
    assert.equal(attempts, 3)
    assert.equal(reports.length, 3)
    for (const report of reports) {
      assert.equal(report.devices[0]!.status, 'error')
      assert.doesNotMatch(report.devices[0]!.message, /private diagnostic/)
    }
    const state = JSON.parse(
      readFileSync(path.join(config.stateDirectory, 'state.json'), 'utf8'),
    )
    assert.deepEqual(Object.values(state.retries), [3])
  })
  it('authenticates requests, rejects bad HTTP replies and coalesces concurrent polls', async () => {
    let requests = 0
    let reply = new Response(JSON.stringify({ devices: [], requests: [] }))
    globalThis.fetch = async (input, init): Promise<Response> => {
      requests++
      assert.equal(String(input), config.origin + '/api/device-provisioning')
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        'Bearer ' + 'a'.repeat(64),
      )
      assert.equal(init?.method, 'GET')
      assert(init?.signal)
      return reply
    }
    worker = new DeviceWorker(config, undefined, 3600000)
    const first = worker.poll()
    assert.equal(worker.poll(), first)
    await first
    assert.equal(requests, 1)
    reply = new Response('unavailable', { status: 503 })
    await assert.rejects(worker.poll(), /unavailable/)
    reply = new Response('x'.repeat(1024 * 1024 + 1))
    await assert.rejects(worker.poll(), /large/)
    reply = new Response('invalid json')
    await assert.rejects(worker.poll(), SyntaxError)
    await worker.close()
    worker = undefined
  })
  it('reports registration through the HTTP boundary and marks an unavailable requested app as failed', async () => {
    const device = {
      id: 1,
      udid: '0'.repeat(40),
      product: 'iPhone14,5',
      model: 'iPhone13',
      os_version: '26.0',
      status: 'pending',
      message: '',
      created_at: 1,
      updated_at: 1,
      name: 'Fixture device',
    }
    const remote = { devices: [device], requests: [] as BuildRequest[] }
    const posted: Report[] = []
    globalThis.fetch = async (_input, init): Promise<Response> => {
      if (init?.method === 'GET') return new Response(JSON.stringify(remote))
      const report = JSON.parse(String(init?.body)) as Report
      posted.push(report)
      for (const update of report.devices) Object.assign(device, update)
      return new Response('{"ok":true}')
    }
    worker = new DeviceWorker(
      config,
      async () => ({
        revision: '0000000000000002',
        devices: [{ id: 1, status: 'registered', message: '' }],
        profiles: [],
        udids: [device.udid],
      }),
      3600000,
    )
    await worker.poll()
    await worker.poll()
    assert.match(device.message, /ready/)
    remote.requests.push({
      id: 2,
      device_id: 1,
      app: 'missing',
      branch: 'master',
      commit_hash: 'a'.repeat(40),
    })
    await worker.poll()
    assert.deepEqual(
      posted.at(-1)!.requests.map((r) => [r.id, r.status]),
      [[2, 'error']],
    )
  })
  it('keeps the daemon alive after a failed poll and releases its lock on SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      ['lib/cli.js', 'devices-worker', '--config', configFile],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let errors = ''
    const exited = once(child, 'exit')
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Worker readiness timed out')),
          5000,
        )
        child.stderr.on('data', (chunk) => {
          errors += String(chunk)
          if (errors.includes('waiting for provisioning service')) {
            clearTimeout(timer)
            resolve()
          }
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      assert.equal(child.exitCode, null)
      child.kill('SIGTERM')
      assert.equal((await exited)[0], 0)
      worker = new DeviceWorker(config, undefined, 3600000, async () => ({
        devices: [],
        requests: [],
      }))
      await worker.poll()
    } finally {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill('SIGKILL')
        await exited
      }
    }
  })
  it('uses redacted CLI failure messages for bootstrap, worker, inspection and invalid commands', () => {
    writeFileSync(config.bundle, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    const bootstrap = spawnSync(
      process.execPath,
      ['lib/cli.js', 'devices-bootstrap', '--config', configFile],
      { encoding: 'utf8', timeout: 10000 },
    )
    assert.equal(bootstrap.status, 1)
    assert.match(bootstrap.stderr, /signing profile preparation failed/)
    for (const command of [
      'devices-bootstrap',
      'devices-worker',
      'devices-inspect',
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          'lib/cli.js',
          command,
          '--config',
          path.join(root, 'missing-private.json'),
        ],
        { encoding: 'utf8', timeout: 10000 },
      )
      assert.equal(result.status, 1)
      assert.doesNotMatch(result.stderr, /missing-private/)
    }
    for (const args of [['builder', 'invalid'], ['invalid']]) {
      const result = spawnSync(process.execPath, ['lib/cli.js', ...args], {
        encoding: 'utf8',
        timeout: 10000,
      })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /command failed/i)
    }
  })
})
