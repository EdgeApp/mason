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
  sendShell,
  WEB_ASSETS,
  webAppRoutes,
  webBundlesDir,
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
})
