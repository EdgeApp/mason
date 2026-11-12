// The run page (DESIGN-LANGUAGE.md §14, screen-04-run, screen-04b-run-states;
// screen inventory §5): the header (build and run, status, when, where,
// commit, trigger and requester, description, reason, parameters, Cancel,
// Request run), the approvals waiting, the Graph or Timeline, the stage panel
// with its log beside the stage list, and the branch's history. A live run
// updates in place from /live: status, stages, steps and log. The same page
// serves the master and the host; on the host the master's actions are
// forwarded, and its whole-run log waits for the run to end.
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  asRunLogPage,
  asRunPage,
  runLogsPath,
  runPath,
  type RunPage as RunData,
} from '../../../shared/api/index.js'
import {
  absoluteTime,
  clock,
  duration,
  relativeTime,
} from '../../../shared/format.js'
import { useApi } from '../../api/context.js'
import { useResource } from '../../hooks/useResource.js'
import type { Crumb } from '../../layout/Breadcrumbs.js'
import { Page } from '../../layout/Page.js'
import { useShell } from '../../layout/ShellContext.js'
import { useLiveState } from '../../live/LiveProvider.js'
import { useProfile } from '../../profile/NodeProfile.js'
import { Button, ButtonLink } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Icon } from '../../ui/Icon.js'
import { LogStore, type LogOpen } from '../../ui/logStore.js'
import { PAGE_TITLE_ID } from '../../ui/PageHeader.js'
import { PipelineGraph } from '../../ui/PipelineGraph.js'
import { SkeletonText } from '../../ui/Skeleton.js'
import { StatusPill } from '../../ui/StatusPill.js'
import { statusOf } from '../../ui/status.js'
import { Timeline } from '../../ui/Timeline.js'
import { Tooltip } from '../../ui/Tooltip.js'
import { runName } from '../artifacts/Artifacts.js'
import {
  ApprovalBox,
  CancelAction,
  RequestSheet,
  runHref,
  type Unavailable,
} from './actions.js'
import {
  canApprove,
  RUN_INCLUDE,
  runTitle,
  runView,
  stageSteps,
  TRIGGER_WORDS,
  type RunView,
} from './model.js'
import { StagePanel } from './panel.js'
import { useRunLive } from './runLive.js'
import { StageList, StagePicker } from './stages.js'

const PROJECTS: Crumb = { label: 'Projects & apps', to: '/projects' }

/** The host's whole-run log while the run is live. */
export const HOST_WHOLE_RUN =
  'The whole run’s log is shown once the run ends: choose a stage to follow its log here.'

/** Now, again every second while something on the page counts up. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return (): void => clearInterval(timer)
  }, [ticking])
  return ticking ? now : Date.now()
}

/** The run page's route: `/runs/:id`, `?stage=`, `&step=`, `&tab=timeline`. */
export function RunPage(): JSX.Element {
  const { id = '' } = useParams()
  const read = useResource(runPath(id, [...RUN_INCLUDE]), asRunPage)
  // The loading page's title had focus (a route change put it there): the
  // run's title takes it over when the run arrives.
  const titleFocus = useRef<{ id: string; focused: boolean }>(undefined)
  if (read.data == null || read.data.id !== id) {
    titleFocus.current = undefined
    if (read.error?.status === 404) return <UnknownRun />
    return (
      <Page crumbs={[PROJECTS, { label: 'Run' }]} title="Run">
        {read.error != null ? (
          <section className="m-card">
            <EmptyState
              icon="error"
              tone="danger"
              title="The run could not be read"
              actions={
                <Button
                  variant="secondary"
                  icon="refresh"
                  onClick={read.reload}
                >
                  Retry
                </Button>
              }
            >
              {read.error.message}
            </EmptyState>
          </section>
        ) : (
          <section className="m-card m-card__body">
            <SkeletonText lines={6} label="Loading the run" />
          </section>
        )}
      </Page>
    )
  }
  if (titleFocus.current?.id !== id)
    titleFocus.current = {
      id,
      focused: document.activeElement?.id === PAGE_TITLE_ID,
    }
  return (
    <RunScreen
      key={id}
      data={read.data}
      reload={read.reload}
      focusTitle={titleFocus.current.focused}
    />
  )
}

/** A run that does not exist, or no longer does. */
function UnknownRun(): JSX.Element {
  return (
    <Page
      crumbs={[PROJECTS, { label: 'Run unavailable' }]}
      title="Run unavailable"
    >
      <section className="m-card">
        <EmptyState
          icon="search"
          title="There is no such run"
          actions={
            <ButtonLink variant="secondary" to="/projects">
              Projects & apps
            </ButtonLink>
          }
        >
          It may have been pruned. Runs older than the retention window are
          removed.
        </EmptyState>
      </section>
    </Page>
  )
}

/** Where the page is: the stage, the step and the view the address names. */
function useSelection(data: RunData): {
  stage: string | undefined
  step: number | undefined
  tab: 'graph' | 'timeline'
  href: (change: {
    stage?: string | undefined
    step?: number | undefined
    tab?: 'graph' | 'timeline'
  }) => string
} {
  const [params] = useSearchParams()
  const asked = params.get('stage') ?? undefined
  const stage = data.stages.some((entry) => entry.name === asked)
    ? asked
    : undefined
  const stepText = params.get('step')
  const step =
    stage != null && stepText != null && /^\d+$/.test(stepText)
      ? Number(stepText)
      : undefined
  const tab = params.get('tab') === 'timeline' ? 'timeline' : 'graph'
  const href = useCallback(
    (change: {
      stage?: string | undefined
      step?: number | undefined
      tab?: 'graph' | 'timeline'
    }): string => {
      const query = new URLSearchParams()
      const nextStage = 'stage' in change ? change.stage : stage
      if (nextStage != null) query.set('stage', nextStage)
      if (nextStage != null && change.step != null)
        query.set('step', String(change.step))
      if ((change.tab ?? tab) === 'timeline') query.set('tab', 'timeline')
      const text = query.toString()
      return `${runHref(data.id)}${text === '' ? '' : `?${text}`}`
    },
    [data.id, stage, tab],
  )
  return { stage, step, tab, href }
}

/** The logs the page has open, one per stage, step or the whole run. */
function useLogs(id: string): (
  key: string,
  open: () => LogOpen | undefined,
  target: {
    stage?: string | undefined
    step?: number | undefined
  },
) => LogStore | undefined {
  const client = useApi()
  const stores = useRef(new Map<string, LogStore>())
  useEffect(() => {
    const open = stores.current
    return (): void => {
      for (const store of open.values()) store.close()
      open.clear()
    }
  }, [])
  return useCallback(
    (key, open, target) => {
      const found = stores.current.get(key)
      if (found != null) return found
      const at = open()
      if (at == null) return undefined
      const store = new LogStore(
        async (page) =>
          await client.get(runLogsPath(id, target, page), asRunLogPage),
      )
      // Only the log shown is kept: the one before it stops asking.
      for (const [other, old] of stores.current) {
        old.close()
        stores.current.delete(other)
      }
      stores.current.set(key, store)
      void store.open(at)
      return store
    },
    [client, id],
  )
}

/** A log store's key. */
const logKey = (
  stage: string | undefined,
  step: number | undefined,
  live: boolean,
): string =>
  `${stage ?? ''}\n${step ?? ''}\n${stage == null && live ? 'live' : ''}`

/** The page for a run the node answered. */
function RunScreen({
  data,
  reload,
  focusTitle,
}: {
  data: RunData
  reload: () => void
  focusTitle: boolean
}): JSX.Element {
  useEffect(() => {
    if (focusTitle)
      document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true })
  }, [focusTitle])
  const profile = useProfile()
  const { session, status: shellStatus } = useShell()
  const navigate = useNavigate()
  const selection = useSelection(data)
  const { stage: chosen, step, tab, href } = selection
  const logs = useLogs(data.id)
  const [requesting, setRequesting] = useState(false)
  const offline: Unavailable | undefined =
    shellStatus?.link?.online === false
      ? { reason: 'The master is unreachable: try again once it is back.' }
      : undefined
  const canRequest = session.permissions.includes('runs.request')
  const unfinished = data.finished == null
  const live = useRunLive(
    {
      id: data.id,
      live: unfinished,
      stages: data.stages.map((stage) => stage.name),
    },
    chosen,
    step,
    {
      log: (stage, text, first) =>
        logs(logKey(stage, undefined, true), () => 'end', { stage })?.append(
          text,
          first,
        ),
      follow: (stage) => {
        logs(logKey(stage, undefined, true), () => 'end', { stage })
      },
      stale: reload,
    },
  )
  const now = useNow(unfinished && !live.ended)
  const run: RunView = runView(data, live, now)
  const stage = run.stages.find((entry) => entry.name === chosen)
  const following = chosen == null && run.live ? live.following : undefined
  const shownName = chosen ?? following
  const shown = run.stages.find((entry) => entry.name === shownName)
  const steps = stageSteps(data, live, shown, shownName)

  // The log shown: a stage's (live ones open at their end), a step's, or the
  // whole run's; the host has no whole-run log while the run is live.
  const hostWaits = profile.role === 'host' && shownName == null && run.live
  const openAt: LogOpen =
    step == null && shownName != null && run.live ? 'end' : 'start'
  const store = hostWaits
    ? undefined
    : logs(logKey(shownName, step, run.live), () => openAt, {
        stage: shownName,
        step,
      })
  const unavailable = hostWaits ? HOST_WHOLE_RUN : undefined

  // One polite region says what changed: a stage's or the run's new status.
  const announce = useAnnouncements(run)
  const liveState = useLiveState()

  const name = runName(data.workflow, data.number)
  const buildNumber = data.details?.buildNumber
  const crumbs: Crumb[] = [
    PROJECTS,
    {
      label: data.project.name,
      to: `/projects/${encodeURIComponent(data.project.slug)}`,
    },
    {
      label: 'Runs and builds',
      to: `/projects/${encodeURIComponent(data.project.slug)}/runs`,
    },
    {
      label: data.branch,
      to: `/projects/${encodeURIComponent(data.project.slug)}/runs?branch=${encodeURIComponent(data.branch)}`,
    },
    { label: `Run ${data.number}` },
  ]
  const waiting = run.stages.filter(
    (entry) => entry.status === 'awaiting_approval' && entry.name !== chosen,
  )
  const wholeClock =
    run.started == null ? '—' : clock((run.finished ?? now) - run.started)
  const listProps = {
    stages: run.stages,
    selected: chosen,
    href: (name: string | undefined): string => href({ stage: name }),
    wholeClock,
    now,
  }
  return (
    <Page
      crumbs={crumbs}
      title={runTitle(data)}
      heading={
        <Link className="m-run__title" to={href({ stage: undefined })}>
          {buildNumber == null ? name : `Build ${buildNumber}`}
        </Link>
      }
      pill={
        <>
          {buildNumber != null && (
            <span className="m-t-title3 m-secondary">{name}</span>
          )}
          <span data-run-status={run.status}>
            <StatusPill status={run.status} />
          </span>
          {run.live && liveState === 'reconnecting' && (
            <StatusPill status="reconnecting" quiet />
          )}
          {run.live && liveState === 'unavailable' && (
            <StatusPill
              status="live_unavailable"
              quiet
              name="Live updates are unavailable here: reload for the latest"
            />
          )}
        </>
      }
      meta={<RunMeta run={run} now={now} />}
      description={
        run.description == null || run.description === '' ? undefined : (
          <span className="m-run__desc">{run.description}</span>
        )
      }
      details={<RunDetails run={run} />}
      actions={
        canRequest ? (
          <>
            {run.live && (
              <CancelAction
                run={data}
                status={run.status}
                unavailable={offline}
                onCancelled={reload}
              />
            )}
            <Button
              variant="secondary"
              icon="play_arrow"
              aria-haspopup="dialog"
              disabled={offline != null}
              title={offline?.reason}
              onClick={() => setRequesting(true)}
            >
              Request run
            </Button>
          </>
        ) : undefined
      }
    >
      <p className="m-sr" role="status" aria-live="polite">
        {announce}
      </p>
      {waiting.map((entry) => (
        <ApprovalBox
          key={entry.name}
          run={data}
          stage={entry.name}
          canDecide={canApprove(session, data, entry.name)}
          unavailable={offline}
          onDecided={reload}
        />
      ))}
      <section className="m-stack" aria-label="Pipeline">
        <div className="m-row m-row--between">
          <div className="m-seg" role="group" aria-label="Pipeline view">
            <button
              className="m-seg__opt"
              type="button"
              aria-pressed={tab === 'graph'}
              onClick={() =>
                navigate(href({ tab: 'graph' }), { replace: true })
              }
            >
              <Icon name="account_tree" />
              Graph
            </button>
            <button
              className="m-seg__opt"
              type="button"
              aria-pressed={tab === 'timeline'}
              onClick={() =>
                navigate(href({ tab: 'timeline' }), { replace: true })
              }
            >
              <Icon name="timeline" />
              Timeline
            </button>
          </div>
          {tab === 'graph' && (
            <span className="m-t-subhead m-tertiary m-run__hint">
              Hover a stage to trace what it waits for
            </span>
          )}
        </div>
        {tab === 'graph' ? (
          <PipelineGraph
            layout={run.layout}
            selected={chosen}
            href={(name) => href({ stage: name })}
            onSelect={(name) => navigate(href({ stage: name }))}
            label={`Pipeline of ${name}`}
          />
        ) : (
          <div className="m-card">
            <div className="m-card__body">
              <Timeline
                now={now}
                stages={run.stages.map((entry) => ({
                  name: entry.name,
                  status: entry.status,
                  started: entry.started,
                  finished: entry.finished,
                  needs:
                    run.layout.bubbles.find((b) => b.name === entry.name)
                      ?.needs ?? [],
                }))}
              />
            </div>
          </div>
        )}
      </section>
      <div className="m-runbody">
        <StagePanel
          run={data}
          stage={stage}
          shown={shown}
          following={following != null}
          step={step}
          steps={steps}
          finished={!run.live}
          now={now}
          store={store}
          openAt={openAt}
          unavailable={unavailable}
          stepHref={(next) => href({ stage: shownName, step: next })}
          canRestart={canRequest}
          canDecide={stage != null && canApprove(session, data, stage.name)}
          offline={offline}
          onChanged={reload}
        />
        <StageList {...listProps} />
        <StagePicker {...listProps} current={stage} />
      </div>
      <History data={data} now={now} />
      {canRequest && (
        <RequestSheet
          run={data}
          open={requesting}
          onClose={() => setRequesting(false)}
        />
      )}
    </Page>
  )
}

/** The header's facts: when and how long, where, the commit and who asked. */
function RunMeta({ run, now }: { run: RunView; now: number }): JSX.Element {
  const { data } = run
  const queued = (run.started ?? now) - data.created
  const took =
    run.started == null ? undefined : (run.finished ?? now) - run.started
  const nodes = [
    ...new Set([
      ...(data.details?.nodes ?? []),
      ...run.stages.flatMap((stage) =>
        stage.node == null ? [] : [stage.node],
      ),
    ]),
  ]
  const trigger = data.details?.trigger
  const requester = data.details?.requestedBy ?? ''
  return (
    <div className="m-row m-t-subhead m-secondary m-run__meta">
      <span className="m-row m-run__fact">
        <Icon name="schedule" size="sm" />
        <span
          className="m-num"
          title={new Date(run.started ?? data.created).toISOString()}
        >
          {absoluteTime(run.started ?? data.created, now)}
        </span>
        <span>· queued {duration(queued)}</span>
        {took != null && (
          <span>
            · {run.finished == null ? 'running' : 'took'} {duration(took)}
          </span>
        )}
      </span>
      {nodes.length > 0 && (
        <span className="m-row m-run__fact">
          <Icon name="dns" size="sm" />
          on{' '}
          {nodes.map((node, index) => (
            <span key={node}>
              <span className="m-t-mono-sm">{node}</span>
              {index < nodes.length - 1 ? ', ' : ''}
            </span>
          ))}
        </span>
      )}
      <span className="m-row m-run__fact">
        {data.commit != null && (
          <>
            <Icon name="commit" size="sm" />
            <Tooltip
              content={<span className="m-t-mono-sm">{data.commit}</span>}
            >
              <span className="m-commit__sha" tabIndex={0}>
                {data.commit.slice(0, 8)}
              </span>
            </Tooltip>
          </>
        )}
        {trigger != null && (
          <span data-trigger={trigger}>
            {TRIGGER_WORDS[trigger] ?? trigger}
            {requester === '' ? '' : ` by ${requester}`}
          </span>
        )}
      </span>
    </div>
  )
}

/** Under the description: why it failed or was cancelled, and its parameters. */
function RunDetails({ run }: { run: RunView }): JSX.Element | null {
  const params = Object.entries(run.data.details?.params ?? {})
  if (run.reason == null && params.length === 0) return null
  const cancelled = run.status === 'cancelled'
  return (
    <>
      {run.reason != null && (
        <p
          className={
            cancelled
              ? 'm-run__reason m-secondary'
              : 'm-run__reason m-danger-text'
          }
        >
          <Icon name={cancelled ? 'block' : 'error'} />
          {run.reason}
        </p>
      )}
      {params.length > 0 && (
        <details className="m-run__params">
          <summary className="m-t-subhead m-secondary">
            Parameters ({params.length})
          </summary>
          <pre className="m-t-mono-sm m-well">
            {params
              .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
              .join('\n')}
          </pre>
        </details>
      )}
    </>
  )
}

/** The last runs of the branch's workflow, this one marked. */
function History({ data, now }: { data: RunData; now: number }): JSX.Element {
  const history = data.history ?? []
  return (
    <section className="m-card" aria-labelledby="history-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="history" />
          <h2 className="m-t-title3" id="history-title">
            History of <span className="m-t-mono">{data.branch}</span>
          </h2>
        </div>
      </header>
      {history.length === 0 ? (
        <EmptyState icon="history" title="No runs yet." />
      ) : (
        <div className="m-table-wrap">
          <table className="m-table m-table--stack">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Status</th>
                <th scope="col">Stages</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr
                  key={entry.id}
                  aria-selected={entry.id === data.id ? 'true' : undefined}
                >
                  <td data-primary data-label="Run">
                    <Link to={runHref(entry.id)}>
                      {runName(data.workflow, entry.number)}
                    </Link>
                  </td>
                  <td data-label="Status">
                    <StatusPill status={entry.status} quiet />
                  </td>
                  <td data-label="Stages">
                    <span className="m-row m-run__dots">
                      {entry.stages.map((stage) => (
                        <span
                          key={stage.name}
                          className="m-dot"
                          role="img"
                          aria-label={`${stage.name}: ${statusOf(stage.status).word.toLowerCase()}`}
                          title={`${stage.name}: ${statusOf(stage.status).word.toLowerCase()}`}
                          style={{
                            ['--solid' as string]: `var(--m-${statusOf(stage.status).tone}-solid)`,
                          }}
                        />
                      ))}
                    </span>
                  </td>
                  <td data-label="Started" className="m-secondary">
                    {relativeTime(entry.created, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** The phrase for the latest change of status: "build-ios succeeded", "Run 182 succeeded". */
function useAnnouncements(run: RunView): string {
  const [said, setSaid] = useState('')
  const last = useRef<Map<string, string> | undefined>(undefined)
  const key = [
    `@run:${run.status}`,
    ...run.stages.map((stage) => `${stage.name}:${stage.status}`),
  ].join('\n')
  const name = runName(run.data.workflow, run.data.number)
  useEffect(() => {
    const now = new Map(
      key.split('\n').map((line) => {
        const at = line.lastIndexOf(':')
        return [line.slice(0, at), line.slice(at + 1)] as const
      }),
    )
    const before = last.current
    last.current = now
    if (before == null) return
    const changed = [...now].filter(
      ([what, status]) => before.get(what) !== status,
    )
    if (changed.length === 0) return
    setSaid(
      changed
        .map(
          ([what, status]) =>
            `${what === '@run' ? name : what} ${statusOf(status).word.toLowerCase()}`,
        )
        .join(', '),
    )
  }, [key, name])
  return said
}
