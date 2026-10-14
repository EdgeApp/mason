import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { BuilderStore } from '../builder/store.js'
import { DeviceWorker, asWorkerConfig } from './worker.js'
import { type Definition } from '../builder/config.js'

let root: string, store: BuilderStore, worker: DeviceWorker
const app = 'test.example.app',
  sha = 'a'.repeat(40),
  udid = '0'.repeat(39) + '1'
const base = {
  schemaVersion: 1,
  branches: {
    master: {
      settings: {
        tools: { bundle: '/fixture/bundle' },
        apps: {
          [app]: {
            ios: {
              apple: {
                teamId: 'FIXTURE',
                profileNames: { [app]: 'old' },
                requiredDevices: [] as string[],
              },
            },
          },
        },
      },
    },
    'feature/example': {
      extends: 'master',
      settings: { apps: { [app]: { apiOrigin: 'https://seat.example.test' } } },
    },
  },
}
describe('Apple provisioning result protocol', () => {
  it('keeps session-refresh diagnostics out of the JSON provisioning result', function () {
    const dir = mkdtempSync(
      path.join(process.env.MASON_TEST_ROOT!, 'apple-protocol-'),
    )
    try {
      writeFileSync(
        path.join(dir, 'spaceship.rb'),
        `
module Spaceship
  class Client; end
  module ConnectAPI
    def self.login(*args, **options)
      puts 'Available session is not valid anymore. Continuing with normal login.'
    end
    class Device
      def self.all; []; end
    end
    class Certificate
      def self.all
        [Struct.new(:id) { def valid?; true; end }.new('fixture')]
      end
    end
    class BundleId
      def self.find(app); Struct.new(:id, :identifier).new('fixture', app); end
    end
    class Profile
      def self.all(**options); []; end
      def self.create(**options)
        puts 'Provisioning profile prepared'
        Struct.new(:profile_content).new(Base64.strict_encode64('fixture-profile'))
      end
    end
  end
end
`,
      )
      const login = path.join(dir, 'login.json')
      const requestFile = path.join(dir, 'request.json')
      writeFileSync(
        login,
        JSON.stringify({
          username: 'fixture',
          password: 'fixture',
          cookieDirectory: dir,
        }),
        { mode: 0o600 },
      )
      writeFileSync(
        requestFile,
        JSON.stringify({
          apple: {
            loginFile: login,
            teamId: 'fixture',
            certificateId: 'fixture',
          },
          devices: [],
          apps: [app],
          directory: dir,
        }),
        { mode: 0o600 },
      )
      const result = spawnSync(
        'ruby',
        [
          '-I',
          dir,
          fileURLToPath(
            new URL('../../src/devices/apple-provision.rb', import.meta.url),
          ),
          requestFile,
        ],
        { encoding: 'utf8', timeout: 10000 },
      )
      if (
        (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      )
        this.skip()
      assert.equal(result.status, 0, result.stderr)
      const reply = JSON.parse(result.stdout)
      assert.equal(reply.profiles.length, 1)
      assert.equal(reply.profiles[0].app, app)
      assert.match(result.stderr, /Available session is not valid anymore/)
      assert.match(result.stderr, /Provisioning profile prepared/)
      assert.equal(
        readFileSync(reply.profiles[0].file, 'utf8'),
        'fixture-profile',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
describe('Device provisioning worker', () => {
  beforeEach(() => {
    root = mkdtempSync(
      path.join(process.env.MASON_TEST_ROOT!, 'device-worker-'),
    )
    chmodSync(root, 0o700)
    const builder = {
      workspace: path.join(root, 'builder'),
      listenHost: '127.0.0.1',
      port: 9300,
    }
    writeFileSync(path.join(root, 'builder.json'), JSON.stringify(builder), {
      mode: 0o600,
    })
    writeFileSync(path.join(root, 'login.json'), '{}', { mode: 0o600 })
    writeFileSync(
      path.join(root, 'token.json'),
      JSON.stringify({ token: 'a'.repeat(64) }),
      { mode: 0o600 },
    )
    store = new BuilderStore(builder)
    const def = {
      slug: app,
      name: 'Fixture',
      position: 0,
      enabled: true,
      repository: 'https://github.com/example/fixture.git',
      workspace: 'git-worktrees',
      entrypoint: undefined,
      timeoutSeconds: 60,
      platforms: ['ios'],
      env: [],
      files: [
        {
          destination: 'deployConfig.json',
          env: 'DEPLOY_CONFIG_FILE',
          contents: Buffer.from(JSON.stringify(base)).toString('base64'),
        },
      ],
    } satisfies Definition
    store.importApp(def)
  })
  afterEach(async () => {
    if (worker) await worker.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('updates only Mason definitions, preserves branch settings, pins unchanged commits and bounds separate retries', async () => {
    const device = {
      id: 1,
      udid,
      product: 'iPhone14,5',
      model: 'iPhone13',
      os_version: '26.0',
      status: 'pending',
      message: '',
      created_at: 1,
      updated_at: 1,
      name: 'iPhone13 of fixture@example',
    }
    let provisionCount = 0
    const remote = {
      devices: [device],
      requests: [] as Array<{
        id: number
        device_id: number
        app: string
        branch: string
        commit_hash: string
      }>,
    }
    const cfg = asWorkerConfig({
      origin: 'https://builds.example.test',
      tokenFile: path.join(root, 'token.json'),
      builderConfigFile: path.join(root, 'builder.json'),
      stateDirectory: path.join(root, 'state'),
      bundle: '/fixture/bundle',
      gemfile: '/fixture/Gemfile',
      bundlePath: '/fixture/gems',
      apple: {
        teamId: 'FIXTURE',
        certificateId: 'FIXTURE',
        loginFile: path.join(root, 'login.json'),
      },
    })
    worker = new DeviceWorker(
      cfg,
      async (devices, apps) => {
        provisionCount++
        assert.equal(devices.length, 1)
        assert.deepEqual(apps, [app])
        const dir = path.join(root, 'state', 'revision00000001')
        mkdirSync(dir, { mode: 0o700 })
        const file = path.join(dir, 'profile.mobileprovision')
        writeFileSync(file, 'fixture', { mode: 0o600 })
        return {
          revision: 'revision00000001',
          devices: [{ id: 1, status: 'registered', message: '' }],
          profiles: [{ app, name: 'fresh', file, sha256: 'fixture' }],
          udids: [udid],
        }
      },
      3600000,
      async (method, body) => {
        if (method === 'GET') return remote
        const report = body as {
          devices: Array<{ id: number; status: string; message: string }>
          requests: Array<{ id: number; status: string; message: string }>
        }
        for (const d of report.devices) Object.assign(device, d)
        for (const r of report.requests)
          remote.requests = remote.requests.filter((q) => q.id !== r.id)
        return { ok: true }
      },
      async () => sha,
    )
    await worker.poll()
    assert.equal(provisionCount, 1)
    const settings = JSON.parse(
      Buffer.from(store.apps()[0]!.files[0]!.contents, 'base64').toString(),
    ) as typeof base
    assert.equal(
      settings.branches.master.settings.apps[app]!.ios.apple.profileNames[app],
      'fresh',
    )
    assert.equal(
      settings.branches['feature/example'].settings.apps[app]!.apiOrigin,
      'https://seat.example.test',
    )
    assert.match(
      settings.branches.master.settings.tools.bundle,
      /revision00000001/,
    )
    let job = store.pending()[0]!
    assert.equal(job.requested_commit, sha)
    assert.equal(job.automatic, 0)
    assert.equal(job.request.platforms?.join(','), 'ios')
    store.claim()
    store.finish(job.id, 'failed', 1)
    await worker.poll()
    job = store.pending()[0]!
    assert.equal(job.requested_commit, sha)
    store.claim()
    store.finish(job.id, 'failed', 1)
    await worker.poll()
    job = store.pending()[0]!
    store.claim()
    store.finish(job.id, 'failed', 1)
    await worker.poll()
    await worker.poll()
    assert.equal(store.pending().length, 0)
    assert.equal(store.db.prepare('SELECT count(*) n FROM jobs').get()?.n, 3)
    assert.equal(
      store.db.prepare('SELECT count(*) n FROM automatic_attempts').get()?.n,
      0,
    )
    assert.match(device.message, /failed/)
    remote.requests.push({
      id: 8,
      device_id: 1,
      app,
      branch: 'feature/example',
      commit_hash: 'b'.repeat(40),
    })
    await worker.poll()
    job = store.pending()[0]!
    assert.equal(job.branch, 'feature/example')
    assert.equal(job.requested_commit, 'b'.repeat(40))
    assert.equal(remote.requests.length, 0)
    assert(readFileSync(path.join(root, 'state', 'state.json')).length > 0)
  })
})
