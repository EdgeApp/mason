// The run page's view of a run: what the node answered, with what /live has
// said since laid over it, and the facts each part of the page draws.
import type {
  Bubble,
  Layout,
  ParamSpec,
  RunPage,
  RunPageStage,
  RunStep,
  SessionInfo,
} from '../../../shared/api/index.js'
import type { LiveStep } from '../../../shared/live.js'
import { runName } from '../artifacts/Artifacts.js'
import type { LiveRunState } from './runLive.js'

/** The include a run page reads with. */
export const RUN_INCLUDE = ['graph', 'steps', 'history', 'details'] as const

/** The words a trigger reads as. */
export const TRIGGER_WORDS: Record<string, string> = {
  push: 'Push',
  request: 'Requested',
  schedule: 'Schedule',
  after: 'After another workflow',
  deviceRegistered: 'Device registered',
  restart: 'Restarted',
}

/** The statuses the stage list filters by, in the order its select lists them. */
export const STAGE_STATUSES = [
  'succeeded',
  'running',
  'queued',
  'failed',
  'unstable',
  'awaiting_approval',
  'skipped',
  'cancelled',
  'timed_out',
  'interrupted',
] as const

/** Statuses a run or stage can still leave. */
const UNFINISHED = new Set(['queued', 'running', 'awaiting_approval'])

/** A stage as the page draws it. */
export interface StageView extends RunPageStage {
  /** The last part of its name, under its bubble and in the list. */
  label: string
  /** Its nesting in the list: one level per `/`. */
  depth: number
}

/** A run as the page draws it. */
export interface RunView {
  data: RunPage
  status: string
  started: number | null
  finished: number | null
  reason: string | null
  description: string | null
  stages: StageView[]
  layout: Layout
  /** Whether it can still change: not finished, and /live has not said it ended. */
  live: boolean
}

/** A stage's label: the last part of its name. */
export const stageLabel = (name: string): string =>
  name.split('/').pop() ?? name

/**
 * A run whose graph is no longer kept: its stages one after another, from
 * Start to End.
 */
export function chainLayout(stages: readonly RunPageStage[]): Layout {
  const bubbles: Bubble[] = [
    {
      name: '@start',
      label: 'Start',
      kind: 'start',
      col: 0,
      row: 0,
      status: 'start',
      waitingFor: [],
      needs: [],
      dependents: [],
    },
    ...stages.map(
      (stage, index): Bubble => ({
        name: stage.name,
        label: stageLabel(stage.name),
        kind: stage.kind === 'approval' ? 'approval' : 'stage',
        col: index + 1,
        row: 0,
        status: stage.status,
        waitingFor: [],
        needs: index === 0 ? [] : [stages[index - 1]!.name],
        dependents:
          index === stages.length - 1 ? [] : [stages[index + 1]!.name],
      }),
    ),
    {
      name: '@end',
      label: 'End',
      kind: 'end',
      col: stages.length + 1,
      row: 0,
      status: 'end',
      waitingFor: [],
      needs: [],
      dependents: [],
    },
  ]
  const names = ['@start', ...stages.map((stage) => stage.name), '@end']
  return {
    bubbles,
    rails: names.slice(1).map((to, index) => ({ from: names[index]!, to })),
    cols: stages.length + 2,
    rows: 1,
  }
}

/** The run with /live's word on it laid over what the node answered. */
export function runView(
  data: RunPage,
  live: LiveRunState,
  now: number,
): RunView {
  const overlay = new Map(
    (live.stages ?? []).map((stage) => [stage.name, stage]),
  )
  const stages = data.stages.map((stage): StageView => {
    const update = overlay.get(stage.name)
    return {
      ...stage,
      ...(update == null
        ? {}
        : {
            status: update.status,
            attempt: update.attempt,
            started: update.started ?? stage.started,
            finished: update.finished ?? stage.finished,
            ...(update.node == null ? {} : { node: update.node }),
          }),
      label: stageLabel(stage.name),
      depth: stage.name.split('/').length - 1,
    }
  })
  const byName = new Map(stages.map((stage) => [stage.name, stage]))
  const base = data.layout ?? chainLayout(data.stages)
  const layout: Layout = {
    ...base,
    bubbles: base.bubbles.map((bubble) => {
      const stage = byName.get(bubble.name)
      if (stage == null) return bubble
      const took =
        stage.started == null
          ? bubble.took
          : (stage.finished ??
              (UNFINISHED.has(stage.status) ? now : stage.started)) -
            stage.started
      return {
        ...bubble,
        status: stage.status,
        ...(stage.node == null ? {} : { node: stage.node }),
        ...(took == null ? {} : { took }),
        waitingFor: stage.status === 'queued' ? bubble.waitingFor : [],
      }
    }),
  }
  const summary = live.summary
  const finished = summary?.finished ?? data.finished
  return {
    data,
    status: summary?.status ?? data.status,
    started: summary?.started ?? data.started,
    finished,
    reason: summary?.reason ?? data.reason,
    description: summary?.description ?? data.description,
    stages,
    layout,
    live: finished == null && !live.ended,
  }
}

/** The page's title: `Build 26110803 · Run 182`, or the run's name alone. */
export function runTitle(data: RunPage): string {
  const name = runName(data.workflow, data.number)
  const number = data.details?.buildNumber
  return number == null ? name : `Build ${number} · ${name}`
}

/** Who decides an approval: its roles, or administrators and managers. */
export const approvers = (data: RunPage, stage: string): string[] =>
  data.graph?.approvals[stage]?.roles ?? ['admin', 'manager']

/** Whether the viewer may decide an approval: an administrator, or a role it names. */
export function canApprove(
  session: SessionInfo,
  data: RunPage,
  stage: string,
): boolean {
  return (
    session.permissions.includes('runs.approve') &&
    (session.role === 'admin' || approvers(data, stage).includes(session.role))
  )
}

/** "admin or manager", for "Waiting for admin or manager to approve." */
export const roleList = (roles: readonly string[]): string =>
  roles.length <= 1
    ? (roles[0] ?? 'admin')
    : `${roles.slice(0, -1).join(', ')} or ${roles[roles.length - 1]}`

/** The parameters a workflow of the recorded Masonfile takes; the run's own without the list. */
export function workflowParams(
  data: RunPage,
  workflow: string,
): Record<string, ParamSpec> {
  const listed = data.graph?.workflows?.find((entry) => entry.name === workflow)
  if (listed != null) return listed.params
  return workflow === data.workflow ? (data.graph?.params ?? {}) : {}
}

/** A step as the list draws it. */
export interface StepView {
  id: number
  kind: string
  title: string
  status: string
  ms: number | null
  parent: number | null
}

/**
 * A stage's steps: /live's while it sends them for this stage, else the
 * node's for the stage's current attempt.
 */
export function stageSteps(
  data: RunPage,
  live: LiveRunState,
  stage: StageView | undefined,
  name: string | undefined,
): StepView[] {
  if (name == null) return []
  if (live.steps?.stage === name)
    return live.steps.steps.map((step: LiveStep) => ({ ...step }))
  const attempt = stage?.attempt
  return (data.steps ?? [])
    .filter(
      (step: RunStep) =>
        step.stage === name && (attempt == null || step.attempt === attempt),
    )
    .map((step) => ({
      id: step.id,
      kind: step.kind,
      title: step.title,
      status: step.status,
      ms: step.ms,
      parent: step.parent,
    }))
}
