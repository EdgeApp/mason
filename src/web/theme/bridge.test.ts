// The iOS 27 bridge in tokens.css must win over the library's own variables
// in both themes, both OS colour schemes and both load orders: Chrome, driven
// by maestro-d's web driver as src/master/screens.test.ts is, loads the
// library's styles.css and tokens.css (and the bundled app-[hash].css) and
// compares each bridged variable's computed value with the Mason role it
// names. Ported from the design language's tools/bridge-check.mjs. Skipped unless MASON_WEB_E2E=1; it needs
// MASON_TEST_ROOT, MASON_BROWSER_BIN, MAESTRO_D and MAESTRO_D_CLIENT_ROOT.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'mocha'
import { webBundlesDir } from '../../node/webRoutes.js'

interface Device {
  command: (name: string, value?: unknown) => Promise<unknown>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  detach: (id: string) => Promise<void>
}

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const tokensFile = path.join(repo, 'src', 'web', 'theme', 'tokens.css')
const libraryFile = path.join(
  repo,
  'node_modules',
  '@ios27_design_system',
  'react',
  'dist',
  'styles.css',
)

/** The bridged names and the Mason role (or literal) each must equal. */
export function bridgePairs(css: string): Array<[string, string]> {
  const start = css.indexOf('iOS 27 bridge')
  assert(start >= 0, 'No iOS 27 bridge block in tokens.css')
  const block = css.slice(css.indexOf('{', start) + 1)
  return [
    ...block.slice(0, block.indexOf('}')).matchAll(/--([a-z0-9-]+): ([^;]+);/g),
  ].map((match) => [match[1]!, match[2]!])
}

/**
 * The page's check: each bridged variable on <html> against its role
 * resolved in the same context. Literal numbers are skipped, and the light
 * theme's own glass values differ from the dark block's by design.
 */
const check = (
  theme: 'dark' | 'light' | null,
  pairs: Array<[string, string]>,
): string => `
  const theme = ${JSON.stringify(theme)}
  const pairs = ${JSON.stringify(pairs)}
  if (theme) document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
  const cs = getComputedStyle(document.documentElement)
  const effective = theme ?? 'dark'
  const probe = document.createElement('div')
  document.body.append(probe)
  // A colour is compared by what it paints: the bundle minifies literals.
  const paint = (value) => {
    if (!CSS.supports('color', value)) return value
    probe.style.color = value
    return getComputedStyle(probe).color
  }
  const out = []
  for (const [name, want] of pairs) {
    const got = paint(cs.getPropertyValue('--' + name).trim())
    probe.style.setProperty('--x', want)
    const expected = paint(getComputedStyle(probe).getPropertyValue('--x').trim())
    if (!/^[0-9]/.test(want) && got !== expected &&
        !(name.startsWith('ios27-glass') && effective === 'light'))
      out.push('--' + name + ': ' + got + ' (want ' + expected + ')')
  }
  probe.remove()
  return JSON.stringify(out)`

describe('The iOS 27 bridge in a real browser', function () {
  this.timeout(600_000)
  const enabled = process.env.MASON_WEB_E2E === '1'
  const {
    MASON_TEST_ROOT: parent,
    MASON_BROWSER_BIN: browserBin,
    MAESTRO_D: daemonName,
    MAESTRO_D_CLIENT_ROOT: clientRoot,
  } = process.env
  let server: Server
  let origin: string
  let daemon: Daemon
  let device: Device
  const id = `mason-bridge-${process.pid}`

  before(async function () {
    if (!enabled) return this.skip()
    assert(parent && browserBin && daemonName && clientRoot)
    const pages: Record<string, [string, string]> = {
      '/library.css': ['text/css', readFileSync(libraryFile, 'utf8')],
      '/tokens.css': ['text/css', readFileSync(tokensFile, 'utf8')],
      '/app.css': [
        'text/css',
        readFileSync(
          path.join(
            webBundlesDir,
            readdirSync(webBundlesDir).find((name) => name.endsWith('.css'))!,
          ),
          'utf8',
        ),
      ],
    }
    for (const [name, order] of [
      ['library-first', ['library', 'tokens']],
      ['tokens-first', ['tokens', 'library']],
      ['bundle', ['app']],
    ] as const)
      pages[`/${name}.html`] = [
        'text/html',
        `<!doctype html><html><head>${order
          .map((sheet) => `<link rel="stylesheet" href="/${sheet}.css">`)
          .join('')}</head><body></body></html>`,
      ]
    server = createServer((req, res) => {
      const page = pages[req.url ?? '']
      res.writeHead(page == null ? 404 : 200, {
        'Content-Type': page?.[0] ?? 'text/plain',
      })
      res.end(page?.[1] ?? 'Not found')
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const require = createRequire(import.meta.url)
    // The client root is the npm package, or the maestro-d checkout holding it.
    const client = [
      path.join(clientRoot, 'dist/cjs/index.js'),
      path.join(clientRoot, 'npm/maestro-d/dist/cjs/index.js'),
    ].find((file) => existsSync(file))
    assert(client, `No maestro-d client under ${clientRoot}`)
    const { MaestroD } = require(client) as {
      MaestroD: { connect: (options: object) => Promise<Daemon> }
    }
    daemon = await MaestroD.connect({ name: daemonName })
    device = await daemon.attach({
      device: id,
      platform: 'web',
      url: `${origin}/library-first.html`,
      extra: { browser: browserBin, windowSize: '1024x768' },
      artifacts: 'none',
      commandTimeout: 30000,
      outputDir: path.join(realpathSync(parent), 'maestro-output'),
    })
  })
  after(async () => {
    await daemon?.detach(id).catch(() => undefined)
    server?.close()
  })

  it('reads the whole bridge from tokens.css', () => {
    assert(bridgePairs(readFileSync(tokensFile, 'utf8')).length >= 40)
  })

  it('wins in both themes, both OS schemes, both load orders and the bundle', async () => {
    const pairs = bridgePairs(readFileSync(tokensFile, 'utf8'))
    const failures: string[] = []
    let checked = 0
    for (const order of ['library-first', 'tokens-first', 'bundle'])
      for (const scheme of ['dark', 'light'] as const) {
        await device.command('openBrowser', { url: `${origin}/${order}.html` })
        await device.command('setDarkMode', { enabled: scheme === 'dark' })
        const seen = (await device.command('evalBrowserScript', {
          script: "return matchMedia('(prefers-color-scheme: dark)').matches",
        })) as { data?: unknown }
        assert.equal(String(seen.data), String(scheme === 'dark'), scheme)
        for (const theme of ['dark', 'light', null] as const) {
          const reply = (await device.command('evalBrowserScript', {
            script: check(theme, pairs),
          })) as { data?: unknown }
          const result = JSON.parse(String(reply.data)) as string[]
          checked++
          if (result.length > 0)
            failures.push(
              `${order}, data-theme=${theme ?? 'none'}, OS ${scheme}: ${result.slice(0, 6).join('; ')}`,
            )
        }
      }
    assert.equal(checked, 18)
    assert.deepEqual(failures, [])
  })
})
