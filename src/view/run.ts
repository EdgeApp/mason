import type { DatabaseSync } from 'node:sqlite'
import { bytes, platformChip, statusDot } from './dashboard.js'
import {
  graphSvg,
  layoutGraph,
  stageLabel,
  timeline,
  timelineHtml,
  type LayoutStage,
  type StageState,
} from './graph.js'
import { ago, duration, escape, time } from './html.js'
import { icon } from './icons.js'
import { logHtml, plainLog } from './log.js'

/** A run's graph as its stages and post stages, from the graph its setup recorded. */
export interface RunGraph {
  stages: LayoutStage[]
  post: LayoutStage[]
  /** Who may decide each approval, by stage name. */
  approvals: Record<
    string,
    {
      roles: string[]
      message?: string
      params: Record<
        string,
        {
          type: string
          choices?: string[]
          default?: unknown
          description?: string
        }
      >
    }
  >
  params: Record<
    string,
    {
      type: string
      choices?: string[]
      default?: unknown
      description?: string
    }
  >
}

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
}

export interface RunData {
  id: string
  number: number
  workflow: string
  branch: string
  commit: string | null
  trigger: string
  actor: string
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
    const node =
      row.worker == null
        ? undefined
        : (options.nodeName?.(row.worker) ?? row.worker.slice(0, 12))
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
        'SELECT stage,attempt,id,kind,title,status,ms,log_start,log_end FROM job_steps WHERE job_id=? ORDER BY stage,attempt,id',
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
    }
  } catch {
    return undefined
  }
}

const triggerText: Record<string, string> = {
  push: 'Push',
  request: 'Requested',
  schedule: 'Schedule',
  after: 'After another workflow',
  deviceRegistered: 'Device registered',
  restart: 'Restarted',
}

export interface RunViewOptions {
  selected?: string
  tab: 'graph' | 'timeline'
  now: number
  /** The selected stage's log (or the run's, with no stage selected): the text, or why it is unavailable. */
  log: { text: string; first?: number } | { unavailable: string }
  /** A URL the page fetches the log from, when this node does not hold it (the host). */
  logSource?: string
  /** Where the shown stage log ends, so the live stream continues from there. */
  logOffset?: number
  /** The step whose lines are shown, when one is expanded. */
  step?: number
  can: {
    cancel: boolean
    restart: boolean
    request: boolean
    approve: (stage: string) => boolean
  }
  /** Where the actions post: the master's API directly, or through the host. */
  base: string
}

function paramField(
  name: string,
  spec: {
    type: string
    choices?: string[]
    default?: unknown
    description?: string
  },
): string {
  const id = `param-${escape(name)}`
  const label = `<label for="${id}">${escape(name)}</label>`
  const hint =
    spec.description == null ? '' : `<small>${escape(spec.description)}</small>`
  if (spec.type === 'choice')
    return `${label}<select id="${id}" name="${escape(name)}">${(
      spec.choices ?? []
    )
      .map(
        (choice) =>
          `<option${choice === spec.default ? ' selected' : ''}>${escape(choice)}</option>`,
      )
      .join('')}</select>${hint}`
  if (spec.type === 'boolean')
    return `${label}<select id="${id}" name="${escape(name)}"><option value="false"${spec.default === true ? '' : ' selected'}>false</option><option value="true"${spec.default === true ? ' selected' : ''}>true</option></select>${hint}`
  return `${label}<input id="${id}" name="${escape(name)}" value="${escape(String(spec.default ?? ''))}"${spec.type === 'number' ? ' inputmode="decimal"' : ''}>${hint}`
}

const statusLine =
  '<p class="notice" role="status" data-field="status" hidden></p>'

/** A form the shell's script sends as JSON to an API path. */
function apiForm(
  path: string,
  fields: string,
  button: string,
  options: { then?: string; className?: string; body?: string } = {},
): string {
  return `<form data-mason="api" data-path="${escape(path)}" data-fields="${escape(fields)}"${options.then == null ? '' : ` data-then="${escape(options.then)}"`}>${options.body ?? ''}<button${options.className == null ? '' : ` class="${options.className}"`}>${button}</button>${statusLine}</form>`
}

function stagePanel(run: RunData, options: RunViewOptions): string {
  const selected =
    options.selected == null
      ? undefined
      : run.stages.find((stage) => stage.name === options.selected)
  const log =
    'unavailable' in options.log
      ? `<p class="empty-state">${escape(options.log.unavailable)}</p>`
      : logHtml(options.log.text, options.log.first ?? 1)
  const downloads = `<div class="actions log-actions"><label class="wrap"><input type="checkbox" data-wrap> Wrap lines</label><a href="${escape(`${options.base}/api/v2/runs/${encodeURIComponent(run.id)}/logs${selected == null ? '' : `?stage=${encodeURIComponent(selected.name)}`}`)}" download>${icon('download')} Raw</a><a href="${escape(`${options.base}/api/v2/runs/${encodeURIComponent(run.id)}/logs?plain=1${selected == null ? '' : `&stage=${encodeURIComponent(selected.name)}`}`)}" download>${icon('description')} Plain text</a></div>`
  if (selected == null)
    return `<section class="panel stage-panel" data-stage=""><h2>${icon('receipt_long')}Whole run log</h2>${downloads}<div data-log>${log}</div></section>`
  const steps = run.steps.filter(
    (step) => step.stage === selected.name && step.attempt === selected.attempt,
  )
  const artifacts = run.artifacts.filter(
    (artifact) => artifact.stage === selected.name,
  )
  const approval = run.graph?.approvals[selected.name]
  const approve =
    selected.status === 'awaiting_approval' &&
    approval != null &&
    options.can.approve(selected.name)
      ? `<div class="approval">${approval.message == null ? '' : `<p>${escape(approval.message)}</p>`}${apiForm(
          `/api/v2/runs/${run.id}/approve`,
          ['stage', 'approve', ...Object.keys(approval.params)].join(','),
          `${icon('check')} Approve`,
          {
            then: 'reload',
            body: `<input type="hidden" name="stage" value="${escape(selected.name)}"><input type="hidden" name="approve" value="true">${Object.entries(
              approval.params,
            )
              .map(([name, spec]) => paramField(name, spec))
              .join('')}`,
          },
        )}${apiForm(
          `/api/v2/runs/${run.id}/approve`,
          'stage,approve',
          `${icon('block')} Reject`,
          {
            then: 'reload',
            className: 'danger',
            body: `<input type="hidden" name="stage" value="${escape(selected.name)}"><input type="hidden" name="approve" value="false">`,
          },
        )}</div>`
      : selected.status === 'awaiting_approval' && approval != null
        ? `<p>Waiting for ${escape(approval.roles.join(' or '))} to approve.</p>`
        : ''
  const restart =
    options.can.restart && run.finished != null
      ? apiForm(
          `/api/v2/runs/${run.id}/restart`,
          'stage',
          `${icon('replay')} Restart from ${escape(stageLabel(selected.name))}`,
          {
            then: 'run',
            className: 'secondary',
            body: `<input type="hidden" name="stage" value="${escape(selected.name)}">`,
          },
        )
      : ''
  const took =
    selected.started == null
      ? undefined
      : (selected.finished ?? options.now) - selected.started
  return `<section class="panel stage-panel" data-stage="${escape(selected.name)}" data-status="${escape(selected.status)}"><h2>${statusDot(selected.status)}${escape(selected.name)}</h2><p class="stage-meta">${escape(selected.status.replace('_', ' '))}${took == null ? '' : ` · ${escape(duration(took))}`}${selected.started == null ? '' : ` · started ${time(selected.started)}`}${selected.node == null ? '' : ` · on <span class="mono">${escape(selected.node)}</span>`}${selected.attempt > 1 ? ` · attempt ${selected.attempt}` : ''}</p>${approve}${restart}${
    artifacts.length === 0
      ? ''
      : `<h3>Artifacts</h3><ul class="plain">${artifacts.map((artifact) => `<li><a href="${escape(`${options.base}/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.name)}`)}">${escape(artifact.name)}</a> <small>${escape(artifact.kind)} · ${escape(bytes(artifact.size))}</small></li>`).join('')}</ul>`
  }<h3>Steps</h3><ol class="steps" data-steps>${
    steps
      .map(
        (step) =>
          `<li class="step${step.id === options.step ? ' open' : ''}"><a href="?stage=${encodeURIComponent(selected.name)}&amp;step=${step.id}${options.tab === 'timeline' ? '&amp;tab=timeline' : ''}">${statusDot(step.status)}<span class="mono">${escape(plainLog(step.title))}</span><small>${escape(step.kind)}${step.ms == null ? '' : ` · ${escape(duration(step.ms))}`}</small></a></li>`,
      )
      .join('') || '<li class="empty">No steps yet.</li>'
  }</ol><h3>${options.step == null ? 'Log' : 'Lines of this step'}</h3>${downloads}<div data-log data-offset="${options.step == null ? (options.logOffset ?? 0) : -1}"${options.logSource == null ? '' : ` data-src="${escape(options.logSource)}"`}>${log}</div></section>`
}

function stageList(
  run: RunData,
  selected: string | undefined,
  tab: string,
): string {
  const suffix = tab === 'timeline' ? '&amp;tab=timeline' : ''
  return `<aside class="panel stage-list"><h2>${icon('account_tree')}Stages</h2><input type="search" placeholder="Find a stage" data-stage-filter aria-label="Find a stage"><select data-status-filter aria-label="Status"><option value="">Every status</option>${[
    'succeeded',
    'running',
    'queued',
    'failed',
    'unstable',
    'awaiting_approval',
    'skipped',
    'cancelled',
  ]
    .map(
      (status) =>
        `<option value="${status}">${escape(status.replace('_', ' '))}</option>`,
    )
    .join('')}</select><ul class="tree">${[
    `<li><a href="?${suffix.replace('&amp;', '')}"${selected == null ? ' aria-current="true"' : ''}>${icon('receipt_long')} Whole run</a></li>`,
    ...run.stages.map((stage) => {
      const depth = stage.name.split('/').length - 1
      return `<li data-name="${escape(stage.name)}" data-status="${escape(stage.status)}" style="padding-left:${depth * 16}px"><a href="?stage=${encodeURIComponent(stage.name)}${suffix}"${stage.name === selected ? ' aria-current="true"' : ''}>${statusDot(stage.status)}<span>${escape(stageLabel(stage.name))}</span><small>${stage.started == null ? '' : escape(duration((stage.finished ?? stage.started) - stage.started))}</small></a></li>`
    }),
  ].join('')}</ul></aside>`
}

/** The run view: header, graph or timeline, the selected stage's panel, the stage list and the branch's history. */
export function runView(run: RunData, options: RunViewOptions): string {
  const states = new Map(run.stages.map((stage) => [stage.name, stage]))
  const graphStages: LayoutStage[] =
    run.graph?.stages ??
    run.stages.map((stage, index) => ({
      name: stage.name,
      kind: stage.kind === 'approval' ? 'approval' : 'stage',
      needs: index === 0 ? [] : [run.stages[index - 1]!.name],
    }))
  const known = new Set(run.stages.map((stage) => stage.name))
  const post = (run.graph?.post ?? []).filter((stage) => known.has(stage.name))
  const layout = layoutGraph(graphStages, post, states, options.now)
  const queued =
    run.started == null ? options.now - run.created : run.started - run.created
  const took =
    run.started == null
      ? undefined
      : (run.finished ?? options.now) - run.started
  const nodes = [
    ...new Set(
      run.stages
        .map((stage) => stage.node)
        .filter((node): node is string => node != null),
    ),
  ]
  const live = run.finished == null
  const cancel =
    options.can.cancel && live
      ? apiForm(
          `/api/v2/runs/${run.id}/cancel`,
          '',
          `${icon('stop_circle')} Cancel`,
          { then: 'reload', className: 'danger' },
        )
      : ''
  const request = options.can.request
    ? `<details class="request"><summary class="button secondary">${icon('play_arrow')} Request run</summary><div class="panel">${apiForm(
        '/api/v2/runs',
        [
          'project',
          'branch',
          'workflow',
          ...Object.keys(run.graph?.params ?? {}),
        ].join(','),
        `${icon('play_arrow')} Request`,
        {
          then: 'run',
          body: `<input type="hidden" name="project" value="${escape(run.project.slug)}"><label for="request-branch">Branch</label><input id="request-branch" name="branch" value="${escape(run.branch)}"><label for="request-workflow">Workflow</label><input id="request-workflow" name="workflow" value="${escape(run.workflow)}">${Object.entries(
            run.graph?.params ?? {},
          )
            .map(([name, spec]) => paramField(name, spec))
            .join('')}`,
        },
      )}</div></details>`
    : ''
  const params = Object.entries(run.params)
  const header = `<div class="page-head run-head" data-run="${escape(run.id)}" data-live="${live ? '1' : '0'}"><div><div class="breadcrumbs"><a href="/?project=${encodeURIComponent(run.project.slug)}">${escape(run.project.name)}</a><span>/</span><a href="/artifacts?project=${encodeURIComponent(run.project.slug)}&amp;branch=${encodeURIComponent(run.branch)}">${escape(run.branch)}</a></div><h1><a href="?" class="run-title">${escape(run.workflow)} #${run.number}</a> <span class="state-${escape(run.status)}" data-run-status>${statusDot(run.status)} ${escape(run.status.replace('_', ' '))}</span></h1><p class="run-meta">${icon('fork_right')} <span class="mono">${escape(run.branch)}</span>${run.commit == null ? '' : ` · ${icon('commit')} <span class="mono">${escape(run.commit.slice(0, 12))}</span>`}${run.project.repository == null ? '' : ` · <span class="mono">${escape(run.project.repository)}</span>`} · ${escape(triggerText[run.trigger] ?? run.trigger)}${run.actor === '' ? '' : ` by ${escape(run.actor)}`} ${time(run.created)} · queued ${escape(duration(queued))}${took == null ? '' : ` · took ${escape(duration(took))}`}${nodes.length === 0 ? '' : ` · on <span class="mono">${nodes.map(escape).join(', ')}</span>`}</p>${run.description == null ? '' : `<p class="run-description">${escape(run.description)}</p>`}${run.reason == null ? '' : `<p class="state-failed">${escape(run.reason)}</p>`}${
    params.length === 0
      ? ''
      : `<details><summary>Parameters</summary><ul class="plain">${params.map(([name, value]) => `<li><span class="mono">${escape(name)}</span> = <span class="mono">${escape(JSON.stringify(value))}</span></li>`).join('')}</ul></details>`
  }</div><div class="actions">${cancel}${request}</div></div>`
  const tabs = `<nav class="chips run-tabs" aria-label="Views"><a class="chip" href="?${options.selected == null ? '' : `stage=${encodeURIComponent(options.selected)}`}"${options.tab === 'graph' ? ' aria-current="true"' : ''}>${icon('account_tree')} Graph</a><a class="chip" href="?tab=timeline${options.selected == null ? '' : `&amp;stage=${encodeURIComponent(options.selected)}`}"${options.tab === 'timeline' ? ' aria-current="true"' : ''}>${icon('timeline')} Timeline</a></nav>`
  const graph =
    options.tab === 'timeline'
      ? `<section class="panel">${timelineHtml(timeline(graphStages, states, options.now))}</section>`
      : `<section class="panel graph-panel"><div class="graph-tools actions"><button type="button" class="secondary" data-zoom="in" aria-label="Zoom in">${icon('zoom_in')}</button><button type="button" class="secondary" data-zoom="out" aria-label="Zoom out">${icon('zoom_out')}</button><button type="button" class="secondary" data-zoom="reset" aria-label="Reset zoom">${icon('fit_screen')}</button><button type="button" class="secondary" data-zoom="full" aria-label="Full screen">${icon('fullscreen')}</button></div><div class="graph-scroll" data-graph>${graphSvg(layout, options.selected)}</div></section>`
  const history = `<section class="panel history"><h2>${icon('history')}History of ${escape(run.branch)}</h2><table class="list"><tbody>${run.history
    .map(
      (entry) =>
        `<tr${entry.id === run.id ? ' class="current"' : ''}><td><a href="/runs/${encodeURIComponent(entry.id)}">#${entry.number}</a></td><td>${statusDot(entry.status)} ${escape(entry.status.replace('_', ' '))}</td><td class="chips-cell">${entry.stages.map((stage) => `<span title="${escape(`${stage.name}: ${stage.status}`)}">${statusDot(stage.status)}</span>`).join('')}</td><td>${escape(ago(entry.created, options.now))}</td></tr>`,
    )
    .join('')}</tbody></table></section>`
  return `${header}${tabs}${graph}<div class="run-body">${stagePanel(run, options)}${stageList(run, options.selected, options.tab)}</div>${history}`
}

/** The published builds of a run, for its header (by commit and branch). */
export function runBuilds(db: DatabaseSync, run: RunData): string {
  const rows = db
    .prepare(
      "SELECT a.name,b.platform,b.version,b.build_number FROM builds b JOIN apps a ON a.id=b.app_id WHERE b.commit_hash=? AND b.branch=? AND b.state='ready' ORDER BY b.id",
    )
    .all(run.commit ?? '', run.branch) as Array<{
    name: string
    platform: string
    version: string
    build_number: string
  }>
  return rows
    .map(
      (row) =>
        `${platformChip(row.platform)} ${escape(row.name)} ${escape(row.version)} (${escape(row.build_number)})`,
    )
    .join(' ')
}
