// A stage's steps as the run page lists them, each under the section it ran
// in. Pure, so the server's page and the browser's live updates share it.
import { duration, escape } from './html.js'
import { plainLog } from './log.js'

export interface StepRow {
  id: number
  kind: string
  title: string
  status: string
  ms?: number | null
  /** The section step it ran in; none, or one not in the list, is the top level. */
  parent?: number | null
}

/** The deepest nesting the list indents; deeper steps stay at this depth. */
const MAX_DEPTH = 4

/**
 * The steps in the order they are listed, with their depth: each section is
 * followed by its own steps, so two sections run at once never interleave.
 */
export function stepTree<T extends StepRow>(
  steps: readonly T[],
): Array<{ step: T; depth: number }> {
  const ids = new Set(steps.map((step) => step.id))
  const children = new Map<number | null, T[]>()
  for (const step of [...steps].sort((a, b) => a.id - b.id)) {
    const parent =
      step.parent != null && step.parent !== step.id && ids.has(step.parent)
        ? step.parent
        : null
    children.set(parent, [...(children.get(parent) ?? []), step])
  }
  const out: Array<{ step: T; depth: number }> = []
  const seen = new Set<number>()
  const visit = (parent: number | null, depth: number): void => {
    for (const step of children.get(parent) ?? []) {
      // A cycle in a malformed report lists each step once.
      if (seen.has(step.id)) continue
      seen.add(step.id)
      out.push({ step, depth: Math.min(depth, MAX_DEPTH) })
      visit(step.id, depth + 1)
    }
  }
  visit(null, 0)
  // Steps only reachable through a cycle are listed at the top level.
  for (const step of steps) if (!seen.has(step.id)) out.push({ step, depth: 0 })
  return out
}

/** The list items of one stage attempt's steps, each linking to its own lines. */
export function stepItems(
  stage: string,
  steps: readonly StepRow[],
  options: { open?: number; tab?: string } = {},
): string {
  return (
    stepTree(steps)
      .map(({ step, depth }) => {
        const classes = [
          'step',
          ...(step.kind === 'section' ? ['section'] : []),
          ...(step.id === options.open ? ['open'] : []),
        ]
        return `<li class="${classes.join(' ')}" data-depth="${depth}"><a href="?stage=${encodeURIComponent(stage)}&amp;step=${step.id}${options.tab === 'timeline' ? '&amp;tab=timeline' : ''}"><span class="dot ${escape(step.status)}" aria-hidden="true"></span><span class="mono">${escape(plainLog(step.title))}</span><small>${escape(step.kind)}${step.ms == null ? '' : ` · ${escape(duration(step.ms))}`}</small></a></li>`
      })
      .join('') || '<li class="empty">No steps yet.</li>'
  )
}
