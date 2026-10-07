import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {
  createServer as createHttpServer,
  request as requestHttp,
} from 'node:http'
import { createServer, request } from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { describe, it } from 'mocha'
import { asConfig } from '../config.js'
import { Store } from '../store.js'
import { asCredentials } from './keys.js'
import {
  desktop,
  manifest,
  packageFields,
  plist,
  zip,
} from './fixtures.test.js'

describe('Mason compiled upload service over verified HTTPS', () => {
  it('imports a key, publishes all package formats, protects links and revokes without secret logs', async function () {
    this.timeout(20000)
    assert(process.env.MASON_TEST_ROOT)
    const root = mkdtempSync(
      path.join(process.env.MASON_TEST_ROOT, 'upload-tls-'),
    )
    const probe = createHttpServer().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = (probe.address() as AddressInfo).port
    probe.close()
    await once(probe, 'close')
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
    const ca = readFileSync(path.join(root, 'tls.crt'))
    const proxy = createServer(
      { key: readFileSync(path.join(root, 'tls.key')), cert: ca },
      (req, res) => {
        const upstream = requestHttp(
          {
            host: '127.0.0.1',
            port,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (response) => {
            res.writeHead(response.statusCode!, response.headers)
            response.pipe(res)
          },
        )
        upstream.on('error', () => res.destroy())
        req.pipe(upstream)
      },
    ).listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const tlsPort = (proxy.address() as AddressInfo).port
    const config = asConfig({
      origin: `https://builds.example.test:${tlsPort}`,
      database: path.join(root, 'state.sqlite'),
      storage: path.join(root, 'packages'),
      port,
      freeSpaceBytes: 0,
    })
    const file = path.join(root, 'config.json')
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
    const store = new Store(config)
    const app = store.addApp({
      slug: packageFields.bundleId,
      name: 'Example',
      position: 0,
    })
    for (const [platform, formats] of [
      ['ios', ['ipa']],
      ['android', ['apk']],
      ['macos', ['dmg']],
      ['windows', ['exe', 'msi']],
    ] as const)
      store.addChannel({
        appId: app,
        platform,
        key: platform,
        allowedFormats: formats,
      })
    store.close()
    const raw = execFileSync(
      process.execPath,
      [
        'lib/cli.js',
        'keys',
        'create',
        '--config',
        file,
        '--name',
        'TLS fixture',
        '--apps',
        String(app),
        '--json',
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const saved = path.join(root, 'credential.json')
    const imported = execFileSync(
      process.execPath,
      ['lib/cli.js', 'keys', 'import', '--file', saved],
      { input: raw, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const credential = asCredentials(
      JSON.parse(readFileSync(saved, 'utf8')),
    )
    assert.equal(statSync(saved).mode & 0o777, 0o600)
    assert(!imported.includes(credential.token))
    const child = spawn(
      process.execPath,
      ['lib/cli.js', 'serve', '--config', file],
      { stdio: 'pipe' },
    )
    let log = ''
    child.stdout.on('data', (data) => {
      log += String(data)
    })
    child.stderr.on('data', (data) => {
      log += String(data)
    })
    async function https(
      pathname: string,
      method = 'GET',
      body?: Buffer,
      contentType?: string,
    ): Promise<{ status: number; body: string }> {
      return await new Promise((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            servername: 'builds.example.test',
            port: tlsPort,
            ca,
            path: pathname,
            method,
            headers: contentType ? { 'Content-Type': contentType } : {},
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                body: Buffer.concat(chunks).toString(),
              }),
            )
            res.on('error', reject)
          },
        )
        req.on('error', reject)
        req.end(body)
      })
    }
    try {
      let ready = false
      for (let i = 0; i < 100; i++) {
        try {
          ready = (await https('/health')).status === 200
        } catch {
          /* Waiting for process listener. */
        }
        if (ready) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert(ready)
      for (const [format, platform, bytes] of [
        [
          'ipa',
          'ios',
          zip([['Payload/Example.app/Info.plist', plist(true)]]),
        ],
        ['apk', 'android', zip([['AndroidManifest.xml', manifest()]])],
        ['dmg', 'macos', desktop('dmg')],
        ['exe', 'windows', desktop('exe')],
        ['msi', 'windows', desktop('msi')],
      ] as const) {
        const form = new FormData()
        form.set('token', credential.token)
        form.set('channel_key', platform)
        form.set(
          'file',
          new Blob([new Uint8Array(bytes)]),
          'fixture.' + format,
        )
        form.set('branch', 'master')
        form.set(
          'custom_fields',
          JSON.stringify({
            mason: {
              ...packageFields,
              buildNumber: format === 'msi' ? '43' : '42',
            },
          }),
        )
        const encoded = new Request(
            'https://builds.example.test/api/apps/upload',
            { method: 'POST', body: form },
          ),
          body = Buffer.from(await encoded.arrayBuffer()),
          type = encoded.headers.get('content-type')!
        const first = await https('/api/apps/upload', 'POST', body, type)
        assert.equal(first.status, 201, first.body)
        const result = JSON.parse(first.body) as {
          app: { id: number }
          id: number
          release_url: string
        }
        assert.equal(result.app.id, app)
        const again = await https('/api/apps/upload', 'POST', body, type)
        assert.equal(again.status, 201)
        assert.deepEqual(JSON.parse(again.body), JSON.parse(first.body))
        const url = new URL(result.release_url)
        assert.equal((await https(url.pathname + url.search)).status, 303)
      }
      execFileSync(
        process.execPath,
        [
          'lib/cli.js',
          'keys',
          'revoke',
          '--config',
          file,
          '--id',
          credential.id,
        ],
        { stdio: 'ignore' },
      )
      const params = new URLSearchParams({
        token: credential.token,
        channel_key: 'ios',
        bundle_id: packageFields.bundleId,
        git_commit: 'unknown',
      })
      assert.equal(
        (await https('/api/apps/version_exist?' + params)).status,
        401,
      )
      assert(!log.includes(credential.token))
      assert(!log.includes('channel_key='))
    } finally {
      const stopped = once(child, 'exit')
      child.kill('SIGTERM')
      await stopped
      proxy.closeAllConnections()
      proxy.close()
      await once(proxy, 'close')
      rmSync(root, { recursive: true, force: true })
    }
  })
})
