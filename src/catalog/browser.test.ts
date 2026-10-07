import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import { describe, it } from 'mocha'
import { Accounts } from '../auth/accounts.js'
import { fixture } from '../auth/providers.test.js'
import { Providers } from '../auth/providers.js'
import { asConfig } from '../config.js'
import { createApp } from '../server.js'
import { Store, digest } from '../store.js'

interface Device {
  command: (name: string, value?: unknown) => Promise<unknown>
  screenshot: () => Promise<Buffer>
}
interface Daemon {
  attach: (options: object) => Promise<Device>
  shutdown: (options: object) => Promise<void>
}
const pin = (cert: Buffer): string =>
  createHash('sha256')
    .update(
      new X509Certificate(cert).publicKey.export({
        type: 'spki',
        format: 'der',
      }),
    )
    .digest('base64')
const quote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'"
describe('Mason real browser acceptance', () => {
  const enabled = process.env.MASON_WEB_E2E === '1'
  ;(enabled ? it : it.skip)(
    'uses OAuth, preapprovals, platform navigation and browser history',
    async function () {
      this.timeout(120000)
      const {
        MASON_TEST_ROOT: parent,
        MASON_ARTIFACTS: artifacts,
        MASON_BROWSER_BIN: browserBin,
        MAESTRO_D: daemonName,
        MAESTRO_D_CLIENT_ROOT: clientRoot,
      } = process.env
      assert(parent && artifacts && browserBin && daemonName && clientRoot)
      const root = mkdtempSync(path.join(parent, 'browser-'))
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=builds.example.test',
          '-addext',
          'subjectAltName=DNS:builds.example.test',
          '-keyout',
          path.join(root, 'tls.key'),
          '-out',
          path.join(root, 'tls.crt'),
        ],
        { stdio: 'ignore' },
      )
      const cert = readFileSync(path.join(root, 'tls.crt')),
        app = express()
      const server = createServer(
        { key: readFileSync(path.join(root, 'tls.key')), cert },
        app,
      ).listen(0, '127.0.0.1')
      await once(server, 'listening')
      const origin = `https://builds.example.test:${(server.address() as AddressInfo).port}`,
        env = await fixture(origin)
      const store = new Store(
        asConfig({
          origin,
          database: path.join(root, 'state.sqlite'),
          storage: path.join(root, 'packages'),
          providers: env.configs,
          freeSpaceBytes: 0,
        }),
      )
      app.use((req, res, next) => {
        if (req.method === 'POST')
          res.on('finish', () =>
            console.log(
              'Browser form',
              req.path,
              res.statusCode,
              'originMatches',
              req.get('origin') === origin,
            ),
          )
        next()
      })
      app.use(
        createApp(store, new Providers(origin, env.configs, env.transport)),
      )
      const accounts = new Accounts(store),
        wrapper = path.join(root, 'browser')
      writeFileSync(
        wrapper,
        `#!/bin/sh\nexec ${quote(browserBin)} --host-resolver-rules='MAP builds.example.test 127.0.0.1, MAP identity.example.test 127.0.0.1' --ignore-certificate-errors-spki-list=${quote(pin(cert) + ',' + pin(env.certificate))} "$@"\n`,
        { mode: 0o700 },
      )
      const require = createRequire(import.meta.url)
      const { MaestroD } = require(
        path.join(clientRoot, 'dist/cjs/index.js'),
      ) as { MaestroD: { connect: (options: object) => Promise<Daemon> } }
      const daemon = await MaestroD.connect({ name: daemonName })
      try {
        const device = await daemon.attach({
          device: 'web-mason-builds',
          platform: 'web',
          url: origin,
          extra: { browser: wrapper, windowSize: '1100,820' },
          artifacts: 'none',
          commandTimeout: 15000,
          outputDir: artifacts,
        })
        const visible = async (text: string): Promise<void> => {
          try {
            await device.command('assertVisible', { text, timeout: 15000 })
          } catch (error) {
            writeFileSync(
              path.join(artifacts, 'mason-browser-failure.png'),
              await device.screenshot(),
            )
            if (!/navigated|execution context/i.test(String(error)))
              throw error
            await device.command('assertVisible', { text, timeout: 15000 })
          }
        }
        const open = async (suffix: string): Promise<void> => {
          await device.command('openBrowser', { url: origin + suffix })
        }
        const tap = async (css: string): Promise<void> => {
          await device.command('tapOn', { css })
        }
        const check = async (expression: string): Promise<void> => {
          await device.command('evalBrowserScript', {
            script: `if (!(${expression})) throw new Error('Browser assertion failed')`,
          })
        }
        const screenshot = async (name: string): Promise<void> => {
          writeFileSync(path.join(artifacts, name), await device.screenshot())
        }
        await open('/auth/login')
        await tap('a[href^="/auth/start/first"]')
        await visible('^Waiting for tester access$')
        await screenshot('mason-pending.png')
        const identity = accounts.identities()[0]!
        accounts.promote(identity.provider, identity.subject, identity.email!)
        const appId = store.addApp({
          slug: 'test.example.app',
          name: 'Example App',
          position: 0,
        })
        for (const [index, name] of [
          'Camera',
          'Director',
          'Preview',
          'Distributor',
          'Scraper',
        ].entries())
          store.addApp({
            slug: `test.example.app${index}`,
            name,
            position: index + 1,
          })
        for (const os of ['ios', 'android', 'macos', 'windows'] as const) {
          const format =
            os === 'ios'
              ? 'ipa'
              : os === 'android'
                ? 'apk'
                : os === 'macos'
                  ? 'dmg'
                  : 'exe'
          const channelId = store.addChannel({
            appId,
            platform: os,
            key: os,
            allowedFormats: [format],
          })
          for (let i = 1; i <= 12; i++) {
            const bytes = Buffer.from(`fixture ${os} ${i}`),
              id = store.reserve('fixture', bytes.length)
            writeFileSync(store.incomingPath(id), bytes, { mode: 0o600 })
            store.publish(id, {
              channelId,
              branch: i === 1 ? 'master' : 'feature/new',
              commit: 'abc123abcdef12345678',
              version: '1.2.3',
              buildNumber: String(i),
              bundleId: 'test.example.app',
              format,
              digest: digest(bytes),
              size: bytes.length,
            })
          }
        }
        await open('/auth/login')
        await tap('a[href^="/auth/start/first"]')
        await visible('^Apps$')
        await screenshot('mason-catalog.png')
        await tap('a[href="/people"]')
        await visible('^People$')
        await tap('#email')
        await device.command('inputText', { text: 'jordan@example.test' })
        await device.command('evalBrowserScript', {
          script: "document.querySelector('#provider').value='plain'",
        })
        await tap('form[action="/people/invitations"] button')
        await visible('^Tester preapproved$')
        await open('/people')
        await screenshot('mason-accounts.png')
        assert.equal(accounts.invitations()[0]?.email, 'jordan@example.test')
        await open(`/apps/${appId}?platform=ios`)
        await visible('^master$')
        await screenshot('mason-branches.png')
        await tap('a[href*="/branches/ZmVhdHVyZS9uZXc"]')
        await visible('^feature/new$')
        await screenshot('mason-builds.png')
        await device.command('evalBrowserScript', {
          script: 'window.scrollTo(0,300)',
        })
        await tap('a[data-platform="android"]')
        await visible('Android builds · newest first')
        await check('Math.abs(window.scrollY - 300) < 3')
        await check(
          "location.pathname.endsWith('/branches/ZmVhdHVyZS9uZXc') && location.search === '?platform=android'",
        )
        await check(
          "document.querySelector('a[data-platform=android]').getAttribute('aria-current') === 'true'",
        )
        await device.command('back')
        await visible('iOS builds · newest first')
        await check("location.search === '?platform=ios'")
        await device.command('evalBrowserScript', {
          script: 'history.forward()',
        })
        await visible('Android builds · newest first')
        await tap('a[data-platform="macos"]')
        await visible('macOS builds · newest first')
        await tap('a[data-platform="windows"]')
        await visible('Windows builds · newest first')
        await open(`/apps/${appId}/branches/ZW1wdHk?platform=ios`)
        await visible('^No iOS builds$')
        await screenshot('mason-empty.png')
        await open('/')
        await tap('form[action="/auth/logout"] button')
        await visible('^Sign in$')
        await tap('a[href^="/auth/start/plain"]')
        await visible('^Apps$')
        const tester = accounts
          .list()
          .find((row) => row.email === 'jordan@example.test')!
        assert.equal(tester.is_tester, 1)
        accounts.setTester(identity.account_id, tester.id, false)
        await open('/')
        await visible('^Sign in$')
        console.log(
          'Browser PASS: pending, operator admin, People preapproval, four platforms/history/empty states, first-login claim and revocation',
        )
      } finally {
        await daemon.shutdown({ wait: 15000 })
        server.close()
        await once(server, 'close')
        store.close()
        await env.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
