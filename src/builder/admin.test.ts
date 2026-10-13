import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { asBuilderConfig } from './config.js'
import { builderCommand } from './cli.js'
import { builderApp } from './server.js'
import { BuilderStore } from './store.js'

let root: string, store: BuilderStore, server: Server, url: string
const deployConfig = Buffer.from('{"upload":"secret-token"}').toString('base64')
const eddy = {
  name: 'Eddy',
  repository: 'git@github.com:example/eddy.git',
  platforms: ['macos'],
  env: [
    { name: 'BUILD_NUMBER_FILE', value: '/state/buildNum.json', secret: false },
    { name: 'UPLOAD_TOKEN', value: 'secret-token' },
  ],
  files: [
    {
      destination: 'deployConfig.json',
      contents: deployConfig,
      env: 'DEPLOY_CONFIG_FILE',
    },
  ],
}
function headers(file: string): Record<string, string> {
  return {
    Authorization: `Bearer ${readFileSync(file, 'utf8').trim()}`,
    'Content-Type': 'application/json',
  }
}
async function put(
  file: string,
  slug: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${url}/api/admin/apps/${slug}`, {
    method: 'PUT',
    headers: headers(file),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  }
}
describe('Mason builder admin API', function () {
  this.timeout(20000)
  let admin: string, build: string
  beforeEach(async () => {
    process.umask(0o077)
    root = mkdtempSync(
      path.join(process.env.MASON_TEST_ROOT!, 'builder-admin-'),
    )
    store = new BuilderStore(
      asBuilderConfig({ workspace: path.join(root, 'state') }),
    )
    admin = path.join(root, 'admin-key')
    build = path.join(root, 'build-key')
    store.key(admin, true)
    store.key(build)
    server = builderApp(store).listen(0, '127.0.0.1')
    await once(server, 'listening')
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('adds an app without returning its secrets and queues its builds', async () => {
    const created = await put(admin, 'app.edge.eddy', eddy)
    assert.equal(created.status, 201)
    const visible = {
      slug: 'app.edge.eddy',
      name: 'Eddy',
      position: 0,
      enabled: true,
      repository: 'git@github.com:example/eddy.git',
      workspace: 'git-worktrees',
      timeoutSeconds: 14400,
      platforms: ['macos'],
      env: [
        {
          name: 'BUILD_NUMBER_FILE',
          value: '/state/buildNum.json',
          secret: false,
        },
        { name: 'UPLOAD_TOKEN', secret: true },
      ],
      files: [
        {
          destination: 'deployConfig.json',
          env: 'DEPLOY_CONFIG_FILE',
          bytes: 25,
        },
      ],
    }
    assert.deepEqual(created.json, visible)
    assert.ok(!JSON.stringify(created.json).includes('secret-token'))
    const listed = await fetch(url + '/api/admin/apps', {
      headers: headers(admin),
    })
    assert.deepEqual(await listed.json(), [visible])
    const one = await fetch(url + '/api/admin/apps/app.edge.eddy', {
      headers: headers(admin),
    })
    assert.deepEqual(await one.json(), visible)
    assert.equal(
      (
        await fetch(url + '/api/admin/apps/app.edge.none', {
          headers: headers(admin),
        })
      ).status,
      404,
    )
    assert.equal(store.buildSettings('app.edge.eddy').defaultBranch, 'master')
    // The new app builds with an ordinary key.
    const job = await fetch(url + '/api/jobs', {
      method: 'POST',
      headers: headers(build),
      body: JSON.stringify({ app: 'app.edge.eddy' }),
    })
    assert.equal(job.status, 202)
    assert.equal(store.pending()[0]!.definition.env[1]!.value, 'secret-token')
  })
  it('keeps stored secrets by reference when a definition changes', async () => {
    await put(admin, 'app.edge.eddy', eddy)
    const changed = await put(admin, 'app.edge.eddy', {
      ...eddy,
      slug: 'app.edge.eddy',
      name: 'Eddy (Edge)',
      env: [
        {
          name: 'BUILD_NUMBER_FILE',
          value: '/other/buildNum.json',
          secret: false,
        },
        { name: 'UPLOAD_TOKEN', keep: true },
        { name: 'EXTRA', value: 'x' },
      ],
      files: [{ destination: 'deployConfig.json', keep: true }],
    })
    assert.equal(changed.status, 200)
    const [stored] = store.apps()
    assert.equal(stored!.name, 'Eddy (Edge)')
    assert.deepEqual(stored!.env, [
      {
        name: 'BUILD_NUMBER_FILE',
        value: '/other/buildNum.json',
        secret: false,
      },
      { name: 'UPLOAD_TOKEN', value: 'secret-token', secret: true },
      { name: 'EXTRA', value: 'x', secret: true },
    ])
    assert.deepEqual(stored!.files, eddy.files)
    // Keeping a file may rebind its environment variable.
    await put(admin, 'app.edge.eddy', {
      ...eddy,
      files: [
        { destination: 'deployConfig.json', keep: true, env: 'OTHER_CONFIG' },
      ],
    })
    assert.equal(store.apps()[0]!.files[0]!.env, 'OTHER_CONFIG')
    assert.equal(store.apps()[0]!.files[0]!.contents, deployConfig)
    // A large injected file exceeds the job API's body limit but not this one.
    const large = Buffer.alloc(200000, 1).toString('base64')
    assert.equal(
      (
        await put(admin, 'app.edge.eddy', {
          ...eddy,
          files: [{ destination: 'large.bin', contents: large }],
        })
      ).status,
      200,
    )
    for (const body of [
      { ...eddy, slug: 'app.edge.other' },
      { ...eddy, env: [{ name: 'MISSING', keep: true }] },
      { ...eddy, env: [{ name: 'UPLOAD_TOKEN', keep: false }] },
      { ...eddy, files: [{ destination: 'deployConfig.json', keep: true }] },
      { ...eddy, platforms: [] },
      { ...eddy, unknown: true },
      [eddy],
      '{not json',
    ]) {
      const result = await put(admin, 'app.edge.eddy', body)
      assert.equal(result.status, 400, JSON.stringify(body).slice(0, 80))
      assert.equal(result.json.error, 'Invalid app definition')
    }
    assert.equal(store.apps()[0]!.files[0]!.destination, 'large.bin')
    assert.equal(
      (
        await put(admin, 'app.edge.other', {
          ...eddy,
          env: [{ name: 'UPLOAD_TOKEN', keep: true }],
        })
      ).status,
      400,
    )
    assert.equal(store.apps().length, 1)
  })
  it('requires an admin key for app definitions only', async () => {
    assert.equal((await put(build, 'app.edge.eddy', eddy)).status, 403)
    const denied = await fetch(url + '/api/admin/apps', {
      headers: headers(build),
    })
    assert.equal(denied.status, 403)
    assert.equal((await fetch(url + '/api/admin/apps')).status, 401)
    assert.equal(
      (await fetch(url + '/api/queue', { headers: headers(admin) })).status,
      200,
    )
    assert.equal(store.apps().length, 0)
  })
  it('creates admin keys from the CLI and adds the role to older key tables', async () => {
    const config = path.join(root, 'builder.json')
    writeFileSync(
      config,
      JSON.stringify({ workspace: path.join(root, 'cli-state') }),
      { mode: 0o600 },
    )
    const output: string[] = []
    await builderCommand(
      [
        'key-create',
        '--config',
        config,
        '--output',
        path.join(root, 'cli-admin'),
        '--role',
        'admin',
      ],
      (s) => output.push(s),
    )
    await builderCommand(
      [
        'key-create',
        '--config',
        config,
        '--output',
        path.join(root, 'cli-build'),
      ],
      (s) => output.push(s),
    )
    const [adminKey, buildKey] = output.map(
      (s) => JSON.parse(s) as { id: string; role: string },
    )
    assert.equal(adminKey!.role, 'admin')
    assert.equal(buildKey!.role, 'build')
    await assert.rejects(
      builderCommand([
        'key-create',
        '--config',
        config,
        '--output',
        path.join(root, 'cli-other'),
        '--role',
        'owner',
      ]),
    )
    const reopened = new BuilderStore(
      asBuilderConfig({ workspace: path.join(root, 'cli-state') }),
    )
    try {
      assert.equal(reopened.isAdmin(adminKey!.id), true)
      assert.equal(reopened.isAdmin(buildKey!.id), false)
    } finally {
      reopened.close()
    }
    const file = path.join(root, 'cli-state', 'builder.sqlite')
    const legacy = new DatabaseSync(file)
    legacy.exec(`DROP TABLE builder_keys;
      CREATE TABLE builder_keys(id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE) STRICT;
      INSERT INTO builder_keys VALUES('old','digest');`)
    legacy.close()
    const migrated = new BuilderStore(
      asBuilderConfig({ workspace: path.join(root, 'cli-state') }),
    )
    try {
      assert.equal(migrated.isAdmin('old'), false)
    } finally {
      migrated.close()
    }
  })
})
