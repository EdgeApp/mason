// The Timeline (DESIGN-LANGUAGE.md §10, screen-04b-run-states): one bar per
// stage that started, placed by real time across the run's span, each row
// led by the stage's status glyph; the critical path — from the stage that
// finished last back through whichever input finished last — is outlined.
import type { JSX } from 'react'
import { duration } from '../../shared/format.js'
import { EmptyState } from './EmptyState.js'
import { Icon } from './Icon.js'
import { statusOf } from './status.js'

/** What the timeline needs of a stage. */
export interface TimelineStage {
  name: string
  status: string
  started: number | null
  finished: number | null
  /** The stages it waits for. */
  needs: string[]
}

export interface TimelineBar {
  name: string
  start: number
  end: number
  status: string
  critical: boolean
}

/** The bars, and the span they are placed across. */
export function timelineBars(
  stages: readonly TimelineStage[],
  now: number,
): { bars: TimelineBar[]; from: number; to: number } {
  const bars: TimelineBar[] = stages
    .filter((stage) => stage.started != null)
    .map((stage) => ({
      name: stage.name,
      start: stage.started!,
      end: stage.finished ?? now,
      status: stage.status,
      critical: false,
    }))
  const by = new Map(bars.map((bar) => [bar.name, bar]))
  let last = [...bars].sort((a, b) => b.end - a.end)[0]
  const seen = new Set<string>()
  while (last != null && !seen.has(last.name)) {
    seen.add(last.name)
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

/** The timeline of a run's stages. */
export function Timeline({
  stages,
  now,
}: {
  stages: readonly TimelineStage[]
  now: number
}): JSX.Element {
  const { bars, from, to } = timelineBars(stages, now)
  if (bars.length === 0)
    return (
      <EmptyState icon="timeline" title="No stage has started yet">
        The timeline fills in as stages start.
      </EmptyState>
    )
  const span = to - from
  return (
    <div className="m-stack">
      <div className="m-timeline" role="list" aria-label="Timeline">
        {bars.map((bar) => {
          const treatment = statusOf(bar.status)
          const left = ((bar.start - from) / span) * 100
          const width = Math.max(0.5, ((bar.end - bar.start) / span) * 100)
          const text = `${bar.name} · ${duration(bar.end - bar.start)} · ${treatment.word.toLowerCase()}${bar.critical ? ' · critical path' : ''}`
          return (
            <div
              key={bar.name}
              role="listitem"
              className="m-timeline__row"
              data-stage={bar.name}
              data-critical={bar.critical ? '' : undefined}
            >
              <span
                className="m-timeline__label"
                style={{
                  ['--solid' as string]: `var(--m-${treatment.tone}-solid)`,
                }}
              >
                <Icon name={treatment.icon} />
                <span className="m-t-mono-sm m-truncate" title={bar.name}>
                  {bar.name.split('/').pop()}
                </span>
              </span>
              <div className="m-timeline__bar" title={text}>
                <span
                  className={bar.critical ? 'm-timeline__critical' : undefined}
                  style={{
                    left: `${left.toFixed(2)}%`,
                    width: `${width.toFixed(2)}%`,
                    ['--bar' as string]: `var(--m-${treatment.tone}-solid)`,
                  }}
                />
                <span className="m-sr">{text}</span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="m-row m-t-subhead m-secondary m-timeline__legend">
        <span className="m-row">
          <span className="m-timeline__swatch" aria-hidden="true" />
          Critical path
        </span>
        <span>Stages that never started are not drawn.</span>
      </div>
    </div>
  )
}
