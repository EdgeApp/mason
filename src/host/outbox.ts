import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { LinkError, type Link } from '../link/link.js'
import { outboxKinds, type OutboxKind } from '../master/hosts.js'

/** Refusals before a message is set aside. */
const REFUSALS = 3

/**
 * The host's only writes to the master — device registrations, prepare
 * requests and staged artifacts — kept in order with idempotency IDs and
 * delivered while the master's link is open. The master's receipt makes a
 * redelivery harmless. A message the master refuses (rather than one cut
 * off by the link) is set aside with the reason after `REFUSALS` refusals,
 * so it cannot hold back the messages behind it.
 */
export class Outbox {
  private flushing: Promise<void> | undefined

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly log?: (line: string) => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS host_outbox(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('device','prepare','artifact')),
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER, receipt TEXT,
      refusals INTEGER NOT NULL DEFAULT 0, refused TEXT) STRICT`)
  }

  enqueue(kind: OutboxKind, payload: unknown): string {
    if (!(outboxKinds as readonly string[]).includes(kind))
      throw new Error(`${String(kind)} is not an outbox message`)
    const id = randomBytes(16).toString('base64url')
    this.db
      .prepare(
        'INSERT INTO host_outbox(id,kind,payload,created_at) VALUES(?,?,?,?)',
      )
      .run(id, kind, JSON.stringify(payload), this.now())
    return id
  }

  pending(): Array<{ id: string; kind: OutboxKind; payload: unknown }> {
    return (
      this.db
        .prepare(
          'SELECT id,kind,payload FROM host_outbox WHERE delivered_at IS NULL AND refused IS NULL ORDER BY seq',
        )
        .all() as Array<{ id: string; kind: OutboxKind; payload: string }>
    ).map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }))
  }

  /** Messages the master refused, with its reasons. */
  refused(): Array<{ id: string; kind: OutboxKind; refused: string }> {
    return (
      this.db
        .prepare(
          'SELECT id,kind,refused FROM host_outbox WHERE refused IS NOT NULL ORDER BY seq',
        )
        .all() as Array<{ id: string; kind: OutboxKind; refused: string }>
    ).map((row) => ({ ...row }))
  }

  /** Delivers waiting messages in order; the first failure stops the pass, keeping the order. */
  flush(link: Link | undefined): Promise<void> {
    if (link == null || link.closed) return Promise.resolve()
    return (this.flushing ??= (async (): Promise<void> => {
      for (const message of this.pending()) {
        let answer: { receipt: string }
        try {
          answer = (await link.request('outbox.deliver', message)) as {
            receipt: string
          }
        } catch (error) {
          if (
            error instanceof LinkError &&
            (error.code === 'failed' || error.code === 'not_allowed')
          )
            this.refuse(message, error.message)
          throw error
        }
        this.db
          .prepare('UPDATE host_outbox SET delivered_at=?,receipt=? WHERE id=?')
          .run(this.now(), answer.receipt, message.id)
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.flushing = undefined
      }))
  }

  private refuse(
    message: { id: string; kind: OutboxKind },
    reason: string,
  ): void {
    const row = this.db
      .prepare(
        'UPDATE host_outbox SET refusals=refusals+1 WHERE id=? RETURNING refusals',
      )
      .get(message.id) as { refusals: number }
    if (row.refusals < REFUSALS) return
    this.db
      .prepare('UPDATE host_outbox SET refused=? WHERE id=?')
      .run(reason.slice(0, 500), message.id)
    this.log?.(
      `The master refused the ${message.kind} message ${message.id}: ${reason}; it is set aside`,
    )
  }
}
