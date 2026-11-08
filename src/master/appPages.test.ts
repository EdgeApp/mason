import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { SESSION_COOKIE } from '../auth/routes.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { crumbTrail } from '../test/crumbs.js'
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
    return { status: response.status, text, json }
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
  /** The branch list's links, in order, with `|` between the pinned group and the rest. */
  const branchList = (html: string): string[] => {
    const nav =
      /<nav class="panel branch-list" aria-label="Branches">([^]*?)<\/nav>/.exec(
        html,
      )?.[1] ?? ''
    return [
      ...nav.matchAll(/<li class="divider"|<a href="[^"]*\?branch=([^"]+)"/g),
    ].map((match) => (match[1] == null ? '|' : decodeURIComponent(match[1])))
  }
  /** The runs the table lists, by id. */
  const runIds = (html: string): string[] =>
    [...html.matchAll(/<tr data-run-id="([^"]+)"/g)].map((match) => match[1]!)
  const tabs = (html: string): string[] =>
    [
      ...(
        /<nav class="tabs" aria-label="App ID">([^]*?)<\/nav>/.exec(
          html,
        )?.[1] ?? ''
      ).matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g),
    ].map((match) => `${match[3]} ${match[1]}${match[2] == null ? '' : ' *'}`)
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

  it('serves both tabs on both nodes, under the app ID’s heading, tabs and breadcrumbs', async () => {
    for (const [name, node, who] of nodes()) {
      const root = name === 'host' ? 'Mason Host /' : 'Mason Master /'
      const page = await request(node, `/projects/fixture/apps/${ALPHA}`, who())
      assert.equal(page.status, 200, `${name}: ${page.text.slice(0, 300)}`)
      assert.match(page.text, new RegExp(`<h1>${ALPHA}</h1>`))
      // Its name, then a chip per platform.
      assert.match(
        page.text,
        /<p>Alpha · <span class="platform">[^]*?Android<\/span> <span class="platform">[^]*?iOS<\/span><\/p>/,
      )
      assert.deepEqual(tabs(page.text), [
        `Runs and builds /projects/fixture/apps/${ALPHA} *`,
        `Build numbers /projects/fixture/apps/${ALPHA}/build-numbers`,
      ])
      // Only two tabs: none of the project's.
      assert.doesNotMatch(page.text, /aria-label="Project"/)
      assert.deepEqual(crumbTrail(page.text), [
        root,
        'Projects /projects',
        'Fixture /projects/fixture',
        `${ALPHA} /projects/fixture/apps/${ALPHA}`,
        `Runs and builds /projects/fixture/apps/${ALPHA} *`,
      ])
      // The side menu has Projects & apps current.
      assert.match(page.text, /<a href="\/projects" aria-current="page"/)
      const branch = await request(
        node,
        `/projects/fixture/apps/${ALPHA}?branch=develop`,
        who(),
      )
      assert.equal(branch.status, 200, name)
      assert.deepEqual(crumbTrail(branch.text).slice(-3), [
        `${ALPHA} /projects/fixture/apps/${ALPHA}`,
        `Runs and builds /projects/fixture/apps/${ALPHA}`,
        `develop /projects/fixture/apps/${ALPHA}?branch=develop *`,
      ])
      assert.match(branch.text, /<h2><span class="mono">develop<\/span><\/h2>/)
      const numbers = await request(
        node,
        `/projects/fixture/apps/${ALPHA}/build-numbers`,
        who(),
      )
      assert.equal(numbers.status, 200, name)
      assert.deepEqual(tabs(numbers.text), [
        `Runs and builds /projects/fixture/apps/${ALPHA}`,
        `Build numbers /projects/fixture/apps/${ALPHA}/build-numbers *`,
      ])
      assert.deepEqual(crumbTrail(numbers.text), [
        root,
        'Projects /projects',
        'Fixture /projects/fixture',
        `${ALPHA} /projects/fixture/apps/${ALPHA}`,
        `Build numbers /projects/fixture/apps/${ALPHA}/build-numbers *`,
      ])
      // Names are escaped.
      const delta = await request(
        node,
        `/projects/fixture/apps/${DELTA}`,
        who(),
      )
      assert.match(delta.text, /<p>Delta &lt;one&gt; · /)
    }
  })

  it('answers 404 under the project for another project’s app ID, an unknown one and a hidden one; testers have no app ID pages', async () => {
    for (const [name, node, who] of nodes())
      for (const appId of [OTHER, 'com.example.none', HIDDEN])
        for (const suffix of ['', '/build-numbers']) {
          const route = `/projects/fixture/apps/${appId}${suffix}`
          const reply = await request(node, route, who())
          assert.equal(reply.status, 404, `${name} ${route}`)
          assert.match(reply.text, /There is no such app ID in this project/)
          // In the project's shell: its breadcrumbs, Projects & apps current.
          assert.deepEqual(crumbTrail(reply.text).slice(1), [
            'Projects /projects',
            'Fixture /projects/fixture *',
          ])
          assert.match(reply.text, /<a href="\/projects" aria-current="page"/)
        }
    // The other project's own page has it.
    assert.equal(
      (
        await request(
          c.master,
          `/projects/other/apps/${OTHER}`,
          onMaster('dev'),
        )
      ).status,
      200,
    )
    // A tester who may install alpha still has no project pages.
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
      const alpha = await request(
        node,
        `/projects/fixture/apps/${ALPHA}`,
        who(),
      )
      assert.deepEqual(
        new Set(runIds(alpha.text)),
        new Set([
          runs['build-alpha@master'],
          runs['build-alpha@develop'],
          runs['ship-alpha@feature/post'],
        ]),
        name,
      )
      assert.doesNotMatch(alpha.text, /build-beta/)
      // develop is pinned and ran alpha; release ran only beta and hotfix
      // nothing, so neither is listed; nograph's run has no graph.
      assert.deepEqual(
        branchList(alpha.text),
        ['develop', '|', 'feature/post', 'master'],
        name,
      )
      const beta = await request(node, `/projects/fixture/apps/${BETA}`, who())
      assert.deepEqual(
        new Set(runIds(beta.text)),
        new Set([
          runs['build-beta@master'],
          runs['build-beta@develop'],
          runs['build-beta@release'],
        ]),
        name,
      )
      // Pinned in the push trigger's order; hotfix has no beta run either.
      assert.deepEqual(branchList(beta.text), [
        'develop',
        'release',
        '|',
        'master',
      ])
      // One branch: its alpha runs only.
      const develop = await request(
        node,
        `/projects/fixture/apps/${ALPHA}?branch=develop`,
        who(),
      )
      assert.deepEqual(runIds(develop.text), [runs['build-alpha@develop']])
      const release = await request(
        node,
        `/projects/fixture/apps/${ALPHA}?branch=release`,
        who(),
      )
      assert.match(release.text, /No runs yet/)
      // No run of the project publishes gamma.
      const gamma = await request(
        node,
        `/projects/fixture/apps/${GAMMA}`,
        who(),
      )
      assert.equal(gamma.status, 200)
      assert.deepEqual(branchList(gamma.text), [])
      assert.match(gamma.text, /No runs yet/)
      // The project's own Runs and builds still lists every run and pinned branch.
      const project = await request(node, '/projects/fixture/runs', who())
      assert.deepEqual(branchList(project.text).slice(0, 4), [
        'develop',
        'release',
        'hotfix',
        '|',
      ])
      assert(runIds(project.text).includes('no-graph'), name)
      assert(runIds(project.text).includes(runs['build-beta@release']!), name)
    }
  })

  it('shows the sequence each app ID takes its numbers from: its own, a shared one, or the default scheme', async () => {
    for (const [name, node, who] of nodes()) {
      const page = async (appId: string): Promise<string> => {
        const reply = await request(
          node,
          `/projects/fixture/apps/${appId}/build-numbers`,
          who(),
        )
        assert.equal(reply.status, 200, `${name} ${appId}`)
        return reply.text
      }
      const alpha = await page(ALPHA)
      assert.match(
        alpha,
        new RegExp(
          `<dt>Sequence</dt><dd class="mono">${ALPHA}</dd><dt>Format</dt><dd class="mono">YYMMDDCC</dd><dt>Scope</dt><dd>across branches</dd>`,
        ),
      )
      assert.match(
        alpha,
        new RegExp(
          `<p data-shared>Shared with: <span class="mono">${BETA}</span></p>`,
        ),
      )
      // Both runs of each took a number from alpha's sequence.
      assert.match(
        alpha,
        /<dt>Last issued<\/dt><dd><span class="mono">\d{8}<\/span><\/dd>/,
      )
      const beta = await page(BETA)
      assert.match(
        beta,
        new RegExp(`<dt>Sequence</dt><dd class="mono">${ALPHA}</dd>`),
      )
      assert.match(
        beta,
        new RegExp(
          `<p data-shared>Shared with: <span class="mono">${ALPHA}</span></p>`,
        ),
      )
      const gamma = await page(GAMMA)
      assert.match(
        gamma,
        new RegExp(
          `<dt>Sequence</dt><dd class="mono">${GAMMA}</dd><dt>Format</dt><dd class="mono">N</dd><dt>Scope</dt><dd>per branch</dd>`,
        ),
      )
      assert.doesNotMatch(gamma, /Shared with/)
      assert.match(gamma, /<dt>Last issued<\/dt><dd>None yet\.<\/dd>/)
      const delta = await page(DELTA)
      assert.match(
        delta,
        /takes the default scheme: <span class="mono">N<\/span>, across branches/,
      )
      // Nothing here to set: a developer, or the host.
      for (const html of [alpha, beta, gamma, delta])
        assert.doesNotMatch(html, /build-numbers\/seed|Set where it stands/)
    }
  })

  it('lets a manager on the master set where the app ID’s sequence stands, refuses a developer, and the host shows it read-only', async () => {
    const mgr = onMaster('mgr')
    const form = await request(
      c.master,
      `/projects/fixture/apps/${BETA}/build-numbers`,
      mgr,
    )
    assert.equal(form.status, 200)
    // Preset to beta's sequence, alpha's: no sequence to choose.
    assert.match(form.text, /data-path="\/api\/v2\/build-numbers\/seed"/)
    assert.match(form.text, /data-fields="project,key,last"/)
    assert.match(
      form.text,
      /<input type="hidden" name="project" value="fixture"><input type="hidden" name="key" value="com\.example\.alpha">/,
    )
    assert.doesNotMatch(form.text, /<select id="seed-key"|name="branch"/)
    assert.match(form.text, /Set where it stands/)
    // A per-branch sequence asks for the branch.
    const gamma = await request(
      c.master,
      `/projects/fixture/apps/${GAMMA}/build-numbers`,
      mgr,
    )
    assert.match(gamma.text, /data-fields="project,key,branch,last"/)
    assert.match(gamma.text, /<input id="seed-branch" name="branch" required>/)
    // Set per branch, each branch's number has its own line.
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
    assert.match(
      (
        await request(
          c.master,
          `/projects/fixture/apps/${GAMMA}/build-numbers`,
          mgr,
        )
      ).text,
      /<dt>Last issued<\/dt><dd><span class="mono">develop<\/span> <span class="mono">7<\/span><br><span class="mono">master<\/span> <span class="mono">12<\/span><\/dd>/,
    )
    // The default scheme has no sequence to set.
    assert.doesNotMatch(
      (
        await request(
          c.master,
          `/projects/fixture/apps/${DELTA}/build-numbers`,
          mgr,
        )
      ).text,
      /Set where it stands/,
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
    const after = await request(
      c.master,
      `/projects/fixture/apps/${BETA}/build-numbers`,
      mgr,
    )
    assert.match(after.text, /<span class="mono">99123199<\/span>/)
    // The host has it from the change feed, with no form.
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
      const hosted = await request(
        host,
        `/projects/fixture/apps/${BETA}/build-numbers`,
        onHost(person),
      )
      assert.equal(hosted.status, 200)
      assert.match(hosted.text, /<span class="mono">99123199<\/span>/)
      assert.doesNotMatch(hosted.text, /build-numbers\/seed|data-mason="api"/)
    }
  })

  it('links ⌘K app results to their app ID pages for developers on both nodes, and to Install apps for testers', async () => {
    const alpha = Number(
      c.master
        .master!.database.db.prepare('SELECT id FROM apps WHERE slug=?')
        .get(ALPHA)!.id,
    )
    for (const [name, node, who] of nodes()) {
      const found = await request(node, '/search?q=alpha', who())
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
      const found = await request(node, '/search?q=alpha', who)
      assert.deepEqual(
        (found.json as Json[]).map((result) => [result.kind, result.href]),
        [['app', `/apps/${alpha}`]],
      )
    }
  })
})
