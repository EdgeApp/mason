import assert from 'node:assert/strict'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { WebSocket } from 'ws'
import { SESSION_COOKIE } from '../auth/routes.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { MASTER_SESSION_COOKIE } from './auth.js'
import { localOperator } from './roles.js'
import { declaredApps, slugFor } from './wizard.js'
import { seedSecret } from '../test/secrets.js'

// Rows and replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
interface Reply {
  status: number
  text: string
  json: Json
  type: string
}

const masonfile = `
export function setup(m) {
  m.apiVersion(1)
  m.workflow('build', { params: { seat: { type: 'choice', choices: ['none', '1'], default: 'none' } } }, (w) => {
    const tested = w.stage('test', { on: 'worker', run: test })
    w.stage('android', { needs: [tested], on: 'linux', tools: { android: ['platforms;android-35'] }, publishes: ['app.example.wizard'], run: build })
  })
  m.workflow('release', { triggers: [{ request: true }] }, (w) => {
    const approved = w.approval('approve', { roles: ['manager'] })
    w.stage('ios', { needs: [approved], on: { os: 'macos' }, apple: { distribution: 'appStore', app: 'app.example.wizard' }, publishes: ['app.example.wizard'], run: build })
  })
}
export async function test(ctx) {
  await ctx.sh('echo "\\u001b[32mgreen\\u001b[0m line"')
  ctx.log.info('second line')
}
export function build() {}
`

describe('Master and host pages for runs, projects, nodes, settings and people', function () {
  this.timeout(240_000)
  let c: Cluster
  let host: RunningNode
  const people: Record<string, number> = {}
  const hooks: Array<{ url: string; body: Json }> = []
  const origin = (node: RunningNode): string =>
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  const request = async (
    node: RunningNode,
    method: string,
    route: string,
    options: {
      cookie?: string
      csrf?: string
      body?: unknown
      accept?: string
    } = {},
  ): Promise<Reply> => {
    const response = await pinnedFetch(
      origin(node) + route,
      {
        method,
        redirect: 'manual',
        headers: {
          ...(options.cookie == null ? {} : { cookie: options.cookie }),
          ...(options.csrf == null
            ? {}
            : { 'x-mason-csrf': options.csrf, origin: origin(node) }),
          ...(options.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...(options.accept == null ? {} : { accept: options.accept }),
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
      type: response.headers.get('content-type') ?? '',
    }
  }
  const signIn = (role: string): { cookie: string; csrf: string } => {
    const { token, session } = c.master.master!.auth.start(
      people[role]!,
      '127.0.0.1',
    )
    return { cookie: `${MASTER_SESSION_COOKIE}=${token}`, csrf: session.csrf }
  }
  const onHost = (role: string): { cookie: string; csrf: string } => {
    const { token, session } = host.host!.accounts.startSession(people[role]!)
    return { cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrf }
  }
  /** A `/live` socket on a node, with the frames it has received; or the status that refused it. */
  const live = async (
    node: RunningNode,
    headers: Record<string, string>,
  ): Promise<
    | number
    | {
        ws: WebSocket
        frames: Json[]
        send: (message: unknown) => void
        next: (test: (frame: Json) => boolean) => Promise<Json>
      }
  > => {
    const ws = new WebSocket(origin(node).replace('https:', 'wss:') + '/live', {
      headers,
      rejectUnauthorized: false,
    })
    const frames: Json[] = []
    const waiting: Array<{ test: (frame: Json) => boolean; done: () => void }> =
      []
    ws.on('message', (data) => {
      frames.push(JSON.parse(String(data)))
      for (const wait of [...waiting]) wait.done()
    })
    const opened = await new Promise<number>((resolve) => {
      ws.once('open', () => resolve(0))
      ws.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 1)
        ws.terminate()
      })
      ws.on('error', () => resolve(1))
    })
    if (opened !== 0) return opened
    return {
      ws,
      frames,
      send: (message) => ws.send(JSON.stringify(message)),
      next: async (test) =>
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error(`No such frame in ${JSON.stringify(frames)}`)),
            10_000,
          )
          const wait = {
            test,
            done: (): void => {
              const found = frames.find(test)
              if (found == null) return
              clearTimeout(timer)
              waiting.splice(waiting.indexOf(wait), 1)
              resolve(found)
            },
          }
          waiting.push(wait)
          wait.done()
        }),
    }
  }
  let run: string

  before(async () => {
    const root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'ui-'),
    )
    c = await cluster(path.join(root, 'cluster'), {
      workers: [{ name: 'w', type: 'worker' }],
      masterOptions: {
        github: {
          apiBase: 'https://api.github.example',
          fetch: (async (url: string | URL, init?: RequestInit) => {
            const target = String(url)
            if (target.endsWith('/user'))
              return new Response('{}', {
                status: 200,
                headers: { 'x-oauth-scopes': 'repo' },
              })
            if (target.endsWith('/hooks')) {
              hooks.push({ url: target, body: JSON.parse(String(init?.body)) })
              return new Response('{}', { status: 201 })
            }
            return new Response('{}', { status: 404 })
          }) as typeof fetch,
        },
      },
    })
    host = await c.startHost('host', { testEndpoints: true })
    const master = c.master.master!
    await master.settings.set(localOperator, 'host', { origin: origin(host) })
    await master.settings.set(localOperator, 'github', {
      kind: 'token',
      token: 'ghp_fixture',
    })
    await master.settings.set(localOperator, 'nodeTypes', { worker: {} })
    c.repo('fixtures/wizard').commit({ 'Masonfile.ts': masonfile })
    for (const role of ['admin', 'manager', 'developer', 'tester'] as const)
      people[role] = (
        await master.people.create(localOperator, {
          email: `${role}.person@example.test`,
          name: `${role} person`,
          role,
          addresses: { google: `${role}@example.test` },
        })
      ).id
    await c.until(
      () =>
        (
          host
            .host!.cache.db.prepare('SELECT COUNT(*) AS n FROM accounts')
            .get() as { n: number }
        ).n >= 4,
      10_000,
      'the people on the host',
    )
  })
  after(async () => {
    await c?.close()
  })

  it('U18.5 adds a project through the wizard: repository check, the Masonfile’s app IDs, ownership, rules, webhook, read-only triggers', async () => {
    const manager = signIn('manager')
    const repository = c.repos.get('fixtures/wizard')!.url
    const refused = await request(c.master, 'POST', '/api/v2/projects/check', {
      ...signIn('developer'),
      body: { repository },
    })
    assert.equal(refused.status, 403)
    assert.equal(
      (await request(c.master, 'GET', '/projects/new', signIn('developer')))
        .status,
      403,
    )
    const page = await request(c.master, 'GET', '/projects/new', manager)
    assert.match(page.text, /data-path="\/api\/v2\/projects\/check"/)
    const checked = await request(c.master, 'POST', '/api/v2/projects/check', {
      ...manager,
      body: { repository },
    })
    assert.equal(checked.status, 200, checked.text)
    assert.deepEqual(checked.json, {
      repository,
      slug: 'wizard',
      defaultBranch: 'master',
    })
    const missing = await request(c.master, 'POST', '/api/v2/projects/check', {
      ...manager,
      body: { repository: 'https://github.com/fixtures/none.git' },
    })
    assert.equal(missing.status, 400)
    assert.equal(
      (
        await request(c.master, 'PUT', '/api/v2/projects/wizard', {
          ...manager,
          body: {
            name: 'wizard',
            repository,
            defaultBranch: 'master',
            format: 'pipeline',
          },
        })
      ).status,
      201,
    )
    assert.match(
      (await request(c.master, 'GET', '/projects/new?slug=wizard', manager))
        .text,
      /Read the Masonfile on master/,
    )
    const started = await request(
      c.master,
      'POST',
      '/api/v2/projects/wizard/discover',
      { ...manager, body: {} },
    )
    assert.equal(started.status, 202, started.text)
    let discovered: Json
    for (
      let tries = 0;
      tries < 240 && discovered?.status !== 'succeeded';
      tries++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      discovered = (
        await request(
          c.master,
          'GET',
          '/api/v2/projects/wizard/discover',
          manager,
        )
      ).json
      if (discovered?.status === 'failed') assert.fail(discovered.reason)
    }
    assert.deepEqual(discovered.apps, [
      { bundleId: 'app.example.wizard', platforms: ['android', 'ios'] },
    ])
    assert.deepEqual(Object.keys(discovered.triggers), ['build', 'release'])
    const apps = await request(
      c.master,
      'GET',
      '/projects/new?slug=wizard',
      manager,
    )
    assert.match(apps.text, /value="app\.example\.wizard"/)
    assert.match(apps.text, /Android/)
    const owned = await request(
      c.master,
      'POST',
      '/api/v2/projects/wizard/wizard/apps',
      { ...manager, body: { apps: 'app.example.wizard', team: 'ABCDE12345' } },
    )
    assert.equal(owned.status, 200, owned.text)
    assert.deepEqual(
      owned.json.apps.map((app: Json) => [
        app.bundleId,
        app.platforms,
        app.apple?.team,
      ]),
      [['app.example.wizard', ['android', 'ios'], 'ABCDE12345']],
    )
    assert.equal(
      (
        await request(c.master, 'POST', '/api/v2/projects/wizard/wizard/apps', {
          ...manager,
          body: { apps: 'not.declared' },
        })
      ).status,
      400,
    )
    const rules = await request(
      c.master,
      'POST',
      '/api/v2/projects/wizard/wizard/rules',
      { ...manager, body: { rules: 'master automatic\n\n* request' } },
    )
    assert.deepEqual(
      rules.json.rules.map((rule: Json) => `${rule.pattern} ${rule.mode}`),
      ['master automatic', '* request'],
    )
    const webhook = await request(
      c.master,
      'POST',
      '/api/v2/projects/wizard/webhook',
      { ...manager, body: {} },
    )
    assert.deepEqual(webhook.json, {
      created: true,
      url: `${origin(host)}/api/webhooks/github/wizard`,
    })
    assert.equal(
      hooks[0]!.url,
      'https://api.github.example/repos/fixtures/wizard/hooks',
    )
    assert.equal(
      hooks[0]!.body.config.url,
      `${origin(host)}/api/webhooks/github/wizard`,
    )
    assert.match(hooks[0]!.body.config.secret, /^[0-9a-f]{48}$/)
    const third = await request(
      c.master,
      'GET',
      '/projects/new?slug=wizard',
      manager,
    )
    assert.match(third.text, /Branches and triggers/)
    assert.match(third.text, /The project has a webhook secret/)
    assert.match(
      third.text,
      /<span class="mono">release<\/span> <small class="mono">\[\{&quot;request&quot;:true\}\]<\/small>/,
    )
    // The discovery run never shows among the project's runs.
    assert.doesNotMatch(
      (await request(c.master, 'GET', '/', manager)).text,
      /@discover/,
    )
    assert.equal(slugFor('git@github.com:Owner/My_App.git'), 'my-app')
    assert.deepEqual(
      declaredApps({
        apiVersion: 1,
        workflows: [],
        buildNumbers: {},
        warnings: [],
      } as never),
      [],
    )
    // A stage that may run on Windows, alone or in a list, publishes for windows.
    for (const on of [{ os: 'windows' }, ['linux', { os: 'windows' }]])
      assert.deepEqual(
        declaredApps({
          apiVersion: 1,
          workflows: [
            {
              stages: [
                { on, publishes: ['app.example.win'], buildNumbers: [] },
              ],
              post: [],
            },
          ],
          buildNumbers: {},
          warnings: [],
        } as never),
        [{ bundleId: 'app.example.win', platforms: ['windows'] }],
      )
    // A stage that signs for tvOS builds tvOS; one that only distributes, iOS.
    assert.deepEqual(
      declaredApps({
        apiVersion: 1,
        workflows: [
          {
            stages: [
              {
                publishes: ['app.example.tv'],
                buildNumbers: [],
                apple: { distribution: 'adHoc', platform: 'tvos' },
              },
              {
                publishes: ['app.example.tv'],
                buildNumbers: [],
                apple: { distribution: 'appStore' },
              },
            ],
            post: [],
          },
        ],
        buildNumbers: {},
        warnings: [],
      } as never),
      [{ bundleId: 'app.example.tv', platforms: ['ios', 'tvos'] }],
    )
    // A build-number sequence keyed by an app ID names that app ID.
    assert.deepEqual(
      declaredApps({
        apiVersion: 1,
        workflows: [
          {
            stages: [
              { publishes: [], buildNumbers: ['app.example.mac', 'nightly'] },
            ],
            post: [],
          },
        ],
        buildNumbers: { 'app.example.phone': {} },
        warnings: [],
      } as never),
      [
        { bundleId: 'app.example.mac', platforms: [] },
        { bundleId: 'app.example.phone', platforms: [] },
      ],
    )
  })

  it('U18.4 run actions carry the CSRF proof, check roles and validate like the API; a stage’s steps and log by stage and step', async () => {
    const developer = signIn('developer')
    const body = { project: 'wizard', branch: 'master', params: { seat: '1' } }
    assert.equal(
      (
        await request(c.master, 'POST', '/api/v2/runs', {
          cookie: developer.cookie,
          body,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request(c.master, 'POST', '/api/v2/runs', {
          ...signIn('tester'),
          body,
        })
      ).status,
      403,
    )
    // Parameters are checked against the Masonfile once its setup has run.
    const bad = await request(c.master, 'POST', '/api/v2/runs', {
      ...developer,
      body: { ...body, params: { seat: '9' } },
    })
    assert.equal(bad.status, 202)
    const failed = await c.until(
      () =>
        c.master
          .master!.database.db.prepare(
            "SELECT reason FROM jobs WHERE id=? AND status='failed'",
          )
          .get(bad.json.id) as Json,
      60_000,
      'the bad run to fail',
    )
    assert.match(failed.reason, /seat/)
    const requested = await request(c.master, 'POST', '/api/v2/runs', {
      ...developer,
      body,
    })
    assert.equal(requested.status, 202, requested.text)
    run = requested.json.id
    await c.until(
      () =>
        (
          c.master
            .master!.database.db.prepare(
              "SELECT status FROM job_stages WHERE job_id=? AND name='test'",
            )
            .get(run) as Json
        )?.status === 'succeeded',
      60_000,
      'the test stage',
    )
    const page = await request(c.master, 'GET', `/runs/${run}`, developer)
    assert.equal(page.status, 200)
    // The header names who requested the run, and the API names them too.
    assert.match(page.text, /Requested by developer person<\/p>/)
    const shown = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}`,
      developer,
    )
    assert.equal(shown.json.actor, `account:${people.developer}`)
    assert.equal(shown.json.requestedBy, 'developer person')
    assert.match(page.text, /class="pipeline-graph"/)
    assert.match(page.text, /data-stage="android"/)
    assert.match(page.text, /data-path="\/api\/v2\/runs\/[^/]+\/cancel"/)
    assert.match(page.text, /src="\/assets\/run\.js"/)
    const stage = await request(
      c.master,
      'GET',
      `/runs/${run}?stage=test`,
      developer,
    )
    assert.match(stage.text, /class="ansi-green">green<\/span> line/)
    assert.match(stage.text, /second line/)
    const steps = c.master
      .master!.database.db.prepare(
        "SELECT id,log_start,log_end FROM job_steps WHERE job_id=? AND stage='test' ORDER BY id",
      )
      .all(run) as Json[]
    assert(steps.length > 0)
    assert(
      steps.every(
        (step: Json) =>
          step.log_start != null &&
          step.log_end != null &&
          step.log_end >= step.log_start,
      ),
    )
    const one = await request(
      c.master,
      'GET',
      `/runs/${run}?stage=test&step=${steps[0].id}`,
      developer,
    )
    assert.match(one.text, /Lines of this step/)
    assert.match(
      (
        await request(
          c.master,
          'GET',
          `/runs/${run}?stage=test&step=999`,
          developer,
        )
      ).text,
      /There is no such step/,
    )
    const raw = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}/logs?stage=test`,
      developer,
    )
    assert.match(raw.text, /\u001b\[32mgreen/)
    const plain = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}/logs?stage=test&plain=1`,
      developer,
    )
    assert.match(plain.text, /^green line$/m)
    // The live socket: a session from the master's own pages, or an API key.
    const pageOrigin = { origin: origin(c.master) }
    const watching = await live(c.master, {
      cookie: developer.cookie,
      ...pageOrigin,
    })
    assert(typeof watching !== 'number')
    watching.send({ subscribe: 'run', run, stage: 'test' })
    const logged = await watching.next((frame) => frame.event === 'log')
    assert.match(logged.data.text, /green.* line\n/)
    assert.equal(logged.data.first, 1)
    assert.deepEqual(watching.frames.map((frame) => frame.event).slice(0, 3), [
      'run',
      'stages',
      'steps',
    ])
    assert.equal(watching.frames[0].data.status, 'running')
    assert.deepEqual(
      watching.frames[1].data.map(
        (stage: Json) => `${stage.name} ${stage.status}`,
      ),
      ['test succeeded', 'android queued'],
    )
    assert.equal(watching.frames[1].data[0].node, 'w')
    assert(watching.frames[2].data.steps.length > 0)
    watching.send({ subscribe: 'queue' })
    const queued = await watching.next((frame) => frame.event === 'queue')
    assert(
      queued.data.some(
        (entry: Json) => entry.job === run && entry.stage === 'android',
      ),
    )
    watching.ws.close()
    const testerSocket = await live(c.master, {
      cookie: signIn('tester').cookie,
      ...pageOrigin,
    })
    assert(typeof testerSocket !== 'number')
    testerSocket.send({ subscribe: 'run', run })
    assert.match(
      (await testerSocket.next((frame) => frame.event === 'error')).data.error,
      /tester role/,
    )
    testerSocket.ws.close()
    // A page's socket needs its own origin; a missing session is refused.
    assert.equal(await live(c.master, { cookie: developer.cookie }), 403)
    assert.equal(
      await live(c.master, {
        cookie: developer.cookie,
        origin: 'https://elsewhere.example',
      }),
      403,
    )
    assert.equal(await live(c.master, pageOrigin), 401)
    const key = c.master.master!.keys.create(localOperator, {
      role: 'developer',
    })
    assert.equal(
      await live(c.master, { authorization: 'Bearer mason_v1_nothing' }),
      401,
    )
    const scripted = await live(c.master, {
      authorization: `Bearer ${key.token}`,
    })
    assert(typeof scripted !== 'number')
    scripted.send({ subscribe: 'status', run })
    assert.equal(
      (await scripted.next((frame) => frame.event === 'run')).data.id,
      run,
    )
    scripted.ws.close()
    // A live page leaves a partial last line to the socket, which sends it once the stage settles.
    const logFile = c.master.master!.scheduler.logFile(run, 'test')
    const whole = readFileSync(logFile)
    appendFileSync(logFile, 'partial')
    const partial = await request(
      c.master,
      'GET',
      `/runs/${run}?stage=test`,
      developer,
    )
    assert.match(partial.text, new RegExp(`data-offset="${whole.length}"`))
    assert.doesNotMatch(partial.text, /partial/)
    const rest = await live(c.master, { authorization: `Bearer ${key.token}` })
    assert(typeof rest !== 'number')
    rest.send({ subscribe: 'run', run, stage: 'test', after: whole.length })
    assert.equal(
      (await rest.next((frame) => frame.event === 'log')).data.text,
      'partial',
    )
    rest.ws.close()
    writeFileSync(logFile, whole)
    // A run a key requested names the key by six characters of its id, off the master too.
    const keyed = await pinnedFetch(
      origin(c.master) + '/api/v2/runs',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...body, params: { seat: 'none' } }),
      },
      c.master.web!.certificate!.pin,
    )
    const keyedBody = (await keyed.json()) as Json
    assert.equal(keyed.status, 202, JSON.stringify(keyedBody))
    const keyedRun = keyedBody.id
    const keyedShown = await request(
      c.master,
      'GET',
      `/api/v2/runs/${keyedRun}`,
      developer,
    )
    const short = key.id.slice(0, 6)
    assert.equal(keyedShown.json.actor, `key ${short}`)
    assert.equal(
      keyedShown.json.requestedBy,
      `local operator · key "developer key ${short}" (${short})`,
    )
    assert.doesNotMatch(keyedShown.text, new RegExp(key.id))
    const cached = await c.until(
      () =>
        host
          .host!.cache.db.prepare(
            'SELECT actor,requested_by FROM jobs WHERE id=?',
          )
          .get(keyedRun) as Json,
      10_000,
      'the keyed run on the host',
    )
    assert.deepEqual(
      { ...cached },
      {
        actor: `key ${short}`,
        requested_by: `local operator · key "developer key ${short}" (${short})`,
      },
    )
    assert.equal(
      (
        await request(c.master, 'POST', `/api/v2/runs/${keyedRun}/cancel`, {
          ...developer,
          body: {},
        })
      ).status,
      200,
    )
    assert.equal(
      (await request(c.master, 'GET', `/runs/${run}`, signIn('tester'))).status,
      403,
    )
    assert.equal(
      (await request(c.master, 'GET', '/runs/none', developer)).status,
      404,
    )
    const timeline = await request(
      c.master,
      'GET',
      `/runs/${run}?tab=timeline`,
      developer,
    )
    assert.match(timeline.text, /class="timeline"/)
    // The Masonfile tab shows the file at a run's commit.
    const file = await request(
      c.master,
      'GET',
      '/projects/wizard/masonfile',
      developer,
    )
    assert.match(file.text, /m\.apiVersion\(1\)/)
    assert.match(file.text, /<\/span><span class="line" data-line="2">/)
    const api = await request(
      c.master,
      'GET',
      `/api/v2/projects/wizard/masonfile?commit=${'0'.repeat(40)}`,
      developer,
    )
    assert.equal(api.status, 400)
  })

  it('serves the run view on the host, its logs forwarded and its live updates relayed from the master, and a developer’s cancel through it', async () => {
    await c.until(
      () =>
        host.host!.cache.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(run),
      10_000,
      'the run on the host',
    )
    const developer = onHost('developer')
    const page = await request(
      host,
      'GET',
      `/runs/${run}?stage=test`,
      developer,
    )
    assert.equal(page.status, 200)
    assert.match(page.text, /<meta name="mason-csrf"/)
    assert.match(page.text, /Requested by developer person<\/p>/)
    assert.match(page.text, /data-offset="tail"/)
    assert.match(page.text, /<title>Run \d+ /)
    // The build number the run reserved reaches the host with the run, and leads its page.
    const master = c.master.master!
    master.database.db
      .prepare(
        "INSERT INTO build_number_reservations(project_id,key,reservation,value,created_at) VALUES(?,'app.example.wizard',?,'26110299',1)",
      )
      .run(master.projects.get('wizard').id, run)
    master.database.change('job', run)
    await c.until(
      () =>
        (
          host
            .host!.cache.db.prepare('SELECT build_number FROM jobs WHERE id=?')
            .get(run) as Json
        )?.build_number === '26110299',
      10_000,
      'the build number on the host',
    )
    const numbered = (await request(host, 'GET', `/runs/${run}`, developer))
      .text
    assert.match(
      numbered,
      /class="run-title">Build 26110299<\/a> <small class="run-number">Run \d+<\/small>/,
    )
    assert.match(numbered, /<title>Build 26110299 · Run \d+ /)
    assert.match(
      (await request(c.master, 'GET', `/runs/${run}`, signIn('developer')))
        .text,
      /class="run-title">Build 26110299<\/a>/,
    )
    master.database.db
      .prepare('DELETE FROM build_number_reservations WHERE reservation=?')
      .run(run)
    master.database.change('job', run)
    const step = await request(
      host,
      'GET',
      `/runs/${run}?stage=test&step=1`,
      developer,
    )
    assert.match(
      step.text,
      /data-src="\/api\/v2\/runs\/[^"]+\/logs\?stage=test&amp;step=1"/,
    )
    assert.match(
      (await request(host, 'GET', `/runs/${run}`, developer)).text,
      /The whole run’s log is on the master/,
    )
    assert.equal(
      (await request(host, 'GET', `/runs/${run}`, onHost('tester'))).status,
      403,
    )
    assert.equal(
      (await request(host, 'GET', '/runs/none', developer)).status,
      404,
    )
    assert.equal((await request(host, 'GET', `/runs/${run}`)).status, 303)
    const log = await request(
      host,
      'GET',
      `/api/v2/runs/${run}/logs?stage=test`,
      { cookie: developer.cookie },
    )
    assert.equal(log.status, 200, log.text)
    assert.match(log.text, /second line/)
    // Live updates are not forwarded requests: they come over the host's live stream.
    assert.equal(
      (
        await request(host, 'GET', `/api/v2/runs/${run}/events?stage=test`, {
          cookie: developer.cookie,
        })
      ).status,
      403,
    )
    // The host's live socket is the master's, relayed over the host's link.
    const watching = await live(host, {
      cookie: developer.cookie,
      origin: origin(host),
    })
    assert(typeof watching !== 'number')
    watching.send({ subscribe: 'run', run, stage: 'test' })
    assert.match(
      (await watching.next((frame) => frame.event === 'log')).data.text,
      /second line/,
    )
    watching.ws.close()
    const testerSocket = await live(host, {
      cookie: onHost('tester').cookie,
      origin: origin(host),
    })
    assert(typeof testerSocket !== 'number')
    testerSocket.send({ subscribe: 'run', run })
    assert.match(
      (await testerSocket.next((frame) => frame.event === 'error')).data.error,
      /tester role/,
    )
    testerSocket.ws.close()
    assert.equal(await live(host, { origin: origin(host) }), 401)
    assert.equal(
      (
        await request(host, 'GET', `/api/v2/runs/${run}/logs`, {
          cookie: onHost('tester').cookie,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request(host, 'GET', '/api/v2/projects', {
          cookie: developer.cookie,
        })
      ).status,
      403,
    )
    const cancelled = await request(
      host,
      'POST',
      `/api/v2/runs/${run}/cancel`,
      { ...developer, body: {} },
    )
    assert.equal(cancelled.status, 200, cancelled.text)
    await c.until(
      () =>
        (
          c.master
            .master!.database.db.prepare('SELECT status FROM jobs WHERE id=?')
            .get(run) as Json
        )?.status === 'cancelled',
      30_000,
      'the cancel on the master',
    )
  })

  it('U18.6 the nodes page shows inventory and checklists and pairs nodes; settings edit areas and send the Apple code to the master', async () => {
    const manager = signIn('manager')
    const nodes = await request(c.master, 'GET', '/nodes', manager)
    assert.equal(nodes.status, 200)
    assert.match(nodes.text, /<span class="mono">w<\/span>/)
    // A node's header names only what it has: no empty type, no slots on the host.
    assert.match(nodes.text, /<small>worker · [^<]*\d+ slots?/)
    assert.doesNotMatch(nodes.text, /· ·|<small>host[^<]*slot/)
    assert.match(nodes.text, /data-path="\/api\/v2\/nodes"/)
    assert.match(nodes.text, /install\.sh/)
    assert.match(nodes.text, /Monthly budget: \$200/)
    assert.match(nodes.text, /<span class="mono">worker<\/span>/)
    const settings = await request(c.master, 'GET', '/settings', manager)
    // Where invitation links open is an administrator's to change.
    assert.doesNotMatch(settings.text, /data-path="\/api\/v2\/settings\/host"/)
    assert.match(settings.text, /only an administrator changes it/)
    assert.match(settings.text, /serves from its cache for \d+ hours/)
    const owner = await request(c.master, 'GET', '/settings', signIn('admin'))
    assert.match(
      owner.text,
      /data-path="\/api\/v2\/settings\/host" data-method="PUT"/,
    )
    assert.match(settings.text, /data-path="\/api\/v2\/apple\/session"/)
    // Secrets stay write-only: the stored GitHub token is an empty field that keeps it.
    assert.match(
      settings.text,
      /name="token" type="password" data-kind="secret" autocomplete="off" placeholder="Leave empty to keep the stored token"/,
    )
    assert(!settings.text.includes('ghp_fixture'))
    assert.match(settings.text, /policy|No keys|admin/)
    // The host has no settings, nodes or Apple pages.
    for (const route of ['/settings', '/nodes', '/people', '/groups'])
      assert(
        [403, 404].includes(
          (await request(host, 'GET', route, onHost('admin'))).status,
        ),
        route,
      )
  })

  it('U18.8 every master page shows each role only the controls it may use', async () => {
    const pages = [
      '/',
      '/nodes',
      '/settings',
      '/people',
      '/groups',
      '/backups',
      `/runs/${run}`,
    ]
    const expected: Record<string, number[]> = {
      admin: [200, 200, 200, 200, 200, 200, 200],
      manager: [200, 200, 200, 200, 200, 200, 200],
      developer: [200, 403, 403, 403, 403, 403, 200],
      tester: [200, 403, 403, 403, 403, 403, 403],
    }
    for (const [role, statuses] of Object.entries(expected)) {
      const session = signIn(role)
      const got = []
      for (const route of pages)
        got.push((await request(c.master, 'GET', route, session)).status)
      assert.deepEqual(got, statuses, role)
    }
    const developer = (await request(c.master, 'GET', '/', signIn('developer')))
      .text
    assert.doesNotMatch(
      developer,
      /href="\/(nodes|settings|people|groups|backups)"|Add project/,
    )
    const manager = (await request(c.master, 'GET', '/', signIn('manager')))
      .text
    assert.match(manager, /href="\/nodes"/)
    assert.match(manager, /Add project/)
    // Only administrators change people; the form asks for an email, which
    // any enabled sign-in method that confirms it signs them in with.
    const adminPeople = (
      await request(c.master, 'GET', '/people', signIn('admin'))
    ).text
    assert.match(adminPeople, /<form data-mason="person-add">/)
    assert.match(adminPeople, /name="email" type="email" required/)
    assert.doesNotMatch(adminPeople, /addresses\./)
    const managerPeople = (
      await request(c.master, 'GET', '/people', signIn('manager'))
    ).text
    assert.doesNotMatch(managerPeople, /data-path="\/api\/v2\/people/)
    assert.doesNotMatch(managerPeople, /data-mason="person-(add|password)"/)
    assert.match(managerPeople, /tester person/)
    // A project's page names its secrets and never shows their values.
    const manager2 = signIn('manager')
    seedSecret(c.master.master!.database.db, 'wizard', {
      name: 'SIGNING_TOKEN',
      kind: 'value',
      value: 'secret-value-fixture',
    })
    // Build numbers: each sequence and its last number; a manager sets where one stands.
    const wizard = c.master.master!.projects.get('wizard')
    c.master.master!.buildNumbers.declare(wizard.id, 'app.example.ui', {
      scope: 'branch',
      format: 'YYMMDDCC',
    })
    assert.equal(
      (
        await request(c.master, 'POST', '/api/v2/build-numbers/seed', {
          ...manager2,
          body: {
            project: 'wizard',
            key: 'app.example.ui',
            branch: 'master',
            last: '26102107',
          },
        })
      ).status,
      200,
    )
    const projectPage = (
      await request(c.master, 'GET', '/projects/wizard', manager2)
    ).text
    assert.match(projectPage, /app\.example\.ui<\/td><td class="mono">YYMMDDCC/)
    assert.match(projectPage, /master<\/span> 26102107/)
    assert.match(projectPage, /data-path="\/api\/v2\/build-numbers\/seed"/)
    // Secrets are on their own tab, not the overview.
    assert.doesNotMatch(projectPage, /SIGNING_TOKEN/)
    assert.doesNotMatch(
      projectPage,
      /data-path="\/api\/v2\/projects\/wizard\/secrets"|data-secrets/,
    )
    assert(!projectPage.includes('secret-value-fixture'))
    const developerProject = (
      await request(c.master, 'GET', '/projects/wizard', signIn('developer'))
    ).text
    assert.match(developerProject, /master<\/td><td>automatic/)
    assert.doesNotMatch(developerProject, /build-numbers\/seed/)
    assert.doesNotMatch(
      developerProject,
      /data-path="\/api\/v2\/projects\/wizard\/secrets"/,
    )
    assert.equal(
      (await request(c.master, 'GET', '/projects/wizard', signIn('tester')))
        .status,
      403,
    )
    // The Secrets tab: names and configs for developers, controls and the audit for managers.
    const managerSecrets = await request(
      c.master,
      'GET',
      '/projects/wizard/secrets',
      manager2,
    )
    assert.equal(managerSecrets.status, 200)
    assert.match(managerSecrets.text, /aria-current="page">Secrets</)
    assert.match(managerSecrets.text, /data-secret-name|SIGNING_TOKEN/)
    assert.match(managerSecrets.text, /data-secret-edit/)
    assert.match(managerSecrets.text, /<h2><span[^>]*>[^<]*<\/span>Audit<\/h2>/)
    assert.match(managerSecrets.text, /src="\/assets\/secrets\.js"/)
    assert(!managerSecrets.text.includes('secret-value-fixture'))
    const developerSecrets = (
      await request(
        c.master,
        'GET',
        '/projects/wizard/secrets',
        signIn('developer'),
      )
    ).text
    assert.match(developerSecrets, /SIGNING_TOKEN/)
    assert.doesNotMatch(
      developerSecrets,
      /data-secret-edit|Audit|data-secrets|assets\/secrets\.js/,
    )
    assert.equal(
      (
        await request(
          c.master,
          'GET',
          '/projects/wizard/secrets',
          signIn('tester'),
        )
      ).status,
      403,
    )
    assert.equal(
      (await request(c.master, 'GET', '/projects/nope/secrets', manager2))
        .status,
      404,
    )
    assert.equal(
      (await request(c.master, 'GET', '/projects/wizard/secrets')).status,
      303,
    )
    // Runs and builds is a project tab: the project's runs, under the same tabs.
    const runsTab = await request(
      c.master,
      'GET',
      '/projects/wizard/runs',
      signIn('developer'),
    )
    assert.equal(runsTab.status, 200)
    assert.match(runsTab.text, /aria-current="page">Runs and builds</)
    assert.match(runsTab.text, /<table class="list runs">|No runs yet/)
    // The branches the build's push trigger names lead the list, a glob by its branches with runs.
    const db = c.master.master!.database.db
    const project = c.master.master!.projects.get('wizard')
    const job = db.prepare(
      "INSERT INTO jobs(id,project_id,workflow,number,branch,trigger,status,created,request) VALUES(?,?,'build',?,?,'request','succeeded',?,'{}')",
    )
    const now = Date.now()
    job.run('m2-a', project.id, 9001, 'release/1', now + 1000)
    job.run('m2-b', project.id, 9002, 'feature/x', now + 2000)
    db.prepare(
      "INSERT INTO build_number_reservations(project_id,key,reservation,value,created_at) VALUES(?,'app.example.wizard','m2-a','26110201',1)",
    ).run(project.id)
    // With no setup of the default branch, the latest of any branch's.
    db.prepare('DELETE FROM push_triggers WHERE project_id=?').run(project.id)
    const pushTriggers = db.prepare(
      "INSERT INTO push_triggers(project_id,branch,sources,triggers,commit_sha,updated) VALUES(?,?,'',?,'',?) ON CONFLICT(project_id,branch) DO UPDATE SET triggers=excluded.triggers",
    )
    pushTriggers.run(
      project.id,
      'some/branch',
      JSON.stringify({ build: ['develop', 'release/*'] }),
      1,
    )
    const order = async (): Promise<string[]> =>
      [
        ...(
          await request(
            c.master,
            'GET',
            '/projects/wizard/runs',
            signIn('developer'),
          )
        ).text.matchAll(/runs\?branch=([^"]+)"/g),
      ].map((match) => decodeURIComponent(match[1]!))
    assert.deepEqual((await order()).slice(0, 3), [
      'develop',
      'release/1',
      'feature/x',
    ])
    // The default branch's triggers win; push: true pins the automatic rules.
    pushTriggers.run(
      project.id,
      project.defaultBranch,
      JSON.stringify({ build: true }),
      0,
    )
    const automatic = project.rules
      .filter((rule) => rule.mode === 'automatic')
      .map((rule) => rule.pattern)
    assert.deepEqual(
      (await order()).slice(0, automatic.length),
      automatic.filter((pattern) => !pattern.includes('*')),
    )
    assert.match(
      (
        await request(
          c.master,
          'GET',
          '/projects/wizard/runs?branch=release%2F1',
          signIn('developer'),
        )
      ).text,
      /<td class="mono">26110201<\/td>/,
    )
    db.prepare("DELETE FROM jobs WHERE id IN ('m2-a','m2-b')").run()
    db.prepare('DELETE FROM push_triggers WHERE project_id=?').run(project.id)
    assert.match(
      (
        await request(
          c.master,
          'GET',
          '/projects/wizard/runs?branch=master',
          signIn('developer'),
        )
      ).text,
      /The latest runs on master/,
    )
    assert.equal(
      (
        await request(
          c.master,
          'GET',
          '/projects/wizard/runs',
          signIn('tester'),
        )
      ).status,
      403,
    )
    assert.equal(
      (await request(c.master, 'GET', '/projects/nope/runs', manager2)).status,
      404,
    )
    assert.equal(
      (await request(c.master, 'GET', '/projects/wizard/runs')).status,
      303,
    )
    assert.doesNotMatch(projectPage, /src="\/assets\/secrets\.js"/)
    assert.match(projectPage, /aria-current="page">Overview</)
    const bundle = await request(c.master, 'GET', '/assets/secrets.js')
    assert.equal(bundle.status, 200)
    assert.match(bundle.text, /data-secrets/)
    assert.equal(
      (await request(c.master, 'GET', '/projects/none', manager2)).status,
      404,
    )
    // A developer may not cancel others' runs from a page without the controls of a manager either way; testers see no runs.
    assert.match(
      (await request(c.master, 'GET', '/', signIn('tester'))).text,
      /Your apps/,
    )
    c.master.master!.database.db
      .prepare("UPDATE accounts SET open_admission=1 WHERE role='tester'")
      .run()
    assert.match(
      (await request(c.master, 'GET', '/', signIn('tester'))).text,
      /Your apps/,
    )
  })

  it('U20.11 Groups lists the groups and opens a page for each; People no longer holds them', async () => {
    const admin = signIn('admin')
    const manager = signIn('manager')
    const adminPeople = (await request(c.master, 'GET', '/people', admin)).text
    assert.match(adminPeople, /name="email" type="email" required/)
    assert.doesNotMatch(adminPeople, /\/api\/v2\/groups/)
    const managerPeople = (await request(c.master, 'GET', '/people', manager))
      .text
    assert.doesNotMatch(managerPeople, /name="email"|\/api\/v2\/groups/)
    assert.match(
      (await request(c.master, 'GET', '/', admin)).text,
      /<a href="\/people"[^>]*>.*?<span class="label">People<\/span><\/a><a href="\/groups"[^>]*>.*?<span class="label">Groups<\/span>/,
    )
    const db = c.master.master!.database.db
    const app = db
      .prepare('SELECT id,name,slug FROM apps ORDER BY position,id LIMIT 1')
      .get() as Json
    assert(app != null, 'the wizard made an app')
    const created = await request(c.master, 'POST', '/api/v2/groups', {
      ...manager,
      body: {
        name: 'Ui <crew>',
        apps: [app.id],
        members: [people.tester],
      },
    })
    assert.equal(created.status, 201, created.text)
    const list = await request(c.master, 'GET', '/groups', manager)
    assert.equal(list.status, 200)
    assert.match(
      list.text,
      new RegExp(
        `<a class="list-row" href="/groups/${created.json.id}"><strong>Ui &lt;crew&gt;</strong>`,
      ),
    )
    assert.match(list.text, /<input id="group-name" name="name"/)
    assert.match(list.text, /aria-current="page" title="Groups"/)
    assert.doesNotMatch(list.text, /src="\/assets\/groups\.js"/)
    const page = await request(
      c.master,
      'GET',
      `/groups/${created.json.id}`,
      manager,
    )
    assert.equal(page.status, 200)
    assert.match(page.text, /<title>Ui &lt;crew&gt; · Mason<\/title>/)
    assert.match(page.text, /<h1 data-group-title>Ui &lt;crew&gt;<\/h1>/)
    assert.match(page.text, /data-group-rename/)
    assert.match(page.text, /data-group-add>.*Add App<\/button>/)
    assert.match(page.text, /data-group-add>.*Add member<\/button>/)
    const catalog = JSON.parse(
      /<script type="application\/json" data-group-catalog>(.*?)<\/script>/.exec(
        page.text,
      )![1]!,
    )
    const names = (
      db.prepare('SELECT name FROM apps ORDER BY position,id').all() as Json[]
    ).map((row) => row.name)
    assert.deepEqual(
      catalog.apps.map((entry: Json) => entry.name),
      names,
    )
    for (const name of names) assert(page.text.includes(JSON.stringify(name)))
    assert(
      catalog.people.some(
        (person: Json) =>
          person.id === people.tester &&
          person.email === 'tester.person@example.test',
      ),
    )
    assert.deepEqual(catalog.group, {
      apps: [app.id],
      members: [people.tester],
    })
    assert.match(page.text, /<h2>.*Apps<\/h2>/)
    assert.match(page.text, /<h2>.*Group Members<\/h2>/)
    assert.match(
      page.text,
      new RegExp(
        `<li data-id="${app.id}"><div><strong>[^<]*</strong><small class="mono">${app.slug.replaceAll('.', '\\.')}<`,
      ),
    )
    assert.match(
      page.text,
      new RegExp(
        `<li data-id="${people.tester}"><div><strong>tester person</strong><small>tester\\.person@example\\.test<`,
      ),
    )
    assert.match(
      page.text,
      /data-method="DELETE" data-fields="" data-then="groups"/,
    )
    assert.match(
      page.text,
      /<script type="module" src="\/assets\/groups\.js"><\/script>/,
    )
    const script = await request(c.master, 'GET', '/assets/groups.js')
    assert.equal(script.status, 200)
    assert.match(script.type, /javascript/)
    assert.match(script.text, /data-group-rename/)
    for (const route of [
      '/groups/999999',
      '/groups/0',
      '/groups/x',
      '/groups/1.5',
    ]) {
      const missing = await request(c.master, 'GET', route, manager)
      assert.equal(missing.status, 404, route)
      assert.match(missing.text, /No such group/, route)
    }
    for (const role of ['developer', 'tester'])
      assert.equal(
        (
          await request(
            c.master,
            'GET',
            `/groups/${created.json.id}`,
            signIn(role),
          )
        ).status,
        403,
        role,
      )
    assert.equal(
      (await request(c.master, 'GET', `/groups/${created.json.id}`)).status,
      303,
    )
    assert(
      [403, 404].includes(
        (
          await request(
            host,
            'GET',
            `/groups/${created.json.id}`,
            onHost('admin'),
          )
        ).status,
      ),
    )
    assert.equal(
      (
        await request(c.master, 'DELETE', `/api/v2/groups/${created.json.id}`, {
          ...manager,
        })
      ).status,
      200,
    )
    // A removed group's page is gone.
    const removed = await request(
      c.master,
      'GET',
      `/groups/${created.json.id}`,
      manager,
    )
    assert.equal(removed.status, 404)
    assert.match(removed.text, /No such group/)
  })
})
