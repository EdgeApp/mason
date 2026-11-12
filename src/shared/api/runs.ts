import {
  asArray,
  asNumber,
  asObject,
  asOptional,
  asString,
  asUnknown,
  asValue,
  type Cleaner,
} from 'cleaners'
import { asNullable } from './artifacts.js'

/**
 * `GET /api/v2/runs/:id?include=graph,steps,history,details`, both nodes:
 * everything the run page draws, in one request.
 */
export const runPath = (id: string, include: RunInclude[]): string =>
  `/api/v2/runs/${encodeURIComponent(id)}?include=${include.join(',')}`

/** The parts a run page asks for beside the run itself. */
export const runIncludes = ['graph', 'steps', 'history', 'details'] as const
export type RunInclude = (typeof runIncludes)[number]

/** A parameter a workflow or an approval takes. */
export interface ParamSpec {
  type: string
  choices?: string[]
  default?: unknown
  description?: string
}

/** A stage of a run's recorded graph. */
export interface LayoutStage {
  name: string
  kind: 'stage' | 'approval' | 'script'
  group?: string
  needs: string[]
  matrix?: Record<string, string | number | boolean>
}

/** A run's graph as its stages and post stages, from the graph its setup recorded. */
export interface RunGraph {
  stages: LayoutStage[]
  post: LayoutStage[]
  /** Who may decide each approval, by stage name. */
  approvals: Record<
    string,
    { roles: string[]; message?: string; params: Record<string, ParamSpec> }
  >
  params: Record<string, ParamSpec>
}

/** One bubble of the drawn pipeline graph. */
export interface Bubble {
  /** The stage's full name; `@start` and `@end` for the ends. */
  name: string
  label: string
  kind: 'start' | 'end' | 'stage' | 'approval' | 'post'
  col: number
  row: number
  status: string
  /** The parallel member a row belongs to, on that row's first bubble. */
  rowLabel?: string
  /** For a queued stage: the stages it still waits for. */
  waitingFor: string[]
  needs: string[]
  dependents: string[]
  node?: string
  took?: number
}

export interface Rail {
  from: string
  to: string
}

/** The pipeline graph laid out in columns and rows. */
export interface Layout {
  bubbles: Bubble[]
  rails: Rail[]
  cols: number
  rows: number
}

/** A step of a stage, with where its lines are in the stage's log. */
export interface RunStep {
  stage: string
  attempt: number
  id: number
  kind: string
  title: string
  status: string
  ms: number | null
  logStart: number | null
  logEnd: number | null
  /** The section step it ran in, if any. */
  parent: number | null
}

/** One stage of the run. */
export interface RunPageStage {
  name: string
  kind: string
  status: string
  attempt: number
  started: number | null
  finished: number | null
  /** The node it ran on, by name. */
  node?: string
}

/** A run of the same branch and workflow, newest first. */
export interface RunHistoryEntry {
  id: string
  number: number
  status: string
  created: number
  stages: Array<{ name: string; status: string }>
}

/** What the run page shows beyond its stages. */
export interface RunDetails {
  trigger: string
  /** Who requested the run, as the pages name them. */
  requestedBy: string
  /** The app build number the run reserved. */
  buildNumber: string | null
  params: Record<string, unknown>
  /** The project's repository. */
  repository?: string
  /** The nodes its stages ran on, by name. */
  nodes: string[]
}

/** What `GET /api/v2/runs/:id?include=…` answers: the run, and the parts asked for. */
export interface RunPage {
  id: string
  number: number
  workflow: string
  branch: string
  commit: string | null
  status: string
  created: number
  started: number | null
  finished: number | null
  description: string | null
  reason: string | null
  project: { slug: string; name: string }
  stages: RunPageStage[]
  artifacts: Array<{ stage: string; name: string; kind: string; size: number }>
  /** `include=graph`: the recorded graph and its layout with the stages' states. */
  graph?: RunGraph
  layout?: Layout
  /** `include=steps`: every stage's steps, with their log offsets. */
  steps?: RunStep[]
  /** `include=history`: the branch's last runs of the workflow. */
  history?: RunHistoryEntry[]
  /** `include=details`. */
  details?: RunDetails
}

const asRecord =
  <T>(cleaner: Cleaner<T>): Cleaner<Record<string, T>> =>
  (raw) => {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
      throw new TypeError('Expected an object')
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, cleaner(value)]),
    )
  }

export const asParamSpec = asObject<ParamSpec>({
  type: asString,
  choices: asOptional(asArray(asString)),
  default: asUnknown,
  description: asOptional(asString),
})

const asMatrixValue: Cleaner<string | number | boolean> = (raw) => {
  if (
    typeof raw !== 'string' &&
    typeof raw !== 'number' &&
    typeof raw !== 'boolean'
  )
    throw new TypeError('Expected a string, number or boolean')
  return raw
}

export const asLayoutStage = asObject<LayoutStage>({
  name: asString,
  kind: asValue('stage', 'approval', 'script'),
  group: asOptional(asString),
  needs: asArray(asString),
  matrix: asOptional(asRecord(asMatrixValue)),
})

export const asRunGraph = asObject<RunGraph>({
  stages: asArray(asLayoutStage),
  post: asArray(asLayoutStage),
  approvals: asRecord(
    asObject({
      roles: asArray(asString),
      message: asOptional(asString),
      params: asRecord(asParamSpec),
    }),
  ),
  params: asRecord(asParamSpec),
})

export const asLayout = asObject<Layout>({
  bubbles: asArray(
    asObject<Bubble>({
      name: asString,
      label: asString,
      kind: asValue('start', 'end', 'stage', 'approval', 'post'),
      col: asNumber,
      row: asNumber,
      status: asString,
      rowLabel: asOptional(asString),
      waitingFor: asArray(asString),
      needs: asArray(asString),
      dependents: asArray(asString),
      node: asOptional(asString),
      took: asOptional(asNumber),
    }),
  ),
  rails: asArray(asObject({ from: asString, to: asString })),
  cols: asNumber,
  rows: asNumber,
})

export const asRunStep = asObject<RunStep>({
  stage: asString,
  attempt: asNumber,
  id: asNumber,
  kind: asString,
  title: asString,
  status: asString,
  ms: asNullable(asNumber),
  logStart: asNullable(asNumber),
  logEnd: asNullable(asNumber),
  parent: asNullable(asNumber),
})

export const asRunPage = asObject<RunPage>({
  id: asString,
  number: asNumber,
  workflow: asString,
  branch: asString,
  commit: asNullable(asString),
  status: asString,
  created: asNumber,
  started: asNullable(asNumber),
  finished: asNullable(asNumber),
  description: asNullable(asString),
  reason: asNullable(asString),
  project: asObject({ slug: asString, name: asString }),
  stages: asArray(
    asObject<RunPageStage>({
      name: asString,
      kind: asString,
      status: asString,
      attempt: asNumber,
      started: asNullable(asNumber),
      finished: asNullable(asNumber),
      node: asOptional(asString),
    }),
  ),
  artifacts: asArray(
    asObject({
      stage: asString,
      name: asString,
      kind: asString,
      size: asNumber,
    }),
  ),
  graph: asOptional(asRunGraph),
  layout: asOptional(asLayout),
  steps: asOptional(asArray(asRunStep)),
  history: asOptional(
    asArray(
      asObject<RunHistoryEntry>({
        id: asString,
        number: asNumber,
        status: asString,
        created: asNumber,
        stages: asArray(asObject({ name: asString, status: asString })),
      }),
    ),
  ),
  details: asOptional(
    asObject<RunDetails>({
      trigger: asString,
      requestedBy: asString,
      buildNumber: asNullable(asString),
      params: asRecord(asUnknown),
      repository: asOptional(asString),
      nodes: asArray(asString),
    }),
  ),
})

export { asRecord }
