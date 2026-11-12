// A stage's steps as the old run page's script lists them (src/browser/run.ts,
// until M11), in the shared order of src/shared/steps.ts.
import { duration, escape } from './html.js'
import { plainLog } from './log.js'
import { stepTree } from '../shared/steps.js'

export { stepTree }

export interface StepRow {
  id: number
  kind: string
  title: string
  status: string
  ms?: number | null
  /** The section step it ran in; none, or one not in the list, is the top level. */
  parent?: number | null
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
