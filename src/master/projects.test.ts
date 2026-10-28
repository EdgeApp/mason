import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, verify } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
} from '../auth/passwordProtocol.js'
import { nodeMain, type MainIO } from '../node/main.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import { startNode, type RunningNode } from '../node/serve.js'
import { createFirstAdmin } from '../setup/setup.js'
import {
  asScheme,
  BuildNumbers,
  compareNumbers,
  datePart,
  render,
} from './buildNumbers.js'
import { MasterDatabase } from './database.js'
import { GitHub, listHeads, storedConnection } from './github.js'
import { Jobs } from './jobs.js'
import { MAX_AUTOMATIC_BRANCHES, Poller } from './poller.js'
import { Projects } from './projects.js'
import { localOperator, type Actor } from './roles.js'
import { asRules, globExpression, matches, ruleFor } from './rules.js'

let root: string
// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const developer: Actor = { role: 'developer', label: 'key:dev' }
const day = (y: number, m: number, d: number, h = 12): number =>
  Date.UTC(y, m - 1, d, h)
const commit = (n: number): string => n.toString(16).padStart(40, 'a')

function database(name = 'm.sqlite', now?: () => number): MasterDatabase {
  return new MasterDatabase(
    new DatabaseSync(path.join(root, name), {
      enableForeignKeyConstraints: true,
    }),
    now,
  )
}
async function master(
  extra: Partial<Parameters<typeof startNode>[0]> = {},
): Promise<{ node: RunningNode; admin: string }> {
  const node = await startNode(
    {
      role: 'master',
      data: path.join(root, 'node'),
      port: 0,
      listen: '127.0.0.1',
      heartbeatMs: 0,
      pollMs: 3600000,
      ...extra,
    },
    () => undefined,
  )
  const parameters = clientParameters('0f'.repeat(16), DEFAULT_PASSWORD_COSTS)
  const setup = await createFirstAdmin(
    node.master!.database,
    node.master!.keys,
    {
      username: 'paul',
      clientHash: await clientPasswordHash('Correct-Horse-9', parameters),
      clientParameters: parameters,
      apiKey: true,
    },
  )
  return { node, admin: setup.token! }
}
async function api(
  node: RunningNode,
  method: string,
  route: string,
  key?: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await pinnedFetch(
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:') + route,
    {
      method,
      headers: {
        ...(key == null ? {} : { Authorization: `Bearer ${key}` }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    node.identity.pin,
  )
  const text = await response.text()
  return {
    status: response.status,
    json: text === '' ? null : JSON.parse(text),
  }
}
function io(
  extra: Partial<MainIO> = {},
): MainIO & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    system: (): never => {
      throw new Error('unused')
    },
    stopped: async () => undefined,
    program: () => [],
    ...extra,
  }
}
async function fakeGitHub(
  handler: (
    url: string,
    headers: Record<string, string | string[] | undefined>,
  ) => { status: number; headers?: Record<string, string>; body?: unknown },
): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const out = handler(req.url ?? '', req.headers)
    res.writeHead(out.status, {
      'Content-Type': 'application/json',
      ...out.headers,
    })
    res.end(JSON.stringify(out.body ?? {}))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  }
}

describe('Projects, branch rules and build numbers', function () {
  this.timeout(60000)
  beforeEach(() => {
    process.umask(0o077)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'projects-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates, updates and removes projects and gives each app ID one project', () => {
    const master = database()
    const projects = new Projects(master)
    const made = projects.save(localOperator, 'fixtures', {
      repository: 'https://github.com/Example/Mason-Fixtures',
      webhookSecret: 's'.repeat(32),
    })
    assert.equal(made.created, true)
    assert.deepEqual(
      [
        made.project.repository,
        made.project.format,
        made.project.defaultBranch,
        made.project.webhookSecret,
        made.project.timeoutSeconds,
      ],
      [
        'https://github.com/example/mason-fixtures.git',
        'pipeline',
        'master',
        { set: true },
        14400,
      ],
    )
    assert.equal(projects.webhookSecret(made.project.id), 's'.repeat(32))
    const updated = projects.save(localOperator, 'fixtures', {
      name: 'Fixtures',
      webhookSecret: { keep: true },
      defaultBranch: 'main',
      script: { platforms: ['ios'] },
    })
    assert.deepEqual(
      [
        updated.created,
        updated.project.name,
        updated.project.defaultBranch,
        updated.project.webhookSecret.set,
      ],
      [false, 'Fixtures', 'main', true],
    )
    assert.equal(
      projects.save(localOperator, 'fixtures', { webhookSecret: null }).project
        .webhookSecret.set,
      false,
    )
    for (const [slug, value, message] of [
      ['bad slug!', { repository: 'https://github.com/a/b' }, /slug/],
      ['x', {}, /needs a repository/],
      ['x', { repository: 'https://gitlab.com/a/b' }, /GitHub/],
      [
        'x',
        { repository: 'https://github.com/a/b', webhookSecret: 'short' },
        /Invalid text/,
      ],
      [
        'x',
        { repository: 'https://github.com/a/b', webhookSecret: { keep: true } },
        /keep/,
      ],
      [
        'x',
        { repository: 'https://github.com/a/b', format: 'yaml' },
        /pipeline or script/,
      ],
    ] as const)
      assert.throws(() => projects.save(localOperator, slug, value), message)
    assert.throws(
      () =>
        projects.save(developer, 'y', { repository: 'https://github.com/a/b' }),
      /Not allowed/,
    )
    const before = Number(
      master.db
        .prepare(
          "SELECT COUNT(*) n FROM change_log WHERE entity='project' AND key='fixtures'",
        )
        .get()!.n,
    )
    const app = projects.addApp(localOperator, 'fixtures', {
      bundleId: 'com.example.masonfixture',
      name: 'Fixture',
      platforms: ['ios', 'android'],
    })
    // The host reads which apps a project owns from the project: it changes too.
    assert.equal(
      Number(
        master.db
          .prepare(
            "SELECT COUNT(*) n FROM change_log WHERE entity='project' AND key='fixtures'",
          )
          .get()!.n,
      ),
      before + 1,
    )
    assert.deepEqual(app.platforms, ['android', 'ios'])
    const channels = master.db
      .prepare(
        'SELECT platform,formats,length(channel_key) n FROM channels ORDER BY platform',
      )
      .all()
    assert.deepEqual(
      channels.map((row) => [row.platform, row.formats]),
      [
        ['android', '["apk"]'],
        ['ios', '["ipa"]'],
      ],
    )
    assert(channels.every((row) => Number(row.n) >= 32))
    // Changing platforms disables the channel left out and keeps its builds.
    assert.deepEqual(
      projects.addApp(localOperator, 'fixtures', {
        bundleId: 'com.example.masonfixture',
        name: 'Fixture 2',
        platforms: ['ios'],
      }).platforms,
      ['ios'],
    )
    assert.equal(projects.resolve('com.example.masonfixture')!.slug, 'fixtures')
    assert.equal(projects.resolve('fixtures')!.slug, 'fixtures')
    assert.equal(projects.resolve('nothing'), undefined)
    projects.save(localOperator, 'other', {
      repository: 'git@github.com:a/b.git',
    })
    assert.throws(
      () =>
        projects.addApp(localOperator, 'other', {
          bundleId: 'com.example.masonfixture',
          name: 'X',
          platforms: ['ios'],
        }),
      /belongs to another project/,
    )
    assert.throws(
      () =>
        projects.addApp(localOperator, 'other', {
          bundleId: 'a',
          name: 'X',
          platforms: [],
        }),
      /each platform once/,
    )
    assert.throws(
      () =>
        projects.addApp(localOperator, 'other', {
          bundleId: 'a',
          name: 'X',
          platforms: ['ios', 'ios'],
        }),
      /each platform once/,
    )
    projects.removeApp(localOperator, 'fixtures', 'com.example.masonfixture')
    assert.throws(
      () =>
        projects.removeApp(
          localOperator,
          'fixtures',
          'com.example.masonfixture',
        ),
      /No project/,
    )
    assert.equal(
      projects.addApp(localOperator, 'other', {
        bundleId: 'com.example.masonfixture',
        name: 'X',
        platforms: ['ios'],
      }).bundleId,
      'com.example.masonfixture',
    )
    assert.deepEqual(
      projects.list().map((project) => project.slug),
      ['fixtures', 'other'],
    )
    projects.remove(localOperator, 'other')
    assert.throws(() => projects.get('other'), /No project named other/)
    assert.equal(
      master.db
        .prepare(
          "SELECT COUNT(*) n FROM apps WHERE slug='com.example.masonfixture'",
        )
        .get()!.n,
      1,
    )
    assert(
      Number(
        master.db
          .prepare("SELECT COUNT(*) n FROM change_log WHERE entity='project'")
          .get()!.n,
      ) >= 4,
    )
  })

  it('keeps secrets write-only, reuses kept values and removes what is left out', () => {
    const projects = new Projects(database())
    projects.save(localOperator, 'p', { repository: 'https://github.com/a/b' })
    const file = Buffer.from('{"k":1}').toString('base64')
    const set = projects.setSecrets(localOperator, 'p', {
      env: [
        { name: 'TOKEN', value: 't0k' },
        { name: 'SERVER', value: 'https://x', secret: false },
      ],
      files: [
        {
          destination: 'config/deploy.json',
          contents: file,
          env: 'DEPLOY_FILE',
        },
      ],
    })
    assert.deepEqual(set.env, [
      { name: 'SERVER', secret: false },
      { name: 'TOKEN', secret: true },
    ])
    assert.deepEqual(set.files, [
      { destination: 'config/deploy.json', env: 'DEPLOY_FILE' },
    ])
    assert(!JSON.stringify(set).includes('t0k'))
    const kept = projects.setSecrets(localOperator, 'p', {
      env: [{ name: 'TOKEN', keep: true }],
      files: [{ destination: 'config/deploy.json', keep: true }],
    })
    assert.deepEqual(kept.env, [{ name: 'TOKEN', secret: true }])
    assert.deepEqual(projects.secrets(set.id).env, [
      { name: 'TOKEN', value: 't0k', secret: true },
    ])
    assert.equal(projects.secrets(set.id).files[0]!.contents, file)
    for (const [value, message] of [
      [{ env: [{ name: 'NEW', keep: true }] }, /No stored value/],
      [{ files: [{ destination: 'x.json', keep: true }] }, /No stored file/],
      [{ env: [{ name: 'A' }] }, /Invalid value/],
      [{ files: [{ destination: 'y', contents: '***' }] }, /base64/],
      [
        {
          env: [
            { name: 'A', value: '1' },
            { name: 'A', value: '2' },
          ],
        },
        /Duplicate/,
      ],
      [{ env: [{ name: 'MASON_X', value: '1' }] }, /Reserved/],
      [{ files: [{ destination: '../etc', contents: file }] }, /Unsafe/],
    ] as const)
      assert.throws(
        () => projects.setSecrets(localOperator, 'p', value),
        message,
      )
    assert.deepEqual(projects.setSecrets(localOperator, 'p', {}).env, [])
    assert.throws(() => projects.setSecrets(developer, 'p', {}), /Not allowed/)
  })

  it('matches branch rules: exact, * within a segment, ** across, first match wins', () => {
    assert(matches('master', 'master'))
    assert(!matches('master', 'master2'))
    assert(matches('feature/*', 'feature/x'))
    assert(!matches('feature/*', 'feature/x/y'))
    assert(matches('release/**', 'release/1.2/hotfix'))
    assert(matches('**', 'anything/at/all'))
    assert(matches('v1.*', 'v1.2'))
    assert(!matches('v1.*', 'v1x2'))
    assert.equal(globExpression('a+b').test('a+b'), true)
    const rules = asRules([
      { pattern: 'wip/**', mode: 'request' },
      { pattern: '**', mode: 'automatic' },
    ])
    assert.equal(ruleFor(rules, 'wip/x')!.mode, 'request')
    assert.equal(ruleFor(rules, 'main')!.mode, 'automatic')
    assert.equal(
      ruleFor([{ pattern: 'master', mode: 'automatic' }], 'other'),
      undefined,
    )
    for (const bad of [
      {},
      [{ pattern: '', mode: 'request' }],
      [{ pattern: 'a b', mode: 'request' }],
      [{ pattern: 'x', mode: 'sometimes' }],
      [null],
    ])
      assert.throws(() => asRules(bad))
  })

  it('builds a push that arrives while the branch is busy as soon as its run ends', () => {
    const master = database()
    const projects = new Projects(master)
    const jobs = new Jobs(master, projects)
    projects.save(localOperator, 'q', { repository: 'https://github.com/a/q' })
    projects.setRules(localOperator, 'q', [
      { pattern: 'release', mode: 'automatic' },
    ])
    const project = projects.get('q')
    const first = jobs.automatic(project, 'release', commit(50))!
    assert.equal(jobs.automatic(project, 'release', commit(51)), undefined)
    assert.equal(jobs.automatic(project, 'release', commit(52)), undefined)
    // Still busy: nothing yet.
    assert.equal(jobs.pushedSince(project, 'release'), undefined)
    master.db
      .prepare("UPDATE jobs SET status='failed' WHERE id=?")
      .run(first.id)
    const next = jobs.pushedSince(project, 'release')!
    assert.equal(next.requested_commit, commit(52))
    master.db
      .prepare("UPDATE jobs SET status='succeeded' WHERE id=?")
      .run(next.id)
    // That commit was tried; a branch no longer automatic waits for a request.
    assert.equal(jobs.pushedSince(project, 'release'), undefined)
    assert.equal(
      jobs.automatic(project, 'release', commit(53))!.branch,
      'release',
    )
    assert.equal(jobs.automatic(project, 'release', commit(54)), undefined)
    master.db
      .prepare("UPDATE jobs SET status='failed' WHERE branch='release'")
      .run()
    projects.setRules(localOperator, 'q', [{ pattern: '*', mode: 'request' }])
    assert.equal(jobs.pushedSince(projects.get('q'), 'release'), undefined)
    assert.equal(jobs.pushedSince(project, 'unknown'), undefined)
  })

  it('polls automatic branches by rule, capped, with three attempts per commit and one pending job', async () => {
    const master = database()
    const projects = new Projects(master)
    const jobs = new Jobs(master, projects)
    const project = projects.save(localOperator, 'p', {
      repository: 'https://github.com/a/b',
    }).project
    projects.setRules(localOperator, 'p', [
      { pattern: 'feature/skip-*', mode: 'request' },
      { pattern: 'master', mode: 'automatic' },
      { pattern: 'feature/*', mode: 'automatic' },
    ])
    const heads = new Map<string, string>([
      ['master', commit(1)],
      ['develop', commit(2)],
      ['feature/skip-me', commit(3)],
    ])
    for (let i = 0; i < 30; i++)
      heads.set(`feature/f${String(i).padStart(2, '0')}`, commit(100 + i))
    let failing = false
    const poller = new Poller(master, projects, jobs, async () => {
      if (failing) throw new Error('offline')
      return heads
    })
    const branches = Poller.automaticBranches(projects.get('p'), heads)
    assert.equal(branches.length, MAX_AUTOMATIC_BRANCHES)
    assert.equal(branches[0], 'master')
    assert(
      !branches.includes('develop') && !branches.includes('feature/skip-me'),
    )
    await poller.poll()
    const queued = jobs.pending()
    assert.equal(queued.length, MAX_AUTOMATIC_BRANCHES)
    assert(queued.every((job) => job.trigger === 'push' && job.automatic === 1))
    // While a job is pending no second job is queued for the branch.
    await poller.poll()
    assert.equal(jobs.pending().length, MAX_AUTOMATIC_BRANCHES)
    const masterJob = queued.find((job) => job.branch === 'master')!
    // A failed attempt is retried; after three the commit is not built again.
    for (let attempt = 0; attempt < 3; attempt++) {
      master.db
        .prepare(
          "UPDATE jobs SET status='failed' WHERE project_id=? AND branch='master'",
        )
        .run(project.id)
      await poller.poll()
    }
    const masterJobs = master.db
      .prepare("SELECT COUNT(*) n FROM jobs WHERE branch='master'")
      .get()!.n
    assert.equal(masterJobs, 3)
    master.db
      .prepare("UPDATE jobs SET status='failed' WHERE branch='master'")
      .run()
    await poller.poll()
    assert.equal(
      master.db
        .prepare("SELECT COUNT(*) n FROM jobs WHERE branch='master'")
        .get()!.n,
      3,
    )
    // A success records the commit; a new commit builds again.
    jobs.succeeded(masterJob.id)
    jobs.succeeded('missing')
    heads.set('master', commit(9))
    await poller.poll()
    assert.equal(
      master.db
        .prepare(
          "SELECT COUNT(*) n FROM jobs WHERE branch='master' AND status='queued'",
        )
        .get()!.n,
      1,
    )
    const state = master.db
      .prepare(
        "SELECT observed_commit,poll_error FROM automatic_branches WHERE branch='master'",
      )
      .get()!
    assert.deepEqual(
      [state.observed_commit, state.poll_error],
      [commit(9), null],
    )
    failing = true
    await poller.poll()
    assert.equal(
      master.db
        .prepare(
          "SELECT poll_error FROM automatic_branches WHERE branch='master'",
        )
        .get()!.poll_error,
      'Could not read the repository',
    )
    // Disabled projects and projects without automatic rules are not polled.
    projects.save(localOperator, 'p', { enabled: false })
    failing = false
    await poller.poll()
    projects.save(localOperator, 'q', { repository: 'https://github.com/a/c' })
    projects.setRules(localOperator, 'q', [{ pattern: '**', mode: 'request' }])
    await poller.poll()
    assert.equal(
      master.db
        .prepare(
          "SELECT COUNT(*) n FROM jobs WHERE project_id=(SELECT id FROM projects WHERE slug='q')",
        )
        .get()!.n,
      0,
    )
    poller.start(10)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await poller.close()
    await poller.poll()
  })

  it('lists branch heads only, not pull requests from forks', async () => {
    const repo = path.join(root, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'F',
          GIT_AUTHOR_EMAIL: 'f@example.test',
          GIT_COMMITTER_NAME: 'F',
          GIT_COMMITTER_EMAIL: 'f@example.test',
        },
      }).trim()
    git('init', '-q', '-b', 'master')
    writeFileSync(path.join(repo, 'a'), '1')
    git('add', 'a')
    git('commit', '-q', '-m', 'one')
    git('branch', 'feature/x')
    git('update-ref', 'refs/pull/1/head', 'HEAD')
    git('tag', 'v1')
    const heads = await listHeads(repo, process.env)
    assert.deepEqual([...heads.keys()].sort(), ['feature/x', 'master'])
    assert.equal(heads.get('master'), git('rev-parse', 'HEAD'))
    await assert.rejects(
      listHeads(path.join(root, 'missing'), process.env),
      /Could not list/,
    )
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(listHeads(repo, process.env, abort.signal))
  })

  it('queues requested jobs only for branches the rules and key scopes allow', async () => {
    const { node, admin } = await master()
    try {
      const keys = node.master!.keys
      assert.equal(
        (
          await api(node, 'PUT', '/api/v2/projects/fixtures', admin, {
            repository: 'https://github.com/example/mason-fixtures',
          })
        ).status,
        201,
      )
      assert.equal(
        (
          await api(node, 'POST', '/api/v2/projects/fixtures/apps', admin, {
            bundleId: 'com.example.masonfixture',
            name: 'Fixture',
            platforms: ['ios'],
          })
        ).status,
        201,
      )
      await api(node, 'PUT', '/api/v2/projects/fixtures/rules', admin, [
        { pattern: 'master', mode: 'automatic' },
        { pattern: 'feature/*', mode: 'request' },
      ])
      const scoped = keys.create(localOperator, {
        role: 'developer',
        projects: ['fixtures'],
        branches: ['feature/*'],
      }).token
      const other = keys.create(localOperator, {
        role: 'developer',
        projects: ['elsewhere'],
      }).token
      const tester = keys.create(localOperator, { role: 'tester' }).token
      const job = await api(node, 'POST', '/api/jobs', scoped, {
        app: 'fixtures',
        branch: 'feature/x',
      })
      assert.equal(job.status, 202)
      assert.deepEqual(
        [
          job.json.project,
          job.json.branch,
          job.json.status,
          job.json.automatic,
          job.json.number,
        ],
        ['fixtures', 'feature/x', 'queued', 0, 1],
      )
      const byApp = await api(node, 'POST', '/api/jobs', admin, {
        app: 'com.example.masonfixture',
      })
      assert.deepEqual(
        [byApp.status, byApp.json.branch, byApp.json.number, byApp.json.app],
        [202, 'master', 2, 'com.example.masonfixture'],
      )
      assert.equal(
        (
          await api(node, 'POST', '/api/jobs', admin, {
            app: 'fixtures',
            branch: 'other',
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await api(node, 'POST', '/api/jobs', scoped, {
            app: 'fixtures',
            branch: 'master',
          })
        ).status,
        403,
      )
      assert.equal(
        (
          await api(node, 'POST', '/api/jobs', other, {
            app: 'fixtures',
            branch: 'master',
          })
        ).status,
        403,
      )
      assert.equal(
        (await api(node, 'POST', '/api/jobs', tester, { app: 'fixtures' }))
          .status,
        403,
      )
      assert.equal(
        (await api(node, 'POST', '/api/jobs', admin, { app: 'nothing' }))
          .status,
        400,
      )
      assert.equal(
        (
          await api(node, 'POST', '/api/jobs', admin, {
            app: 'fixtures',
            platforms: [],
          })
        ).status,
        400,
      )
      assert.equal((await api(node, 'POST', '/api/jobs')).status, 401)
      // Idempotent requests return the same job; a changed one conflicts.
      const first = await api(node, 'POST', '/api/jobs', admin, {
        app: 'fixtures',
        idempotencyKey: 'k1',
      })
      const again = await api(node, 'POST', '/api/jobs', admin, {
        app: 'fixtures',
        idempotencyKey: 'k1',
      })
      assert.equal(first.json.id, again.json.id)
      assert.equal(
        (
          await api(node, 'POST', '/api/jobs', admin, {
            app: 'fixtures',
            branch: 'feature/y',
            idempotencyKey: 'k1',
          })
        ).status,
        400,
      )
      assert.equal(
        (await api(node, 'GET', `/api/jobs/${job.json.id}`, admin)).json.id,
        job.json.id,
      )
      assert.equal(
        (await api(node, 'GET', '/api/jobs/missing', admin)).status,
        404,
      )
      assert.equal((await api(node, 'GET', '/api/queue', admin)).json.length, 3)
      assert.equal((await api(node, 'GET', '/api/queue', tester)).status, 403)
      // Script projects keep their platforms and injected files.
      await api(node, 'PUT', '/api/v2/projects/script', admin, {
        repository: 'https://github.com/a/s',
        format: 'script',
        script: { platforms: ['ios'] },
      })
      await api(node, 'PUT', '/api/v2/projects/script/rules', admin, [
        { pattern: '**', mode: 'request' },
      ])
      await api(node, 'PUT', '/api/v2/projects/script/secrets', admin, {
        files: [
          { destination: 'c.json', contents: 'e30=', env: 'CONFIG_FILE' },
        ],
      })
      assert.equal(
        (
          await api(node, 'POST', '/api/jobs', admin, {
            app: 'script',
            platforms: ['android'],
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await api(node, 'POST', '/api/jobs', admin, {
            app: 'script',
            envVars: [{ CONFIG_FILE: 'x' }],
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await api(node, 'POST', '/api/jobs', admin, {
            app: 'script',
            platforms: ['ios'],
          })
        ).status,
        202,
      )
      // The queue holds at most 100 jobs.
      for (let i = 0; i < 96; i++)
        node.master!.jobs.request(localOperator, { app: 'script' })
      assert.equal(
        (await api(node, 'POST', '/api/jobs', admin, { app: 'script' })).status,
        400,
      )
      await api(node, 'PUT', '/api/v2/projects/off', admin, {
        repository: 'https://github.com/a/o',
        enabled: false,
      })
      assert.throws(
        () => node.master!.jobs.request(localOperator, { app: 'off' }),
        /disabled/,
      )
    } finally {
      await node.close()
    }
  })

  it('renders build numbers by scheme, scope and date part, never lower and never twice', () => {
    const master = database()
    const projects = new Projects(master)
    const id = projects.save(localOperator, 'p', {
      repository: 'https://github.com/a/b',
    }).project.id
    const numbers = new BuildNumbers(master)
    const plain = { format: 'N' }
    assert.deepEqual(
      [1, 2, 3].map((n) =>
        numbers.reserve(id, 'app', 'master', plain, `r${n}`),
      ),
      ['1', '2', '3'],
    )
    assert.equal(numbers.reserve(id, 'app', 'master', plain, 'r2'), '2')
    const branchScope = { scope: 'branch', format: 'N' }
    assert.equal(numbers.reserve(id, 'b', 'master', branchScope, 'x1'), '1')
    assert.equal(numbers.reserve(id, 'b', 'feature', branchScope, 'x2'), '1')
    assert.equal(numbers.reserve(id, 'b', 'master', branchScope, 'x3'), '2')
    const daily = { scope: 'branch', format: 'YYMMDDCC' }
    assert.equal(
      numbers.reserve(id, 'd', 'master', daily, 'd1', day(2026, 10, 17)),
      '26101701',
    )
    assert.equal(
      numbers.reserve(id, 'd', 'master', daily, 'd2', day(2026, 10, 17, 23)),
      '26101702',
    )
    assert.equal(
      numbers.reserve(id, 'd', 'master', daily, 'd3', day(2026, 10, 18, 1)),
      '26101801',
    )
    // The scheme's time zone decides the date: 05:00 UTC is still the 17th in Los Angeles.
    const pacific = {
      scope: 'branch',
      format: 'YYMMDDCC',
      timeZone: 'America/Los_Angeles',
    }
    assert.equal(
      numbers.reserve(
        id,
        'la',
        'master',
        pacific,
        'l1',
        Date.UTC(2026, 9, 18, 5),
      ),
      '26101701',
    )
    assert.equal(
      datePart(asScheme(pacific), Date.UTC(2026, 9, 18, 9)),
      '261018#',
    )
    // A count that outgrows its digits fails instead of wrapping.
    for (let n = 1; n <= 9; n++)
      numbers.reserve(
        id,
        'small',
        'master',
        { format: 'YYC' },
        `s${n}`,
        day(2026, 1, 1),
      )
    assert.throws(
      () =>
        numbers.reserve(
          id,
          'small',
          'master',
          { format: 'YYC' },
          's10',
          day(2026, 1, 1),
        ),
      /outgrew C/,
    )
    // start raises a sequence but never lowers it.
    assert.equal(
      numbers.reserve(id, 'v', 'master', { start: 4000 }, 'v1'),
      '4000',
    )
    assert.equal(
      numbers.reserve(id, 'v', 'master', { start: 10 }, 'v2'),
      '4001',
    )
    assert.equal(
      numbers.reserve(id, 'v', 'master', { start: 5000 }, 'v3'),
      '5000',
    )
    // A scheme that would render lower than an issued value is refused.
    assert.throws(
      () =>
        numbers.reserve(
          id,
          'd',
          'master',
          { scope: 'branch', format: 'N' },
          'back',
          day(2026, 10, 19),
        ),
      /not above 26101801/,
    )
    assert.throws(
      () =>
        numbers.checkScheme(id, 'd', 'master', {
          scope: 'branch',
          format: 'N',
        }),
      /raise start/,
    )
    numbers.checkScheme(id, 'd', 'master', daily, day(2026, 10, 19))
    numbers.checkScheme(id, 'fresh', 'master', daily)
    const many = new Set(
      Array.from({ length: 50 }, (_, n) =>
        numbers.reserve(id, 'concurrent', 'master', plain, `c${n}`),
      ),
    )
    assert.equal(many.size, 50)
    assert.equal(compareNumbers('1.10', '1.9') > 0, true)
    assert.equal(compareNumbers('2', '2.0'), 0)
    assert.equal(
      render(asScheme({ format: 'YYYY.MM.CC' }), day(2026, 3, 4), 7),
      '2026.03.07',
    )
  })

  it('validates schemes against Apple and Android rules', () => {
    for (const ok of [
      {},
      { format: 'YYMMDDCC', check: 'apple' },
      { format: 'YYYY.MM.CCC', check: 'apple' },
      { format: 'YYMMDDCC', check: 'android' },
      { format: 'YYYYMMDDCC', check: 'android' },
      { format: 'N', check: 'android' },
      { format: 'HHCC', timeZone: 'Europe/Paris' },
    ])
      asScheme(ok)
    for (const [bad, message] of [
      [{ format: 'YYYY.MM.DD.CC', check: 'apple' }, /three/],
      [{ format: 'YY-CC', check: 'apple' }, /three/],
      [{ format: '.N', check: 'apple' }, /three/],
      [{ format: 'YYYYMMDDCCC', check: 'android' }, /2,100,000,000/],
      [{ format: '1.N', check: 'android' }, /single integer/],
      [{ format: 'YYMMDD' }, /exactly one/],
      [{ format: 'NCC' }, /exactly one/],
      [{ format: '' }, /1–40/],
      [{ format: 'CC', start: 5 }, /N formats only/],
      [{ start: -1 }, /whole number/],
      [{ scope: 'project' }, /scope/],
      [{ timeZone: 'Mars/Olympus' }, /time zone/],
      [{ check: 'windows' }, /apple or android/],
    ] as const)
      assert.throws(() => asScheme(bad), message)
  })

  it('offsets counts by the instance count base', () => {
    const master = database()
    const projects = new Projects(master)
    const id = projects.save(localOperator, 'p', {
      repository: 'https://github.com/a/b',
    }).project.id
    const numbers = new BuildNumbers(master, () => 50)
    const daily = { scope: 'branch', format: 'YYMMDDCC' }
    assert.equal(
      numbers.reserve(id, 'app', 'master', daily, 'a', day(2026, 10, 20)),
      '26102051',
    )
    for (let n = 52; n <= 99; n++)
      numbers.reserve(id, 'app', 'master', daily, `a${n}`, day(2026, 10, 20))
    assert.throws(
      () =>
        numbers.reserve(id, 'app', 'master', daily, 'over', day(2026, 10, 20)),
      /outgrew CC/,
    )
    assert.equal(numbers.reserve(id, 'n', 'master', { start: 1 }, 'n'), '51')
    assert.throws(
      () =>
        numbers.reserve(
          id,
          'android',
          'master',
          { start: 2_100_000_000, check: 'android' },
          'big',
        ),
      /android limit/,
    )
  })

  it('U5.6 sets where a sequence stands so the next number follows it, for any format, without lowering it', async () => {
    const today = day(2026, 10, 20)
    const { node, admin } = await master()
    try {
      const m = node.master!
      const project = m.projects.save(localOperator, 'acme', {
        repository: 'https://github.com/a/t',
      }).project
      const daily = {
        scope: 'branch',
        format: 'YYMMDDCC',
        timeZone: 'UTC',
      } as const
      // Only a declared scheme can be seeded.
      assert.throws(
        () =>
          m.seed(
            'acme',
            'app',
            { branch: 'master', last: '26102003' },
            localOperator,
          ),
        /no build-number scheme yet/,
      )
      m.buildNumbers.declare(project.id, 'app', daily)
      m.seed(
        'acme',
        'app',
        { branch: 'master', last: '26102003' },
        localOperator,
      )
      assert.equal(
        m.buildNumbers.reserve(project.id, 'app', 'master', daily, 'm1', today),
        '26102004',
      )
      // An earlier day's number seeds only that day; today starts fresh.
      m.seed(
        'acme',
        'app',
        { branch: 'feature/x', last: '26101807' },
        localOperator,
      )
      assert.equal(
        m.buildNumbers.reserve(
          project.id,
          'app',
          'feature/x',
          daily,
          'f1',
          today,
        ),
        '26102001',
      )
      // A lower number leaves the sequence alone.
      m.seed(
        'acme',
        'app',
        { branch: 'master', last: '26102001' },
        localOperator,
      )
      assert.equal(
        m.buildNumbers.reserve(project.id, 'app', 'master', daily, 'm2', today),
        '26102005',
      )
      for (const [value, message] of [
        [{ last: '26102001' }, /name the branch/],
        [{ branch: 'x', last: 'nope' }, /does not have the YYMMDDCC format/],
        [{ branch: 'x', last: '2610201' }, /does not have the YYMMDDCC format/],
        [{ branch: 'x' }, /An empty value/],
      ] as const)
        assert.throws(
          () => m.seed('acme', 'app', value, localOperator),
          message,
        )
      // A plain count with literals, numbered across branches.
      m.buildNumbers.declare(project.id, 'plain', { format: '1.N' })
      m.seed('acme', 'plain', { last: '1.41' }, localOperator)
      assert.equal(
        m.buildNumbers.reserve(
          project.id,
          'plain',
          'any',
          { format: '1.N' },
          'p1',
          today,
        ),
        '1.42',
      )
      assert.throws(
        () => m.seed('acme', '', { last: '1' }, localOperator),
        /key is required/,
      )
      assert.throws(
        () => m.seed('missing', 'app', { last: '1' }, localOperator),
        /No project/,
      )
      // Managers and admins may seed over the API; developers may not.
      const developerKey = m.keys.create(localOperator, {
        role: 'developer',
      }).token
      const body = {
        project: 'acme',
        key: 'app',
        branch: 'release',
        last: '26102030',
      }
      assert.equal(
        (
          await api(
            node,
            'POST',
            '/api/v2/build-numbers/seed',
            developerKey,
            body,
          )
        ).status,
        403,
      )
      assert.deepEqual(
        (await api(node, 'POST', '/api/v2/build-numbers/seed', admin, body))
          .json,
        { key: 'app', branch: 'release', last: '26102030' },
      )
      assert.equal(
        m.buildNumbers.reserve(
          project.id,
          'app',
          'release',
          daily,
          'r1',
          today,
        ),
        '26102031',
      )
      assert.equal(
        (
          await api(node, 'POST', '/api/v2/build-numbers/seed', admin, {
            ...body,
            project: 'nope',
          })
        ).status,
        404,
      )
      assert.equal(
        (
          await api(node, 'PUT', '/api/v2/settings/buildNumbers', admin, {
            countBase: -1,
          })
        ).status,
        400,
      )
      // There is no command for it: the API is the way in.
      assert.equal(
        await nodeMain(['build-numbers', 'seed', '--data', node.dir], io()),
        1,
      )
    } finally {
      await node.close()
    }
  })

  it('answers API errors with 400, 403, 404 and 409 and audits every change', async () => {
    const { node, admin } = await master()
    try {
      const developerKey = node.master!.keys.create(localOperator, {
        role: 'developer',
      }).token
      assert.equal(
        (
          await api(node, 'PUT', '/api/v2/projects/p', admin, {
            repository: 'https://github.com/a/b',
          })
        ).status,
        201,
      )
      assert.equal(
        (await api(node, 'PUT', '/api/v2/projects/p', admin, { name: 'P' }))
          .status,
        200,
      )
      assert.equal(
        (await api(node, 'PUT', '/api/v2/projects/q', admin, {})).status,
        400,
      )
      assert.equal(
        (
          await api(node, 'PUT', '/api/v2/projects/p', developerKey, {
            name: 'X',
          })
        ).status,
        403,
      )
      assert.equal(
        (await api(node, 'GET', '/api/v2/projects/missing', admin)).status,
        404,
      )
      assert.equal(
        (await api(node, 'GET', '/api/v2/projects', developerKey)).json.length,
        1,
      )
      assert.equal(
        (await api(node, 'GET', '/api/v2/projects/p', developerKey)).json.name,
        'P',
      )
      await api(node, 'POST', '/api/v2/projects/p/apps', admin, {
        bundleId: 'a.b',
        name: 'A',
        platforms: ['ios'],
      })
      await api(node, 'PUT', '/api/v2/projects/q', admin, {
        repository: 'https://github.com/a/q',
      })
      assert.equal(
        (
          await api(node, 'POST', '/api/v2/projects/q/apps', admin, {
            bundleId: 'a.b',
            name: 'A',
            platforms: ['ios'],
          })
        ).status,
        409,
      )
      assert.equal(
        (await api(node, 'DELETE', '/api/v2/projects/q/apps/a.b', admin))
          .status,
        404,
      )
      assert.equal(
        (await api(node, 'DELETE', '/api/v2/projects/p/apps/a.b', admin))
          .status,
        200,
      )
      assert.equal(
        (
          await api(node, 'PUT', '/api/v2/projects/p/secrets', admin, {
            env: [{ name: 'X', value: '1' }],
          })
        ).json.env.length,
        1,
      )
      assert.equal(
        (
          await api(node, 'PUT', '/api/v2/projects/p/rules', admin, [
            { pattern: '**', mode: 'nope' },
          ])
        ).status,
        400,
      )
      await api(node, 'PUT', '/api/v2/projects/p/rules', admin, [
        { pattern: '**', mode: 'request' },
      ])
      node.master!.jobs.request(localOperator, { app: 'p' })
      assert.equal(
        (await api(node, 'DELETE', '/api/v2/projects/p', admin)).status,
        409,
      )
      assert.equal(
        (await api(node, 'DELETE', '/api/v2/projects/q', admin)).status,
        200,
      )
      const audit = node.databases
        .get('master.sqlite')!
        .prepare(
          "SELECT action FROM audit WHERE action LIKE 'project.%' ORDER BY id",
        )
        .all()
        .map((row) => row.action)
      assert.deepEqual(audit, [
        'project.create',
        'project.update',
        'project.app',
        'project.create',
        'project.app.remove',
        'project.secrets',
        'project.rules',
        'project.remove',
      ])
      // The same through the command line.
      const file = path.join(root, 'project.json')
      writeFileSync(
        file,
        JSON.stringify({
          repository: 'https://github.com/a/c',
          format: 'script',
          apps: [{ bundleId: 'c.d', name: 'C', platforms: ['android'] }],
          rules: [{ pattern: 'master', mode: 'automatic' }],
          secrets: { env: [{ name: 'TOKEN', value: 'x' }] },
        }),
      )
      const set = io()
      assert.equal(
        await nodeMain(
          ['projects', 'set', 'cli', '--file', file, '--data', node.dir],
          set,
        ),
        0,
      )
      assert.equal(JSON.parse(set.lines.join('\n')).apps[0].bundleId, 'c.d')
      const listed = io()
      assert.equal(
        await nodeMain(['projects', 'list', '--data', node.dir], listed),
        0,
      )
      assert(listed.lines.some((line) => line.startsWith('cli  script')))
      assert.equal(
        await nodeMain(
          ['projects', 'list', '--json', '--data', node.dir],
          io(),
        ),
        0,
      )
      const got = io()
      assert.equal(
        await nodeMain(['projects', 'get', 'cli', '--data', node.dir], got),
        0,
      )
      assert.equal(JSON.parse(got.lines.join('\n')).env[0].name, 'TOKEN')
      assert.equal(
        await nodeMain(['projects', 'remove', 'cli', '--data', node.dir], io()),
        0,
      )
      assert.equal(
        await nodeMain(['projects', 'frob', '--data', node.dir], io()),
        1,
      )
    } finally {
      await node.close()
    }
  })

  it('connects to GitHub with a token, an app or a generated SSH key, secrets write-only', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
    let jwt = ''
    const fake = await fakeGitHub((url, headers) => {
      if (url === '/user') {
        const auth = String(headers.authorization)
        if (auth === 'Bearer good')
          return {
            status: 200,
            headers: { 'X-OAuth-Scopes': 'repo, read:org' },
          }
        if (auth === 'Bearer narrow')
          return { status: 200, headers: { 'X-OAuth-Scopes': 'read:org' } }
        if (auth === 'Bearer fine-grained') return { status: 200 }
        return { status: 401 }
      }
      if (url === '/app/installations/77/access_tokens') {
        jwt = String(headers.authorization).slice(7)
        return {
          status: 201,
          body: {
            token: 'ghs_installation',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          },
        }
      }
      return { status: 404 }
    })
    const { node, admin } = await master({
      masterOptions: { github: { apiBase: fake.origin } },
    })
    try {
      const m = node.master!
      const put = async (
        body: unknown,
      ): Promise<{ status: number; json: Json }> =>
        await api(node, 'PUT', '/api/v2/settings/github', admin, body)
      assert.equal((await put({ kind: 'token', token: 'bad' })).status, 400)
      assert.match(
        (await put({ kind: 'token', token: 'narrow' })).json.error,
        /repo scope/,
      )
      assert.deepEqual(
        (await put({ kind: 'token', token: 'fine-grained' })).json,
        { kind: 'token', token: { set: true } },
      )
      assert.deepEqual((await put({ kind: 'token', token: 'good' })).json, {
        kind: 'token',
        token: { set: true },
      })
      assert.equal(
        (await put({ kind: 'token', token: { keep: true } })).status,
        200,
      )
      assert.equal((await put({ kind: 'token' })).status, 400)
      const access = await m.github.gitAccess(
        'https://github.com/example/mason-fixtures.git',
        root,
      )
      assert.equal(access.url, 'https://github.com/example/mason-fixtures.git')
      assert.equal(
        access.env.GIT_CONFIG_VALUE_0,
        `AUTHORIZATION: basic ${Buffer.from('x-access-token:good').toString('base64')}`,
      )
      const plain = await m.github.gitAccess('https://example.test/x.git', root)
      assert.equal(plain.url, 'https://example.test/x.git')
      assert.equal(plain.env.GIT_CONFIG_COUNT, undefined)
      // A GitHub App: the master signs a JWT and caches the installation token.
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      assert.equal(
        (
          await put({
            kind: 'app',
            appId: 12,
            installationId: 77,
            privateKey: pem,
          })
        ).status,
        200,
      )
      const [header, payload, signature] = jwt.split('.')
      assert(
        verify(
          'sha256',
          Buffer.from(`${header}.${payload}`),
          publicKey,
          Buffer.from(signature!, 'base64url'),
        ),
      )
      assert.equal(
        JSON.parse(Buffer.from(payload!, 'base64url').toString()).iss,
        12,
      )
      const appAccess = await m.github.gitAccess('git@github.com:a/b.git', root)
      assert.equal(appAccess.url, 'https://github.com/a/b.git')
      assert.equal(
        appAccess.env.GIT_CONFIG_VALUE_0,
        `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_installation').toString('base64')}`,
      )
      assert.equal(
        (
          await put({
            kind: 'app',
            appId: 12,
            installationId: 78,
            privateKey: { keep: true },
          })
        ).status,
        400,
      )
      assert.equal(
        (
          await put({
            kind: 'app',
            appId: 0,
            installationId: 77,
            privateKey: pem,
          })
        ).status,
        400,
      )
      assert.equal(
        (await put({ kind: 'app', appId: 12, installationId: 77 })).status,
        400,
      )
      // An SSH deploy key the master generates; its public half is shown.
      const ssh = await put({ kind: 'ssh' })
      assert.match(ssh.json.publicKey, /^ssh-ed25519 /)
      assert.deepEqual(ssh.json.privateKey, { set: true })
      assert.equal(
        (await put({ kind: 'ssh', privateKey: { keep: true } })).json.publicKey,
        ssh.json.publicKey,
      )
      assert.notEqual(
        (await put({ kind: 'ssh' })).json.publicKey,
        ssh.json.publicKey,
      )
      const sshAccess = await m.github.gitAccess(
        'https://github.com/a/b.git',
        root,
      )
      assert.equal(sshAccess.url, 'git@github.com:a/b.git')
      assert.match(sshAccess.env.GIT_SSH_COMMAND!, /-o IdentitiesOnly=yes/)
      assert.equal((await put({ kind: 'carrier pigeon' })).status, 400)
      assert.equal(storedConnection(undefined), undefined)
      assert.equal(storedConnection({ kind: 'other' }), undefined)
      const offline = new GitHub(() => undefined, {
        apiBase: 'http://127.0.0.1:1',
      })
      await assert.rejects(offline.checkToken('x'))
      const broken = new GitHub(() => undefined, {
        fetch: async (): Promise<Response> =>
          new Response(JSON.stringify({}), { status: 201 }),
      })
      await assert.rejects(
        broken.installationToken(1, 2, pem),
        /no installation token/,
      )
      const refused = new GitHub(() => undefined, {
        fetch: async (): Promise<Response> => new Response('', { status: 403 }),
      })
      await assert.rejects(
        refused.installationToken(1, 2, pem),
        /refused the app/,
      )
      const noExpiry = new GitHub(() => undefined, {
        fetch: async (): Promise<Response> =>
          new Response(JSON.stringify({ token: 't' }), { status: 201 }),
      })
      assert.equal(await noExpiry.installationToken(1, 2, pem), 't')
      assert.equal(await noExpiry.installationToken(1, 2, pem), 't')
    } finally {
      await node.close()
      fake.server.close()
    }
  })
})
