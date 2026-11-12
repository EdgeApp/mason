import type { Bubble, Layout, LayoutStage, Rail } from '../shared/api/runs.js'

export type { Bubble, Layout, LayoutStage, Rail }

/** What a run says about a stage. */
export interface StageState {
  status: string
  started?: number | null
  finished?: number | null
  worker?: string | null
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
