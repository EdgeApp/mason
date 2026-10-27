import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { asConfig } from '../config.js'
import { createApp } from '../server.js'
import { Store } from '../store.js'
import { asUploadFields } from './fields.js'
import {
  desktop,
  manifest,
  packageFields,
  plist,
  zip,
} from './fixtures.test.js'
import { ApiKeys, type Credentials } from './keys.js'

let root: string,
  store: Store,
  server: Server,
  origin: string,
  keys: ApiKeys,
  credential: Credentials,
  app: number
const boundary = 'mason-upload-fixture'
function part(name: string, value: string | Buffer, filename?: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}\r\n\r\n`,
    ),
    Buffer.from(value),
    Buffer.from('\r\n'),
  ])
}
const end = Buffer.from(`--${boundary}--\r\n`)
function body(
  format = 'ipa',
  extra: Array<[string, string]> = [],
  bytes = zip([['Payload/Example.app/Info.plist', plist()]]),
): Buffer {
  return Buffer.concat([
    part('token', credential.token),
    part('channel_key', format === 'msi' ? 'exe' : format),
    part('file', bytes, 'fixture.' + format),
    ...extra.map(([key, value]) => part(key, value)),
    end,
  ])
}
async function post(
  payload: Buffer,
  query = '',
  headers = {},
): Promise<Response> {
  return await fetch(origin + '/api/apps/upload' + query, {
    method: 'POST',
    body: new Uint8Array(payload),
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
  })
}
function clean(): void {
  assert.equal(
    store.db.prepare('SELECT COUNT(*) total FROM reservations').get()?.total,
    0,
  )
  assert.equal(readdirSync(store.incoming).length, 0)
}
describe('Zealot-compatible upload HTTP API', () => {
  it('accepts branch-scoped numbers and requires a branch for ambiguous version lookup', async () => {
    const first = await post(body('ipa', [['branch', 'master']]))
    assert.equal(first.status, 201)
    const build = await first.json()
    const second = await post(body('ipa', [['branch', 'feature/example']]))
    assert.equal(second.status, 201)
    const query = new URLSearchParams({
      token: credential.token,
      channel_key: 'ipa',
      bundle_id: build.bundle_id,
      release_version: build.release_version,
      build_version: build.build_version,
    })
    assert.equal(
      (await fetch(origin + '/api/apps/version_exist?' + query)).status,
      409,
    )
    query.set('branch', 'feature/example')
    assert.equal(
      (await fetch(origin + '/api/apps/version_exist?' + query)).status,
      200,
    )
  })
  it('rejects an oversized canonical URL before publishing and preserves valid Unicode URLs', async () => {
    const expanded = 'https://ci.example.test/' + '\u00e9'.repeat(401)
    assert(expanded.length < 2048 && new URL(expanded).href.length > 2048)
    const rejected = await post(body('ipa', [['ci_url', expanded]]))
    assert.equal(rejected.status, 400)
    assert.equal(store.builds(app).length, 0)
    clean()
    const accepted = 'https://ci.example.test/caf\u00e9'
    const reply = await post(body('ipa', [['ci_url', accepted]]))
    assert.equal(reply.status, 201)
    assert.equal((await reply.json()).ci_url, new URL(accepted).href)
    assert.equal(store.builds(app).length, 1)
  })
  for (const kind of ['depth', 'nodes', 'size'])
    it(`returns committed ${kind}-bounded metadata and resolves its publication again`, async () => {
      let value: unknown = 'leaf'
      for (let i = 0; i < 12; ++i) value = { nested: value }
      if (kind === 'nodes') value = { items: Array(4094).fill(0) }
      if (kind === 'size') value = { text: 'x'.repeat(65400) }
      const extra: Array<[string, string]> = [
        ['custom_fields', JSON.stringify(value)],
      ]
      if (kind === 'size')
        extra.push(['ci_url', 'https://ci.example.test/' + 'x'.repeat(1900)])
      const reply = await post(body('ipa', extra))
      assert.equal(reply.status, 201, await reply.clone().text())
      const first = await reply.json()
      assert.deepEqual(first.custom_fields, value)
      const query = new URLSearchParams({
        token: credential.token,
        channel_key: 'ipa',
        release_version: first.release_version,
        build_version: first.build_version,
        bundle_id: first.bundle_id,
        git_commit: first.git_commit,
      })
      const found = await fetch(origin + '/api/apps/version_exist?' + query)
      assert.equal(found.status, 200)
      assert.deepEqual(await found.json(), first)
      assert.equal(store.builds(app).length, 1)
    })
  it('accepts and preserves the upstream Fastlane custom fields array', async () => {
    const response = await post(body('ipa', [['custom_fields', '["[]"]']]))
    assert.equal(response.status, 201)
    assert.deepEqual((await response.json()).custom_fields, ['[]'])
    clean()
  })
  beforeEach(async () => {
    assert(process.env.MASON_TEST_ROOT)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'upload-'))
    store = new Store(
      asConfig({
        origin: 'https://builds.example.test',
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'files'),
        packageBytes: 8192,
        freeSpaceBytes: 0,
      }),
    )
    app = store.addApp({
      slug: packageFields.bundleId,
      name: 'Example',
      position: 0,
    })
    for (const platform of ['ios', 'android', 'macos', 'windows'] as const)
      for (const format of platform === 'ios'
        ? ['ipa']
        : platform === 'android'
          ? ['apk']
          : platform === 'macos'
            ? ['dmg']
            : ['exe'])
        store.addChannel({
          appId: app,
          platform,
          key: format,
          allowedFormats: platform === 'windows' ? ['exe', 'msi'] : [format],
        })
    keys = new ApiKeys(store)
    credential = keys.create('Uploader', [app])
    server = createApp(store).listen(0, '127.0.0.1')
    await once(server, 'listening')
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('accepts official Fastlane ordering, returns its consumed fields, and retries idempotently', async () => {
    const payload = body('ipa', [
      ['branch', 'feature/日本'],
      ['git_commit', 'abc123'],
      ['changelog', 'One\nTwo'],
      ['source', 'fastlane'],
      ['ci_url', 'https://ci.example.test/job/1'],
      ['release_type', 'adhoc'],
      ['name', 'Ignored display override'],
    ])
    const first = await post(payload)
    assert.equal(first.status, 201, await first.clone().text())
    const result = (await first.json()) as {
      app: { id: number }
      id: number
      version: number
      bundle_id: string
      build_version: string
      ci_url: string
      text_changelog: string
      release_url: string
      install_url: string
      qrcode_url: null
    }
    assert.equal(result.app.id, app)
    assert.equal(result.version, result.id)
    assert.equal(result.bundle_id, packageFields.bundleId)
    assert.equal(result.build_version, '42')
    assert.equal(result.ci_url, 'https://ci.example.test/job/1')
    assert.equal(result.text_changelog, 'One\nTwo')
    assert.equal(typeof result.release_url, 'string')
    assert.equal(result.install_url, result.release_url)
    assert.equal(result.qrcode_url, null)
    assert(!JSON.stringify(result).includes(credential.token))
    assert(!JSON.stringify(result).includes('grant='))
    const second = await post(payload)
    assert.equal(second.status, 201)
    assert.deepEqual(await second.json(), result)
    assert.equal(store.builds(app).length, 1)
    clean()
    const publicLink = new URL(result.release_url)
    assert.equal(
      (
        await fetch(origin + publicLink.pathname + publicLink.search, {
          redirect: 'manual',
        })
      ).status,
      303,
    )
    for (const query of [
      { git_commit: 'abc123' },
      { release_version: '1.2.3', build_version: '42' },
    ] as Array<Record<string, string>>) {
      const params = new URLSearchParams({
        token: credential.token,
        channel_key: 'ipa',
        bundle_id: packageFields.bundleId,
        ...query,
      })
      assert.equal(
        (await fetch(origin + '/api/apps/version_exist?' + params)).status,
        200,
      )
    }
    const params = new URLSearchParams({
      token: credential.token,
      channel_key: 'ipa',
      bundle_id: packageFields.bundleId,
      git_commit: 'missing',
    })
    assert.equal(
      (await fetch(origin + '/api/apps/version_exist?' + params)).status,
      404,
    )
    params.delete('git_commit')
    assert.equal(
      (await fetch(origin + '/api/apps/version_exist?' + params)).status,
      400,
    )
  })
  it('accepts Edge query credentials and verifies IPA/APK/DMG/EXE/MSI package identities', async () => {
    const query =
      '?' +
      new URLSearchParams({
        token: credential.token,
        channel_key: 'ipa',
        branch: 'master',
        git_commit: 'abc',
      })
    assert.equal(
      (
        await post(
          Buffer.concat([
            part(
              'file',
              zip([['Payload/Example.app/Info.plist', plist(true)]]),
              'fixture.ipa',
            ),
            end,
          ]),
          query,
        )
      ).status,
      201,
    )
    assert.equal(
      (await post(body('apk', [], zip([['AndroidManifest.xml', manifest()]]))))
        .status,
      201,
    )
    for (const format of ['dmg', 'exe', 'msi'] as const) {
      const res = await post(
        body(
          format,
          [
            [
              'custom_fields',
              JSON.stringify({
                mason: {
                  ...packageFields,
                  buildNumber: format === 'msi' ? '43' : '42',
                },
              }),
            ],
          ],
          desktop(format),
        ),
      )
      assert.equal(res.status, 201, await res.text())
    }
    assert.equal(store.builds(app).length, 5)
    clean()
  })
  it('rejects file-first, duplicate/unsupported metadata and malformed requests without leaving files', async () => {
    const invalid = [
      Buffer.concat([
        part('file', 'x', 'fixture.ipa'),
        part('token', credential.token),
        end,
      ]),
      body('ipa', [['token', credential.token]]),
      body('ipa', [['password', 'no']]),
      body('ipa', [['custom_fields', '{"masonUpload":{}}']]),
      body('ipa', [['branch', 'bad\nbranch']]),
      body('ipa', [['changelog', 'x'.repeat(65537)]]),
      Buffer.concat([
        part('token', credential.token),
        part('channel_key', 'ipa'),
        end,
      ]),
      Buffer.concat([
        body().subarray(0, -end.length),
        part('file', 'x', 'second.ipa'),
        end,
      ]),
      Buffer.concat([
        part('token', credential.token),
        part('channel_key', 'ipa'),
        part('other', 'x', 'fixture.ipa'),
        end,
      ]),
      body().subarray(0, -20),
      body('ipa', [], Buffer.alloc(0)),
      body('ipa', [], Buffer.from('bad zip')),
    ]
    for (const bytes of invalid) {
      const response = await post(bytes)
      assert(response.status >= 400, await response.text())
      clean()
    }
    for (const query of [
      '?slug=change',
      '?token=one&token=two',
      '?token=duplicate',
    ]) {
      assert.equal((await post(body(), query)).status, 400)
      clean()
    }
    assert.equal(
      (await post(body(), '', { 'Content-Encoding': 'gzip' })).status,
      415,
    )
    assert.equal(
      (await post(body(), '', { 'Content-Type': 'text/plain' })).status,
      400,
    )
    assert.equal(
      (await post(body('apk', [], Buffer.from('invalid')))).status,
      400,
    )
    assert.equal((await post(body('ipa', [], Buffer.alloc(8193)))).status, 413)
    clean()
    assert.throws(() =>
      asUploadFields({
        token: credential.token,
        channel_key: 'ipa',
        changelog: '\0',
      }),
    )
    assert.throws(() =>
      asUploadFields({
        token: credential.token,
        channel_key: 'ipa',
        changelog: 'x'.repeat(65537),
      }),
    )
  })
  it('enforces scope, live revocation, format/app identity, conflicts and capacity', async () => {
    const other = store.addApp({
      slug: 'test.example.other',
      name: 'Other',
      position: 1,
    })
    store.addChannel({
      appId: other,
      platform: 'ios',
      key: 'other',
      allowedFormats: ['ipa'],
    })
    assert.equal((await post(body('other'))).status, 401)
    const changed = Buffer.concat([
      part('token', credential.token),
      part('channel_key', 'ipa'),
      part('file', desktop('dmg'), 'fixture.dmg'),
      end,
    ])
    assert.equal((await post(changed)).status, 400)
    assert.equal((await post(body())).status, 201)
    assert.equal(
      (
        await post(
          body(
            'ipa',
            [],
            zip([
              ['Payload/Example.app/Info.plist', plist()],
              ['extra', Buffer.from('changed')],
            ]),
          ),
        )
      ).status,
      409,
    )
    const all = keys.create('All', 'all')
    credential = all
    assert.equal(
      (
        await post(
          body('other', [], zip([['Payload/Example.app/Info.plist', plist()]])),
        )
      ).status,
      400,
    )
    const reservations = [
      store.reserve(credential.id, 8192),
      store.reserve(credential.id, 8192),
    ]
    assert.equal((await post(body())).status, 503)
    reservations.forEach((id) => store.cancel(id))
    keys.revoke(credential.id)
    assert.equal((await post(body())).status, 401)
    clean()
    assert.equal(
      (
        await fetch(
          origin +
            '/api/apps/version_exist?token=wrong&channel_key=ipa&bundle_id=x&git_commit=x',
        )
      ).status,
      400,
    )
  })
  it('cancels interrupted streams and rechecks keys after an in-flight revocation', async () => {
    const start = Buffer.concat([
      part('token', credential.token),
      part('channel_key', 'ipa'),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.ipa"\r\n\r\n`,
      ),
    ])
    async function active(): Promise<ReturnType<typeof httpRequest>> {
      const req = httpRequest(origin + '/api/apps/upload', {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
      })
      req.on('error', () => {})
      req.write(Buffer.concat([start, Buffer.from('P')]))
      for (let n = 0; n < 100 && readdirSync(store.incoming).length === 0; n++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(readdirSync(store.incoming).length, 1)
      return req
    }
    const aborted = await active()
    aborted.destroy()
    for (let n = 0; n < 100 && readdirSync(store.incoming).length !== 0; n++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    clean()
    const revoked = await active()
    keys.revoke(credential.id)
    const response = once(revoked, 'response')
    revoked.end(
      Buffer.concat([
        zip([['Payload/Example.app/Info.plist', plist()]]).subarray(1),
        Buffer.from('\r\n'),
        end,
      ]),
    )
    const [res] = await response
    assert.equal(res.statusCode, 401)
    res.resume()
    await once(res, 'end')
    clean()
    assert.equal(store.builds(app).length, 0)
  })
  it('bounds failed API attempts without disclosing credentials', async () => {
    for (let i = 0; i < 120; i++)
      await fetch(origin + '/api/apps/version_exist?token=invalid')
    const res = await post(body())
    assert.equal(res.status, 429)
    assert(!(await res.text()).includes(credential.token))
    clean()
  })
})
