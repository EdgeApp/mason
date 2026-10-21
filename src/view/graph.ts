import { duration, escape } from './html.js'
import { icons } from './icons.js'

/** What the layout needs of a stage from a run's graph. */
export interface LayoutStage {
  name: string
  kind: 'stage' | 'approval' | 'script'
  group?: string
  needs: string[]
  matrix?: Record<string, string | number | boolean>
}

/** What a run says about a stage. */
export interface StageState {
  status: string
  started?: number | null
  finished?: number | null
  worker?: string | null
}

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
export interface Layout {
  bubbles: Bubble[]
  rails: Rail[]
  cols: number
  rows: number
}

const finished = new Set([
  'succeeded',
  'unstable',
  'failed',
  'skipped',
  'cancelled',
  'timed_out',
  'interrupted',
])

/** The part of a stage's name shown under its bubble. */
export function stageLabel(name: string): string {
  return name.split('/').pop() ?? name
}

/**
 * Lays a run's stages out left to right, Jenkins-style. A stage's column is
 * one past its deepest input. A stage that needs one stage continues that
 * stage's row unless another stage already did; a stage that needs the
 * exits of one parallel group joins on the group's top row (the full fork
 * and join); any other stage that needs several sits between their rows,
 * so only the rails it needs converge on it. Post stages stack after the
 * main stages, before End.
 */
export function layoutGraph(
  stages: LayoutStage[],
  post: LayoutStage[],
  states: ReadonlyMap<string, StageState> = new Map(),
  now = Date.now(),
): Layout {
  const byName = new Map(stages.map((stage) => [stage.name, stage]))
  const col = new Map<string, number>()
  const depth = (name: string, seen = new Set<string>()): number => {
    const known = col.get(name)
    if (known != null) return known
    if (seen.has(name)) throw new Error(`The stages loop through ${name}`)
    seen.add(name)
    const stage = byName.get(name)
    const value =
      stage == null || stage.needs.length === 0
        ? 1
        : 1 +
          Math.max(
            ...stage.needs
              .filter((need) => byName.has(need))
              .map((need) => depth(need, seen)),
            0,
          )
    col.set(name, value)
    return value
  }
  for (const stage of stages) depth(stage.name)
  const order = [...stages].sort(
    (a, b) =>
      col.get(a.name)! - col.get(b.name)! ||
      stages.indexOf(a) - stages.indexOf(b),
  )
  const row = new Map<string, number>()
  const occupied = new Set<string>()
  const continued = new Set<string>()
  let lanes = 0
  const place = (name: string, wanted: number): void => {
    let at = Math.max(0, wanted)
    while (occupied.has(`${col.get(name)}:${at}`)) at++
    occupied.add(`${col.get(name)}:${at}`)
    row.set(name, at)
    lanes = Math.max(lanes, at + 1)
  }
  /** A group's exits: its stages no other stage of the group needs. */
  const exits = (group: string): string[] => {
    const members = stages.filter((stage) => stage.group === group)
    return members
      .filter(
        (stage) => !members.some((other) => other.needs.includes(stage.name)),
      )
      .map((stage) => stage.name)
  }
  for (const stage of order) {
    const needs = stage.needs.filter((need) => byName.has(need))
    if (needs.length === 0) {
      place(stage.name, row.size === 0 ? 0 : lanes)
    } else if (needs.length === 1) {
      const only = needs[0]!
      if (continued.has(only)) place(stage.name, lanes)
      else {
        continued.add(only)
        place(stage.name, row.get(only)!)
      }
    } else {
      const rows = needs.map((need) => row.get(need)!)
      const group = byName.get(needs[0]!)?.group
      const plainJoin =
        group != null &&
        stage.group !== group &&
        needs.every((need) => byName.get(need)?.group === group) &&
        exits(group).every((exit) => needs.includes(exit))
      for (const need of needs) continued.add(need)
      place(
        stage.name,
        plainJoin
          ? Math.min(...rows)
          : Math.round(
              rows.reduce((sum, value) => sum + value, 0) / rows.length,
            ),
      )
    }
  }
  const maxCol = Math.max(0, ...col.values())
  const sinks = stages
    .filter(
      (stage) => !stages.some((other) => other.needs.includes(stage.name)),
    )
    .map((stage) => stage.name)
  const dependents = new Map<string, string[]>()
  for (const stage of stages)
    for (const need of stage.needs)
      dependents.set(need, [...(dependents.get(need) ?? []), stage.name])
  const state = (name: string): StageState =>
    states.get(name) ?? { status: 'queued' }
  const bubble = (
    stage: LayoutStage,
    kind: Bubble['kind'],
    c: number,
    r: number,
  ): Bubble => {
    const s = state(stage.name)
    const took =
      s.started == null
        ? undefined
        : (s.finished ?? (finished.has(s.status) ? s.started : now)) - s.started
    return {
      name: stage.name,
      label: stageLabel(stage.name),
      kind,
      col: c,
      row: r,
      status: s.status,
      waitingFor:
        s.status === 'queued'
          ? stage.needs.filter((need) => !finished.has(state(need).status))
          : [],
      needs: stage.needs,
      dependents: dependents.get(stage.name) ?? [],
      ...(s.worker == null ? {} : { node: s.worker }),
      ...(took == null ? {} : { took }),
    }
  }
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
  ]
  const labelled = new Set<string>()
  for (const stage of order) {
    const made = bubble(
      stage,
      stage.kind === 'approval' ? 'approval' : 'stage',
      col.get(stage.name)!,
      row.get(stage.name)!,
    )
    // A parallel member's row is labelled with the member's name on its first bubble.
    const parts = stage.name.split('/')
    if (stage.group != null && parts.length >= 2 && parts[0] === stage.group) {
      const member = parts.slice(0, 2).join('/')
      if (!labelled.has(member) && parts.length === 3) {
        labelled.add(member)
        made.rowLabel = parts[1]
      }
    }
    bubbles.push(made)
  }
  post.forEach((stage, index) =>
    bubbles.push(bubble(stage, 'post', maxCol + 1, index)),
  )
  const endCol = maxCol + 1 + (post.length > 0 ? 1 : 0)
  bubbles.push({
    name: '@end',
    label: 'End',
    kind: 'end',
    col: endCol,
    row: 0,
    status: 'end',
    waitingFor: [],
    needs: [],
    dependents: [],
  })
  const rails: Rail[] = [
    ...order
      .filter(
        (stage) => stage.needs.filter((need) => byName.has(need)).length === 0,
      )
      .map((stage) => ({ from: '@start', to: stage.name })),
    ...stages.flatMap((stage) =>
      stage.needs
        .filter((need) => byName.has(need))
        .map((need) => ({ from: need, to: stage.name })),
    ),
    ...(post.length === 0
      ? sinks.map((sink) => ({ from: sink, to: '@end' }))
      : [
          ...sinks.flatMap((sink) =>
            post.map((stage) => ({ from: sink, to: stage.name })),
          ),
          ...post.map((stage) => ({ from: stage.name, to: '@end' })),
        ]),
  ]
  if (stages.length === 0) rails.push({ from: '@start', to: '@end' })
  return {
    bubbles,
    rails,
    cols: endCol + 1,
    rows: Math.max(1, lanes, post.length),
  }
}

const COL = 132
const ROW = 76
const PAD = 40
const R = 13

const statusWords: Record<string, string> = {
  awaiting_approval: 'waiting for approval',
  timed_out: 'timed out',
}

/** The graph as SVG: a bubble per stage, each a link selecting that stage, and its rails. */
export function graphSvg(layout: Layout, selected?: string): string {
  const at = new Map(layout.bubbles.map((bubble) => [bubble.name, bubble]))
  const x = (bubble: Bubble): number => PAD + bubble.col * COL
  const y = (bubble: Bubble): number => PAD + bubble.row * ROW
  const width = PAD * 2 + (layout.cols - 1) * COL
  const height = PAD * 2 + (layout.rows - 1) * ROW + 24
  const rails = layout.rails
    .map((rail) => {
      const from = at.get(rail.from)!
      const to = at.get(rail.to)!
      const [x1, y1, x2, y2] = [x(from) + R, y(from), x(to) - R, y(to)]
      const mid = x2 - COL / 2 + R
      const d =
        y1 === y2
          ? `M${x1} ${y1}H${x2}`
          : `M${x1} ${y1}H${Math.max(x1, mid - 24)}C${mid} ${y1} ${mid} ${y2} ${mid + 24} ${y2}H${x2}`
      return `<path class="rail" d="${d}" data-from="${escape(rail.from)}" data-to="${escape(rail.to)}"/>`
    })
    .join('')
  const bubbles = layout.bubbles
    .map((bubble) => {
      const cx = x(bubble)
      const cy = y(bubble)
      const end = bubble.kind === 'start' || bubble.kind === 'end'
      const status = statusWords[bubble.status] ?? bubble.status
      const tip = end
        ? bubble.label
        : [
            bubble.name,
            status,
            bubble.node == null ? undefined : `on ${bubble.node}`,
            bubble.took == null ? undefined : duration(bubble.took),
            bubble.waitingFor.length === 0
              ? undefined
              : `waiting for ${bubble.waitingFor.map(stageLabel).join(', ')}`,
          ]
            .filter((part) => part != null)
            .join(' · ')
      const glyph =
        bubble.kind === 'approval'
          ? `<text class="glyph" x="${cx}" y="${cy + 6}">&#x${icons.pan_tool.toString(16)};</text>`
          : ''
      const label = `<text class="label" x="${cx}" y="${cy + R + 16}">${escape(bubble.label)}</text>`
      const rowLabel =
        bubble.rowLabel == null
          ? ''
          : `<text class="row-label" x="${cx - R - 6}" y="${cy - R - 6}">${escape(bubble.rowLabel)}</text>`
      const shape = `<circle cx="${cx}" cy="${cy}" r="${end ? 7 : R}"/>${bubble.status === 'running' ? `<circle class="ring" cx="${cx}" cy="${cy}" r="${R + 4}"/>` : ''}${glyph}`
      const attributes = `class="bubble ${escape(bubble.kind)} status-${escape(bubble.status)}${bubble.name === selected ? ' selected' : ''}" data-stage="${escape(bubble.name)}" data-needs="${escape(bubble.needs.join(' '))}" data-dependents="${escape(bubble.dependents.join(' '))}"`
      return end
        ? `<g ${attributes}><title>${escape(tip)}</title>${shape}${label}</g>`
        : `<a href="?stage=${encodeURIComponent(bubble.name)}" ${attributes} aria-label="${escape(tip)}"><title>${escape(tip)}</title>${shape}${label}${rowLabel}</a>`
    })
    .join('')
  return `<svg class="pipeline-graph" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Pipeline graph">${rails}${bubbles}</svg>`
}

export interface TimelineBar {
  name: string
  start: number
  end: number
  status: string
  critical: boolean
}

/**
 * The Timeline tab's bars: one per stage that started, placed by real time,
 * and the critical path — from the stage that finished last, back through
 * whichever input finished last — highlighted.
 */
export function timeline(
  stages: LayoutStage[],
  states: ReadonlyMap<string, StageState>,
  now: number,
): { bars: TimelineBar[]; from: number; to: number } {
  const bars = stages
    .filter((stage) => states.get(stage.name)?.started != null)
    .map((stage) => {
      const s = states.get(stage.name)!
      return {
        name: stage.name,
        start: s.started!,
        end: s.finished ?? now,
        status: s.status,
        critical: false,
      }
    })
  const by = new Map(bars.map((bar) => [bar.name, bar]))
  let last = [...bars].sort((a, b) => b.end - a.end)[0]
  while (last != null) {
    last.critical = true
    const needs = stages.find((stage) => stage.name === last!.name)?.needs ?? []
    last = needs
      .map((need) => by.get(need))
      .filter((bar): bar is TimelineBar => bar != null)
      .sort((a, b) => b.end - a.end)[0]
  }
  const from = Math.min(...bars.map((bar) => bar.start), now)
  const to = Math.max(...bars.map((bar) => bar.end), from + 1)
  return { bars, from, to }
}

/** The Timeline tab as HTML bars with percentages of the run's span. */
export function timelineHtml(data: ReturnType<typeof timeline>): string {
  const span = data.to - data.from
  return `<div class="timeline" role="list">${
    data.bars
      .map(
        (bar) =>
          `<div class="timeline-row" role="listitem"><span class="mono">${escape(stageLabel(bar.name))}</span><div class="timeline-track"><span class="timeline-bar status-${escape(bar.status)}${bar.critical ? ' critical' : ''}" style="left:${(((bar.start - data.from) / span) * 100).toFixed(2)}%;width:${Math.max(0.5, ((bar.end - bar.start) / span) * 100).toFixed(2)}%" title="${escape(`${bar.name} · ${duration(bar.end - bar.start)}${bar.critical ? ' · critical path' : ''}`)}"></span></div></div>`,
      )
      .join('') || '<p class="empty-state">No stage has started yet.</p>'
  }</div>`
}
