import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { signV4 } from '../host/storage.js'
import { createCertificate, publicKeyPin } from '../node/certificate.js'
import { pinnedAgent } from '../node/pinnedFetch.js'

/** A Spaces access key: its secret and the buckets it may use. */
export interface FakeSpacesKey {
  name: string
  secret: string
  /** Bucket names it may read and write, or every bucket. */
  grants: string[] | 'all'
}

const authPattern =
  /^AWS4-HMAC-SHA256 Credential=([^/,]+)\/(\d{8})\/([^/,]+)\/s3\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/

/**
 * DigitalOcean Spaces in one region, path-style on 127.0.0.1: several
 * buckets, access keys limited to some of them, and names another account
 * already holds. Every request's Signature V4 is checked.
 */
export class FakeSpaces {
  endpoint = ''
  readonly keys = new Map<string, FakeSpacesKey>()
  readonly buckets = new Map<string, Map<string, Buffer>>()
  /** Bucket names another account owns. */
  readonly taken = new Set<string>()
  /** Requests a new key is refused before it works, as DigitalOcean's are for a few seconds. */
  newKeyRefusals = 0
  private readonly refusals = new Map<string, number>()
  private server: Server | undefined

  constructor(readonly region = 'sfo3') {}

  /** Makes a key, as `POST /v2/spaces/keys` does; returns its id. */
  addKey(key: FakeSpacesKey): string {
    const id = 'DO' + randomBytes(9).toString('hex').toUpperCase()
    this.keys.set(id, key)
    if (this.newKeyRefusals > 0) this.refusals.set(id, this.newKeyRefusals)
    return id
  }

  /** A fetch that trusts this server's certificate, for clients under test. */
  fetch: typeof fetch = fetch

  async start(): Promise<void> {
    const certificate = createCertificate(['127.0.0.1'])
    const agent = pinnedAgent(publicKeyPin(certificate.cert))
    this.fetch = ((url: string | URL, init?: RequestInit) =>
      fetch(url, {
        ...init,
        // @ts-expect-error undici's dispatcher option
        dispatcher: agent,
      })) as typeof fetch
    const server = createServer(
      { cert: certificate.cert, key: certificate.key },
      (req, res): void => {
        void this.handle(req, res).catch((): void => {
          if (!res.headersSent) this.error(res, 500, 'InternalError')
        })
      },
    )
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', (): void => resolve()),
    )
    this.server = server
    this.endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    const server = this.server
    if (server == null) return
    this.server = undefined
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close((): void => resolve()))
  }

  private error(res: ServerResponse, status: number, code: string): void {
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code></Error>`
    res.writeHead(status, { 'content-type': 'application/xml' })
    res.end(body)
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? ''
    const target = req.url ?? '/'
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const authorization = String(req.headers.authorization ?? '')
    const match = authPattern.exec(authorization)
    const amzDate = String(req.headers['x-amz-date'] ?? '')
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '')
    const key = match == null ? undefined : this.keys.get(match[1]!)
    if (match == null || key == null) {
      this.error(res, 403, 'InvalidAccessKeyId')
      return
    }
    const refusals = this.refusals.get(match[1]!) ?? 0
    if (refusals > 0) {
      this.refusals.set(match[1]!, refusals - 1)
      this.error(res, 403, 'InvalidAccessKeyId')
      return
    }
    const when = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate)
    if (when == null || match[3] !== this.region) {
      this.error(res, 403, 'AuthorizationHeaderMalformed')
      return
    }
    const [, y, mo, d, h, mi, s] = when.map(Number) as number[]
    const expected = signV4(
      {
        method,
        url: new URL(target, `http://${String(req.headers.host)}`),
        headers: {},
        payloadHash,
      },
      {
        accessKeyId: match[1]!,
        secretAccessKey: key.secret,
        region: this.region,
        service: 's3',
      },
      new Date(Date.UTC(y!, mo! - 1, d, h, mi, s)),
    ).Authorization!
    if (
      Buffer.byteLength(expected) !== Buffer.byteLength(authorization) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(authorization))
    ) {
      this.error(res, 403, 'SignatureDoesNotMatch')
      return
    }
    if (createHash('sha256').update(body).digest('hex') !== payloadHash) {
      this.error(res, 400, 'XAmzContentSHA256Mismatch')
      return
    }
    const url = new URL(target, 'http://fake')
    const [bucket, ...rest] = url.pathname.slice(1).split('/')
    const object = rest.map(decodeURIComponent).join('/')
    const allowed = key.grants === 'all' || key.grants.includes(bucket!)
    const objects = this.buckets.get(bucket!)
    if (object === '') {
      if (method === 'PUT') {
        if (this.taken.has(bucket!))
          return this.error(res, 409, 'BucketAlreadyExists')
        if (key.grants !== 'all') return this.error(res, 403, 'AccessDenied')
        if (objects != null)
          return this.error(res, 409, 'BucketAlreadyOwnedByYou')
        this.buckets.set(bucket!, new Map())
        res.writeHead(200)
        res.end()
        return
      }
      if (!allowed) {
        res.writeHead(403)
        res.end()
        return
      }
      if (objects == null) {
        if (method === 'HEAD') {
          res.writeHead(404)
          res.end()
        } else this.error(res, 404, 'NoSuchBucket')
        return
      }
      if (method === 'HEAD') {
        res.writeHead(200)
        res.end()
      } else if (method === 'DELETE') {
        if (objects.size > 0) return this.error(res, 409, 'BucketNotEmpty')
        this.buckets.delete(bucket!)
        res.writeHead(204)
        res.end()
      } else if (method === 'GET') {
        const listed = [...objects.keys()]
          .map((name) => `<Contents><Key>${name}</Key></Contents>`)
          .join('')
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(`<ListBucketResult>${listed}</ListBucketResult>`)
      } else this.error(res, 405, 'MethodNotAllowed')
      return
    }
    if (!allowed) return this.error(res, 403, 'AccessDenied')
    if (objects == null) return this.error(res, 404, 'NoSuchBucket')
    if (method === 'PUT') {
      objects.set(object, body)
      res.writeHead(200)
      res.end()
    } else if (method === 'GET') {
      const found = objects.get(object)
      if (found == null) return this.error(res, 404, 'NoSuchKey')
      res.writeHead(200, { 'content-length': found.length })
      res.end(found)
    } else if (method === 'HEAD') {
      const found = objects.get(object)
      res.writeHead(found == null ? 404 : 200)
      res.end()
    } else if (method === 'DELETE') {
      objects.delete(object)
      res.writeHead(204)
      res.end()
    } else this.error(res, 405, 'MethodNotAllowed')
  }
}
