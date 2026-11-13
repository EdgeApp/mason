import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { SESSION_COOKIE } from '../auth/routes.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { seedSecret } from '../test/secrets.js'
import {
  packageFields,
  plistOf,
  simulatorZip,
  zip,
} from '../upload/fixtures.test.js'
import { artifactRunData } from './pageData/artifacts.js'
import { olderVersion } from './artifacts.js'
import { localOperator } from './roles.js'

// Rows and API answers are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const APP = packageFields.bundleId

const TV = 'test.example.tv'
const tvMasonfile = `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber('${TV}', { start: 5 })
  m.workflow('build', {}, () => {})
  m.stage('ship', { on: {}, publishes: ['${TV}'], secrets: ['TV_IPA'], run: ship })
}
export async function ship(ctx: Stage) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('TV.ipa', Buffer.from(ctx.secret('TV_IPA'), 'base64'))
  return await ctx.publish({ app: '${TV}', platform: 'tvos', path: 'TV.ipa' })
}
`

const masonfile = `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber('${APP}', { start: 70 })
  m.workflow('build', { params: { mode: { type: 'string', default: 'both' } } }, () => {})
  m.stage('ship', { on: {}, publishes: ['${APP}'], secrets: ['PHONE_IPA', 'MAESTRO_ZIP'], run: ship })
}
export async function ship(ctx: Stage) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync('Example.ipa', Buffer.from(ctx.secret('PHONE_IPA'), 'base64'))
  writeFileSync('Example.app.zip', Buffer.from(ctx.secret('MAESTRO_ZIP'), 'base64'))
  if (ctx.run.params.mode === 'both')
    await ctx.publish({ app: '${APP}', platform: 'ios', path: 'Example.ipa' })
  return await ctx.publish({ app: '${APP}', platform: 'ios', variant: 'maestro', path: 'Example.app.zip' })
}
`

describe('iPhone Simulator and tvOS builds', function () {
  this.timeout(120_000)
  let c: Cluster
  let host: RunningNode
  let tester: { id: number }
  const db = (): import('node:sqlite').DatabaseSync =>
    c.master.master!.database.db
  /** The run's number: one past the sequence's last. */
  const next = (): string =>
    String(
      Number(
        (
          db()
            .prepare('SELECT value FROM build_number_last WHERE key=?')
            .get(APP) as Json | undefined
        )?.value ?? 69,
      ) + 1,
    )
  const info = (
    number: string,
    extra: Record<string, string | string[]> = {},
  ): Record<string, string | string[]> => ({
    CFBundleIdentifier: APP,
    CFBundleShortVersionString: packageFields.version,
    CFBundleVersion: number,
    ...extra,
  })
  const seed = (ipa: Buffer, simulator: Buffer): void => {
    for (const [name, value] of [
      ['PHONE_IPA', ipa],
      ['MAESTRO_ZIP', simulator],
    ] as const) {
      db().prepare('DELETE FROM project_secrets WHERE name=?').run(name)
      seedSecret(db(), 'phones', {
        name,
        kind: 'value',
        value: value.toString('base64'),
      })
    }
  }
  const ipaOf = (number: string): Buffer =>
    zip([['Payload/Example.app/Info.plist', plistOf(info(number))]])
  const run = async (mode: string): Promise<Json> => {
    const created = await c.api('POST', '/api/v2/runs', {
      project: 'phones',
      branch: 'master',
      params: { mode },
    })
    assert.equal(created.status, 202, created.text)
    return await c.until(
      () => {
        const value = c.master.master!.run(created.json.id) as Json
        return ['succeeded', 'failed', 'cancelled'].includes(value.status)
          ? value
          : undefined
      },
      60_000,
      `the ${mode} run`,
    )
  }
  /** A branch of an app on the host, as Install apps reads it. */
  const hostBranch = async (appId: number, platform: string): Promise<Json> => {
    const started = host.host!.accounts.startSession(tester.id)
    const route = `/api/v2/catalog/apps/${appId}/branches/${Buffer.from('master').toString('base64url')}?platform=${platform}`
    const response = await pinnedFetch(
      host.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:') + route,
      {
        redirect: 'manual',
        headers: { cookie: `${SESSION_COOKIE}=${started.token}` },
      },
      host.web!.certificate!.pin,
    )
    assert.equal(response.status, 200, route)
    return await response.json()
  }

  before(async () => {
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'simulator-'),
    )
    c = await cluster(path.join(dir, 'cluster'), { workers: [{ name: 'w' }] })
    host = await c.startHost('host')
    const master = c.master.master!
    await master.settings.set(localOperator, 'host', {
      origin: 'https://builds.example.test',
      workerOrigin: host.web!.url,
    })
    const repo = c.repo('fixtures/phones')
    repo.commit({ 'Masonfile.ts': masonfile })
    master.saveProject(localOperator, 'phones', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
      apps: [{ bundleId: APP, name: 'Phone', platforms: ['ios'] }],
    })
    const tvRepo = c.repo('fixtures/tvs')
    tvRepo.commit({ 'Masonfile.ts': tvMasonfile })
    master.saveProject(localOperator, 'tvs', {
      repository: tvRepo.url,
      rules: [{ pattern: '*', mode: 'request' }],
      apps: [{ bundleId: TV, name: 'Television', platforms: ['tvos'] }],
    })
    tester = await master.people.create(localOperator, {
      emails: ['simulator@example.test', 'sam@example.test'],
      name: 'Sam',
      role: 'admin',
    })
  })
  after(async () => {
    await c?.close()
  })

  it('U12.19 publishes a zipped iPhone Simulator app as a variant of the run’s iOS build, offered on the host as a download only', async () => {
    const number = next()
    const simulator = simulatorZip({ fields: { CFBundleVersion: number } })
    seed(ipaOf(number), simulator)
    const value = await run('both')
    assert.equal(
      value.status,
      'succeeded',
      c.master.master!.scheduler.logs(value.id),
    )
    const rows = (
      db()
        .prepare(
          'SELECT id,variant,format,build_number,bundle_id,size,file_key,expires_at FROM builds WHERE run=? ORDER BY variant',
        )
        .all(value.id) as Json[]
    ).map((row) => ({ ...row }))
    assert.deepEqual(
      rows.map((row) => [row.variant, row.format, row.build_number]),
      [
        ['', 'ipa', number],
        ['maestro', 'zip', number],
      ],
    )
    assert.equal(rows[1].size, simulator.length)
    assert.match(rows[1].file_key, /-maestro-[0-9a-f]{16}\.zip$/)
    // One build: its variants expire together.
    assert.equal(rows[0].expires_at, rows[1].expires_at)
    await c.until(
      () =>
        (
          host
            .host!.cache.db.prepare('SELECT COUNT(*) n FROM builds WHERE run=?')
            .get(value.id) as Json
        ).n === 2,
      5000,
      'the build on the host',
    )
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(tester.id),
      5000,
      'the tester on the host',
    )
    const appId = Number(
      (
        host
          .host!.cache.db.prepare('SELECT id FROM apps WHERE slug=?')
          .get(APP) as Json
      ).id,
    )
    const page = await hostBranch(appId, 'ios')
    const builds = new Map(
      (page.builds as Json[]).map((build) => [build.id, build]),
    )
    // The simulator build downloads, for the iPhone Simulator: no grant, no installer.
    const maestro = builds.get(rows[1].id)
    assert.deepEqual(
      [
        maestro.variant,
        maestro.version,
        maestro.buildNumber,
        maestro.download,
        maestro.size,
        maestro.eligible,
        maestro.token,
        maestro.installUrl,
      ],
      [
        'maestro',
        '1.2.3',
        number,
        'iPhone Simulator',
        simulator.length,
        true,
        undefined,
        undefined,
      ],
    )
    // The device build waits for a registered device; the simulator build checks none.
    const phone = builds.get(rows[0].id)
    assert.deepEqual(
      [phone.variant, phone.download, phone.eligible, phone.token],
      ['', undefined, false, undefined],
    )
    assert.equal(page.device, false)
    // Artifacts' run detail lists it as an iPhone Simulator download (the
    // web app labels such a build Download, to /apps/:id, on the host).
    const detail = artifactRunData(
      {
        db: host.host!.cache.db,
        viewer: { role: 'admin', node: 'host' },
        now: Date.now(),
        appVisible: () => true,
        artifactBase: '',
      },
      value.id,
    )!
    const download = detail.builds.find((build) => build.variant === 'maestro')!
    assert.deepEqual(
      [
        download.app,
        download.version,
        download.buildNumber,
        download.platform,
        download.downloadOnly,
        download.appId,
      ],
      ['Phone', '1.2.3', number, 'ios', 'iPhone Simulator', appId],
    )
  })

  it('U12.19 refuses a simulator zip of a device app, of two apps, of another app or of another build number, and any to an older host', async () => {
    const refused = async (
      simulator: (number: string) => Buffer,
      message: RegExp,
    ): Promise<void> => {
      const number = next()
      seed(ipaOf(number), simulator(number))
      const value = await run('simulator')
      assert.equal(value.status, 'failed')
      assert.match(c.master.master!.scheduler.logs(value.id)!, message)
      assert.equal(
        (
          db()
            .prepare('SELECT COUNT(*) n FROM builds WHERE run=?')
            .get(value.id) as Json
        ).n,
        0,
      )
    }
    await refused(
      (number) => simulatorZip({ platform: 'iphoneos', fields: info(number) }),
      /not built for the iPhone Simulator/,
    )
    await refused(
      (number) =>
        zip([
          [
            'A.app/Info.plist',
            plistOf(info(number, { DTPlatformName: 'iphonesimulator' })),
          ],
          [
            'B.app/Info.plist',
            plistOf(info(number, { DTPlatformName: 'iphonesimulator' })),
          ],
        ]),
      /a zip of exactly one \.app/,
    )
    await refused(
      (number) =>
        simulatorZip({
          fields: { ...info(number), CFBundleIdentifier: 'other.example.app' },
        }),
      /not the reservation’s app/,
    )
    await refused(
      (number) => simulatorZip({ fields: info(String(Number(number) + 5)) }),
      /is not the reserved/,
    )
    // A host older than the master may not take a zip: nothing is sent to it.
    assert(olderVersion('0.4.3', '0.10.0'))
    assert(olderVersion('v0.4', '0.4.1'))
    assert(!olderVersion('0.4.3', '0.4.3'))
    assert(!olderVersion('1.0.0', '0.9.9'))
    const reported = db()
      .prepare("SELECT version FROM nodes WHERE role='host'")
      .get() as Json
    db().prepare("UPDATE nodes SET version='0.0.1' WHERE role='host'").run()
    try {
      await refused(
        (number) => simulatorZip({ fields: info(number) }),
        /The host runs Mason 0\.0\.1, older than this master's .*, and may not take zip builds; update the host first/,
      )
    } finally {
      db()
        .prepare("UPDATE nodes SET version=? WHERE role='host'")
        .run(reported.version)
    }
  })

  it('U14.13 publishes a tvOS app, which the host offers as an Apple TV download only, never to an older host', async () => {
    /** A run of the tvOS app, whose IPA is the number `number`. */
    const tvRun = async (number: string): Promise<Json> => {
      db().prepare("DELETE FROM project_secrets WHERE name='TV_IPA'").run()
      seedSecret(db(), 'tvs', {
        name: 'TV_IPA',
        kind: 'value',
        value: zip([
          [
            'Payload/TV.app/Info.plist',
            plistOf({
              CFBundleIdentifier: TV,
              CFBundleShortVersionString: '2.0',
              CFBundleVersion: number,
              DTPlatformName: 'appletvos',
            }),
          ],
        ]).toString('base64'),
      })
      const created = await c.api('POST', '/api/v2/runs', {
        project: 'tvs',
        branch: 'master',
      })
      assert.equal(created.status, 202, created.text)
      return await c.until(
        () => {
          const found = c.master.master!.run(created.json.id) as Json
          return ['succeeded', 'failed'].includes(found.status)
            ? found
            : undefined
        },
        60_000,
        'the tvOS run',
      )
    }
    // A host older than the master may not know tvOS: nothing is sent to it.
    const reported = db()
      .prepare("SELECT version FROM nodes WHERE role='host'")
      .get() as Json
    db().prepare("UPDATE nodes SET version='0.0.1' WHERE role='host'").run()
    const refused = await tvRun('5')
    db()
      .prepare("UPDATE nodes SET version=? WHERE role='host'")
      .run(reported.version)
    assert.equal(refused.status, 'failed')
    assert.match(
      c.master.master!.scheduler.logs(refused.id)!,
      /The host runs Mason 0\.0\.1, older than this master's .*, and may not show tvOS builds; update the host first/,
    )
    const value = await tvRun('6')
    assert.equal(
      value.status,
      'succeeded',
      c.master.master!.scheduler.logs(value.id),
    )
    const build = db()
      .prepare(
        'SELECT id,platform,format,version,build_number,bundle_id FROM builds WHERE run=?',
      )
      .get(value.id) as Json
    assert.deepEqual(
      [
        build.platform,
        build.format,
        build.version,
        build.build_number,
        build.bundle_id,
      ],
      ['tvos', 'ipa', '2.0', '6', TV],
    )
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM builds WHERE id=?')
          .get(build.id),
      5000,
      'the tvOS build on the host',
    )
    const appId = Number(
      (
        host
          .host!.cache.db.prepare('SELECT id FROM apps WHERE slug=?')
          .get(TV) as Json
      ).id,
    )
    // It downloads for the Apple TV: no grant, no installer.
    const page = await hostBranch(appId, 'tvos')
    const tv = (page.builds as Json[]).find((entry) => entry.id === build.id)
    assert.deepEqual(
      [tv.version, tv.buildNumber, tv.download, tv.token, tv.installUrl],
      ['2.0', '6', 'Apple TV', undefined, undefined],
    )
  })
})
