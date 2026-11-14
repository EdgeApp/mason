import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import { after, before, describe, it } from 'mocha'
import { hostApp } from '../host/web.js'
import {
  contentSecurityPolicy,
  masterContentSecurityPolicy,
  shellContentSecurityPolicy,
} from './csp.js'
import { nodeWebApp } from './webApp.js'
import { assertShell } from '../test/webShell.js'
import {
  pageFallback,
  pageRoutes,
  PAGE_ROUTES,
  sendShell,
  WEB_ASSETS,
  webAppRoutes,
  webBundlesDir,
  type PageAnswer,
  type PageNode,
} from './webRoutes.js'

/** Serves an app on a free port and returns its origin and a closer. */
async function serve(
  app: express.Express,
): Promise<{ origin: string; server: Server }> {
  const server = createServer(app).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, server }
}

describe('The React app on a node', () => {
  const servers: Server[] = []
  let master: string
  let waitingHost: string
  /** The bundle's files, by kind; npm run build wrote them. */
  const files: Record<'app' | 'css' | 'worker', string> = {
    app: '',
    css: '',
    worker: '',
  }

  before(async () => {
    const names = readdirSync(webBundlesDir)
    const find = (pattern: RegExp): string => {
      const name = names.find((file) => pattern.test(file))
      assert(name, `No ${pattern} in ${webBundlesDir}; run npm run build`)
      return name
    }
    files.app = find(/^app-[A-Z0-9]{8}\.js$/)
    files.css = find(/^app-[A-Z0-9]{8}\.css$/)
    files.worker = find(/^password-worker-[A-Z0-9]{8}\.js$/)
    const one = await serve(
      nodeWebApp({ role: 'master', testEndpoints: false }),
    )
    const two = await serve(hostApp({ role: 'host', testEndpoints: false }))
    servers.push(one.server, two.server)
    master = one.origin
    waitingHost = two.origin
  })
  after(() => {
    for (const server of servers) server.close()
  })

  it('runs the server suites without a DOM', () => {
    assert.equal(
      typeof (globalThis as { window?: unknown }).window,
      'undefined',
    )
    assert.equal(
      typeof (globalThis as { document?: unknown }).document,
      'undefined',
    )
  })

  it('answers index.html for /_web and every path below it, never cached', async () => {
    for (const origin of [master, waitingHost])
      for (const route of ['/_web', '/_web/', '/_web/runs/12', '/_web/a/b/c']) {
        const reply = await fetch(origin + route)
        assert.equal(reply.status, 200, route)
        assert.match(reply.headers.get('content-type') ?? '', /^text\/html/)
        assert.equal(reply.headers.get('cache-control'), 'no-store')
        assert.equal(
          reply.headers.get('content-security-policy'),
          shellContentSecurityPolicy,
        )
        const html = await reply.text()
        assert.match(html, /<div id="root"><\/div>/)
        for (const file of [
          files.app,
          files.css,
          files.worker,
          'theme-boot.js',
        ])
          assert(html.includes(`${WEB_ASSETS}/${file}`), file)
      }
    // Outside the mount the old pages still answer.
    assert.notEqual(
      (await fetch(`${master}/_webby`)).headers.get('content-security-policy'),
      shellContentSecurityPolicy,
    )
  })

  it('lets the shell start the password worker, and nothing compile WebAssembly but the worker', () => {
    assert.equal(
      shellContentSecurityPolicy,
      `${contentSecurityPolicy}; worker-src 'self'`,
    )
    assert.doesNotMatch(shellContentSecurityPolicy, /wasm-unsafe-eval/)
  })

  it('caches hashed files for a year and revalidates theme-boot.js', async () => {
    for (const [file, type] of [
      [files.app, /^text\/javascript/],
      [files.css, /^text\/css/],
      [files.worker, /^text\/javascript/],
    ] as const) {
      const reply = await fetch(`${master}${WEB_ASSETS}/${file}`)
      assert.equal(reply.status, 200, file)
      assert.match(reply.headers.get('content-type') ?? '', type)
      assert.equal(
        reply.headers.get('cache-control'),
        'public, max-age=31536000, immutable',
      )
      assert.equal(
        reply.headers.get('content-security-policy'),
        file === files.worker
          ? masterContentSecurityPolicy
          : contentSecurityPolicy,
      )
    }
    const boot = await fetch(`${waitingHost}${WEB_ASSETS}/theme-boot.js`)
    assert.equal(boot.status, 200)
    assert.equal(boot.headers.get('cache-control'), 'no-cache')
  })

  it('serves nothing else from the bundle directory', async () => {
    for (const name of [
      'index.html',
      'missing-AAAAAAAA.js',
      '.hidden.js',
      'notes.txt',
      '..%2Fbundles%2Findex.html',
    ])
      assert.equal(
        (await fetch(`${master}${WEB_ASSETS}/${name}`)).status,
        404,
        name,
      )
  })

  it('answers the shell at a node’s own address with a status and a provider sign-in’s state, escaped', async () => {
    const app = express()
    app.get('/plain', (_req, res) => sendShell(res))
    app.get('/flow', (_req, res) =>
      sendShell(res, {
        status: 403,
        flow: { state: 'failed', message: 'No "x" <b>&</b> here' },
      }),
    )
    app.get('/patterns', (_req, res) =>
      sendShell(res, {
        flow: { state: 'failed', message: "$' $` $& $$ here" },
      }),
    )
    const { origin, server } = await serve(app)
    servers.push(server)
    const read = async (
      route: string,
    ): Promise<{ status: number; headers: Headers; text: string }> => {
      const reply = await fetch(origin + route)
      return {
        status: reply.status,
        headers: reply.headers,
        text: await reply.text(),
      }
    }
    assert.equal(assertShell(await read('/plain')), undefined)
    const flow = await read('/flow')
    assert.deepEqual(assertShell(flow, 403), {
      state: 'failed',
      message: 'No "x" <b>&</b> here',
    })
    assert.doesNotMatch(flow.text, /<b>/)
    // Replacement patterns in the flow are its text, not the page's.
    const patterns = await read('/patterns')
    assert.deepEqual(assertShell(patterns), {
      state: 'failed',
      message: "$' $` $& $$ here",
    })
    assert.equal(patterns.text.match(/<div id="root">/g)?.length, 1)
  })

  it('says so when the app is not built', async () => {
    const empty = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'web-'),
    )
    try {
      const app = express()
      app.use(webAppRoutes({ dir: empty }))
      const { origin, server } = await serve(app)
      servers.push(server)
      const reply = await fetch(`${origin}/_web/runs`)
      assert.equal(reply.status, 503)
      assert.match(await reply.text(), /not built/)
      const shell = express()
      shell.get('/sign-in', (_req, res) => sendShell(res, { dir: empty }))
      const bare = await serve(shell)
      servers.push(bare.server)
      assert.equal((await fetch(`${bare.origin}/sign-in`)).status, 503)
      assert.equal(
        (await fetch(`${origin}${WEB_ASSETS}/theme-boot.js`)).status,
        404,
      )
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('M11 answers every page from one table: sign-in when signed out, 403 or 404 by permission, the node’s check, and 404 elsewhere', async () => {
    let role: 'admin' | 'developer' | 'tester' | undefined
    const asked: string[] = []
    const node = (kind: 'master' | 'host'): PageNode => ({
      node: kind,
      role: () => role,
      signIn: (req) => `/sign-in?return=${encodeURIComponent(req.originalUrl)}`,
      check: (subject, req): PageAnswer | Promise<PageAnswer> => {
        asked.push(subject)
        if (req.query.fail != null) throw new Error('The check failed')
        if (subject === 'home' && role == null) return { redirect: '/sign-in' }
        return subject === 'run' ? Promise.resolve(404) : 200
      },
    })
    const mount = async (kind: 'master' | 'host'): Promise<string> => {
      const app = express()
      app.use(pageRoutes(node(kind)))
      app.use(pageFallback(node(kind)))
      app.use(
        (
          _error: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          res.status(500).send('Server error')
        },
      )
      const { origin, server } = await serve(app)
      servers.push(server)
      return origin
    }
    const onMaster = await mount('master')
    const onHost = await mount('host')
    const get = async (
      origin: string,
      route: string,
      method = 'GET',
    ): Promise<{ status: number; location: string | null; text: string }> => {
      const reply = await fetch(origin + route, { method, redirect: 'manual' })
      return {
        status: reply.status,
        location: reply.headers.get('location'),
        text: await reply.text(),
      }
    }
    // Signed out: sign-in for a page, the node's own answer for the open ones.
    role = undefined
    assert.equal(
      (await get(onMaster, '/nodes')).location,
      '/sign-in?return=%2Fnodes',
    )
    assert.equal((await get(onMaster, '/')).location, '/sign-in')
    assert.equal((await get(onMaster, '/sign-in')).status, 200)
    assert.equal(
      (await get(onHost, '/elsewhere')).location,
      '/sign-in?return=%2Felsewhere',
    )
    // A role without a page's permission: 403, or 404 where the page is hidden from it.
    role = 'tester'
    assert.equal((await get(onMaster, '/artifacts')).status, 403)
    assert.equal((await get(onMaster, '/projects/x/runs')).status, 404)
    assert.equal((await get(onMaster, '/account')).status, 200)
    // What the page names is the node's to check, after the permission.
    role = 'developer'
    asked.length = 0
    assert.equal((await get(onMaster, '/runs/1')).status, 404)
    assert.equal((await get(onMaster, '/projects/x')).status, 200)
    assert.deepEqual(asked, ['run', 'project'])
    assert.equal((await get(onMaster, '/runs/1?fail=1')).status, 500)
    // A master-only page does not exist on a host; neither does any other address.
    role = 'admin'
    assert.equal((await get(onMaster, '/groups/2')).status, 200)
    assert.equal((await get(onHost, '/groups/2')).status, 404)
    assert.equal((await get(onHost, '/no/such/page')).status, 404)
    assert.match((await get(onHost, '/no/such/page')).text, /<div id="root">/)
    // The host's sign-in does not exist on the master: signed out, its own.
    assert.equal((await get(onMaster, '/auth/login')).status, 404)
    assert.equal((await get(onHost, '/auth/login')).status, 200)
    role = undefined
    assert.equal(
      (await get(onMaster, '/auth/login?return=%2Fnodes')).location,
      '/sign-in?return=%2Fauth%2Flogin%3Freturn%3D%252Fnodes',
    )
    role = 'admin'
    // The API, assets and other methods answer a plain 404.
    for (const [route, method] of [
      ['/api/v2/none', 'GET'],
      ['/assets/none.js', 'GET'],
      ['/projects', 'POST'],
    ] as const) {
      const reply = await get(onHost, route, method)
      assert.deepEqual([reply.status, reply.text], [404, 'Not found'], route)
    }
    // Every page the master serves is in the table once.
    const paths = PAGE_ROUTES.flatMap((route) =>
      Array.isArray(route.path) ? route.path : [route.path],
    )
    assert.equal(new Set(paths).size, paths.length)
  })
})
