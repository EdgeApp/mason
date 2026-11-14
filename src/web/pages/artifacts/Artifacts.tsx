// Artifacts (DESIGN-LANGUAGE.md §14, screen-05-artifacts): the latest runs,
// narrowed by project and branch, and a run's detail at `?run=`: its
// stages, tests, published builds (Install or Download on the host) and
// saved artifacts. Unfinished runs keep their status from /live.
import { useEffect, useRef, type JSX } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  ARTIFACTS_PATH,
  artifactRunPath,
  asArtifactRunDetail,
  asArtifactsList,
  type ArtifactRunDetail,
  type ArtifactsList,
} from '../../../shared/api/index.js'
import {
  absoluteTime,
  bytes,
  count,
  duration,
  relativeTime,
} from '../../../shared/format.js'
import { Page } from '../../layout/Page.js'
import type { Crumb } from '../../layout/Breadcrumbs.js'
import { useResource } from '../../hooks/useResource.js'
import { useRunStatuses } from '../../live/useRunStatuses.js'
import { useProfile } from '../../profile/NodeProfile.js'
import { Count } from '../../ui/Badge.js'
import { Button, ButtonLink, buttonClass } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Icon } from '../../ui/Icon.js'
import type { IconName } from '../../ui/icons.js'
import { PlatformChip } from '../../ui/RunChip.js'
import { SkeletonText } from '../../ui/Skeleton.js'
import { StatusPill } from '../../ui/StatusPill.js'
import { statusOf } from '../../ui/status.js'

const TITLE = 'Artifacts'
const DESCRIPTION =
  'Each run’s saved artifacts, test results and published builds.'

/** A run's name: `Run 12`, or `Run 12 · deploy` for another workflow. */
export const runName = (workflow: string, number: number): string =>
  `Run ${number}${workflow === 'build' ? '' : ` · ${workflow}`}`

/** The Artifacts address for a filter (project, branch) or a run. */
export function artifactsHref(filter: {
  project?: string | undefined
  branch?: string | undefined
  run?: string | undefined
}): string {
  const query = new URLSearchParams()
  if (filter.run != null) query.set('run', filter.run)
  if (filter.project != null) query.set('project', filter.project)
  if (filter.branch != null) query.set('branch', filter.branch)
  const text = query.toString()
  return text === '' ? '/artifacts' : `/artifacts?${text}`
}

/** The list's read for its filter. */
export function listPath(project?: string, branch?: string): string {
  return artifactsHref({ project, branch }).replace(
    '/artifacts',
    ARTIFACTS_PATH,
  )
}

/** A read that failed: what went wrong and a way to try again. */
function Failed({
  what,
  message,
  retry,
}: {
  what: string
  message: string
  retry: () => void
}): JSX.Element {
  return (
    <section className="m-card">
      <EmptyState
        icon="error"
        tone="danger"
        title={`${what} could not be read`}
        actions={
          <Button variant="secondary" icon="refresh" onClick={retry}>
            Retry
          </Button>
        }
      >
        {message}
      </EmptyState>
    </section>
  )
}

/** The project and branch selects. */
function Filters({
  list,
  project,
  branch,
  choose,
}: {
  list: ArtifactsList | undefined
  project: string | undefined
  branch: string | undefined
  choose: (project?: string, branch?: string) => void
}): JSX.Element {
  const projects = list?.projects ?? []
  const branches = list?.branches ?? []
  const projectOptions =
    project == null || projects.some((entry) => entry.slug === project)
      ? projects
      : [...projects, { slug: project, name: list?.project?.name ?? project }]
  const branchOptions =
    branch == null || branches.includes(branch)
      ? branches
      : [...branches, branch]
  return (
    <div className="m-row m-row--between">
      <div className="m-row m-artifacts__filters">
        <select
          className="m-select m-select--auto"
          aria-label="Project"
          value={project ?? ''}
          onChange={(event) =>
            choose(event.target.value === '' ? undefined : event.target.value)
          }
        >
          <option value="">All projects</option>
          {projectOptions.map((entry) => (
            <option key={entry.slug} value={entry.slug}>
              {entry.name}
            </option>
          ))}
        </select>
        {project != null && (
          <select
            className="m-select m-select--auto"
            aria-label="Branch"
            value={branch ?? ''}
            onChange={(event) =>
              choose(
                project,
                event.target.value === '' ? undefined : event.target.value,
              )
            }
          >
            <option value="">All branches</option>
            {branchOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>
      <span className="m-t-subhead m-tertiary">50 most recent runs</span>
    </div>
  )
}

/** The latest runs, as a table that stacks on narrow content. */
function RunsTable({ list }: { list: ArtifactsList }): JSX.Element {
  const statuses = useRunStatuses(list.runs)
  const now = Date.now()
  if (list.runs.length === 0)
    return (
      <section className="m-card">
        <EmptyState icon="inventory_2" title="No runs yet." />
      </section>
    )
  return (
    <section className="m-card" aria-label="Runs">
      <div className="m-table-wrap">
        <table className="m-table m-table--stack">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Branch</th>
              <th scope="col">Status</th>
              <th scope="col">Builds</th>
              <th scope="col" className="m-right">
                Artifacts
              </th>
              <th scope="col">Started</th>
            </tr>
          </thead>
          <tbody>
            {list.runs.map((run) => (
              <tr key={run.id}>
                <td data-primary data-label="Run">
                  <Link
                    className="m-t-headline"
                    to={artifactsHref({ run: run.id })}
                  >
                    {run.project.slug} {runName(run.workflow, run.number)}
                  </Link>
                </td>
                <td data-label="Branch" className="m-t-mono m-wrap-any">
                  {run.branch}
                </td>
                <td data-label="Status">
                  <StatusPill quiet status={statuses[run.id] ?? run.status} />
                </td>
                <td data-label="Builds" className="m-t-mono-sm">
                  {run.builds === 0
                    ? '—'
                    : `${run.buildNumbers.join(', ')} · ${run.builds} ${run.builds === 1 ? 'file' : 'files'}`}
                </td>
                <td data-label="Artifacts" className="m-num">
                  {run.artifacts.count === 0
                    ? '—'
                    : `${count(run.artifacts.count)} · ${bytes(run.artifacts.size)}`}
                </td>
                <td data-label="Started" className="m-secondary">
                  {relativeTime(run.created, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** The latest runs of every project, or of one and its branch. */
function ArtifactsList({
  project,
  branch,
}: {
  project: string | undefined
  branch: string | undefined
}): JSX.Element {
  const [, setParams] = useSearchParams()
  const read = useResource(listPath(project, branch), asArtifactsList)
  // The filters keep their options while a narrower list loads.
  const options = useRef<ArtifactsList | undefined>(undefined)
  if (read.data != null) options.current = read.data
  const list = read.data
  const crumbs: Crumb[] = [{ label: TITLE, to: '/artifacts' }]
  if (project != null)
    crumbs.push({
      label: list?.project?.name ?? project,
      to: artifactsHref({ project }),
    })
  if (branch != null) crumbs.push({ label: branch })
  return (
    <Page crumbs={crumbs} title={TITLE} description={DESCRIPTION}>
      <Filters
        list={list ?? options.current}
        project={project}
        branch={branch}
        choose={(nextProject, nextBranch) => {
          const query = new URLSearchParams()
          if (nextProject != null) query.set('project', nextProject)
          if (nextBranch != null) query.set('branch', nextBranch)
          setParams(query)
        }}
      />
      {list != null ? (
        <RunsTable list={list} />
      ) : read.error != null ? (
        <Failed
          what="The runs"
          message={read.error.message}
          retry={read.reload}
        />
      ) : (
        <section className="m-card m-card__body">
          <SkeletonText lines={5} label="Loading the runs" />
        </section>
      )}
    </Page>
  )
}

/** A card of the run detail. */
function DetailCard({
  icon,
  title,
  end,
  children,
}: {
  icon?: IconName
  title: string
  end?: JSX.Element
  children: JSX.Element
}): JSX.Element {
  return (
    <section className="m-card" aria-label={title}>
      <header className="m-card__header">
        <div className="m-card__title">
          {icon != null && <Icon name={icon} />}
          <h2 className="m-t-title3">{title}</h2>
          {end}
        </div>
      </header>
      {children}
    </section>
  )
}

/** A card's empty line. */
const Nothing = ({ text }: { text: string }): JSX.Element => (
  <div className="m-card__body">
    <p className="m-t-callout m-secondary">{text}</p>
  </div>
)

/** `report` → `Report`. */
const kindWord = (kind: string): string =>
  kind.charAt(0).toUpperCase() + kind.slice(1)

/** The tests the run's stages reported: totals, then each stage when there are several. */
function Tests({ tests }: { tests: ArtifactRunDetail['tests'] }): JSX.Element {
  const total = tests.reduce(
    (sum, entry) => ({
      passed: sum.passed + entry.passed,
      failed: sum.failed + entry.failed,
      skipped: sum.skipped + entry.skipped,
    }),
    { passed: 0, failed: 0, skipped: 0 },
  )
  const figure = (value: number, word: string, danger = false): JSX.Element => (
    <span>
      <span
        className={`m-t-metric m-metric--sm${danger && value > 0 ? ' m-danger-text' : ''}`}
      >
        {count(value)}
      </span>{' '}
      <span className="m-secondary">{word}</span>
    </span>
  )
  return (
    <DetailCard icon="check_circle" title="Tests">
      <>
        <div className="m-card__body">
          <div className="m-row m-tests__totals">
            {figure(total.passed, 'passed')}
            {figure(total.failed, 'failed', true)}
            {figure(total.skipped, 'skipped')}
          </div>
        </div>
        {tests.length > 1 && (
          <ul className="m-list">
            {tests.map((entry, n) => (
              <li
                key={`${entry.stage}-${n}`}
                className="m-list__row m-list__row--compact"
              >
                <span className="m-list__main m-t-mono">{entry.stage}</span>
                <span className="m-t-subhead m-secondary">
                  {entry.passed} passed ·{' '}
                  <span className={entry.failed > 0 ? 'm-danger-text' : ''}>
                    {entry.failed} failed
                  </span>{' '}
                  · {entry.skipped} skipped
                </span>
              </li>
            ))}
          </ul>
        )}
      </>
    </DetailCard>
  )
}

/** A run's stages, tests, published builds and saved artifacts. */
function RunDetail({ id }: { id: string }): JSX.Element {
  const profile = useProfile()
  const read = useResource(artifactRunPath(id), asArtifactRunDetail)
  const detail = read.data
  const statuses = useRunStatuses(
    detail == null ? [] : [{ id: detail.run.id, status: detail.run.status }],
  )
  const live = statuses[id]
  // A status /live reports reads the run again: stages, builds and artifacts change with it.
  const reload = read.reload
  useEffect(() => {
    if (live != null) reload()
  }, [live, reload])

  if (detail == null) {
    if (read.error?.status === 404)
      return (
        <Page
          crumbs={[
            { label: TITLE, to: '/artifacts' },
            { label: 'Run unavailable' },
          ]}
          title="Run unavailable"
        >
          <section className="m-card">
            <EmptyState
              icon="inventory_2"
              title="There is no such run."
              actions={
                <ButtonLink variant="secondary" to="/artifacts">
                  All runs
                </ButtonLink>
              }
            />
          </section>
        </Page>
      )
    return (
      <Page
        crumbs={[{ label: TITLE, to: '/artifacts' }, { label: 'Run' }]}
        title="Run"
      >
        {read.error != null ? (
          <Failed what="The run" message={read.error.message} retry={reload} />
        ) : (
          <section className="m-card m-card__body">
            <SkeletonText lines={6} label="Loading the run" />
          </section>
        )}
      </Page>
    )
  }
  const { run, stages, tests, builds, artifacts } = detail
  const status = live ?? run.status
  const now = Date.now()
  const title = runName(run.workflow, run.number)
  return (
    <Page
      crumbs={[
        { label: TITLE, to: '/artifacts' },
        {
          label: run.project.name,
          to: artifactsHref({ project: run.project.slug }),
        },
        { label: `Run ${run.number}` },
      ]}
      title={title}
      pill={<StatusPill status={status} />}
      description={
        <span className="m-row m-t-subhead m-secondary">
          <span className="m-t-mono-sm">{run.branch}</span>
          {run.commit != null && (
            <span className="m-commit__sha" title={run.commit}>
              {run.commit.slice(0, 12)}
            </span>
          )}
          <span>
            {absoluteTime(run.created, now)}
            {run.started == null
              ? ''
              : ` · took ${duration((run.finished ?? now) - run.started)}`}
          </span>
        </span>
      }
      actions={
        <ButtonLink
          variant="secondary"
          icon="history"
          to={`/runs/${encodeURIComponent(run.id)}`}
        >
          Open the run
        </ButtonLink>
      }
    >
      {run.description != null && run.description !== '' && (
        <p className="m-page__desc m-run__desc">{run.description}</p>
      )}
      <div className="m-grid-3">
        <DetailCard icon="account_tree" title="Stages">
          {stages.length === 0 ? (
            <Nothing text="No stage has started yet." />
          ) : (
            <ul className="m-list">
              {stages.map((stage) => (
                <li
                  key={stage.name}
                  className="m-list__row m-list__row--compact"
                >
                  <span className="m-list__main m-t-mono m-wrap-any">
                    {stage.name}
                  </span>
                  <StatusPill
                    quiet
                    status={stage.status}
                    label={
                      stage.started == null
                        ? undefined
                        : `${statusOf(stage.status).word} · ${duration((stage.finished ?? now) - stage.started)}`
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </DetailCard>
        {tests.length > 0 && <Tests tests={tests} />}
        <DetailCard icon="deployed_code" title="Published builds">
          {builds.length === 0 ? (
            <Nothing text="None." />
          ) : (
            <ul className="m-list">
              {builds.map((build) => (
                <li key={build.id} className="m-list__row">
                  <span className="m-list__main">
                    <span className="m-t-mono m-queue__name">
                      {build.app} {build.version} ({build.buildNumber})
                      {build.variant === '' ? '' : ` ${build.variant}`}
                    </span>
                    <span className="m-row m-t-subhead m-secondary">
                      <PlatformChip platform={build.platform} />
                      {build.downloadOnly != null && (
                        <span>{build.downloadOnly}</span>
                      )}
                      <span>{bytes(build.size)}</span>
                    </span>
                  </span>
                  {profile.role === 'host' && (
                    <ButtonLink
                      variant="secondary"
                      size="sm"
                      icon={
                        build.downloadOnly == null
                          ? 'mobile_arrow_down'
                          : 'download'
                      }
                      to={`/apps/${build.appId}`}
                    >
                      {build.downloadOnly == null ? 'Install' : 'Download'}
                    </ButtonLink>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DetailCard>
      </div>
      <DetailCard
        title="Saved artifacts"
        end={<Count count={artifacts.length} />}
      >
        {artifacts.length === 0 ? (
          <Nothing text="This run saved no artifacts." />
        ) : (
          <div className="m-table-wrap">
            <table className="m-table m-table--stack">
              <thead>
                <tr>
                  <th scope="col">Artifact</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="m-right">
                    Size
                  </th>
                  <th scope="col">
                    <span className="m-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((artifact) => (
                  <tr key={`${artifact.stage}/${artifact.name}`}>
                    <td
                      data-primary
                      data-label="Artifact"
                      className="m-t-mono m-wrap-any"
                    >
                      {artifact.name}
                    </td>
                    <td data-label="Stage" className="m-t-mono-sm">
                      {artifact.stage}
                    </td>
                    <td data-label="Kind">{kindWord(artifact.kind)}</td>
                    <td data-label="Size" className="m-right m-num">
                      {bytes(artifact.size)}
                    </td>
                    <td data-actions>
                      <div className="m-table__actions">
                        {artifact.viewUrl != null && (
                          <a
                            className={buttonClass({
                              variant: 'plain',
                              size: 'sm',
                            })}
                            href={artifact.viewUrl}
                          >
                            <Icon name="visibility" />
                            View
                          </a>
                        )}
                        <a
                          className={buttonClass({
                            variant: 'plain',
                            size: 'sm',
                            iconOnly: true,
                          })}
                          href={artifact.url}
                          aria-label={`Download ${artifact.name}`}
                          title={`Download ${artifact.name}`}
                        >
                          <Icon name="download" />
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DetailCard>
    </Page>
  )
}

/** Artifacts: the list, or a run's detail at `?run=`. */
export function ArtifactsPage(): JSX.Element {
  const [params] = useSearchParams()
  const run = params.get('run')
  if (run != null && run !== '') return <RunDetail key={run} id={run} />
  const project = params.get('project') ?? undefined
  const branch = params.get('branch') ?? undefined
  return (
    <ArtifactsList
      project={project === '' ? undefined : project}
      branch={branch === '' ? undefined : branch}
    />
  )
}
