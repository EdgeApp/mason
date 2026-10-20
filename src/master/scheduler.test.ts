import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'mocha'
import { cluster, type Cluster } from '../test/cluster.js'
import { nodeMain } from '../node/main.js'
import { platformOs, osVersion } from '../worker/baseInventory.js'
import { checkoutEnvironment } from '../worker/checkout.js'
import { Journal } from '../worker/journal.js'
import { WorkerRuntime } from '../worker/stage.js'
import { cronMatches, parseCron } from './triggers.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = (): string =>
  mkdtempSync(
    path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'scheduler-'),
  )

const terminal = [
  'succeeded',
  'unstable',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
]

async function finished(c: Cluster, id: string, ms = 60000): Promise<Json> {
  return await c.until(
    () => {
      const run = c.master.master!.run(id) as Json
      return terminal.includes(run?.status) ? run : undefined
    },
    ms,
    `run ${id} to finish`,
  )
}

function stage(run: Json, name: string): Json {
  return run.stages.find((entry: Json) => entry.name === name)
}

describe('Scheduler, workers and stashes', function () {
  this.timeout(120000)
  let c: Cluster

  before(async () => {
    c = await cluster(root(), {
      workers: [
        { name: 'alpha', type: 'linux', slots: 2 },
        { name: 'beta', type: 'mac', labels: ['signing'] },
      ],
    })
  })
  after(async () => {
    await c?.close()
  })

  async function project(
    slug: string,
    files: Record<string, string>,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const repo = c.repo(`fixtures/${slug}`)
    const commit = repo.commit(files)
    c.master.master!.saveProject({ role: 'admin', label: 'test' }, slug, {
      repository: repo.url,
      format: 'pipeline',
      rules: [
        { pattern: 'master', mode: 'request' },
        { pattern: 'feature/**', mode: 'request' },
      ],
      apps: [
        { bundleId: `app.example.${slug}`, name: slug, platforms: ['ios'] },
      ],
      ...extra,
    })
    return commit
  }

  it('U7.1/U7.3/U7.9 runs setup without secrets, then stages on matching workers with only their secrets and a stash between them', async () => {
    await project(
      'stages',
      {
        'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  console.log('setup env', JSON.stringify(process.env))
  m.apiVersion(1)
  m.stage('compile', { on: 'linux', secrets: ['API_TOKEN'], run: compile })
  m.stage('package', { on: { type: 'mac', labels: ['signing'] }, run: pack })
}
export async function compile(ctx: Stage) {
  await ctx.fs.write('dist/app.txt', 'built with ' + ctx.secret('API_TOKEN').length + ' characters')
  await ctx.stash('dist', 'dist/**')
  console.log('token is', ctx.secret('API_TOKEN'))
  return { node: ctx.node.name }
}
export async function pack(ctx: Stage) {
  await ctx.unstash('dist')
  let secret = ''
  try { ctx.secret('API_TOKEN') } catch (error) { secret = (error as Error).message }
  return { node: ctx.node.name, dist: await ctx.fs.read('dist/app.txt'), secret, env: Object.keys(process.env).includes('API_TOKEN') }
}
`,
      },
      {
        secrets: {
          env: [{ name: 'API_TOKEN', value: 'tok-123456', secret: true }],
          files: [],
        },
      },
    )
    const created = await c.api('POST', '/api/jobs', {
      app: 'stages',
      branch: 'master',
    })
    assert.equal(created.status, 202, created.text)
    const run = await finished(c, created.json.id)
    assert.equal(run.status, 'succeeded', JSON.stringify(run))
    assert.equal(stage(run, '@setup').status, 'succeeded')
    assert.deepEqual(stage(run, 'compile').output, { node: 'alpha' })
    assert.deepEqual(stage(run, 'package').output, {
      node: 'beta',
      dist: 'built with 10 characters',
      secret: 'Stage package did not declare the secret API_TOKEN',
      env: false,
    })
    const logs = await c.api('GET', `/api/jobs/${created.json.id}/logs`)
    assert.equal(logs.status, 200)
    assert.match(logs.text, /── Setup, attempt 1, on (alpha|beta) ──/)
    assert.match(logs.text, /── Stage compile, attempt 1, on alpha ──/)
    assert.match(logs.text, /── Stage package, attempt 1, on beta ──/)
    assert.match(logs.text, /token is \[redacted\]/)
    assert(!logs.text.includes('tok-123456'))
    const job = await c.api('GET', `/api/jobs/${created.json.id}`)
    for (const field of [
      'id',
      'app',
      'branch',
      'status',
      'created',
      'started',
      'finished',
      'commit_sha',
      'automatic',
      'cancel',
      'quarantine',
    ])
      assert(field in job.json, field)
    assert.deepEqual(
      job.json.stages
        .map((entry: Json) => [entry.name, entry.status, entry.worker])
        .slice(1),
      [
        ['compile', 'succeeded', 'alpha'],
        ['package', 'succeeded', 'beta'],
      ],
    )
  })

  async function request(
    slug: string,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await c.api('POST', '/api/v2/runs', {
      project: slug,
      ...body,
    })
    assert.equal(created.status, 202, created.text)
    return created.json.id
  }
  const sleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }
  const db = (): Cluster['master']['databases'] extends Map<string, infer D>
    ? D
    : never => c.master.master!.database.db as never
  const stageRow = (id: string, name: string): Json =>
    db()
      .prepare('SELECT * FROM job_stages WHERE job_id=? AND name=?')
      .get(id, name)
  async function running(
    id: string,
    name: string,
    text?: string,
  ): Promise<void> {
    await c.until(
      () =>
        stageRow(id, name)?.status === 'running' &&
        (text == null ||
          (c.master.master!.scheduler.logs(id) ?? '').includes(text)),
      30000,
      `${name} to run`,
    )
  }

  it('U7.1 fails a job whose setup fails with the setup log, and refuses a cycle', async () => {
    await project('broken', {
      'Masonfile.ts': `export function setup() { throw new Error('setup exploded') }\n`,
    })
    const broken = await finished(c, await request('broken'))
    assert.equal(broken.status, 'failed')
    assert.match(broken.reason, /setup exploded/)
    assert.match(
      c.master.master!.scheduler.logs(broken.id)!,
      /Error: setup exploded/,
    )
    await project('cycle', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('a', { on: 'linux', run: work, needs: [{ name: 'b', kind: 'stage' }] })
  m.stage('b', { on: 'linux', run: work })
}
export async function work(ctx: Stage) {}
`,
    })
    const cycle = await finished(c, await request('cycle'))
    assert.equal(cycle.status, 'failed')
    assert.match(cycle.reason, /cycle: a → b → a/)
  })

  it('U7.2 assigns by type, labels and slots, and never to a quarantined worker', async () => {
    await project('placement', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.parallel('group', {
    one: { on: 'linux', run: nap },
    two: { on: 'linux', run: nap },
    signed: { on: { labels: ['signing'] }, run: nap },
  })
  m.stage('elsewhere', { needs: [], on: { arch: '${process.arch === 'arm64' ? 'x64' : 'arm64'}' }, run: nap })
}
export async function nap(ctx: Stage) { await ctx.sleep('1s'); return ctx.node.name }
`,
    })
    const id = await request('placement')
    await c.until(
      () => stageRow(id, 'group/signed')?.status === 'succeeded',
      30000,
      'signed',
    )
    await c.until(
      () => stageRow(id, 'group/two')?.status === 'succeeded',
      30000,
      'two',
    )
    await c.until(
      () => stageRow(id, 'group/one')?.status === 'succeeded',
      30000,
      'one',
    )
    const one = stageRow(id, 'group/one')
    const two = stageRow(id, 'group/two')
    assert.equal(one.output, '"alpha"')
    assert.equal(two.output, '"alpha"')
    assert(
      one.started < two.finished && two.started < one.finished,
      'two slots run side by side',
    )
    assert.equal(stageRow(id, 'group/signed').output, '"beta"')
    assert.equal(stageRow(id, 'elsewhere').status, 'queued')
    c.master.master!.scheduler.cancel(id)
    const run = await finished(c, id)
    assert.equal(run.status, 'cancelled')
    assert.equal(stage(run, 'elsewhere').status, 'cancelled')

    const alpha = c.workers.get('alpha')!.worker!
    alpha.journal.setQuarantine('Build processes remain')
    await c.drop('alpha', 0)
    await c.until(
      () =>
        db()
          .prepare(
            'SELECT quarantine FROM worker_inventory WHERE fingerprint=?',
          )
          .get(c.fingerprint('alpha'))?.quarantine,
      5000,
      'quarantine',
    )
    const blocked = await request('placement')
    await sleep(1500)
    assert.equal(stageRow(blocked, 'group/one').status, 'queued')
    alpha.recover()
    await c.drop('alpha', 0)
    await c.until(
      () => stageRow(blocked, 'group/one')?.status === 'succeeded',
      30000,
      'recovered',
    )
    c.master.master!.scheduler.cancel(blocked)
    await finished(c, blocked)
  })

  it('U7.4/U7.6/U7.24 replays logs, steps and the result exactly once after a link drop', async () => {
    await project('replay', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('talk', { on: 'mac', run: talk })
}
export async function talk(ctx: Stage) {
  for (let i = 1; i <= 20; i++) {
    await ctx.log.section('step ' + i, async () => { console.log('line ' + i) })
    await ctx.sleep('1s').catch(() => {})
    if (i === 3) await new Promise((r) => setTimeout(r, 1))
  }
  return 'done'
}
`,
    })
    const id = await request('replay')
    await running(id, 'talk', 'line 3')
    let disconnected = ''
    await c.drop('beta', 2500, async () => {
      disconnected = (c.master.master!.run(id) as Json).stages.find(
        (entry: Json) => entry.name === 'talk',
      ).display
    })
    assert.equal(disconnected, 'running (disconnected)')
    const run = await finished(c, id, 90000)
    assert.equal(run.status, 'succeeded')
    const log = c.master.master!.scheduler.logs(id)!
    for (let i = 1; i <= 20; i++)
      assert.equal(log.split(`line ${i}\n`).length - 1, 1, `line ${i}`)
    const talk = stage(run, 'talk')
    assert.equal(talk.attempt, 1)
    assert.equal(talk.steps.length, 20)
    assert.deepEqual(
      talk.steps.map((step: Json) => [step.id, step.title, step.status]),
      Array.from({ length: 20 }, (_, i) => [
        i + 1,
        `step ${i + 1}`,
        'succeeded',
      ]),
    )
    assert(talk.steps.every((step: Json) => typeof step.ms === 'number'))
    const api = await c.api('GET', `/api/v2/runs/${id}`)
    assert.deepEqual(
      api.json.stages.find((entry: Json) => entry.name === 'talk').steps,
      talk.steps,
    )
  })

  it('U7.6 marks a stage interrupted when its worker says nothing by the timeout, and never assigns it twice', async () => {
    await c.startWorker({ name: 'gamma', type: 'silent' })
    await project('silence', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('wait', { on: 'silent', timeout: '2s', run: wait })
}
export async function wait(ctx: Stage) { console.log('waiting'); await ctx.sleep('10s') }
`,
    })
    const id = await request('silence')
    await running(id, 'wait', 'waiting')
    await c.stopWorker('gamma')
    const run = await finished(c, id)
    assert.equal(run.status, 'interrupted')
    assert.equal(stage(run, 'wait').status, 'interrupted')
    assert.equal(stage(run, 'wait').attempt, 1)
    assert.match(
      c.master.master!.scheduler.logs(id)!,
      /No word from the worker by the stage timeout/,
    )
  })

  it('U7.5 cancels queued, preparing, running and disconnected stages', async () => {
    await project('cancels', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export async function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { where: { type: 'string', default: 'linux' }, slowSetup: { type: 'boolean', default: false } } }, () => {})
  if (m.params.slowSetup === true) await new Promise((r) => setTimeout(r, 20000))
  if (m.params.where === 'nowhere') m.stage('lost', { on: 'nowhere', run: work })
  else m.stage('work', { on: m.params.where === 'mac' ? 'mac' : 'linux', run: work })
}
export async function work(ctx: Stage) { console.log('working'); await ctx.sh('sleep 30') }
`,
    })
    const queued = await request('cancels', { params: { where: 'nowhere' } })
    await c.until(
      () => stageRow(queued, 'lost')?.status === 'queued',
      30000,
      'queued',
    )
    c.master.master!.scheduler.cancel(queued)
    assert.equal((await finished(c, queued)).status, 'cancelled')

    const preparing = await request('cancels', { params: { slowSetup: true } })
    await running(preparing, '@setup')
    c.master.master!.scheduler.cancel(preparing)
    const prep = await finished(c, preparing)
    assert.equal(prep.status, 'cancelled')

    const live = await request('cancels', { params: { where: 'linux' } })
    await running(live, 'work', 'working')
    const started = Date.now()
    c.master.master!.scheduler.cancel(live)
    const cancelled = await finished(c, live)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(stage(cancelled, 'work').status, 'cancelled')
    assert(Date.now() - started < 15000)

    const away = await request('cancels', { params: { where: 'mac' } })
    await running(away, 'work', 'working')
    await c.drop('beta', 500, async () => {
      c.master.master!.scheduler.cancel(away)
    })
    const gone = await finished(c, away)
    assert.equal(gone.status, 'cancelled')
    assert.equal(stage(gone, 'work').status, 'cancelled')
  })

  it('U7.8 stashes stay within the run and its limit, and a token of another stage is refused', async () => {
    await project('stashing', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('make', { on: 'linux', run: make })
  m.stage('hold', { on: 'linux', run: hold })
}
export async function make(ctx: Stage) {
  await ctx.fs.write('out/a.txt', 'a')
  await ctx.fs.write('out/a.map', 'map')
  await ctx.stash('out', 'out/**', { exclude: ['*.map'] })
  let none = ''
  try { await ctx.stash('empty', 'nothing/**') } catch (error) { none = (error as Error).message }
  return none
}
export async function hold(ctx: Stage) {
  await ctx.unstash('out', { into: 'copy' })
  const files = await ctx.fs.glob('copy/**')
  let missing = ''
  try { await ctx.unstash('ghost') } catch (error) { missing = (error as Error).message }
  console.log('holding')
  await ctx.sleep('2s')
  return { files, missing }
}
`,
    })
    const id = await request('stashing')
    await running(id, 'hold', 'holding')
    const row = stageRow(id, 'hold')
    const alphaLink = c.workers.get('alpha')!.links!.current()!
    const refusal = async (params: Record<string, unknown>): Promise<string> =>
      await new Promise((resolve) => {
        const stream = alphaLink.openStream('stash.get', params)
        stream.on('abort', resolve)
        stream.on('end', () => {
          resolve('ended')
        })
      })
    assert.match(
      await refusal({
        key: `${id}/hold/1`,
        token: 'f'.repeat(48),
        name: 'out',
      }),
      /not assigned to this worker/,
    )
    assert.match(
      await refusal({ key: `${id}/make/1`, token: row.token, name: 'out' }),
      /not assigned to this worker/,
    )
    assert.match(
      await refusal({ key: `${id}/hold/1`, token: row.token, name: 'ghost' }),
      /No such stash/,
    )
    const run = await finished(c, id)
    assert.equal(run.status, 'succeeded')
    assert.equal(stage(run, 'make').output, 'Stash empty matched no files')
    assert.deepEqual(stage(run, 'hold').output, {
      files: ['copy/out/a.txt'],
      missing: 'Stash ghost: No such stash in this run',
    })
    assert.deepEqual(
      c.master.master!.stashes.list(id).map((entry) => entry.name),
      ['out'],
    )
    await c.until(
      () => !existsSync(path.join(c.workers.get('alpha')!.dir, 'stashes', id)),
      5000,
      'worker stash removal',
    )

    const small = await cluster(root(), {
      workers: [{ name: 'tiny', type: 'linux' }],
      masterOptions: { stashLimit: 64 * 1024 },
    })
    try {
      const repo = small.repo('fixtures/big')
      repo.commit({
        'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
import { randomBytes } from 'node:crypto'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('big', { on: 'linux', run: big })
}
export async function big(ctx: Stage) {
  await ctx.fs.write('big.bin', randomBytes(256 * 1024))
  await ctx.stash('big', 'big.bin')
}
`,
      })
      small.master.master!.saveProject(
        { role: 'admin', label: 'test' },
        'big',
        {
          repository: repo.url,
          rules: [{ pattern: 'master', mode: 'request' }],
        },
      )
      const created = await small.api('POST', '/api/v2/runs', {
        project: 'big',
      })
      const bigRun = await small.until(() => {
        const r = small.master.master!.run(created.json.id) as Json
        return terminal.includes(r.status) ? r : undefined
      }, 60000)
      assert.equal(bigRun.status, 'failed')
      assert.match(stage(bigRun, 'big').reason, /stashes are over 0 MiB/)
    } finally {
      await small.close()
    }
  })

  it('U7.9 keeps the v1 job API: queue entries, apps, build settings, log and cancel', async () => {
    await project('compat', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('lost', { on: 'nowhere', run: work })
}
export async function work(ctx: Stage) {}
`,
    })
    const created = await c.api('POST', '/api/jobs', {
      app: 'app.example.compat',
      idempotencyKey: 'k1',
    })
    assert.equal(created.status, 202)
    const again = await c.api('POST', '/api/jobs', {
      app: 'app.example.compat',
      idempotencyKey: 'k1',
    })
    assert.equal(again.json.id, created.json.id)
    assert.equal(
      (await c.api('POST', '/api/jobs', { app: 'compat', branch: 'nope' }))
        .status,
      400,
    )
    await c.until(
      () => stageRow(created.json.id, 'lost')?.status === 'queued',
      30000,
      'queued',
    )
    const queue = await c.api('GET', '/api/queue')
    const entry = queue.json.find((item: Json) => item.id === created.json.id)
    assert.deepEqual(
      Object.keys(entry).sort(),
      [
        'app',
        'automatic',
        'branch',
        'cancel',
        'cleanup_error',
        'client_ip',
        'client_name',
        'commit_sha',
        'created',
        'exit_code',
        'finished',
        'id',
        'number',
        'project',
        'quarantine',
        'quarantine_reason',
        'requested_commit',
        'stages',
        'started',
        'status',
        'trigger',
        'workflow',
      ].sort(),
    )
    assert.equal(entry.trigger, 'api')
    assert.equal(entry.finished, null)
    assert.deepEqual(
      entry.stages.map((item: Json) => [item.name, item.status]),
      [
        ['@setup', 'succeeded'],
        ['lost', 'queued'],
      ],
    )
    const apps = await c.api('GET', '/api/apps')
    const compat = apps.json.find((app: Json) => app.slug === 'compat')
    assert.deepEqual(
      [compat.defaultBranch, compat.automaticBranches, compat.pollIntervalMs],
      ['master', [], 300000],
    )
    const put = await c.api('PUT', '/api/apps/compat/build-settings', {
      defaultBranch: 'master',
      automaticBranches: ['master'],
    })
    assert.deepEqual(put.json.automaticBranches, ['master'])
    assert.deepEqual(
      c.master
        .master!.projects.get('compat')
        .rules.map((rule) => [rule.pattern, rule.mode]),
      [
        ['master', 'automatic'],
        ['feature/**', 'request'],
      ],
    )
    assert.equal(
      (await c.api('GET', '/api/apps/compat/build-settings')).json
        .defaultBranch,
      'master',
    )
    assert.deepEqual(
      (await c.api('POST', `/api/jobs/${created.json.id}/cancel`)).json,
      { cancelled: true },
    )
    await finished(c, created.json.id)
    assert.equal(
      (await c.api('POST', `/api/jobs/${created.json.id}/cancel`)).status,
      409,
    )
    const log = await c.api('GET', `/api/jobs/${created.json.id}/log`)
    assert.match(log.text, /── Setup, attempt 1/)
    assert.equal(
      (await c.api('GET', '/api/jobs/00000000-0000-0000-0000-000000000000'))
        .status,
      404,
    )
    assert.equal(
      (
        await c.api(
          'GET',
          '/api/jobs/00000000-0000-0000-0000-000000000000/logs',
        )
      ).status,
      404,
    )
  })

  it('U7.10 runs sequences in order within and side by side across, and failFast stops the others', async () => {
    await project('sequences', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { fail: { type: 'boolean', default: false }, failFast: { type: 'boolean', default: true } } }, () => {})
  m.parallel('build', {
    ios: [
      { name: 'compile', on: 'linux', run: slow },
      { name: 'sign', on: 'linux', run: quick },
    ],
    android: [
      { name: 'compile', on: 'linux', run: quick },
      { name: 'sign', on: 'linux', run: m.params.fail === true ? fail : quick },
      { name: 'upload', on: 'linux', run: quick },
    ],
  }, { failFast: m.params.failFast !== false })
}
export async function slow(ctx: Stage) { await ctx.sleep(ctx.run.params.fail === true && ctx.run.params.failFast !== false ? '20s' : '2s') }
export async function quick(ctx: Stage) {}
export async function fail(ctx: Stage) { throw new Error('signing failed') }
`,
    })
    const ok = await finished(
      c,
      await request('sequences', { params: { fail: false } }),
    )
    assert.equal(ok.status, 'succeeded')
    const at = (name: string, field: 'started' | 'finished'): number =>
      stage(ok, name)[field]
    assert(
      at('build/ios/sign', 'started') >= at('build/ios/compile', 'finished'),
    )
    assert(
      at('build/android/sign', 'started') >=
        at('build/android/compile', 'finished'),
    )
    assert(
      at('build/android/compile', 'started') <
        at('build/ios/compile', 'finished'),
      'sequences run side by side',
    )

    const failing = await finished(
      c,
      await request('sequences', { params: { fail: true } }),
    )
    assert.equal(failing.status, 'failed')
    assert.equal(stage(failing, 'build/android/sign').status, 'failed')
    assert.equal(stage(failing, 'build/android/upload').status, 'skipped')
    assert.equal(stage(failing, 'build/ios/compile').status, 'cancelled')
    assert(
      ['cancelled', 'skipped'].includes(
        stage(failing, 'build/ios/sign').status,
      ),
    )

    const soft = await finished(
      c,
      await request('sequences', { params: { fail: true, failFast: false } }),
      90000,
    )
    assert.equal(soft.status, 'failed')
    assert.equal(stage(soft, 'build/ios/compile').status, 'succeeded')
    assert.equal(stage(soft, 'build/ios/sign').status, 'succeeded')
    assert.equal(stage(soft, 'build/android/upload').status, 'skipped')
  })

  it('U7.11 enforces activityTimeout on the worker while the master is away; output resets the clock', async () => {
    await project('silent', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { chatty: { type: 'boolean', default: false } } }, () => {})
  m.stage('quiet', { on: 'mac', activityTimeout: '1s', run: m.params.chatty === true ? chatty : quiet })
}
export async function quiet(ctx: Stage) { console.log('begin'); await ctx.sleep('5s') }
export async function chatty(ctx: Stage) {
  for (let i = 0; i < 6; i++) { console.log('tick ' + i); await new Promise((r) => setTimeout(r, 400)) }
}
`,
    })
    const quiet = await request('silent', { params: { chatty: false } })
    await running(quiet, 'quiet', 'begin')
    await c.drop('beta', 2500)
    const timedOut = await finished(c, quiet)
    assert.equal(stage(timedOut, 'quiet').status, 'timed_out')
    assert.match(c.master.master!.scheduler.logs(quiet)!, /No output for 1 s/)
    const chatty = await finished(
      c,
      await request('silent', { params: { chatty: true } }),
    )
    assert.equal(chatty.status, 'succeeded')
  })

  it('U7.12 shares custom workspace paths by name, locks them, and keeps them inside their roots', async () => {
    const outside = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'roots-'),
    )
    await project('workspaces', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { path: { type: 'string', default: 'shared' }, pair: { type: 'boolean', default: false } } }, () => {})
  const space = { path: String(m.params.path ?? 'shared'), mode: 'reuse' as const }
  if (m.params.pair === true)
    m.parallel('pair', {
      first: { on: 'linux', workspace: space, run: write },
      second: { on: 'linux', workspace: space, run: write },
    })
  else m.stage('read', { on: 'linux', workspace: space, run: read })
}
export async function write(ctx: Stage) {
  const start = Date.now()
  await ctx.fs.write('marker-' + ctx.stage.name.split('/').pop(), ctx.run.branch)
  await ctx.sleep('1s')
  return { start, end: Date.now() }
}
export async function read(ctx: Stage) {
  return (await ctx.fs.glob('marker-*')).length + ':' + ctx.workspace
}
`,
    })
    const pair = await finished(
      c,
      await request('workspaces', { params: { pair: true } }),
    )
    assert.equal(pair.status, 'succeeded')
    const first = stage(pair, 'pair/first').output
    const second = stage(pair, 'pair/second').output
    assert(
      first.end <= second.start || second.end <= first.start,
      'one waits for the other',
    )
    assert.match(
      c.master.master!.scheduler.logs(pair.id)!,
      /Waiting for another stage to finish with/,
    )
    c.repo('fixtures/workspaces').commit({}, 'feature/other')
    const read = await finished(
      c,
      await request('workspaces', {
        branch: 'feature/other',
        params: { pair: false },
      }),
    )
    assert.match(stage(read, 'read').output, /^2:.*workspaces\/shared$/)
    const absolute = await finished(
      c,
      await request('workspaces', {
        params: { path: path.join(outside, 'abs') },
      }),
    )
    assert.equal(absolute.status, 'failed')
    assert.match(
      stage(absolute, 'read').reason,
      /is not under one of this node's workspace roots/,
    )
    await c.master.master!.registry.assign(c.fingerprint('alpha'), {
      workspaceRoots: [outside],
    })
    const allowed = await finished(
      c,
      await request('workspaces', {
        params: { path: path.join(outside, 'abs') },
      }),
    )
    assert.equal(allowed.status, 'succeeded', JSON.stringify(allowed))
    assert.equal(
      stage(allowed, 'read').output,
      `0:${path.join(outside, 'abs')}`,
    )
    const escape = await finished(
      c,
      await request('workspaces', { params: { path: '../up' } }),
    )
    assert.equal(escape.status, 'failed')
    assert.match(escape.reason, /cannot contain \.\./)
    const { symlinkSync, mkdirSync } = await import('node:fs')
    mkdirSync(path.join(c.workers.get('alpha')!.dir, 'workspaces'), {
      recursive: true,
    })
    symlinkSync(
      outside,
      path.join(c.workers.get('alpha')!.dir, 'workspaces', 'link'),
    )
    const linked = await finished(
      c,
      await request('workspaces', { params: { path: 'link/inner' } }),
    )
    assert.equal(linked.status, 'failed')
    assert.match(stage(linked, 'read').reason, /outside the workspace/)
  })

  it('U7.13 the stages of a run share each sequence’s number, and app IDs in a sequence’s apps take theirs from it', async () => {
    await project(
      'shared-numbers',
      {
        'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber('app', { format: 'N', apps: ['app.example.one', 'app.example.two'] })
  m.stage('one', { on: 'linux', publishes: ['app.example.one'], run: number })
  m.stage('two', { on: 'linux', publishes: ['app.example.two'], buildNumbers: ['app'], run: number })
  m.stage('other', { on: 'linux', buildNumbers: ['other'], run: other })
}
export async function number(ctx: Stage) {
  return ctx.getBuildNumber(ctx.stage.name === 'one' ? 'app.example.one' : 'app.example.two') + '/' + (ctx.stage.name === 'two' ? ctx.getBuildNumber('app') : '')
}
export async function other(ctx: Stage) { return ctx.getBuildNumber('other') }
`,
      },
      {
        apps: ['one', 'two'].map((name) => ({
          bundleId: `app.example.${name}`,
          name,
          platforms: ['android'],
        })),
      },
    )
    const first = await finished(c, await request('shared-numbers'))
    const second = await finished(c, await request('shared-numbers'))
    assert.deepEqual(
      ['one', 'two', 'other'].map((name) => stage(first, name).output),
      ['1/', '1/1', '1'],
    )
    // The next run takes the next number, for every app of the sequence at once.
    assert.deepEqual(
      ['one', 'two', 'other'].map((name) => stage(second, name).output),
      ['2/', '2/2', '2'],
    )
  })

  it('U7.13 restarts from a stage, reusing what does not depend on it, with new build numbers', async () => {
    const flag = path.join(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'flag-'),
      ),
      'pass',
    )
    await project('restart', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
import { existsSync } from 'node:fs'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('prepare', { on: 'linux', run: prepare })
  m.stage('build', { on: 'linux', publishes: ['app.example.restart'], run: build })
  m.stage('ship', { on: 'linux', run: ship })
}
export async function prepare(ctx: Stage) {
  await ctx.fs.write('p.txt', 'prepared ' + Date.now())
  await ctx.stash('p', 'p.txt')
  return await ctx.fs.read('p.txt')
}
export async function build(ctx: Stage) {
  await ctx.unstash('p', { into: 'in' })
  if (!existsSync(${JSON.stringify(flag)})) throw new Error('not yet')
  return { number: ctx.getBuildNumber('app.example.restart'), prepared: await ctx.fs.read('in/p.txt') }
}
export async function ship(ctx: Stage) { return 'shipped' }
`,
    })
    const first = await finished(c, await request('restart'))
    assert.equal(first.status, 'failed')
    assert.equal(stage(first, 'ship').status, 'skipped')
    const firstNumber = c.master
      .master!.database.db.prepare(
        'SELECT value FROM build_number_reservations WHERE reservation=?',
      )
      .get(first.id)!.value
    const { writeFileSync } = await import('node:fs')
    writeFileSync(flag, 'yes')
    const restarted = await c.api('POST', `/api/v2/runs/${first.id}/restart`, {
      stage: 'build',
    })
    assert.equal(restarted.status, 201, restarted.text)
    const second = await finished(c, restarted.json.id)
    assert.equal(second.status, 'succeeded')
    assert.equal(second.restartOf, first.id)
    assert.equal(stage(second, 'prepare').reused, true)
    assert.equal(
      stage(second, 'prepare').output,
      stage(first, 'prepare').output,
    )
    assert.equal(
      stage(second, '@setup'),
      undefined,
      'the original graph is reused',
    )
    const built = stage(second, 'build').output
    assert.equal(built.prepared, stage(first, 'prepare').output)
    assert.notEqual(built.number, firstNumber)
    assert(Number(built.number) > Number(firstNumber))
    assert.equal(stage(second, 'ship').output, 'shipped')
    c.master.master!.stashes.remove(first.id)
    const refused = await c.api('POST', `/api/v2/runs/${first.id}/restart`, {
      stage: 'build',
    })
    assert.equal(refused.status, 400)
    assert.match(refused.json.error, /stashes .* have expired/)
    assert.equal(
      (
        await c.api('POST', `/api/v2/runs/${first.id}/restart`, {
          stage: 'nope',
        })
      ).status,
      400,
    )
    assert.equal(
      (await c.api('POST', `/api/v2/runs/${first.id}/restart`, {})).status,
      400,
    )
  })

  it('U7.14 survives a master restart mid-run: running stages report in, approvals keep waiting, nothing is assigned twice', async () => {
    await project('resilient', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { approve: { type: 'boolean', default: false } } }, () => {})
  if (m.params.approve === true) {
    m.approval('ok')
    m.stage('after', { on: 'linux', run: quick })
    return
  }
  m.stage('long', { on: 'mac', run: long })
  m.stage('next', { on: 'linux', run: quick })
}
export async function long(ctx: Stage) { console.log('long start'); await ctx.sleep('3s'); console.log('long end'); return 'long' }
export async function quick(ctx: Stage) { return 'quick' }
`,
    })
    c.repo('fixtures/resilient').commit({}, 'feature/approve')
    const waiting = await request('resilient', {
      branch: 'feature/approve',
      params: { approve: true },
    })
    await c.until(
      () => stageRow(waiting, 'ok')?.status === 'awaiting_approval',
      30000,
      'approval',
    )
    const id = await request('resilient', { params: { approve: false } })
    await running(id, 'long', 'long start')
    await c.restartMaster()
    const run = await finished(c, id)
    assert.equal(run.status, 'succeeded')
    assert.equal(stage(run, 'long').attempt, 1)
    assert.equal(stage(run, 'next').attempt, 1)
    assert.equal(
      c.master.master!.scheduler.logs(id)!.split('long end').length - 1,
      1,
    )
    assert.equal(stageRow(waiting, 'ok').status, 'awaiting_approval')
    const approved = await c.api('POST', `/api/v2/runs/${waiting}/approve`, {
      stage: 'ok',
    })
    assert.equal(approved.status, 200, approved.text)
    assert.equal((await finished(c, waiting)).status, 'succeeded')
  })

  it('U7.15 checks out only through the master: incremental, shallow, submodules and LFS, with no credentials', async () => {
    const sub = c.repo('fixtures/sub')
    sub.commit({ 'file.txt': 'from the submodule' })
    const lfsContent = Buffer.from('large file contents\n'.repeat(500))
    const oid = createHash('sha256').update(lfsContent).digest('hex')
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`)
      if (req.url?.endsWith('/objects/batch')) {
        res.setHeader('Content-Type', 'application/vnd.git-lfs+json')
        res.end(
          JSON.stringify({
            objects: [
              {
                oid,
                size: lfsContent.length,
                actions: {
                  download: {
                    href: `http://127.0.0.1:${(server.address() as AddressInfo).port}/objects/${oid}`,
                  },
                },
              },
            ],
          }),
        )
      } else if (req.url === `/objects/${oid}`) res.end(lfsContent)
      else res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const main = c.repo('fixtures/checkout')
      main.lfs = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git/info/lfs`,
        headers: { Authorization: 'Basic master-only' },
      }
      main.commit({
        'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { shallow: { type: 'boolean', default: false } } }, () => {})
  if (m.params.shallow === true)
    m.stage('shallow', { on: 'linux', checkout: { depth: 1 }, workspace: { path: 'shallow-' + m.commit.slice(0, 8), mode: 'clean' }, run: shallow })
  else m.stage('look', { on: 'linux', checkout: { submodules: true, lfs: true }, run: look })
}
export async function look(ctx: Stage) {
  const ext = await ctx.sh('git fetch "ext::sh -c true" master', { allowFailure: true, quiet: true })
  return {
    sub: await ctx.fs.read('lib/sub/file.txt'),
    lfs: (await ctx.fs.read('asset.bin')).length,
    leaks: Object.keys(process.env).filter((name) => /SSH_AUTH_SOCK|ASKPASS|TOKEN|GIT_CONFIG/.test(name)),
    ext: ext.stderr.trim(),
  }
}
export async function shallow(ctx: Stage) {
  return (await ctx.sh('git rev-list --count HEAD', { quiet: true })).stdout.trim()
}
`,
        'big.txt': randomBytes(512 * 1024).toString('hex'),
        '.gitattributes': 'asset.bin filter=lfs diff=lfs merge=lfs -text\n',
        'asset.bin': `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${lfsContent.length}\n`,
      })
      main.git(
        '-c',
        'protocol.file.allow=always',
        'submodule',
        '--quiet',
        'add',
        sub.bare,
        'lib/sub',
      )
      main.git('config', '-f', '.gitmodules', 'submodule.lib/sub.url', sub.url)
      main.commit({}, 'master', 'Add the submodule')
      c.master.master!.saveProject(
        { role: 'admin', label: 'test' },
        'checkout',
        {
          repository: main.url,
          repositories: [sub.url],
          rules: [{ pattern: 'master', mode: 'request' }],
        },
      )
      let bytes = 0
      const mirrors = c.master.master!.mirrors
      const original = mirrors.uploadPack.bind(mirrors)
      mirrors.uploadPack = (
        project,
        repository,
        protocol,
      ): ReturnType<typeof original> => {
        const child = original(project, repository, protocol)
        child.stdout!.on('data', (chunk: Buffer) => {
          bytes += chunk.length
        })
        return child
      }
      try {
        const first = await finished(c, await request('checkout'))
        assert.equal(
          first.status,
          'succeeded',
          c.master.master!.scheduler.logs(first.id),
        )
        const look = stage(first, 'look').output
        assert.equal(look.sub, 'from the submodule')
        assert.equal(
          look.lfs,
          lfsContent.length,
          c.master.master!.scheduler.logs(first.id),
        )
        assert.deepEqual(look.leaks, [])
        assert.match(look.ext, /transport 'ext' not allowed/)
        assert.deepEqual(seen, [
          'POST /repo.git/info/lfs/objects/batch Basic master-only',
          `GET /objects/${oid} undefined`,
        ])
        const firstBytes = bytes
        assert(firstBytes > 512 * 1024, `first fetch ${firstBytes}`)
        main.commit({ 'small.txt': 'a small change' })
        bytes = 0
        const second = await finished(c, await request('checkout'))
        assert.equal(second.status, 'succeeded')
        assert(
          bytes < firstBytes / 10,
          `incremental fetch ${bytes} of ${firstBytes}`,
        )
        const shallowRun = await finished(
          c,
          await request('checkout', { params: { shallow: true } }),
        )
        assert.equal(stage(shallowRun, 'shallow').output, '1')
      } finally {
        mirrors.uploadPack = original
      }
      const helper = spawnSync(
        'git',
        ['config', '--get-all', 'credential.helper'],
        { env: checkoutEnvironment(), encoding: 'utf8' },
      )
      assert.equal(helper.stdout.trim(), '')
      assert.equal(checkoutEnvironment().SSH_AUTH_SOCK, undefined)
    } finally {
      server.close()
    }
  })

  it('U7.16 serves only upload-pack, for listed repositories, to the worker running a stage; tags are pushed by the master only when allowed', async () => {
    const repo = c.repo('fixtures/refusals')
    await project('refusals', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('tag', { on: 'mac', run: tag })
  m.stage('hold', { on: 'mac', run: hold })
}
export async function tag(ctx: Stage) {
  try { await ctx.git.tag('v-' + ctx.run.number, { push: true, message: 'Release' }) } catch (error) { return (error as Error).message }
  return 'pushed'
}
export async function hold(ctx: Stage) { console.log('holding'); await ctx.sleep('3s') }
`,
    })
    const id = await request('refusals')
    await running(id, 'hold', 'holding')
    const row = stageRow(id, 'hold')
    const key = `${id}/hold/1`
    const open = async (
      node: string,
      params: Record<string, unknown>,
    ): Promise<string> =>
      await new Promise((resolve) => {
        const stream = c.workers
          .get(node)!
          .links!.current()!
          .openStream('git.upload-pack', params)
        stream.on('abort', resolve)
        stream.on('data', () => {
          resolve('served')
          stream.abort('enough')
        })
      })
    assert.match(
      await open('beta', {
        key,
        token: row.token,
        service: 'git-receive-pack',
        repository: repo.url,
      }),
      /Only git-upload-pack is served/,
    )
    assert.match(
      await open('beta', {
        key,
        token: row.token,
        service: 'git-upload-pack',
        repository: 'https://github.com/someone/else.git',
      }),
      /not one this project lists/,
    )
    assert.match(
      await open('alpha', {
        key,
        token: row.token,
        service: 'git-upload-pack',
        repository: repo.url,
      }),
      /not assigned to this worker/,
    )
    assert.equal(
      await open('beta', {
        key,
        token: row.token,
        service: 'git-upload-pack',
        repository: repo.url,
      }),
      'served',
    )
    const refused = await finished(c, id)
    assert.equal(
      stage(refused, 'tag').output,
      'This project does not allow tag pushes',
    )
    assert.equal(repo.git('ls-remote', '--tags', repo.bare), '')
    c.master.master!.saveProject({ role: 'admin', label: 'test' }, 'refusals', {
      tagPushes: true,
    })
    const pushed = await finished(c, await request('refusals'))
    assert.equal(stage(pushed, 'tag').output, 'pushed')
    assert.match(repo.git('ls-remote', '--tags', repo.bare), /refs\/tags\/v-2/)
  })

  it('polls a project as soon as an automatic rule is saved', async () => {
    await project('eager', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('one', { on: 'linux', run: one })
}
export async function one(ctx: Stage) { return ctx.run.trigger }
`,
    })
    c.master.master!.projects.setRules(
      { role: 'admin', label: 'test' },
      'eager',
      [{ pattern: 'master', mode: 'automatic' }],
    )
    const pushed = await c.until(
      () => (c.master.master!.runs({ project: 'eager' }) as Json[])[0],
      10000,
      'the push run',
    )
    assert.equal(pushed.trigger, 'push')
    assert.equal(stage(await finished(c, pushed.id), 'one').output, 'push')
  })

  it('U7.17 caches graphs by commit, workflow, branch, trigger and parameters', async () => {
    await project('cache', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { n: { type: 'number', default: 1 } } }, () => {})
  m.stage('one', { on: 'linux', run: one })
}
export async function one(ctx: Stage) { return ctx.run.params.n }
`,
    })
    const a = await finished(c, await request('cache', { params: { n: 1 } }))
    const b = await finished(c, await request('cache', { params: { n: 1 } }))
    const other = await finished(
      c,
      await request('cache', { params: { n: 2 } }),
    )
    assert.notEqual(stage(a, '@setup'), undefined)
    assert.equal(stage(b, '@setup'), undefined)
    assert.notEqual(stage(other, '@setup'), undefined)
    assert.equal(stage(other, 'one').output, 2)
    c.repo('fixtures/cache').commit({ 'x.txt': 'new commit' })
    const moved = await finished(
      c,
      await request('cache', { params: { n: 1 } }),
    )
    assert.notEqual(stage(moved, '@setup'), undefined)
  })

  it('U7.18 starts schedule, after and deviceRegistered workflows only where rules and triggers allow; requests need a role', async () => {
    const body = (name: string): string =>
      `w.stage('${name}', { on: 'linux', run: quick })`
    await project('timers', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { fail: { type: 'boolean', default: false } } }, () => {})
  m.stage('build', { on: 'linux', run: m.params.fail === true ? fail : quick })
  m.workflow('nightly', { triggers: [{ schedule: '0 3 * * *', branches: ['master'] }] }, (w) => { ${body('n')} })
  m.workflow('deploy', { triggers: [{ after: { workflow: 'build' } }] }, (w) => { ${body('d')} })
  m.workflow('audit', { triggers: [{ after: { workflow: 'build', status: 'completed' } }] }, (w) => { ${body('a')} })
  m.workflow('devices', { triggers: [{ deviceRegistered: true }] }, (w) => { ${body('r')} })
}
export async function quick(ctx: Stage) { return ctx.run.workflow }
export async function fail(ctx: Stage) { throw new Error('no') }
`,
    })
    await project('bystander', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('b', { on: 'linux', run: quick })
  m.workflow('follow', { triggers: [{ after: { workflow: 'build', status: 'completed' } }] }, (w) => { w.stage('f', { on: 'linux', run: quick }) })
}
export async function quick(ctx: Stage) {}
`,
    })
    const runs = (slug: string, workflow?: string): Json[] =>
      c.master.master!.runs({
        project: slug,
        ...(workflow == null ? {} : { workflow }),
      }) as Json[]
    const build = await finished(c, await request('timers'))
    assert.equal(build.status, 'succeeded')
    const deploy = await c.until(
      () => runs('timers', 'deploy')[0],
      30000,
      'deploy',
    )
    const audit = await c.until(
      () => runs('timers', 'audit')[0],
      30000,
      'audit',
    )
    assert.equal(deploy.trigger, 'after')
    assert.equal(deploy.requested_commit, build.commit_sha)
    assert.equal((await finished(c, deploy.id)).status, 'succeeded')
    await finished(c, audit.id)
    const failed = await finished(
      c,
      await request('timers', { params: { fail: true } }),
    )
    assert.equal(failed.status, 'failed')
    await c.until(
      () => runs('timers', 'audit').length === 2,
      30000,
      'second audit',
    )
    await sleep(500)
    assert.equal(runs('timers', 'deploy').length, 1)
    assert.equal(runs('bystander').length, 0)
    for (const run of runs('timers')) await finished(c, run.id)

    const scheduler = c.master.master!.scheduler
    ;(scheduler.options as { timeZone?: string }).timeZone =
      'America/Los_Angeles'
    const three = Date.UTC(2026, 9, 21, 10, 0, 0)
    scheduler.schedules(three)
    scheduler.schedules(three + 20000)
    scheduler.schedules(three + 60000)
    assert.equal(runs('timers', 'nightly').length, 1)
    assert.equal(runs('timers', 'nightly')[0].trigger, 'schedule')
    c.master.master!.projects.setRules(
      { role: 'admin', label: 'test' },
      'timers',
      [{ pattern: 'feature/**', mode: 'request' }],
    )
    scheduler.schedules(three + 86400000)
    assert.equal(runs('timers', 'nightly').length, 1, 'no rule, no schedule')
    c.master.master!.projects.setRules(
      { role: 'admin', label: 'test' },
      'timers',
      [{ pattern: 'master', mode: 'request' }],
    )
    const devices = scheduler.deviceRegistered()
    assert.deepEqual(
      devices.map((job) => [job.project, job.workflow]),
      [['timers', 'devices']],
    )
    await assert.rejects(
      scheduler.request(
        { role: 'tester', label: 'tester' },
        { project: 'timers' },
      ),
      /Not allowed for this role/,
    )
    for (const run of runs('timers')) await finished(c, run.id)
  })

  it('U7.19 runs one run per concurrency group, cancels the previous one when asked, and lets other groups run side by side', async () => {
    c.repo('fixtures/lanes')
    await project('lanes', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { ms: { type: 'number', default: 1500 } } }, () => {})
  m.stage('work', { on: 'linux', run: work })
  m.workflow('slow', { triggers: [{ request: true }], concurrency: { group: 'workflow' } }, (w) => { w.stage('work', { on: 'linux', run: work }) })
  m.workflow('replace', { triggers: [{ request: true }], params: { ms: { type: 'number', default: 10000 } }, concurrency: { group: 'workflow', cancelPrevious: true } }, (w) => { w.stage('work', { on: 'linux', run: work }) })
}
export async function work(ctx: Stage) { console.log('working'); await ctx.sleep(String(Math.max(1, Math.round(Number(ctx.run.params.ms ?? 1500) / 1000))) + 's') }
`,
    })
    c.repo('fixtures/lanes').commit({}, 'feature/lane')
    const first = await request('lanes', { workflow: 'slow' })
    const second = await request('lanes', { workflow: 'slow' })
    const [a, b] = [await finished(c, first), await finished(c, second)]
    assert.equal(b.status, 'succeeded')
    assert(b.started >= a.finished, 'the second waited for the first')
    const old = await request('lanes', { workflow: 'replace' })
    await running(old, 'work', 'working')
    const replacement = await request('lanes', {
      workflow: 'replace',
      params: { ms: 1000 },
    })
    const cancelled = await finished(c, old)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(stage(cancelled, 'work').status, 'cancelled')
    assert.equal((await finished(c, replacement)).status, 'succeeded')
    const main = await request('lanes', { params: { ms: 2000 } })
    const lane = await request('lanes', {
      branch: 'feature/lane',
      params: { ms: 2000 },
    })
    const [x, y] = [await finished(c, main), await finished(c, lane)]
    assert(
      x.started < y.finished && y.started < x.finished,
      `branches run side by side: ${JSON.stringify([x.started, x.finished, y.started, y.finished, x.stages, y.stages])}`,
    )
  })

  it('U7.20 times a whole run out and retries a stage only on the listed outcomes', async () => {
    await project('limits', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { failFast: false }, () => {})
  m.stage('flaky', { on: 'linux', retry: { attempts: 3, on: ['failed'] }, run: flaky })
  m.stage('never', { needs: [], on: 'linux', retry: { attempts: 3, on: ['timed_out'] }, run: never })
  m.workflow('stuck', { triggers: [{ request: true }], timeout: '2s' }, (w) => { w.stage('wait', { on: 'linux', run: wait }) })
}
export async function flaky(ctx: Stage) { if (ctx.stage.attempt < 3) throw new Error('try again'); return ctx.stage.attempt }
export async function never(ctx: Stage) { throw new Error('broken for good') }
export async function wait(ctx: Stage) { await ctx.sh('sleep 30') }
`,
    })
    const retried = await finished(c, await request('limits'))
    assert.equal(stage(retried, 'flaky').status, 'succeeded')
    assert.equal(stage(retried, 'flaky').attempt, 3)
    assert.equal(stage(retried, 'flaky').output, 3)
    assert.equal(stage(retried, 'never').status, 'failed')
    assert.equal(stage(retried, 'never').attempt, 1)
    assert.equal(retried.status, 'failed')
    const stuck = await finished(
      c,
      await request('limits', { workflow: 'stuck' }),
    )
    assert.equal(stuck.status, 'timed_out')
    assert.equal(stage(stuck, 'wait').status, 'cancelled')
  })

  it('U7.21 runs each post stage exactly when its condition holds', async () => {
    await project('posts', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { fail: { type: 'boolean', default: false }, slow: { type: 'boolean', default: false }, soft: { type: 'boolean', default: false } } }, () => {})
  m.stage('main', { on: 'linux', run: main })
  const post = { on: 'linux', run: note } as const
  m.post({ always: post, success: post, unstable: post, failure: post, aborted: post, fixed: post, regression: post })
}
export async function main(ctx: Stage) {
  if (ctx.run.params.slow === true) { console.log('slow'); await ctx.sleep('30s') }
  if (ctx.run.params.soft === true) ctx.unstable('soft')
  if (ctx.run.params.fail === true) throw new Error('main failed')
}
export async function note(ctx: Stage) { return ctx.stage.name }
`,
    })
    const ran = (run: Json): string[] =>
      run.stages
        .filter(
          (entry: Json) =>
            entry.name.startsWith('post/') && entry.status === 'succeeded',
        )
        .map((entry: Json) => entry.name.slice(5))
    const one = await finished(
      c,
      await request('posts', { params: { fail: true } }),
    )
    assert.equal(one.status, 'failed')
    assert.deepEqual(ran(one), ['always', 'failure'])
    const two = await finished(c, await request('posts'))
    assert.equal(two.status, 'succeeded')
    assert.deepEqual(ran(two), ['always', 'success', 'fixed'])
    const three = await finished(
      c,
      await request('posts', { params: { fail: true } }),
    )
    assert.deepEqual(ran(three), ['always', 'failure', 'regression'])
    const four = await finished(
      c,
      await request('posts', { params: { soft: true } }),
    )
    assert.equal(four.status, 'unstable')
    assert.deepEqual(ran(four), ['always', 'unstable'])
    const five = await request('posts', { params: { slow: true } })
    await running(five, 'main', 'slow')
    c.master.master!.scheduler.cancel(five)
    const aborted = await finished(c, five)
    assert.equal(aborted.status, 'cancelled')
    assert.deepEqual(ran(aborted), ['always', 'aborted'])
  })

  it('U7.22 lets only allowed roles approve, validates their parameters, and cancels on timeout or rejection', async () => {
    await project('gates', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { params: { quick: { type: 'boolean', default: false } } }, () => {})
  m.stage('build', { on: 'linux', run: quick })
  const ok = m.approval('ok', { roles: ['manager'], params: { notes: { type: 'text' } }, ...(m.params.quick === true ? { timeout: '1s' } : {}) })
  m.stage('upload', { needs: [ok], on: 'linux', run: upload })
}
export async function quick(ctx: Stage) {}
export async function upload(ctx: Stage) { return { notes: ctx.run.params.notes, output: await ctx.output('ok') } }
`,
    })
    const scheduler = c.master.master!.scheduler
    const id = await request('gates')
    await c.until(
      () => stageRow(id, 'ok')?.status === 'awaiting_approval',
      30000,
      'approval',
    )
    assert.throws(
      () =>
        scheduler.approve({ role: 'developer', label: 'dev' }, id, 'ok', {
          approve: true,
        }),
      /Only manager may decide/,
    )
    assert.throws(
      () =>
        scheduler.approve({ role: 'tester', label: 'tester' }, id, 'ok', {
          approve: true,
        }),
      /Only manager/,
    )
    assert.throws(
      () =>
        scheduler.approve({ role: 'manager', label: 'mgr' }, id, 'ok', {
          approve: true,
        }),
      /notes is required/,
    )
    scheduler.approve({ role: 'manager', label: 'mgr' }, id, 'ok', {
      approve: true,
      params: { notes: 'ship it' },
    })
    const approved = await finished(c, id)
    assert.equal(approved.status, 'succeeded')
    assert.deepEqual(stage(approved, 'upload').output, {
      notes: 'ship it',
      output: { approver: 'mgr', params: { notes: 'ship it' } },
    })
    assert.equal(stage(approved, 'ok').approval.decision.approver, 'mgr')
    assert.throws(
      () =>
        scheduler.approve({ role: 'manager', label: 'mgr' }, id, 'ok', {
          approve: true,
        }),
      /No approval is waiting/,
    )
    const timed = await finished(
      c,
      await request('gates', { params: { quick: true } }),
    )
    assert.equal(timed.status, 'cancelled')
    assert.equal(stage(timed, 'ok').status, 'cancelled')
    assert.equal(stage(timed, 'upload').status, 'cancelled')
    const rejected = await request('gates')
    await c.until(
      () => stageRow(rejected, 'ok')?.status === 'awaiting_approval',
      30000,
      'approval',
    )
    scheduler.approve({ role: 'admin', label: 'boss' }, rejected, 'ok', {
      approve: false,
    })
    const no = await finished(c, rejected)
    assert.equal(no.status, 'cancelled')
    assert.match(stage(no, 'ok').reason, /Rejected by boss/)
  })

  it('U7.23 removes runs and stashes beyond keep in the hourly cleanup, but not a run being restarted', async () => {
    await project('kept', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.workflow('build', { keep: { runs: 1 } }, () => {})
  m.stage('one', { on: 'linux', run: quick })
  m.workflow('stashy', { triggers: [{ request: true }], keep: { stashes: 1 }, params: { wait: { type: 'boolean', default: false } } }, (w) => {
    w.stage('make', { on: 'linux', run: make })
    w.stage('use', { on: 'linux', run: use })
  })
}
export async function quick(ctx: Stage) {}
export async function make(ctx: Stage) { await ctx.fs.write('s.txt', 's'); await ctx.stash('s', 's.txt') }
export async function use(ctx: Stage) { await ctx.unstash('s'); console.log('using'); await ctx.sleep('2s') }
`,
    })
    const retention = c.master.master!.retention
    const older = await finished(c, await request('kept'))
    const newer = await finished(c, await request('kept'))
    const stashOld = await finished(
      c,
      await request('kept', { workflow: 'stashy' }),
    )
    const stashNew = await finished(
      c,
      await request('kept', { workflow: 'stashy' }),
    )
    const restarted = await c.api(
      'POST',
      `/api/v2/runs/${stashOld.id}/restart`,
      { stage: 'use' },
    )
    assert.equal(restarted.status, 201)
    await running(restarted.json.id, 'use', 'using')
    retention.cleanup()
    assert.equal(c.master.master!.run(older.id), undefined)
    assert.notEqual(c.master.master!.run(newer.id), undefined)
    assert.deepEqual(
      c.master.master!.stashes.list(stashOld.id).map((entry) => entry.name),
      ['s'],
      'a run being restarted keeps its stashes',
    )
    await finished(c, restarted.json.id)
    retention.cleanup()
    assert.deepEqual(c.master.master!.stashes.list(stashOld.id), [])
    assert.deepEqual(c.master.master!.stashes.list(stashNew.id), [])
    assert.deepEqual(
      c.master
        .master!.stashes.list(restarted.json.id)
        .map((entry) => entry.name),
      ['s'],
    )
    const cli = await c.api('GET', '/api/v2/runs?project=kept&workflow=build')
    assert.deepEqual(
      cli.json.map((run: Json) => run.id),
      [newer.id],
    )
  })

  it('U7.24 lists, filters and acts on runs through /api/v2/runs, refusing bad parameters with 400', async () => {
    const list = await c.api('GET', '/api/v2/runs?project=posts&status=failed')
    assert.equal(list.status, 200)
    assert(
      list.json.length >= 2 &&
        list.json.every(
          (run: Json) => run.status === 'failed' && run.project === 'posts',
        ),
    )
    assert(list.json[0].created >= list.json[1].created, 'newest first')
    const bad = await c.api('POST', '/api/v2/runs', {
      project: 'posts',
      params: { fail: 'yes' },
    })
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /fail must be true or false/)
    const unknown = await c.api('POST', '/api/v2/runs', {
      project: 'posts',
      params: { nope: 1 },
    })
    assert.equal(unknown.status, 400)
    assert.equal(
      (
        await c.api('POST', '/api/v2/runs', {
          project: 'posts',
          branch: 'nowhere',
        })
      ).status,
      400,
    )
    assert.equal(
      (await c.api('POST', '/api/v2/runs', { project: 'ghost' })).status,
      400,
    )
    const slow = await c.api('POST', '/api/v2/runs', {
      project: 'posts',
      params: { slow: true },
    })
    assert.equal(slow.status, 202)
    await running(slow.json.id, 'main', 'slow')
    assert.deepEqual(
      (await c.api('POST', `/api/v2/runs/${slow.json.id}/cancel`)).json,
      { cancelled: true },
    )
    assert.equal((await finished(c, slow.json.id)).status, 'cancelled')
    assert.equal((await c.api('GET', '/api/v2/runs/nope')).status, 404)
    const logs = await c.api('GET', `/api/v2/runs/${slow.json.id}/logs`)
    assert.match(logs.text, /slow/)
    const tester = c.master.master!.keys.create(
      { role: 'admin', label: 'test' },
      { role: 'tester', name: 'tester' },
    )
    assert.equal(
      (await c.api('GET', '/api/v2/runs', undefined, tester.token)).status,
      403,
    )
    assert.equal(
      (
        await c.api(
          'GET',
          `/api/jobs/${slow.json.id}/logs`,
          undefined,
          tester.token,
        )
      ).status,
      403,
    )
    assert.equal(
      (await c.api('POST', '/api/v2/runs/nope/approve', {})).status,
      400,
    )
    // A new commit that adds a parameter accepts it at once.
    const posts = c.repo('fixtures/posts')
    posts.commit({
      'Masonfile.ts': readFileSync(
        path.join(posts.work, 'Masonfile.ts'),
        'utf8',
      ).replace(
        "soft: { type: 'boolean', default: false }",
        "soft: { type: 'boolean', default: false }, extra: { type: 'boolean', default: false }",
      ),
    })
    const added = await c.api('POST', '/api/v2/runs', {
      project: 'posts',
      params: { extra: true },
    })
    assert.equal(added.status, 202, added.text)
    assert.equal((await finished(c, added.json.id)).status, 'succeeded')
    const again = await c.api('POST', '/api/v2/runs', {
      project: 'posts',
      params: { extra: 'no' },
    })
    assert.equal(again.status, 400, "the new commit's graph is known now")
  })

  it('U7.25 sets the run description through the master and looks up outputs of stages that finished later, waiting while the link is down', async () => {
    await project('outputs', {
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('later', { on: 'linux', run: later })
  m.stage('waiter', { needs: [], on: 'mac', run: waiter })
}
export async function later(ctx: Stage) { ctx.describe('z'.repeat(300)); await ctx.sleep('3s'); return 'late' }
export async function waiter(ctx: Stage) {
  console.log('asking')
  const value = await ctx.output('later')
  let ghost = ''
  try { await ctx.output('ghost') } catch (error) { ghost = (error as Error).message }
  ctx.describe('Final words')
  return { value, ghost }
}
`,
    })
    const id = await request('outputs')
    await running(id, 'waiter', 'asking')
    await c.drop('beta', 1500)
    const run = await finished(c, id)
    assert.equal(run.status, 'succeeded', JSON.stringify(run))
    assert.deepEqual(stage(run, 'waiter').output, {
      value: 'late',
      ghost: 'Unknown stage ghost',
    })
    assert.equal(run.description, 'Final words')
    const capped = await finished(c, await request('outputs'))
    assert(['Final words', 'z'.repeat(200)].includes(capped.description))
    assert(String(capped.description).length <= 200)
  })

  it('U6.7/U7.3 runs a script project as one build stage with every secret and file, as the builder did', async () => {
    const repo = c.repo('fixtures/script')
    repo.commit({
      'Masonfile.ts': `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const e = process.env
console.log('secret is', e.SCRIPT_SECRET)
writeFileSync(e.MASON_RESULT_FILE!, JSON.stringify({
  app: e.MASON_APP, branch: e.MASON_BRANCH, job: e.MASON_JOB_ID, platforms: e.MASON_PLATFORMS,
  plain: e.PLAIN, secret: (e.SCRIPT_SECRET ?? '').length, file: readFileSync(e.CONFIG_FILE!, 'utf8'),
  injected: existsSync('config/app.json'), commit: e.MASON_COMMIT?.length,
}))
if (e.MASON_BRANCH === 'feature/fail') process.exit(3)
`,
    })
    repo.commit({}, 'feature/fail')
    c.master.master!.saveProject({ role: 'admin', label: 'test' }, 'script', {
      repository: repo.url,
      format: 'script',
      script: { platforms: ['ios', 'android'], on: 'linux' },
      rules: [
        { pattern: 'master', mode: 'request' },
        { pattern: 'feature/**', mode: 'request' },
      ],
      secrets: {
        env: [
          { name: 'PLAIN', value: 'visible', secret: false },
          { name: 'SCRIPT_SECRET', value: 'shh-secret-value', secret: true },
        ],
        files: [
          {
            destination: 'config/app.json',
            contents: Buffer.from('{"k":1}').toString('base64'),
            env: 'CONFIG_FILE',
          },
        ],
      },
    })
    const created = await c.api('POST', '/api/jobs', {
      app: 'script',
      platforms: ['ios'],
    })
    const run = await finished(c, created.json.id)
    assert.equal(
      run.status,
      'succeeded',
      c.master.master!.scheduler.logs(run.id),
    )
    assert.deepEqual(stage(run, 'build').output, {
      app: 'script',
      branch: 'master',
      job: run.id,
      platforms: 'ios',
      plain: 'visible',
      secret: 16,
      file: '{"k":1}',
      injected: true,
      commit: 40,
    })
    assert.deepEqual(
      (await c.api('GET', `/api/jobs/${run.id}`)).json.result,
      stage(run, 'build').output,
    )
    assert.match(
      c.master.master!.scheduler.logs(run.id)!,
      /secret is \[redacted\]/,
    )
    const failed = await finished(
      c,
      (
        await c.api('POST', '/api/jobs', {
          app: 'script',
          branch: 'feature/fail',
        })
      ).json.id,
    )
    assert.equal(failed.status, 'failed')
    assert.equal(failed.exit_code, 3)
    assert.match(
      c.master.master!.scheduler.logs(failed.id)!,
      /Build execution did not complete successfully/,
    )
  })

  it('restores and saves caches, checks out another listed repository, tags locally, and stashes while the master is away', async () => {
    const other = c.repo('fixtures/other')
    other.commit({ 'README.md': 'the other repository' })
    await project(
      'extras',
      {
        'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('cached', { on: 'linux', cache: [{ key: 'deps', paths: ['deps'] }], run: cached })
  m.stage('extra', { on: 'linux', checkout: false, run: extra })
  m.stage('stasher', { on: 'mac', run: stasher })
  m.stage('reader', { on: 'linux', run: reader })
}
export async function cached(ctx: Stage) {
  let before = false
  try { before = (await ctx.fs.read('deps/a.txt')) === 'dep' } catch {}
  await ctx.fs.write('deps/a.txt', 'dep')
  await ctx.fs.write('manual/b.txt', 'manual')
  await ctx.cache.save('manual', ['manual'])
  const missing = await ctx.cache.restore('nothing-saved', ['x'])
  const restored = await ctx.cache.restore('manual', ['manual'])
  await ctx.git.tag('local-' + ctx.run.number)
  const tags = (await ctx.sh('git tag -l', { quiet: true })).stdout.trim()
  return { before, missing, restored, tags }
}
export async function extra(ctx: Stage) {
  await ctx.checkout({ repository: 'https://github.com/fixtures/other.git', path: 'other' })
  let refused = ''
  try { await ctx.checkout({ repository: 'https://github.com/fixtures/secret.git', path: 'secret' }) } catch (error) { refused = (error as Error).message }
  return { readme: await ctx.fs.read('other/README.md'), refused, empty: (await ctx.fs.glob('Masonfile.ts')).length }
}
export async function stasher(ctx: Stage) {
  console.log('stashing soon')
  await ctx.sleep('1s')
  await ctx.fs.write('late.txt', 'made while away')
  await ctx.stash('late', 'late.txt')
}
export async function reader(ctx: Stage) { await ctx.unstash('late'); return await ctx.fs.read('late.txt') }
`,
      },
      { repositories: [other.url] },
    )
    const first = await request('extras')
    await running(first, 'stasher', 'stashing soon')
    await c.drop('beta', 2500)
    const one = await finished(c, first)
    assert.equal(
      one.status,
      'succeeded',
      c.master.master!.scheduler.logs(first),
    )
    assert.deepEqual(stage(one, 'cached').output, {
      before: false,
      missing: false,
      restored: true,
      tags: 'local-1',
    })
    assert.deepEqual(stage(one, 'extra').output, {
      readme: 'the other repository',
      refused: 'That repository is not one this project lists',
      empty: 0,
    })
    assert.equal(stage(one, 'reader').output, 'made while away')
    const two = await finished(c, await request('extras'))
    assert.equal(
      stage(two, 'cached').output.before,
      true,
      'the cache was restored before the stage',
    )
  })

  it('answers the runs, nodes and recover commands', async () => {
    const lines: string[] = []
    const errors: string[] = []
    const io = {
      out: (line: string) => lines.push(line),
      err: (line: string) => errors.push(line),
    } as never
    assert.equal(
      await nodeMain(
        [
          'runs',
          'list',
          '--project',
          'script',
          '--status',
          'failed',
          '--data',
          c.master.dir,
        ],
        io,
      ),
      0,
      errors.join('\n'),
    )
    assert.match(lines.pop()!, /script build #2 {2}feature\/fail {2}failed/)
    assert.equal(
      await nodeMain(
        [
          'runs',
          'list',
          '--project',
          'script',
          '--json',
          '--limit',
          '1',
          '--data',
          c.master.dir,
        ],
        io,
      ),
      0,
    )
    assert.equal(JSON.parse(lines.pop()!)[0].project, 'script')
    assert.equal(
      await nodeMain(['runs', 'cleanup', '--data', c.master.dir], io),
      0,
    )
    assert.match(
      lines.pop()!,
      /^Removed \d+ run\(s\), the stashes of \d+ run\(s\) and \d+ unused graph\(s\)\.$/,
    )
    assert.equal(
      await nodeMain(
        [
          'nodes',
          'set',
          'alpha',
          '--slots',
          '3',
          '--label',
          'fast',
          '--type',
          'linux',
          '--data',
          c.master.dir,
        ],
        io,
      ),
      0,
      errors.join('\n'),
    )
    assert.equal(lines.pop(), 'alpha: type linux, labels fast, 3 slot(s)')
    assert.equal(
      await nodeMain(
        [
          'nodes',
          'set',
          'alpha',
          '--slots',
          '2',
          '--label',
          'fast',
          '--name',
          'alpha',
          '--workspace-root',
          '/tmp/x',
          '--json',
          '--data',
          c.master.dir,
        ],
        io,
      ),
      0,
    )
    assert.deepEqual(JSON.parse(lines.pop()!).workspaceRoots, ['/tmp/x'])
    assert.equal(
      await nodeMain(['nodes', 'set', 'nobody', '--data', c.master.dir], io),
      1,
    )
    assert.match(errors.pop()!, /No such node/)
    assert.equal(
      await nodeMain(['runs', 'what', '--data', c.master.dir], io),
      1,
    )
    c.workers.get('alpha')!.worker!.journal.setQuarantine('stuck')
    assert.equal(
      await nodeMain(['recover', '--data', c.workers.get('alpha')!.dir], io),
      0,
    )
    assert.equal(
      lines.pop(),
      'Quarantine cleared; the worker takes stages again.',
    )
    assert.equal(
      c.workers.get('alpha')!.worker!.journal.quarantine(),
      undefined,
    )
  })
})

describe('A master with its own worker', function () {
  this.timeout(120000)

  it('keeps the master’s stashes when its own worker forgets a finished run', async () => {
    const c = await cluster(root(), { coWorker: true })
    try {
      const repo = c.repo('fixtures/own')
      repo.commit({
        'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('make', { on: 'master', run: make })
}
export async function make(ctx: Stage) { await ctx.fs.write('a.txt', 'a'); await ctx.stash('a', 'a.txt') }
`,
      })
      c.master.master!.saveProject({ role: 'admin', label: 'test' }, 'own', {
        repository: repo.url,
        rules: [{ pattern: 'master', mode: 'request' }],
      })
      const created = await c.api('POST', '/api/v2/runs', { project: 'own' })
      const run = await finished(c, created.json.id)
      assert.equal(
        run.status,
        'succeeded',
        c.master.master!.scheduler.logs(run.id),
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal(
        existsSync(path.join(c.master.dir, 'stashes', run.id, 'a.tar')),
        true,
      )
      assert.equal(c.master.master!.stashes.kept(run.id, ['make']), true)
      assert.equal(
        existsSync(path.join(c.master.dir, 'worker', 'stashes', run.id)),
        false,
      )
    } finally {
      await c.close()
    }
  })
})

describe('Worker journal and cron schedules', () => {
  it('U7.7 marks runs in progress at a restart interrupted, and refuses stages while quarantined', async () => {
    const dir = root()
    const db = new DatabaseSync(path.join(dir, 'worker.sqlite'))
    const journal = new Journal(db)
    journal.start('job/stage/1', 'stage', { token: 't' })
    journal.append('job/stage/1', 'log', 'hello\n')
    const runtime = new WorkerRuntime({
      dir,
      db,
      version: '1.0.0',
      link: (): undefined => undefined,
      assignment: (): undefined => undefined,
    })
    await runtime.start()
    assert.deepEqual(runtime.journal.get('job/stage/1'), {
      key: 'job/stage/1',
      kind: 'stage',
      assignment: { token: 't' },
      status: 'finished',
      result: {
        status: 'interrupted',
        reason: 'The worker restarted while this ran',
      },
    })
    assert.deepEqual(
      runtime.journal.pending('job/stage/1').map((record) => record.data),
      ['hello\n'],
    )
    runtime.journal.setQuarantine('Build processes remain')
    assert.equal(runtime.inventory().quarantine, 'Build processes remain')
    assert.throws(
      () =>
        (runtime.methods().requests!['stage.run'] as (p: unknown) => unknown)({
          key: 'k',
          token: 't',
        }),
      /quarantined/,
    )
    runtime.recover()
    assert.equal(runtime.inventory().quarantine, undefined)
    assert.throws(
      () =>
        (runtime.methods().requests!['stage.run'] as (p: unknown) => unknown)(
          {},
        ),
      /Invalid assignment/,
    )
    assert.deepEqual(
      (runtime.methods().requests!['stage.cancel'] as (p: unknown) => unknown)({
        key: 'none',
      }),
      { known: false },
    )
    runtime.journal.reported('job/stage/1')
    runtime.journal.prune(Date.now() + 2 * 86400000)
    assert.equal(runtime.journal.get('job/stage/1'), undefined)
    await runtime.stop()
    db.close()
    assert.throws(
      () =>
        new Journal(
          Object.assign(new DatabaseSync(':memory:'), {}) as DatabaseSync,
        ).append('x', 'log', ''),
      /Unknown run/,
    )
  })

  it('names the operating system of each platform', () => {
    assert.equal(platformOs('darwin'), 'macos')
    assert.equal(platformOs('win32'), 'windows')
    assert.equal(platformOs('linux'), 'linux')
    assert.match(osVersion('linux'), /\d/)
    assert.match(osVersion('darwin'), /^\d+\.\d+/)
  })

  it('matches cron entries in a time zone', () => {
    const tz = 'America/Los_Angeles'
    const at = (iso: string): number => Date.parse(iso)
    assert.equal(
      cronMatches(parseCron('0 3 * * *'), at('2026-10-21T10:00:00Z'), tz),
      true,
    )
    assert.equal(
      cronMatches(parseCron('0 3 * * *'), at('2026-10-21T03:00:00Z'), tz),
      false,
    )
    assert.equal(
      cronMatches(
        parseCron('*/15 9-17 * * mon-fri'),
        at('2026-10-21T16:45:00Z'),
        tz,
      ),
      true,
    )
    assert.equal(
      cronMatches(
        parseCron('*/15 9-17 * * mon-fri'),
        at('2026-10-24T16:45:00Z'),
        tz,
      ),
      false,
    )
    assert.equal(
      cronMatches(parseCron('0 0 1 jan *'), at('2027-01-01T08:00:00Z'), tz),
      true,
    )
    assert.equal(
      cronMatches(parseCron('0 12 13 * 5'), at('2026-11-13T20:00:00Z'), tz),
      true,
      'either day field',
    )
    assert.equal(
      cronMatches(parseCron('0 12 13 * 5'), at('2026-11-06T20:00:00Z'), tz),
      true,
      'a Friday',
    )
    assert.equal(
      cronMatches(parseCron('0 12 13 * 5'), at('2026-11-07T20:00:00Z'), tz),
      false,
    )
    assert.equal(
      cronMatches(parseCron('0 0 * * 7'), at('2026-10-25T07:00:00Z'), tz),
      true,
      '7 is Sunday',
    )
    assert.equal(
      cronMatches(parseCron('5,10 * * * *'), at('2026-10-21T10:10:00Z'), tz),
      true,
    )
    for (const bad of [
      '* * * *',
      '61 * * * *',
      '* * * * 8',
      'x * * * *',
      '*/0 * * * *',
      '5-1 * * * *',
    ])
      assert.throws(() => parseCron(bad), /cron|range|step|5-field/i, bad)
  })
})
