import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { after, before, describe, it } from 'mocha'
import { FakeS3 } from '../test/fakeS3.js'
import {
  DiskStorage,
  S3Storage,
  signV4,
  validateKey,
  type StorageDriver,
} from './storage.js'

const bucket = 'mason-artifacts'
const region = 'nyc3'
const accessKeyId = 'AKIDMASONTESTKEY0001'
const secretAccessKey = 'mason/test/secret/0123456789abcdefABCDEF'

function scratch(prefix: string): string {
  return mkdtempSync(
    path.join(realpathSync(process.env.MASON_TEST_ROOT!), prefix),
  )
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const invalidKeys = [
  '../x',
  '/abs',
  'a//b',
  '',
  'a'.repeat(513),
  'a/../b',
  'a/',
  'sp ace',
]

/** The behaviour every driver must share, run once per driver. */
function driverBehaviour(
  name: string,
  setup: () => Promise<{ driver: StorageDriver; cleanup: () => Promise<void> }>,
): void {
  describe(name, function () {
    this.timeout(20000)
    let driver: StorageDriver
    let cleanup: () => Promise<void>
    let files: string
    let big: Buffer
    let bigFile: string

    before(async (): Promise<void> => {
      ;({ driver, cleanup } = await setup())
      files = scratch('storage-src-')
      big = randomBytes(3 * 1024 * 1024 + 123)
      bigFile = path.join(files, 'big.bin')
      writeFileSync(bigFile, big)
    })
    after(async (): Promise<void> => {
      await cleanup()
      rmSync(files, { recursive: true, force: true })
    })

    it('U12.10 round-trips a multi-chunk file', async (): Promise<void> => {
      await driver.put('apps/demo/1/app.ipa', bigFile)
      const result = await driver.get('apps/demo/1/app.ipa')
      assert.ok(result != null)
      assert.equal(result.size, big.length)
      assert.ok((await collect(result.stream)).equals(big))
    })

    it('U12.10 a ranged get returns exactly those bytes', async (): Promise<void> => {
      const start = 1024 * 1024 - 7
      const end = 2 * 1024 * 1024 + 11
      const result = await driver.get('apps/demo/1/app.ipa', { start, end })
      assert.ok(result != null)
      assert.equal(result.size, big.length)
      assert.ok(
        (await collect(result.stream)).equals(big.subarray(start, end + 1)),
      )
      const tail = await driver.get('apps/demo/1/app.ipa', {
        start: big.length - 3,
        end: big.length + 100,
      })
      assert.ok(tail != null)
      assert.ok(
        (await collect(tail.stream)).equals(big.subarray(big.length - 3)),
      )
    })

    it('U12.10 refuses an invalid or unsatisfiable range', async (): Promise<void> => {
      await assert.rejects(
        driver.get('apps/demo/1/app.ipa', { start: 5, end: 4 }),
      )
      await assert.rejects(
        driver.get('apps/demo/1/app.ipa', { start: -1, end: 4 }),
      )
      await assert.rejects(
        driver.get('apps/demo/1/app.ipa', {
          start: big.length,
          end: big.length + 5,
        }),
      )
    })

    it('U12.10 head reports the size', async (): Promise<void> => {
      assert.deepEqual(await driver.head('apps/demo/1/app.ipa'), {
        size: big.length,
      })
    })

    it('U12.10 a missing key reads as undefined', async (): Promise<void> => {
      assert.equal(await driver.get('apps/none/app.ipa'), undefined)
      assert.equal(
        await driver.get('apps/demo/1/none.ipa', { start: 0, end: 1 }),
        undefined,
      )
      assert.equal(await driver.head('apps/none/app.ipa'), undefined)
      assert.equal(await driver.head('apps/demo/1/none.ipa'), undefined)
    })

    it('U12.10 overwrites an existing object', async (): Promise<void> => {
      const small = path.join(files, 'small.txt')
      writeFileSync(small, 'first')
      await driver.put('notes/a.txt', small)
      writeFileSync(small, 'second version')
      await driver.put('notes/a.txt', small)
      const result = await driver.get('notes/a.txt')
      assert.ok(result != null)
      assert.equal((await collect(result.stream)).toString(), 'second version')
      assert.deepEqual(await driver.head('notes/a.txt'), { size: 14 })
    })

    it('U12.10 stores an empty file', async (): Promise<void> => {
      const empty = path.join(files, 'empty')
      writeFileSync(empty, '')
      await driver.put('empty', empty)
      assert.deepEqual(await driver.head('empty'), { size: 0 })
      const result = await driver.get('empty')
      assert.ok(result != null)
      assert.equal((await collect(result.stream)).length, 0)
    })

    it('U12.10 delete makes the object missing', async (): Promise<void> => {
      await driver.delete('notes/a.txt')
      assert.equal(await driver.get('notes/a.txt'), undefined)
      assert.equal(await driver.head('notes/a.txt'), undefined)
    })

    it('U12.10 deleting a missing key is not an error', async (): Promise<void> => {
      await driver.delete('notes/a.txt')
      await driver.delete('never/existed/at/all')
    })

    it('U12.10 rejects invalid keys', async (): Promise<void> => {
      for (const key of invalidKeys) {
        await assert.rejects(
          driver.put(key, bigFile),
          /Invalid storage key/,
          key,
        )
        await assert.rejects(driver.get(key), /Invalid storage key/, key)
        await assert.rejects(driver.head(key), /Invalid storage key/, key)
        await assert.rejects(driver.delete(key), /Invalid storage key/, key)
      }
    })
  })
}

describe('Artifact storage', function () {
  this.timeout(20000)

  it('U12.10 validateKey accepts safe keys and refuses unsafe ones', (): void => {
    assert.equal(validateKey('a/b.c-d_e/F9'), 'a/b.c-d_e/F9')
    assert.equal(validateKey('x'.repeat(512)), 'x'.repeat(512))
    for (const key of [...invalidKeys, '.', 'a/./b', 'a\\b', 'é']) {
      assert.throws((): string => validateKey(key), /Invalid storage key/, key)
    }
  })

  driverBehaviour('DiskStorage', async () => {
    const root = scratch('storage-')
    return {
      driver: new DiskStorage(root),
      cleanup: async (): Promise<void> => {
        rmSync(root, { recursive: true, force: true })
      },
    }
  })

  let sharedFake: FakeS3
  driverBehaviour('S3Storage', async () => {
    sharedFake = new FakeS3({ bucket, region, accessKeyId, secretAccessKey })
    await sharedFake.start()
    return {
      driver: new S3Storage({
        endpoint: sharedFake.endpoint,
        bucket,
        region,
        accessKeyId,
        secretAccessKey,
        pathStyle: true,
        allowInsecure: true,
      }),
      cleanup: async (): Promise<void> => {
        // Every request the shared suite made carried a real payload hash.
        assert.ok(
          sharedFake.requests.every(
            (r): boolean =>
              r.headers['x-amz-content-sha256'] !== 'UNSIGNED-PAYLOAD',
          ),
        )
        await sharedFake.close()
      },
    }
  })

  describe('DiskStorage only', (): void => {
    let root: string
    let outside: string
    let disk: DiskStorage

    before((): void => {
      root = scratch('storage-')
      outside = scratch('storage-outside-')
      writeFileSync(path.join(outside, 'secret'), 'outside content')
      symlinkSync(outside, path.join(root, 'linkdir'))
      symlinkSync(path.join(outside, 'secret'), path.join(root, 'linkfile'))
      disk = new DiskStorage(root)
    })
    after((): void => {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    })

    it('U12.10 never follows a symlink out of the root', async (): Promise<void> => {
      const source = path.join(outside, 'planted-source')
      writeFileSync(source, 'planted')
      try {
        // Reads through a symlinked directory or a symlinked file fail.
        await assert.rejects(disk.get('linkdir/secret'), /symlink/)
        await assert.rejects(disk.head('linkdir/secret'), /symlink/)
        await assert.rejects(disk.get('linkfile'), /symlink/)
        await assert.rejects(
          disk.get('linkfile', { start: 0, end: 3 }),
          /symlink/,
        )
        await assert.rejects(disk.head('linkfile'), /symlink/)
        await assert.rejects(disk.delete('linkdir/secret'), /symlink/)
        // Writing through a symlinked directory fails.
        await assert.rejects(
          disk.put('linkdir/secret', source),
          /non-directory/,
        )
        await assert.rejects(disk.put('linkdir/new', source), /non-directory/)
        // Writing a key that is a symlink replaces the link, not its target.
        await disk.put('linkfile', source)
        assert.equal(
          readFileSync(path.join(outside, 'secret'), 'utf8'),
          'outside content',
        )
        const result = await disk.get('linkfile')
        assert.ok(result != null)
        assert.equal((await collect(result.stream)).toString(), 'planted')
        // Deleting a planted symlink removes the link only.
        symlinkSync(path.join(outside, 'secret'), path.join(root, 'linkfile2'))
        await disk.delete('linkfile2')
        assert.equal(
          readFileSync(path.join(outside, 'secret'), 'utf8'),
          'outside content',
        )
      } finally {
        rmSync(source, { force: true })
      }
    })

    it('U12.10 writes private files and directories atomically', async (): Promise<void> => {
      const source = path.join(outside, 'payload')
      writeFileSync(source, 'payload')
      await disk.put('deep/er/obj.bin', source)
      assert.equal(statSync(path.join(root, 'deep')).mode & 0o777, 0o700)
      assert.equal(statSync(path.join(root, 'deep/er')).mode & 0o777, 0o700)
      assert.equal(
        statSync(path.join(root, 'deep/er/obj.bin')).mode & 0o777,
        0o600,
      )
      // A failed write (missing source) leaves neither the object nor a temp file.
      await assert.rejects(
        disk.put('deep/er/missing.bin', path.join(outside, 'nope')),
      )
      assert.equal(await disk.head('deep/er/missing.bin'), undefined)
      assert.deepEqual(readdirSync(path.join(root, 'deep/er')), ['obj.bin'])
    })

    it('U12.10 a file where a directory belongs reads as missing', async (): Promise<void> => {
      const source = path.join(outside, 'payload')
      await disk.put('plain', source)
      assert.equal(await disk.get('plain/child'), undefined)
      assert.equal(await disk.head('plain/child'), undefined)
      await disk.delete('plain/child')
      await assert.rejects(disk.put('plain/child', source), /non-directory/)
      mkdirSync(path.join(root, 'adir'))
      await assert.rejects(disk.get('adir'), /not a file/)
      await assert.rejects(disk.head('adir'), /not a file/)
    })
  })

  describe('S3Storage only', (): void => {
    let fake: FakeS3
    let files: string
    let small: string

    before(async (): Promise<void> => {
      fake = new FakeS3({ bucket, region, accessKeyId, secretAccessKey })
      await fake.start()
      files = scratch('storage-s3-')
      small = path.join(files, 'small.txt')
      writeFileSync(small, 'hello')
    })
    after(async (): Promise<void> => {
      await fake.close()
      rmSync(files, { recursive: true, force: true })
    })

    function client(
      overrides: Partial<ConstructorParameters<typeof S3Storage>[0]> = {},
    ): S3Storage {
      return new S3Storage({
        endpoint: fake.endpoint,
        bucket,
        region,
        accessKeyId,
        secretAccessKey,
        pathStyle: true,
        allowInsecure: true,
        ...overrides,
      })
    }

    it('U12.10 signV4 reproduces the AWS GET Object example', (): void => {
      // AWS docs, "Signature Calculations for the Authorization Header:
      // Transferring Payload in a Single Chunk", GET Object example.
      const headers = signV4(
        {
          method: 'GET',
          url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
          headers: { Range: 'bytes=0-9' },
          payloadHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
        {
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          region: 'us-east-1',
          service: 's3',
        },
        new Date('2013-05-24T00:00:00Z'),
      )
      assert.equal(
        headers.Authorization,
        'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
      )
      assert.equal(headers['x-amz-date'], '20130524T000000Z')
      assert.equal(
        headers['x-amz-content-sha256'],
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      )
    })

    it('U12.10 signV4 canonicalises the query string and encoded path', (): void => {
      const sign = (url: string): string =>
        signV4(
          { method: 'get', url: new URL(url), headers: {}, payloadHash: 'x' },
          {
            accessKeyId: 'a',
            secretAccessKey: 's',
            region: 'r',
            service: 's3',
          },
          new Date(0),
        ).Authorization!
      // Parameter order does not change the signature; values do.
      assert.equal(
        sign('https://h/k?b=2&a=1&a=0'),
        sign('https://h/k?a=0&a=1&b=2'),
      )
      assert.notEqual(sign('https://h/k?a=1'), sign('https://h/k?a=2'))
      assert.equal(sign('https://h/a%20b'), sign('https://h/a b'))
      assert.equal(sign('https://h'), sign('https://h/'))
    })

    it('U12.10 a wrong secret fails with a 403 that leaks no credentials', async (): Promise<void> => {
      const wrongSecret = 'not-the-secret-0123456789'
      const bad = client({ secretAccessKey: wrongSecret })
      const failures: Error[] = []
      for (const attempt of [
        (): Promise<unknown> => bad.put('leak/check.txt', small),
        (): Promise<unknown> => bad.get('leak/check.txt'),
        (): Promise<unknown> => bad.head('leak/check.txt'),
        (): Promise<unknown> => bad.delete('leak/check.txt'),
      ]) {
        await assert.rejects(attempt(), (error: Error): boolean => {
          failures.push(error)
          return true
        })
      }
      assert.equal(fake.objects.size, 0)
      for (const error of failures) {
        assert.match(
          error.message,
          /^S3 (PUT|GET|HEAD|DELETE) leak\/check\.txt failed: HTTP 403/,
        )
        const text = `${error.message}\n${error.stack ?? ''}`
        assert.ok(!text.includes(accessKeyId))
        assert.ok(!text.includes(wrongSecret))
        assert.ok(!text.includes(secretAccessKey))
        assert.ok(!text.includes('Signature='))
        assert.ok(!/[0-9a-f]{64}/.test(text))
      }
      // The fake does echo the key id, like S3, so the client dropped it.
      assert.match(failures[0]!.message, /SignatureDoesNotMatch/)
    })

    it('U12.10 refuses an http endpoint without allowInsecure', (): void => {
      assert.throws(
        (): S3Storage => client({ allowInsecure: false }),
        /must use https/,
      )
      assert.throws(
        (): S3Storage =>
          client({ endpoint: 'ftp://example.com', allowInsecure: true }),
        /must use https/,
      )
      assert.throws(
        (): S3Storage => client({ endpoint: 'https://example.com/prefix' }),
        /bare origin/,
      )
      assert.throws((): S3Storage => client({ bucket: 'Bad_Bucket' }), /bucket/)
    })

    it('U12.10 builds virtual-hosted and path-style URLs', async (): Promise<void> => {
      const seen: Array<{ url: string; headers: Headers }> = []
      const recorder = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) })
        return new Response(null, { status: 200 })
      }
      const options = {
        endpoint: 'https://nyc3.digitaloceanspaces.com',
        bucket: 'bucket',
        region: 'nyc3',
        accessKeyId,
        secretAccessKey,
      }
      await new S3Storage(options, recorder).delete('key')
      await new S3Storage({ ...options, pathStyle: true }, recorder).delete(
        'dir/key.bin',
      )
      assert.equal(
        seen[0]!.url,
        'https://bucket.nyc3.digitaloceanspaces.com/key',
      )
      assert.equal(
        seen[1]!.url,
        'https://nyc3.digitaloceanspaces.com/bucket/dir/key.bin',
      )
      assert.match(
        seen[0]!.headers.get('authorization')!,
        /\/nyc3\/s3\/aws4_request, /,
      )
    })

    it('U12.10 uses the injected clock for x-amz-date', async (): Promise<void> => {
      const fixed = new Date('2030-01-02T03:04:05Z')
      const storage = new S3Storage(
        {
          endpoint: fake.endpoint,
          bucket,
          region,
          accessKeyId,
          secretAccessKey,
          pathStyle: true,
          allowInsecure: true,
        },
        fetch,
        (): Date => fixed,
      )
      await storage.put('clock.txt', small)
      assert.equal(
        fake.requests.at(-1)!.headers['x-amz-date'],
        '20300102T030405Z',
      )
      assert.equal(
        fake.requests.at(-1)!.headers['x-amz-content-sha256'],
        createHash('sha256').update('hello').digest('hex'),
      )
      assert.equal(fake.objects.get('clock.txt')!.toString(), 'hello')
      // S3 and Spaces want a sized upload, not chunked transfer encoding.
      assert.equal(fake.requests.at(-1)!.headers['content-length'], '5')
      assert.equal(
        fake.requests.at(-1)!.headers['transfer-encoding'],
        undefined,
      )
    })

    it('U12.10 reports server errors by status and code only', async (): Promise<void> => {
      const respond =
        (response: () => Response) => async (): Promise<Response> =>
          response()
      const options = {
        endpoint: 'https://s3.example.com',
        bucket: 'bucket',
        region: 'us-east-1',
        accessKeyId,
        secretAccessKey,
      }
      const plain = new S3Storage(
        options,
        respond((): Response => new Response('oops', { status: 500 })),
      )
      await assert.rejects(plain.get('k'), {
        message: 'S3 GET k failed: HTTP 500',
      })
      await assert.rejects(plain.head('k'), {
        message: 'S3 HEAD k failed: HTTP 500',
      })
      await assert.rejects(plain.delete('k'), {
        message: 'S3 DELETE k failed: HTTP 500',
      })
      const coded = new S3Storage(
        options,
        respond(
          (): Response =>
            new Response(
              `<Error><Code>SlowDown</Code><Message>${accessKeyId}</Message></Error>`,
              {
                status: 503,
              },
            ),
        ),
      )
      await assert.rejects(coded.get('k'), {
        message: 'S3 GET k failed: HTTP 503 SlowDown',
      })
      // A server that ignores Range must not hand back the whole object.
      const ignoresRange = new S3Storage(
        options,
        respond((): Response => new Response('whole object', { status: 200 })),
      )
      await assert.rejects(
        ignoresRange.get('k', { start: 0, end: 1 }),
        /did not honour the byte range/,
      )
      // A body-less 200 still yields an empty stream.
      const empty = new S3Storage(
        options,
        respond(
          (): Response =>
            new Response(null, {
              status: 200,
              headers: { 'content-length': '0' },
            }),
        ),
      )
      const result = await empty.get('k')
      assert.ok(result != null)
      assert.equal((await collect(result.stream)).length, 0)
    })

    it('U12.10 the fake S3 rejects unsigned, mismatched and misrouted requests', async (): Promise<void> => {
      const send = async (
        method: string,
        target: string,
        options: {
          body?: string
          payloadHash?: string
          secret?: string
          key?: string
          headers?: Record<string, string>
        } = {},
      ): Promise<{ status: number; text: string }> => {
        const url = new URL(`${fake.endpoint}${target}`)
        const body = options.body ?? ''
        const auth = signV4(
          {
            method,
            url,
            headers: options.headers ?? {},
            payloadHash:
              options.payloadHash ??
              createHash('sha256').update(body).digest('hex'),
          },
          {
            accessKeyId: options.key ?? accessKeyId,
            secretAccessKey: options.secret ?? secretAccessKey,
            region,
            service: 's3',
          },
          new Date(),
        )
        const response = await fetch(url, {
          method,
          headers: { ...options.headers, ...auth },
          body: method === 'PUT' ? body : undefined,
        })
        return { status: response.status, text: await response.text() }
      }
      const unsigned = await fetch(`${fake.endpoint}/${bucket}/x`)
      assert.equal(unsigned.status, 403)
      assert.match(await unsigned.text(), /<Code>AccessDenied<\/Code>/)
      assert.match(
        (await send('GET', `/${bucket}/x`, { key: 'AKIDOTHER' })).text,
        /InvalidAccessKeyId/,
      )
      const mismatch = await send('PUT', `/${bucket}/x`, {
        body: 'abc',
        payloadHash: createHash('sha256').update('abd').digest('hex'),
      })
      assert.equal(mismatch.status, 400)
      assert.match(mismatch.text, /XAmzContentSHA256Mismatch/)
      assert.match(
        (
          await send('PUT', `/${bucket}/x`, {
            body: 'abc',
            payloadHash: 'UNSIGNED-PAYLOAD',
          })
        ).text,
        /XAmzContentSHA256Mismatch/,
      )
      assert.match((await send('GET', '/other-bucket/x')).text, /NoSuchBucket/)
      assert.match(
        (await send('GET', `/${bucket}/x`)).text,
        /<Code>NoSuchKey<\/Code>/,
      )
      assert.equal((await send('POST', `/${bucket}/x`)).status, 405)
      assert.equal(
        (await send('PUT', `/${bucket}/x`, { body: 'abc' })).status,
        200,
      )
      const open = await send('GET', `/${bucket}/x`, {
        headers: { range: 'bytes=1-' },
      })
      assert.equal(open.status, 206)
      assert.equal(open.text, 'bc')
      assert.equal(
        (
          await send('GET', `/${bucket}/x`, {
            headers: { range: 'bytes=9-10' },
          })
        ).status,
        416,
      )
      assert.equal(
        (await send('GET', `/${bucket}/x`, { headers: { range: 'items=0-1' } }))
          .status,
        416,
      )
    })
  })
})
