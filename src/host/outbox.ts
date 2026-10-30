import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { LinkError, type Link } from '../link/link.js'
import { outboxKinds, type OutboxKind } from '../master/hosts.js'

/** The master's refusals before a message is set aside. */
const REFUSALS = 3
/**
 * Failures (the master erring rather than refusing) before a message is set
 * aside: about an hour of flushes, so a master fault of minutes delays its
 * messages without losing them, while one that never goes cannot hold back
 * the queue for good.
 */
const FAILURES = 60

/**
 * The host's only writes to the master — device registrations, prepare
 * requests and staged artifacts — kept in order with idempotency IDs and
 * delivered while the master's link is open. The master's receipt makes a
 * redelivery harmless. A message the master refuses (rather than one cut
 * off by the link) is set aside with the reason after `REFUSALS` refusals,
 * so it cannot hold back the messages behind it; one the master keeps
 * failing on is retried, and set aside only after `FAILURES`.
 */
export class Outbox {
  private flushing: Promise<void> | undefined
  private readonly setAsideListeners: Array<
    (kind: OutboxKind, payload: string, code: LinkError['code']) => void
  > = []

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

  /**
   * Called with each message the master refused for good, to undo what it
   * stood for; the payload is the stored JSON text, for the listener to
   * clean, and the code is the last refusal's (`refused` when the master
   * refused it deliberately, `failed` when it kept failing).
   */
  onSetAside(
    listener: (
      kind: OutboxKind,
      payload: string,
      code: LinkError['code'],
    ) => void,
  ): void {
    this.setAsideListeners.push(listener)
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
            (error.code === 'failed' ||
              error.code === 'not_allowed' ||
              error.code === 'refused')
          )
            this.refuse(message, error.message, error.code)
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
    code: LinkError['code'],
  ): void {
    const row = this.db
      .prepare(
        'UPDATE host_outbox SET refusals=refusals+1 WHERE id=? RETURNING refusals',
      )
      .get(message.id) as { refusals: number }
    const failed = code === 'failed'
    if (row.refusals < (failed ? FAILURES : REFUSALS)) {
      if (failed)
        this.log?.(
          `Delivering the ${message.kind} message ${message.id} failed: ${reason}; it stays queued`,
        )
      return
    }
    const set = this.db
      .prepare(
        'UPDATE host_outbox SET refused=? WHERE id=? RETURNING kind,payload',
      )
      .get(reason.slice(0, 500), message.id) as {
      kind: OutboxKind
      payload: string
    }
    for (const listener of this.setAsideListeners)
      try {
        listener(set.kind, set.payload, code)
      } catch (error) {
        this.log?.(
          `Undoing the ${message.kind} message ${message.id} failed: ${(error as Error).message}`,
        )
      }
    this.log?.(
      `The master ${failed ? 'kept failing on' : 'refused'} the ${message.kind} message ${message.id}: ${reason}; it is set aside`,
    )
  }
}
