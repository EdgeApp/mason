import { timingSafeEqual } from 'node:crypto'
import express, {
  type ErrorRequestHandler,
  Router,
  type Request,
  type Response,
} from 'express'
import { sessionContext } from '../auth/routes.js'
import type { Stream } from '../link/link.js'
import { clientAddress, isRunAction, isRunRead } from '../master/forward.js'
import type { HostRuntime } from './runtime.js'

const same = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** Reads the forwarded response: a JSON header line, then the body. */
async function relay(stream: Stream, res: Response): Promise<void> {
  let header: Buffer | undefined = Buffer.alloc(0)
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      if (header == null) {
        res.write(chunk)
        return
      }
      header = Buffer.concat([header, chunk])
      const end = header.indexOf(10)
      if (end < 0) {
        if (header.length > 4096) {
          stream.abort('Malformed response')
          reject(new Error('Malformed response'))
        }
        return
      }
      const meta = JSON.parse(header.subarray(0, end).toString()) as {
        status: number
        contentType: string | null
        disposition?: string
      }
      const rest = header.subarray(end + 1)
      header = undefined
      res.status(meta.status)
      if (meta.contentType != null) res.set('Content-Type', meta.contentType)
      if (meta.disposition != null)
        res.set('Content-Disposition', meta.disposition)
      if (rest.length > 0) res.write(rest)
    })
    stream.once('end', () => {
      stream.end()
      resolve()
    })
    stream.once('abort', (reason: string) => {
      reject(new Error(reason))
    })
  })
  res.end()
}

/**
 * Forwards `/api/jobs`, `/api/queue` and `/api/v2/…` to the master over its
 * link (`api.forward`). An API-key request carries its bearer token and the
 * master authenticates it; a signed-in host session may only make the run
 * actions — request, cancel, restart, approve — with its CSRF proof, and the
 * master is told its account and permission version. 503 while the master
 * is unreachable.
 */
export function forwardRoutes(host: HostRuntime): Router {
  const router = Router()
  router.use(
    ['/api/jobs', '/api/queue', '/api/v2'],
    express.raw({ type: () => true, limit: '512kb' }),
    (req: Request, res: Response, next) => {
      void (async (): Promise<void> => {
        const link = host.options.link()
        if (link == null || link.closed || !host.online()) {
          res
            .status(503)
            .json({ error: 'The Mason master is unreachable; retry later' })
          return
        }
        const authorization = req.get('authorization')
        let account: { id: number; permissionVersion: number } | undefined
        if (authorization == null) {
          const context = sessionContext(req, host.accounts)
          if (context == null) {
            res.status(401).json({ error: 'Sign in or use an API key' })
            return
          }
          if (isRunRead(req.method, req.originalUrl)) {
            account = {
              id: context.account.id,
              permissionVersion: context.session.permission_version,
            }
          } else if (!isRunAction(req.method, req.originalUrl)) {
            res.status(403).json({
              error:
                'A host session may only read run logs and events, or request, cancel, restart or approve runs',
            })
            return
          }
          if (account != null) {
            // A read needs no request proof.
          } else {
            const origin = req.get('origin')
            const proof =
              req.get('x-mason-csrf') ??
              ((): unknown => {
                try {
                  return (
                    JSON.parse(Buffer.from(req.body as Buffer).toString()) as {
                      csrf?: unknown
                    }
                  ).csrf
                } catch {
                  return undefined
                }
              })()
            let sameOrigin = false
            try {
              sameOrigin =
                origin != null && new URL(origin).host === req.get('host')
            } catch {
              sameOrigin = false
            }
            if (
              !sameOrigin ||
              typeof proof !== 'string' ||
              !same(proof, context.session.csrf)
            ) {
              res.status(403).json({ error: 'Invalid request proof' })
              return
            }
            account = {
              id: context.account.id,
              permissionVersion: context.session.permission_version,
            }
          }
        }
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        const stream = link.openStream('api.forward', {
          method: req.method,
          path: req.originalUrl,
          ...(authorization == null ? {} : { authorization }),
          ...(req.get('content-type') == null
            ? {}
            : { contentType: req.get('content-type') }),
          ...(body.length === 0 ? {} : { body: body.toString('base64') }),
          ...(account == null ? {} : { account }),
          // Who connected, for the master's audit of secret views and changes.
          address: clientAddress(req),
        })
        try {
          await relay(stream, res)
        } catch (error) {
          if (!res.headersSent)
            res.status(502).json({ error: (error as Error).message })
          else res.end()
        }
      })().catch(next)
    },
  )
  // A body over the forwarding limit: send larger files to the master directly.
  router.use(['/api/jobs', '/api/queue', '/api/v2'], ((
    error,
    _req,
    res,
    next,
  ) => {
    if ((error as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({
        error:
          'The request is over the 512 KB a host forwards; send it to the master directly',
      })
      return
    }
    next(error)
  }) as ErrorRequestHandler)
  return router
}
