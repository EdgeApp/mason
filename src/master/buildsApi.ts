import { Router, type Request, type Response } from 'express'
import type { BuildsViewer } from '../host/builds.js'
import type { Stream } from '../link/link.js'
import { actorOf, authenticate, Unauthorized } from './api.js'
import { HostNotConnected } from './hosts.js'
import { allowRole } from './permissions.js'
import { Forbidden, type Actor } from './roles.js'
import type { Master } from './runtime.js'

/** The headers a relayed download keeps from the host's answer. */
const RELAYED = [
  'content-type',
  'content-disposition',
  'content-length',
  'repr-digest',
  'etag',
  'location',
  'cache-control',
]
/** The longest header line a host's download answer may start with. */
const MAX_HEADER = 16 * 1024

/**
 * The viewer the host decides for: the actor's role and a key's scopes,
 * and the account whose groups a tester sees, a session's own or a key's
 * creator.
 */
export function viewerOf(actor: Actor): BuildsViewer {
  const account = actor.accountId ?? actor.creator
  return {
    role: actor.role,
    label: actor.label,
    ...(account == null ? {} : { account }),
    ...(actor.scopes == null ? {} : { scopes: actor.scopes }),
  }
}

/** Why the master cannot reach a host for the builds API, or undefined when it can try. */
function noHost(master: Master): string | undefined {
  return master.registry.list().some((node) => node.role === 'host')
    ? undefined
    : 'This cluster has no host'
}

/**
 * Passes a host's `builds.download` answer to the client: the JSON line's
 * status and allowed headers, then the bytes. The stream's credit is held
 * and each chunk's bytes are granted back once the response has flushed
 * them, so a slow client paces the host. A client that goes away aborts the
 * stream; a malformed line, or an abort before the line, answers 502.
 */
export async function relayDownload(
  stream: Stream,
  res: Response,
): Promise<void> {
  stream.holdCredit()
  await new Promise<void>((resolve) => {
    let header: Buffer | undefined = Buffer.alloc(0)
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const fail = (reason: string): void => {
      if (!res.headersSent) {
        // A line's headers describe a file that is not coming.
        for (const name of RELAYED) res.removeHeader(name)
        res.status(502).json({ error: reason })
      } else res.destroy()
      finish()
    }
    const write = (chunk: Buffer): void => {
      res.write(chunk, () => {
        stream.grant(chunk.length)
      })
    }
    res.once('close', () => {
      if (!res.writableFinished) stream.abort('The download was cancelled')
      finish()
    })
    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      if (header == null) {
        write(chunk)
        return
      }
      header = Buffer.concat([header, chunk])
      const end = header.indexOf(10)
      if (end < 0) {
        if (header.length > MAX_HEADER) {
          stream.abort('Malformed answer')
          fail('The host’s answer was malformed')
          return
        }
        stream.grant(chunk.length)
        return
      }
      let meta: { status?: unknown; headers?: unknown }
      try {
        meta = JSON.parse(header.subarray(0, end).toString()) as typeof meta
        const status = Number(meta.status)
        if (!Number.isSafeInteger(status) || status < 100 || status > 599)
          throw new Error('No status')
      } catch {
        stream.abort('Malformed answer')
        fail('The host’s answer was malformed')
        return
      }
      const rest = header.subarray(end + 1)
      header = undefined
      res.status(Number(meta.status))
      for (const [name, value] of Object.entries(
        meta.headers != null && typeof meta.headers === 'object'
          ? meta.headers
          : {},
      ))
        if (RELAYED.includes(name.toLowerCase()) && typeof value === 'string')
          res.set(name, value)
      stream.grant(chunk.length - rest.length)
      if (rest.length > 0) write(rest)
    })
    stream.once('end', () => {
      stream.end()
      if (settled) return
      if (header != null) {
        fail('The host’s answer was malformed')
        return
      }
      res.end(finish)
    })
    stream.once('abort', (reason: string) => {
      if (settled) return
      fail(reason)
    })
  })
}

/**
 * The builds API on the master: it authenticates the caller, checks
 * `builds.read`, and relays to the host, which decides what the caller sees
 * from its cache and serves the file from its storage.
 */
export function buildsApi(master: Master): Router {
  const router = Router()
  router.use('/api/v2/builds', authenticate(master))
  const viewer = (res: Response): BuildsViewer => {
    const actor = actorOf(res)
    allowRole(actor, 'builds.read')
    return viewerOf(actor)
  }
  const refuse = (res: Response, error: unknown): void => {
    res
      .status(
        error instanceof Forbidden
          ? 403
          : error instanceof Unauthorized
            ? 401
            : 500,
      )
      .json({ error: (error as Error).message })
  }
  const ask = (
    params: (req: Request) => Record<string, unknown>,
  ): ((req: Request, res: Response) => void) => {
    return (req, res) => {
      void (async (): Promise<void> => {
        let who: BuildsViewer
        try {
          who = viewer(res)
        } catch (error) {
          refuse(res, error)
          return
        }
        const missing = noHost(master)
        if (missing != null) {
          res.status(503).json({ error: missing })
          return
        }
        try {
          const answer = await master.hosts.askHost<{
            status: number
            body: unknown
          }>('builds.request', { viewer: who, ...params(req) })
          if (answer == null) {
            res.status(503).json({ error: 'This cluster has no host' })
            return
          }
          res.status(answer.status).json(answer.body)
        } catch (error) {
          if (error instanceof HostNotConnected)
            res.status(503).json({ error: 'The host is not connected' })
          else res.status(502).json({ error: (error as Error).message })
        }
      })()
    }
  }
  router.get(
    '/api/v2/builds',
    ask((req) => ({ op: 'list', query: req.query })),
  )
  router.get(
    '/api/v2/builds/:id',
    ask((req) => ({ op: 'get', id: req.params.id })),
  )
  router.get('/api/v2/builds/:id/download', (req, res) => {
    let who: BuildsViewer
    try {
      who = viewer(res)
    } catch (error) {
      refuse(res, error)
      return
    }
    const missing = noHost(master)
    if (missing != null) {
      res.status(503).json({ error: missing })
      return
    }
    let stream: Stream
    try {
      stream = master.hosts.openHostStream('builds.download', {
        viewer: who,
        id: req.params.id,
        head: req.method === 'HEAD',
      })
    } catch {
      res.status(503).json({ error: 'The host is not connected' })
      return
    }
    void relayDownload(stream, res)
  })
  return router
}
