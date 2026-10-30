import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { Agent } from 'undici'
import { LinkError } from '../link/link.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { FakeS3 } from '../test/fakeS3.js'
import { desktop, manifest, zip } from '../upload/fixtures.test.js'
import { signClaims, verifyClaims, type GrantClaims } from './artifacts.js'
import { seedLegacySecrets, seedSecret } from '../test/secrets.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = (): string =>
  mkdtempSync(
    path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'artifacts-'),
  )
const admin = { role: 'admin' as const, label: 'paul' }
const APP = 'test.example.app'
const insecure = new Agent({ connect: { rejectUnauthorized: false } })
const sha = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex')
const apk = zip([['AndroidManifest.xml', manifest()]])
const dmg = desktop('dmg')
/** Another valid disk image: one byte away from the first. */
const dmg2 = Buffer.from(dmg)
dmg2[16] = (dmg2[16]! + 1) % 256
const dmg3 = Buffer.from(dmg)
dmg3[17] = (dmg3[17]! + 1) % 256

const masonfile = `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  const split = String(m.params.mode).startsWith('variants')
  m.buildNumber('${APP}', { start: 42, block: split ? 3 : 1 })
  m.workflow('build', { params: { mode: { type: 'string', default: 'apk' } }, keep: { artifactDays: 3 } }, () => {})
  if (split)
    m.parallel('split', {
      universal: { on: {}, publishes: ['${APP}'], secrets: ['APK_N0', 'APK_N1'], run: shipUniversal },
      arm64: { on: {}, publishes: ['${APP}'], secrets: ['APK_N2', 'APK_N3'], run: shipArm64 },
    })
  else m.stage('ship', { on: {}, publishes: ['${APP}'], secrets: ['FIXTURE_APK', 'FIXTURE_DMG'], run: ship })
}
const put = async (ctx: Stage, secret: string): Promise<string> => {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(secret + '.apk', Buffer.from(ctx.secret(secret), 'base64'))
  return secret + '.apk'
}
export async function shipUniversal(ctx: Stage) {
  await ctx.publish({ app: '${APP}', platform: 'android', path: await put(ctx, 'APK_N0'), changelog: 'Split' })
  return await ctx.publish({ app: '${APP}', platform: 'android', variant: 'armeabi-v7a', path: await put(ctx, 'APK_N1') })
}
export async function shipArm64(ctx: Stage) {
  const secret = ctx.run.params.mode === 'variants-outside' ? 'APK_N3' : 'APK_N2'
  return await ctx.publish({ app: '${APP}', platform: 'android', variant: 'arm64-v8a', path: await put(ctx, secret) })
}
export async function ship(ctx: Stage) {
  const { writeFileSync, mkdirSync, existsSync } = await import('node:fs')
  const mode = String(ctx.run.params.mode)
  if (mode === 'apk') {
    writeFileSync('app.apk', Buffer.from(ctx.secret('FIXTURE_APK'), 'base64'))
    return await ctx.publish({ app: '${APP}', platform: 'android', path: 'app.apk', changelog: 'From the pipeline' })
  }
  if (mode === 'dmg' || mode === 'dmg-wait') {
    if (mode === 'dmg-wait')
      await ctx.waitUntil(() => existsSync('go'), { timeout: '30s', interval: '1s' })
    writeFileSync('app.dmg', Buffer.from(ctx.secret('FIXTURE_DMG'), 'base64'))
    return await ctx.publish({ app: '${APP}', platform: 'macos', path: 'app.dmg', version: '1.2.3' })
  }
  if (mode === 'dmg-late') {
    await ctx.waitUntil(() => existsSync('late-go'), { timeout: '30s', interval: '1s' })
    const image = Buffer.from(ctx.secret('FIXTURE_DMG'), 'base64')
    image[16] = (image[16] + 2) % 256
    writeFileSync('app.dmg', image)
    return await ctx.publish({ app: '${APP}', platform: 'macos', path: 'app.dmg', version: '1.2.4' })
  }
  if (mode === 'save') {
    mkdirSync('report', { recursive: true })
    writeFileSync('report/index.html', '<html><body>Report</body></html>')
    writeFileSync('results.xml', '<testsuite name="s"><testcase name="a"/><testcase name="b"><failure message="boom"/></testcase></testsuite>')
    await ctx.artifacts.save('report', 'report/**', { kind: 'report' })
    await ctx.artifacts.save('results', 'results.xml', { visibleTo: 'testers' })
    return await ctx.tests('junit', 'results.xml')
  }
  if (mode === 'strict') {
    writeFileSync('results.xml', '<testsuite name="s"><testcase name="b"><failure message="boom"/></testcase></testsuite>')
    return await ctx.tests('junit', 'results.xml', { failOn: 'failure' })
  }
  if (mode === 'fetch') return await ctx.artifacts.fetch({ workflow: 'build', name: 'results' }, 'got')
  if (mode === 'missing') return await ctx.artifacts.fetch({ workflow: 'build', name: 'nothing' }, 'got')
  return null
}
`

describe('Artifacts and publication', function () {
  this.timeout(120_000)
  let c: Cluster
  let host: RunningNode
  let s3: FakeS3
  const access = (): { origin: string; pin: string } => ({
    origin: c.hosts.get('host')!.web!.url,
    pin: c.hosts.get('host')!.web!.certificate!.pin,
  })

  before(async () => {
    s3 = new FakeS3({
      bucket: 'mason-artifacts',
      region: 'nyc3',
      accessKeyId: 'AKIAFAKE1234',
      secretAccessKey: 'fake-secret-value-1234',
    })
    await s3.start()
    const dir = root()
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [{ name: 'w' }],
    })
    // The fake S3 speaks plain HTTP behind an https endpoint in the setting.
    const plain = (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> =>
      fetch(
        String(url instanceof Request ? url.url : url).replace(
          /^https:/,
          'http:',
        ),
        init,
      )
    host = await c.startHost('host', {
      hostOptions: { storageFetch: plain as typeof fetch },
    })
    const master = c.master.master!
    await master.settings.set(admin, 'host', {
      origin: 'https://builds.example.test',
      workerOrigin: host.web!.url,
    })
    const repo = c.repo('fixtures/ship')
    repo.commit({ 'Masonfile.ts': masonfile })
    master.saveProject(admin, 'ship', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
      apps: [
        { bundleId: APP, name: 'Example', platforms: ['android', 'macos'] },
      ],
    })
    seedLegacySecrets(master.database.db, 'ship', {
      env: [
        { name: 'FIXTURE_APK', value: apk.toString('base64'), secret: false },
        { name: 'FIXTURE_DMG', value: dmg.toString('base64'), secret: false },
        ...[0, 1, 2, 3].map((k) => ({
          name: `APK_N${k}`,
          value: apk.toString('base64'),
          secret: false,
        })),
      ],
    })
    master.saveProject(admin, 'other', {
      repository: c.repo('fixtures/other').url,
      rules: [{ pattern: '*', mode: 'request' }],
    })
    c.repo('fixtures/other').commit({
      'Masonfile.ts': masonfile.replace(
        `publishes: ['${APP}']`,
        'publishes: []',
      ),
    })
  })
  after(async () => {
    await c?.close()
    await s3?.close()
  })

  const run = async (
    mode: string,
    project = 'ship',
    branch = 'master',
  ): Promise<Json> => {
    const created = await c.api('POST', '/api/v2/runs', {
      project,
      branch,
      params: { mode },
    })
    assert.equal(created.status, 202, created.text)
    return await c.until(
      () => {
        const value = c.master.master!.run(created.json.id) as Json
        return ['succeeded', 'failed', 'cancelled', 'unstable'].includes(
          value.status,
        )
          ? value
          : undefined
      },
      60_000,
      `the ${mode} run`,
    )
  }
  const output = (value: Json): Json =>
    value.stages.find((stage: Json) => stage.name === 'ship').output
  const db = (): import('node:sqlite').DatabaseSync =>
    c.master.master!.database.db

  it('U12.1/U12.4 reserves each declared publication, publishes the staged APK as a ready build and shows it on the host', async () => {
    const value = await run('apk')
    assert.equal(
      value.status,
      'succeeded',
      c.master.master!.scheduler.logs(value.id),
    )
    const result = output(value)
    assert(result.buildId > 0)
    assert.equal(result.visible, true)
    const build = db()
      .prepare('SELECT * FROM builds WHERE id=?')
      .get(result.buildId) as Json
    assert.equal(build.state, 'ready')
    assert.equal(build.build_number, '42')
    assert.equal(build.bundle_id, APP)
    assert.equal(build.changelog, 'From the pipeline')
    assert.equal(build.digest, sha(apk))
    const reservations = (
      db()
        .prepare(
          'SELECT r.platform,r.build_number,p.variant,p.build_id FROM build_reservations r LEFT JOIN build_publications p ON p.reservation_id=r.id WHERE r.job_id=?',
        )
        .all(value.id) as Json[]
    ).map((row) => ({ ...row }))
    // The unused macOS reservation went with the run's end.
    assert.deepEqual(reservations, [
      {
        platform: 'android',
        build_number: '42',
        variant: '',
        build_id: result.buildId,
      },
    ])
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM builds WHERE id=?')
          .get(result.buildId),
      2000,
      'the build on the host',
    )
    // The builds table keeps the distribution schema's columns.
    const columns = (
      db().prepare('PRAGMA table_info(builds)').all() as Json[]
    ).map((column) => column.name)
    assert.deepEqual(columns.slice(0, 5), [
      'id',
      'app_id',
      'channel_id',
      'platform',
      'branch',
    ])
  })

  it('U12.2/U12.3/U12.13 the host checks the grant’s signature, expiry, digest, size and the package’s app, reached by its pin', async () => {
    const master = c.master.master!
    const job = (
      db().prepare('SELECT id FROM jobs ORDER BY created LIMIT 1').get() as Json
    ).id
    const reserve = (): Json[] =>
      master.artifacts.reserve(
        { job, stage: 'ship', attempt: 9, project: 1 },
        [APP],
        { [APP]: '42' },
      )
    reserve()
    const granted = master.artifacts.grant(
      { job, stage: 'ship', attempt: 9 },
      {
        app: APP,
        platform: 'android',
        format: 'apk',
        digest: sha(apk),
        size: apk.length,
        version: '1.2.3',
      },
    )
    assert.equal(granted.pin, access().pin)
    assert(granted.url.startsWith(access().origin))
    const post = async (
      url: string,
      body: Buffer,
      headers: Record<string, string>,
      pin = granted.pin,
    ): ReturnType<typeof pinnedFetch> =>
      await pinnedFetch(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', ...headers },
          body,
        },
        pin,
      )
    // A wrong pin fails before anything is sent.
    await assert.rejects(
      post(
        granted.url,
        apk,
        { Authorization: `Bearer ${granted.grant}` },
        'sha256//' + 'A'.repeat(43) + '=',
      ),
    )
    // A tampered grant, another reservation's grant, a different file or size.
    const [payload, signature] = granted.grant.split('.')
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
        size: 99,
      }),
    ).toString('base64url')
    assert.equal(
      (
        await post(granted.url, apk, {
          Authorization: `Bearer ${forged}.${signature}`,
        })
      ).status,
      401,
    )
    assert.equal(
      (
        await post(granted.url, Buffer.concat([apk, Buffer.from('x')]), {
          Authorization: `Bearer ${granted.grant}`,
        })
      ).status,
      413,
    )
    assert.equal(
      (
        await post(granted.url.replace(/[0-9a-f]{32}$/, '0'.repeat(32)), apk, {
          Authorization: `Bearer ${granted.grant}`,
        })
      ).status,
      401,
    )
    const claims = verifyClaims<GrantClaims>(
      granted.grant,
      c.master.master!.identity.publicKey,
      'grant',
      Date.now(),
    )
    const expired = signClaims(
      { ...claims, expires: Date.now() - 1 },
      c.master.master!.identity.privateKey,
    )
    assert.equal(
      (await post(granted.url, apk, { Authorization: `Bearer ${expired}` }))
        .status,
      401,
    )
    const otherDigest = signClaims(
      { ...claims, digest: sha(Buffer.from('other')) },
      c.master.master!.identity.privateKey,
    )
    assert.equal(
      (await post(granted.url, apk, { Authorization: `Bearer ${otherDigest}` }))
        .status,
      400,
    )
    // The package must be the reservation's app.
    const wrongApp = signClaims(
      { ...claims, app: 'other.example.app' },
      c.master.master!.identity.privateKey,
    )
    const refused = await post(granted.url, apk, {
      Authorization: `Bearer ${wrongApp}`,
    })
    assert.equal(refused.status, 400)
    assert.match(
      String(((await refused.json()) as Json).error),
      /reservation’s app/,
    )
    // The right file publishes; a second upload to the same reservation is refused.
    const first = await post(granted.url, apk, {
      Authorization: `Bearer ${granted.grant}`,
    })
    assert.equal(first.status, 201, await first.clone().text())
    const differ = signClaims(
      { ...claims, digest: sha(dmg), size: dmg.length, format: 'dmg' as never },
      c.master.master!.identity.privateKey,
    )
    assert.equal(
      (await post(granted.url, dmg, { Authorization: `Bearer ${differ}` }))
        .status,
      409,
    )
    // A grant for a format the platform does not take, or with no reservation left.
    assert.throws(
      () =>
        master.artifacts.grant(
          { job, stage: 'ship', attempt: 9 },
          {
            app: APP,
            platform: 'android',
            format: 'dmg',
            digest: sha(dmg),
            size: 1,
            version: '1',
          },
        ),
      /published as apk/,
    )
    // The same file again is a retry; another file in that variant is
    // refused for the whole run; another variant takes the same reservation.
    const grantFor = (extra: Record<string, unknown>): Json =>
      master.artifacts.grant(
        { job, stage: 'ship', attempt: 9 },
        {
          app: APP,
          platform: 'android',
          format: 'apk',
          digest: sha(apk),
          size: apk.length,
          version: '1',
          ...extra,
        },
      )
    assert.equal(grantFor({}).reservation, granted.reservation)
    assert.throws(
      () => grantFor({ digest: sha(dmg), size: dmg.length }),
      /The default variant is already published for this run/,
    )
    assert.equal(
      grantFor({ variant: 'arm64-v8a' }).reservation,
      granted.reservation,
    )
    assert.throws(
      () => grantFor({ variant: '-bad' }),
      /A variant is 1 to 32 letters/,
    )
    // With a block of 1 the number is the reserved one, as before.
    assert.throws(
      () => grantFor({ variant: 'x', buildNumber: '43' }),
      /The build number 43 is not the reserved 42/,
    )
  })

  it('U12.5 the host has no Zealot upload API: publishing goes only through ctx.publish', async () => {
    for (const [method, route] of [
      ['POST', '/api/apps/upload?token=x&channel_key=y'],
      [
        'GET',
        '/api/apps/version_exist?token=x&channel_key=y&bundle_id=a&git_commit=b',
      ],
    ] as const) {
      const response = await fetch(host.web!.url + route, {
        method,
        dispatcher: insecure,
      } as RequestInit)
      assert.equal(response.status, 404, `${method} ${route}`)
    }
    // Nor does the master take one.
    assert.equal(
      (await c.api('POST', '/api/v2/keys', { name: 'zealot', role: 'upload' }))
        .status,
      400,
    )
  })

  it('U12.7 stages an upload by the stage token while the master is away and publishes it on reconnect', async () => {
    const master = c.master.master!
    const job = (
      db().prepare('SELECT id FROM jobs ORDER BY created LIMIT 1').get() as Json
    ).id
    const run9 = { job, stage: 'ship', attempt: 11, project: 1 }
    const reservations = master.artifacts.reserve(run9, [APP], { [APP]: '800' })
    const token = master.artifacts.uploadToken(run9, reservations, 60)!
    const mac = reservations.find((entry) => entry.platform === 'macos')!
    const post = async (
      reservation: string,
      headers: Record<string, string>,
    ): ReturnType<typeof pinnedFetch> =>
      await pinnedFetch(
        `${token.origin}/api/artifacts/${reservation}`,
        {
          method: 'POST',
          headers: {
            'X-Mason-Token': token.token,
            'X-Mason-Format': 'dmg',
            'X-Mason-Version': '3.0.0',
            ...headers,
          },
          body: dmg3,
        },
        token.pin,
      )
    await c.drop('host', 2000, async () => {
      await c.until(() => !host.host!.online(), 2000, 'offline')
      assert.equal(
        (await post(mac.id, { 'X-Mason-Build-Number': '801' })).status,
        400,
      )
      assert.equal(
        (await post('f'.repeat(32), { 'X-Mason-Build-Number': '800' })).status,
        403,
      )
      const staged = await post(mac.id, { 'X-Mason-Build-Number': '800' })
      assert.equal(staged.status, 202)
      assert.equal(((await staged.json()) as Json).staged, true)
      assert.equal(
        db().prepare("SELECT 1 FROM builds WHERE build_number='800'").get(),
        undefined,
      )
    })
    await c.until(
      () =>
        db().prepare("SELECT state FROM builds WHERE build_number='800'").get(),
      10_000,
      'the staged build published',
    )
    assert.equal(
      (
        db()
          .prepare(
            "SELECT build_id FROM build_publications WHERE reservation_id=? AND variant=''",
          )
          .get(mac.id) as Json
      ).build_id > 0,
      true,
    )
    // A stage whose own link drops publishes by token, and its record reaches the master once.
    const workerData = c.workers.get('w')!.dir
    const created = await c.api('POST', '/api/v2/runs', {
      project: 'ship',
      branch: 'master',
      params: { mode: 'dmg-wait' },
    })
    const id = created.json.id as string
    await c.until(
      () =>
        (c.master.master!.run(id) as Json).stages.some(
          (stage: Json) => stage.name === 'ship' && stage.status === 'running',
        ),
      30_000,
      'the stage running',
    )
    await c.drop('w', 4000, async () => {
      const workspace = path.join(workerData, 'checkouts', '0', 'ship')
      writeFileSync(path.join(workspace, 'go'), '')
      await c.until(
        () => c.workers.get('w')!.worker!.journal.runs('running').length === 0,
        20_000,
        'the stage finished offline',
      )
    })
    const done = await c
      .until(
        () => {
          const value = c.master.master!.run(id) as Json
          return value.status === 'succeeded' ? value : undefined
        },
        20_000,
        'the offline stage reported',
      )
      .catch((error: Error) => {
        throw new Error(
          `${error.message}\n${JSON.stringify(c.master.master!.run(id))}\n${c.master.master!.scheduler.logs(id) ?? ''}`,
        )
      })
    const log = c.master.master!.scheduler.logs(id)!
    assert.equal(
      log.match(/while the master was away/g)?.length ?? 0,
      output(done).buildId === 0 ? 1 : 0,
    )
    // With the host away too, the run can end before the host confirms the
    // staged upload; its reservation waits for the host.
    const late = (
      await c.api('POST', '/api/v2/runs', {
        project: 'ship',
        branch: 'master',
        params: { mode: 'dmg-late' },
      })
    ).json.id as string
    await c.until(
      () =>
        (c.master.master!.run(late) as Json).stages.some(
          (stage: Json) => stage.name === 'ship' && stage.status === 'running',
        ),
      30_000,
      'the late stage running',
    )
    await c.drop('host', 2000, async () => {
      await c.until(() => !host.host!.online(), 2000, 'the host offline')
      await c.drop('w', 2000, async () => {
        const workspace = path.join(workerData, 'checkouts', '0', 'ship')
        writeFileSync(path.join(workspace, 'late-go'), '')
        await c.until(
          () =>
            c.workers.get('w')!.worker!.journal.runs('running').length === 0,
          20_000,
          'the late stage finished offline',
        )
      })
      await c.until(
        () => (c.master.master!.run(late) as Json).status === 'succeeded',
        20_000,
        'the late run reported',
      )
      assert.deepEqual(
        db()
          .prepare(
            'SELECT p.build_id, p.staged_at IS NOT NULL staged FROM build_reservations r JOIN build_publications p ON p.reservation_id=r.id WHERE r.job_id=?',
          )
          .all(late)
          .map((row) => ({ ...row })),
        [{ build_id: null, staged: 1 }],
      )
    })
    await c.until(
      () =>
        (
          db()
            .prepare(
              'SELECT p.build_id FROM build_reservations r JOIN build_publications p ON p.reservation_id=r.id WHERE r.job_id=?',
            )
            .get(late) as Json
        ).build_id != null,
      10_000,
      'the host confirmed the staged build after the run ended',
    )
  })

  it('U12.16 a run publishes variants from parallel stages inside its block; a number past it is refused', async () => {
    // The run's N: one past the sequence's last number.
    const next = (): number =>
      Number(
        (
          db()
            .prepare('SELECT value FROM build_number_last WHERE key=?')
            .get(APP) as Json | undefined
        )?.value ?? 41,
      ) + 1
    const seed = (n: number): void => {
      for (const k of [0, 1, 2, 3]) {
        db()
          .prepare('DELETE FROM project_secrets WHERE name=?')
          .run(`APK_N${k}`)
        seedSecret(db(), 'ship', {
          name: `APK_N${k}`,
          kind: 'value',
          value: zip([
            ['AndroidManifest.xml', manifest(false, false, n + k)],
            ['pad.bin', Buffer.alloc(100 * (k + 1))],
          ]).toString('base64'),
        })
      }
    }
    const n = next()
    seed(n)
    const value = await run('variants')
    assert.equal(
      value.status,
      'succeeded',
      c.master.master!.scheduler.logs(value.id),
    )
    const rows = (
      db()
        .prepare(
          'SELECT variant,build_number,expires_at,size FROM builds WHERE run=? ORDER BY variant',
        )
        .all(value.id) as Json[]
    ).map((row) => ({ ...row }))
    assert.deepEqual(
      rows.map((row) => [row.variant, row.build_number]),
      [
        ['', String(n)],
        ['arm64-v8a', String(n + 2)],
        ['armeabi-v7a', String(n + 1)],
      ],
    )
    // One build: its variants expire together.
    assert.equal(new Set(rows.map((row) => row.expires_at)).size, 1)
    await c.until(
      () =>
        (
          host
            .host!.cache.db.prepare('SELECT COUNT(*) n FROM builds WHERE run=?')
            .get(value.id) as Json
        ).n === 3,
      5000,
      'the variants on the host',
    )
    // The next run's block starts after this one's; a variant past it is refused.
    const m = next()
    assert.equal(m, n + 3)
    seed(m)
    const outside = await run('variants-outside')
    assert.equal(outside.status, 'failed')
    assert.match(
      c.master.master!.scheduler.logs(outside.id)!,
      new RegExp(`${m + 3} is outside the run's block ${m}–${m + 2}`),
    )
  })

  it('U12.17 the host stages each variant by token, refuses another file in one, and drops a staged file the master refuses', async () => {
    const master = c.master.master!
    // A run of its own, so its builds are this test's alone.
    const job = (await run('apk')).id as string
    // Two stages of one run, each with its own Android reservation.
    const runA = { job, stage: 'a', attempt: 1, project: 1 }
    const runB = { job, stage: 'b', attempt: 1, project: 1 }
    const pick = (list: Json[]): Json =>
      list.find((entry) => entry.platform === 'android')
    const a = pick(
      master.artifacts.reserve(runA, [APP], { [APP]: '900' }, { [APP]: 3 }),
    )
    const b = pick(
      master.artifacts.reserve(runB, [APP], { [APP]: '900' }, { [APP]: 3 }),
    )
    assert.equal(a.block, 3)
    const tokenA = master.artifacts.uploadToken(runA, [a], 60)!
    const tokenB = master.artifacts.uploadToken(runB, [b], 60)!
    const apkAt = (code: number, pad = 0): Buffer =>
      zip([
        ['AndroidManifest.xml', manifest(false, false, code)],
        ['pad.bin', Buffer.alloc(pad)],
      ])
    const post = async (
      token: Json,
      reservation: string,
      body: Buffer,
      headers: Record<string, string>,
    ): ReturnType<typeof pinnedFetch> =>
      await pinnedFetch(
        `${token.origin}/api/artifacts/${reservation}`,
        {
          method: 'POST',
          headers: {
            'X-Mason-Token': token.token,
            'X-Mason-Format': 'apk',
            'X-Mason-Version': '1.2.3',
            ...headers,
          },
          body,
        },
        token.pin,
      )
    await c.drop('host', 2000, async () => {
      await c.until(() => !host.host!.online(), 2000, 'offline')
      const staged = await post(tokenA, a.id, apkAt(902), {
        'X-Mason-Build-Number': '902',
        'X-Mason-Variant': 'arm64-v8a',
      })
      assert.equal(staged.status, 202, await staged.clone().text())
      // Past the block, a bad name, or another file in that variant.
      assert.equal(
        (
          await post(tokenA, a.id, apkAt(903), {
            'X-Mason-Build-Number': '903',
            'X-Mason-Variant': 'arm64-v8a',
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await post(tokenA, a.id, apkAt(902), {
            'X-Mason-Build-Number': '902',
            'X-Mason-Variant': '..',
          })
        ).status,
        400,
      )
      const other = await post(tokenA, a.id, apkAt(902, 10), {
        'X-Mason-Build-Number': '902',
        'X-Mason-Variant': 'arm64-v8a',
      })
      assert.equal(other.status, 409)
      assert.match(
        String(((await other.json()) as Json).error),
        /arm64-v8a is already published for this run/,
      )
    })
    await c.until(
      () =>
        db()
          .prepare(
            "SELECT 1 FROM builds WHERE run=? AND variant='arm64-v8a' AND build_number='902'",
          )
          .get(job),
      10_000,
      'the staged variant published',
    )
    // Another stage of the run publishes the same variant with another file:
    // the master refuses, and the host drops what it staged.
    const refused = await post(tokenB, b.id, apkAt(902, 20), {
      'X-Mason-Build-Number': '902',
      'X-Mason-Variant': 'arm64-v8a',
    })
    assert.equal(refused.status, 409)
    assert.match(
      String(((await refused.json()) as Json).error),
      /arm64-v8a is already published for this run/,
    )
    const cache = host.host!.cache.db
    assert.equal(
      cache.prepare('SELECT 1 FROM host_staged WHERE reservation=?').get(b.id),
      undefined,
    )
    assert.equal(
      await host.host!.objects.head(
        `${b.id}-arm64-v8a-${sha(apkAt(902, 20)).slice(0, 16)}.apk`,
      ),
      undefined,
    )
    // The variant's published file, under its own digest's key, stays.
    assert.notEqual(
      await host.host!.objects.head(
        `${a.id}-arm64-v8a-${sha(apkAt(902)).slice(0, 16)}.apk`,
      ),
      undefined,
    )
    // A staged confirm the master refuses for good, through the outbox, is
    // dropped too, when that upload stored its file.
    // A queued confirmation of a staged file, and the record its upload made.
    const stagedFile = (
      reservation: string,
      variant: string,
      fileKey: string,
      fresh: boolean,
      stagedAt?: number,
    ): Json => {
      if (stagedAt != null)
        host
          .host!.cache.db.prepare(
            'INSERT OR REPLACE INTO host_staged(reservation,variant,digest,staged_at) VALUES(?,?,?,?)',
          )
          .run(reservation, variant, sha(apkAt(1)), stagedAt)
      return {
        action: 'staged',
        reservation,
        variant,
        fileKey,
        staged: {
          reservation,
          variant,
          digest: sha(apkAt(1)),
          fileKey,
          fresh,
          ...(stagedAt == null ? {} : { stagedAt }),
        },
      }
    }
    const lost = `${'e'.repeat(32)}-lost.apk`
    const file = path.join(host.dir, 'lost.apk')
    writeFileSync(file, apkAt(1))
    await host.host!.objects.put(lost, file, sha(apkAt(1)))
    host.host!.outbox.enqueue(
      'artifact',
      stagedFile('e'.repeat(32), 'lost', lost, true, 1),
    )
    for (let attempt = 0; attempt < 4; attempt++)
      await host.host!.outbox.flush(host.host!.options.link())
    for (let wait = 0; (await host.host!.objects.head(lost)) != null; wait++) {
      assert(wait < 200, 'the refused file was not dropped')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    // A fresh upload's refusal keeps its file while a repeat of it still
    // waits in the outbox for its own confirmation.
    const shared = `${'a'.repeat(32)}-shared-${sha(apkAt(1)).slice(0, 16)}.apk`
    await host.host!.objects.put(shared, file, sha(apkAt(1)))
    host.host!.outbox.enqueue(
      'artifact',
      stagedFile('a'.repeat(32), 'shared', shared, true, 2),
    )
    host.host!.outbox.enqueue(
      'artifact',
      stagedFile('a'.repeat(32), 'shared', shared, false),
    )
    for (let attempt = 0; attempt < 3; attempt++)
      await host.host!.outbox.flush(host.host!.options.link())
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.notEqual(await host.host!.objects.head(shared), undefined)
    // Nor while a repeat sent straight to the master has recorded the file
    // anew, before its build reaches the host.
    const direct = `${'b'.repeat(32)}-direct-${sha(apkAt(1)).slice(0, 16)}.apk`
    await host.host!.objects.put(direct, file, sha(apkAt(1)))
    host.host!.outbox.enqueue(
      'artifact',
      stagedFile('b'.repeat(32), 'direct', direct, true, 3),
    )
    host
      .host!.cache.db.prepare(
        "UPDATE host_staged SET staged_at=4 WHERE reservation=? AND variant='direct'",
      )
      .run('b'.repeat(32))
    // A set-aside payload that does not clean deletes nothing.
    const kept = `${'f'.repeat(32)}-kept.apk`
    await host.host!.objects.put(kept, file, sha(apkAt(1)))
    const escape = host.host!.outbox.enqueue('artifact', {
      ...stagedFile('f'.repeat(32), 'kept', kept, true),
      staged: { reservation: 'f'.repeat(32), variant: '..', fileKey: kept },
    })
    // The shared repeat and the direct upload's message ahead of it are
    // refused too, without deleting either file.
    for (let attempt = 0; attempt < 12; attempt++)
      await host.host!.outbox.flush(host.host!.options.link())
    assert(host.host!.outbox.refused().some((entry) => entry.id === escape))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.notEqual(await host.host!.objects.head(shared), undefined)
    assert.notEqual(await host.host!.objects.head(direct), undefined)
    assert.equal(
      (
        host
          .host!.cache.db.prepare(
            "SELECT staged_at FROM host_staged WHERE reservation=? AND variant='direct'",
          )
          .get('b'.repeat(32)) as Json
      ).staged_at,
      4,
    )
    assert.notEqual(await host.host!.objects.head(kept), undefined)
  })

  it('U12.18 a confirmation with no answer or a failure keeps its file; a refusal frees its variant; a repeat never deletes a published file', async () => {
    const master = c.master.master!
    const job = (await run('apk')).id as string
    const runC = { job, stage: 'c', attempt: 1, project: 1 }
    const reservations = master.artifacts.reserve(
      runC,
      [APP],
      { [APP]: '950' },
      { [APP]: 3 },
    )
    const c1 = reservations.find((entry: Json) => entry.platform === 'android')!
    const mac = reservations.find((entry: Json) => entry.platform === 'macos')!
    const token = master.artifacts.uploadToken(runC, reservations, 60)!
    const apk950 = zip([['AndroidManifest.xml', manifest(false, false, 950)]])
    const post = async (
      using: Json,
      reservation: string,
      body: Buffer,
      headers: Record<string, string>,
    ): ReturnType<typeof pinnedFetch> =>
      await pinnedFetch(
        `${using.origin}/api/artifacts/${reservation}`,
        {
          method: 'POST',
          headers: {
            'X-Mason-Token': using.token,
            'X-Mason-Version': '1.2.3',
            ...headers,
          },
          body,
        },
        using.pin,
      )
    const keyOf = (name: string, body: Buffer, format: string): string =>
      `${name}-${sha(body).slice(0, 16)}.${format}`
    // The master's answer to the confirmation never comes (a timeout), or it
    // fails (a busy database): the host keeps the file and its outbox settles it.
    const options = host.host!.options as { link: () => Json }
    const realLink = options.link
    const answering = async (
      error: LinkError,
      send: () => ReturnType<typeof pinnedFetch>,
    ): ReturnType<typeof pinnedFetch> => {
      options.link = (): Json => {
        const link = realLink()
        return link == null
          ? undefined
          : {
              get closed(): boolean {
                return link.closed as boolean
              },
              request: async (method: string, params: unknown) =>
                method === 'artifacts.staged'
                  ? await Promise.reject(error)
                  : await link.request(method, params),
            }
      }
      try {
        return await send()
      } finally {
        options.link = realLink
      }
    }
    const slow = await answering(
      new LinkError('The request timed out', 'timeout'),
      async () =>
        await post(token, c1.id, apk950, {
          'X-Mason-Format': 'apk',
          'X-Mason-Build-Number': '950',
        }),
    )
    assert.equal(slow.status, 202, await slow.clone().text())
    const busy = await answering(
      new LinkError('database is locked', 'failed'),
      async () =>
        await post(token, c1.id, apk950, {
          'X-Mason-Format': 'apk',
          'X-Mason-Build-Number': '950',
          'X-Mason-Variant': 'busy',
        }),
    )
    assert.equal(busy.status, 202, await busy.clone().text())
    const key = keyOf(c1.id, apk950, 'apk')
    const busyKey = keyOf(`${c1.id}-busy`, apk950, 'apk')
    for (const stored of [key, busyKey])
      assert.notEqual(await host.host!.objects.head(stored), undefined)
    await c.until(
      () =>
        db()
          .prepare(
            "SELECT COUNT(*) n FROM builds WHERE run=? AND variant IN ('','busy')",
          )
          .get(job)!.n === 2 || undefined,
      10_000,
      'both confirmations delivered by the outbox',
    )
    // A grant for that same file under another number in the block is
    // refused, and so is another file from the stage's second attempt.
    assert.throws(
      () =>
        master.artifacts.grant(runC, {
          app: APP,
          platform: 'android',
          format: 'apk',
          digest: sha(apk950),
          size: apk950.length,
          version: '1.2.3',
          buildNumber: '951',
        }),
      /The default variant is already published for this run/,
    )
    const runC2 = { ...runC, attempt: 2 }
    const retried = master.artifacts.reserve(
      runC2,
      [APP],
      { [APP]: '950' },
      { [APP]: 3 },
    )
    const c2 = retried.find((entry: Json) => entry.platform === 'android')!
    assert.throws(
      () =>
        master.artifacts.grant(runC2, {
          app: APP,
          platform: 'android',
          format: 'apk',
          digest: sha(Buffer.from('another file')),
          size: 10,
          version: '1.2.3',
        }),
      /The default variant is already published for this run/,
    )
    // The retry sends its run's published file again: that build answers,
    // and the host stores nothing more.
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM builds WHERE file_key=?')
          .get(key),
      10_000,
      'the build on the host',
    )
    const again = await post(
      master.artifacts.uploadToken(runC2, retried, 60)!,
      c2.id,
      apk950,
      { 'X-Mason-Format': 'apk', 'X-Mason-Build-Number': '950' },
    )
    assert.equal(again.status, 201, await again.clone().text())
    assert.equal(
      await host.host!.objects.head(keyOf(c2.id, apk950, 'apk')),
      undefined,
    )
    // A desktop file published as 950, then sent again as 951: the master
    // refuses the repeat, and the published file and its record stay.
    const desktop = { 'X-Mason-Format': 'dmg' }
    const first = await post(token, mac.id, dmg, {
      ...desktop,
      'X-Mason-Build-Number': '950',
      'X-Mason-Variant': 'mac',
    })
    assert.equal(first.status, 201, await first.clone().text())
    const repeat = await post(token, mac.id, dmg, {
      ...desktop,
      'X-Mason-Build-Number': '951',
      'X-Mason-Variant': 'mac',
    })
    assert.equal(repeat.status, 409)
    assert.match(
      String(((await repeat.json()) as Json).error),
      /mac is already published for this run/,
    )
    const dmgKey = keyOf(`${mac.id}-mac`, dmg, 'dmg')
    assert.notEqual(await host.host!.objects.head(dmgKey), undefined)
    assert.notEqual(
      host
        .host!.cache.db.prepare(
          "SELECT 1 FROM host_staged WHERE reservation=? AND variant='mac'",
        )
        .get(mac.id),
      undefined,
    )
    // The published variant stays the run's: its record keeps its digest and
    // build, and another file for it is still refused.
    const macRecord = db()
      .prepare(
        "SELECT digest,build_id FROM build_publications WHERE reservation_id=? AND variant='mac'",
      )
      .get(mac.id) as Json
    assert.equal(macRecord.digest, sha(dmg))
    assert.notEqual(macRecord.build_id, null)
    assert.throws(
      () =>
        master.artifacts.grant(runC, {
          app: APP,
          platform: 'macos',
          format: 'dmg',
          digest: sha(dmg3),
          size: dmg3.length,
          version: '1.2.3',
          variant: 'mac',
        }),
      /mac is already published for this run/,
    )
    // Two uploads of one file for one variant at once, as N and N+1: one
    // publishes, the other is refused, and the published file stays.
    const pair = Buffer.from(dmg)
    pair[18] = (pair[18]! + 1) % 256
    const twins = await Promise.all(
      ['950', '951'].map(
        async (number) =>
          await post(token, mac.id, pair, {
            ...desktop,
            'X-Mason-Build-Number': number,
            'X-Mason-Variant': 'pair',
          }),
      ),
    )
    assert.deepEqual(twins.map((answer) => answer.status).sort(), [201, 409])
    assert.notEqual(
      await host.host!.objects.head(keyOf(`${mac.id}-pair`, pair, 'dmg')),
      undefined,
    )
    assert.notEqual(
      host
        .host!.cache.db.prepare(
          "SELECT 1 FROM host_staged WHERE reservation=? AND variant='pair'",
        )
        .get(mac.id),
      undefined,
    )
    // A failure inside the store's check (a corrupt channel row) is not a
    // refusal: the host keeps the file for its outbox, and it publishes once
    // the master is well again.
    const flaky = Buffer.from(dmg)
    flaky[19] = (flaky[19]! + 1) % 256
    const channel = db()
      .prepare(
        "SELECT c.id,c.formats FROM channels c JOIN apps a ON a.id=c.app_id WHERE a.slug=? AND c.platform='macos'",
      )
      .get(APP) as Json
    db()
      .prepare("UPDATE channels SET formats='not json' WHERE id=?")
      .run(channel.id)
    let failing
    try {
      failing = await post(token, mac.id, flaky, {
        ...desktop,
        'X-Mason-Build-Number': '950',
        'X-Mason-Variant': 'flaky',
      })
    } finally {
      db()
        .prepare('UPDATE channels SET formats=? WHERE id=?')
        .run(channel.formats, channel.id)
    }
    assert.equal(failing.status, 202, await failing.clone().text())
    const flakyKey = keyOf(`${mac.id}-flaky`, flaky, 'dmg')
    assert.notEqual(await host.host!.objects.head(flakyKey), undefined)
    await host.host!.outbox.flush(host.host!.options.link())
    await c.until(
      () =>
        db()
          .prepare("SELECT 1 FROM builds WHERE run=? AND variant='flaky'")
          .get(job),
      10_000,
      'the flaky publication delivered',
    )
    // The same repeat through the outbox, set aside after its refusals,
    // deletes nothing either: that upload did not store the file.
    host.host!.outbox.enqueue('artifact', {
      action: 'staged',
      reservation: mac.id,
      variant: 'mac',
      digest: sha(dmg),
      size: dmg.length,
      format: 'dmg',
      version: '1.2.3',
      buildNumber: '951',
      bundleId: APP,
      fileKey: dmgKey,
      staged: {
        reservation: mac.id,
        variant: 'mac',
        digest: sha(dmg),
        fileKey: dmgKey,
        fresh: false,
      },
    })
    for (let attempt = 0; attempt < 4; attempt++)
      await host.host!.outbox.flush(host.host!.options.link())
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.notEqual(await host.host!.objects.head(dmgKey), undefined)
    // An offline stage's journal reserved a variant; the host's confirmation
    // of it is refused (past the block) through the outbox delivery, so the
    // variant is free again; so is a record from before digests were kept.
    const confirmation = (variant: string, buildNumber: string): Json => ({
      action: 'staged',
      reservation: mac.id,
      variant,
      digest: sha(dmg2),
      size: dmg2.length,
      format: 'dmg',
      version: '1.2.3',
      buildNumber,
      bundleId: APP,
      fileKey: keyOf(`${mac.id}-${variant}`, dmg2, 'dmg'),
    })
    master.artifacts.markStaged(job, mac.id, 'x64', sha(dmg2))
    db()
      .prepare(
        "INSERT INTO build_publications(reservation_id,variant,staged_at) VALUES(?,'old',1),(?,'older',1)",
      )
      .run(mac.id, mac.id)
    const record = (variant: string): Json =>
      db()
        .prepare(
          'SELECT digest,build_id FROM build_publications WHERE reservation_id=? AND variant=?',
        )
        .get(mac.id, variant)
    for (const variant of ['x64', 'old'])
      assert.throws(
        () =>
          master.hosts.deliver(
            {
              id: `refused-${variant}`,
              kind: 'artifact',
              payload: confirmation(variant, '999'),
            },
            c.fingerprint('host'),
          ),
        (error: LinkError) =>
          error.code === 'refused' &&
          /outside the run's block 950–952/.test(error.message),
      )
    assert.equal(record('x64'), undefined)
    assert.equal(record('old'), undefined)
    // A record from before digests confirms normally and gains its build.
    master.hosts.deliver(
      {
        id: 'confirmed-older',
        kind: 'artifact',
        payload: confirmation('older', '952'),
      },
      c.fingerprint('host'),
    )
    assert.equal(record('older').digest, sha(dmg2))
    assert.notEqual(record('older').build_id, null)
    const granted = master.artifacts.grant(runC, {
      app: APP,
      platform: 'macos',
      format: 'dmg',
      digest: sha(dmg3),
      size: dmg3.length,
      version: '1.2.3',
      variant: 'x64',
    })
    assert.equal(granted.reservation, mac.id)
    // The store's own refusal is final too: another run sends this run's
    // published desktop file for the same variant under its own number.
    const job2 = (await run('apk')).id as string
    const runD = { job: job2, stage: 'd', attempt: 1, project: 1 }
    const later = master.artifacts.reserve(runD, [APP], { [APP]: '960' })
    const mac2 = later.find((entry: Json) => entry.platform === 'macos')!
    const conflicting = await post(
      master.artifacts.uploadToken(runD, later, 60)!,
      mac2.id,
      dmg,
      { ...desktop, 'X-Mason-Build-Number': '960', 'X-Mason-Variant': 'mac' },
    )
    assert.equal(conflicting.status, 409)
    assert.match(
      String(((await conflicting.json()) as Json).error),
      /Build publication conflict/,
    )
    master.artifacts.markStaged(job2, mac2.id, 'mac', sha(dmg))
    assert.throws(
      () =>
        master.hosts.deliver(
          {
            id: 'conflict-mac',
            kind: 'artifact',
            payload: {
              action: 'staged',
              reservation: mac2.id,
              variant: 'mac',
              digest: sha(dmg),
              size: dmg.length,
              format: 'dmg',
              version: '1.2.3',
              buildNumber: '960',
              bundleId: APP,
              fileKey: keyOf(`${mac2.id}-mac`, dmg, 'dmg'),
            },
          },
          c.fingerprint('host'),
        ),
      (error: LinkError) =>
        error.code === 'refused' &&
        error.message === 'Build publication conflict',
    )
    assert.equal(
      db()
        .prepare(
          "SELECT 1 FROM build_publications WHERE reservation_id=? AND variant='mac'",
        )
        .get(mac2.id),
      undefined,
    )
    // A finished run keeps its reservations with publications and drops
    // the retry's, which published nothing of its own.
    master.artifacts.release(job)
    const kept = db()
      .prepare('SELECT id FROM build_reservations WHERE job_id=?')
      .all(job)
      .map((row: Json) => row.id)
    assert(kept.includes(c1.id) && kept.includes(mac.id), String(kept))
    assert(!kept.includes(c2.id))
  })

  it('U12.8/U12.9/U12.11 saves artifacts and test results; testers see only what is visible to them; reports open sandboxed', async () => {
    const value = await run('save')
    assert.equal(
      value.status,
      'unstable',
      c.master.master!.scheduler.logs(value.id),
    )
    assert.deepEqual(
      value.tests.map((entry: Json) => [
        entry.stage,
        entry.passed,
        entry.failed,
      ]),
      [['ship', 1, 1]],
    )
    assert.deepEqual(
      value.artifacts.map((entry: Json) => [
        entry.name,
        entry.kind,
        entry.visibleTo ?? null,
      ]),
      [
        ['report', 'report', null],
        ['results', 'file', 'testers'],
      ],
    )
    const api = await c.api('GET', `/api/v2/runs/${value.id}`)
    assert.equal(api.status, 200)
    assert.equal(api.json.tests[0].failures[0].message, 'boom')
    const strict = await run('strict')
    assert.equal(strict.status, 'failed')
    // Another run's token, a bad name.
    const master = c.master.master!
    const otherToken = master.artifacts.uploadToken(
      { job: strict.id, stage: 'ship', attempt: 1, project: 1 },
      [],
      60,
    )!
    const save = async (
      runId: string,
      name: string,
      token = otherToken.token,
    ): Promise<number> =>
      (
        await pinnedFetch(
          `${otherToken.origin}/api/runs/${runId}/artifacts/${name}`,
          {
            method: 'POST',
            headers: { 'X-Mason-Token': token },
            body: Buffer.from('x'),
          },
          otherToken.pin,
        )
      ).status
    assert.equal(await save(value.id, 'stolen'), 403)
    assert.equal(await save(strict.id, '..bad'), 400)
    assert.equal(await save(strict.id, 'ok', 'garbage'), 401)
    // Sessions: a tester sees only `visibleTo: testers`; developers see all; the report is sandboxed.
    const cache = host.host!.cache
    const now = Date.now()
    master.database.db.exec(
      `INSERT INTO accounts(id,name,role,permission_version,created_at) VALUES(50,'T','tester',1,${now}),(51,'D','developer',1,${now})`,
    )
    master.database.change('account', 50)
    master.database.change('account', 51)
    await c.until(
      () => cache.db.prepare('SELECT 1 FROM accounts WHERE id=51').get(),
      2000,
      'accounts on the host',
    )
    const session = (id: number): string =>
      host.host!.accounts.startSession(id).token
    const get = async (url: string, id: number): Promise<Response> =>
      await fetch(`${host.web!.url}${url}`, {
        headers: { cookie: `__Host-mason-session=${session(id)}` },
        // @ts-expect-error undici's dispatcher option
        dispatcher: insecure,
      })
    assert.deepEqual(
      (
        (await (
          await get(`/api/runs/${value.id}/artifacts`, 50)
        ).json()) as Json[]
      ).map((row) => row.name),
      ['results'],
    )
    assert.deepEqual(
      (
        (await (
          await get(`/api/runs/${value.id}/artifacts`, 51)
        ).json()) as Json[]
      ).map((row) => row.name),
      ['report', 'results'],
    )
    assert.equal(
      (await get(`/runs/${value.id}/artifacts/report`, 50)).status,
      404,
    )
    const tarball = await get(`/runs/${value.id}/artifacts/results`, 50)
    assert.equal(tarball.status, 200, await tarball.clone().text())
    const report = await get(`/runs/${value.id}/artifacts/report/view`, 51)
    assert.equal(report.status, 200)
    assert.match(await report.text(), /Report/)
    assert.match(report.headers.get('content-security-policy')!, /^sandbox;/)
    assert.doesNotMatch(
      report.headers.get('content-security-policy')!,
      /allow-same-origin/,
    )
    assert.equal(
      (await get(`/runs/${value.id}/artifacts/report/view/../../etc`, 51))
        .status,
      404,
    )
    assert.equal(
      (await get(`/runs/${value.id}/artifacts/results/view`, 51)).status,
      404,
    )
    assert.equal(
      (
        await fetch(`${host.web!.url}/api/runs/${value.id}/artifacts`, {
          // @ts-expect-error undici's dispatcher option
          dispatcher: insecure,
        })
      ).status,
      401,
    )
    // Saved artifacts sit beside the flat build files, which the store
    // still counts for upload capacity and prunes.
    assert(
      existsSync(
        path.join(host.dir, 'storage', 'runs', value.id, 'report', 'files'),
      ),
    )
    assert.equal(typeof cache.store.usage(), 'number')
    assert.doesNotThrow(() => cache.store.prune())
  })

  it('U12.14 fetches the latest matching run’s artifact by grant, checking its digest, within the project only', async () => {
    const value = await run('fetch')
    assert.equal(
      value.status,
      'succeeded',
      c.master.master!.scheduler.logs(value.id),
    )
    assert.deepEqual(
      output(value).map((file: string) => path.basename(file)),
      ['results.xml'],
    )
    const missing = await run('missing')
    assert.equal(missing.status, 'failed')
    assert.match(
      c.master.master!.scheduler.logs(missing.id)!,
      /No run matches .*nothing/,
    )
    const elsewhere = await run('fetch', 'other')
    assert.equal(elsewhere.status, 'failed')
    // A stored file that no longer matches fails the fetch.
    const stored = host
      .host!.cache.db.prepare(
        "SELECT storage_key FROM host_artifacts WHERE name='results' ORDER BY created_at DESC",
      )
      .get() as Json
    writeFileSync(
      path.join(host.dir, 'storage', stored.storage_key),
      'tampered',
    )
    const tampered = await run('fetch')
    assert.equal(tampered.status, 'failed')
    assert.match(
      c.master.master!.scheduler.logs(tampered.id)!,
      /does not match its digest/,
    )
  })

  it('U12.12 validates the storage area, keeps its secret write-only, and reads each object from where it was stored', async () => {
    const settings = c.master.master!.settings
    await assert.rejects(
      settings.set(admin, 'storage', { driver: 'ftp' }),
      /disk or s3/,
    )
    await assert.rejects(
      settings.set(admin, 'storage', {
        driver: 's3',
        s3: {
          endpoint: 'http://x.example',
          bucket: 'b-1',
          region: 'nyc3',
          accessKeyId: 'AKIAFAKE1234',
          secretAccessKey: 'secret-value-1',
        },
      }),
      /HTTPS/,
    )
    await assert.rejects(
      settings.set(admin, 'storage', {
        driver: 's3',
        s3: {
          endpoint: 'https://x.example',
          region: 'nyc3',
          accessKeyId: 'AKIAFAKE1234',
          secretAccessKey: 'secret-value-1',
        },
      }),
      /bucket/,
    )
    const endpoint = s3.endpoint.replace(/^http:/, 'https:')
    await settings.set(admin, 'storage', {
      driver: 's3',
      s3: {
        endpoint,
        bucket: 'mason-artifacts',
        region: 'nyc3',
        accessKeyId: 'AKIAFAKE1234',
        secretAccessKey: 'fake-secret-value-1234',
      },
    })
    assert.deepEqual(
      (settings.get(admin, 'storage') as Json).s3.secretAccessKey,
      { set: true },
    )
    await settings.set(admin, 'storage', {
      driver: 's3',
      s3: {
        endpoint,
        bucket: 'mason-artifacts',
        region: 'nyc3',
        accessKeyId: 'AKIAFAKE1234',
        secretAccessKey: { keep: true },
      },
    })
    await c.until(
      () => host.host!.cache.setting<Json>('storage')?.driver === 's3',
      2000,
      'the setting on the host',
    )
    const value = await run('save')
    assert.equal(value.status, 'unstable')
    assert(
      [...s3.objects.keys()].some((key) =>
        key.includes(`runs/${value.id}/results.tar.gz`),
      ),
      [...s3.objects.keys()].join(' '),
    )
    // The earlier disk build still downloads; the new artifact comes from S3.
    const developer = host.host!.accounts.startSession(51).token
    const download = await fetch(
      `${host.web!.url}/runs/${value.id}/artifacts/results`,
      {
        headers: { cookie: `__Host-mason-session=${developer}` },
        // @ts-expect-error undici's dispatcher option
        dispatcher: insecure,
      },
    )
    assert.equal(download.status, 200)
    assert(existsSync(path.join(host.dir, 'storage', 'files')))
    // The change log names the area only; the secret travels in the host's projection, to the host alone.
    assert(
      !JSON.stringify(db().prepare('SELECT * FROM change_log').all()).includes(
        'fake-secret-value-1234',
      ),
    )
    assert(
      !JSON.stringify(c.master.master!.settings.get(admin, 'storage')).includes(
        'fake-secret-value-1234',
      ),
    )
    // Another bucket: new artifacts go there, and the earlier one is still
    // read from the bucket it was written to.
    const second = new FakeS3({
      bucket: 'mason-artifacts-2',
      region: 'nyc3',
      accessKeyId: 'AKIAFAKE5678',
      secretAccessKey: 'fake-secret-value-5678',
    })
    await second.start()
    try {
      await settings.set(admin, 'storage', {
        driver: 's3',
        s3: {
          endpoint: second.endpoint.replace(/^http:/, 'https:'),
          bucket: 'mason-artifacts-2',
          region: 'nyc3',
          accessKeyId: 'AKIAFAKE5678',
          secretAccessKey: 'fake-secret-value-5678',
        },
      })
      await c.until(
        () =>
          host.host!.cache.setting<Json>('storage')?.s3?.bucket ===
          'mason-artifacts-2',
        2000,
        'the second bucket on the host',
      )
      const later = await run('save')
      assert(
        [...second.objects.keys()].some((key) =>
          key.includes(`runs/${later.id}/results.tar.gz`),
        ),
      )
      for (const id of [value.id, later.id]) {
        const response = await fetch(
          `${host.web!.url}/runs/${id}/artifacts/results`,
          {
            headers: { cookie: `__Host-mason-session=${developer}` },
            // @ts-expect-error undici's dispatcher option
            dispatcher: insecure,
          },
        )
        assert.equal(response.status, 200, id)
        await response.arrayBuffer()
      }
    } finally {
      await second.close()
    }
    await settings.set(admin, 'storage', { driver: 'disk' })
  })

  it('U12.15 expires builds and saved artifacts: the host deletes the files and confirms once, also after being offline', async () => {
    const master = c.master.master!
    const build = db()
      .prepare(
        "SELECT id,file_key FROM builds WHERE state='ready' ORDER BY id LIMIT 1",
      )
      .get() as Json
    db()
      .prepare('UPDATE builds SET expires_at=? WHERE id=?')
      .run(Date.now() - 1000, build.id)
    await c.drop('host', 1500, async () => {
      await c.until(() => !host.host!.online(), 2000, 'offline')
      assert.equal(master.expire().builds, 1)
      assert.equal(
        (
          db()
            .prepare('SELECT state FROM builds WHERE id=?')
            .get(build.id) as Json
        ).state,
        'deleting',
      )
    })
    await c.until(
      () =>
        (
          db()
            .prepare('SELECT state FROM builds WHERE id=?')
            .get(build.id) as Json
        ).state === 'deleted',
      10_000,
      'the build deleted',
    )
    assert(!existsSync(path.join(host.dir, 'storage', 'files', build.file_key)))
    const receipts = db()
      .prepare(
        "SELECT COUNT(*) n FROM host_receipts WHERE kind='artifact' AND payload LIKE ?",
      )
      .get(`%"build":${build.id}%`) as Json
    assert.equal(receipts.n, 1)
    // A saved artifact past keep.artifactDays goes the same way.
    const artifact = db()
      .prepare(
        'SELECT job_id,name FROM run_artifacts ORDER BY created_at LIMIT 1',
      )
      .get() as Json
    db()
      .prepare(
        'UPDATE run_artifacts SET created_at=0 WHERE job_id=? AND name=?',
      )
      .run(artifact.job_id, artifact.name)
    assert(master.expire().artifacts >= 1)
    await c.until(
      () =>
        db()
          .prepare('SELECT 1 FROM run_artifacts WHERE job_id=? AND name=?')
          .get(artifact.job_id, artifact.name) == null,
      10_000,
      'the artifact deleted',
    )
    assert.equal(
      host
        .host!.cache.db.prepare(
          'SELECT 1 FROM host_artifacts WHERE run=? AND name=?',
        )
        .get(artifact.job_id, artifact.name),
      undefined,
    )
  })
})
