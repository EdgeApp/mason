import type { MasterDatabase } from './database.js'

/** A run whose rows changed, or a stage of it whose log grew. */
export type FeedEvent =
  | { kind: 'run'; run: string }
  | { kind: 'log'; run: string; stage: string }

/**
 * What the live pages hear about runs, the moment the master records it: a
 * run whose job, stage or step rows changed (every such write marks the job
 * changed) and a stage whose log a worker's report grew. Events are
 * coalesced and delivered on the next turn of the event loop, after the
 * write's transaction has committed, so a listener reads what was written;
 * a write that rolled back reads as no change.
 */
export class RunFeed {
  private readonly listeners = new Set<(events: FeedEvent[]) => void>()
  private readonly pending = new Map<string, FeedEvent>()
  private scheduled = false

  constructor(
    database: MasterDatabase,
    logged: Set<(job: string, stage: string) => void>,
  ) {
    database.listeners.add((entity, key) => {
      if (entity === 'job') this.push({ kind: 'run', run: key })
    })
    logged.add((run, stage) => {
      this.push({ kind: 'log', run, stage })
    })
  }

  /** Hears each batch of events; returns the unsubscribe. */
  subscribe(listener: (events: FeedEvent[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private push(event: FeedEvent): void {
    this.pending.set(
      event.kind === 'run'
        ? `run ${event.run}`
        : `log ${event.run} ${event.stage}`,
      event,
    )
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => {
      this.flush()
    })
  }

  private flush(): void {
    this.scheduled = false
    const events = [...this.pending.values()]
    this.pending.clear()
    for (const listener of this.listeners)
      try {
        listener(events)
      } catch {
        // One page's failure never stops the others' updates.
      }
  }
}
