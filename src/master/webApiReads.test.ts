import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { WebSocket } from 'ws'
import type { RunningNode } from '../node/serve.js'
import {
  asAccountInfo,
  asArtifactRunDetail,
  asArtifactsList,
  asBuildViews,
  asDashboardData,
  asLayout,
  asMasonfileCommits,
  asMasonfileText,
  asNotifications,
  asProjectApp,
  asProjectOverview,
  asProjectRuns,
  asQueue,
  asRunGraph,
  asRunPage,
  asSearchResults,
  asStatusInfo,
} from '../shared/api/index.js'
import type { LiveFrame } from '../shared/live.js'
import type { Role } from '../shared/permissions.js'
import { FakeLiveSource } from '../test/fakeLiveSource.js'
import { proofLog } from '../test/proofLog.js'
import {
  ALPHA,
  BETA,
  readFixture,
  shape,
  type ReadFixture,
  type Reply,
  type Who,
} from '../test/readFixture.js'
import { LiveSession } from './live.js'
import { backupNotice } from './reads.js'
import { masonfileTooLarge } from './scheduler.js'
import { localOperator } from './roles.js'

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'reads-'))

const roles: Role[] = ['tester', 'developer', 'manager', 'admin']

describe('Master web API: the pages’ reads', function () {
  this.timeout(300_000)
  let f: ReadFixture
  let master: RunningNode
  const as = (role: Role): Who => f.on('master', role)
  const get = async (route: string, who: Who): Promise<Reply> =>
    await f.request(master, 'GET', route, who)
  /** Which roles a route answers 200 for, and the status the others get. */
  const matrix = async (
    route: string,
    allowed: Role[],
    refused = 403,
  ): Promise<void> => {
    for (const role of roles) {
      const reply = await get(route, as(role))
      assert.equal(
        reply.status,
        allowed.includes(role) ? 200 : refused,
        `${role} ${route}: ${reply.text}`,
      )
    }
    assert.equal((await get(route, {})).status, 401, `${route} unsigned`)
  }

  before(async () => {
    f = await readFixture(root())
    master = f.c.master
  })
  after(async () => {
    await f?.c.close()
  })

  it('GET /api/v2/status: the workers and the banners, for everyone signed in', async () => {
    await matrix('/api/v2/status', roles)
    const admin = shape(
      asStatusInfo,
      (await get('/api/v2/status', as('admin'))).json,
    )
    assert.equal(admin.node, 'master')
    assert.deepEqual(admin.cluster, { idle: 1, total: 1, healthy: true })
    assert.deepEqual(admin.banners[0], {
      kind: 'testEndpoints',
      text: 'Test endpoints are enabled on this Mason node.',
    })
    const notice = backupNotice(master.master!, {
      role: 'admin',
      accountId: f.people.admin,
      label: 'admin',
    })
    assert.equal(
      admin.banners.find((banner) => banner.kind === 'backup')?.text,
      notice,
    )
    // The backup reminder is for those who may configure backups.
    const tester = (await get('/api/v2/status', as('tester'))).json
    assert.equal(
      tester.banners.some(
        (banner: { kind: string }) => banner.kind === 'backup',
      ),
      false,
    )
    assert.equal(
      (await get('/api/v2/status', { key: f.keys.developer })).status,
      200,
    )
  })

  it('GET /api/v2/notifications: the approvals a person may decide, and the master’s notices for managers', async () => {
    await matrix('/api/v2/notifications', roles)
    const manager = shape(
      asNotifications,
      (await get('/api/v2/notifications', as('manager'))).json,
    )
    assert.equal(manager[0]!.kind, 'approval')
    assert.match(
      manager[0]!.text,
      /^reads .* \(release\) waits for your approval at approve$/,
    )
    assert.equal(manager[0]!.href, `/runs/${f.runs.waiting}`)
    assert.deepEqual(
      manager.slice(1),
      master.master!.notices().map((text) => ({ kind: 'notice', text })),
    )
    // The approval names managers (and administrators decide every one).
    for (const role of ['tester', 'developer'] as const)
      assert.deepEqual(
        (await get('/api/v2/notifications', as(role))).json,
        [],
        role,
      )
    // A key scoped to another project sees no approval of this one.
    assert.deepEqual(
      (await get('/api/v2/notifications', { key: f.keys.scoped })).json,
      [],
    )
  })

  it('GET /api/v2/search: projects, app IDs, runs and branches within what the person may see', async () => {
    await matrix('/api/v2/search?q=reads', roles)
    const developer = shape(
      asSearchResults,
      (await get('/api/v2/search?q=reads', as('developer'))).json,
    )
    assert.deepEqual(developer[0], {
      kind: 'project',
      label: 'Reads',
      detail: 'reads',
      href: '/projects/reads',
    })
    const tester = (await get('/api/v2/search?q=example', as('tester'))).json
    assert.deepEqual(
      tester.map((result: { label: string }) => result.label),
      [ALPHA],
    )
    assert.match(tester[0].href, /^\/apps\/\d+$/)
    assert.deepEqual((await get('/api/v2/search', as('admin'))).json, [])
    assert.equal(
      (await get('/api/v2/search?q=reads', { key: f.keys.scoped })).status,
      403,
    )
  })

  it('GET /api/v2/dashboard: everything Projects & apps shows, with the master’s workers', async () => {
    await matrix('/api/v2/dashboard', ['developer', 'manager', 'admin'])
    const data = shape(
      asDashboardData,
      (await get('/api/v2/dashboard', as('developer'))).json,
    )
    assert.equal(data.counts.android >= 1, true)
    const card = data.projects.find((project) => project.slug === 'reads')!
    assert.equal(card.slug, 'reads')
    assert.equal(card.repository != null, true)
    assert.deepEqual(
      card.apps.map((app) => [app.slug, app.builds.map((b) => b.buildNumber)]),
      [
        [ALPHA, ['7']],
        [BETA, []],
      ],
    )
    assert.equal(data.nodes!.length, 1)
    assert.equal(data.nodes![0]!.status, 'idle')
    const filtered = (
      await get('/api/v2/dashboard?platform=ios&project=reads', as('admin'))
    ).json
    assert.deepEqual(filtered.filter, { platform: 'ios', project: 'reads' })
    assert.equal(
      (await get('/api/v2/dashboard', { key: f.keys.developer })).status,
      200,
    )
    assert.equal(
      (await get('/api/v2/dashboard', { key: f.keys.scoped })).status,
      403,
    )
  })

  it('GET /api/v2/queue: the running and queued stages, within a key’s scopes', async () => {
    await matrix('/api/v2/queue', ['developer', 'manager', 'admin'])
    // The release run's stage after its approval waits in the queue.
    const queue = shape(
      asQueue,
      (await get('/api/v2/queue', as('developer'))).json,
    )
    assert.deepEqual(
      queue.map((entry) => [entry.job, entry.stage, entry.status]),
      [[f.runs.waiting, 'ship', 'queued']],
    )
    assert.deepEqual(
      (await get('/api/v2/queue', { key: f.keys.scoped })).json,
      [],
    )
  })

  it('GET /api/v2/artifacts: the latest runs with their build numbers and saved artifacts', async () => {
    await matrix('/api/v2/artifacts', ['developer', 'manager', 'admin'])
    const list = shape(
      asArtifactsList,
      (
        await get(
          '/api/v2/artifacts?project=reads&branch=master',
          as('developer'),
        )
      ).json,
    )
    assert.deepEqual(list.project, { slug: 'reads', name: 'Reads' })
    assert.equal(list.branch, 'master')
    const row = list.runs.find((run) => run.id === f.runs.built)!
    assert.deepEqual(
      [row.buildNumbers, row.builds, row.artifacts, row.project],
      [['7'], 1, { count: 1, size: 42 }, { slug: 'reads', name: 'Reads' }],
    )
    const all = (await get('/api/v2/artifacts', as('admin'))).json
    assert.deepEqual(
      all.runs.map((run: { id: string }) => run.id).sort(),
      [f.runs.built, f.runs.waiting].sort(),
    )
    // A key scoped elsewhere reads its own projects only.
    assert.equal(
      (await get('/api/v2/artifacts?project=reads', { key: f.keys.scoped }))
        .status,
      403,
    )
    assert.deepEqual(
      (await get('/api/v2/artifacts?project=elsewhere', { key: f.keys.scoped }))
        .json.runs,
      [],
    )
  })

  it('GET /api/v2/artifacts/runs/:id: stages, tests, published builds and saved artifacts at the host’s origin', async () => {
    const route = `/api/v2/artifacts/runs/${f.runs.built}`
    await matrix(route, ['developer', 'manager', 'admin'])
    const detail = shape(
      asArtifactRunDetail,
      (await get(route, as('developer'))).json,
    )
    const hostOrigin = f.origin(f.host)
    assert.equal(detail.artifactOrigin, hostOrigin)
    assert.equal(detail.run.id, f.runs.built)
    assert.deepEqual(
      detail.stages.map((stage) => [stage.name, stage.status]),
      [['compile', 'succeeded']],
    )
    assert.deepEqual(detail.tests, [
      { stage: 'compile', passed: 3, failed: 1, skipped: 2 },
    ])
    assert.deepEqual(
      detail.builds.map((build) => [build.id, build.app, build.buildNumber]),
      [[f.build, 'Alpha', '7']],
    )
    const base = `${hostOrigin}/runs/${f.runs.built}/artifacts/report.html`
    assert.deepEqual(
      [detail.artifacts[0]!.url, detail.artifacts[0]!.viewUrl],
      [base, `${base}/view`],
    )
    assert.equal(
      (await get('/api/v2/artifacts/runs/nope', as('developer'))).status,
      404,
    )
    assert.equal((await get(route, { key: f.keys.scoped })).status, 403)
  })

  it('GET /api/v2/runs/:id?include=…: the run page in one request; without include, the run as before', async () => {
    const route = `/api/v2/runs/${f.runs.built}?include=graph,steps,history,details`
    await matrix(route, ['developer', 'manager', 'admin'])
    const page = shape(asRunPage, (await get(route, as('developer'))).json)
    assert.deepEqual(
      [page.id, page.workflow, page.branch, page.status, page.project],
      [
        f.runs.built,
        'build',
        'master',
        'succeeded',
        { slug: 'reads', name: 'Reads' },
      ],
    )
    shape(asRunGraph, page.graph)
    shape(asLayout, page.layout)
    assert.deepEqual(
      page.graph!.stages.map((stage) => stage.name),
      ['compile'],
    )
    assert.equal(
      page.layout!.bubbles.find((bubble) => bubble.name === 'compile')!.status,
      'succeeded',
    )
    // Every stage's steps, with where their lines are in its log.
    assert.equal(Array.isArray(page.steps), true)
    assert.deepEqual(
      page.history!.map((entry) => entry.id),
      [f.runs.built],
    )
    assert.equal(page.details!.trigger, 'request')
    assert.equal(page.details!.repository != null, true)
    assert.deepEqual(page.details!.nodes, [page.stages[0]!.node])
    assert.deepEqual(page.artifacts, [
      { stage: 'compile', name: 'report.html', kind: 'report', size: 42 },
    ])
    // Only the parts asked for.
    const bare = (
      await get(`/api/v2/runs/${f.runs.built}?include=`, as('developer'))
    ).json
    assert.deepEqual(
      ['graph', 'layout', 'steps', 'history', 'details'].filter(
        (part) => part in bare,
      ),
      [],
    )
    // A run at its approval: who decides it, and where it waits.
    const waiting = (
      await get(`/api/v2/runs/${f.runs.waiting}?include=graph`, as('developer'))
    ).json
    assert.deepEqual(waiting.graph.approvals.approve.roles, ['manager'])
    assert.equal(
      waiting.layout.bubbles.find(
        (bubble: { name: string }) => bubble.name === 'approve',
      ).status,
      'awaiting_approval',
    )
    const bad = await get(
      `/api/v2/runs/${f.runs.built}?include=graph,everything`,
      as('developer'),
    )
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /not everything/)
    assert.equal(
      (await get('/api/v2/runs/nope?include=graph', as('developer'))).status,
      404,
    )
    // Without include, the answer API clients already read.
    const plain = (await get(`/api/v2/runs/${f.runs.built}`, as('developer')))
      .json
    assert.equal(plain.stages[0].display, 'succeeded')
    assert.equal(plain.layout, undefined)
  })

  it('GET /api/v2/projects/:slug/overview: details, sequences and what the person may seed', async () => {
    const route = '/api/v2/projects/reads/overview'
    await matrix(route, ['developer', 'manager', 'admin'])
    const developer = shape(
      asProjectOverview,
      (await get(route, as('developer'))).json,
    )
    assert.deepEqual(
      [developer.slug, developer.name, developer.canSeed, developer.secrets],
      ['reads', 'Reads', false, true],
    )
    assert.deepEqual(developer.appNames, [
      { bundleId: ALPHA, name: 'Alpha' },
      { bundleId: BETA, name: 'Beta' },
    ])
    assert.deepEqual(
      developer.buildNumbers.map((sequence) => [sequence.key, sequence.apps]),
      [[ALPHA, [BETA]]],
    )
    assert.equal((await get(route, as('manager'))).json.canSeed, true)
    assert.equal(
      (await get('/api/v2/projects/nope/overview', as('admin'))).status,
      404,
    )
    assert.equal((await get(route, { key: f.keys.scoped })).status, 403)
  })

  it('GET /api/v2/projects/:slug/runs: branches, pinned first, and runs with build numbers, for the project or an app ID', async () => {
    const route = '/api/v2/projects/reads/runs'
    await matrix(route, ['developer', 'manager', 'admin'])
    const runs = shape(asProjectRuns, (await get(route, as('developer'))).json)
    assert.deepEqual(
      runs.branches.map((branch) => branch.branch),
      ['release', 'master'],
    )
    const row = runs.runs.find((run) => run.id === f.runs.built)!
    // The number the run reserved from its sequence, else what it published.
    assert.equal(row.version, '1.2')
    assert.equal(
      row.buildNumber,
      (
        await get(
          `/api/v2/runs/${f.runs.built}?include=details`,
          as('developer'),
        )
      ).json.details.buildNumber ?? '7',
    )
    const one = (await get(`${route}?branch=master&app=${ALPHA}`, as('admin')))
      .json
    assert.deepEqual(one.app, {
      id: one.app.id,
      bundleId: ALPHA,
      name: 'Alpha',
      platforms: one.app.platforms,
    })
    assert.deepEqual([...one.app.platforms].sort(), ['android', 'ios'])
    assert.equal(one.branch, 'master')
    assert.deepEqual(
      one.runs.map((run: { id: string }) => run.id),
      [f.runs.built],
    )
    assert.equal(
      (await get(`${route}?app=com.example.none`, as('admin'))).status,
      404,
    )
  })

  it('GET /api/v2/projects/:slug/apps/:appId: the app ID, its sequence and the app IDs sharing it', async () => {
    const route = `/api/v2/projects/reads/apps/${BETA}`
    await matrix(route, ['developer', 'manager', 'admin'])
    const beta = shape(asProjectApp, (await get(route, as('manager'))).json)
    assert.deepEqual(
      [beta.app.bundleId, beta.sequence?.key, beta.shared, beta.canSeed],
      [BETA, ALPHA, [ALPHA], true],
    )
    assert.deepEqual(beta.defaultScheme, { format: 'N', scope: 'app' })
    const alpha = (
      await get(`/api/v2/projects/reads/apps/${ALPHA}`, as('developer'))
    ).json
    assert.deepEqual([alpha.shared, alpha.canSeed], [[BETA], false])
    assert.equal(
      (await get('/api/v2/projects/reads/apps/com.example.none', as('admin')))
        .status,
      404,
    )
  })

  it('GET /api/v2/projects/:slug/masonfile(/commits): the kept copy first, then the mirror', async () => {
    await matrix('/api/v2/projects/reads/masonfile/commits', [
      'developer',
      'manager',
      'admin',
    ])
    const commits = shape(
      asMasonfileCommits,
      (await get('/api/v2/projects/reads/masonfile/commits', as('developer')))
        .json,
    )
    assert.deepEqual(
      commits.map((commit) => commit.branch),
      ['release', 'master'],
    )
    const sha = commits[1]!.sha
    const read = async (): Promise<Reply> =>
      await get(
        `/api/v2/projects/reads/masonfile?commit=${sha}`,
        as('developer'),
      )
    // Without a commit, the newest run's.
    assert.equal(
      (await get('/api/v2/projects/reads/masonfile', as('developer'))).json
        .commit,
      commits[0]!.sha,
    )
    const kept = shape(asMasonfileText, (await read()).json)
    assert.deepEqual([kept.commit, kept.file], [sha, 'Masonfile.ts'])
    assert.match(kept.text, /ctx\.log\.info\('compiled'\)/)
    const db = master.master!.database.db
    const key = `${master.master!.projects.get('reads').id}:${sha}`
    const original = String(
      db.prepare('SELECT text FROM masonfiles WHERE key=?').get(key)!.text,
    )
    try {
      // The kept copy wins over the mirror.
      db.prepare('UPDATE masonfiles SET text=? WHERE key=?').run('// kept', key)
      assert.equal((await read()).json.text, '// kept')
      // One too large to keep is read from the mirror.
      db.prepare('UPDATE masonfiles SET text=? WHERE key=?').run(
        masonfileTooLarge('Masonfile.ts'),
        key,
      )
      assert.equal((await read()).json.text, original)
    } finally {
      db.prepare('UPDATE masonfiles SET text=? WHERE key=?').run(original, key)
    }
    const missing = await get(
      `/api/v2/projects/reads/masonfile?commit=${'0'.repeat(40)}`,
      as('developer'),
    )
    assert.equal(missing.status, 404, missing.text)
    assert.equal(
      (await get('/api/v2/projects/nope/masonfile', as('developer'))).status,
      404,
    )
    // A script project has no Masonfile, and one with no run no commit yet.
    master.master!.saveProject(localOperator, 'scripted', {
      repository: 'https://github.com/example/scripted',
      format: 'script',
      script: { platforms: ['android'] },
    })
    master.master!.saveProject(localOperator, 'unbuilt', {
      repository: 'https://github.com/example/unbuilt',
    })
    for (const [slug, error] of [
      ['scripted', 'This project builds from a script; it has no Masonfile.'],
      ['unbuilt', 'No run has a commit yet.'],
    ] as const) {
      const reply = await get(
        `/api/v2/projects/${slug}/masonfile`,
        as('developer'),
      )
      assert.deepEqual([reply.status, reply.json], [404, { error }])
    }
  })

  it('GET /api/v2/account: the person’s own record; a key has none', async () => {
    await matrix('/api/v2/account', roles)
    const account = shape(
      asAccountInfo,
      (await get('/api/v2/account', as('developer'))).json,
    )
    assert.deepEqual(account, {
      id: f.people.developer,
      name: 'Read developer',
      role: 'developer',
      password: false,
      emails: [{ email: 'read.developer@example.test', confirmed: true }],
      editable: true,
      passwordHere: true,
    })
    assert.deepEqual(
      (await get('/api/v2/account', { key: f.keys.developer })).json,
      { error: 'Sign in: an API key has no account' },
    )
  })

  it('GET /api/v2/builds?run=: the builds one run published', async () => {
    const mine = shape(
      asBuildViews,
      (await get(`/api/v2/builds?run=${f.runs.built}`, as('developer'))).json,
    )
    assert.deepEqual(
      mine.map((build) => [build.id, build.run]),
      [[f.build, f.runs.built]],
    )
    assert.deepEqual(
      (await get(`/api/v2/builds?run=${f.runs.waiting}`, as('developer'))).json,
      [],
    )
    // The tester sees alpha's build through her group.
    assert.equal(
      (await get(`/api/v2/builds?run=${f.runs.built}`, as('tester'))).json
        .length,
      1,
    )
  })

  it('/live status: the shell’s workers and banners for anyone signed in, a run’s status unchanged', async () => {
    const url = master.web!.url.replace(/^https:\/\/[^:]+:/, 'wss://127.0.0.1:')
    const session = as('tester') as { cookie: string }
    const ws = new WebSocket(`${url}/live`, {
      headers: {
        cookie: session.cookie,
        origin: master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:'),
      },
      rejectUnauthorized: false,
    })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const frames: LiveFrame[] = []
    ws.on('message', (data) => {
      frames.push(JSON.parse(String(data)) as LiveFrame)
    })
    ws.send(JSON.stringify({ subscribe: 'status', key: 'shell' }))
    ws.send(
      JSON.stringify({ subscribe: 'status', run: f.runs.built, key: 'run' }),
    )
    await f.c.until(() => frames.length >= 2, 5000, 'two frames')
    ws.close()
    proofLog(
      'WS master/live {subscribe:status} (tester session)',
      JSON.stringify(frames),
    )
    const shell = frames.find((frame) => frame.key === 'shell')!
    assert.equal(shell.event, 'status')
    assert.deepEqual(shape(asStatusInfo, shell.data).cluster, {
      idle: 1,
      total: 1,
      healthy: true,
    })
    // A tester may not read runs: the run's status is refused as before.
    const run = frames.find((frame) => frame.key === 'run')!
    assert.equal(run.event, 'error')
  })
})

describe('Live shell status', () => {
  const open = (
    source: FakeLiveSource,
  ): { session: LiveSession; frames: LiveFrame[]; closed: number[] } => {
    const frames: LiveFrame[] = []
    const closed: number[] = []
    const viewer = { role: 'developer' as const, label: 'test' }
    let signedIn = true
    const session = new LiveSession(
      source,
      () => (signedIn ? viewer : undefined),
      {
        send: (text): void => {
          frames.push(JSON.parse(text) as LiveFrame)
        },
        close: (code): void => {
          closed.push(code)
          signedIn = false
        },
      },
    )
    return { session, frames, closed }
  }

  it('sends the status when it changes: on a run’s change and on the clock; one without a status refuses', async function () {
    this.timeout(10_000)
    const source = new FakeLiveSource(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'shell-'),
      ),
    )
    const none = open(source)
    none.session.receive(JSON.stringify({ subscribe: 'status' }))
    assert.deepEqual(none.frames, [
      {
        key: 'status',
        event: 'error',
        data: { error: 'This node has no status to follow' },
      },
    ])
    none.session.end()
    let idle = 1
    const status = (): {
      node: 'master'
      cluster: { idle: number; total: number; healthy: boolean }
      banners: []
    } => ({
      node: 'master',
      cluster: { idle, total: 2, healthy: true },
      banners: [],
    })
    const withStatus = Object.assign(source, { status })
    const { session, frames, closed } = open(withStatus)
    session.receive(JSON.stringify({ subscribe: 'status', key: 'a' }))
    session.receive(JSON.stringify({ subscribe: 'status', key: 'b' }))
    assert.deepEqual(
      frames.map((frame) => [frame.key, frame.event]),
      [
        ['a', 'status'],
        ['b', 'status'],
      ],
    )
    // A log line changes nothing; a run's change does.
    source.notify({ kind: 'log', run: 'r', stage: 's' })
    idle = 2
    source.notify({ kind: 'log', run: 'r', stage: 's' })
    assert.equal(frames.length, 2)
    source.notify({ kind: 'run', run: 'r' })
    assert.equal(frames.length, 4)
    // Unchanged, nothing more; changed, on the next tick.
    source.notify({ kind: 'run', run: 'r' })
    assert.equal(frames.length, 4)
    session.receive(JSON.stringify({ unsubscribe: 'b' }))
    idle = 0
    await new Promise((resolve) => setTimeout(resolve, 2200))
    assert.deepEqual(
      frames
        .slice(4)
        .map((frame) => [
          frame.key,
          (frame.data as { cluster: { idle: number } }).cluster.idle,
        ]),
      [['a', 0]],
    )
    // A viewer who signed out is closed at the next change.
    session.receive(JSON.stringify({ subscribe: 'queue', key: 'q' }))
    closed.push(0)
    session.end()
    session.receive(JSON.stringify({ unsubscribe: 'a' }))
    assert.deepEqual(closed, [0])
  })
})
