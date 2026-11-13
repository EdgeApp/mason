import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { SESSION_COOKIE } from '../auth/routes.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { assertShell, type ShellReply } from '../test/webShell.js'
import { MASTER_SESSION_COOKIE } from './auth.js'
import { localOperator } from './roles.js'

// Rows and answers are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const ALPHA = 'com.example.alpha'
const BETA = 'com.example.beta'
const GAMMA = 'com.example.gamma'
const DELTA = 'com.example.delta'
const HIDDEN = 'com.example.hidden'
const OTHER = 'com.example.other'

/**
 * build-alpha publishes alpha and build-beta beta; ship-alpha publishes
 * alpha only from a post stage. Alpha's own sequence is shared with beta,
 * gamma has its own per-branch sequence and delta none.
 */
const masonfile = `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber('${ALPHA}', { format: 'YYMMDDCC', apps: ['${BETA}'] })
  m.buildNumber('${GAMMA}', { scope: 'branch' })
  m.workflow('build-alpha', { triggers: [{ request: true }] }, (w) => {
    w.stage('android', { on: 'master', publishes: ['${ALPHA}'], run: nothing })
  })
  m.workflow('build-beta', { triggers: [{ request: true }] }, (w) => {
    w.stage('macos', { on: 'master', publishes: ['${BETA}'], run: nothing })
  })
  m.workflow('ship-alpha', { triggers: [{ request: true }] }, (w) => {
    w.stage('check', { on: 'master', run: nothing })
    w.post({ always: { on: 'master', publishes: ['${ALPHA}'], run: nothing } })
  })
}
export async function nothing(ctx: Stage) {
  ctx.log.info('nothing to build')
}
`

interface Reply {
  status: number
  text: string
  json: Json
  headers: ShellReply['headers']
}

describe('App ID pages on the master and the host', function () {
  this.timeout(300_000)
  let c: Cluster
  let host: RunningNode
  const people: Record<string, number> = {}
  const runs: Record<string, string> = {}

  const origin = (node: RunningNode): string =>
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  const request = async (
    node: RunningNode,
    route: string,
    options: {
      method?: string
      cookie?: string
      csrf?: string
      body?: unknown
    } = {},
  ): Promise<Reply> => {
    const response = await pinnedFetch(
      origin(node) + route,
      {
        method: options.method ?? 'GET',
        redirect: 'manual',
        headers: {
          ...(options.cookie == null ? {} : { cookie: options.cookie }),
          ...(options.csrf == null
            ? {}
            : { 'x-mason-csrf': options.csrf, origin: origin(node) }),
          ...(options.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      },
      node.web!.certificate!.pin,
    )
    const text = await response.text()
    let json: Json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return {
      status: response.status,
      text,
      json,
      headers: response.headers,
    }
  }
  const onMaster = (person: string): { cookie: string; csrf: string } => {
    const { token, session } = c.master.master!.auth.start(
      people[person]!,
      '127.0.0.1',
    )
    return { cookie: `${MASTER_SESSION_COOKIE}=${token}`, csrf: session.csrf }
  }
  const onHost = (person: string): { cookie: string } => ({
    cookie: `${SESSION_COOKIE}=${host.host!.accounts.startSession(people[person]!).token}`,
  })
  const nodes = (): Array<[string, RunningNode, () => { cookie: string }]> => [
    ['master', c.master, (): { cookie: string } => onMaster('dev')],
    ['host', host, (): { cookie: string } => onHost('dev')],
  ]
  /** Asserts a reply is the web app's shell with that status. */
  const shell = (reply: Reply, status: number, what: string): void => {
    assert.equal(reply.status, status, what)
    assertShell(reply, status)
  }
  /** A JSON read that answers 200. */
  const read = async (
    node: RunningNode,
    route: string,
    who: { cookie: string },
  ): Promise<Json> => {
    const reply = await request(node, route, who)
    assert.equal(reply.status, 200, `${route}: ${reply.text}`)
    return reply.json
  }
  /** The branch list, in order, with `|` between the pinned group and the rest. */
  const branchList = (branches: Json[]): string[] => {
    const pinned = branches
      .filter((entry) => entry.pinned)
      .map((entry) => String(entry.branch))
    const rest = branches
      .filter((entry) => !entry.pinned)
      .map((entry) => String(entry.branch))
    return pinned.length > 0 && rest.length > 0
      ? [...pinned, '|', ...rest]
      : [...pinned, ...rest]
  }
  /** The runs a list holds, by id. */
  const runIds = (list: Json): string[] =>
    (list.runs as Json[]).map((run) => String(run.id))
  /** Waits until the host's copy has the master's latest project details. */
  const hostDetails = async (
    test: (details: Json) => boolean,
    what: string,
  ): Promise<void> => {
    await c.until(
      () => {
        const row = host
          .host!.cache.db.prepare(
            "SELECT details FROM projects WHERE slug='fixture'",
          )
          .get() as { details: string | null } | undefined
        return row?.details != null && test(JSON.parse(row.details))
      },
      15_000,
      what,
    )
  }

  before(async () => {
    const root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'app-pages-'),
    )
    c = await cluster(path.join(root, 'cluster'), { coWorker: true })
    host = await c.startHost('host', { testEndpoints: true })
    const master = c.master.master!
    await master.settings.set(localOperator, 'host', {
      origin: origin(host),
      workerOrigin: host.web!.url,
    })
    const repo = c.repo('fixtures/fixture')
    repo.commit({ 'Masonfile.ts': masonfile }, 'master', 'Fixture Masonfile')
    for (const branch of ['develop', 'release', 'feature/post'])
      repo.commit({ [`${branch}.txt`]: `${branch}\n` }, branch, branch)
    master.saveProject(localOperator, 'fixture', {
      name: 'Fixture',
      repository: repo.url,
      rules: [{ pattern: '**', mode: 'request' }],
      apps: [
        { bundleId: ALPHA, name: 'Alpha', platforms: ['ios', 'android'] },
        { bundleId: BETA, name: 'Beta', platforms: ['macos'] },
        { bundleId: GAMMA, name: 'Gamma', platforms: ['android'] },
        { bundleId: DELTA, name: 'Delta <one>', platforms: ['windows'] },
        { bundleId: HIDDEN, name: 'Hidden', platforms: ['android'] },
      ],
    })
    const other = c.repo('fixtures/other')
    other.commit({ 'Masonfile.ts': 'export function setup() {}' })
    master.saveProject(localOperator, 'other', {
      name: 'Other',
      repository: other.url,
      rules: [{ pattern: '*', mode: 'request' }],
      apps: [{ bundleId: OTHER, name: 'Other', platforms: ['android'] }],
    })
    for (const [key, role] of [
      ['dev', 'developer'],
      ['mgr', 'manager'],
      ['tess', 'tester'],
    ] as const)
      people[key] = (
        await master.people.create(localOperator, {
          name: `${key} person`,
          emails: [`${key}@example.test`],
          role,
        })
      ).id
    const db = master.database.db
    const appId = (slug: string): number =>
      Number(db.prepare('SELECT id FROM apps WHERE slug=?').get(slug)!.id)
    master.people.createGroup(localOperator, {
      name: 'Testers',
      apps: [appId(ALPHA), appId(BETA)],
      members: [people.tess!],
    })
    // The hidden app is disabled: no one sees it.
    db.prepare('UPDATE apps SET enabled=0 WHERE slug=?').run(HIDDEN)
    master.database.change('app', appId(HIDDEN))
    // Real runs on the co-worker: alpha and beta on master and develop,
    // beta alone on release, and alpha's post stage on feature/post.
    for (const [workflow, branch] of [
      ['build-alpha', 'master'],
      ['build-beta', 'master'],
      ['build-alpha', 'develop'],
      ['build-beta', 'develop'],
      ['build-beta', 'release'],
      ['ship-alpha', 'feature/post'],
    ] as const) {
      const created = await c.api('POST', '/api/v2/runs', {
        project: 'fixture',
        branch,
        workflow,
      })
      assert.equal(created.status, 202, created.text)
      const id = String((created.json as Json).id)
      const run = await c.until(
        () => {
          const value = master.run(id) as Json
          return ['succeeded', 'failed', 'cancelled', 'unstable'].includes(
            value.status,
          )
            ? value
            : undefined
        },
        120_000,
        `${workflow} on ${branch}`,
      )
      assert.equal(run.status, 'succeeded', master.scheduler.logs(id))
      runs[`${workflow}@${branch}`] = id
    }
    // A run with no graph never counts.
    const project = master.projects.get('fixture')
    db.prepare(
      "INSERT INTO jobs(id,project_id,workflow,number,branch,trigger,status,created,request) VALUES('no-graph',?,'build-alpha',900,'nograph','request','failed',?,'{}')",
    ).run(project.id, master.database.now())
    master.database.change('job', 'no-graph')
    // The push trigger builds develop, release and hotfix (which has no run).
    db.prepare(
      "INSERT INTO push_triggers(project_id,branch,sources,triggers,commit_sha,updated) VALUES(?,?,'',?,'',?) ON CONFLICT(project_id,branch) DO UPDATE SET triggers=excluded.triggers",
    ).run(
      project.id,
      project.defaultBranch,
      JSON.stringify({ build: ['develop', 'release', 'hotfix'] }),
      master.database.now(),
    )
    master.database.change('project', 'fixture')
    await c.until(
      () =>
        host
          .host!.cache.db.prepare(
            "SELECT COUNT(*) AS n FROM jobs WHERE graph IS NOT NULL OR id='no-graph'",
          )
          .get()!.n === 7 &&
        host
          .host!.cache.db.prepare(
            "SELECT 1 FROM accounts WHERE name='dev person'",
          )
          .get() != null &&
        host
          .host!.cache.db.prepare(
            'SELECT 1 FROM apps WHERE slug=? AND enabled=0',
          )
          .get(HIDDEN) != null,
      20_000,
      'the runs, people and apps on the host',
    )
    await hostDetails(
      (details) =>
        details.pinned.includes('hotfix') &&
        details.buildNumbers.some(
          (sequence: Json) =>
            sequence.key === ALPHA && sequence.last.length > 0,
        ),
      'the pinned branches and sequences on the host',
    )
  })
  after(async () => {
    await c?.close()
  })

  it('serves both tabs on both nodes as the web app, which reads the app ID’s heading', async () => {
    for (const [name, node, who] of nodes()) {
      for (const suffix of ['', '?branch=develop', '/build-numbers'])
        shell(
          await request(
            node,
            `/projects/fixture/apps/${ALPHA}${suffix}`,
            who(),
          ),
          200,
          `${name} ${suffix}`,
        )
      // Its project, its name and its platforms head both tabs.
      const app = await read(
        node,
        `/api/v2/projects/fixture/apps/${ALPHA}`,
        who(),
      )
      assert.deepEqual(
        [app.slug, app.name, app.app.bundleId, app.app.name, app.app.platforms],
        ['fixture', 'Fixture', ALPHA, 'Alpha', ['android', 'ios']],
        name,
      )
      const runsList = await read(
        node,
        `/api/v2/projects/fixture/runs?app=${ALPHA}&branch=develop`,
        who(),
      )
      assert.equal(runsList.branch, 'develop', name)
      assert.deepEqual(runsList.app, app.app, name)
      // Names come as they are; the page escapes them.
      const delta = await read(
        node,
        `/api/v2/projects/fixture/apps/${DELTA}`,
        who(),
      )
      assert.equal(delta.app.name, 'Delta <one>')
    }
  })

  it('answers 404 under the project for another project’s app ID, an unknown one and a hidden one; testers have no app ID pages', async () => {
    for (const [name, node, who] of nodes())
      for (const appId of [OTHER, 'com.example.none', HIDDEN]) {
        for (const suffix of ['', '/build-numbers']) {
          const route = `/projects/fixture/apps/${appId}${suffix}`
          shell(await request(node, route, who()), 404, `${name} ${route}`)
        }
        for (const route of [
          `/api/v2/projects/fixture/apps/${appId}`,
          `/api/v2/projects/fixture/runs?app=${appId}`,
        ]) {
          const reply = await request(node, route, who())
          assert.equal(reply.status, 404, `${name} ${route}`)
          assert.match(reply.json.error, /No such app ID in this project/)
        }
      }
    // An unknown project is unknown on both nodes.
    for (const [name, node, who] of nodes())
      shell(
        await request(node, `/projects/none/apps/${ALPHA}`, who()),
        404,
        name,
      )
    // The other project's own page has it.
    shell(
      await request(c.master, `/projects/other/apps/${OTHER}`, onMaster('dev')),
      200,
      'other',
    )
    await read(
      c.master,
      `/api/v2/projects/other/apps/${OTHER}`,
      onMaster('dev'),
    )
    // A tester who may install alpha still has no project pages: to a
    // tester projects do not exist on either node.
    for (const [node, who] of [
      [c.master, onMaster('tess')],
      [host, onHost('tess')],
    ] as const)
      for (const suffix of ['', '/build-numbers'])
        assert.equal(
          (await request(node, `/projects/fixture/apps/${ALPHA}${suffix}`, who))
            .status,
          404,
        )
    for (const [node, who] of [
      [c.master, onMaster('tess')],
      [host, onHost('tess')],
    ] as const)
      assert.equal(
        (await request(node, `/api/v2/projects/fixture/apps/${ALPHA}`, who))
          .status,
        403,
      )
    // Signed out, the page asks for a sign-in.
    assert.equal(
      (await request(c.master, `/projects/fixture/apps/${ALPHA}`)).status,
      303,
    )
    assert.equal(
      (await request(host, `/projects/fixture/apps/${ALPHA}`)).status,
      303,
    )
  })

  it('lists only the runs whose workflow publishes the app ID, a post stage counting, and only the branches that ran one', async () => {
    for (const [name, node, who] of nodes()) {
      const runsOf = async (query: string): Promise<Json> =>
        await read(node, `/api/v2/projects/fixture/runs?${query}`, who())
      const alpha = await runsOf(`app=${ALPHA}`)
      assert.deepEqual(
        new Set(runIds(alpha)),
        new Set([
          runs['build-alpha@master'],
          runs['build-alpha@develop'],
          runs['ship-alpha@feature/post'],
        ]),
        name,
      )
      assert(
        alpha.runs.every((run: Json) => run.workflow !== 'build-beta'),
        name,
      )
      assert.equal(alpha.more, false)
      // develop is pinned and ran alpha; release ran only beta and hotfix
      // nothing, so neither is listed; nograph's run has no graph.
      assert.deepEqual(
        branchList(alpha.branches),
        ['develop', '|', 'feature/post', 'master'],
        name,
      )
      const beta = await runsOf(`app=${BETA}`)
      assert.deepEqual(
        new Set(runIds(beta)),
        new Set([
          runs['build-beta@master'],
          runs['build-beta@develop'],
          runs['build-beta@release'],
        ]),
        name,
      )
      // Pinned in the push trigger's order; hotfix has no beta run either.
      assert.deepEqual(branchList(beta.branches), [
        'develop',
        'release',
        '|',
        'master',
      ])
      // One branch: its alpha runs only.
      const develop = await runsOf(`app=${ALPHA}&branch=develop`)
      assert.deepEqual(runIds(develop), [runs['build-alpha@develop']])
      const release = await runsOf(`app=${ALPHA}&branch=release`)
      assert.deepEqual(release.runs, [])
      // No run of the project publishes gamma.
      const gamma = await runsOf(`app=${GAMMA}`)
      assert.deepEqual(gamma.branches, [])
      assert.deepEqual(gamma.runs, [])
      // The project's own Runs and builds still lists every run and pinned branch.
      shell(
        await request(node, '/projects/fixture/runs', who()),
        200,
        `${name} runs`,
      )
      const project = await runsOf('')
      assert.deepEqual(branchList(project.branches).slice(0, 4), [
        'develop',
        'release',
        'hotfix',
        '|',
      ])
      assert(runIds(project).includes('no-graph'), name)
      assert(runIds(project).includes(runs['build-beta@release']!), name)
      // A limit answers the newest runs and whether older ones are left.
      const two = await runsOf('limit=2')
      assert.deepEqual(runIds(two), runIds(project).slice(0, 2), name)
      assert.equal(two.more, true, name)
      assert.equal(project.more, false, name)
    }
  })

  it('shows the sequence each app ID takes its numbers from: its own, a shared one, or the default scheme', async () => {
    for (const [name, node, who] of nodes()) {
      const numbers = async (appId: string): Promise<Json> =>
        await read(node, `/api/v2/projects/fixture/apps/${appId}`, who())
      const alpha = await numbers(ALPHA)
      assert.deepEqual(
        [alpha.sequence.key, alpha.sequence.format, alpha.sequence.scope],
        [ALPHA, 'YYMMDDCC', 'app'],
        name,
      )
      assert.deepEqual(alpha.shared, [BETA], name)
      // Both runs of each took a number from alpha's sequence.
      assert.equal(alpha.sequence.last.length, 1, name)
      assert.match(alpha.sequence.last[0].value, /^\d{8}$/)
      const beta = await numbers(BETA)
      assert.equal(beta.sequence.key, ALPHA, name)
      assert.deepEqual(beta.shared, [ALPHA], name)
      const gamma = await numbers(GAMMA)
      assert.deepEqual(
        [gamma.sequence.key, gamma.sequence.format, gamma.sequence.scope],
        [GAMMA, 'N', 'branch'],
        name,
      )
      assert.deepEqual(gamma.shared, [], name)
      assert.deepEqual(gamma.sequence.last, [], name)
      const delta = await numbers(DELTA)
      assert.equal(delta.sequence, undefined, name)
      assert.deepEqual(delta.shared, [], name)
      assert.deepEqual(delta.defaultScheme, { format: 'N', scope: 'app' })
      // Nothing here to set: a developer, or the host.
      for (const app of [alpha, beta, gamma, delta])
        assert.equal(app.canSeed, false, name)
    }
  })

  it('lets a manager on the master set where the app ID’s sequence stands, refuses a developer, and the host shows it read-only', async () => {
    const mgr = onMaster('mgr')
    shell(
      await request(
        c.master,
        `/projects/fixture/apps/${BETA}/build-numbers`,
        mgr,
      ),
      200,
      'beta',
    )
    // Beta's sequence is alpha's, which a manager on the master may set.
    const form = await read(
      c.master,
      `/api/v2/projects/fixture/apps/${BETA}`,
      mgr,
    )
    assert.equal(form.canSeed, true)
    assert.equal(form.sequence.key, ALPHA)
    // A per-branch sequence asks for the branch: each branch's number has its own line.
    for (const [branch, last] of [
      ['develop', '7'],
      ['master', '12'],
    ])
      assert.equal(
        (
          await request(c.master, '/api/v2/build-numbers/seed', {
            method: 'POST',
            ...mgr,
            body: { project: 'fixture', key: GAMMA, branch, last },
          })
        ).status,
        200,
      )
    const gamma = await read(
      c.master,
      `/api/v2/projects/fixture/apps/${GAMMA}`,
      mgr,
    )
    assert.equal(gamma.sequence.scope, 'branch')
    assert.deepEqual(gamma.sequence.last, [
      { branch: 'develop', value: '7' },
      { branch: 'master', value: '12' },
    ])
    // The default scheme has no sequence to set.
    assert.equal(
      (await read(c.master, `/api/v2/projects/fixture/apps/${DELTA}`, mgr))
        .sequence,
      undefined,
    )
    const body = { project: 'fixture', key: ALPHA, last: '99123199' }
    const dev = onMaster('dev')
    const refused = await request(c.master, '/api/v2/build-numbers/seed', {
      method: 'POST',
      ...dev,
      body,
    })
    assert.equal(refused.status, 403, refused.text)
    const seeded = await request(c.master, '/api/v2/build-numbers/seed', {
      method: 'POST',
      ...mgr,
      body,
    })
    assert.equal(seeded.status, 200, seeded.text)
    const after = await read(
      c.master,
      `/api/v2/projects/fixture/apps/${BETA}`,
      mgr,
    )
    assert.deepEqual(
      after.sequence.last.map((entry: Json) => entry.value),
      ['99123199'],
    )
    // The host has it from the change feed, and no one may set it there.
    await hostDetails(
      (details) =>
        details.buildNumbers.some(
          (sequence: Json) =>
            sequence.key === ALPHA &&
            sequence.last.some((entry: Json) => entry.value === '99123199'),
        ),
      'the new number on the host',
    )
    for (const person of ['dev', 'mgr']) {
      shell(
        await request(
          host,
          `/projects/fixture/apps/${BETA}/build-numbers`,
          onHost(person),
        ),
        200,
        person,
      )
      const hosted = await read(
        host,
        `/api/v2/projects/fixture/apps/${BETA}`,
        onHost(person),
      )
      assert.deepEqual(
        hosted.sequence.last.map((entry: Json) => entry.value),
        ['99123199'],
      )
      assert.equal(hosted.canSeed, false, person)
    }
  })

  it('links ⌘K app results to their app ID pages for developers on both nodes, and to Install apps for testers', async () => {
    const alpha = Number(
      c.master
        .master!.database.db.prepare('SELECT id FROM apps WHERE slug=?')
        .get(ALPHA)!.id,
    )
    for (const [name, node, who] of nodes()) {
      const found = await request(node, '/api/v2/search?q=alpha', who())
      assert.equal(found.status, 200, name)
      const app = (found.json as Json[]).find(
        (result) => result.kind === 'app' && result.label === ALPHA,
      )
      assert.equal(app?.href, `/projects/fixture/apps/${ALPHA}`, name)
      // The link opens the page.
      assert.equal((await request(node, app.href, who())).status, 200)
    }
    for (const [node, who] of [
      [c.master, onMaster('tess')],
      [host, onHost('tess')],
    ] as const) {
      const found = await request(node, '/api/v2/search?q=alpha', who)
      assert.deepEqual(
        (found.json as Json[]).map((result) => [result.kind, result.href]),
        [['app', `/apps/${alpha}`]],
      )
    }
  })
})
