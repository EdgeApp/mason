import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { cluster, type Cluster } from '../../test/cluster.js'
import { FakeCloud } from '../../test/fakeCloud.js'
import { FakeSpaces } from '../../test/fakeSpaces.js'
import { nodesView } from '../../view/admin.js'
import { localOperator } from '../roles.js'
import type { CloudHostRow } from './hosts.js'

// API replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

describe('Host storage on DigitalOcean Spaces', function () {
  this.timeout(120_000)
  let c: Cluster
  let cloud: FakeCloud
  const spaces = new FakeSpaces()
  let timeout = false

  before(async () => {
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'spaces-'),
    )
    await spaces.start()
    cloud = new FakeCloud(dir)
    cloud.spaces = spaces
    c = await cluster(path.join(dir, 'cluster'), {
      workers: [],
      masterOptions: {
        cloudHosts: {
          provider: () => cloud,
          publicAddress: async () => '203.0.113.7',
          tickMs: 3_600_000,
          settleMs: 50,
        },
        spaces: {
          endpoint: () => spaces.endpoint,
          fetch: (async (url: string | URL, init?: RequestInit) => {
            if (timeout) {
              const error = new Error('The operation timed out')
              error.name = 'TimeoutError'
              throw error
            }
            return await spaces.fetch(url, init)
          }) as typeof fetch,
          wait: async () => undefined,
        },
      },
    })
    await c.master.master!.settings.set(localOperator, 'cloudAccounts', {
      accounts: [
        {
          id: 'do',
          name: 'DigitalOcean',
          provider: 'digitalocean',
          key: 'dop_v1_' + 'b'.repeat(64),
        },
      ],
    })
  })
  after(async () => {
    await c?.close()
    await cloud?.close()
    await spaces.close()
  })

  const row = (name: string): CloudHostRow =>
    c.master.master!.cloudHosts.get(name)!
  const storage = (): Json => c.master.master!.settings.value('storage')
  const settle = async (name: string, state: string): Promise<Json> =>
    await c.until(
      () => (row(name)?.state === state ? row(name) : undefined),
      30_000,
      `${name} ${state}`,
    )
  const reconcile = async (name: string): Promise<Json> =>
    (await c.api('POST', `/api/v2/cloud/hosts/${name}/reconcile`, {})).json

  it('U6.2 the Storage form saves a Space only after its key writes, reads and deletes there; the secret is write-only', async () => {
    // A Space and a key made by hand, as a person would in DigitalOcean.
    // DigitalOcean grants a key only on a bucket that exists.
    const setup = await cloud.createSpacesKey('hand-setup', [
      { bucket: '', permission: 'fullaccess' },
    ])
    const { SpaceClient } = await import('./spaces.js')
    await new SpaceClient(
      { endpoint: spaces.endpoint, region: 'sfo3' },
      { accessKeyId: setup.id, secretAccessKey: setup.secret },
      spaces.fetch,
    ).create('mason-scratch')
    await assert.rejects(
      cloud.createSpacesKey('hand-early', [
        { bucket: 'mason-not-yet', permission: 'readwrite' },
      ]),
      /403 invalid grant/,
    )
    const scratch = await cloud.createSpacesKey('hand-scratch', [
      { bucket: 'mason-scratch', permission: 'readwrite' },
    ])
    const save = async (body: Json): Promise<Json> =>
      await c.api('POST', '/api/v2/storage/space', {
        url: 'https://mason-scratch.sfo3.digitaloceanspaces.com',
        accessKeyId: scratch.id,
        secretAccessKey: scratch.secret,
        ...body,
      })
    const wrong = await save({ secretAccessKey: 'wrong-secret-12345' })
    assert.equal(wrong.status, 400)
    assert.match(
      wrong.json.error,
      /^Nothing was saved: Space mason-scratch: AccessDenied \(the key cannot use this Space\)/,
    )
    const denied = await save({
      url: 'https://other.sfo3.digitaloceanspaces.com',
    })
    assert.match(
      denied.json.error,
      /Nothing was saved: Space other: AccessDenied/,
    )
    const missing = await save({
      url: 'https://missing.sfo3.digitaloceanspaces.com',
      accessKeyId: setup.id,
      secretAccessKey: setup.secret,
    })
    assert.match(
      missing.json.error,
      /Nothing was saved: Space missing: NoSuchBucket/,
    )
    timeout = true
    const slow = await save({})
    timeout = false
    assert.match(slow.json.error, /Nothing was saved: The operation timed out/)
    assert.match((await save({ url: 'not a url' })).json.error, /is not a URL/)
    assert.match(
      (await save({ accessKeyId: '' })).json.error,
      /access key and secret are required/,
    )
    assert.equal(storage(), undefined, 'nothing saved')
    const saved = await save({})
    assert.equal(saved.status, 200, saved.text)
    assert.deepEqual(saved.json, {
      driver: 's3',
      s3: {
        endpoint: spaces.endpoint,
        bucket: 'mason-scratch',
        region: 'sfo3',
        accessKeyId: scratch.id,
        secretAccessKey: { set: true },
      },
    })
    const kept = await save({ secretAccessKey: { keep: true } })
    assert.equal(kept.status, 200, kept.text)
    assert.equal(storage().s3.secretAccessKey, scratch.secret)
    assert.equal((await c.api('GET', '/api/v2/storage')).json.driver, 's3')
    const disk = await c.api('POST', '/api/v2/storage/disk', {})
    assert.deepEqual(disk.json, { driver: 'disk' })
  })

  it('U6.3/U6.4 a host made with a new Space gets its bucket and a key limited to it; reconcile then changes nothing', async () => {
    // New keys are refused for their first requests, as DigitalOcean's are.
    spaces.newKeyRefusals = 2
    const made = await c.api('POST', '/api/v2/cloud/hosts', {
      name: 'e2e',
      account: 'do',
      region: 'sfo3',
      size: 's-1vcpu-1gb',
      space: { bucket: 'mason-e2e', region: 'sfo3' },
    })
    assert.equal(made.status, 201, made.text)
    await settle('e2e', 'ready')
    spaces.newKeyRefusals = 0
    assert(spaces.buckets.has('mason-e2e'))
    const keys = [...spaces.keys.entries()].filter(([, key]) =>
      key.name.startsWith('mason-host-'),
    )
    assert.equal(keys.length, 1, 'the setup key is gone')
    const [keyId, key] = keys[0]!
    assert.deepEqual(key.grants, ['mason-e2e'])
    assert.deepEqual(
      cloud.spacesCalls.filter((call) => call.includes('mason-host')),
      // The bucket first: DigitalOcean grants a key only on a bucket that exists.
      [
        `create ${key.name}-setup`,
        `delete ${key.name}-setup`,
        `create ${key.name}`,
      ],
    )
    assert.equal(storage().driver, 's3')
    assert.equal(storage().s3.bucket, 'mason-e2e')
    assert.equal(storage().s3.accessKeyId, keyId)
    assert.equal(storage().s3.secretAccessKey, key.secret)
    assert.equal(row('e2e').space_owned, 1)
    assert.equal(row('e2e').space_pending, 0)
    const listed = (await c.api('GET', '/api/v2/cloud/hosts')).json[0]
    assert.equal(listed.space_secret, undefined)
    assert.equal(listed.space_bucket, 'mason-e2e')
    const before = cloud.spacesCalls.length
    assert.equal((await reconcile('e2e')).state, 'ready')
    assert.equal(cloud.spacesCalls.length, before, 'no Spaces calls')
    // The page offers the Space's storage and its removal choice.
    const html = nodesView({
      nodes: [],
      types: {},
      pools: [],
      host: 'https://127.0.0.1',
      cloudHosts: [
        {
          name: 'e2e',
          state: 'ready',
          account: 'do',
          region: 'sfo3',
          size: 's-1vcpu-1gb',
          address: '127.0.0.1',
          origin: 'https://127.0.0.1',
          error: null,
          space: { bucket: 'mason-e2e', region: 'sfo3' },
        },
        {
          name: 'other',
          state: 'ready',
          account: 'do',
          region: 'nyc3',
          size: 's-1vcpu-1gb',
          address: null,
          origin: null,
          error: null,
        },
      ],
      storage: { driver: 's3', bucket: 'mason-e2e', endpoint: spaces.endpoint },
      budget: { monthly: 200 },
      canChange: true,
    })
    assert.match(
      html,
      /Builds Space <span class="mono">mason-e2e<\/span> \(sfo3\)/,
    )
    assert.match(html, /Also delete the Space and every build in it/)
    assert.match(
      html,
      /Builds are stored in <span class="mono">mason-e2e<\/span>/,
    )
    assert.match(html, /Use the host’s disk/)
    assert.match(html, /value="mason-other"/)
    assert.match(
      nodesView({
        nodes: [],
        types: {},
        pools: [],
        host: 'https://h',
        budget: { monthly: 1 },
        canChange: true,
      }),
      /Builds are stored on the host’s disk/,
    )
  })

  it('U6.5 a listed key whose secret the database lacks is replaced, the old Mason key deleted, and the bucket adopted', async () => {
    const old = row('e2e').space_key_id!
    // As a database restored from before the key was made.
    c.master
      .master!.database.db.prepare(
        "UPDATE cloud_hosts SET space_secret=NULL,space_key_id='gone' WHERE name='e2e'",
      )
      .run()
    await c.master.master!.settings.set(localOperator, 'storage', {
      driver: 'disk',
    })
    const before = cloud.spacesCalls.length
    assert.equal((await reconcile('e2e')).state, 'ready')
    const name = spaces.keys.get(row('e2e').space_key_id!)!.name
    // The bucket is seen with a setup key, adopted, then a key made for it.
    assert.deepEqual(cloud.spacesCalls.slice(before), [
      `create ${name}-setup`,
      `delete ${name}-setup`,
      `create ${name}`,
      `delete ${name}`,
    ])
    assert(!spaces.keys.has(old))
    assert.notEqual(row('e2e').space_key_id, old)
    assert.equal(row('e2e').space_owned, 1)
    // Storage an administrator set is not replaced by a reconcile.
    assert.equal(storage().driver, 'disk')
  })

  it('U6.6 a Space name another account holds is an error with nothing made; storage set by an administrator stays', async () => {
    spaces.taken.add('popular')
    const refused = await c.api('POST', '/api/v2/cloud/hosts/e2e/space', {
      bucket: 'popular',
      region: 'sfo3',
    })
    assert.equal(refused.json.state, 'error')
    assert.equal(
      refused.json.error,
      'The Space name popular is taken by another account; choose another',
    )
    assert(!spaces.buckets.has('popular'))
    assert.equal(storage().driver, 'disk')
    assert.equal(
      (
        await c.api('POST', '/api/v2/cloud/hosts/e2e/space', {
          bucket: 'X',
          region: 'sfo3',
        })
      ).json.error,
      'space.bucket is a Space name: 3 to 63 lowercase letters, digits and dashes',
    )
    assert.equal(
      (
        await c.api('POST', '/api/v2/cloud/hosts/e2e/space', {
          bucket: 'fine',
          region: 'mars',
        })
      ).json.error,
      'space.region is a Spaces region such as sfo3',
    )
    assert.equal(
      (
        await c.api('POST', '/api/v2/cloud/hosts/none/space', {
          bucket: 'fine',
          region: 'sfo3',
        })
      ).status,
      404,
    )
    // Back to its own Space: storage switches because the administrator asked.
    const back = await c.api('POST', '/api/v2/cloud/hosts/e2e/space', {
      bucket: 'mason-e2e',
      region: 'sfo3',
    })
    assert.equal(back.json.state, 'ready', back.text)
    assert.equal(storage().s3.bucket, 'mason-e2e')
  })

  it('U6.7 remove keeps the Space by default and deletes the Mason key; asked, it empties and deletes a Space it made', async () => {
    const key = row('e2e').space_key_id!
    spaces.buckets.get('mason-e2e')!.set('builds/one.ipa', Buffer.from('one'))
    assert.equal(
      (await c.api('DELETE', '/api/v2/cloud/hosts/e2e', { confirm: 'e2e' }))
        .status,
      200,
    )
    assert(spaces.buckets.has('mason-e2e'), 'the Space and its builds stay')
    assert(!spaces.keys.has(key), 'the Mason key goes')
    // Storage was through that key: the next host stores on its disk.
    assert.equal(storage().driver, 'disk')
    // A host made with the same Space adopts it; deleted with the host, Mason
    // empties it only because this host made it.
    assert.equal(
      (
        await c.api('POST', '/api/v2/cloud/hosts', {
          name: 'e2e',
          account: 'do',
          region: 'sfo3',
          size: 's-1vcpu-1gb',
          space: { bucket: 'mason-fresh', region: 'sfo3' },
        })
      ).status,
      201,
    )
    await settle('e2e', 'ready')
    assert.equal(row('e2e').space_owned, 1)
    spaces.buckets.get('mason-fresh')!.set('builds/two.apk', Buffer.from('two'))
    const deleted = await c.api('DELETE', '/api/v2/cloud/hosts/e2e', {
      confirm: 'e2e',
      deleteSpace: 'delete',
    })
    assert.equal(deleted.status, 200, deleted.text)
    assert(!spaces.buckets.has('mason-fresh'))
    assert(spaces.buckets.has('mason-e2e'))
    assert.equal(storage().driver, 'disk')
    assert.deepEqual(
      [...spaces.keys.values()].filter((entry) =>
        entry.name.startsWith('mason-host-'),
      ),
      [],
    )
    // A host given a Space that already exists adopts it, and never deletes it.
    await c.api('POST', '/api/v2/cloud/hosts', {
      name: 'e2e',
      account: 'do',
      region: 'sfo3',
      size: 's-1vcpu-1gb',
      space: { bucket: 'mason-e2e', region: 'sfo3' },
    })
    await settle('e2e', 'ready')
    assert.equal(row('e2e').space_owned, 0)
    assert.equal(
      (
        await c.api('DELETE', '/api/v2/cloud/hosts/e2e', {
          confirm: 'e2e',
          deleteSpace: 'delete',
        })
      ).status,
      200,
    )
    assert(spaces.buckets.get('mason-e2e')?.has('builds/one.ipa'))
  })
})
