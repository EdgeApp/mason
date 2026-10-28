import { createHash, randomBytes } from 'node:crypto'
import { signV4 } from '../../host/storage.js'

/**
 * DigitalOcean Spaces for a host's builds. A Space is an S3 bucket; the host
 * stores objects in it through the `storage` settings area and streams them
 * to testers itself, so the bucket stays private.
 */

export interface SpaceLocation {
  /** The region endpoint, `https://<region>.digitaloceanspaces.com`. */
  endpoint: string
  bucket: string
  region: string
}

const bucketName = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const spacesHost =
  /^(?:([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\.)?([a-z0-9]+)\.digitaloceanspaces\.com$/

/**
 * A Space from its URL: `https://<bucket>.<region>.digitaloceanspaces.com`,
 * or the region endpoint with the bucket as its path or given apart.
 */
export function parseSpaceUrl(url: unknown, bucket?: unknown): SpaceLocation {
  if (typeof url !== 'string') throw new Error('The Space URL is required')
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new Error(`${url} is not a URL`)
  }
  const match = spacesHost.exec(parsed.hostname)
  if (parsed.protocol !== 'https:' || match == null)
    throw new Error(
      'A Space URL is https://<name>.<region>.digitaloceanspaces.com',
    )
  const region = match[2]!
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '')
  const name =
    match[1] ??
    (path !== '' ? path : typeof bucket === 'string' ? bucket.trim() : '')
  if (!bucketName.test(name))
    throw new Error(
      'Name the Space: its URL or the bucket field holds no Space name',
    )
  return {
    endpoint: `https://${region}.digitaloceanspaces.com`,
    bucket: name,
    region,
  }
}

export interface SpaceCredentials {
  accessKeyId: string
  secretAccessKey: string
}

/** An S3 error: its HTTP status and S3 code. */
export class SpaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The bucket requests the master makes itself, signed with Signature V4. */
export class SpaceClient {
  constructor(
    private readonly location: Pick<SpaceLocation, 'endpoint' | 'region'>,
    private readonly credentials: SpaceCredentials,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async send(
    method: string,
    path: string,
    body?: Buffer,
    query = '',
  ): Promise<Response> {
    const url = new URL(`${this.location.endpoint}/${path}${query}`)
    const payload = body ?? Buffer.alloc(0)
    const payloadHash = createHash('sha256').update(payload).digest('hex')
    const headers = signV4(
      { method, url, headers: {}, payloadHash },
      {
        accessKeyId: this.credentials.accessKeyId,
        secretAccessKey: this.credentials.secretAccessKey,
        region: this.location.region,
        service: 's3',
      },
      this.now(),
    )
    return await this.fetcher(url, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' || method === 'DELETE'
        ? {}
        : { body: new Uint8Array(payload) }),
      signal: AbortSignal.timeout(30_000),
    })
  }

  private async fail(response: Response, what: string): Promise<never> {
    const text = await response.text()
    const code =
      /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? String(response.status)
    throw new SpaceError(
      response.status,
      code,
      `${what}: ${code}${response.status === 403 ? ' (the key cannot use this Space)' : ''}`,
    )
  }

  /** Whether the bucket exists for these credentials. */
  async exists(bucket: string): Promise<boolean> {
    const response = await this.send('HEAD', bucket)
    if (response.ok) return true
    if (response.status === 404) return false
    throw new SpaceError(
      response.status,
      response.status === 403 ? 'AccessDenied' : String(response.status),
      `Space ${bucket}: ${response.status === 403 ? 'AccessDenied (the key cannot use this Space)' : response.status}`,
    )
  }

  /** Makes a private bucket; one this account already owns is fine. */
  async create(bucket: string): Promise<void> {
    const response = await this.send('PUT', bucket)
    if (response.ok) return
    const text = await response.text()
    if (/<Code>BucketAlreadyOwnedByYou<\/Code>/.test(text)) return
    const code =
      /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? String(response.status)
    throw new SpaceError(
      response.status,
      code,
      code === 'BucketAlreadyExists'
        ? `The Space name ${bucket} is taken by another account; choose another`
        : `Could not make Space ${bucket}: ${code}`,
    )
  }

  async put(bucket: string, key: string, body: Buffer): Promise<void> {
    const response = await this.send('PUT', `${bucket}/${key}`, body)
    if (!response.ok) await this.fail(response, `Writing ${key}`)
  }
  async get(bucket: string, key: string): Promise<Buffer> {
    const response = await this.send('GET', `${bucket}/${key}`)
    if (!response.ok) await this.fail(response, `Reading ${key}`)
    return Buffer.from(await response.arrayBuffer())
  }
  async delete(bucket: string, key: string): Promise<void> {
    const response = await this.send('DELETE', `${bucket}/${key}`)
    if (!response.ok && response.status !== 404)
      await this.fail(response, `Deleting ${key}`)
  }
  /** Every key in the bucket. */
  async keys(bucket: string): Promise<string[]> {
    const out: string[] = []
    let token: string | undefined
    for (;;) {
      const response = await this.send(
        'GET',
        bucket,
        undefined,
        `?list-type=2${token == null ? '' : `&continuation-token=${encodeURIComponent(token)}`}`,
      )
      if (!response.ok) await this.fail(response, `Listing Space ${bucket}`)
      const text = await response.text()
      for (const match of text.matchAll(/<Key>([^<]+)<\/Key>/g))
        out.push(match[1]!)
      token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(
        text,
      )?.[1]
      if (token == null) return out
    }
  }
  /** Deletes every object, then the bucket; a bucket already gone is fine. */
  async destroy(bucket: string): Promise<void> {
    if (!(await this.exists(bucket))) return
    for (const key of await this.keys(bucket)) await this.delete(bucket, key)
    const response = await this.send('DELETE', bucket)
    if (!response.ok && response.status !== 404)
      await this.fail(response, `Deleting Space ${bucket}`)
  }

  /** Puts, reads and deletes a check object: the key can use the Space as storage. */
  async check(bucket: string): Promise<void> {
    if (!(await this.exists(bucket)))
      throw new SpaceError(404, 'NoSuchBucket', `Space ${bucket}: NoSuchBucket`)
    const key = `mason-check/${randomBytes(8).toString('hex')}`
    const body = Buffer.from(`Mason storage check ${key}`)
    await this.put(bucket, key, body)
    try {
      if (!(await this.get(bucket, key)).equals(body))
        throw new SpaceError(
          500,
          'Mismatch',
          'The Space returned other bytes than were written',
        )
    } finally {
      await this.delete(bucket, key)
    }
  }
}
