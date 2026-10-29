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
      storage: {
        driver: 's3',
        bucket: 'mason-e2e',
        endpoint: spaces.endpoint,
        locations: c.master.master!.storageLocations.list(),
      },
      budget: { monthly: 200 },
      canChange: true,
    })
    assert.match(
      html,
      /Builds Space <span class="mono">mason-e2e<\/span> \(sfo3\)/,
    )
    assert.match(html, /Also delete the Space and every build in it/)
    // The Space is a storage row new builds go to; the disk is a row to switch to.
    assert.match(
      html,
      /<tr data-location="space-mason-e2e-[^"]+"><td><span class="mono">mason-e2e<\/span> · sfo3 · made for host e2e<\/td><td>[^<]*<span class="icon"[^>]*>[^<]*<\/span> New builds go here<\/td>/,
    )
    assert.match(
      html,
      /<tr data-location="disk"><td>Host’s disk<\/td><td><form data-mason="api" data-path="\/api\/v2\/storage\/disk"[\s\S]*?Use for new builds/,
    )
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
      /<tr data-location="disk"><td>Host’s disk<\/td><td><span class="icon"[^>]*>[^<]*<\/span> New builds go here<\/td>/,
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

  it('U6.7 remove keeps the Space and its key as a storage location by default; asked, it empties and deletes a Space it made', async () => {
    const key = row('e2e').space_key_id!
    spaces.buckets.get('mason-e2e')!.set('builds/one.ipa', Buffer.from('one'))
    assert.equal(
      (await c.api('DELETE', '/api/v2/cloud/hosts/e2e', { confirm: 'e2e' }))
        .status,
      200,
    )
    assert(spaces.buckets.has('mason-e2e'), 'the Space and its builds stay')
    assert(spaces.keys.has(key), 'the key stays, so the Space stays usable')
    // New builds still go there, and the Space is a storage location of its own.
    assert.equal(storage().s3.bucket, 'mason-e2e')
    const kept = c.master
      .master!.storageLocations.list()
      .find((location) => location.bucket === 'mason-e2e')!
    assert.equal(kept.host, undefined)
    assert.equal(kept.bucketOwned, true)
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
    const buckets = c.master
      .master!.storageLocations.list()
      .map((location) => location.bucket)
    assert(buckets.includes('mason-e2e'), 'the kept Space stays a location')
    assert(!buckets.includes('mason-fresh'), 'the deleted Space is gone')
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

  it('U4.1/U4.5 makeSpace makes or adopts the bucket, reuses a working key, replaces keys of its name unless told not to, and waits for a new key to work', async () => {
    const hostSpace = c.master.master!.hostSpace
    spaces.newKeyRefusals = 2
    const first = await hostSpace.makeSpace(cloud, {
      bucket: 'mason-direct',
      region: 'sfo3',
      keyName: 'direct-key',
    })
    spaces.newKeyRefusals = 0
    assert.equal(first.made, true)
    assert.equal(first.keyMade, true)
    assert.equal(first.keyId, first.accessKeyId)
    assert.deepEqual(spaces.keys.get(first.keyId)!.grants, ['mason-direct'])
    const reused = await hostSpace.makeSpace(cloud, {
      bucket: 'mason-direct',
      region: 'sfo3',
      keyName: 'direct-key',
      key: { accessKeyId: first.accessKeyId, secretAccessKey: first.secret },
    })
    assert.equal(reused.made, false)
    assert.equal(reused.keyMade, false)
    assert.equal(reused.keyId, first.keyId)
    // Without deleteOld, the earlier key of the name stays.
    const beside = await hostSpace.makeSpace(cloud, {
      bucket: 'mason-direct',
      region: 'sfo3',
      keyName: 'direct-key',
      deleteOld: false,
    })
    assert.equal(beside.made, false)
    assert(spaces.keys.has(first.keyId))
    const replaced = await hostSpace.makeSpace(cloud, {
      bucket: 'mason-direct',
      region: 'sfo3',
      keyName: 'direct-key',
    })
    assert(!spaces.keys.has(first.keyId))
    assert(!spaces.keys.has(beside.keyId))
    assert(spaces.keys.has(replaced.keyId))
    spaces.taken.add('someone-elses')
    await assert.rejects(
      hostSpace.makeSpace(cloud, {
        bucket: 'someone-elses',
        region: 'sfo3',
        keyName: 'direct-key',
      }),
      /taken/,
    )
    // A key that never starts to work is the error, and is deleted: only the
    // bucket's own key is refused, so the bucket's setup key works.
    const create = cloud.createSpacesKey.bind(cloud)
    cloud.createSpacesKey = async (name, grants): ReturnType<typeof create> => {
      spaces.newKeyRefusals = name === 'never-works' ? 50 : 0
      return await create(name, grants)
    }
    try {
      await assert.rejects(
        hostSpace.makeSpace(cloud, {
          bucket: 'mason-direct',
          region: 'sfo3',
          keyName: 'never-works',
        }),
        /AccessDenied|InvalidAccessKeyId|403/,
      )
    } finally {
      cloud.createSpacesKey = create
    }
    spaces.newKeyRefusals = 0
    assert(
      ![...spaces.keys.values()].some((key) => key.name === 'never-works'),
      'a key that never worked is deleted',
    )
    assert(cloud.spacesCalls.includes('create never-works'))
    assert(cloud.spacesCalls.includes('delete never-works'))
  })

  it('U4.3 Make a new Space saves storage with its own key and the account that made it; the secret stays write-only', async () => {
    const before = storage()
    assert.match(
      (
        await c.api('POST', '/api/v2/storage/space/new', {
          account: 'none',
          bucket: 'mason-store',
          region: 'sfo3',
        })
      ).json.error,
      /none is not a DigitalOcean account/,
    )
    assert.match(
      (
        await c.api('POST', '/api/v2/storage/space/new', {
          account: 'do',
          bucket: 'mason-store',
          region: 'zzz9',
        })
      ).json.error,
      /^zzz9 has no Spaces; choose one of sfo3, nyc3/,
    )
    spaces.taken.add('popular-store')
    const taken = await c.api('POST', '/api/v2/storage/space/new', {
      account: 'do',
      bucket: 'popular-store',
      region: 'sfo3',
    })
    assert.equal(taken.status, 400)
    assert.match(taken.json.error, /^Nothing was saved: .*taken/)
    assert.deepEqual(storage(), before)
    const made = await c.api('POST', '/api/v2/storage/space/new', {
      account: 'do',
      bucket: 'mason-store',
      region: 'sfo3',
    })
    assert.equal(made.status, 200, made.text)
    assert.equal(made.json.driver, 's3')
    assert.deepEqual(made.json.s3.secretAccessKey, { set: true })
    assert.equal(made.json.managed.account, 'do')
    const keyId = storage().managed.keyId
    assert.equal(storage().s3.accessKeyId, keyId)
    assert.deepEqual(spaces.keys.get(keyId)!.grants, ['mason-store'])
    assert.equal(
      spaces.keys.get(keyId)!.name,
      `mason-storage-${c.master.master!.masterId}-mason-store`,
    )
    // The host never receives which account made it.
    const { hostProjection } = await import('../hostSettings.js')
    assert.equal(hostProjection('storage', storage()).managed, undefined)
  })

  it('U4.3b the Space and key storage used before stay, so earlier builds are still served; a failed Make a new Space leaves no key', async () => {
    const firstKey = storage().managed.keyId
    // Re-saving the same Space through Use an existing Space keeps it managed.
    const resaved = await c.api('POST', '/api/v2/storage/space', {
      url: 'https://mason-store.sfo3.digitaloceanspaces.com',
      accessKeyId: firstKey,
      secretAccessKey: { keep: true },
    })
    assert.equal(resaved.status, 200, resaved.text)
    assert.equal(storage().managed.keyId, firstKey)
    // A second new Space, then the disk: the first Space's key still works for its builds.
    await c.api('POST', '/api/v2/storage/space/new', {
      account: 'do',
      bucket: 'mason-store-two',
      region: 'sfo3',
    })
    const secondKey = storage().managed.keyId
    assert.notEqual(secondKey, firstKey)
    await c.api('POST', '/api/v2/storage/disk', {})
    assert.equal(storage().driver, 'disk')
    assert(spaces.keys.has(firstKey), 'the first Space keeps its key')
    assert(spaces.keys.has(secondKey), 'the second Space keeps its key')
    assert(spaces.buckets.has('mason-store'))
    // Back to the first Space: its key is reused, not replaced.
    await c.api('POST', '/api/v2/storage/space/new', {
      account: 'do',
      bucket: 'mason-store-two',
      region: 'sfo3',
    })
    // A save that fails after the key was made deletes that key.
    const keysBefore = [...spaces.keys.keys()]
    const set = c.master.master!.settings.set.bind(c.master.master!.settings)
    c.master.master!.settings.set = async (): Promise<never> => {
      throw new Error('The database is locked')
    }
    try {
      const failed = await c.api('POST', '/api/v2/storage/space/new', {
        account: 'do',
        bucket: 'mason-store-three',
        region: 'sfo3',
      })
      assert.equal(failed.status, 400)
      assert.equal(
        failed.json.error,
        'Nothing was saved: The database is locked',
      )
    } finally {
      c.master.master!.settings.set = set
    }
    assert.deepEqual([...spaces.keys.keys()].sort(), keysBefore.sort())
    await c.api('POST', '/api/v2/storage/disk', {})
  })

  it('U4.4 the Storage card makes a new Space from a DigitalOcean account, uses an existing one, or the disk', () => {
    const html = nodesView({
      nodes: [],
      types: {},
      pools: [],
      host: 'https://h',
      storage: { driver: 's3', bucket: 'b', endpoint: 'https://sfo3.example' },
      poolAccounts: [
        { id: 'do', name: 'DigitalOcean', provider: 'digitalocean' },
        { id: 'mac', name: 'NoMac', provider: 'nomac' },
      ],
      budget: { monthly: 1 },
      canChange: true,
    })
    const card = html.slice(html.indexOf('id="storage"'))
    assert.match(
      card,
      /<details class="action" id="storage-new"><summary class="button">.*Make a new Space<\/summary>/,
    )
    assert.match(
      card,
      /billed by use from \$5 a month for 250 GB, so there is no machine size to choose/,
    )
    assert.match(
      card,
      /data-path="\/api\/v2\/storage\/space\/new" data-fields="account,bucket,region,use"/,
    )
    assert.match(
      card,
      /<select id="new-space-account" name="account"><option value="do">DigitalOcean<\/option><\/select>/,
    )
    assert.match(
      card,
      /<details class="action" id="storage-existing"><summary class="button">.*Add an existing Space<\/summary>/,
    )
    assert.match(
      card,
      /<input id="new-space-use" name="use" type="checkbox" data-kind="checkbox" checked> Use it for new builds/,
    )
    assert.match(
      card,
      /<th>Location<\/th><th>New builds<\/th><th>Files<\/th><th>Size<\/th>/,
    )
  })

  it('U4.6 a key that fails after the bucket is made: the host still owns the Space, old keys keep working, and a failed new storage Space leaves nothing', async () => {
    const hostSpace = c.master.master!.hostSpace
    const create = cloud.createSpacesKey.bind(cloud)
    /** Refuses new keys whose name ends with `suffix`, once each or always. */
    const refuse = (suffix: string, times: number): void => {
      let left = times
      cloud.createSpacesKey = async (
        name,
        grants,
      ): ReturnType<typeof create> => {
        spaces.newKeyRefusals = name.endsWith(suffix) && left-- > 0 ? 50 : 0
        return await create(name, grants)
      }
    }
    try {
      // A host whose Space key never works at first still records owning the bucket it made.
      refuse('-owned', 1)
      const made = await c.api('POST', '/api/v2/cloud/hosts', {
        name: 'owned',
        account: 'do',
        region: 'sfo3',
        size: 's-1vcpu-1gb',
        space: { bucket: 'mason-owned', region: 'sfo3' },
      })
      assert.equal(made.status, 201, made.text)
      await c.until(
        () => (row('owned')?.space_owned === 1 ? true : undefined),
        30_000,
        'the bucket recorded as owned',
      )
      assert(spaces.buckets.has('mason-owned'))
      cloud.createSpacesKey = create
      spaces.newKeyRefusals = 0
      // The next reconcile makes the key and the host is ready.
      for (let i = 0; i < 20 && row('owned').state !== 'ready'; i++) {
        await reconcile('owned')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal(row('owned').state, 'ready')
      const removed = await c.api('DELETE', '/api/v2/cloud/hosts/owned', {
        confirm: 'owned',
        deleteSpace: 'delete',
      })
      assert.equal(removed.status, 200, removed.text)
      assert(
        !spaces.buckets.has('mason-owned'),
        'the owned Space is deleted with the host',
      )
      // A replacement key that never works leaves the old key working.
      const first = await hostSpace.makeSpace(cloud, {
        bucket: 'mason-keep',
        region: 'sfo3',
        keyName: 'keep-key',
      })
      refuse('keep-key', 1)
      await assert.rejects(
        hostSpace.makeSpace(cloud, {
          bucket: 'mason-keep',
          region: 'sfo3',
          keyName: 'keep-key',
        }),
      )
      assert(
        spaces.keys.has(first.keyId),
        'the old key survives a failed replacement',
      )
      assert.equal(
        [...spaces.keys.values()].filter((key) => key.name === 'keep-key')
          .length,
        1,
      )
      cloud.createSpacesKey = create
      spaces.newKeyRefusals = 0
      const second = await hostSpace.makeSpace(cloud, {
        bucket: 'mason-keep',
        region: 'sfo3',
        keyName: 'keep-key',
      })
      assert(!spaces.keys.has(first.keyId))
      assert(spaces.keys.has(second.keyId))
      // Make a new Space whose key never works: no bucket and no key are left.
      refuse('mason-gone', 1)
      const failed = await c.api('POST', '/api/v2/storage/space/new', {
        account: 'do',
        bucket: 'mason-gone',
        region: 'sfo3',
      })
      assert.equal(failed.status, 400)
      assert.match(failed.json.error, /^Nothing was saved: /)
      assert(
        !spaces.buckets.has('mason-gone'),
        'the bucket made for it is deleted',
      )
      assert(
        ![...spaces.keys.values()].some((key) =>
          key.name.endsWith('mason-gone'),
        ),
      )
      // An account with no stored key is refused by name.
      const provider = c.master.master!.cloudHosts.provider.bind(
        c.master.master!.cloudHosts,
      )
      c.master.master!.cloudHosts.provider = (): undefined => undefined
      try {
        assert.equal(
          (
            await c.api('POST', '/api/v2/storage/space/new', {
              account: 'do',
              bucket: 'mason-nokey',
              region: 'sfo3',
            })
          ).json.error,
          'do has no API key',
        )
      } finally {
        c.master.master!.cloudHosts.provider = provider
      }
    } finally {
      cloud.createSpacesKey = create
      spaces.newKeyRefusals = 0
    }
  })

  it('U2.2/U2.3 a Space made without using it is a location; deleting it empties and deletes the bucket and its key; nothing goes while the host cannot answer', async () => {
    const master = c.master.master!
    const before = storage()
    const made = await c.api('POST', '/api/v2/storage/space/new', {
      account: 'do',
      bucket: 'mason-spare',
      region: 'sfo3',
      use: false,
    })
    assert.equal(made.status, 200, made.text)
    assert.deepEqual(storage(), before, 'new builds still go where they did')
    const spare = master.storageLocations
      .list()
      .find((location) => location.bucket === 'mason-spare')!
    assert.equal(spare.origin, 'made')
    assert.equal(spare.bucketOwned, true)
    assert.equal(spare.active, false)
    const keyId = (
      master.database.db
        .prepare('SELECT key_id FROM storage_locations WHERE id=?')
        .get(spare.id) as { key_id: string }
    ).key_id
    assert(spaces.keys.has(keyId))
    spaces.buckets.get('mason-spare')!.set('builds/x.ipa', Buffer.from('x'))
    // A host that cannot answer: nothing is removed.
    const deps = {
      hostKeys: async (): Promise<string[]> => {
        throw new Error('the host is not connected')
      },
      hostForget: async (): Promise<void> => undefined,
      forgetFiles: (): void => undefined,
      provider: (): FakeCloud => cloud,
      destroyBucket: async (): Promise<void> => undefined,
      masterId: master.masterId,
    }
    await assert.rejects(
      master.storageLocations.remove(
        localOperator,
        spare.id,
        'mason-spare',
        deps,
      ),
      /Nothing was removed: the host did not answer \(the host is not connected\)/,
    )
    await assert.rejects(
      master.storageLocations.remove(localOperator, spare.id, 'mason-spare', {
        ...deps,
        hostKeys: async () => undefined,
        provider: () => undefined,
      }),
      /Nothing was removed: do has no API key/,
    )
    assert(spaces.buckets.has('mason-spare'))
    const removed = await c.api(
      'DELETE',
      `/api/v2/storage/locations/${encodeURIComponent(spare.id)}`,
      { confirm: 'mason-spare' },
    )
    assert.equal(removed.status, 200, removed.text)
    assert.deepEqual(removed.json, { files: 0, bucketDeleted: true })
    assert(!spaces.buckets.has('mason-spare'))
    assert(!spaces.keys.has(keyId))
    assert(
      !master.storageLocations
        .list()
        .some((location) => location.bucket === 'mason-spare'),
    )
  })
})
