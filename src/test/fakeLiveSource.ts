import { appendFileSync } from 'node:fs'
import path from 'node:path'
import type {
  LiveRun,
  LiveSource,
  LiveStage,
  LiveStep,
} from '../master/live.js'
import type { FeedEvent } from '../master/runFeed.js'
import type { QueueEntry } from '../view/dashboard.js'

/** A run's rows and stage logs a test changes, with the feed it announces them on. */
export class FakeLiveSource implements LiveSource {
  readonly listeners = new Set<(events: FeedEvent[]) => void>()
  runs = new Map<string, LiveRun>()
  stepsOf = new Map<string, LiveStep[]>()
  entries: QueueEntry[] = []
  constructor(readonly dir: string) {}
  subscribe(listener: (events: FeedEvent[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  run(id: string): LiveRun | undefined {
    return structuredClone(this.runs.get(id))
  }
  steps(id: string, stage: string): LiveStep[] {
    return this.stepsOf.get(`${id}/${stage}`) ?? []
  }
  logFile(id: string, stage: string): string {
    return path.join(this.dir, `${id}-${encodeURIComponent(stage)}.log`)
  }
  queue(): QueueEntry[] {
    return this.entries
  }
  notify(...events: FeedEvent[]): void {
    for (const listener of [...this.listeners]) listener(events)
  }
  /** Appends to a stage's log and announces it. */
  write(id: string, stage: string, text: string): void {
    appendFileSync(this.logFile(id, stage), text)
    this.notify({ kind: 'log', run: id, stage })
  }
  /** Changes a run's rows and announces it. */
  change(id: string, edit: (run: LiveRun) => void): void {
    edit(this.runs.get(id)!)
    this.notify({ kind: 'run', run: id })
  }
}

/** A stage of a fake run. */
export const liveStage = (
  name: string,
  status: string,
  started?: number,
): LiveStage => ({
  name,
  kind: 'stage',
  status,
  attempt: 1,
  ...(started == null ? {} : { started }),
})

/** A running fake run of `app` on master. */
export const liveRun = (
  id: string,
  stages: LiveStage[],
  project = 'app',
): LiveRun => ({
  project,
  branch: 'master',
  finished: false,
  summary: {
    id,
    number: 1,
    workflow: 'build',
    branch: 'master',
    status: 'running',
    created: 1,
  },
  stages,
})
