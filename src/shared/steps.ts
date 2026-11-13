// A stage's steps as the run page lists them, each under the section it ran
// in.

/** What the list needs of a step. */
export interface TreeStep {
  id: number
  /** The section step it ran in; none, or one not in the list, is the top level. */
  parent?: number | null
}

/** The deepest nesting the list indents; deeper steps stay at this depth. */
export const MAX_STEP_DEPTH = 4

/**
 * The steps in the order they are listed, with their depth: each section is
 * followed by its own steps, so two sections run at once never interleave.
 */
export function stepTree<T extends TreeStep>(
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
      out.push({ step, depth: Math.min(depth, MAX_STEP_DEPTH) })
      visit(step.id, depth + 1)
    }
  }
  visit(null, 0)
  // Steps only reachable through a cycle are listed at the top level.
  for (const step of steps) if (!seen.has(step.id)) out.push({ step, depth: 0 })
  return out
}
