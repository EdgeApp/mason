import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { Agent } from 'undici'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { FakeS3 } from '../test/fakeS3.js'
import { desktop, manifest, zip } from '../upload/fixtures.test.js'
import { signClaims, verifyClaims, type GrantClaims } from './artifacts.js'
import { seedLegacySecrets } from '../test/secrets.js'

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
  m.buildNumber('${APP}', { start: 42 })
  m.workflow('build', { params: { mode: { type: 'string', default: 'apk' } }, keep: { artifactDays: 3 } }, () => {})
  m.stage('ship', { on: {}, publishes: ['${APP}'], secrets: ['FIXTURE_APK', 'FIXTURE_DMG'], run: ship })
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
          'SELECT platform,build_number,build_id FROM build_reservations WHERE job_id=?',
        )
        .all(value.id) as Json[]
    ).map((row) => ({ ...row }))
    // The unused macOS reservation went with the run's end.
    assert.deepEqual(reservations, [
      { platform: 'android', build_number: '42', build_id: result.buildId },
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
    assert.throws(
      () =>
        master.artifacts.grant(
          { job, stage: 'ship', attempt: 9 },
          {
            app: APP,
            platform: 'android',
            format: 'apk',
            digest: sha(apk),
            size: apk.length,
            version: '1',
          },
        ),
      /no android reservation/,
    )
  })

  it('U12.5/U12.6 publishes Zealot uploads through the master, conflicts on a duplicate number, and answers 503 offline', async () => {
    const master = c.master.master!
    const appId = (
      db().prepare('SELECT id FROM apps WHERE slug=?').get(APP) as Json
    ).id
    const key = master.keys.create(admin, {
      role: 'upload',
      apps: [appId],
      name: 'zealot',
    })
    master.database.change('api_key', key.id)
    const channelKey = (
      db()
        .prepare(
          "SELECT channel_key FROM channels WHERE app_id=? AND platform='macos'",
        )
        .get(appId) as Json
    ).channel_key
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM api_keys WHERE id=?')
          .get(key.id),
      2000,
      'the key on the host',
    )
    const upload = async (file: Buffer, build: string): Promise<Response> => {
      const form = new FormData()
      form.set('token', key.token)
      form.set('channel_key', channelKey)
      form.set('branch', 'release')
      form.set('git_commit', 'a'.repeat(40))
      form.set(
        'custom_fields',
        JSON.stringify({
          mason: { bundleId: APP, version: '2.0.0', buildNumber: build },
        }),
      )
      form.set('file', new Blob([new Uint8Array(file)]), 'app.dmg')
      return await fetch(`${host.web!.url}/api/apps/upload`, {
        method: 'POST',
        body: form,
        // @ts-expect-error undici's dispatcher option
        dispatcher: insecure,
      })
    }
    const ok = await upload(dmg, '700')
    assert.equal(ok.status, 201, await ok.clone().text())
    const published = db()
      .prepare(
        "SELECT * FROM builds WHERE branch='release' AND build_number='700'",
      )
      .get() as Json
    assert.equal(published.state, 'ready')
    assert.equal((await upload(dmg2, '700')).status, 409)
    const exists = await fetch(
      `${host.web!.url}/api/apps/version_exist?token=${key.token}&channel_key=${channelKey}&bundle_id=${APP}&release_version=2.0.0&build_version=700&branch=release`,
      {
        // @ts-expect-error undici's dispatcher option
        dispatcher: insecure,
      },
    )
    await c.until(
      () =>
        host
          .host!.cache.db.prepare(
            "SELECT 1 FROM builds WHERE build_number='700'",
          )
          .get(),
      2000,
      'the build cached',
    )
    assert([200, 404].includes(exists.status))
    await c.drop('host', 1500, async () => {
      await c.until(() => !host.host!.online(), 2000, 'offline')
      assert.equal((await upload(dmg, '701')).status, 503)
    })
    await c.until(() => host.host!.online(), 10_000, 'online')
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
          .prepare('SELECT build_id FROM build_reservations WHERE id=?')
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
            'SELECT build_id, staged_at IS NOT NULL staged FROM build_reservations WHERE job_id=?',
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
            .prepare('SELECT build_id FROM build_reservations WHERE job_id=?')
            .get(late) as Json
        ).build_id != null,
      10_000,
      'the host confirmed the staged build after the run ended',
    )
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
