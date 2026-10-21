import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { SESSION_COOKIE } from '../auth/routes.js'
import { MASTER_SESSION_COOKIE } from '../master/auth.js'
import { localOperator } from '../master/roles.js'
import { contentSecurityPolicy } from '../node/webApp.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
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
          email: `${role}.person@example.test`,
          name: `${role[0]!.toUpperCase()}${role.slice(1)} Person`,
          role,
          addresses: { google: `${role}@example.test` },
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
      // Only the master's sign-in page compiles the password hash.
      assert.equal(
        /wasm-unsafe-eval/.test(reply.csp),
        node === c.master && route === '/sign-in',
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
      assert.match((await get(node, '/assets/shell.js')).type, /javascript/)
      assert.match(
        (await get(node, '/assets/style.css')).text,
        /@font-face\{font-family:'Geist'/,
      )
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
        /href="\/(backups|people|settings)|data-mason="/,
        route,
      )
    }
    for (const route of ['/backups', '/people', '/api/v2/settings/backup'])
      assert(
        [403, 404].includes((await get(host, route, onHost('admin'))).status),
        route,
      )
    assert.match(
      (await get(c.master, '/', onMaster('admin'))).text,
      /href="\/backups"/,
    )
    const developer = await get(c.master, '/', onMaster('developer'))
    assert.doesNotMatch(developer.text, /href="\/backups"/)
    assert.match(
      developer.text,
      /<strong>Developer Person<\/strong><small>developer · master/,
    )
    // Testers keep the phone-first catalog on the host and their apps on the master.
    const catalog = await get(host, '/', onHost('tester'))
    assert.doesNotMatch(catalog.text, /Projects &amp; apps/)
    assert.equal((await get(host, '/artifacts', onHost('tester'))).status, 403)
    assert.match(
      (await get(c.master, '/', onMaster('tester'))).text,
      /No apps are shared with you yet/,
    )
    assert.equal(
      (await get(c.master, '/artifacts', onMaster('tester'))).status,
      403,
    )
    assert.equal((await get(host, '/artifacts')).status, 303)
    assert.equal((await get(c.master, '/artifacts')).status, 303)
  })

  it('U17.4 both nodes render the dashboard from their own data; only the master lists nodes', async () => {
    const master = await get(
      c.master,
      '/?platform=android',
      onMaster('developer'),
    )
    assert.match(master.text, /app\.example\.views/)
    assert.match(master.text, /Worker nodes/)
    assert.match(master.text, /workers idle/)
    const onHostPage = await get(host, '/?project=views', onHost('developer'))
    assert.match(onHostPage.text, /app\.example\.views/)
    assert.doesNotMatch(onHostPage.text, /Worker nodes|workers idle/)
    assert.match(
      (await get(host, '/artifacts?run=none', onHost('developer'))).text,
      /Run unavailable/,
    )
  })

  it('U17.5 search answers signed-in viewers only, within what they may see', async () => {
    const found = JSON.parse(
      (await get(host, '/search?q=views', onHost('developer'))).text,
    ) as Array<{
      kind: string
    }>
    assert.deepEqual(
      found.map((result) => result.kind),
      ['project', 'app'],
    )
    assert.deepEqual(
      JSON.parse((await get(host, '/search?q=views', onHost('tester'))).text),
      [],
    )
    assert.equal((await get(host, '/search?q=views')).status, 401)
    assert.equal(
      JSON.parse(
        (await get(c.master, '/search?q=views', onMaster('manager'))).text,
      ).length,
      2,
    )
    assert.equal((await get(c.master, '/search?q=views')).status, 401)
  })

  it('U17.6 the master’s notices reach managers and administrators only', async () => {
    assert.match(
      (await get(c.master, '/', onMaster('manager'))).text,
      /This master is not backed up<\/li>/,
    )
    assert.doesNotMatch(
      (await get(c.master, '/', onMaster('developer'))).text,
      /not backed up<\/li>/,
    )
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
})
