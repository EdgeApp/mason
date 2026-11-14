// The stage list (screen-04-run's aside): find a stage, narrow by status,
// "Whole run" first and each stage indented by its nesting, with its glyph
// and how long it took. On narrow content it folds into one picker row that
// opens the same list as a sheet.
import { useState, type JSX } from 'react'
import { Link } from 'react-router'
import { clock } from '../../../shared/format.js'
import { Icon } from '../../ui/Icon.js'
import { Sheet } from '../../ui/Sheet.js'
import { statusOf } from '../../ui/status.js'
import { STAGE_STATUSES, type StageView } from './model.js'

/** The stage-list glyph classes by tone. */
const GLYPH_TONE: Record<string, string> = {
  success: 'success',
  danger: 'failed',
  warning: 'waiting',
  running: 'running',
  neutral: 'queued',
  info: 'queued',
}

/** A stage's or step's glyph in a list: a spinner while it runs. */
export function StageGlyph({ status }: { status: string }): JSX.Element {
  if (status === 'running')
    return <span className="m-spinner m-spinner--sm" aria-hidden="true" />
  const treatment = statusOf(status)
  return (
    <Icon
      name={treatment.icon}
      className={`m-stage-ico m-stage-ico--${GLYPH_TONE[treatment.tone]}`}
    />
  )
}

/** How long a stage has taken, as a clock; a dash before it starts. */
export const stageClock = (stage: StageView, now: number): string =>
  stage.started == null ? '—' : clock((stage.finished ?? now) - stage.started)

export interface StageListProps {
  stages: StageView[]
  selected: string | undefined
  /** The address that shows a stage (none: the whole run). */
  href: (stage: string | undefined) => string
  /** The whole run's time so far. */
  wholeClock: string
  now: number
  /** A row was chosen (closes the sheet). */
  onChoose?: () => void
}

/** The filters and the tree. */
function StageTree({
  stages,
  selected,
  href,
  wholeClock,
  now,
  onChoose,
}: StageListProps): JSX.Element {
  const [find, setFind] = useState('')
  const [status, setStatus] = useState('')
  const shown = stages.filter(
    (stage) =>
      stage.name.toLowerCase().includes(find.trim().toLowerCase()) &&
      (status === '' || stage.status === status),
  )
  return (
    <>
      <div className="m-card__body m-stack m-stagelist__filters">
        <div className="m-affix">
          <Icon name="search" />
          <input
            className="m-input"
            type="search"
            placeholder="Find a stage"
            aria-label="Find a stage"
            value={find}
            onChange={(event) => setFind(event.target.value)}
          />
        </div>
        <select
          className="m-select"
          aria-label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">Every status</option>
          {STAGE_STATUSES.map((entry) => (
            <option key={entry} value={entry}>
              {statusOf(entry).word}
            </option>
          ))}
        </select>
      </div>
      <ul className="m-stagelist__tree">
        <li>
          <Link
            className="m-stage"
            to={href(undefined)}
            aria-current={selected == null ? 'true' : undefined}
            onClick={onChoose}
          >
            <Icon name="receipt_long" className="m-stage-ico" />
            <span className="m-stage__name">Whole run</span>
            <span className="m-stage__time">{wholeClock}</span>
          </Link>
        </li>
        {shown.map((stage) => (
          <li
            key={stage.name}
            data-stage={stage.name}
            data-status={stage.status}
          >
            <Link
              className="m-stage"
              to={href(stage.name)}
              aria-current={stage.name === selected ? 'true' : undefined}
              style={{
                paddingLeft: `calc(${stage.depth}rem + var(--m-space-4))`,
              }}
              title={stage.name}
              onClick={onChoose}
            >
              <StageGlyph status={stage.status} />
              <span className="m-stage__name">
                {stage.label}
                <span className="m-sr">, {statusOf(stage.status).word}</span>
              </span>
              <span className="m-stage__time">{stageClock(stage, now)}</span>
            </Link>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="m-t-subhead m-tertiary m-stagelist__none">
            No stage matches.
          </li>
        )}
      </ul>
    </>
  )
}

/** The aside: the list in a card. */
export function StageList(props: StageListProps): JSX.Element {
  return (
    <aside className="m-card m-stagelist" aria-labelledby="stages-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="account_tree" />
          <h2 className="m-t-title3" id="stages-title">
            Stages
          </h2>
        </div>
      </header>
      <StageTree {...props} />
    </aside>
  )
}

/** Narrow: one row naming the shown stage, which opens the list as a sheet. */
export function StagePicker(
  props: StageListProps & { current: StageView | undefined },
): JSX.Element {
  const [open, setOpen] = useState(false)
  const { current } = props
  return (
    <>
      <button
        className="m-stagepicker m-card"
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="account_tree" />
        <span className="m-list__main">
          <span className="m-t-subhead m-secondary">Stage</span>
          <span className="m-t-headline">
            {current == null
              ? 'Whole run'
              : `${current.label} · ${statusOf(current.status).word}`}
          </span>
        </span>
        <Icon name="expand_more" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Stages">
        <div className="m-stagelist m-stagelist--sheet">
          <StageTree {...props} onChoose={() => setOpen(false)} />
        </div>
      </Sheet>
    </>
  )
}
