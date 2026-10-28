import assert from 'node:assert/strict'
import { after, before, describe, it } from 'mocha'
import { FakeSpaces } from '../../test/fakeSpaces.js'
import { parseSpaceUrl, SpaceClient, SpaceError } from './spaces.js'

describe('DigitalOcean Spaces', () => {
  const spaces = new FakeSpaces()
  let full: { id: string; secret: string }
  let scoped: { id: string; secret: string }
  before(async () => {
    await spaces.start()
    full = {
      id: spaces.addKey({
        name: 'setup',
        secret: 'full-secret-1234',
        grants: 'all',
      }),
      secret: 'full-secret-1234',
    }
    scoped = {
      id: spaces.addKey({
        name: 'host',
        secret: 'scoped-secret-1234',
        grants: ['mason-e2e'],
      }),
      secret: 'scoped-secret-1234',
    }
  })
  after(async () => {
    await spaces.close()
  })
  const client = (key: { id: string; secret: string }): SpaceClient =>
    new SpaceClient(
      { endpoint: spaces.endpoint, region: 'sfo3' },
      { accessKeyId: key.id, secretAccessKey: key.secret },
      spaces.fetch,
    )

  it('U6.1 reads a Space from its URL, its region endpoint and path, or a bucket field', () => {
    const want = {
      endpoint: 'https://sfo3.digitaloceanspaces.com',
      bucket: 'mason-e2e',
      region: 'sfo3',
    }
    assert.deepEqual(
      parseSpaceUrl('https://mason-e2e.sfo3.digitaloceanspaces.com'),
      want,
    )
    assert.deepEqual(
      parseSpaceUrl(' https://sfo3.digitaloceanspaces.com/mason-e2e/ '),
      want,
    )
    assert.deepEqual(
      parseSpaceUrl('https://sfo3.digitaloceanspaces.com', 'mason-e2e'),
      want,
    )
    assert.throws(() => parseSpaceUrl(undefined), /The Space URL is required/)
    assert.throws(() => parseSpaceUrl('not a url'), /is not a URL/)
    assert.throws(
      () => parseSpaceUrl('http://mason-e2e.sfo3.digitaloceanspaces.com'),
      /A Space URL is https/,
    )
    assert.throws(
      () => parseSpaceUrl('https://example.com/bucket'),
      /A Space URL is https/,
    )
    assert.throws(
      () => parseSpaceUrl('https://sfo3.digitaloceanspaces.com'),
      /Name the Space/,
    )
  })

  it('U6.2 a check writes, reads and deletes; a wrong secret or a key without the bucket is refused', async () => {
    await client(full).create('mason-e2e')
    // A bucket this account owns already is fine.
    await client(full).create('mason-e2e')
    await client(scoped).check('mason-e2e')
    assert.deepEqual([...spaces.buckets.get('mason-e2e')!.keys()], [])
    await assert.rejects(
      client({ id: scoped.id, secret: 'wrong-secret-1234' }).check('mason-e2e'),
      (error: unknown) => error instanceof SpaceError && error.status === 403,
    )
    await assert.rejects(client(scoped).check('other'), /AccessDenied/)
    await assert.rejects(client(full).check('missing'), /NoSuchBucket/)
    await assert.rejects(
      client(scoped).create('mine'),
      /Could not make Space mine: AccessDenied/,
    )
    spaces.taken.add('popular')
    await assert.rejects(
      client(full).create('popular'),
      /The Space name popular is taken by another account/,
    )
  })

  it('stores, lists and deletes objects, and deletes a whole Space', async () => {
    const space = client(scoped)
    await space.put('mason-e2e', 'builds/one.ipa', Buffer.from('one'))
    await space.put('mason-e2e', 'builds/two.apk', Buffer.from('two'))
    assert.deepEqual(
      (await space.get('mason-e2e', 'builds/one.ipa')).toString(),
      'one',
    )
    assert.deepEqual((await space.keys('mason-e2e')).sort(), [
      'builds/one.ipa',
      'builds/two.apk',
    ])
    await assert.rejects(
      space.get('mason-e2e', 'missing'),
      /Reading missing: NoSuchKey/,
    )
    await assert.rejects(
      client(scoped).put('other', 'x', Buffer.from('x')),
      /Writing x: AccessDenied \(the key cannot use this Space\)/,
    )
    await space.delete('mason-e2e', 'builds/one.ipa')
    await client(full).destroy('mason-e2e')
    assert.equal(spaces.buckets.has('mason-e2e'), false)
    await client(full).destroy('mason-e2e')
    await assert.rejects(client(scoped).keys('other'), /Listing Space other/)
  })
})
