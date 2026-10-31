import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { Request } from 'express'
import { privateDirectory } from '../config.js'
import type { Stream } from '../link/link.js'
import { controlSocketPath } from '../node/control.js'

/** Header carrying the forwarder's per-process secret on the API socket. */
const INTERNAL = 'x-mason-internal'
const ACCOUNT = 'x-mason-host-account'
const VERSION = 'x-mason-host-permission-version'
/** Paths the host forwards: the v1 job API and `/api/v2`. */
const FORWARDED = /^\/api\/(jobs|queue|v2)(\/|\?|$)/
/** Run actions a host session may make: request, cancel, restart and approve. */
const RUN_ACTIONS = [
  /^\/api\/jobs$/,
  /^\/api\/jobs\/[^/]+\/cancel$/,
  /^\/api\/v2\/runs$/,
  /^\/api\/v2\/runs\/[^/]+\/(cancel|restart|approve)$/,
]
const MAX_BODY = 512 * 1024
/** Where a request came from: its socket's address, without the IPv4-mapped prefix. */
export function clientAddress(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
}

/** The header that carries a forwarded request's client address; believed only on the API socket. */
export const FORWARDED_FOR = 'x-mason-forwarded-for'

/** A request the host forwards over its link. */
export interface ForwardRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** The path and query, under `/api/jobs`, `/api/queue` or `/api/v2`. */
  path: string
  authorization?: string
  contentType?: string
  /** The body, base64. */
  body?: string
  /** A host session's account and the permission version it was made under. */
  account?: { id: number; permissionVersion: number }
  /** The address the host's client connected from, for the master's audit. */
  address?: string
}

export function asForwardRequest(value: unknown): ForwardRequest {
  const input = (value ?? {}) as Record<string, unknown>
  const method = input.method
  if (
    method !== 'GET' &&
    method !== 'POST' &&
    method !== 'PUT' &&
    method !== 'DELETE'
  )
    throw new Error('Unsupported method')
  const target = input.path
  if (
    typeof target !== 'string' ||
    target.length > 2048 ||
    !FORWARDED.test(target) ||
    /\/\.\.?(\/|\?|$)|[\r\n\\#]/.test(target)
  )
    throw new Error('That path is not forwarded')
  const text = (field: string, max: number): string | undefined => {
    const out = input[field]
    if (out == null) return undefined
    if (typeof out !== 'string' || out.length > max || /[\r\n]/.test(out))
      throw new Error(`Invalid ${field}`)
    return out
  }
  const body = text('body', Math.ceil((MAX_BODY * 4) / 3) + 4)
  const account = input.account as
    | { id?: unknown; permissionVersion?: unknown }
    | undefined
  if (
    account != null &&
    (!Number.isSafeInteger(account.id) ||
      !Number.isSafeInteger(account.permissionVersion))
  )
    throw new Error('Invalid account')
  const authorization = text('authorization', 512)
  const contentType = text('contentType', 200)
  const address = text('address', 100)
  return {
    method,
    path: target,
    ...(authorization == null ? {} : { authorization }),
    ...(contentType == null ? {} : { contentType }),
    ...(body == null ? {} : { body }),
    ...(address == null ? {} : { address }),
    ...(account == null
      ? {}
      : {
          account: {
            id: Number(account.id),
            permissionVersion: Number(account.permissionVersion),
          },
        }),
  }
}

/** Run reads a host session may make: a run's logs and events, and the queue's events. */
const RUN_READS = [
  /^\/api\/v2\/runs\/[^/]+\/(logs|events)$/,
  /^\/api\/v2\/queue\/events$/,
]

/** Whether a host session may make this request: one of the four run actions. */
export function isRunAction(method: string, target: string): boolean {
  const pathname = target.split('?')[0]!
  return method === 'POST' && RUN_ACTIONS.some((rule) => rule.test(pathname))
}

/** Whether a host session may make this read, which needs no request proof. */
export function isRunRead(method: string, target: string): boolean {
  const pathname = target.split('?')[0]!
  return method === 'GET' && RUN_READS.some((rule) => rule.test(pathname))
}

/**
 * Serves the master's API on an owner-only Unix socket for requests the
 * host forwards, so they meet the same routes and checks as direct ones.
 * Only requests on that socket carrying this process's secret may assert a
 * host session's account.
 */
export class Forwarder {
  private readonly secret = randomBytes(32).toString('base64url')
  private server: http.Server | undefined
  private socketPath = ''

  async listen(app: http.RequestListener, dir: string): Promise<void> {
    this.socketPath = controlSocketPath(dir, 'api')
    if (path.dirname(this.socketPath) !== dir)
      privateDirectory(path.dirname(this.socketPath))
    if (existsSync(this.socketPath)) {
      if (!lstatSync(this.socketPath).isSocket())
        throw new Error('API socket path is not a socket')
      rmSync(this.socketPath)
    }
    const server = http.createServer(app)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ path: this.socketPath, readableAll: false }, resolve)
    })
    this.server = server
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server == null) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(this.socketPath, { force: true })
  }

  /** The account a host session asserts, only on the API socket with this process's secret. */
  asserted(
    req: Request,
  ): { accountId: number; permissionVersion: number } | undefined {
    const proof = req.get(INTERNAL)
    if (
      this.server == null ||
      (req.socket as { server?: unknown }).server !== this.server ||
      proof == null ||
      proof.length !== this.secret.length ||
      !timingSafeEqual(Buffer.from(proof), Buffer.from(this.secret))
    )
      return undefined
    const accountId = Number(req.get(ACCOUNT))
    const permissionVersion = Number(req.get(VERSION))
    if (
      !Number.isSafeInteger(accountId) ||
      !Number.isSafeInteger(permissionVersion)
    )
      return undefined
    return { accountId, permissionVersion }
  }

  /** Whether a request came through the host. */
  forwarded(req: Request): boolean {
    return (
      this.server != null &&
      (req.socket as { server?: unknown }).server === this.server
    )
  }

  /**
   * Runs a forwarded request and streams back a JSON header line
   * (`{status, contentType}`) followed by the body.
   */
  async forward(value: unknown, stream: Stream): Promise<void> {
    try {
      if (this.server == null) throw new Error('The master is not serving')
      const request = asForwardRequest(value)
      if (
        request.account != null &&
        !isRunAction(request.method, request.path) &&
        !isRunRead(request.method, request.path)
      )
        throw new Error(
          'A host session may only request, cancel, restart or approve runs',
        )
      const body =
        request.body == null ? undefined : Buffer.from(request.body, 'base64')
      if (body != null && body.length > MAX_BODY)
        throw new Error('The request body is too large')
      const headers: Record<string, string> = { host: 'mason-master' }
      if (request.authorization != null)
        headers.authorization = request.authorization
      if (request.contentType != null)
        headers['content-type'] = request.contentType
      if (body != null) headers['content-length'] = String(body.length)
      if (request.address != null) headers[FORWARDED_FOR] = request.address
      if (request.account != null) {
        headers[INTERNAL] = this.secret
        headers[ACCOUNT] = String(request.account.id)
        headers[VERSION] = String(request.account.permissionVersion)
      }
      const response = await new Promise<http.IncomingMessage>(
        (resolve, reject) => {
          const outgoing = http.request(
            {
              socketPath: this.socketPath,
              method: request.method,
              path: request.path,
              headers,
            },
            resolve,
          )
          outgoing.once('error', reject)
          outgoing.end(body)
        },
      )
      await stream.write(
        Buffer.from(
          JSON.stringify({
            status: response.statusCode ?? 502,
            contentType: response.headers['content-type'] ?? null,
            ...(response.headers['content-disposition'] == null
              ? {}
              : { disposition: response.headers['content-disposition'] }),
          }) + '\n',
        ),
      )
      try {
        for await (const chunk of response) await stream.write(chunk as Buffer)
      } catch (error) {
        // The host went away mid-stream (an event stream's browser closed).
        response.destroy()
        throw error
      }
      stream.end()
    } catch (error) {
      stream.abort((error as Error).message)
    }
  }
}
