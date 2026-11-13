import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { readFileSync } from 'node:fs'
import { SESSION_COOKIE } from '../auth/routes.js'
import { MASTER_SESSION_COOKIE } from '../master/auth.js'
import { MASONFILE_COPIES } from '../master/scheduler.js'
import { localOperator } from '../master/roles.js'
import { contentSecurityPolicy, shellContentSecurityPolicy } from './csp.js'
import { pinnedFetch } from './pinnedFetch.js'
import type { RunningNode } from './serve.js'
import { webBundlesDir } from './webRoutes.js'
import { cluster, type Cluster } from '../test/cluster.js'

interface Reply {
  status: number
  text: string
  type: string
  csp: string
  cache: string
  location: string
  setCookie: string
}

// Copies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

describe('Pages on the master and the host', function () {
  this.timeout(120_000)
  let c: Cluster
  let host: RunningNode
  const accounts: Record<string, number> = {}
  const get = async (
    node: RunningNode,
    route: string,
    cookie?: string,
  ): Promise<Reply> => {
    const url = node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
    const response = await pinnedFetch(
      url + route,
      { redirect: 'manual', headers: cookie == null ? {} : { cookie } },
      node.web!.certificate!.pin,
    )
    return {
      status: response.status,
      text: await response.text(),
      type: response.headers.get('content-type') ?? '',
      csp: response.headers.get('content-security-policy') ?? '',
      cache: response.headers.get('cache-control') ?? '',
      location: response.headers.get('location') ?? '',
      setCookie: response.headers.get('set-cookie') ?? '',
    }
  }
  const onMaster = (role: string): string => {
    const { token } = c.master.master!.auth.start(accounts[role]!, '127.0.0.1')
    return `${MASTER_SESSION_COOKIE}=${token}`
  }
  const onHost = (role: string): string =>
    `${SESSION_COOKIE}=${host.host!.accounts.startSession(accounts[role]!).token}`
  /** Every resource a page loads: scripts, stylesheets, icons and images. */
  const resources = (html: string): string[] =>
    [
      ...html.matchAll(/<(?:script|img|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g),
    ].map((match) => match[1]!)

  before(async () => {
    const root = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'views-'),
    )
    c = await cluster(path.join(root, 'cluster'))
    host = await c.startHost('host', { testEndpoints: true })
    const master = c.master.master!
    await master.settings.set(localOperator, 'host', {
      origin: host.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:'),
    })
    const repo = c.repo('fixtures/views')
    repo.commit({ 'Masonfile.ts': 'export function setup() {}' })
    master.saveProject(localOperator, 'views', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
      apps: [
        {
          bundleId: 'app.example.views',
          name: 'Views',
          platforms: ['ios', 'android'],
        },
      ],
    })
    for (const role of ['admin', 'manager', 'developer', 'tester'] as const)
      accounts[role] = (
        await master.people.create(localOperator, {
          emails: [`${role}.person@example.test`, `${role}@example.test`],
          name: `${role[0]!.toUpperCase()}${role.slice(1)} Person`,
          role,
        })
      ).id
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT COUNT(*) AS n FROM accounts')
          .get() as {
          n: number
        },
      10_000,
      'the accounts on the host',
    )
    await c.until(
      () =>
        (
          host
            .host!.cache.db.prepare('SELECT COUNT(*) AS n FROM accounts')
            .get() as { n: number }
        ).n >= 4 &&
        host
          .host!.cache.db.prepare("SELECT 1 FROM projects WHERE slug='views'")
          .get(),
      10_000,
      'the people and project on the host',
    )
  })
  after(async () => {
    await c?.close()
  })

  it('U17.1 pages load only Mason’s own resources; fonts, icons and licences are cached for a year', async () => {
    const pages: Array<[RunningNode, string, string | undefined]> = [
      [c.master, '/', onMaster('admin')],
      [c.master, '/artifacts', onMaster('developer')],
      [c.master, '/sign-in', undefined],
      [c.master, '/account', onMaster('tester')],
      [c.master, '/people', onMaster('admin')],
      [host, '/', onHost('developer')],
      [host, '/apps', onHost('tester')],
      [host, '/artifacts', onHost('admin')],
      [host, '/auth/login', undefined],
    ]
    for (const [node, route, cookie] of pages) {
      const reply = await get(node, route, cookie)
      assert.equal(reply.status, 200, `${route}: ${reply.text.slice(0, 200)}`)
      for (const resource of resources(reply.text))
        assert.match(resource, /^\/(?!\/)/, `${route} loads ${resource}`)
      assert.match(reply.csp, /font-src 'self'/)
      // No page compiles the password hash: the sign-in pages are the web
      // app's shell, which only starts the worker that does. Projects & apps
      // (the master's home), Artifacts, Your account and People (which set
      // passwords) are the shell too, as are Install apps (the host's home).
      assert.doesNotMatch(reply.csp, /wasm-unsafe-eval/, route)
      assert.equal(
        reply.csp === shellContentSecurityPolicy,
        [
          '/sign-in',
          '/auth/login',
          '/artifacts',
          '/account',
          '/people',
          '/apps',
        ].includes(route) || route === '/',
        route,
      )
    }
    assert.equal((await get(c.master, '/')).csp, contentSecurityPolicy)
    for (const node of [c.master, host]) {
      const font = await get(node, '/assets/fonts/geist-variable.woff2')
      assert.equal(font.status, 200)
      assert.equal(font.type, 'font/woff2')
      assert.match(font.cache, /max-age=31536000/)
      const licence = await get(
        node,
        '/assets/fonts/LICENSE-material-symbols.txt',
      )
      assert.match(licence.text, /Apache License/)
      assert.equal(
        (await get(node, '/assets/logo/mason-logo-180.png')).type,
        'image/png',
      )
      assert.equal((await get(node, '/favicon.ico')).type, 'image/x-icon')
      for (const missing of [
        '/assets/fonts/none.woff2',
        '/assets/fonts/.hidden.woff2',
        '/assets/fonts/x.exe',
        '/assets/logo/..%2F..%2Fpackage.json',
      ])
        assert.equal((await get(node, missing)).status, 404, missing)
    }
  })

  it('U17.3 the host never renders administration; the master shows it to the roles that hold it', async () => {
    for (const route of ['/', '/artifacts', '/apps', '/devices']) {
      const reply = await get(host, route, onHost('admin'))
      assert.doesNotMatch(
        reply.text,
        /href="\/(backups|people|groups|settings)|data-mason="/,
        route,
      )
    }
    for (const route of [
      '/backups',
      '/people',
      '/groups',
      '/groups/1',
      '/api/v2/settings/backup',
    ])
      assert(
        [403, 404].includes((await get(host, route, onHost('admin'))).status),
        route,
      )
    // Install apps and Devices are the web app's on the master too, whose
    // side menu follows the role from the session.
    for (const role of ['admin', 'developer', 'tester'])
      for (const route of ['/apps', '/devices']) {
        const reply = await get(c.master, route, onMaster(role))
        assert.equal(reply.status, 200, `${role} ${route}`)
        assert.match(reply.text, /<div id="root"><\/div>/)
        assert.equal(reply.csp, shellContentSecurityPolicy)
      }
    // Testers' home is Install apps on both nodes, which lists nothing
    // shared with them yet.
    const catalog = await get(host, '/', onHost('tester'))
    assert.match(catalog.text, /<div id="root"><\/div>/)
    assert.equal((await get(host, '/artifacts', onHost('tester'))).status, 403)
    const tester = onMaster('tester')
    assert.match(
      (await get(c.master, '/', tester)).text,
      /<div id="root"><\/div>/,
    )
    for (const [node, cookie] of [
      [c.master, tester],
      [host, onHost('tester')],
    ] as const)
      assert.deepEqual(
        JSON.parse((await get(node, '/api/v2/catalog/apps', cookie)).text).apps,
        [],
      )
    assert.equal(
      (await get(c.master, '/artifacts', onMaster('tester'))).status,
      403,
    )
    assert.equal((await get(host, '/artifacts')).status, 303)
    assert.equal((await get(c.master, '/artifacts')).status, 303)
  })

  it('U17.4 both nodes render the dashboard from their own data; only the master lists nodes', async () => {
    // Each node answers the web app's shell, and the dashboard from its own data.
    const shell = (reply: Reply): void => {
      assert.equal(reply.status, 200, reply.text.slice(0, 200))
      assert.match(reply.text, /<div id="root"><\/div>/)
      assert.equal(reply.csp, shellContentSecurityPolicy)
    }
    shell(
      await get(c.master, '/projects?platform=android', onMaster('developer')),
    )
    const json = async (
      node: RunningNode,
      route: string,
      cookie: string,
    ): Promise<Json> => {
      const reply = await get(node, route, cookie)
      assert.equal(reply.status, 200, reply.text)
      return JSON.parse(reply.text)
    }
    const master = await json(
      c.master,
      '/api/v2/dashboard?platform=android',
      onMaster('developer'),
    )
    assert(
      JSON.stringify(master.projects).includes('app.example.views'),
      'the master’s dashboard',
    )
    assert(Array.isArray(master.nodes))
    shell(await get(host, '/projects?project=views', onHost('developer')))
    const onHostPage = await json(
      host,
      '/api/v2/dashboard?project=views',
      onHost('developer'),
    )
    assert(JSON.stringify(onHostPage.projects).includes('app.example.views'))
    assert.equal(onHostPage.nodes, undefined)
    // An unknown run's detail: the shell, which reads the 404.
    shell(await get(host, '/artifacts?run=none', onHost('developer')))
    assert.equal(
      (await get(host, '/api/v2/artifacts/runs/none', onHost('developer')))
        .status,
      404,
    )
  })

  it('U17.5 search answers signed-in viewers only, within what they may see', async () => {
    const search = async (node: RunningNode, cookie?: string): Promise<Reply> =>
      await get(node, '/api/v2/search?q=views', cookie)
    const found = JSON.parse(
      (await search(host, onHost('developer'))).text,
    ) as Array<{ kind: string }>
    assert.deepEqual(
      found.map((result) => result.kind),
      ['project', 'app'],
    )
    assert.deepEqual(
      JSON.parse((await search(host, onHost('tester'))).text),
      [],
    )
    assert.equal((await search(host)).status, 401)
    assert.equal(
      JSON.parse((await search(c.master, onMaster('manager'))).text).length,
      2,
    )
    assert.equal((await search(c.master)).status, 401)
    // Search's results page is the web app's.
    for (const [node, cookie] of [
      [c.master, onMaster('manager')],
      [host, onHost('developer')],
    ] as const) {
      const page = await get(node, '/search?q=views', cookie)
      assert.equal(page.status, 200)
      assert.equal(page.csp, shellContentSecurityPolicy)
    }
  })

  it('U17.6 the master’s notices reach managers and administrators only', async () => {
    const notices = async (role: string): Promise<string> =>
      (await get(c.master, '/api/v2/notifications', onMaster(role))).text
    assert.match(await notices('manager'), /This master is not backed up/)
    assert.doesNotMatch(await notices('developer'), /not backed up/)
  })

  it('M5.1 the host serves Overview, Runs and builds and Masonfile from its own copy, read-only, for developers and up', async () => {
    const master = c.master.master!
    const project = master.projects.get('views')
    // A run pins its commit; the master keeps that commit's Masonfile once.
    const run = await c.api('POST', '/api/v2/runs', {
      project: 'views',
      branch: 'master',
    })
    assert.equal(run.status, 202, run.text)
    const key = await c.until(
      () =>
        master.database.db
          .prepare('SELECT key FROM masonfiles WHERE project_id=?')
          .get(project.id)?.key as string | undefined,
      20_000,
      'the Masonfile kept',
    )
    assert.match(key, new RegExp(`^${project.id}:[0-9a-f]{40}$`))
    // A read that finds no Masonfile keeps nothing, and the next one tries again.
    const commit = key.split(':')[1]!
    master.database.db.prepare('DELETE FROM masonfiles WHERE key=?').run(key)
    const keep = (
      master.scheduler as unknown as {
        keepMasonfile: (project: unknown, commit: string) => Promise<void>
      }
    ).keepMasonfile.bind(master.scheduler)
    await keep({ ...project, entrypoint: 'Missing.ts' }, commit)
    assert.equal(
      master.database.db
        .prepare('SELECT 1 FROM masonfiles WHERE key=?')
        .get(key),
      undefined,
    )
    await keep({ ...project, format: 'script' }, commit)
    assert.equal(
      master.database.db
        .prepare('SELECT 1 FROM masonfiles WHERE key=?')
        .get(key),
      undefined,
    )
    await keep(project, commit)
    await keep(project, commit)
    // A Masonfile too large to copy is kept as a note saying so.
    const mirrors = master.mirrors
    const file = mirrors.file.bind(mirrors)
    mirrors.file = async (...args): ReturnType<typeof file> => ({
      blob: (await file(...args))!.blob,
    })
    master.database.db.prepare('DELETE FROM masonfiles WHERE key=?').run(key)
    try {
      await keep(project, commit)
    } finally {
      mirrors.file = file
    }
    assert.match(
      (
        master.database.db
          .prepare('SELECT text FROM masonfiles WHERE key=?')
          .get(key) as { text: string }
      ).text,
      /larger than 256 KiB; Mason keeps no copy/,
    )
    // The master still shows that Masonfile, from its mirror (review 2.harness-review.3).
    const tab = await get(
      c.master,
      `/api/v2/projects/views/masonfile?commit=${commit}`,
      onMaster('developer'),
    )
    assert.equal(tab.status, 200, tab.text)
    assert.match(JSON.parse(tab.text).text, /export function setup/)
    assert.doesNotMatch(tab.text, /Mason keeps no copy/)
    // Only the newest commits' copies stay: past the limit the oldest go.
    const fill = master.database.db.prepare(
      "INSERT INTO masonfiles(key,project_id,commit_sha,file,text,created_at) VALUES(?,?,?,'Masonfile.ts','old',?)",
    )
    for (let n = 0; n < MASONFILE_COPIES; n++)
      fill.run(`${project.id}:old${n}`, project.id, `old${n}`, n)
    master.database.db.prepare('DELETE FROM masonfiles WHERE key=?').run(key)
    await keep(project, commit)
    const left = master.database.db
      .prepare('SELECT key FROM masonfiles WHERE project_id=?')
      .all(project.id)
      .map((row) => String(row.key))
    assert.equal(left.length, MASONFILE_COPIES)
    assert.ok(left.includes(key))
    assert.ok(!left.includes(`${project.id}:old0`))
    assert.ok(
      master.database.db
        .prepare(
          "SELECT 1 FROM change_log WHERE entity='masonfile' AND key=? AND operation='delete'",
        )
        .get(`${project.id}:old0`),
    )
    assert.equal(
      (
        master.database.db
          .prepare('SELECT file FROM masonfiles WHERE key=?')
          .get(key) as { file: string }
      ).file,
      'Masonfile.ts',
    )
    assert.equal(
      (
        master.database.db
          .prepare(
            "SELECT COUNT(*) AS n FROM change_log WHERE entity='masonfile' AND key=?",
          )
          .get(key) as { n: number }
      ).n,
      // One change per copy stored (the run's, then three stored again
      // above); keeping a commit that has one adds none.
      4,
    )
    // A declared sequence and a seed reach the host's copy.
    master.buildNumbers.declare(project.id, 'app.example.views', {
      format: 'N',
      scope: 'app',
      start: 1,
      timeZone: 'UTC',
    })
    master.seed('views', 'app.example.views', { last: '41' }, localOperator)
    const copy = async (): Promise<Json> =>
      await c.until(
        () => {
          const row = host
            .host!.cache.db.prepare(
              "SELECT details FROM projects WHERE slug='views'",
            )
            .get() as { details: string | null } | undefined
          const details =
            row?.details == null ? undefined : JSON.parse(row.details)
          return details?.buildNumbers?.[0]?.last?.[0]?.value === '41'
            ? details
            : undefined
        },
        10_000,
        'the seeded sequence on the host',
      )
    const details = await copy()
    assert.equal(details.repository, project.repository)
    assert.deepEqual(details.apps, [
      { bundleId: 'app.example.views', platforms: ['android', 'ios'] },
    ])
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM masonfiles WHERE key=?')
          .get(key),
      10_000,
      'the Masonfile on the host',
    )
    // A project's pages are the web app's on both nodes, which reads the
    // Overview's App IDs and Build numbers the same from each; the host has
    // no Secrets tab and no seed form.
    const shell = (reply: Reply, status = 200): void => {
      assert.equal(reply.status, status, reply.text.slice(0, 300))
      assert.equal(reply.cache, 'no-store')
      assert.equal(reply.csp, shellContentSecurityPolicy)
      assert.match(reply.text, /<div id="root"><\/div>/)
    }
    const read = async (
      node: RunningNode,
      route: string,
      cookie: string,
    ): Promise<Json> => {
      const reply = await get(node, route, cookie)
      assert.equal(reply.status, 200, reply.text)
      return JSON.parse(reply.text)
    }
    shell(await get(c.master, '/projects/views', onMaster('manager')))
    shell(await get(host, '/projects/views', onHost('manager')))
    const onTheMaster = await read(
      c.master,
      '/api/v2/projects/views/overview',
      onMaster('manager'),
    )
    const onTheHost = await read(
      host,
      '/api/v2/projects/views/overview',
      onHost('manager'),
    )
    for (const field of ['apps', 'appNames', 'buildNumbers', 'repository'])
      assert.deepEqual(onTheHost[field], onTheMaster[field], field)
    assert.deepEqual(
      onTheHost.appNames.map((app: Json) => app.bundleId),
      ['app.example.views'],
    )
    assert.deepEqual([onTheMaster.secrets, onTheHost.secrets], [true, false])
    assert.deepEqual([onTheMaster.canSeed, onTheHost.canSeed], [true, false])
    shell(await get(host, '/projects/views/runs', onHost('developer')))
    const runs = await read(
      host,
      '/api/v2/projects/views/runs',
      onHost('developer'),
    )
    assert.equal(runs.name, onTheMaster.name)
    assert(runs.runs.some((entry: Json) => entry.id === run.json.id))
    // The Masonfile shows from the copy, also while the link is down.
    shell(await get(host, '/projects/views/masonfile', onHost('developer')))
    let offline: Reply | undefined
    await c.drop('host', 2000, async () => {
      offline = await get(
        host,
        '/api/v2/projects/views/masonfile',
        onHost('developer'),
      )
    })
    assert.equal(offline!.status, 200, offline!.text)
    assert.match(JSON.parse(offline!.text).text, /export function setup/)
    // Testers reach apps through Install apps: to them projects do not exist.
    for (const route of [
      '/projects/views',
      '/projects/views/runs',
      '/projects/views/masonfile',
    ])
      assert.equal(
        (await get(host, route, onHost('tester'))).status,
        404,
        route,
      )
    assert.equal(
      (await get(host, '/api/v2/projects/views/overview', onHost('tester')))
        .status,
      403,
    )
    // A project the host does not hold is the app's unknown state.
    shell(await get(host, '/projects/nothing', onHost('developer')), 404)
    shell(await get(host, '/projects/nothing/runs', onHost('developer')), 404)
    assert.equal(
      (
        await get(
          host,
          '/api/v2/projects/nothing/overview',
          onHost('developer'),
        )
      ).status,
      404,
    )
  })

  it('removing a project removes its kept Masonfiles, on the host too (review 3.harness-review.4)', async () => {
    const master = c.master.master!
    const repo = c.repo('fixtures/gone')
    repo.commit({ 'Masonfile.ts': 'export function setup() {}' })
    master.saveProject(localOperator, 'gone', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
    })
    const id = master.projects.get('gone').id
    const key = `${id}:${'d'.repeat(40)}`
    master.database.db
      .prepare(
        "INSERT INTO masonfiles(key,project_id,commit_sha,file,text,created_at) VALUES(?,?,?,'Masonfile.ts','x',0)",
      )
      .run(key, id, 'd'.repeat(40))
    master.database.change('masonfile', key)
    const onHost = (): unknown =>
      host
        .host!.cache.db.prepare('SELECT 1 FROM masonfiles WHERE key=?')
        .get(key)
    await c.until(() => onHost(), 10_000, 'the copy on the host')
    master.projects.remove(localOperator, 'gone')
    assert.equal(
      master.database.db
        .prepare('SELECT 1 FROM masonfiles WHERE project_id=?')
        .get(id),
      undefined,
    )
    await c.until(() => onHost() == null || undefined, 10_000, 'the copy gone')
  })

  it('E2E only: the host opens a test session in a browser that cannot be handed a cookie', async () => {
    const { token } = host.host!.accounts.startSession(accounts.tester!)
    const opened = await get(host, `/test/session/${token}`)
    assert.equal(opened.status, 303)
    assert.equal(opened.location, '/')
    assert.match(
      opened.setCookie,
      new RegExp(`^__Host-mason-session=${token};.*HttpOnly.*Secure`, 'i'),
    )
    assert.equal((await get(host, '/test/session/not-a-session')).status, 404)
    assert.equal((await get(c.master, `/test/session/${token}`)).status, 303)
  })

  it('M11 every page address on both nodes answers the web app’s shell, never a page the server drew', async () => {
    const index = readFileSync(path.join(webBundlesDir, 'index.html'), 'utf8')
    const token = 'A'.repeat(43)
    const pages = [
      '/',
      '/?later=backups',
      '/sign-in',
      '/auth/login',
      '/auth/invite',
      '/projects',
      '/projects?platform=ios',
      '/projects/new',
      '/projects/views',
      '/projects/views/runs',
      '/projects/views/masonfile',
      '/projects/views/secrets',
      '/projects/views/apps/app.example.views',
      '/projects/views/apps/app.example.views/build-numbers',
      '/projects/nothing',
      '/artifacts',
      '/artifacts?run=none',
      '/runs/none',
      '/search?q=views',
      '/account',
      '/nodes',
      '/cloud',
      '/settings',
      '/people',
      '/groups',
      '/groups/1',
      '/backups',
      '/apps',
      '/apps/1',
      '/apps/1/branches/bWFzdGVy',
      '/devices',
      `/devices/complete/${token}`,
      '/no/such/page',
    ]
    const viewers: Array<[RunningNode, string, string]> = [
      [c.master, 'admin', onMaster('admin')],
      [c.master, 'tester', onMaster('tester')],
      [host, 'admin', onHost('admin')],
      [host, 'developer', onHost('developer')],
      [host, 'tester', onHost('tester')],
    ]
    for (const [node, who, cookie] of viewers)
      for (const route of pages) {
        const reply = await get(node, route, cookie)
        const where = `${node === host ? 'host' : 'master'} ${who} ${route}`
        if (reply.status === 303) {
          // Sign-in, set up or home: an address, never a page.
          assert.match(reply.location, /^\/(sign-in|auth\/login|)(\?|$)/, where)
          assert.equal(reply.text, '', where)
          continue
        }
        assert([200, 403, 404, 410].includes(reply.status), where)
        assert.equal(reply.text, index, where)
        assert.equal(reply.csp, shellContentSecurityPolicy, where)
        assert.equal(reply.cache, 'no-store', where)
      }
    // Signed out, a page sends to sign in.
    for (const route of ['/projects', '/runs/none', '/apps', '/no/such/page']) {
      assert.equal((await get(c.master, route)).location, '/sign-in', route)
      assert.equal(
        (await get(host, route)).location,
        `/auth/login?return=${encodeURIComponent(route)}`,
        route,
      )
    }
    // The host's sign-in is not the master's: signed out, the master's own.
    const login = await get(c.master, '/auth/login?return=%2Fnodes')
    assert.deepEqual([login.status, login.location], [303, '/sign-in'])
    assert.equal(
      (await get(c.master, '/auth/login', onMaster('admin'))).status,
      404,
    )
    // The old pages' scripts and stylesheet are gone; unknown API and asset
    // addresses answer a plain 404.
    for (const node of [c.master, host])
      for (const route of [
        ...[
          'groups',
          'master',
          'password-worker',
          'people',
          'run',
          'secrets',
          'catalog',
          'shell',
        ].map((name) => `/assets/${name}.js`),
        '/assets/style.css',
        ...(node === host ? [] : ['/api/v2/no-such-route']),
      ]) {
        const reply = await get(
          node,
          route,
          node === host ? onHost('admin') : onMaster('admin'),
        )
        assert.equal(reply.status, 404, route)
        assert.doesNotMatch(reply.text, /<html|<!doctype/i, route)
      }
    // The addresses that stay the server's answer their own content.
    for (const node of [c.master, host]) {
      const health = await get(node, '/health')
      assert.equal(JSON.parse(health.text).status, 'ready')
      const qr = await get(
        node,
        '/devices/qr',
        node === host ? onHost('tester') : onMaster('tester'),
      )
      assert.match(qr.type, /image\/svg\+xml/)
      assert.equal(
        (await get(node, `/install/${token}/other`)).text,
        'Not found',
      )
    }
    assert.equal((await get(host, '/xcode/Xcode-26.0.xip')).status, 403)
  })
})
