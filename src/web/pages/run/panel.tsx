// The stage panel (screen-04-run): the chosen stage's facts, its approval,
// Restart from it, its steps (sections, nested up to four levels, each
// opening its own lines) and saved artifacts, then its log; with no stage
// chosen, the whole run's log, or while the run is live the running stage it
// follows. On narrow content the log also opens full screen.
import { useState, type JSX, type ReactNode } from 'react'
import { Link } from 'react-router'
import { runLogsPath, type RunPage } from '../../../shared/api/index.js'
import { stripAnsi } from '../../../shared/ansi.js'
import { absoluteTime, bytes, clock, duration } from '../../../shared/format.js'
import { stepTree } from '../../../shared/steps.js'
import { Button } from '../../ui/Button.js'
import { Count } from '../../ui/Badge.js'
import { Icon } from '../../ui/Icon.js'
import { LogViewer } from '../../ui/LogViewer.js'
import type { LogOpen, LogStore } from '../../ui/logStore.js'
import { Sheet } from '../../ui/Sheet.js'
import { StatusPill } from '../../ui/StatusPill.js'
import { statusOf } from '../../ui/status.js'
import { ApprovalBox, RestartAction, type Unavailable } from './actions.js'
import type { StageView, StepView } from './model.js'
import { StageGlyph } from './stages.js'

export interface StagePanelProps {
  run: RunPage
  /** The chosen stage. */
  stage: StageView | undefined
  /** The stage whose steps and log show: the chosen one, or the one followed. */
  shown: StageView | undefined
  /** The whole-run view follows this running stage. */
  following: boolean
  step: number | undefined
  steps: StepView[]
  finished: boolean
  now: number
  /** The log's lines, or none (the host's whole run while it is live). */
  store: LogStore | undefined
  openAt: LogOpen
  /** Why there is no log to show. */
  unavailable: ReactNode
  /** Where a step's lines, or the stage's whole log, are. */
  stepHref: (step: number | undefined) => string
  canRestart: boolean
  canDecide: boolean
  /** Why the master's actions cannot be used now. */
  offline: Unavailable | undefined
  onChanged: () => void
}

/** The chosen stage's facts. */
function Facts({ stage, now }: { stage: StageView; now: number }): JSX.Element {
  const took =
    stage.started == null ? undefined : (stage.finished ?? now) - stage.started
  return (
    <dl className="m-kv">
      <dt>Status</dt>
      <dd>
        <StatusPill status={stage.status} />
      </dd>
      {stage.started != null && (
        <>
          <dt>Started</dt>
          <dd className="m-num" title={new Date(stage.started).toISOString()}>
            {absoluteTime(stage.started, now)}
          </dd>
        </>
      )}
      {took != null && (
        <>
          <dt>{stage.finished == null ? 'Running' : 'Took'}</dt>
          <dd className="m-num">{duration(took)}</dd>
        </>
      )}
      {stage.node != null && (
        <>
          <dt>Node</dt>
          <dd className="m-t-mono">{stage.node}</dd>
        </>
      )}
      {stage.attempt > 1 && (
        <>
          <dt>Attempt</dt>
          <dd className="m-num">{stage.attempt}</dd>
        </>
      )}
    </dl>
  )
}

/** A stage's steps, each under its section, each opening its own lines. */
export function StepList({
  steps,
  step,
  stepHref,
}: {
  steps: StepView[]
  step: number | undefined
  stepHref: (step: number | undefined) => string
}): JSX.Element {
  if (steps.length === 0)
    return <p className="m-t-subhead m-tertiary m-steps__none">No steps yet.</p>
  return (
    <ol className="m-steps">
      {stepTree(steps).map(({ step: entry, depth }) => (
        <li
          key={entry.id}
          data-step={entry.id}
          data-depth={depth}
          className={entry.kind === 'section' ? 'm-steps__section' : undefined}
        >
          <Link
            className="m-steps__row"
            to={stepHref(entry.id)}
            aria-current={entry.id === step ? 'true' : undefined}
            style={{
              paddingLeft: `calc(${depth * 1.25}rem + var(--m-space-3))`,
            }}
          >
            <StageGlyph status={entry.status} />
            <span
              className={
                entry.kind === 'section'
                  ? 'm-t-headline m-steps__title'
                  : 'm-t-mono m-steps__title'
              }
            >
              {stripAnsi(entry.title)}
              <span className="m-sr">, {statusOf(entry.status).word}</span>
            </span>
            <span className="m-tertiary m-t-subhead m-steps__meta">
              {entry.kind} · {entry.ms == null ? '—' : clock(entry.ms)}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  )
}

/** The stage panel. */
export function StagePanel(props: StagePanelProps): JSX.Element {
  const {
    run,
    stage,
    shown,
    following,
    step,
    steps,
    finished,
    now,
    store,
    openAt,
    unavailable,
    stepHref,
    canRestart,
    canDecide,
    offline,
    onChanged,
  } = props
  const [fullScreen, setFullScreen] = useState(false)
  const artifacts =
    stage == null
      ? []
      : run.artifacts.filter((artifact) => artifact.stage === stage.name)
  const target = { stage: shown?.name, step }
  const title =
    step != null
      ? 'Lines of this step'
      : stage != null
        ? `Log of ${stage.name}`
        : following && shown != null
          ? `● ${shown.name} following the running stage`
          : 'Whole run log'
  const log = (tall: boolean): ReactNode =>
    store == null ? (
      <div className="m-log" role="region" aria-label={title}>
        <div className="m-log__bar">
          <span className="m-log__title">{title}</span>
        </div>
        <div className="m-log__frame">
          <div className="m-log__body">
            <div className="m-log__gap">{unavailable}</div>
          </div>
        </div>
      </div>
    ) : (
      <LogViewer
        store={store}
        title={title}
        label={title}
        openAt={openAt}
        unavailable={unavailable}
        describeFailure={(failure) =>
          failure.status === 404
            ? /no such step/i.test(failure.message)
              ? 'There is no such step.'
              : 'This run has no log.'
            : failure.message
        }
        tall={tall}
        downloads={{
          raw: runLogsPath(run.id, target),
          plain: runLogsPath(run.id, target, { plain: true }),
        }}
      />
    )
  const logParts = (): ReactNode => (
    <>
      {!fullScreen && log(false)}
      <Button
        className="m-log-fullscreen"
        variant="secondary"
        icon="fullscreen"
        aria-haspopup="dialog"
        onClick={() => setFullScreen(true)}
      >
        Open the log full screen
      </Button>
      <Sheet
        open={fullScreen}
        onClose={() => setFullScreen(false)}
        title={title}
        size="large"
      >
        {fullScreen && log(true)}
      </Sheet>
    </>
  )
  // The whole run's log needs no card: only its title sits above the log.
  if (stage == null && shown == null)
    return (
      <section className="m-stack m-stagepanel" aria-labelledby="stage-title">
        <h2
          className="m-t-title2 m-row m-stagepanel__whole-head"
          id="stage-title"
        >
          <Icon name="receipt_long" />
          Whole run
        </h2>
        {logParts()}
      </section>
    )
  return (
    <section className="m-stack m-stagepanel" aria-labelledby="stage-title">
      <div className="m-card">
        <div className="m-card__body m-stack">
          <div className="m-row m-row--between m-stagepanel__head">
            <h2 className="m-t-title2 m-row" id="stage-title">
              {stage != null ? (
                <>
                  <StageGlyph status={stage.status} />
                  {stage.name}
                </>
              ) : following && shown != null ? (
                <>
                  <StageGlyph status={shown.status} />
                  {shown.name}
                  <span className="m-t-subhead m-secondary">
                    following the running stage
                  </span>
                </>
              ) : null}
            </h2>
            {stage != null && canRestart && (
              <RestartAction
                run={run}
                stage={stage.name}
                finished={finished}
                unavailable={offline}
              />
            )}
          </div>
          {stage != null && <Facts stage={stage} now={now} />}
          {stage?.status === 'awaiting_approval' && (
            <ApprovalBox
              key={stage.name}
              run={run}
              stage={stage.name}
              canDecide={canDecide}
              unavailable={offline}
              onDecided={onChanged}
            />
          )}
        </div>
        {shown != null && (
          <details className="m-disclosure m-stagepanel__steps" open>
            <summary className="m-t-headline">
              <span className="m-stagepanel__grow">Steps</span>
              <Count count={steps.length} />
            </summary>
            <StepList steps={steps} step={step} stepHref={stepHref} />
            {step != null && (
              <p className="m-stagepanel__whole">
                <Link to={stepHref(undefined)}>
                  The whole log of {shown.name}
                </Link>
              </p>
            )}
          </details>
        )}
        {artifacts.length > 0 && (
          <div className="m-card__body m-stagepanel__artifacts">
            <h3 className="m-t-eyebrow">Artifacts of {stage!.name}</h3>
            <ul className="m-list">
              {artifacts.map((artifact) => (
                <li className="m-row" key={artifact.name}>
                  <a className="m-t-mono-sm" href={artifact.url}>
                    {artifact.name}
                  </a>
                  <span className="m-t-subhead m-tertiary">
                    {artifact.kind} · {bytes(artifact.size)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {logParts()}
    </section>
  )
}
