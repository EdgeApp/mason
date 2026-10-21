import { createHash, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { signV4 } from '../host/storage.js'

/** Credentials and bucket the fake S3 server accepts. */
export interface FakeS3Options {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/** One request the fake server received. */
export interface FakeS3Request {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
}

const authPattern =
  /^AWS4-HMAC-SHA256 Credential=([^/,]+)\/(\d{8})\/([^/,]+)\/s3\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/

function escapeXml(value: string): string {
  return value.replace(
    /[<>&'"]/g,
    (c: string): string => `&#${c.charCodeAt(0)};`,
  )
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value
}

function parseAmzDate(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value)
  if (match == null) return undefined
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[]
  return new Date(Date.UTC(y!, mo! - 1, d, h, mi, s))
}

/**
 * A path-style S3 server on 127.0.0.1 that verifies AWS Signature V4 and the
 * payload hash on every request and keeps objects in memory.
 */
export class FakeS3 {
  endpoint = ''
  readonly objects = new Map<string, Buffer>()
  readonly requests: FakeS3Request[] = []
  private readonly options: FakeS3Options
  private server: Server | undefined

  constructor(options: FakeS3Options) {
    this.options = options
  }

  async start(): Promise<void> {
    const server = createServer((req, res): void => {
      this.handle(req, res).catch((): void => {
        if (!res.headersSent) this.error(res, 500, 'InternalError')
        else res.destroy()
      })
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', (): void => resolve())
    })
    this.server = server
    this.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    const server = this.server
    if (server == null) return
    this.server = undefined
    server.closeAllConnections()
    await new Promise<void>((resolve): void => {
      server.close((): void => resolve())
    })
  }

  private error(
    res: ServerResponse,
    status: number,
    code: string,
    extra = '',
  ): void {
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${code}</Message>${extra}</Error>`
    res.writeHead(status, {
      'content-type': 'application/xml',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? ''
    const target = req.url ?? '/'
    this.requests.push({ method, path: target, headers: { ...req.headers } })
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)

    const authorization = headerValue(req.headers.authorization) ?? ''
    const match = authPattern.exec(authorization)
    const amzDate = headerValue(req.headers['x-amz-date']) ?? ''
    const payloadHash = headerValue(req.headers['x-amz-content-sha256']) ?? ''
    const when = parseAmzDate(amzDate)
    if (match == null || when == null) {
      this.error(res, 403, 'AccessDenied')
      return
    }
    const [, accessKeyId, date, region, signedList, signature] =
      match as unknown as string[]
    if (accessKeyId !== this.options.accessKeyId) {
      this.error(res, 403, 'InvalidAccessKeyId')
      return
    }
    const signedNames = signedList!.split(';')
    if (
      date !== amzDate.slice(0, 8) ||
      region !== this.options.region ||
      !['host', 'x-amz-content-sha256', 'x-amz-date'].every(
        (name: string): boolean => signedNames.includes(name),
      )
    ) {
      this.error(res, 403, 'AuthorizationHeaderMalformed')
      return
    }
    const host = headerValue(req.headers.host) ?? ''
    const headers: Record<string, string> = {}
    for (const name of signedNames) {
      if (
        name === 'host' ||
        name === 'x-amz-date' ||
        name === 'x-amz-content-sha256'
      ) {
        continue
      }
      headers[name] = headerValue(req.headers[name]) ?? ''
    }
    const expected = signV4(
      { method, url: new URL(target, `http://${host}`), headers, payloadHash },
      { ...this.options, service: 's3' },
      when,
    ).Authorization!
    const given = Buffer.from(authorization)
    const wanted = Buffer.from(expected)
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      // Real S3 echoes these back, which is why clients must not repeat its
      // error bodies.
      this.error(
        res,
        403,
        'SignatureDoesNotMatch',
        `<AWSAccessKeyId>${escapeXml(accessKeyId!)}</AWSAccessKeyId><SignatureProvided>${signature}</SignatureProvided>`,
      )
      return
    }
    if (createHash('sha256').update(body).digest('hex') !== payloadHash) {
      this.error(res, 400, 'XAmzContentSHA256Mismatch')
      return
    }

    const prefix = `/${this.options.bucket}/`
    const pathname = new URL(target, 'http://fake').pathname
    if (!pathname.startsWith(prefix) || pathname.length === prefix.length) {
      this.error(res, 404, 'NoSuchBucket')
      return
    }
    const key = decodeURIComponent(pathname.slice(prefix.length))
    const object = this.objects.get(key)

    switch (method) {
      case 'PUT':
        this.objects.set(key, body)
        res.writeHead(200, {
          etag: `"${createHash('md5').update(body).digest('hex')}"`,
        })
        res.end()
        return
      case 'DELETE':
        this.objects.delete(key)
        res.writeHead(204)
        res.end()
        return
      case 'HEAD':
        if (object == null) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'content-length': object.length })
        res.end()
        return
      case 'GET': {
        if (object == null) {
          this.error(res, 404, 'NoSuchKey')
          return
        }
        const range = headerValue(req.headers.range)
        if (range == null) {
          res.writeHead(200, { 'content-length': object.length })
          res.end(object)
          return
        }
        const parsed = /^bytes=(\d+)-(\d*)$/.exec(range)
        const start = Number(parsed?.[1])
        if (parsed == null || start >= object.length) {
          this.error(res, 416, 'InvalidRange')
          return
        }
        const end = Math.min(
          parsed[2] === '' ? object.length - 1 : Number(parsed[2]),
          object.length - 1,
        )
        res.writeHead(206, {
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${object.length}`,
        })
        res.end(object.subarray(start, end + 1))
        return
      }
      default:
        this.error(res, 405, 'MethodNotAllowed')
    }
  }
}
