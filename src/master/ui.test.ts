import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
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
    const events = await request(
      c.master,
      'GET',
      `/api/v2/runs/${run}/events?stage=test`,
      developer,
    )
    assert.match(events.type, /text\/event-stream/)
    assert.match(events.text, /event: stages/)
    assert.match(events.text, /event: log/)
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

  it('serves the run view on the host, its logs and events forwarded to the master, and a developer’s cancel through it', async () => {
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
    assert.match(page.text, /data-offset="0"/)
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
    const events = await request(
      host,
      'GET',
      `/api/v2/runs/${run}/events?stage=test`,
      { cookie: developer.cookie },
    )
    assert.match(events.text, /event: log/)
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
    assert.match(
      settings.text,
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
    for (const route of ['/settings', '/nodes', '/people'])
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
      '/backups',
      `/runs/${run}`,
    ]
    const expected: Record<string, number[]> = {
      admin: [200, 200, 200, 200, 200, 200],
      manager: [200, 200, 200, 200, 200, 200],
      developer: [200, 403, 403, 403, 403, 200],
      tester: [200, 403, 403, 403, 403, 403],
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
      /href="\/(nodes|settings|people|backups)"|Add project/,
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
    assert.match(adminPeople, /data-path="\/api\/v2\/people"/)
    assert.match(adminPeople, /name="email" type="email" required/)
    assert.doesNotMatch(adminPeople, /addresses\./)
    const managerPeople = (
      await request(c.master, 'GET', '/people', signIn('manager'))
    ).text
    assert.doesNotMatch(managerPeople, /data-path="\/api\/v2\/people/)
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
  })
})
