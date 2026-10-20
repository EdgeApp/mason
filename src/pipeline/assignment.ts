import type { Json, RunInfo } from '../../types/mason/index.js'
import type { GraphStage, SetupContext } from './graph.js'

/** What the master sends a worker for a setup run: no secrets, files or tokens beyond the run's own. */
export interface SetupAssignment {
  kind: 'setup'
  /** `<job>/@setup/<attempt>`. */
  key: string
  /** Authenticates this run's calls back to the master. */
  token: string
  job: string
  project: string
  repository: string
  repositories: string[]
  commit: string
  entrypoint?: string
  context: SetupContext
  /** Seconds. */
  timeout: number
}

/** What the master sends a worker for one stage attempt. */
export interface StageAssignment {
  kind: 'stage' | 'script'
  /** `<job>/<stage>/<attempt>`. */
  key: string
  token: string
  job: string
  stage: string
  attempt: number
  project: string
  repository: string
  repositories: string[]
  commit: string
  entrypoint?: string
  /** The export a pipeline stage calls. */
  function?: string
  run: RunInfo
  matrix: Record<string, string | number | boolean>
  checkout: GraphStage['checkout']
  workspace: GraphStage['workspace']
  /** Absolute directories this node allows as custom workspace paths. */
  workspaceRoots: string[]
  cache: GraphStage['cache']
  /** Non-secret environment. */
  env: Record<string, string>
  /** Declared secrets only (for a script stage: every project secret). */
  secrets: Record<string, string>
  /** Declared secret files only, by name, base64-encoded. */
  files: Record<string, string>
  /** A script stage's injected files (base64), written into the checkout for the build. */
  inject?: Array<{ destination: string; contents: string; env?: string }>
  platforms?: string[]
  buildNumbers: Record<string, string>
  outputs: Record<string, Json>
  /** Stashes of the run to deliver before the stage starts. */
  stashes: string[]
  /** Seconds. */
  timeout: number
  activityTimeout?: number
  continueOnError: boolean
}

export type Assignment = SetupAssignment | StageAssignment

/** What a worker reports when a run ends. */
export interface RunReport {
  status:
    | 'succeeded'
    | 'unstable'
    | 'failed'
    | 'cancelled'
    | 'timed_out'
    | 'interrupted'
  value?: Json
  reason?: string
  description?: string
  exitCode?: number
  /** Set when the guardian could not prove the run's processes stopped. */
  quarantine?: string
}

/** An assignment as the worker journals it: without secrets, files or injected contents. */
export function redact(assignment: Assignment): Assignment {
  if (assignment.kind === 'setup') return assignment
  const { secrets, files, inject, ...rest } = assignment
  return {
    ...rest,
    secrets: Object.fromEntries(Object.keys(secrets).map((name) => [name, ''])),
    files: Object.fromEntries(Object.keys(files).map((name) => [name, ''])),
    ...(inject == null
      ? {}
      : { inject: inject.map((file) => ({ ...file, contents: '' })) }),
  }
}
