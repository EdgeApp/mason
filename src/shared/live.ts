// The `/live` WebSocket's messages, which the server (src/master/live.ts,
// src/host/live.ts) and the pages (src/browser/live.ts, the web app) share.

/** Where the master and the host accept the live pages' socket. */
export const LIVE_PATH = '/live'

/** The close code that means the node cannot serve live updates (its master is older): final. */
export const LIVE_UNAVAILABLE = 4000

/** What a page subscribes to: a run's log, a run's status, or the queue. */
export type LiveTopic = 'run' | 'status' | 'queue'

/**
 * The events a frame carries: a run's status line, its stages, a stage's
 * steps, log text, the queue, the end of a subscription (`end`: the run
 * finished; `gone`: it no longer exists) and refusals.
 */
export type LiveEvent =
  | 'run'
  | 'stages'
  | 'steps'
  | 'log'
  | 'queue'
  | 'end'
  | 'gone'
  | 'error'

/** A frame the node sends: an event of one subscription, or an error. */
export interface LiveFrame {
  key?: string
  event: LiveEvent
  data?: unknown
}

/** A message a page sends: a subscription under its key, or the end of one. */
export type LiveMessage =
  | { unsubscribe: string }
  | {
      subscribe: LiveTopic
      key: string
      run?: string
      stage?: string
      after?: number
      follow?: boolean
      /** Start at the log's end, as a page with none of its own. */
      tail?: boolean
      /** False for a page that shows no more of the log (a step's lines). */
      log?: boolean
    }

/** One stage of a run, as the run page draws it. */
export interface LiveStage {
  name: string
  kind: string
  status: string
  attempt: number
  node?: string
  started?: number
  finished?: number
  reason?: string
  disconnected?: true
}

/** A run's state, as the live pages show it. */
export interface LiveRun {
  project: string
  branch: string
  finished: boolean
  /** The run's status line: what the `run` event carries. */
  summary: {
    id: string
    number: number
    workflow: string
    branch: string
    status: string
    created: number
    started?: number
    finished?: number
    description?: string
    reason?: string
  }
  stages: LiveStage[]
}

/** One step of a stage, as the `steps` event carries it. */
export interface LiveStep {
  id: number
  kind: string
  title: string
  status: string
  ms: number | null
  parent: number | null
}
