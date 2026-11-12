// A live run's updates from /live, for the run page: its status line, its
// stages, the shown stage's steps and its log lines. With no stage chosen
// the node follows the running stage, and says so with that stage's steps;
// the page then shows that stage's log. A log line longer than a frame comes
// in pieces marked partial, held until the rest arrives. Each reconnect
// resumes after the last byte received, so no line is lost or repeated.
import { useEffect, useRef, useState } from 'react'
import type { LiveRun, LiveStage, LiveStep } from '../../../shared/live.js'
import type { LiveFrame, LiveSubscribe } from '../../live/LiveClient.js'
import { useLiveClient } from '../../live/LiveProvider.js'

/** What /live said about the run since the page read it. */
export interface LiveRunState {
  summary: LiveRun['summary'] | undefined
  stages: LiveStage[] | undefined
  /** The shown (or followed) stage's steps. */
  steps: { stage: string; steps: LiveStep[] } | undefined
  /** The running stage the whole-run view follows. */
  following: string | undefined
  /** The run finished (`end`) or was deleted (`gone`). */
  ended: boolean
}

export const NOTHING_LIVE: LiveRunState = {
  summary: undefined,
  stages: undefined,
  steps: undefined,
  following: undefined,
  ended: false,
}

/** What the page does with what arrives. */
export interface RunLiveHandlers {
  /** Lines of the shown stage's log, numbered from `first`. */
  log: (stage: string, text: string, first: number) => void
  /** The whole-run view starts following a stage: its log starts afresh. */
  follow: (stage: string) => void
  /** The page's read is stale: a stage it does not know, a new status, the end. */
  stale: () => void
}

/**
 * One page's subscription, as a pure state machine: the message to send
 * (as of now: a resume names where the log reached), and what each frame
 * means.
 */
export class RunLive {
  /** Bytes of the shown stage's log received. */
  private offset: number | undefined
  /** The start of a line longer than a frame, held until the rest of it arrives. */
  private carry: { text: string; first: number } | undefined
  /** The stage whose log is shown: the chosen one, or the one followed. */
  private shown: string | undefined
  private statuses = ''
  state: LiveRunState = NOTHING_LIVE

  constructor(
    private readonly run: string,
    /** The stages the page drew. */
    private readonly known: ReadonlySet<string>,
    /** The stage chosen; none follows the running one. */
    private readonly stage: string | undefined,
    /** A step chosen: its lines only, no more log. */
    private readonly step: number | undefined,
    private readonly handlers: RunLiveHandlers,
    /** Called with each new state. */
    private readonly changed: (state: LiveRunState) => void,
  ) {
    this.shown = stage
  }

  /** The subscribe message, as of now. */
  message(): LiveSubscribe {
    if (this.stage == null) return { subscribe: 'run', run: this.run }
    if (this.step != null)
      return { subscribe: 'run', run: this.run, stage: this.stage, log: false }
    return this.offset == null
      ? { subscribe: 'run', run: this.run, stage: this.stage, tail: true }
      : {
          subscribe: 'run',
          run: this.run,
          stage: this.stage,
          after: this.offset,
        }
  }

  private set(next: Partial<LiveRunState>): void {
    this.state = { ...this.state, ...next }
    this.changed(this.state)
  }

  apply(frame: LiveFrame): void {
    const data = frame.data as Record<string, unknown> | undefined
    switch (frame.event) {
      case 'run': {
        const summary = data as unknown as LiveRun['summary']
        const was = this.state.summary?.status
        this.set({ summary })
        if (was != null && was !== summary.status) this.handlers.stale()
        return
      }
      case 'stages': {
        const stages = frame.data as LiveStage[]
        const statuses = stages
          .map((stage) => `${stage.name}:${stage.status}`)
          .join('\n')
        const unknown = stages.some((stage) => !this.known.has(stage.name))
        const moved = this.statuses !== '' && statuses !== this.statuses
        this.statuses = statuses
        this.set({ stages })
        if (unknown || moved) this.handlers.stale()
        return
      }
      case 'steps': {
        const stage = String(data!.stage)
        if (this.stage == null && stage !== this.shown) {
          this.shown = stage
          this.offset = undefined
          this.carry = undefined
          this.handlers.follow(stage)
          this.set({ following: stage })
        }
        if (stage === this.shown)
          this.set({ steps: { stage, steps: data!.steps as LiveStep[] } })
        return
      }
      case 'log': {
        if (data!.stage !== this.shown || this.step != null) return
        this.offset = Number(data!.offset)
        const text = (this.carry?.text ?? '') + String(data!.text)
        const first = this.carry?.first ?? Number(data!.first)
        if (data!.partial === true) {
          this.carry = { text, first }
          return
        }
        this.carry = undefined
        this.handlers.log(this.shown!, text, first)
        return
      }
      case 'end':
      case 'gone':
        this.set({ ended: true })
        this.handlers.stale()
        return
      default:
        return
    }
  }
}

/**
 * Follows a live run while the page shows it: none for a finished run, or
 * without a live client. A new choice of stage or step subscribes afresh.
 */
export function useRunLive(
  run: { id: string; live: boolean; stages: readonly string[] },
  stage: string | undefined,
  step: number | undefined,
  handlers: RunLiveHandlers,
): LiveRunState {
  const client = useLiveClient()
  const [state, setState] = useState<LiveRunState>(NOTHING_LIVE)
  const latest = useRef(handlers)
  latest.current = handlers
  const known = run.stages.join('\n')
  useEffect(() => {
    setState(NOTHING_LIVE)
    if (client == null || !run.live) return undefined
    const live = new RunLive(
      run.id,
      new Set(known.split('\n')),
      stage,
      step,
      {
        log: (...args): void => latest.current.log(...args),
        follow: (name): void => latest.current.follow(name),
        stale: (): void => latest.current.stale(),
      },
      setState,
    )
    return client.subscribe(
      `run:${run.id}`,
      () => live.message(),
      (frame) => live.apply(frame),
    )
  }, [client, run.id, run.live, known, stage, step])
  return state
}
