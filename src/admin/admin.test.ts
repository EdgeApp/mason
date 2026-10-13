import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { asConfig } from '../config.js'
import { createApp } from '../server.js'
import { Store } from '../store.js'
import { desktop } from '../upload/fixtures.test.js'
import { ApiKeys, type Credentials, type Key } from '../upload/keys.js'
import { asSlug, type AdminApp, type AdminChannel } from './apps.js'
import { migrateAdmin } from './schema.js'

let root: string,
  store: Store,
  server: Server,
  origin: string,
  keys: ApiKeys,
  admin: Credentials,
  configFile: string
type ListedKey = Omit<Key, 'apps'> & { apps: 'all' | string[] }
async function call<T = { error: string }>(
  method: string,
  route: string,
  body?: unknown,
  token = admin.token,
): Promise<{ status: number; json: T }> {
  const response = await fetch(origin + route, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    json: (text.startsWith('{') || text.startsWith('[')
      ? JSON.parse(text)
      : { error: text }) as T,
  }
}
async function upload(
  channelKey: string,
  token: string,
  buildNumber = '1',
): Promise<Response> {
  const boundary = 'mason-admin-fixture'
  const part = (name: string, value: string | Buffer, file?: string): Buffer =>
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file ? `; filename="${file}"` : ''}\r\n\r\n`,
      ),
      Buffer.from(value),
      Buffer.from('\r\n'),
    ])
  return await fetch(origin + '/api/apps/upload', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: new Uint8Array(
      Buffer.concat([
        part('token', token),
        part('channel_key', channelKey),
        part(
          'custom_fields',
          JSON.stringify({
            mason: { bundleId: 'app.edge.eddy', version: '0.3.3', buildNumber },
          }),
        ),
        part('file', desktop('dmg'), 'Eddy.dmg'),
        Buffer.from(`--${boundary}--\r\n`),
      ]),
    ),
  })
}
function cli(args: string[]): string {
  return execFileSync(process.execPath, ['lib/cli.js', 'keys', ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}
describe('Mason distribution admin API', () => {
  beforeEach(async () => {
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'admin-'))
    store = new Store(
      asConfig({
        origin: 'https://builds.example.test',
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'files'),
        packageBytes: 8192,
        freeSpaceBytes: 0,
      }),
    )
    configFile = path.join(root, 'config.json')
    writeFileSync(configFile, JSON.stringify(store.config), { mode: 0o600 })
    keys = new ApiKeys(store)
    admin = keys.create('Operator', undefined, undefined, 'admin')
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
  it('adds a macOS app, its channel and an upload key that publishes a DMG', async () => {
    store.addApp({ slug: 'app.example.first', name: 'First', position: 3 })
    const created = await call<AdminApp>('POST', '/api/admin/apps', {
      slug: 'app.edge.eddy',
      name: 'Eddy',
    })
    assert.equal(created.status, 201)
    assert.deepEqual(
      { ...created.json, id: undefined },
      {
        id: undefined,
        slug: 'app.edge.eddy',
        name: 'Eddy',
        position: 4,
        enabled: true,
        channels: [],
      },
    )
    const channel = await call<AdminChannel>(
      'POST',
      '/api/admin/apps/app.edge.eddy/channels',
      {
        platform: 'macos',
      },
    )
    assert.equal(channel.status, 201)
    assert.equal(channel.json.platform, 'macos')
    assert.deepEqual(channel.json.formats, ['dmg'])
    assert.equal(channel.json.enabled, true)
    assert.match(channel.json.key, /^[A-Za-z0-9_-]{43}$/)
    const key = await call<Credentials>('POST', '/api/admin/keys', {
      name: 'Eddy builds',
      apps: ['app.edge.eddy'],
    })
    assert.equal(key.status, 201)
    assert.equal(key.json.origin, 'https://builds.example.test')
    const uploaded = await upload(channel.json.key, key.json.token)
    assert.equal(uploaded.status, 201, await uploaded.text())
    assert.equal(store.builds(created.json.id).length, 1)
    // An admin key is not an upload key.
    assert.equal((await upload(channel.json.key, admin.token, '2')).status, 401)
    // Neither is an upload key an admin key.
    assert.equal(
      (await call('GET', '/api/admin/apps', undefined, key.json.token)).status,
      401,
    )
    const listed = await call<ListedKey[]>('GET', '/api/admin/keys')
    assert.equal(listed.status, 200)
    const eddyKey = listed.json.find((k) => k.id === key.json.id)!
    assert.deepEqual(eddyKey.apps, ['app.edge.eddy'])
    assert.equal(eddyKey.role, 'upload')
    assert.equal(listed.json.find((k) => k.id === admin.id)!.role, 'admin')
    assert.equal(
      (await call('POST', `/api/admin/keys/${key.json.id}/revoke`)).status,
      200,
    )
    assert.equal(
      (await upload(channel.json.key, key.json.token, '3')).status,
      401,
    )
    const audit = store.db
      .prepare('SELECT action,target FROM audit ORDER BY id')
      .all()
      .map((row) => `${String(row.action)} ${String(row.target)}`)
    assert.deepEqual(audit, [
      `key.create.admin ${admin.id}`,
      'app.create app.edge.eddy',
      'channel.create app.edge.eddy:macos',
      `key.create ${key.json.id}`,
      `key.revoke ${key.json.id}`,
    ])
  })
  it('updates apps and channels, rotates channel keys and reports conflicts', async () => {
    const app = await call<AdminApp>('POST', '/api/admin/apps', {
      slug: 'app.example.desk',
      name: 'Desk',
      position: 9,
      enabled: false,
    })
    assert.equal(app.json.position, 9)
    assert.equal(app.json.enabled, false)
    assert.equal(
      (
        await call('POST', '/api/admin/apps', {
          slug: 'app.example.desk',
          name: 'Again',
        })
      ).status,
      409,
    )
    const changed = await call<AdminApp>(
      'PATCH',
      '/api/admin/apps/app.example.desk',
      {
        name: 'Desk Tool',
        enabled: true,
      },
    )
    assert.equal(changed.status, 200)
    assert.equal(changed.json.name, 'Desk Tool')
    assert.equal(changed.json.position, 9)
    assert.equal(changed.json.enabled, true)
    const unchanged = await call<AdminApp>(
      'PATCH',
      '/api/admin/apps/app.example.desk',
      {},
    )
    assert.deepEqual(unchanged.json, changed.json)
    const windows = await call<AdminChannel>(
      'POST',
      '/api/admin/apps/app.example.desk/channels',
      {
        platform: 'windows',
        enabled: false,
      },
    )
    assert.deepEqual(windows.json.formats, ['exe', 'msi'])
    assert.equal(windows.json.enabled, false)
    assert.equal(
      (
        await call('POST', '/api/admin/apps/app.example.desk/channels', {
          platform: 'windows',
        })
      ).status,
      409,
    )
    const rotated = await call<AdminChannel>(
      'PATCH',
      '/api/admin/apps/app.example.desk/channels/windows',
      { formats: ['msi'], enabled: true, rotateKey: true },
    )
    assert.equal(rotated.status, 200)
    assert.deepEqual(rotated.json.formats, ['msi'])
    assert.equal(rotated.json.enabled, true)
    assert.notEqual(rotated.json.key, windows.json.key)
    const kept = await call<AdminChannel>(
      'PATCH',
      '/api/admin/apps/app.example.desk/channels/windows',
      {},
    )
    assert.deepEqual(kept.json, rotated.json)
    const fetched = await call<AdminApp>(
      'GET',
      '/api/admin/apps/app.example.desk',
    )
    assert.deepEqual(fetched.json.channels, [rotated.json])
    const all = await call<AdminApp[]>('GET', '/api/admin/apps')
    assert.deepEqual(all.json, [fetched.json])
    for (const [method, route, body, status] of [
      ['GET', '/api/admin/apps/app.example.none', undefined, 404],
      ['PATCH', '/api/admin/apps/app.example.none', {}, 404],
      [
        'POST',
        '/api/admin/apps/app.example.none/channels',
        { platform: 'ios' },
        404,
      ],
      ['PATCH', '/api/admin/apps/app.example.desk/channels/ios', {}, 404],
      ['POST', '/api/admin/apps', { slug: 'nodots', name: 'X' }, 400],
      [
        'POST',
        '/api/admin/apps',
        { slug: 'app.example.x', name: 'X', extra: 1 },
        400,
      ],
      [
        'POST',
        '/api/admin/apps/app.example.desk/channels',
        { platform: 'linux' },
        400,
      ],
      [
        'POST',
        '/api/admin/apps/app.example.desk/channels',
        { platform: 'macos', formats: ['ipa'] },
        400,
      ],
      [
        'PATCH',
        '/api/admin/apps/app.example.desk/channels/windows',
        { formats: [] },
        400,
      ],
      ['PATCH', '/api/admin/apps/app.example.desk', { enabled: 'yes' }, 400],
      ['POST', '/api/admin/apps', '{not json', 400],
      [
        'POST',
        '/api/admin/keys',
        { name: 'X', apps: ['app.example.none'] },
        404,
      ],
      ['POST', '/api/admin/keys', { name: 'X', apps: [] }, 400],
      ['POST', '/api/admin/keys', { name: 'X', apps: 'every' }, 400],
      [
        'POST',
        '/api/admin/keys',
        { name: 'X', apps: 'all', expiresAt: 1 },
        400,
      ],
      ['POST', `/api/admin/keys/${'0'.repeat(32)}/revoke`, undefined, 404],
      ['POST', '/api/admin/keys/invalid/revoke', undefined, 400],
    ] as const) {
      const result = await call(method, route, body)
      assert.equal(result.status, status, `${method} ${route}`)
      assert.equal(typeof result.json.error, 'string')
    }
    const everything = await call<Credentials>('POST', '/api/admin/keys', {
      name: 'All apps',
      apps: 'all',
      expiresAt: Date.now() + 60000,
    })
    assert.equal(everything.status, 201)
    const listed = await call<ListedKey[]>('GET', '/api/admin/keys')
    assert.equal(
      listed.json.find((k) => k.id === everything.json.id)!.apps,
      'all',
    )
  })
  it('requires a live admin key and limits request rate', async () => {
    assert.equal(
      (await call('GET', '/api/admin/apps', undefined, 'invalid')).status,
      401,
    )
    const plain = await fetch(origin + '/api/admin/apps')
    assert.equal(plain.status, 401)
    const expiring = keys.create('Soon', undefined, Date.now() + 60000, 'admin')
    assert.equal(
      (await call('GET', '/api/admin/apps', undefined, expiring.token)).status,
      200,
    )
    keys.revoke(expiring.id)
    assert.equal(
      (await call('GET', '/api/admin/apps', undefined, expiring.token)).status,
      401,
    )
    const unknown = await call('GET', '/api/admin/unknown')
    assert.equal(unknown.status, 404)
    let limited = 0
    for (let i = 0; i < 125; i++)
      if ((await call('GET', '/api/admin/apps')).status === 429) limited++
    assert.ok(limited > 0)
  })
  it('validates bundle identifiers', () => {
    assert.equal(asSlug('app.edge.eddy'), 'app.edge.eddy')
    for (const value of [
      'eddy',
      '.app.edge',
      'app..edge',
      'app.edge.',
      'app/edge.x',
      'a.' + 'b'.repeat(160),
    ])
      assert.throws(() => asSlug(value))
  })
  it('mints admin keys from the server CLI without app scopes', () => {
    const credential = JSON.parse(
      cli([
        'create',
        '--config',
        configFile,
        '--name',
        'Bootstrap',
        '--role',
        'admin',
        '--json',
      ]),
    )
    assert.equal(keys.authenticateAdmin(credential.token).name, 'Bootstrap')
    assert.throws(() => keys.authenticate(credential.token, 1))
    for (const args of [
      [
        'create',
        '--config',
        configFile,
        '--name',
        'X',
        '--role',
        'admin',
        '--apps',
        'all',
        '--json',
      ],
      [
        'create',
        '--config',
        configFile,
        '--name',
        'X',
        '--role',
        'owner',
        '--json',
      ],
      ['create', '--config', configFile, '--name', 'X', '--json'],
    ])
      assert.throws(() => cli(args))
    const listed = JSON.parse(cli(['list', '--config', configFile]))
    assert.deepEqual(listed.map((k: { role: string }) => k.role).sort(), [
      'admin',
      'admin',
    ])
  })
  it('gives keys from older databases the upload role', () => {
    const file = path.join(root, 'legacy.sqlite')
    const legacy = new DatabaseSync(file)
    legacy.exec(`CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, apps TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
    ) STRICT;
    INSERT INTO api_keys(id,hash,name,apps,created_at) VALUES('k','h','Old','"all"',1);`)
    migrateAdmin(legacy)
    assert.equal(
      legacy.prepare('SELECT role FROM api_keys').get()?.role,
      'upload',
    )
    assert.equal(legacy.prepare('PRAGMA user_version').get()?.user_version, 7)
    assert.throws(() =>
      legacy.exec(
        "INSERT INTO api_keys(id,hash,name,apps,created_at,role) VALUES('x','y','Bad','[]',1,'owner')",
      ),
    )
    legacy.close()
  })
})
