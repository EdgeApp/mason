import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Request } from 'express'
import { cookie, SESSION_COOKIE } from '../auth/routes.js'
import type { Link, Stream } from '../link/link.js'
import {
  sameOrigin,
  streamLines,
  type LiveStreamParams,
  type LiveViewer,
} from '../master/live.js'
import { LIVE_UNAVAILABLE } from '../shared/live.js'
import type { HostRuntime } from './runtime.js'

/** The longest frame the master sends: a log frame's text, escaped. */
const MAX_FRAME = 8 * 1024 * 1024
/** What a page may leave unsent before the host stops granting the master credit for more. */
const PAGE_BACKLOG = 1024 * 1024
/** Live streams one link carries at once. */
export const MAX_LIVE_STREAMS = 256
/** A bearer header with a key's token: `mason_v1_<id>.<secret>`, or an imported builder token. */
const BEARER =
  /^Bearer (mason_v1_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}|[a-f0-9]{64})$/
/** Why a master that serves no live pages (an older one) refuses the stream. */
const UNSERVED = /(^live is not allowed$)|does not serve live pages/
export { LIVE_UNAVAILABLE }

/** Live streams open on each link. */
const streams = new WeakMap<Link, number>()

/**
 * The host's `/live`: the master serves it, over the host's link. Each page
 * socket gets its own `live` stream, and the host relays the page's
 * messages up and the master's frames down. A page from the host's own
 * origin names its session's account and permission version, which the
 * master trusts only on this link; a script's API key goes to the master
 * as it is. While the master is unreachable the upgrade is refused with
 * 503; when the link drops, each page is closed with 1012 and reconnects.
 */
export function hostLive(
  host: HostRuntime,
  options: { maxStreams?: number } = {},
): (req: IncomingMessage) => LiveViewer | number {
  return (req) => {
    const origin = sameOrigin(req)
    if (origin === false) return 403
    let params: LiveStreamParams
    let valid = (): boolean => true
    let who: string
    const authorization = req.headers.authorization
    if (authorization != null) {
      // Only a key's token goes to the master; anything else is refused here.
      const token = BEARER.exec(authorization)?.[1]
      if (token == null) return 401
      params = { authorization }
      who = `token:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`
    } else {
      if (origin !== true) return 403
      const token = cookie(req as Request, SESSION_COOKIE)
      const context = host.accounts.session(token)
      if (context == null) return 401
      params = {
        account: {
          id: context.account.id,
          permissionVersion: context.session.permission_version,
        },
      }
      valid = (): boolean => host.accounts.session(token) != null
      who = `account:${context.account.id}`
    }
    const link = host.options.link()
    if (link == null || link.closed || !host.online()) return 503
    if ((streams.get(link) ?? 0) >= (options.maxStreams ?? MAX_LIVE_STREAMS))
      return 503
    return {
      who,
      open: (out): ReturnType<LiveViewer['open']> => {
        let closed = false
        const close = (code: number): void => {
          if (closed) return
          closed = true
          out.close(code)
        }
        let stream: Stream
        try {
          stream = link.openStream('live', params)
        } catch {
          close(1012)
          return { receive: (): void => undefined, end: (): void => undefined }
        }
        // The master sends no more than the page takes: credit goes back as
        // the page's socket drains, so a slow page never piles up here.
        stream.holdCredit()
        streams.set(link, (streams.get(link) ?? 0) + 1)
        let counted = true
        const uncount = (): void => {
          if (!counted) return
          counted = false
          streams.set(link, (streams.get(link) ?? 1) - 1)
        }
        streamLines(
          stream,
          (text) => {
            if (!text.startsWith('{"close":')) {
              out.send(text)
              return
            }
            const code = (JSON.parse(text) as { close: unknown }).close
            close(Number.isSafeInteger(code) ? Number(code) : 1011)
          },
          MAX_FRAME,
        )
        let owed = 0
        let waiting = false
        const repay = (): void => {
          if (waiting || owed === 0 || closed) return
          if ((out.pending?.() ?? 0) <= PAGE_BACKLOG) {
            stream.grant(owed)
            owed = 0
            return
          }
          waiting = true
          void (out.drained?.() ?? Promise.resolve()).then(() => {
            waiting = false
            repay()
          })
        }
        stream.on('data', (chunk: Buffer) => {
          owed += chunk.length
          repay()
        })
        // A link that drops takes its streams with it: the page reconnects.
        // A master too old to serve live pages refuses the stream: that is final.
        stream.once('abort', (reason: string) => {
          uncount()
          close(UNSERVED.test(reason) ? LIVE_UNAVAILABLE : 1012)
        })
        stream.once('end', () => {
          uncount()
          close(1000)
        })
        return {
          receive: (text): void => {
            stream.write(Buffer.from(text + '\n')).catch(() => undefined)
          },
          end: (): void => {
            closed = true
            stream.end()
          },
        }
      },
      valid,
    }
  }
}
