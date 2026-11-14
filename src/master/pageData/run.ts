import type { DatabaseSync } from 'node:sqlite'
import type { LayoutStage, StageState } from './graph.js'
import { shownLabel } from '../requesters.js'
import type { RunGraph, RunStep, WorkflowSpec } from '../../shared/api/runs.js'

export type { RunGraph, RunStep }

export interface RunData {
  id: string
  number: number
  workflow: string
  branch: string
  commit: string | null
  trigger: string
  actor: string
  /** Who requested the run, as a page shows them: never a key's whole id. */
  requestedBy: string
  /** The app build number the run reserved, which its page leads with. */
  buildNumber: string | null
  status: string
  created: number
  started: number | null
  finished: number | null
  description: string | null
  reason: string | null
  params: Record<string, unknown>
  project: { id: number; slug: string; name: string; repository?: string }
  stages: Array<
    StageState & { name: string; kind: string; attempt: number; node?: string }
  >
  steps: RunStep[]
  graph?: RunGraph
  artifacts: Array<{ stage: string; name: string; kind: string; size: number }>
  history: Array<{
    id: string
    number: number
    status: string
    created: number
    stages: Array<{ name: string; status: string }>
  }>
}

/** Reads a run from the master's database or the host's cache, which share these tables. */
export function runData(
  db: DatabaseSync,
  id: string,
  graphOf: (id: string) => RunGraph | undefined,
  options: {
    repository?: (projectId: number) => string | undefined
    nodeName?: (fingerprint: string) => string | undefined
    /** Who an actor label names; the host's cache holds it resolved by the master. */
    requester?: (label: string) => string
    /** The app build number a run reserved; the host's cache holds it with the run. */
    buildNumber?: (id: string) => string | undefined
  } = {},
): RunData | undefined {
  const job = db
    .prepare(
      'SELECT j.*,p.slug,p.name AS project_name FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=?',
    )
    .get(id) as Record<string, unknown> | undefined
  if (job == null) return undefined
  const stages = (
    db
      .prepare(
        "SELECT name,kind,status,attempt,worker,started,finished FROM job_stages WHERE job_id=? AND name NOT LIKE '@%' ORDER BY position",
      )
      .all(id) as Array<{
      name: string
      kind: string
      status: string
      attempt: number
      worker: string | null
      started: number | null
      finished: number | null
    }>
  ).map((row) => {
    // A node is shown by its name, never its fingerprint: one with none is left out.
    const node =
      row.worker == null
        ? undefined
        : options.nodeName != null
          ? options.nodeName(row.worker)
          : row.worker
    return {
      name: row.name,
      kind: row.kind,
      status: row.status,
      attempt: row.attempt,
      started: row.started,
      finished: row.finished,
      worker: node ?? null,
      ...(node == null ? {} : { node }),
    }
  })
  const steps = (
    db
      .prepare(
        'SELECT stage,attempt,id,kind,title,status,ms,log_start,log_end,parent FROM job_steps WHERE job_id=? ORDER BY stage,attempt,id',
      )
      .all(id) as Array<{
      stage: string
      attempt: number
      id: number
      kind: string
      title: string
      status: string
      ms: number | null
      log_start: number | null
      log_end: number | null
      parent: number | null
    }>
  ).map((row) => ({
    stage: row.stage,
    attempt: row.attempt,
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    ms: row.ms,
    logStart: row.log_start,
    logEnd: row.log_end,
    parent: row.parent ?? null,
  }))
  const projectId = Number(job.project_id)
  const history = (
    db
      .prepare(
        'SELECT id,number,status,created FROM jobs WHERE project_id=? AND branch=? AND workflow=? ORDER BY created DESC LIMIT 10',
      )
      .all(projectId, String(job.branch), String(job.workflow)) as Array<{
      id: string
      number: number
      status: string
      created: number
    }>
  ).map((row) => ({
    ...row,
    stages: db
      .prepare(
        "SELECT name,status FROM job_stages WHERE job_id=? AND name NOT LIKE '@%' ORDER BY position",
      )
      .all(row.id) as Array<{ name: string; status: string }>,
  }))
  const graph = graphOf(id)
  const repository = options.repository?.(projectId)
  return {
    id,
    number: Number(job.number),
    workflow: String(job.workflow),
    branch: String(job.branch),
    commit: job.commit_sha == null ? null : String(job.commit_sha),
    trigger: String(job.trigger),
    actor: String(job.actor ?? ''),
    requestedBy:
      options.requester?.(String(job.actor ?? '')) ??
      (job.requested_by == null
        ? shownLabel(String(job.actor ?? ''))
        : String(job.requested_by)),
    buildNumber:
      (options.buildNumber == null
        ? (job.build_number as string | null | undefined)
        : options.buildNumber(id)) ?? null,
    status: String(job.status),
    created: Number(job.created),
    started: job.started == null ? null : Number(job.started),
    finished: job.finished == null ? null : Number(job.finished),
    description: job.description == null ? null : String(job.description),
    reason: job.reason == null ? null : String(job.reason),
    params: JSON.parse(String(job.params ?? '{}')) as Record<string, unknown>,
    project: {
      id: projectId,
      slug: String(job.slug),
      name: String(job.project_name),
      ...(repository == null ? {} : { repository }),
    },
    stages,
    steps,
    ...(graph == null ? {} : { graph }),
    artifacts: db
      .prepare(
        'SELECT stage,name,kind,size FROM run_artifacts WHERE job_id=? AND deleting=0 ORDER BY stage,name',
      )
      .all(id) as Array<{
      stage: string
      name: string
      kind: string
      size: number
    }>,
    history,
  }
}

/** A run's graph from the graph JSON its setup recorded. */
export function graphFromJson(
  graph: string | null | undefined,
  workflow: string,
): RunGraph | undefined {
  if (graph == null) return undefined
  try {
    const parsed = JSON.parse(graph) as {
      workflows?: Array<{
        name: string
        params?: RunGraph['params']
        stages: Array<
          LayoutStage & {
            approval?: {
              roles: string[]
              message?: string
              params?: RunGraph['params']
            }
          }
        >
        post?: LayoutStage[]
      }>
    }
    const found = parsed.workflows?.find((entry) => entry.name === workflow)
    if (found == null) return undefined
    const workflows: WorkflowSpec[] = (parsed.workflows ?? []).map((entry) => ({
      name: entry.name,
      params: entry.params ?? {},
    }))
    const pick = (stage: LayoutStage): LayoutStage => ({
      name: stage.name,
      kind: stage.kind,
      needs: stage.needs ?? [],
      ...(stage.group == null ? {} : { group: stage.group }),
      ...(stage.matrix == null ? {} : { matrix: stage.matrix }),
    })
    return {
      stages: found.stages.map(pick),
      post: (found.post ?? []).map(pick),
      approvals: Object.fromEntries(
        found.stages
          .filter((stage) => stage.approval != null)
          .map((stage) => [
            stage.name,
            {
              roles: stage.approval!.roles,
              ...(stage.approval!.message == null
                ? {}
                : { message: stage.approval!.message }),
              params: stage.approval!.params ?? {},
            },
          ]),
      ),
      params: found.params ?? {},
      workflows,
    }
  } catch {
    return undefined
  }
}
