import express, { Router, type ErrorRequestHandler } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import type { Link } from '../link/link.js'
import type { WebhookResult } from '../master/hosts.js'

const MAX_BODY = 1024 * 1024
/** Deliveries one project may send a minute. */
const RATE = 60

/**
 * `POST /api/webhooks/github/<project>`: GitHub push deliveries, relayed
 * raw with their signature to the master, which verifies them with the
 * project's webhook secret (the host never holds it). While the master is
 * unreachable the host keeps the latest delivery per project and branch and
 * forwards it on reconnect.
 */
export class Webhooks {
  private readonly counts = new Map<string, { count: number; until: number }>()
  private flushing: Promise<void> | undefined

  constructor(
    private readonly options: {
      db: DatabaseSync
      now: () => number
      link: () => Link | undefined
      /** Whether the project is in the cache. */
      known: (project: string) => boolean
    },
  ) {
    options.db.exec(`CREATE TABLE IF NOT EXISTS host_webhooks(
      project TEXT NOT NULL, branch TEXT NOT NULL, event TEXT NOT NULL, signature TEXT NOT NULL,
      body BLOB NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(project, branch)) STRICT`)
  }

  private limited(project: string): boolean {
    const now = this.options.now()
    const entry = this.counts.get(project)
    const current =
      entry != null && entry.until > now
        ? entry
        : { count: 0, until: now + 60_000 }
    current.count++
    this.counts.set(project, current)
    if (this.counts.size > 10_000)
      for (const [key, value] of this.counts)
        if (value.until <= now) this.counts.delete(key)
    return current.count > RATE
  }

  private keep(
    project: string,
    event: string,
    signature: string,
    body: Buffer,
  ): void {
    let branch = ''
    try {
      branch =
        /^refs\/heads\/(.+)$/.exec(
          String(
            (JSON.parse(body.toString('utf8')) as { ref?: unknown }).ref ?? '',
          ),
        )?.[1] ?? ''
    } catch {
      // The master refuses it on reconnect.
    }
    this.options.db
      .prepare(
        'INSERT INTO host_webhooks(project,branch,event,signature,body,received_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project,branch) DO UPDATE SET event=excluded.event,signature=excluded.signature,body=excluded.body,received_at=excluded.received_at',
      )
      .run(project, branch, event, signature, body, this.options.now())
  }

  queued(): Array<{ project: string; branch: string }> {
    return this.options.db
      .prepare('SELECT project,branch FROM host_webhooks ORDER BY received_at')
      .all() as Array<{
      project: string
      branch: string
    }>
  }

  /** Forwards kept deliveries once the master is back; each is sent once. */
  flush(): Promise<void> {
    const link = this.options.link()
    if (link == null || link.closed) return Promise.resolve()
    return (this.flushing ??= (async (): Promise<void> => {
      const rows = this.options.db
        .prepare('SELECT * FROM host_webhooks ORDER BY received_at')
        .all() as Array<{
        project: string
        branch: string
        event: string
        signature: string
        body: Uint8Array
      }>
      for (const row of rows) {
        await link.request('webhook.github', {
          project: row.project,
          event: row.event,
          signature: row.signature,
          body: Buffer.from(row.body).toString('base64'),
        })
        this.options.db
          .prepare('DELETE FROM host_webhooks WHERE project=? AND branch=?')
          .run(row.project, row.branch)
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.flushing = undefined
      }))
  }

  routes(): Router {
    const router = Router()
    const tooLarge: ErrorRequestHandler = (error, _req, res, next) => {
      if ((error as { type?: string }).type === 'entity.too.large') {
        res.status(413).json({ error: 'The delivery is too large' })
        return
      }
      next(error)
    }
    router.post(
      '/api/webhooks/github/:project',
      express.raw({ type: () => true, limit: MAX_BODY }),
      async (req, res) => {
        const project = String(req.params.project)
        if (!this.options.known(project)) {
          res.status(404).json({ error: 'Unknown project' })
          return
        }
        if (this.limited(project)) {
          res.status(429).json({ error: 'Too many deliveries' })
          return
        }
        const signature = req.get('x-hub-signature-256')
        const event = req.get('x-github-event') ?? ''
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        if (signature == null || !/^sha256=[0-9a-f]{64}$/.test(signature)) {
          res.status(401).json({ error: 'The delivery is not signed' })
          return
        }
        const link = this.options.link()
        if (link != null && !link.closed)
          try {
            const answer = (await link.request('webhook.github', {
              project,
              event,
              signature,
              body: body.toString('base64'),
            })) as WebhookResult
            if (answer.status === 'refused') {
              res.status(answer.http ?? 422).json({ error: answer.reason })
              return
            }
            res.status(202).json(answer)
            return
          } catch {
            // The link dropped: keep it for the reconnect.
          }
        this.keep(project, event, signature, body)
        res.status(202).json({ status: 'queued' })
      },
    )
    router.use('/api/webhooks', tooLarge)
    return router
  }
}
