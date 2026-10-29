import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { hostProjection } from './hostSettings.js'

describe('What the host receives of published settings', () => {
  it('U4.3c storage reaches the host without the account that made its key; other areas pass through', () => {
    const s3 = {
      endpoint: 'https://sfo3.digitaloceanspaces.com',
      bucket: 'b',
      region: 'sfo3',
      accessKeyId: 'KEY12345',
      secretAccessKey: 'secret-1234',
    }
    assert.deepEqual(
      hostProjection('storage', {
        driver: 's3',
        s3,
        managed: { account: 'do', keyId: 'KEY12345' },
      }),
      { driver: 's3', s3 },
    )
    assert.deepEqual(hostProjection('storage', { driver: 'disk' }), {
      driver: 'disk',
    })
    assert.deepEqual(hostProjection('host', { origin: 'https://h' }), {
      origin: 'https://h',
    })
  })
})
