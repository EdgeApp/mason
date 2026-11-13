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
import { assertShell, type ShellReply } from '../test/webShell.js'

// Rows and replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
interface Reply {
  status: number
  text: string
  json: Json
  type: string
  headers: ShellReply['headers']
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
      headers: response.headers,
    }
  }
  /** Asserts a reply is the web app's shell with that status. */
  const shell = (reply: Reply, status = 200): void => {
    assertShell(reply, status)
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
          emails: [`${role}.person@example.test`, `${role}@example.test`],
          name: `${role} person`,
          role,
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
    // The wizard is the web app's: a developer reads its 403 inside it, and
    // a manager drives it through the wizard's routes.
    shell(
      await request(c.master, 'GET', '/projects/new', signIn('developer')),
      403,
    )
    shell(await request(c.master, 'GET', '/projects/new', manager))
    assert.equal((await request(c.master, 'GET', '/projects/new')).status, 303)
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
    // Step 2 reads the Masonfile on the project's default branch.
    shell(await request(c.master, 'GET', '/projects/new?slug=wizard', manager))
    const saved = await request(
      c.master,
      'GET',
      '/api/v2/projects/wizard',
      manager,
    )
    assert.equal(saved.status, 200, saved.text)
    assert.deepEqual(
      [
        saved.json.repository,
        saved.json.defaultBranch,
        saved.json.webhookSecret,
      ],
      [repository, 'master', { set: false }],
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
    // The read-only triggers step shows each workflow's triggers as declared.
    assert.deepEqual(discovered.triggers.release, [{ request: true }])
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
    // The project now holds what each step set, as the wizard reads it back.
    const third = await request(
      c.master,
      'GET',
      '/api/v2/projects/wizard',
      manager,
    )
    assert.deepEqual(third.json.webhookSecret, { set: true })
    assert.deepEqual(
      third.json.apps.map((app: Json) => app.bundleId),
      ['app.example.wizard'],
    )
    assert.deepEqual(
      third.json.rules.map((rule: Json) => [rule.pattern, rule.mode]),
      [
        ['master', 'automatic'],
        ['*', 'request'],
      ],
    )
    // The discovery run never shows among the project's runs.
    assert.doesNotMatch(
      (await request(c.master, 'GET', '/api/v2/dashboard', manager)).text,
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
    // The run page is the web app's; it reads the run, its graph, steps,
    // history and details in one request, and its log a page at a time.
    const page = await request(c.master, 'GET', `/runs/${run}`, developer)
    assert.equal(page.status, 200)
    assert.match(page.text, /<div id="root"><\/div>/)
    assert.doesNotMatch(page.text, /\/assets\/run\.js/)
    const read = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}?include=graph,steps,history,details`,
      developer,
    )
    assert.equal(read.status, 200, read.text)
    // The header names who requested the run, and the API names them too.
    assert.equal(read.json.details.requestedBy, 'developer person')
    assert.equal(read.json.details.trigger, 'request')
    const shown = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}`,
      developer,
    )
    assert.equal(shown.json.actor, `account:${people.developer}`)
    assert.equal(shown.json.requestedBy, 'developer person')
    assert(
      read.json.layout.bubbles.some(
        (bubble: Json) => bubble.name === 'android',
      ),
    )
    assert.deepEqual(
      read.json.history.map((entry: Json) => entry.id).includes(run),
      true,
    )
    const stage = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}/logs?stage=test&from=0&count=500`,
      developer,
    )
    assert.equal(stage.status, 200, stage.text)
    assert.match(stage.json.text, /\u001b\[32mgreen\u001b\[0m line/)
    assert.match(stage.json.text, /second line/)
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
    assert.deepEqual(
      read.json.steps
        .filter((step: Json) => step.stage === 'test')
        .map((step: Json) => step.id),
      steps.map((step: Json) => step.id),
    )
    const one = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}/logs?stage=test&step=${steps[0].id}&from=0`,
      developer,
    )
    assert.equal(one.status, 200, one.text)
    const none = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}/logs?stage=test&step=999&from=0`,
      developer,
    )
    assert.equal(none.status, 404)
    assert.match(none.json.error, /No such step/)
    // A stage that has written nothing (an approval, one not started) has no lines.
    const quiet = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}/logs?stage=not-started&last=1`,
      developer,
    )
    assert.equal(quiet.status, 200, quiet.text)
    assert.deepEqual(quiet.json, {
      start: 1,
      total: 0,
      first: 1,
      text: '',
      end: 0,
    })
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
    // A live log's last page holds a partial last line; the page's socket
    // resumes after the bytes it holds and sends the line once it is whole.
    const logFile = c.master.master!.scheduler.logFile(run, 'test')
    const whole = readFileSync(logFile)
    appendFileSync(logFile, 'partial')
    const partial = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}/logs?stage=test&last=1`,
      developer,
    )
    assert.equal(partial.json.end, whole.length + 'partial'.length)
    assert.match(partial.json.text, /\npartial$/)
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
    // A tester reads the 403 inside the app, and a run that does not exist
    // its unknown-run state, each with that status.
    const refused = await request(
      c.master,
      'GET',
      `/runs/${run}`,
      signIn('tester'),
    )
    assert.equal(refused.status, 403)
    assert.match(refused.text, /<div id="root"><\/div>/)
    const missing = await request(c.master, 'GET', '/runs/none', developer)
    assert.equal(missing.status, 404)
    assert.match(missing.text, /<div id="root"><\/div>/)
    // The Masonfile tab is the web app's; it shows the file at a run's
    // commit, the newest by default.
    shell(
      await request(c.master, 'GET', '/projects/wizard/masonfile', developer),
    )
    const commits = await request(
      c.master,
      'GET',
      '/api/v2/projects/wizard/masonfile/commits',
      developer,
    )
    assert.equal(commits.status, 200, commits.text)
    assert(commits.json.length > 0)
    const file = await request(
      c.master,
      'GET',
      '/api/v2/projects/wizard/masonfile',
      developer,
    )
    assert.equal(file.status, 200, file.text)
    assert.equal(file.json.commit, commits.json[0].sha)
    assert.equal(file.json.file, 'Masonfile.ts')
    assert.match(file.json.text, /m\.apiVersion\(1\)/)
    const api = await request(
      c.master,
      'GET',
      `/api/v2/projects/wizard/masonfile?commit=${'0'.repeat(40)}`,
      developer,
    )
    assert.equal(api.status, 404)
  })

  it('serves the run view on the host, its logs forwarded and its live updates relayed from the master, and a developer’s cancel through it', async () => {
    await c.until(
      () =>
        host.host!.cache.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(run),
      10_000,
      'the run on the host',
    )
    const developer = onHost('developer')
    // The page is the web app's, read from the host's copy.
    const page = await request(
      host,
      'GET',
      `/runs/${run}?stage=test`,
      developer,
    )
    assert.equal(page.status, 200)
    assert.match(page.text, /<div id="root"><\/div>/)
    const include = `/api/v2/runs/${run}?include=graph,steps,history,details`
    const read = await request(host, 'GET', include, developer)
    assert.equal(read.status, 200, read.text)
    assert.equal(read.json.details.requestedBy, 'developer person')
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
    assert.equal(
      (await request(host, 'GET', include, developer)).json.details.buildNumber,
      '26110299',
    )
    assert.equal(
      (await request(c.master, 'GET', include, signIn('developer'))).json
        .details.buildNumber,
      '26110299',
    )
    master.database.db
      .prepare('DELETE FROM build_number_reservations WHERE reservation=?')
      .run(run)
    master.database.change('job', run)
    // A step's lines, by number, through the host over its link.
    const step = await request(
      host,
      'GET',
      `/api/v2/runs/${run}/logs?stage=test&step=1&from=0`,
      { cookie: developer.cookie },
    )
    assert.equal(step.status, 200, step.text)
    assert(step.json.start >= 1)
    // A tester reads the 403 in the app; an unknown run its 404; nobody signed in signs in.
    const refused = await request(host, 'GET', `/runs/${run}`, onHost('tester'))
    assert.equal(refused.status, 403)
    assert.match(refused.text, /<div id="root"><\/div>/)
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
    // A page's lines by number, forwarded over the host's link as JSON.
    const tail = await request(
      host,
      'GET',
      `/api/v2/runs/${run}/logs?stage=test&last=1&count=1`,
      { cookie: developer.cookie },
    )
    assert.equal(tail.status, 200, tail.text)
    assert.equal(tail.json.start, 1)
    assert(tail.json.total >= 2, tail.text)
    assert.equal(tail.json.first, tail.json.total)
    assert.match(tail.json.text, /second line\n$/)
    const top = await request(
      host,
      'GET',
      `/api/v2/runs/${run}/logs?stage=test&from=1&count=500`,
      { cookie: developer.cookie },
    )
    assert.equal(top.json.first, 1)
    assert.equal(
      top.json.text.split('\n').length - 1,
      tail.json.total,
      top.text,
    )
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

  it('U18.6 Nodes and Settings are the web app’s: nodes with their type, slots and checklists, node types, the budget, settings areas by role and the Apple session', async () => {
    const manager = signIn('manager')
    const read = async (route: string, as = manager): Promise<Json> => {
      const reply = await request(c.master, 'GET', route, as)
      assert.equal(reply.status, 200, `${route}: ${reply.text}`)
      return reply.json
    }
    shell(await request(c.master, 'GET', '/nodes', manager))
    shell(await request(c.master, 'GET', '/settings', manager))
    // A node's card names only what it has: the worker its type and slots,
    // the host neither.
    const nodes = (await read('/api/v2/nodes')) as Json[]
    const worker = nodes.find((node) => node.name === 'w')
    assert.equal(worker.role, 'worker')
    assert.equal(worker.type, 'worker')
    assert(worker.slots >= 1)
    assert(Array.isArray(worker.checklist))
    const paired = nodes.find((node) => node.role === 'host')
    assert(paired != null, 'the host is paired')
    assert(!paired.type, 'a host has no type')
    assert.equal((await read('/api/v2/cloud/budget')).monthly, 200)
    assert.deepEqual(Object.keys(await read('/api/v2/settings/nodeTypes')), [
      'worker',
    ])
    // Where invitation links open is an administrator's to change; a manager
    // reads it, with how long the host serves from its cache.
    const hostSetting = await read('/api/v2/settings/host')
    assert.equal(hostSetting.origin, origin(host))
    assert.equal(hostSetting.offlineGraceHours, 72)
    const permissions = async (role: string): Promise<string[]> =>
      (await read('/api/v2/session', signIn(role))).permissions
    assert(!(await permissions('manager')).includes('signIn.change'))
    assert((await permissions('admin')).includes('signIn.change'))
    assert.equal(
      (
        await request(c.master, 'PUT', '/api/v2/settings/host', {
          ...manager,
          body: hostSetting,
        })
      ).status,
      403,
    )
    // Settings → Apple reads the master's Apple ID session.
    assert.equal(typeof (await read('/api/v2/apple/signing')), 'object')
    // Secrets stay write-only: the stored GitHub token reads as set.
    const github = await request(
      c.master,
      'GET',
      '/api/v2/settings/github',
      manager,
    )
    assert.deepEqual(github.json.token, { set: true })
    assert(!github.text.includes('ghp_fixture'))
    assert(Array.isArray(await read('/api/v2/keys')))
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
      '/projects',
      '/nodes',
      '/settings',
      '/people',
      '/groups',
      '/backups',
      `/runs/${run}`,
    ]
    const expected: Record<string, number[]> = {
      admin: [200, 200, 200, 200, 200, 200, 200, 200],
      manager: [200, 200, 200, 200, 200, 200, 200, 200],
      developer: [200, 200, 403, 403, 403, 403, 403, 200],
      // Everyone's home is Install apps; to a tester projects do not exist.
      tester: [200, 404, 403, 403, 403, 403, 403, 403],
    }
    for (const [role, statuses] of Object.entries(expected)) {
      const session = signIn(role)
      const got = []
      for (const route of pages)
        got.push((await request(c.master, 'GET', route, session)).status)
      assert.deepEqual(got, statuses, role)
    }
    // Administration and the run page are the web app's, each guarded by
    // its permission (the run page's trail goes through its project's Runs
    // and builds and its branch: src/web/pages/run, and E2 in a browser).
    const admin = signIn('admin')
    for (const route of [
      '/nodes',
      '/settings',
      '/people',
      '/groups',
      '/backups',
    ])
      shell(await request(c.master, 'GET', route, admin))
    for (const route of [
      '/nodes',
      '/settings',
      '/people',
      '/groups',
      '/backups',
    ])
      shell(await request(c.master, 'GET', route, signIn('developer')), 403)
    assert.match(
      (await request(c.master, 'GET', `/runs/${run}`, admin)).text,
      /<div id="root"><\/div>/,
    )
    // Projects & apps is the web app's: its links and Add project follow the
    // session's permissions, which it reads.
    const permissions = async (role: string): Promise<string[]> =>
      (await request(c.master, 'GET', '/api/v2/session', signIn(role))).json
        .permissions
    for (const role of ['developer', 'manager']) {
      const page = await request(c.master, 'GET', '/projects', signIn(role))
      assert.match(page.text, /<div id="root"><\/div>/)
    }
    const developer = await permissions('developer')
    assert(!developer.includes('nodes.read'))
    assert(!developer.includes('projects.change'))
    const manager = await permissions('manager')
    assert(manager.includes('nodes.read'))
    assert(manager.includes('projects.change'))
    // Only administrators change people; managers read them.
    assert(!manager.includes('people.change'))
    assert(manager.includes('people.read'))
    assert((await permissions('admin')).includes('people.change'))
    const managerPeople = await request(
      c.master,
      'GET',
      '/api/v2/people',
      signIn('manager'),
    )
    assert.equal(managerPeople.status, 200)
    assert(
      (managerPeople.json as Json[]).some(
        (person) => person.name === 'tester person',
      ),
    )
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
    // A project's pages are the web app's: its Overview reads the project's
    // details, its sequences and whether the viewer may set where one stands.
    shell(await request(c.master, 'GET', '/projects/wizard', manager2))
    const overview = async (role: string): Promise<Json> => {
      const reply = await request(
        c.master,
        'GET',
        '/api/v2/projects/wizard/overview',
        signIn(role),
      )
      assert.equal(reply.status, 200, reply.text)
      return reply.json
    }
    const managerOverview = await overview('manager')
    const sequence = managerOverview.buildNumbers.find(
      (entry: Json) => entry.key === 'app.example.ui',
    )
    assert.equal(sequence.format, 'YYMMDDCC')
    assert.deepEqual(sequence.last, [{ branch: 'master', value: '26102107' }])
    assert.equal(managerOverview.canSeed, true)
    // The master has a Secrets tab; secrets are on it, not the overview.
    assert.equal(managerOverview.secrets, true)
    assert.doesNotMatch(JSON.stringify(managerOverview), /SIGNING_TOKEN/)
    assert(!JSON.stringify(managerOverview).includes('secret-value-fixture'))
    shell(
      await request(c.master, 'GET', '/projects/wizard', signIn('developer')),
    )
    const developerOverview = await overview('developer')
    assert.deepEqual(
      developerOverview.rules.find((rule: Json) => rule.pattern === 'master'),
      { pattern: 'master', mode: 'automatic' },
    )
    assert.equal(developerOverview.canSeed, false)
    assert.equal(
      (
        await request(c.master, 'POST', '/api/v2/build-numbers/seed', {
          ...signIn('developer'),
          body: {
            project: 'wizard',
            key: 'app.example.ui',
            branch: 'master',
            last: '26102108',
          },
        })
      ).status,
      403,
    )
    // To a tester projects do not exist: every page under /projects is the
    // master's not-found page, and the reads refuse them.
    const testerRoutes = [
      '/projects/wizard',
      '/projects/wizard/runs',
      '/projects/wizard/masonfile',
      '/projects/wizard/secrets',
    ]
    for (const route of testerRoutes)
      assert.equal(
        (await request(c.master, 'GET', route, signIn('tester'))).status,
        404,
        route,
      )
    assert.equal(
      (
        await request(
          c.master,
          'GET',
          '/api/v2/projects/wizard/overview',
          signIn('tester'),
        )
      ).status,
      403,
    )
    // The Secrets tab: names and configs for developers, contents and the
    // audit for managers; values never appear in the list.
    shell(await request(c.master, 'GET', '/projects/wizard/secrets', manager2))
    const managerSecrets = await request(
      c.master,
      'GET',
      '/api/v2/projects/wizard/secrets',
      manager2,
    )
    assert.equal(managerSecrets.status, 200, managerSecrets.text)
    assert(
      managerSecrets.json.some(
        (secret: Json) => secret.name === 'SIGNING_TOKEN',
      ),
    )
    assert(!managerSecrets.text.includes('secret-value-fixture'))
    const audit = await request(
      c.master,
      'GET',
      '/api/v2/projects/wizard/secrets/audit',
      manager2,
    )
    assert.equal(audit.status, 200, audit.text)
    assert(Array.isArray(audit.json))
    const backups = await request(
      c.master,
      'GET',
      '/api/v2/projects/wizard/secrets/backups',
      manager2,
    )
    assert.equal(backups.status, 200, backups.text)
    assert.equal(typeof backups.json.backupsConfigured, 'boolean')
    shell(
      await request(
        c.master,
        'GET',
        '/projects/wizard/secrets',
        signIn('developer'),
      ),
    )
    const developerSecrets = await request(
      c.master,
      'GET',
      '/api/v2/projects/wizard/secrets',
      signIn('developer'),
    )
    assert.equal(developerSecrets.status, 200, developerSecrets.text)
    assert(
      developerSecrets.json.some(
        (secret: Json) => secret.name === 'SIGNING_TOKEN',
      ),
    )
    assert(!developerSecrets.text.includes('secret-value-fixture'))
    assert.equal(
      (
        await request(
          c.master,
          'GET',
          '/api/v2/projects/wizard/secrets/audit',
          signIn('developer'),
        )
      ).status,
      403,
    )
    shell(
      await request(c.master, 'GET', '/projects/nope/secrets', manager2),
      404,
    )
    assert.equal(
      (
        await request(
          c.master,
          'GET',
          '/api/v2/projects/nope/secrets',
          manager2,
        )
      ).status,
      404,
    )
    assert.equal(
      (await request(c.master, 'GET', '/projects/wizard/secrets')).status,
      303,
    )
    // Runs and builds is a project tab: the project's runs.
    shell(
      await request(
        c.master,
        'GET',
        '/projects/wizard/runs',
        signIn('developer'),
      ),
    )
    const runsOf = async (query = ''): Promise<Json> => {
      const reply = await request(
        c.master,
        'GET',
        `/api/v2/projects/wizard/runs${query}`,
        signIn('developer'),
      )
      assert.equal(reply.status, 200, reply.text)
      return reply.json
    }
    const runsTab = await runsOf()
    assert.equal(runsTab.name, 'wizard')
    assert(runsTab.runs.some((entry: Json) => entry.id === run))
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
      (await runsOf()).branches.map((entry: Json) => entry.branch)
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
    // A branch's runs lead with the build number each reserved.
    shell(
      await request(
        c.master,
        'GET',
        '/projects/wizard/runs?branch=release%2F1',
        signIn('developer'),
      ),
    )
    const release = await runsOf('?branch=release%2F1')
    assert.equal(release.branch, 'release/1')
    assert.deepEqual(
      release.runs.map((entry: Json) => [entry.id, entry.buildNumber]),
      [['m2-a', '26110201']],
    )
    db.prepare("DELETE FROM jobs WHERE id IN ('m2-a','m2-b')").run()
    db.prepare('DELETE FROM push_triggers WHERE project_id=?').run(project.id)
    const onMaster = await runsOf('?branch=master')
    assert.equal(onMaster.branch, 'master')
    assert(onMaster.runs.every((entry: Json) => entry.branch === 'master'))
    shell(await request(c.master, 'GET', '/projects/nope/runs', manager2), 404)
    assert.equal(
      (await request(c.master, 'GET', '/api/v2/projects/nope/runs', manager2))
        .status,
      404,
    )
    assert.equal(
      (await request(c.master, 'GET', '/projects/wizard/runs')).status,
      303,
    )
    // The old Secrets page's script is gone with the server pages.
    assert.equal(
      (await request(c.master, 'GET', '/assets/secrets.js')).status,
      404,
    )
    shell(await request(c.master, 'GET', '/projects/none', manager2), 404)
    // A developer may not cancel others' runs from a page without the controls of a manager either way; testers see no runs.
    // A tester's home is Install apps, the web app's (catalogRelay.test.ts follows it).
    shell(await request(c.master, 'GET', '/', signIn('tester')))
  })

  it('U20.11 Groups lists the groups and opens a page for each, its picker over every app and person', async () => {
    const manager = signIn('manager')
    const read = async (route: string): Promise<Json> => {
      const reply = await request(c.master, 'GET', route, manager)
      assert.equal(reply.status, 200, `${route}: ${reply.text}`)
      return reply.json
    }
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
    const page = `/groups/${created.json.id}`
    // The list and a group's page are the web app's.
    shell(await request(c.master, 'GET', '/groups', manager))
    shell(await request(c.master, 'GET', page, manager))
    assert(
      ((await read('/api/v2/groups')) as Json[]).some(
        (group) => group.id === created.json.id && group.name === 'Ui <crew>',
      ),
    )
    const group = await read(`/api/v2/groups/${created.json.id}`)
    assert.equal(group.name, 'Ui <crew>')
    assert.deepEqual(group.apps, [{ id: app.id, slug: app.slug }])
    assert.deepEqual(group.members, [people.tester])
    // Add App and Add member pick from every app, in catalog order, and
    // every person.
    assert.deepEqual(
      ((await read('/api/v2/apps')) as Json[]).map((entry) => entry.name),
      (
        db.prepare('SELECT name FROM apps ORDER BY position,id').all() as Json[]
      ).map((row) => row.name),
    )
    assert(
      ((await read('/api/v2/people')) as Json[]).some(
        (person) =>
          person.id === people.tester &&
          person.emails[0].email === 'tester.person@example.test',
      ),
    )
    // The old Groups page's script is gone with the server pages.
    assert.equal(
      (await request(c.master, 'GET', '/assets/groups.js')).status,
      404,
    )
    for (const route of [
      '/groups/999999',
      '/groups/0',
      '/groups/x',
      '/groups/1.5',
    ])
      shell(await request(c.master, 'GET', route, manager), 404)
    for (const role of ['developer', 'tester'])
      shell(await request(c.master, 'GET', page, signIn(role)), 403)
    assert.equal((await request(c.master, 'GET', page)).status, 303)
    assert(
      [403, 404].includes(
        (await request(host, 'GET', page, onHost('admin'))).status,
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
    shell(await request(c.master, 'GET', page, manager), 404)
  })
})
