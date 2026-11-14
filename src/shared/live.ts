// The `/live` WebSocket's messages, which the server (src/master/live.ts,
// src/host/live.ts) and the web app share.
import type { StatusInfo } from './api/shell.js'

/** Where the master and the host accept the live pages' socket. */
export const LIVE_PATH = '/live'

/** The close code that means the node cannot serve live updates (its master is older): final. */
export const LIVE_UNAVAILABLE = 4000

/**
 * Messages a page may send at once, and how many more each second: the
 * node refuses the rest, so the page paces itself below the same budget.
 */
export const LIVE_MESSAGE_BURST = 50
export const LIVE_MESSAGES_PER_SECOND = 20

/** Subscriptions one socket may hold at once on a node. */
export const LIVE_MAX_SUBSCRIPTIONS = 200

/** Why a node refuses a message over its socket's budget. */
export const LIVE_TOO_MANY = 'Too many messages: send fewer'

/**
 * What a page subscribes to: a run's log, a run's status, or the queue;
 * `status` without a run is the shell's: the master's workers, or the
 * host's link to its master.
 */
export type LiveTopic = 'run' | 'status' | 'queue'

/**
 * The events a frame carries: a run's status line, its stages, a stage's
 * steps, log text, the queue, the shell's status, the end of a subscription
 * (`end`: the run finished; `gone`: it no longer exists) and refusals.
 */
export type LiveEvent =
  | 'run'
  | 'stages'
  | 'steps'
  | 'log'
  | 'queue'
  | 'status'
  | 'end'
  | 'gone'
  | 'error'

/** A frame the node sends: an event of one subscription, or an error. */
export interface LiveFrame {
  key?: string
  event: LiveEvent
  data?: unknown
}

/**
 * The shell's `status` subscription's frame: what `GET /api/v2/status`
 * answers, sent when it subscribes and again whenever it changes.
 */
export interface LiveStatusFrame {
  key: string
  event: 'status'
  data: StatusInfo
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

/**
 * One socket's message budget on a node: LIVE_MESSAGE_BURST at once,
 * refilled by LIVE_MESSAGES_PER_SECOND.
 */
export class LiveBudget {
  private allowance = LIVE_MESSAGE_BURST

  constructor(private counted: number) {}

  /** Spends one message at `now`; false when none is left. */
  take(now: number): boolean {
    this.allowance = Math.min(
      LIVE_MESSAGE_BURST,
      this.allowance + ((now - this.counted) / 1000) * LIVE_MESSAGES_PER_SECOND,
    )
    this.counted = now
    if (this.allowance < 1) return false
    this.allowance--
    return true
  }
}

/**
 * The refusal of a message over the budget, naming the subscription it
 * leaves unsent (an unsubscribe's key is the one it ends), so the page
 * can send it again.
 */
export function liveRefusal(message: LiveMessage | undefined): LiveFrame {
  const key =
    message == null
      ? undefined
      : 'unsubscribe' in message
        ? message.unsubscribe
        : message.key
  return {
    ...(key == null ? {} : { key }),
    event: 'error',
    data: { error: LIVE_TOO_MANY },
  }
}
