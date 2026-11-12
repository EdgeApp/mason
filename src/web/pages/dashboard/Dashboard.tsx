// Projects & apps (DESIGN-LANGUAGE.md §14, screen-01-dashboard): the tiles,
// the platform pills and the app-ID filter, each project's card with its
// latest commit, latest runs and app IDs with their builds, and the aside
// (the queue, the master's workers, the latest builds). The queue and the
// run chips stay current from /live.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  asDashboardData,
  asQueue,
  DASHBOARD_PATH,
  platformNames,
  type DashboardData,
  type ProjectCard,
  type QueueEntry,
} from '../../../shared/api/index.js'
import {
  bytes,
  duration,
  relativeTime,
  shortAge,
} from '../../../shared/format.js'
import { Page } from '../../layout/Page.js'
import { useShell } from '../../layout/ShellContext.js'
import { useResource } from '../../hooks/useResource.js'
import { useInvalidations, useLive } from '../../live/LiveProvider.js'
import { useRunStatuses } from '../../live/useRunStatuses.js'
import { useProfile } from '../../profile/NodeProfile.js'
import { Count } from '../../ui/Badge.js'
import { Button, ButtonLink } from '../../ui/Button.js'
import { Chip } from '../../ui/Chip.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { FilterPills } from '../../ui/FilterPills.js'
import { Icon } from '../../ui/Icon.js'
import { platformLook } from '../../ui/platform.js'
import { MoreChip, PlatformChip, RunChip } from '../../ui/RunChip.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { StatTile, Gauge, Meter } from '../../ui/StatTile.js'
import { StatusPill } from '../../ui/StatusPill.js'

/** How many builds an app ID's row shows before "+N more". */
export const BUILD_CHIPS = 6

const runHref = (id: string): string => `/runs/${encodeURIComponent(id)}`
const projectHref = (slug: string): string =>
  `/projects/${encodeURIComponent(slug)}`
const appHref = (project: string, app: string): string =>
  `${projectHref(project)}/apps/${encodeURIComponent(app)}`

/** The dashboard's read for the page's filter. */
export function dashboardPath(params: URLSearchParams): string {
  const query = new URLSearchParams()
  const platform = params.get('platform')
  const project = params.get('project')
  if (project != null && project !== '') query.set('project', project)
  if (platform != null && platform !== '') query.set('platform', platform)
  const text = query.toString()
  return text === '' ? DASHBOARD_PATH : `${DASHBOARD_PATH}?${text}`
}

/**
 * The run chips a project's card shows: a run the queue names that the
 * card has no chip for takes the front, in place of its branch's chip.
 */
export function withQueued(
  card: ProjectCard,
  queue: readonly QueueEntry[],
): ProjectCard['runs'] {
  let runs = [...card.runs]
  for (const entry of queue) {
    if (entry.project !== card.slug) continue
    if (runs.some((run) => run.id === entry.job)) continue
    runs = [
      {
        id: entry.job,
        branch: entry.branch,
        number: entry.number,
        status: entry.status === 'queued' ? 'queued' : 'running',
        workflow: entry.workflow,
      },
      ...runs.filter((run) => run.branch !== entry.branch),
    ]
  }
  return runs
}

/**
 * Whether an app ID matches the filter field's text, by its ID or name;
 * every app of a project whose name matches does.
 */
export function filterApps(
  card: ProjectCard,
  text: string,
): ProjectCard['apps'] | undefined {
  const needle = text.trim().toLowerCase()
  if (needle === '') return card.apps
  if (
    card.name.toLowerCase().includes(needle) ||
    card.slug.toLowerCase().includes(needle)
  )
    return card.apps
  const apps = card.apps.filter(
    (app) =>
      app.slug.toLowerCase().includes(needle) ||
      app.name.toLowerCase().includes(needle),
  )
  return apps.length === 0 ? undefined : apps
}

/** The four tiles. */
function Tiles({ data }: { data: DashboardData }): JSX.Element {
  const { tiles, counts } = data
  const rate = tiles.successRate == null ? undefined : tiles.successRate * 100
  const [storage, unit] = bytes(tiles.storage).split(' ')
  const filtered = data.filter.platform != null || data.filter.project != null
  const names = data.projects.map((card) => card.slug)
  return (
    <section className="m-tiles" aria-label="Summary">
      <StatTile
        label="Projects"
        icon="folder"
        value={tiles.projects}
        foot={
          !filtered && names.length > 0 ? (
            <span className="m-t-mono-sm m-wrap-any">
              {names.slice(0, 3).join(', ')}
              {names.length > 3 ? ` +${names.length - 3}` : ''}
            </span>
          ) : undefined
        }
      />
      <StatTile label="App IDs" icon="apps" value={tiles.apps}>
        <Meter
          parts={platformNames.map((key) => ({
            label: platformLook(key).name,
            value: counts[key],
            series: platformLook(key).series,
          }))}
        />
      </StatTile>
      <StatTile
        label="Success rate"
        value={rate == null ? '—' : `${rate.toFixed(1)}%`}
        foot={
          <span>
            {tiles.finished === 0
              ? 'No finished runs in 30 days'
              : `${tiles.finished} ${tiles.finished === 1 ? 'run' : 'runs'} in 30 days`}
          </span>
        }
        gauge={
          rate == null ? (
            <Icon name="speed" className="m-stat__icon" />
          ) : (
            <Gauge
              percent={rate}
              label={`${rate.toFixed(1)} percent of finished runs succeeded`}
            />
          )
        }
      />
      <StatTile
        label="Artifact storage"
        icon="storage"
        value={storage}
        unit={unit!}
        foot={<span>Builds and run artifacts</span>}
      />
    </section>
  )
}

/** One app ID's row: its ID, name and platforms, and each branch's latest build. */
function AppRow({
  project,
  app,
  now,
  statuses,
}: {
  project: string
  app: ProjectCard['apps'][number]
  now: number
  statuses: Record<string, string>
}): JSX.Element {
  const href = appHref(project, app.slug)
  const more = Math.max(app.builds.length, app.branches) - BUILD_CHIPS
  const first = app.platforms[0]
  return (
    <li className="m-approw">
      <span className="m-glyphbox">
        <Icon name={first == null ? 'apps' : platformLook(first).icon} />
      </span>
      <span className="m-list__main">
        <Link to={href} className="m-t-mono m-approw__id">
          {app.slug}
        </Link>
        <span className="m-list__sub">{app.name}</span>
        {app.platforms.length > 0 && (
          <span className="m-row m-approw__platforms">
            {app.platforms.map((platform) => (
              <PlatformChip key={platform} platform={platform} />
            ))}
          </span>
        )}
      </span>
      <span className="m-runchips">
        {app.builds.length === 0 ? (
          <span className="m-t-callout m-secondary">No builds yet</span>
        ) : (
          app.builds.slice(0, BUILD_CHIPS).map((build) => {
            const status =
              build.run == null
                ? build.status
                : (statuses[build.run] ?? build.status)
            return (
              <RunChip
                key={build.branch}
                build
                branch={build.branch}
                number={build.buildNumber}
                age={shortAge(build.at, now)}
                {...(status == null ? {} : { status })}
                {...(build.run == null ? {} : { to: runHref(build.run) })}
              />
            )
          })
        )}
        {more > 0 && (
          <MoreChip
            count={more}
            to={href}
            name={`${more} more branches of ${app.slug}`}
          />
        )}
      </span>
    </li>
  )
}

/** A project's card. */
function ProjectCardView({
  card,
  apps,
  queue,
  now,
  statuses,
}: {
  card: ProjectCard
  apps: ProjectCard['apps']
  queue: readonly QueueEntry[]
  now: number
  statuses: Record<string, string>
}): JSX.Element {
  const runs = withQueued(card, queue)
  return (
    <article
      className="m-card"
      id={`project-${card.slug}`}
      aria-labelledby={`project-${card.slug}-title`}
    >
      <header className="m-card__header m-card__header--top">
        <span className="m-glyphbox m-glyphbox--accent">
          <Icon name="folder" />
        </span>
        <div className="m-list__main">
          <Link to={projectHref(card.slug)} className="m-row m-project__link">
            <h2 className="m-t-title2" id={`project-${card.slug}-title`}>
              {card.name}
            </h2>
            {card.defaultBranch != null && (
              <Chip kind="mono" title="Default branch">
                <span className="m-sr">Default branch</span>{' '}
                {card.defaultBranch}
              </Chip>
            )}
          </Link>
          {card.repository != null && (
            <span className="m-t-mono-sm m-secondary m-wrap-any">
              {card.repository}
            </span>
          )}
        </div>
        {card.webhook != null && (
          <StatusPill
            quiet
            status={card.webhook ? 'active' : 'not_set_up'}
            label={card.webhook ? 'Webhook active' : 'Webhook not set up'}
          />
        )}
      </header>
      <div className="m-card__body m-stack">
        {card.latest != null && (
          <div className="m-well m-commit">
            <span className="m-commit__sha" title={card.latest.commit}>
              {card.latest.commit.slice(0, 8)}
            </span>
            <span className="m-commit__msg">
              {card.latest.description === ''
                ? 'No description'
                : card.latest.description}
            </span>
            <span className="m-commit__time">
              {relativeTime(card.latest.at, now)}
            </span>
          </div>
        )}
        <div className="m-stack m-stack--tight">
          <div className="m-row m-row--between">
            <h3 className="m-t-eyebrow">Latest runs</h3>
            <Link to={`${projectHref(card.slug)}/runs`} className="m-t-subhead">
              Runs and builds
            </Link>
          </div>
          {runs.length === 0 ? (
            <p className="m-t-callout m-secondary">No runs yet.</p>
          ) : (
            <div className="m-runchips">
              {runs.map((run) => (
                <RunChip
                  key={run.id}
                  branch={run.branch}
                  number={run.number}
                  status={statuses[run.id] ?? run.status}
                  to={runHref(run.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="m-card__section">
        <h3 className="m-t-eyebrow">
          App IDs <Count count={apps.length} />
        </h3>
      </div>
      {apps.length === 0 ? (
        <div className="m-card__body m-card__body--after">
          <p className="m-t-callout m-secondary">No app IDs.</p>
        </div>
      ) : (
        <ul className="m-list" aria-label={`${card.name} app IDs`}>
          {apps.map((app) => (
            <AppRow
              key={app.id}
              project={card.slug}
              app={app}
              now={now}
              statuses={statuses}
            />
          ))}
        </ul>
      )}
    </article>
  )
}

/** A panel of the aside, with its title and what it holds. */
function Panel({
  icon,
  title,
  end,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name']
  title: string
  end?: JSX.Element
  children: JSX.Element
}): JSX.Element {
  return (
    <section className="m-card" aria-label={title}>
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name={icon} />
          <h2 className="m-t-title3">{title}</h2>
        </div>
        {end}
      </header>
      {children}
    </section>
  )
}

/** A panel's empty line. */
const Nothing = ({ text }: { text: string }): JSX.Element => (
  <div className="m-card__body">
    <p className="m-t-callout m-secondary">{text}</p>
  </div>
)

/** The queue: running stages, then queued ones, with their progress. */
export function QueuePanel({
  queue,
}: {
  queue: readonly QueueEntry[]
}): JSX.Element {
  const running = queue.filter((entry) => entry.status === 'running').length
  return (
    <Panel
      icon="hourglass_top"
      title="Queue"
      end={<span className="m-count">{running} running</span>}
    >
      {queue.length === 0 ? (
        <Nothing text="Nothing is running." />
      ) : (
        <ul className="m-list">
          {queue.map((entry) => {
            const percent =
              entry.progress == null
                ? undefined
                : Math.round(entry.progress * 100)
            return (
              <li
                key={`${entry.job}-${entry.stage}`}
                className="m-list__row m-queue__entry"
              >
                <div className="m-row m-row--between">
                  <span className="m-t-mono m-queue__name">
                    {entry.project} · {entry.stage}
                  </span>
                  <StatusPill quiet status={entry.status} />
                </div>
                <span className="m-t-subhead m-secondary">
                  Run {entry.number}
                  {entry.workflow === 'build'
                    ? ''
                    : ` · ${entry.workflow}`} ·{' '}
                  <span className="m-t-mono-sm">{entry.branch}</span>
                  {entry.elapsed == null ? '' : ` · ${duration(entry.elapsed)}`}
                </span>
                {percent != null && (
                  <div
                    className="m-progress"
                    role="progressbar"
                    aria-valuenow={percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${entry.stage}, about ${percent}% of its usual time`}
                  >
                    <span
                      className="m-progress__running"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

/** The master's workers. */
function WorkersPanel({
  nodes,
  link,
}: {
  nodes: NonNullable<DashboardData['nodes']>
  link: boolean
}): JSX.Element {
  return (
    <Panel
      icon="dns"
      title="Worker nodes"
      {...(link
        ? {
            end: (
              <Link className="m-t-subhead" to="/nodes">
                Nodes
              </Link>
            ),
          }
        : {})}
    >
      {nodes.length === 0 ? (
        <Nothing text="No nodes are linked." />
      ) : (
        <ul className="m-list">
          {nodes.map((node) => (
            <li key={node.name} className="m-list__row m-list__row--compact">
              <span className="m-list__main">
                <span className="m-t-mono m-queue__name">{node.name}</span>
                <span className="m-list__sub m-t-mono-sm">{node.detail}</span>
              </span>
              <StatusPill quiet status={node.status} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** The latest published builds. */
function BuildsPanel({
  builds,
  now,
}: {
  builds: DashboardData['builds']
  now: number
}): JSX.Element {
  return (
    <Panel icon="deployed_code" title="Recent builds">
      {builds.length === 0 ? (
        <Nothing text="No builds yet." />
      ) : (
        <ul className="m-list">
          {builds.map((build) => (
            <li key={build.id} className="m-list__row">
              <span className="m-list__main">
                <span className="m-t-mono m-queue__name">
                  {build.app} {build.version}{' '}
                  <span className="m-tertiary">({build.buildNumber})</span>
                </span>
                <span className="m-row m-t-subhead m-secondary">
                  <PlatformChip platform={build.platform} />
                  <span className="m-t-mono-sm">{build.branch}</span>
                  <span>
                    · {bytes(build.size)} · {relativeTime(build.at, now)}
                  </span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** The page while its first read is under way: shaped like the page. */
function Loading(): JSX.Element {
  return (
    <div className="m-stack" role="status" aria-label="Loading projects">
      <div className="m-tiles">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="m-card m-stat">
            <Skeleton width="40%" height="0.75rem" />
            <Skeleton width="30%" height="2rem" />
          </div>
        ))}
      </div>
      <Skeleton width="20rem" height="2.5rem" pill />
      <div className="m-card m-card__body m-stack">
        <Skeleton width="50%" height="1.5rem" />
        <Skeleton height="2.5rem" />
        <Skeleton width="70%" />
      </div>
    </div>
  )
}

/** Projects & apps. */
export function DashboardPage({
  crumbs,
}: {
  crumbs?: Array<{ label: string; to?: string }>
}): JSX.Element {
  const { session, nav } = useShell()
  const profile = useProfile()
  const [params, setParams] = useSearchParams()
  const path = dashboardPath(params)
  const read = useResource(path, asDashboardData, { invalidatedBy: ['queue'] })
  const invalidations = useInvalidations()
  const [text, setText] = useState('')
  const [live, setLive] = useState<QueueEntry[] | undefined>()
  const [announcement, setAnnouncement] = useState('')
  const first = useRef(true)
  const data = read.data

  // A new answer has the queue as of its read.
  useEffect(() => setLive(undefined), [data])

  const onQueue = useCallback(
    (frame: { event: string; data?: unknown }) => {
      if (frame.event !== 'queue') return
      let entries: QueueEntry[]
      try {
        entries = asQueue(frame.data)
      } catch {
        return
      }
      setLive(entries)
      // The first frame is the queue as the page subscribed; later ones change it.
      if (first.current) {
        first.current = false
        return
      }
      const running = entries.filter((entry) => entry.status === 'running')
      setAnnouncement(
        entries.length === 0
          ? 'Nothing is running'
          : `${running.length} running, ${entries.length - running.length} queued`,
      )
      invalidations.invalidate('queue')
    },
    [invalidations],
  )
  useLive('dashboard-queue', { subscribe: 'queue' }, onQueue)

  const queue = live ?? data?.queue ?? []
  const statuses = useRunStatuses(
    useMemo(
      () =>
        (data?.projects ?? []).flatMap((card) => [
          ...withQueued(card, queue),
          ...card.apps.flatMap((app) =>
            app.builds.flatMap((build) =>
              build.run == null
                ? []
                : [{ id: build.run, status: build.status }],
            ),
          ),
        ]),
      [data, queue],
    ),
  )

  const setFilter = (name: 'platform' | 'project', value?: string): void => {
    const next = new URLSearchParams(params)
    if (value == null || value === '') next.delete(name)
    else next.set(name, value)
    setParams(next)
  }

  const canAdd =
    profile.role === 'master' && session.permissions.includes('projects.change')
  const now = Date.now()
  const shown =
    data?.projects.flatMap((card) => {
      const apps = filterApps(card, text)
      return apps == null ? [] : [{ card, apps }]
    }) ?? []
  const project = data?.filter.project

  return (
    <Page
      crumbs={crumbs ?? [{ label: 'Projects & apps' }]}
      title="Projects & apps"
      description="Every project’s app IDs, their latest builds and runs."
      {...(canAdd
        ? {
            actions: (
              <ButtonLink variant="primary" icon="add" to="/projects/new">
                Add project
              </ButtonLink>
            ),
          }
        : {})}
    >
      <p className="m-sr" role="status" aria-live="polite">
        {announcement}
      </p>
      {data == null ? (
        read.error != null ? (
          <section className="m-card">
            <EmptyState
              icon="error"
              tone="danger"
              title="Projects & apps could not be read"
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
          <Loading />
        )
      ) : (
        <>
          <Tiles data={data} />
          <div className="m-row m-row--between">
            <div className="m-row">
              <FilterPills
                label="Platform"
                value={data.filter.platform ?? 'all'}
                onChange={(key) =>
                  setFilter('platform', key === 'all' ? undefined : key)
                }
                options={(['all', ...platformNames] as const)
                  .filter((key) => key === 'all' || data.counts[key] > 0)
                  .map((key) => ({
                    key,
                    label: key === 'all' ? 'All' : platformLook(key).name,
                    count: data.counts[key],
                  }))}
              />
              {project != null && (
                <button
                  type="button"
                  className="m-chip m-chip--accent m-chip--remove"
                  onClick={() => setFilter('project')}
                  aria-label={`Show every project, not only ${project}`}
                >
                  <Icon name="folder" />
                  {data.projects[0]?.name ?? project}
                  <Icon name="close" />
                </button>
              )}
            </div>
            <div className="m-affix m-dashboard__filter">
              <Icon name="search" />
              <input
                className="m-input"
                type="search"
                placeholder="Filter app IDs"
                aria-label="Filter app IDs"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
          </div>
          <div className="m-split">
            <div className="m-stack m-stack--lg">
              {shown.length === 0 ? (
                <section className="m-card">
                  <EmptyState icon="folder" title="No projects match.">
                    {data.projects.length === 0 && text === ''
                      ? undefined
                      : 'Clear the filter or choose another platform.'}
                  </EmptyState>
                </section>
              ) : (
                shown.map(({ card, apps }) => (
                  <ProjectCardView
                    key={card.id}
                    card={card}
                    apps={apps}
                    queue={queue}
                    now={now}
                    statuses={statuses}
                  />
                ))
              )}
            </div>
            <aside className="m-stack" aria-label="Cluster activity">
              <QueuePanel queue={queue} />
              {data.nodes != null && (
                <WorkersPanel
                  nodes={data.nodes}
                  link={nav.some((entry) => entry.key === 'nodes')}
                />
              )}
              <BuildsPanel builds={data.builds} now={now} />
            </aside>
          </div>
        </>
      )}
    </Page>
  )
}
