// What a project's pages share (DESIGN-LANGUAGE.md §14, screen-02-project):
// the header with the project's name, its Masonfile kind, its repository
// and Request run; the tabs (Secrets on the master only); and the states a
// project read can end in. The app ID pages head themselves with the app ID.
import { useState, type JSX, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  asProjectOverview,
  projectOverviewPath,
  type ProjectOverview,
} from '../../../shared/api/index.js'
import { useResource, type Resource } from '../../hooks/useResource.js'
import type { Crumb } from '../../layout/Breadcrumbs.js'
import { Page } from '../../layout/Page.js'
import { useShell } from '../../layout/ShellContext.js'
import { Button, ButtonLink } from '../../ui/Button.js'
import { Chip } from '../../ui/Chip.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Icon } from '../../ui/Icon.js'
import type { IconName } from '../../ui/icons.js'
import { PlatformChip } from '../../ui/RunChip.js'
import { SkeletonText } from '../../ui/Skeleton.js'
import { RequestSheet, type Unavailable } from '../run/actions.js'

/** Where a project's pages are. */
export function projectHref(
  slug: string,
  tab: 'overview' | 'runs' | 'masonfile' | 'secrets' = 'overview',
  query: Record<string, string | undefined> = {},
): string {
  const base = `/projects/${encodeURIComponent(slug)}`
  return withQuery(tab === 'overview' ? base : `${base}/${tab}`, query)
}

/** Where an app ID's pages are: its Runs and builds, or its Build numbers. */
export function appHref(
  slug: string,
  appId: string,
  tab: 'runs' | 'build-numbers' = 'runs',
  query: Record<string, string | undefined> = {},
): string {
  const base = `/projects/${encodeURIComponent(slug)}/apps/${encodeURIComponent(appId)}`
  return withQuery(tab === 'runs' ? base : `${base}/build-numbers`, query)
}

const withQuery = (
  path: string,
  query: Record<string, string | undefined>,
): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query))
    if (value != null) search.set(key, value)
  const text = search.toString()
  return text === '' ? path : `${path}?${text}`
}

/** The first levels of every project page. */
export const PROJECTS: Crumb = { label: 'Projects & apps', to: '/projects' }
export const projectCrumb = (slug: string, name: string): Crumb => ({
  label: name,
  to: projectHref(slug),
})

/** Why the master's actions are disabled on a host that cannot reach it. */
export function useOffline(): Unavailable | undefined {
  const { status } = useShell()
  return status?.link?.online === false
    ? { reason: 'The master is unreachable: try again once it is back.' }
    : undefined
}

/** A read that failed: what went wrong and a way to try again. */
export function Failed({
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

/** A card's loading state, shaped like its content. */
export function Loading({ label }: { label: string }): JSX.Element {
  return (
    <section className="m-card m-card__body">
      <SkeletonText lines={5} label={label} />
    </section>
  )
}

/** A project, or an app ID of one, that this node does not hold or the viewer may not see. */
export function Unknown({
  crumbs,
  title,
  text,
}: {
  crumbs: Crumb[]
  title: string
  text: string
}): JSX.Element {
  return (
    <Page crumbs={crumbs} title={title}>
      <section className="m-card">
        <EmptyState
          icon="search"
          title={text}
          actions={
            <ButtonLink variant="secondary" to="/projects">
              Projects & apps
            </ButtonLink>
          }
        />
      </section>
    </Page>
  )
}

type ProjectTab = 'overview' | 'runs' | 'masonfile' | 'secrets'

const TABS: Array<{ key: ProjectTab; label: string; icon: IconName }> = [
  { key: 'overview', label: 'Overview', icon: 'dashboard' },
  { key: 'runs', label: 'Runs and builds', icon: 'history' },
  { key: 'masonfile', label: 'Masonfile', icon: 'description' },
  { key: 'secrets', label: 'Secrets', icon: 'key' },
]

/** A project's tabs; Secrets only where the node keeps them (the master). */
export function ProjectTabs({
  slug,
  name,
  current,
  secrets,
}: {
  slug: string
  name: string
  current: ProjectTab
  secrets: boolean
}): JSX.Element {
  return (
    <nav className="m-tabs" aria-label={name}>
      {TABS.filter((tab) => tab.key !== 'secrets' || secrets).map((tab) => (
        <Link
          key={tab.key}
          className="m-tab"
          to={projectHref(slug, tab.key)}
          aria-current={tab.key === current ? 'page' : undefined}
        >
          <Icon name={tab.icon} />
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}

/** The workflow Request run starts with: `build` when the Masonfile has it. */
const firstWorkflow = (overview: ProjectOverview): string => {
  const names = overview.workflows?.map((entry) => entry.name) ?? []
  return names.includes('build') ? 'build' : (names[0] ?? 'build')
}

/** Request run in a project's header: the default branch, a workflow of its latest Masonfile. */
function RequestRun({ overview }: { overview: ProjectOverview }): JSX.Element {
  const [open, setOpen] = useState(false)
  const offline = useOffline()
  return (
    <>
      <Button
        variant="primary"
        icon="play_arrow"
        aria-haspopup="dialog"
        disabled={offline != null}
        title={offline?.reason}
        onClick={() => setOpen(true)}
      >
        Request run
      </Button>
      <RequestSheet
        target={{
          id: `project-${overview.slug}`,
          project: { slug: overview.slug, name: overview.name },
          branch: overview.defaultBranch,
          workflow: firstWorkflow(overview),
          workflows: overview.workflows,
        }}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/** A project's read, which every project tab heads itself with. */
export const useOverview = (slug: string): Resource<ProjectOverview> =>
  useResource(projectOverviewPath(slug), asProjectOverview)

/**
 * A project tab: its crumbs, the project's header and tabs, then the tab's
 * content once the project is read; the project's own states otherwise.
 */
export function ProjectPage({
  slug,
  tab,
  title,
  crumbs,
  description,
  children,
}: {
  slug: string
  tab: ProjectTab
  /** The tab's own title, for the document and the top bar. */
  title: string
  /** The trail after the project. */
  crumbs?: Crumb[]
  description?: ReactNode
  /** The tab's content; `reload` reads the project again (after a change). */
  children: (overview: ProjectOverview, reload: () => void) => ReactNode
}): JSX.Element {
  const read = useOverview(slug)
  const { session } = useShell()
  const overview = read.data
  const head = projectCrumb(slug, overview?.name ?? slug)
  const trail: Crumb[] = [
    PROJECTS,
    ...(tab === 'overview' && crumbs == null
      ? [{ label: head.label }]
      : [head, ...(crumbs ?? [])]),
  ]
  if (overview == null && read.error?.status === 404)
    return (
      <Unknown
        crumbs={[PROJECTS, { label: 'Project unavailable' }]}
        title="Project unavailable"
        text="There is no such project."
      />
    )
  const name = overview?.name ?? slug
  return (
    <Page
      crumbs={trail}
      title={tab === 'overview' ? name : `${name} · ${title}`}
      heading={name}
      pill={
        overview == null ? undefined : (
          <Chip kind="accent" icon="bolt">
            {overview.format === 'script'
              ? 'Script project'
              : 'Pipeline Masonfile'}
          </Chip>
        )
      }
      description={
        overview == null ? undefined : (
          <span className="m-t-mono m-wrap-any">{overview.repository}</span>
        )
      }
      actions={
        overview != null && session.permissions.includes('runs.request') ? (
          <RequestRun overview={overview} />
        ) : undefined
      }
    >
      <ProjectTabs
        slug={slug}
        name={name}
        current={tab}
        secrets={overview?.secrets ?? false}
      />
      {description != null && <p className="m-page__desc">{description}</p>}
      {overview != null ? (
        children(overview, read.reload)
      ) : read.error != null ? (
        <Failed
          what="The project"
          message={read.error.message}
          retry={read.reload}
        />
      ) : (
        <Loading label="Loading the project" />
      )}
    </Page>
  )
}

/** An app ID's two tabs. */
export function AppTabs({
  slug,
  appId,
  current,
}: {
  slug: string
  appId: string
  current: 'runs' | 'build-numbers'
}): JSX.Element {
  return (
    <nav className="m-tabs" aria-label={appId}>
      <Link
        className="m-tab"
        to={appHref(slug, appId)}
        aria-current={current === 'runs' ? 'page' : undefined}
      >
        <Icon name="history" />
        Runs and builds
      </Link>
      <Link
        className="m-tab"
        to={appHref(slug, appId, 'build-numbers')}
        aria-current={current === 'build-numbers' ? 'page' : undefined}
      >
        <Icon name="label" />
        Build numbers
      </Link>
    </nav>
  )
}

/** An app ID's heading: its name and platforms under the app ID. */
export function AppHeading({
  name,
  platforms,
}: {
  name: string
  platforms: string[]
}): JSX.Element {
  return (
    <span className="m-row">
      {name}
      {platforms.map((platform) => (
        <PlatformChip key={platform} platform={platform} />
      ))}
    </span>
  )
}

/** The trail of an app ID's pages: the project, the app ID, its tab. */
export function appCrumbs(
  slug: string,
  project: string,
  appId: string,
  tab: 'runs' | 'build-numbers',
  branch?: string,
): Crumb[] {
  return [
    PROJECTS,
    projectCrumb(slug, project),
    { label: appId, to: appHref(slug, appId) },
    tab === 'runs'
      ? branch == null
        ? { label: 'Runs and builds' }
        : { label: 'Runs and builds', to: appHref(slug, appId) }
      : { label: 'Build numbers' },
    ...(tab === 'runs' && branch != null ? [{ label: branch }] : []),
  ]
}
