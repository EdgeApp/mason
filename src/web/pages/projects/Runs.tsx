// Runs and builds (screen-03-runs): a project's branches beside the
// selected branch's runs. The list starts with All branches, then the
// branches its push trigger builds (with their globs expanded), then the
// rest by their latest run; the table shows each run's status (kept live),
// version, build number and when it started, with *Show more* for older
// runs. An app ID's own page is the same, narrowed to the runs whose
// workflow publishes it, under the app ID's heading and tabs.
import { useRef, useState, type JSX } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import {
  asProjectRuns,
  projectRunsPath,
  RUNS_LIMIT,
  RUNS_PAGE,
  type ProjectRuns,
} from '../../../shared/api/index.js'
import { relativeTime } from '../../../shared/format.js'
import { useResource, type Resource } from '../../hooks/useResource.js'
import type { Crumb } from '../../layout/Breadcrumbs.js'
import { Page } from '../../layout/Page.js'
import { useRunStatuses } from '../../live/useRunStatuses.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Icon } from '../../ui/Icon.js'
import { StatusPill } from '../../ui/StatusPill.js'
import { runName } from '../artifacts/Artifacts.js'
import { runHref } from '../run/actions.js'
import {
  AppHeading,
  AppTabs,
  appCrumbs,
  appHref,
  Failed,
  Loading,
  PROJECTS,
  ProjectPage,
  projectCrumb,
  projectHref,
  Unknown,
} from './project.js'

/** The runs read for a branch, an app ID and how many. */
export function runsPath(
  slug: string,
  options: {
    branch?: string | undefined
    app?: string | undefined
    limit: number
  },
): string {
  const query = new URLSearchParams()
  if (options.branch != null) query.set('branch', options.branch)
  if (options.app != null) query.set('app', options.app)
  if (options.limit !== RUNS_PAGE) query.set('limit', String(options.limit))
  const text = query.toString()
  return `${projectRunsPath(slug)}${text === '' ? '' : `?${text}`}`
}

/** The branch list: All branches, those built on push, then the rest. */
function BranchList({
  data,
  branch,
  href,
}: {
  data: ProjectRuns
  branch: string | undefined
  href: (branch?: string) => string
}): JSX.Element {
  const now = Date.now()
  const pinned = data.branches.filter((entry) => entry.pinned)
  const others = data.branches.filter((entry) => !entry.pinned)
  const item = (entry: ProjectRuns['branches'][number]): JSX.Element => (
    <Link
      key={entry.branch}
      to={href(entry.branch)}
      aria-current={entry.branch === branch ? 'page' : undefined}
    >
      <span className="m-t-mono m-truncate m-sidelist__name">
        {entry.branch}
      </span>
      <span className="m-t-subhead m-tertiary">
        {entry.at == null ? 'No runs yet' : relativeTime(entry.at, now)}
      </span>
    </Link>
  )
  return (
    <nav className="m-card" aria-label="Branches">
      <div className="m-sidelist">
        <Link to={href()} aria-current={branch == null ? 'page' : undefined}>
          <span className="m-row">
            <Icon name="fork_right" />
            <strong className="m-t-callout">All branches</strong>
          </span>
        </Link>
        {pinned.length > 0 && (
          <p className="m-t-eyebrow m-sidelist__eyebrow">Build on push</p>
        )}
        {pinned.map(item)}
        {pinned.length > 0 && others.length > 0 && <hr />}
        {others.map(item)}
      </div>
    </nav>
  )
}

/** The runs, newest first, with their live status, and *Show more*. */
function RunsTable({
  data,
  branch,
  loadingMore,
  showMore,
}: {
  data: ProjectRuns
  branch: string | undefined
  loadingMore: boolean
  showMore: () => void
}): JSX.Element {
  const statuses = useRunStatuses(data.runs)
  const now = Date.now()
  return (
    <section className="m-card" aria-labelledby="runs-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <h2
            className={branch == null ? 'm-t-title3' : 'm-t-title3 m-t-mono'}
            id="runs-title"
          >
            {branch ?? 'All branches'}
          </h2>
          {data.runs.length > 0 && (
            <span className="m-count">{data.runs.length} latest</span>
          )}
        </div>
      </header>
      {data.runs.length === 0 ? (
        <EmptyState icon="history" title="No runs yet." />
      ) : (
        <div className="m-table-wrap">
          <table className="m-table m-table--stack m-runs">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Version</th>
                <th scope="col">Build number</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <tr key={run.id} data-run-id={run.id}>
                  <td data-primary data-label="Run">
                    <Link to={runHref(run.id)} className="m-row m-runs__run">
                      <StatusPill
                        quiet
                        status={statuses[run.id] ?? run.status}
                      />
                      <span className="m-list__main">
                        <span className="m-t-headline">
                          {runName(run.workflow, run.number)}
                        </span>
                        {branch == null && (
                          <span className="m-t-mono-sm m-secondary m-wrap-any">
                            {run.branch}
                          </span>
                        )}
                      </span>
                    </Link>
                  </td>
                  <td data-label="Version" className="m-t-mono">
                    {run.version === '' ? '—' : run.version}
                  </td>
                  <td data-label="Build number" className="m-t-mono">
                    {run.buildNumber === '' ? '—' : run.buildNumber}
                  </td>
                  <td data-label="Started" className="m-secondary">
                    {relativeTime(run.at, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.more && (
        <footer className="m-card__footer">
          <span className="m-t-subhead m-tertiary">
            Showing the {data.runs.length} latest
          </span>
          <Button
            variant="secondary"
            size="sm"
            busy={loadingMore}
            onClick={showMore}
          >
            Show more
          </Button>
        </footer>
      )}
    </section>
  )
}

/** A project's or an app ID's runs, kept while a longer list loads, read again when the queue changes. */
function useRuns(
  slug: string,
  branch: string | undefined,
  app?: string,
): {
  data: ProjectRuns | undefined
  read: Resource<ProjectRuns>
  showMore: () => void
} {
  const [limit, setLimit] = useState(RUNS_PAGE)
  const scope = `${branch ?? ''}\n${app ?? ''}`
  const [askedFor, setAskedFor] = useState(scope)
  // Another branch starts again from the first page.
  if (askedFor !== scope) {
    setAskedFor(scope)
    setLimit(RUNS_PAGE)
  }
  const read = useResource(
    runsPath(slug, { branch, app, limit }),
    asProjectRuns,
    { invalidatedBy: ['queue'] },
  )
  const shown = useRef<{ scope: string; data: ProjectRuns } | undefined>(
    undefined,
  )
  if (read.data != null) shown.current = { scope, data: read.data }
  return {
    data:
      read.data ??
      (shown.current?.scope === scope ? shown.current.data : undefined),
    read,
    showMore: () => setLimit((was) => Math.min(RUNS_LIMIT, was + RUNS_PAGE)),
  }
}

/** The branch list beside the runs, or the read's own state. */
function RunsAndBuilds({
  runs,
  branch,
  href,
}: {
  runs: ReturnType<typeof useRuns>
  branch: string | undefined
  href: (branch?: string) => string
}): JSX.Element {
  const { data, read } = runs
  if (data == null)
    return read.error != null ? (
      <Failed
        what="The runs"
        message={read.error.message}
        retry={read.reload}
      />
    ) : (
      <Loading label="Loading the runs" />
    )
  return (
    <div className="m-master-detail">
      <BranchList data={data} branch={branch} href={href} />
      <RunsTable
        data={data}
        branch={branch}
        loadingMore={read.loading}
        showMore={runs.showMore}
      />
    </div>
  )
}

/** The branch the address names. */
const useBranch = (): string | undefined => {
  const [params] = useSearchParams()
  const branch = params.get('branch')
  return branch == null || branch === '' ? undefined : branch
}

/** A project's Runs and builds, under its header. */
function ProjectRuns({
  slug,
  branch,
}: {
  slug: string
  branch: string | undefined
}): JSX.Element {
  const runs = useRuns(slug, branch)
  return (
    <RunsAndBuilds
      runs={runs}
      branch={branch}
      href={(name) => projectHref(slug, 'runs', { branch: name })}
    />
  )
}

/** `/projects/:slug/runs`, both nodes. */
export function ProjectRunsPage(): JSX.Element {
  const { slug = '' } = useParams()
  const branch = useBranch()
  const crumbs: Crumb[] =
    branch == null
      ? [{ label: 'Runs and builds' }]
      : [
          { label: 'Runs and builds', to: projectHref(slug, 'runs') },
          { label: branch },
        ]
  return (
    <ProjectPage
      slug={slug}
      tab="runs"
      title="Runs and builds"
      crumbs={crumbs}
      description={
        branch == null
          ? 'The latest runs on every branch.'
          : `The latest runs on ${branch}.`
      }
    >
      {() => <ProjectRuns slug={slug} branch={branch} />}
    </ProjectPage>
  )
}

/** `/projects/:slug/apps/:appId`, both nodes: the app ID's own Runs and builds. */
export function AppRunsPage(): JSX.Element {
  const { slug = '', appId = '' } = useParams()
  const branch = useBranch()
  const runs = useRuns(slug, branch, appId)
  if (runs.data == null && runs.read.error?.status === 404)
    return (
      <Unknown
        crumbs={[
          PROJECTS,
          projectCrumb(slug, slug),
          { label: 'App ID unavailable' },
        ]}
        title="App ID unavailable"
        text="There is no such app ID in this project."
      />
    )
  const app = runs.data?.app
  return (
    <Page
      crumbs={appCrumbs(slug, runs.data?.name ?? slug, appId, 'runs', branch)}
      title={`${appId} · Runs and builds`}
      heading={
        <span className="m-t-mono m-wrap-any m-title-mono">{appId}</span>
      }
      description={
        app == null ? undefined : (
          <AppHeading name={app.name} platforms={app.platforms} />
        )
      }
    >
      <AppTabs slug={slug} appId={appId} current="runs" />
      <RunsAndBuilds
        runs={runs}
        branch={branch}
        href={(name) => appHref(slug, appId, 'runs', { branch: name })}
      />
    </Page>
  )
}
