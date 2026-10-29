import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import ssh2 from 'ssh2'
import { dialWire, PinMismatch } from '../../link/network.js'
import { openTunnel, type GatewayAccess } from '../../link/sshGateway.js'
import { createCertificate, certificateHash } from '../../node/certificate.js'
import { cluster, type Cluster } from '../../test/cluster.js'
import { FakeNoMac } from '../../test/fakeNoMac.js'
import { nodesView } from '../../view/admin.js'
import { ProviderError } from './digitalocean.js'
import { NoMac } from './nomac.js'

const { utils } = ssh2

// Runs and requests are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = (name: string): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), name))
const key = utils.generateKeyPairSync('ed25519')
const sshKey = (): { privateKey: string; publicKey: string } => ({
  privateKey: key.private,
  publicKey: key.public,
})
/** First-boot data with pairing material, as a pool makes it. */
const script = (pairing: {
  cert: string
  key: string
  secret: string
}): string =>
  `set -euo pipefail\ncat > ~/mason-pairing.json <<'MASON_PAIRING'\n${JSON.stringify(pairing)}\nMASON_PAIRING\n`

describe('NoMac Macs', function () {
  this.timeout(120_000)
  const fake = new FakeNoMac(root('nomac-'))
  let nomac: NoMac
  before(async () => {
    await fake.start()
    nomac = new NoMac(FakeNoMac.KEY, {
      api: fake.api,
      fetch: fake.fetch,
      sshKey,
      gatewayTls: { ca: fake.ca },
      wait: async (): Promise<void> => undefined,
    })
  })
  after(async () => {
    await fake.close()
  })

  const ready = async (id: string): Promise<Json> => {
    for (let i = 0; i < 10; i++) {
      const machine = await nomac.get(id)
      if (machine?.status === 'active') return machine
    }
    throw new Error('never active')
  }

  it('U7.1/U7.7 creates a session by its idempotency key with the master’s key and limits, and is active once its setup ran', async () => {
    const certificate = createCertificate(['mac'])
    const spec = {
      name: 'mason-0123456789-mac-1',
      region: 'nomac',
      size: 'standard',
      image: 'macos',
      tags: [],
      userData: script({
        cert: certificate.cert,
        key: certificate.key,
        secret: randomBytes(32).toString('base64url'),
      }),
      limits: { maxSeconds: 3600, idleSeconds: 900 },
    }
    const made = await nomac.create(spec)
    assert.equal(made.status, 'new')
    const created = fake.requests.find(
      (request) => request.path === '/api/v1/mac/sessions',
    )!
    assert.equal(created.key, 'mason-0123456789-mac-1')
    assert.deepEqual(created.body, {
      public_key: key.public,
      profile: 'standard',
      limits: { max_duration_seconds: 3600, idle_timeout_seconds: 900 },
      access: { prompts: 'auto' },
    })
    // A repeat with the same key is the same session.
    assert.equal((await nomac.create(spec)).id, made.id)
    assert.equal((await nomac.get(made.id))!.status, 'new')
    const machine = await ready(made.id)
    assert.equal(machine.address, `nomac:${made.id}`)
    assert.equal(machine.port, 9310)
    const job = fake.requests.find((request) => request.path.endsWith('/jobs'))!
    assert.equal(job.key, `mason-setup-${made.id}`)
    assert.deepEqual((job.body as Json).argv.slice(0, 2), ['/bin/bash', '-lc'])
    // U7.6: the link's TLS over the gateway's forward, pinned to the Mac's certificate.
    const { exporter } = await dialWire(
      { host: `nomac:${made.id}`, port: 9310 },
      certificateHash(certificate.cert),
      10_000,
      async () => await nomac.tunnel(made.id, 9310),
    )
    assert.equal(exporter.length, 32)
    await assert.rejects(
      dialWire(
        { host: `nomac:${made.id}`, port: 9310 },
        certificateHash(createCertificate(['other']).cert),
        10_000,
        async () => await nomac.tunnel(made.id, 9310),
      ),
      PinMismatch,
    )
    // U7.5: each tunnel asks for a fresh gateway token.
    assert.equal(
      fake.requests.filter((request) => request.path.endsWith('/access'))
        .length,
      2,
    )
    assert.equal(await nomac.get('ses_none'), undefined)
    assert.deepEqual(await nomac.list(), [])
    assert.equal(await nomac.priceHourly(), 0.8)
  })

  it('U7.7 a failing setup is an error naming its exit code', async () => {
    const made = await nomac.create({
      name: 'mason-0123456789-mac-2',
      region: 'nomac',
      size: 'standard',
      image: 'macos',
      tags: [],
      userData: script({ cert: 'x', key: 'y', secret: 'z' }),
    })
    fake.failSetup = 2
    await assert.rejects(
      (async (): Promise<void> => {
        for (let i = 0; i < 10; i++) await nomac.get(made.id)
      })(),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.kind === 'setup' &&
        /ended with exit code 2: Downloading install.sh: no such release/.test(
          error.message,
        ),
    )
  })

  it('U7.2 no credit is a quota failure that says to add some; a refused key is auth', async () => {
    fake.credit = 0
    await assert.rejects(
      nomac.create({
        name: 'k',
        region: '',
        size: '',
        image: '',
        tags: [],
        userData: '',
      }),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.kind === 'quota' &&
        /add credit to the NoMac account/.test(error.message),
    )
    fake.credit = 10_000_000
    const wrong = new NoMac('nmk_' + 'x'.repeat(40), {
      api: fake.api,
      fetch: fake.fetch,
      sshKey,
    })
    await assert.rejects(
      wrong.priceHourly(),
      (error: unknown) =>
        error instanceof ProviderError && error.kind === 'auth',
    )
    const away = new NoMac(FakeNoMac.KEY, {
      api: 'https://127.0.0.1:1/api/v1',
      sshKey,
    })
    await assert.rejects(
      away.list().then(() => away.priceHourly()),
      (error: unknown) =>
        error instanceof ProviderError && error.kind === 'unavailable',
    )
  })

  it('U7.3 destroy waits for cleanup; NoMac keeps no snapshots', async () => {
    const [session] = [...fake.sessions.values()]
    await nomac.destroy(session!.id)
    assert.equal(session!.cleanup_confirmed, true)
    // Gone already is fine.
    await nomac.destroy('ses_none')
    await assert.rejects(nomac.snapshot(), /NoMac Macs are not snapshotted/)
    assert.deepEqual(await nomac.snapshots(), [])
    assert.equal(await nomac.hasSnapshot(), false)
    await nomac.deleteSnapshot()
    await nomac.powerOff()
    await nomac.firewall()
    assert.equal(nomac.supportsSnapshots, false)
  })

  it('U7.5 the gateway client accepts only the host key /access reported', async () => {
    const session = await nomac.create({
      name: 'mason-0123456789-mac-3',
      region: 'nomac',
      size: 'standard',
      image: 'macos',
      tags: [],
      userData: script({
        ...createCertificate(['mac']),
        secret: randomBytes(32).toString('base64url'),
      }),
    })
    await ready(session.id)
    const access = (await (
      await fake.fetch(`${fake.api}/mac/sessions/${session.id}/access`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FakeNoMac.KEY}` },
      })
    ).json()) as GatewayAccess
    const other = utils.generateKeyPairSync('ed25519')
    await assert.rejects(
      openTunnel({
        sessionId: session.id,
        access: { ...access, ssh: { ...access.ssh, host_key: other.public } },
        privateKey: key.private,
        port: 9310,
        tls: { ca: fake.ca },
      }),
    )
    await assert.rejects(
      openTunnel({
        sessionId: 'ses_else',
        access,
        privateKey: key.private,
        port: 9310,
      }),
      /another session/,
    )
    await assert.rejects(
      openTunnel({
        sessionId: session.id,
        access: { ...access, gateway: 'http://127.0.0.1:1' },
        privateKey: key.private,
        port: 9310,
      }),
      /must be an HTTPS origin/,
    )
    await assert.rejects(
      openTunnel({
        sessionId: session.id,
        access: { ...access, token: 'wrong' },
        privateKey: key.private,
        port: 9310,
        tls: { ca: fake.ca },
      }),
      /refused the tunnel \(HTTP 401\)/,
    )
    await nomac.destroy(session.id)
  })
})

describe('A NoMac pool', function () {
  this.timeout(180_000)
  let c: Cluster
  let fake: FakeNoMac
  let offset = 0

  before(async () => {
    const dir = root('nomac-pool-')
    fake = new FakeNoMac(dir)
    await fake.start()
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [],
      masterOptions: {
        now: () => Date.now() + offset,
        cloud: {
          publicAddress: async () => '203.0.113.7',
          tickMs: 200,
          pairTimeoutMs: 60_000,
          nomac: {
            api: fake.api,
            fetch: fake.fetch,
            gatewayTls: { ca: fake.ca },
            wait: async () => undefined,
          },
        },
      },
    })
    const master = c.master.master!
    await master.settings.set({ role: 'admin', label: 'paul' }, 'host', {
      origin: 'https://builds.example.test',
    })
    const release = path.join(dir, 'release')
    mkdirSync(release)
    const files: Record<string, string> = {
      'install.sh': '#!/bin/bash\n',
      'mason-0.3.0-linux-x64.tar.gz': 'tarball',
      'mason-0.3.0-darwin-arm64.tar.gz': 'tarball',
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
    await master.settings.set(
      { role: 'admin', label: 'paul' },
      'cloudAccounts',
      {
        accounts: [
          { id: 'mac', name: 'NoMac', provider: 'nomac', key: FakeNoMac.KEY },
        ],
      },
    )
    const repo = c.repo('fixtures/nomac')
    repo.commit({
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'

export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('build', { on: 'mac', run: build })
}
export async function build(ctx: Stage) {
  return { node: ctx.node.name }
}
`,
    })
    master.saveProject({ role: 'admin', label: 'paul' }, 'nomac', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
    })
  })
  after(async () => {
    await c?.close()
    await fake?.close()
  })

  it('U7.4 a NoMac pool runs one Mac at a time for at most eight hours, in NoMac’s profile', async () => {
    const settings = c.master.master!.settings
    const pool = (extra: Json = {}): Json => ({
      name: 'mac',
      type: 'mac',
      account: 'mac',
      ttlMinutes: 5,
      ...extra,
    })
    await assert.rejects(
      settings.set({ role: 'admin', label: 'paul' }, 'cloud', {
        pools: [pool({ maxNodes: 2 })],
      }),
      /pool.maxNodes is a whole number from 1 to 1/,
    )
    await assert.rejects(
      settings.set({ role: 'admin', label: 'paul' }, 'cloud', {
        pools: [pool({ maxHoursPerNode: 9 })],
      }),
      /pool.maxHoursPerNode is a whole number from 1 to 8/,
    )
    const saved = await settings.set(
      { role: 'admin', label: 'paul' },
      'cloud',
      { pools: [pool()] },
    )
    assert.deepEqual(
      (saved.pools as Json[]).map((entry) => [
        entry.provider,
        entry.region,
        entry.size,
        entry.maxNodes,
        entry.maxHoursPerNode,
      ]),
      [['nomac', 'nomac', 'standard', 1, 8]],
    )
    // U2.4 the form's NoMac defaults make a valid pool.
    const defaults = await settings.set(
      { role: 'admin', label: 'paul' },
      'cloud',
      {
        pools: [pool({ name: 'macos-cloud', type: 'macos-arm64' })],
      },
    )
    assert.deepEqual(
      (defaults.pools as Json[]).map((entry) => [entry.name, entry.type]),
      [['macos-cloud', 'macos-arm64']],
    )
    await settings.set({ role: 'admin', label: 'paul' }, 'cloud', {
      pools: [pool()],
    })
    // The Nodes page offers a NoMac pool without region, size or image, and no NoMac host.
    const html = nodesView({
      nodes: [],
      types: {},
      pools: [],
      host: 'https://builds.example.test',
      budget: { monthly: 200 },
      canChange: true,
      poolAccounts: [{ id: 'mac', name: 'NoMac', provider: 'nomac' }],
    })
    assert.match(
      html,
      /<details class="action add-pool" id="add-pool-mac"><summary class="button">.*Add a pool on NoMac<\/summary>/,
    )
    // NoMac pools default to the macOS cloud type.
    assert.match(html, /id="new-mac-name" name="name" value="macos-cloud"/)
    assert.match(html, /id="new-mac-type" name="type" value="macos-arm64"/)
    assert.match(html, /one Apple silicon Mac with Xcode at a time/)
    assert.match(html, /id="new-mac-maxNodes"[^>]*max="1"/)
    assert.match(html, /id="new-mac-maxHoursPerNode"[^>]*value="8"[^>]*max="8"/)
    assert.doesNotMatch(html, /id="new-mac-(region|size|image)"/)
    assert.doesNotMatch(html, /id="add-host-mac"/)
  })

  it('U7.3/U7.7/U7.8 a run starts a Mac, its setup and stage run there over the gateway, a dropped tunnel re-dials, and the idle Mac is stopped', async () => {
    const created = await c.api('POST', '/api/v2/runs', {
      project: 'nomac',
      branch: 'master',
    })
    assert.equal(created.status, 202, created.text)
    const id = created.json.id as string
    const done = await c
      .until(
        () => {
          const run = c.master.master!.run(id) as Json
          return ['succeeded', 'failed'].includes(run.status) ? run : undefined
        },
        90_000,
        'the run',
      )
      .catch((error: Error) => {
        throw new Error(
          `${error.message}: ${JSON.stringify(c.master.master!.run(id))}`,
        )
      })
    assert.equal(done.status, 'succeeded', JSON.stringify(done.stages))
    const [session] = [...fake.sessions.values()]
    assert(session != null)
    const setup = fake.requests.find((request) =>
      request.path.endsWith('/jobs'),
    )!
    const command = (setup.body as Json).argv[2] as string
    assert.match(
      command,
      /bash ~\/mason-install.sh --user --from https:\/\/builds.example.test/,
    )
    assert.match(
      command,
      /nomac-service start mason-worker -- ~\/.local\/bin\/mason worker --pairing-file ~\/mason-pairing.json --listen 127.0.0.1 --link-port 9310 --slots 1/,
    )
    assert.deepEqual(
      (
        fake.requests.find(
          (request) => request.path === '/api/v1/mac/sessions',
        )!.body as Json
      ).limits,
      { max_duration_seconds: 8 * 3600, idle_timeout_seconds: 15 * 60 },
    )
    // A dropped tunnel is a dropped link; the master dials again through a new token.
    const machine = c.master.master!.pools.machines()[0]! as Json
    const tokens = fake.requests.filter((request) =>
      request.path.endsWith('/access'),
    ).length
    c.master.master!.registry.link(machine.fingerprint)!.close()
    await c.until(
      () =>
        fake.requests.filter((request) => request.path.endsWith('/access'))
          .length > tokens &&
        c.master.master!.registry.link(machine.fingerprint) != null,
      30_000,
      'the link again',
    )
    // Idle past its pool's minutes: the session is stopped, never snapshotted.
    offset += 6 * 60_000
    await c.until(
      () => c.master.master!.pools.machines().length === 0,
      30_000,
      'retired',
    )
    assert.equal(session.cleanup_confirmed, true)
    assert.deepEqual(c.master.master!.pools.view().snapshots, [])
    await assert.rejects(
      c.master.master!.pools.tunnel('nomac:ses_none', 9310),
      /No NoMac machine/,
    )
  })

  it('U7.7 a Mac whose setup fails is stopped at once, and the pool waits before starting another', async () => {
    fake.failSetup = 1
    const before = fake.sessions.size
    const created = await c.api('POST', '/api/v2/runs', {
      project: 'nomac',
      branch: 'master',
    })
    const id = created.json.id as string
    const stage = await c.until(
      () => {
        const run = c.master.master!.run(id) as Json
        const found = (run.stages as Json[]).find(
          (entry) => entry.name === 'build',
        )
        return /failed its setup/.test(found?.reason ?? '') ? found : undefined
      },
      30_000,
      'the setup failure on the stage',
    )
    assert.match(
      stage.reason,
      /The last mac machine failed its setup, so the next starts in 10 minutes: Setting up NoMac session ses_\w+ ended with exit code 1: Downloading install.sh: no such release/,
    )
    assert.equal(fake.sessions.size, before + 1)
    const failed = [...fake.sessions.values()].at(-1)!
    await c.until(
      () => (failed.state === 'stopped' ? true : undefined),
      10_000,
      'the failed Mac stopped',
    )
    // No second Mac while the pool waits.
    assert.equal(fake.sessions.size, before + 1)
    await c.api('POST', `/api/v2/runs/${id}/cancel`, {})
  })
})
