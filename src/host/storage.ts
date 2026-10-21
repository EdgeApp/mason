import { createHash, createHmac, randomBytes } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/** Metadata about one stored object. */
export interface StoredObject {
  size: number
}

/** A place the host keeps artifacts: local disk or S3-compatible storage. */
export interface StorageDriver {
  readonly kind: 'disk' | 's3'
  /** Stores a local file under key (overwrites). */
  put(key: string, file: string): Promise<void>
  /**
   * Reads an object, or a byte range [start, end] inclusive; undefined when it
   * does not exist. size is always the whole object's size, so a caller can
   * build a Content-Range header; an end past the object is clamped.
   */
  get(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{ stream: Readable; size: number } | undefined>
  head(key: string): Promise<StoredObject | undefined>
  /** Deletes an object; deleting a missing one is not an error. */
  delete(key: string): Promise<void>
}

/** Connection settings for S3-compatible object storage. */
export interface S3Options {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Path-style URLs (endpoint/bucket/key) instead of virtual-hosted (bucket.host/key); default false. */
  pathStyle?: boolean
  /** Tests only: allow an http:// endpoint. */
  allowInsecure?: boolean
}

const keyPattern = /^[A-Za-z0-9._/-]{1,512}$/

/** Checks an object key and returns it unchanged; throws when it is unsafe. */
export function validateKey(key: string): string {
  if (typeof key !== 'string' || !keyPattern.test(key)) {
    throw new Error('Invalid storage key')
  }
  // '.' is refused alongside '..' because both resolve differently on disk
  // than in an object store.
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error('Invalid storage key')
    }
  }
  return key
}

function checkRange(range: { start: number; end: number }): void {
  const { start, end } = range
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw new Error('Invalid byte range')
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : undefined
}

/** Stores objects as files under a private root directory. */
export class DiskStorage implements StorageDriver {
  readonly kind = 'disk'
  private readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  async put(key: string, file: string): Promise<void> {
    const segments = validateKey(key).split('/')
    const name = segments.pop() as string
    let dir = this.root
    for (const segment of segments) {
      dir = path.join(dir, segment)
      try {
        await mkdir(dir, { mode: 0o700 })
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
      // mkdir succeeds or reports EEXIST for a planted symlink alike, so the
      // component is checked without following it.
      if (!(await lstat(dir)).isDirectory()) {
        throw new Error(`Storage key ${key} crosses a non-directory`)
      }
    }
    const temporary = path.join(
      dir,
      `.${name}.${randomBytes(8).toString('hex')}.tmp`,
    )
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      )
      await pipeline(createReadStream(file), handle.createWriteStream())
      // rename replaces a symlink at the target rather than writing through it.
      await rename(temporary, path.join(dir, name))
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  async get(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{ stream: Readable; size: number } | undefined> {
    if (range != null) checkRange(range)
    const target = await this.locate(key)
    if (target == null) return undefined
    let handle
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      return this.missing(key, error)
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error(`Storage key ${key} is not a file`)
      let options: { start: number; end: number } | undefined
      if (range != null) {
        if (range.start >= info.size) {
          throw new Error(`Range not satisfiable for storage key ${key}`)
        }
        options = {
          start: range.start,
          end: Math.min(range.end, info.size - 1),
        }
      }
      return { stream: handle.createReadStream(options), size: info.size }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async head(key: string): Promise<StoredObject | undefined> {
    const target = await this.locate(key)
    if (target == null) return undefined
    let info
    try {
      info = await lstat(target)
    } catch (error) {
      return this.missing(key, error)
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to follow a symlink for storage key ${key}`)
    }
    if (!info.isFile()) throw new Error(`Storage key ${key} is not a file`)
    return { size: info.size }
  }

  async delete(key: string): Promise<void> {
    const target = await this.locate(key)
    if (target == null) return
    try {
      // unlink removes a symlink itself, never what it points at.
      await unlink(target)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }

  /**
   * Resolves a key to its file path after checking every directory component
   * without following symlinks; undefined when a component does not exist.
   */
  private async locate(key: string): Promise<string | undefined> {
    const segments = validateKey(key).split('/')
    let current = this.root
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment)
      let info
      try {
        info = await lstat(current)
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined
        throw error
      }
      if (info.isSymbolicLink()) {
        throw new Error(`Refusing to follow a symlink for storage key ${key}`)
      }
      // A file where a directory belongs means the key cannot exist.
      if (!info.isDirectory()) return undefined
    }
    return path.join(current, segments[segments.length - 1] as string)
  }

  private missing(key: string, error: unknown): undefined {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new Error(`Refusing to follow a symlink for storage key ${key}`)
    }
    throw error
  }
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

/** URI-encodes per SigV4: RFC 3986 unreserved characters stay literal. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c: string): string => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function canonicalUri(url: URL): string {
  if (url.pathname === '' || url.pathname === '/') return '/'
  // The URL may carry WHATWG percent-encoding; normalise to SigV4's, once.
  return url.pathname
    .split('/')
    .map((segment: string): string => uriEncode(decodeURIComponent(segment)))
    .join('/')
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([name, value]): [string, string] => [
      uriEncode(name),
      uriEncode(value),
    ])
    .sort(([a, x], [b, y]): number =>
      a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
    )
    .map(([name, value]): string => `${name}=${value}`)
    .join('&')
}

/** AWS Signature V4 headers for one request (exported for the known-answer test). */
export function signV4(
  request: {
    method: string
    url: URL
    headers: Record<string, string>
    payloadHash: string
  },
  credentials: {
    accessKeyId: string
    secretAccessKey: string
    region: string
    service: string
  },
  now: Date,
): Record<string, string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const date = amzDate.slice(0, 8)
  const headers = new Map<string, string>()
  for (const [name, value] of Object.entries(request.headers)) {
    headers.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '))
  }
  headers.set('host', request.url.host)
  headers.set('x-amz-date', amzDate)
  headers.set('x-amz-content-sha256', request.payloadHash)
  const names = [...headers.keys()].sort()
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(request.url),
    canonicalQuery(request.url),
    names
      .map((name: string): string => `${name}:${headers.get(name)}\n`)
      .join(''),
    signedHeaders,
    request.payloadHash,
  ].join('\n')
  const scope = `${date}/${credentials.region}/${credentials.service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')
  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${credentials.secretAccessKey}`, date),
        credentials.region,
      ),
      credentials.service,
    ),
    'aws4_request',
  )
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex')
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': request.payloadHash,
  }
}

const emptyHash = sha256Hex('')

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/** Stores objects in an S3-compatible bucket (DigitalOcean Spaces, AWS S3). */
export class S3Storage implements StorageDriver {
  readonly kind = 's3'
  private readonly options: S3Options
  private readonly base: URL
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(
    options: S3Options,
    fetchImpl: typeof fetch = fetch,
    now: () => Date = (): Date => new Date(),
  ) {
    const base = new URL(options.endpoint)
    if (
      base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && options.allowInsecure === true)
    ) {
      throw new Error('S3 endpoint must use https')
    }
    if (
      base.pathname !== '/' ||
      base.search !== '' ||
      base.hash !== '' ||
      base.username !== '' ||
      base.password !== ''
    ) {
      throw new Error('S3 endpoint must be a bare origin')
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new Error('Invalid S3 bucket name')
    }
    this.options = options
    this.base = base
    this.fetchImpl = fetchImpl
    this.now = now
  }

  async put(key: string, file: string): Promise<void> {
    validateKey(key)
    // Hashing first lets the body stream with a signed payload hash instead
    // of UNSIGNED-PAYLOAD; a file changed in between fails the server's check.
    const payloadHash = await hashFile(file)
    const { size } = await stat(file)
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream
    const response = await this.send('PUT', key, {
      payloadHash,
      body,
      unsigned: { 'content-length': String(size) },
    })
    if (!response.ok) await this.fail('PUT', key, response)
    await response.body?.cancel()
  }

  async get(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{ stream: Readable; size: number } | undefined> {
    validateKey(key)
    if (range != null) checkRange(range)
    const response = await this.send('GET', key, {
      signed:
        range == null ? {} : { range: `bytes=${range.start}-${range.end}` },
    })
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    if (!response.ok) await this.fail('GET', key, response)
    let size: number
    if (range == null) {
      size = Number(response.headers.get('content-length'))
    } else {
      // A server that ignores Range would hand back the wrong bytes.
      const match = /^bytes \d+-\d+\/(\d+)$/.exec(
        response.status === 206
          ? (response.headers.get('content-range') ?? '')
          : '',
      )
      if (match == null) {
        await response.body?.cancel()
        throw new Error(`S3 GET ${key} did not honour the byte range`)
      }
      size = Number(match[1])
    }
    const stream =
      response.body == null
        ? Readable.from([])
        : Readable.fromWeb(response.body as WebReadableStream)
    return { stream, size }
  }

  async head(key: string): Promise<StoredObject | undefined> {
    validateKey(key)
    const response = await this.send('HEAD', key, {})
    if (response.status === 404) return undefined
    if (!response.ok) await this.fail('HEAD', key, response)
    return { size: Number(response.headers.get('content-length')) }
  }

  async delete(key: string): Promise<void> {
    validateKey(key)
    const response = await this.send('DELETE', key, {})
    if (!response.ok && response.status !== 404) {
      await this.fail('DELETE', key, response)
    }
    await response.body?.cancel()
  }

  private objectUrl(key: string): URL {
    const encoded = key.split('/').map(uriEncode).join('/')
    if (this.options.pathStyle === true) {
      return new URL(`${this.base.origin}/${this.options.bucket}/${encoded}`)
    }
    return new URL(
      `${this.base.protocol}//${this.options.bucket}.${this.base.host}/${encoded}`,
    )
  }

  private async send(
    method: string,
    key: string,
    extra: {
      payloadHash?: string
      body?: ReadableStream
      signed?: Record<string, string>
      unsigned?: Record<string, string>
    },
  ): Promise<Response> {
    const url = this.objectUrl(key)
    const signed = extra.signed ?? {}
    const auth = signV4(
      {
        method,
        url,
        headers: signed,
        payloadHash: extra.payloadHash ?? emptyHash,
      },
      {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
        region: this.options.region,
        service: 's3',
      },
      this.now(),
    )
    // Node's fetch streams a request body only in half-duplex mode, which the
    // global RequestInit type does not declare.
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers: { ...extra.unsigned, ...signed, ...auth },
      body: extra.body,
      duplex: extra.body == null ? undefined : 'half',
      // A redirect (wrong region, say) is reported, not followed with our
      // credentials.
      redirect: 'manual',
    }
    return await this.fetchImpl(url.toString(), init)
  }

  /**
   * Throws a sanitized error. S3 error bodies echo the access key ID, the
   * string to sign and the signature, so only the <Code> is ever kept.
   */
  private async fail(
    method: string,
    key: string,
    response: Response,
  ): Promise<never> {
    const text =
      method === 'HEAD' ? '' : await response.text().catch((): string => '')
    const code = /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(text)?.[1]
    throw new Error(
      `S3 ${method} ${key} failed: HTTP ${response.status}${code == null ? '' : ` ${code}`}`,
    )
  }
}
