// The pipeline graph (DESIGN-LANGUAGE.md §10, screen-04-run): stages left to
// right, Jenkins-style, as the server lays them out in columns and rows. It
// is drawn in rem — each column at least 8.25rem, widened to its widest label
// up to 16rem, rows 4.75rem apart, labels 0.75rem — so spacing and labels
// grow together with the text size, and it scrolls sideways rather than
// shrinking. A label wraps to two lines, then ellipsizes, with the full name
// in the bubble's accessible name and tooltip. Hovering or focusing a stage
// traces its inputs and dependents and dims the rest; each bubble selects its
// stage.
import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react'
import type { Bubble, Layout } from '../../shared/api/index.js'
import { duration } from '../../shared/format.js'
import { Button } from './Button.js'
import { glyph } from './icons.js'
import { statusOf } from './status.js'

/** One unit is 1/16 rem: a pixel at the default text size. */
const REM = 16
/** A column's least and greatest width (8.25rem, 16rem). */
export const COLUMN_MIN = 132
export const COLUMN_MAX = 256
/** Start's and End's columns. */
const END_COLUMN = 72
/** Rows' spacing (4.75rem). */
export const ROW = 76
/** Around the graph; room above the first row for a row label. */
const PAD_X = 16
const PAD_TOP = 36
/** A stage's bubble, and Start's and End's. */
const RADIUS = 14
const END_RADIUS = 7
/** A label's two lines (0.75rem on a 1rem line) under its bubble. */
const LABEL_LINE = 16
const LABEL_GAP = 6
/** The width a label's character takes, on average, at 0.75rem semibold. */
export const LABEL_CHAR = 7
/** A label's room inside its column. */
const LABEL_INSET = 16

/** Zoom limits and step. */
export const ZOOM_MIN = 0.4
export const ZOOM_MAX = 3
export const ZOOM_STEP = 1.25

/** Each bubble's place, and the graph's size, in units. */
export interface Geometry {
  width: number
  height: number
  /** Each column's width, by column. */
  columns: number[]
  at: Map<string, { x: number; y: number; r: number; labelWidth: number }>
}

/** A label's estimated width on one line. */
export const labelWidth = (label: string): number =>
  Math.ceil(label.length * LABEL_CHAR)

/** How many lines a label takes in a column of this width: one, or two (then it ellipsizes). */
export const labelLines = (label: string, column: number): 1 | 2 =>
  labelWidth(label) <= column - LABEL_INSET ? 1 : 2

/**
 * Where everything goes: each column as wide as its widest label (within
 * 132–256 units), Start and End narrow; each row 76 units apart, with room
 * for two lines of label under the last.
 */
export function graphGeometry(layout: Layout): Geometry {
  const columns = Array.from({ length: layout.cols }, (_, col) => {
    const stages = layout.bubbles.filter(
      (bubble) =>
        bubble.col === col && bubble.kind !== 'start' && bubble.kind !== 'end',
    )
    if (stages.length === 0) return END_COLUMN
    const widest = Math.max(
      ...stages.map((bubble) => labelWidth(bubble.label) + LABEL_INSET),
    )
    return Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, widest))
  })
  const left = columns.map((_, col) =>
    columns.slice(0, col).reduce((sum, width) => sum + width, PAD_X),
  )
  const at = new Map<
    string,
    { x: number; y: number; r: number; labelWidth: number }
  >()
  for (const bubble of layout.bubbles) {
    const end = bubble.kind === 'start' || bubble.kind === 'end'
    const width = columns[bubble.col] ?? COLUMN_MIN
    at.set(bubble.name, {
      x: (left[bubble.col] ?? PAD_X) + width / 2,
      y: PAD_TOP + bubble.row * ROW,
      r: end ? END_RADIUS : RADIUS,
      labelWidth: width - LABEL_INSET,
    })
  }
  return {
    width: columns.reduce((sum, width) => sum + width, PAD_X * 2),
    height:
      PAD_TOP +
      (Math.max(1, layout.rows) - 1) * ROW +
      RADIUS +
      LABEL_GAP +
      LABEL_LINE * 2 +
      12,
    columns,
    at,
  }
}

/** A rail's path: straight along a row, else a curve between rows. */
export function railPath(
  from: { x: number; y: number; r: number },
  to: { x: number; y: number; r: number },
): string {
  const x1 = from.x + from.r
  const x2 = to.x - to.r
  if (from.y === to.y) return `M${x1} ${from.y}H${x2}`
  const bend = (x2 - x1) / 2
  return `M${x1} ${from.y}C${x1 + bend} ${from.y} ${x2 - bend} ${to.y} ${x2} ${to.y}`
}

/** How a status reads in a bubble's name: `waiting for approval`, `timed out`. */
const statusText = (status: string): string =>
  statusOf(status).word.toLowerCase()

/** A bubble's accessible name and tooltip: name · status · on node · took · waiting for. */
export function bubbleName(bubble: Bubble): string {
  if (bubble.kind === 'start' || bubble.kind === 'end') return bubble.label
  return [
    bubble.name,
    statusText(bubble.status),
    bubble.node == null ? undefined : `on ${bubble.node}`,
    bubble.took == null ? undefined : duration(bubble.took),
    bubble.waitingFor.length === 0
      ? undefined
      : `waiting for ${bubble.waitingFor
          .map((name) => name.split('/').pop() ?? name)
          .join(', ')}`,
  ]
    .filter((part) => part != null)
    .join(' · ')
}

/** The stages a bubble's trace lights: itself, its inputs and its dependents. */
export function traced(layout: Layout, name: string | undefined): Set<string> {
  if (name == null) return new Set()
  const bubble = layout.bubbles.find((entry) => entry.name === name)
  if (bubble == null) return new Set()
  return new Set([name, ...bubble.needs, ...bubble.dependents])
}

export interface PipelineGraphProps {
  layout: Layout
  /** The selected stage, traced while nothing is hovered. */
  selected?: string | undefined
  /** Where a stage's bubble goes. */
  href: (stage: string) => string
  /** Selects a stage (the bubble's link, without a reload). */
  onSelect: (stage: string) => void
  /** The graph's name for assistive tech: "Pipeline of Run 182". */
  label: string
}

/** One stage's bubble: its tone, its glyph, a ring while running, its label. */
function StageBubble({
  bubble,
  place,
  selected,
  dim,
  href,
  onSelect,
  onTrace,
}: {
  bubble: Bubble
  place: { x: number; y: number; r: number; labelWidth: number }
  selected: boolean
  dim: boolean
  href: string
  onSelect: () => void
  onTrace: (on: boolean) => void
}): JSX.Element {
  const treatment = statusOf(bubble.status)
  const tone = treatment.tone
  const icon = bubble.kind === 'approval' ? 'pan_tool' : treatment.icon
  const name = bubbleName(bubble)
  const { x, y, r } = place
  const lines = labelLines(bubble.label, place.labelWidth + LABEL_INSET)
  return (
    <a
      href={href}
      className="m-gbubble"
      data-stage={bubble.name}
      data-status={bubble.status}
      data-dim={dim ? '' : undefined}
      aria-label={name}
      aria-current={selected ? 'true' : undefined}
      onClick={(event: MouseEvent) => {
        event.preventDefault()
        onSelect()
      }}
      onMouseEnter={() => onTrace(true)}
      onMouseLeave={() => onTrace(false)}
      onFocus={() => onTrace(true)}
      onBlur={() => onTrace(false)}
    >
      <title>{name}</title>
      {selected && (
        <circle
          className="m-gbubble__selected"
          cx={x}
          cy={y}
          r={r + 6}
          fill="none"
        />
      )}
      <circle
        className="m-gbubble__disc"
        cx={x}
        cy={y}
        r={r}
        fill={`var(--m-${tone}-soft)`}
        stroke={`var(--m-${tone}-solid)`}
        strokeWidth={2}
        strokeDasharray={bubble.status === 'queued' ? '3 3' : undefined}
      />
      {bubble.status === 'running' && (
        <circle
          className="m-gbubble__ring"
          cx={x}
          cy={y}
          r={r + 3}
          fill="none"
          stroke="var(--m-running-solid)"
        />
      )}
      <text
        className="m-gbubble__glyph"
        x={x}
        y={y + 5}
        textAnchor="middle"
        fill={`var(--m-${tone}-text)`}
        aria-hidden="true"
      >
        {glyph(icon)}
      </text>
      <foreignObject
        x={x - place.labelWidth / 2}
        y={y + r + LABEL_GAP}
        width={place.labelWidth}
        height={LABEL_LINE * 2}
        aria-hidden="true"
      >
        <div className="m-glabel-box" data-lines={lines}>
          {bubble.label}
        </div>
      </foreignObject>
      {bubble.rowLabel != null && (
        <text
          className="m-gsub"
          x={x - r}
          y={y - r - 8}
          textAnchor="start"
          aria-hidden="true"
        >
          {bubble.rowLabel}
        </text>
      )}
    </a>
  )
}

/** The graph's SVG, its rails under its bubbles. */
export function PipelineSvg({
  layout,
  selected,
  href,
  onSelect,
  label,
  scale = 1,
}: PipelineGraphProps & { scale?: number }): JSX.Element {
  const [hovered, setHovered] = useState<string | undefined>()
  const geometry = graphGeometry(layout)
  const focus = hovered ?? selected
  const lit = traced(layout, focus)
  const tracing = lit.size > 0
  return (
    <svg
      className="m-pipeline"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      style={{
        width: `${(geometry.width * scale) / REM}rem`,
        height: `${(geometry.height * scale) / REM}rem`,
      }}
      role="group"
      aria-label={label}
      data-tracing={tracing ? '' : undefined}
    >
      {layout.rails.map((rail) => {
        const from = geometry.at.get(rail.from)
        const to = geometry.at.get(rail.to)
        if (from == null || to == null) return null
        const related =
          focus != null && (rail.from === focus || rail.to === focus)
        return (
          <path
            key={`${rail.from}>${rail.to}`}
            className="m-grail"
            d={railPath(from, to)}
            data-related={related ? '' : undefined}
            data-dim={tracing && !related ? '' : undefined}
            data-from={rail.from}
            data-to={rail.to}
          />
        )
      })}
      {layout.bubbles.map((bubble) => {
        const place = geometry.at.get(bubble.name)!
        if (bubble.kind === 'start' || bubble.kind === 'end')
          return (
            <g key={bubble.name} className="m-gend" aria-hidden="true">
              <circle
                cx={place.x}
                cy={place.y}
                r={place.r}
                fill="var(--m-neutral-solid)"
              />
              <text
                className="m-gsub"
                x={place.x}
                y={place.y + 24}
                textAnchor="middle"
              >
                {bubble.label}
              </text>
            </g>
          )
        return (
          <StageBubble
            key={bubble.name}
            bubble={bubble}
            place={place}
            selected={bubble.name === selected}
            dim={tracing && !lit.has(bubble.name)}
            href={href(bubble.name)}
            onSelect={() => onSelect(bubble.name)}
            onTrace={(on) =>
              setHovered((was) =>
                on ? bubble.name : was === bubble.name ? undefined : was,
              )
            }
          />
        )
      })}
    </svg>
  )
}

/** The graph in its panel: zoom in and out, fit, full screen; it scrolls sideways. */
export function PipelineGraph(props: PipelineGraphProps): JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [full, setFull] = useState(false)
  useEffect(() => {
    const changed = (): void =>
      setFull(
        document.fullscreenElement != null &&
          document.fullscreenElement === panel.current,
      )
    document.addEventListener('fullscreenchange', changed)
    return (): void => document.removeEventListener('fullscreenchange', changed)
  }, [])
  const zoom = (next: number): void =>
    setScale(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)))
  const fit = (): void => {
    const room = scroller.current?.clientWidth ?? 0
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const width =
      (graphGeometry(props.layout).width / REM) *
      (Number.isFinite(rem) && rem > 0 ? rem : REM)
    zoom(room > 0 && width > 0 ? room / width : 1)
  }
  const fullScreen = (): void => {
    const element = panel.current
    if (element == null) return
    if (document.fullscreenElement != null) {
      void document.exitFullscreen?.().then(() => setFull(false))
      return
    }
    void element.requestFullscreen?.()?.then(
      () => setFull(true),
      () => setFull(false),
    )
  }
  const tool = (
    icon: 'zoom_in' | 'zoom_out' | 'fit_screen' | 'fullscreen',
    label: string,
    run: () => void,
    disabled = false,
  ): ReactNode => (
    <Button
      variant="secondary"
      size="sm"
      iconOnly
      icon={icon}
      label={label}
      onClick={run}
      disabled={disabled}
    />
  )
  return (
    <div className="m-graph" ref={panel} data-full={full ? '' : undefined}>
      <div className="m-graph__tools">
        {tool(
          'zoom_in',
          'Zoom in',
          () => zoom(scale * ZOOM_STEP),
          scale >= ZOOM_MAX,
        )}
        {tool(
          'zoom_out',
          'Zoom out',
          () => zoom(scale / ZOOM_STEP),
          scale <= ZOOM_MIN,
        )}
        {tool('fit_screen', 'Fit', fit)}
        {tool(
          'fullscreen',
          full ? 'Exit full screen' : 'Full screen',
          fullScreen,
        )}
      </div>
      <div className="m-graph__scroll" ref={scroller} data-scale={scale}>
        <PipelineSvg {...props} scale={scale} />
      </div>
    </div>
  )
}
