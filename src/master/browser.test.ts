import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, it } from 'mocha'
import { startNode } from '../node/serve.js'

interface Device {
  command: (name: string, value?: unknown) => Promise<unknown>
  screenshot: () => Promise<Buffer>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  shutdown: (options: object) => Promise<void>
}
const quote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'"

describe('Master sign-in in a real browser', () => {
  const enabled = process.env.MASON_WEB_E2E === '1'
  ;(enabled ? it : it.skip)(
    'U13.1 the bundled password worker runs under the page’s CSP: first-run setup, sign-out and sign-in in Chrome',
    async function () {
      this.timeout(180_000)
      const {
        MASON_TEST_ROOT: parent,
        MASON_ARTIFACTS: artifacts,
        MASON_BROWSER_BIN: browserBin,
        MAESTRO_D: daemonName,
        MAESTRO_D_CLIENT_ROOT: clientRoot,
      } = process.env
      assert(parent && artifacts && browserBin && daemonName && clientRoot)
      const root = mkdtempSync(path.join(parent, 'master-browser-'))
      const data = path.join(root, 'master')
      const node = await startNode(
        { role: 'master', data, port: 0, listen: '127.0.0.1', heartbeatMs: 0 },
        () => undefined,
      )
      const origin = node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
      const pin = node.web!.certificate!.pin.replace(/^sha256\/\//, '')
      const wrapper = path.join(root, 'browser')
      writeFileSync(
        wrapper,
        `#!/bin/sh\nexec ${quote(browserBin)} --ignore-certificate-errors-spki-list=${quote(pin)} "$@"\n`,
        { mode: 0o700 },
      )
      const require = createRequire(import.meta.url)
      const { MaestroD } = require(
        path.join(clientRoot, 'dist/cjs/index.js'),
      ) as { MaestroD: { connect: (options: object) => Promise<Daemon> } }
      const daemon = await MaestroD.connect({ name: daemonName })
      try {
        const device = await daemon.attach({
          device: 'web-mason-master',
          platform: 'web',
          url: origin,
          extra: { browser: wrapper, windowSize: '1100x820' },
          artifacts: 'none',
          commandTimeout: 30000,
          outputDir: artifacts,
        })
        const visible = async (text: string): Promise<void> => {
          try {
            await device.command('assertVisible', { text, timeout: 30000 })
          } catch (error) {
            // The page can navigate while the assertion polls; look again.
            if (!/navigated|execution context/i.test(String(error))) {
              writeFileSync(
                path.join(artifacts, 'master-browser-failure.png'),
                await device.screenshot(),
              )
              throw error
            }
            await device.command('assertVisible', { text, timeout: 30000 })
          }
        }
        const type = async (css: string, text: string): Promise<void> => {
          await device.command('tapOn', { css })
          await device.command('inputText', { text })
        }
        const screenshot = async (name: string): Promise<void> => {
          writeFileSync(path.join(artifacts, name), await device.screenshot())
        }
        await device.command('openBrowser', { url: origin + '/' })
        await visible('^Set up this master$')
        await screenshot('master-setup.png')
        const code = readFileSync(path.join(data, 'setup-code'), 'utf8').trim()
        await type('#code', code)
        await type('#username', 'owner')
        await type('#password', 'Owner-Horse-9-long')
        await device.command('tapOn', {
          css: 'form[data-mason="setup"] button',
        })
        // The worker computed the client hash in the page's CSP; the account exists.
        await visible('^Backups$')
        await screenshot('master-backup-prompt.png')
        assert.equal(node.master!.configured(), true)
        await device.command('tapOn', { css: 'summary[aria-label="Account"]' })
        await device.command('tapOn', {
          css: 'form[data-mason="sign-out"] button',
        })
        await visible('^Sign in$')
        await type('#username', 'owner')
        await type('#password', 'Owner-Horse-9-long')
        await device.command('tapOn', {
          css: 'form[data-mason="sign-in"] button',
        })
        // The browser's hash matches the one the server stored at setup.
        await visible('^Projects & apps$')
        await screenshot('master-signed-in.png')
      } finally {
        await daemon
          .shutdown({ device: 'web-mason-master' })
          .catch(() => undefined)
        await node.close()
      }
    },
  )
})
