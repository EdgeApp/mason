// Every page's route, declared once for both profiles: master-only routes
// are not registered on the host (their addresses answer 404 there). Until a
// page's milestone ports it, its route is the node's own page: outside the
// /_web mount the app leaves for it with a full load, and inside the mount
// it renders the page's header and what is coming. The access check and
// the 403 are real already.
import {
  createContext,
  useContext,
  useEffect,
  type ComponentType,
  type JSX,
} from 'react'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router'
import type { NodeInfo } from '../../shared/api/index.js'
import type { Permission, Role } from '../../shared/permissions.js'
import { AppShell } from '../layout/AppShell.js'
import type { Crumb } from '../layout/Breadcrumbs.js'
import { useShell } from '../layout/ShellContext.js'
import { Forbidden } from '../pages/errors/Forbidden.js'
import { NotFound } from '../pages/errors/NotFound.js'
import { InvitePage } from '../pages/auth/Invite.js'
import { SetupPage } from '../pages/auth/Setup.js'
import { SignInPage } from '../pages/auth/SignIn.js'
import { ArtifactsPage } from '../pages/artifacts/Artifacts.js'
import { DashboardPage } from '../pages/dashboard/Dashboard.js'
import { PlaceholderPage } from '../pages/Placeholder.js'
import { SearchPage } from '../pages/search/Search.js'
import { SkeletonText } from '../ui/Skeleton.js'
import type { IconName } from '../ui/icons.js'
import { homeFor, navItem } from './navigation.js'
import { useProfile } from './NodeProfile.js'

type Params = Readonly<Partial<Record<string, string>>>

/** One page of the signed-in app. */
export interface PageRoute {
  path: string
  title: (params: Params) => string
  description: string
  /** The milestone that ports it. */
  milestone: string
  icon: IconName
  /** What opens it, and who holds that (for the 403's words). */
  permission: Permission
  least: Role
  masterOnly: boolean
  /** The trail after the node's pill; the last is the page. */
  crumbs: (params: Params) => Crumb[]
  /** The page, once its milestone has ported it; until then the node draws it. */
  page?: ComponentType
}

/** A route that is one of the navigation's destinations. */
function destination(
  key: string,
  description: string,
  milestone: string,
): PageRoute {
  const entry = navItem(key)!
  return {
    path: entry.href,
    title: () => entry.label,
    description,
    milestone,
    icon: entry.icon,
    permission: entry.permission,
    least: entry.least,
    masterOnly: entry.masterOnly,
    crumbs: () => [{ label: entry.label }],
  }
}

const PROJECTS: Crumb = { label: 'Projects & apps', to: '/projects' }
const project = (params: Params): Crumb => ({
  label: params.slug ?? '',
  to: `/projects/${params.slug}`,
})
const app = (params: Params): Crumb => ({
  label: params.appId ?? '',
  to: `/projects/${params.slug}/apps/${params.appId}`,
})

/** A project's or an app ID's page. */
function projectPage(
  path: string,
  title: string,
  description: string,
  crumbs: (params: Params) => Crumb[],
  masterOnly = false,
): PageRoute {
  return {
    path,
    title: () => title,
    description,
    milestone: 'M8',
    icon: 'folder',
    permission: 'projects.read',
    least: 'developer',
    masterOnly,
    crumbs,
  }
}

/** Every signed-in page, in no particular order (the router ranks them). */
export const PAGE_ROUTES: readonly PageRoute[] = [
  {
    ...destination(
      'dashboard',
      'Every project’s app IDs, their latest builds and runs.',
      'M6',
    ),
    page: DashboardPage,
  },
  {
    ...destination(
      'artifacts',
      'Each run’s saved artifacts, test results and published builds.',
      'M6',
    ),
    page: ArtifactsPage,
  },
  {
    page: SearchPage,
    path: '/search',
    title: () => 'Search',
    description: 'Projects, app IDs, runs, commits and branches.',
    milestone: 'M6',
    icon: 'search',
    permission: 'builds.read',
    least: 'tester',
    masterOnly: false,
    crumbs: () => [{ label: 'Search' }],
  },
  {
    path: '/runs/:id',
    title: () => 'Run',
    description: 'A run’s stages, steps, log and history.',
    milestone: 'M7',
    icon: 'history',
    permission: 'runs.read',
    least: 'developer',
    masterOnly: false,
    crumbs: (params) => [
      PROJECTS,
      { label: `Run ${(params.id ?? '').slice(0, 8)}` },
    ],
  },
  {
    ...projectPage(
      '/projects/new',
      'Add a project',
      'Read a repository’s Masonfile and add it.',
      () => [PROJECTS, { label: 'Add a project' }],
      true,
    ),
    permission: 'projects.change',
    least: 'manager',
  },
  projectPage(
    '/projects/:slug',
    'Overview',
    'The project’s app IDs, branch rules and build numbers.',
    (p) => [PROJECTS, { label: p.slug ?? '' }],
  ),
  projectPage(
    '/projects/:slug/runs',
    'Runs and builds',
    'The project’s branches and runs.',
    (p) => [PROJECTS, project(p), { label: 'Runs and builds' }],
  ),
  projectPage(
    '/projects/:slug/masonfile',
    'Masonfile',
    'The Masonfile at a commit.',
    (p) => [PROJECTS, project(p), { label: 'Masonfile' }],
  ),
  projectPage(
    '/projects/:slug/secrets',
    'Secrets',
    'The project’s secret values and files, and who read them.',
    (p) => [PROJECTS, project(p), { label: 'Secrets' }],
    true,
  ),
  projectPage(
    '/projects/:slug/apps/:appId',
    'Runs and builds',
    'An app ID’s runs and builds.',
    (p) => [PROJECTS, project(p), { label: p.appId ?? '' }],
  ),
  projectPage(
    '/projects/:slug/apps/:appId/build-numbers',
    'Build numbers',
    'An app ID’s build-number sequence.',
    (p) => [PROJECTS, project(p), app(p), { label: 'Build numbers' }],
  ),
  destination(
    'nodes',
    'The workers and the host, their checks and pools.',
    'M9',
  ),
  destination('cloud', 'Cloud accounts and their checks.', 'M9'),
  destination(
    'settings',
    'Apple, signing, keys, GitHub, the host, storage, sign-in and node types.',
    'M9',
  ),
  destination('people', 'Who signs in, their roles and emails.', 'M9'),
  destination('groups', 'Which testers install which apps.', 'M9'),
  {
    ...destination('groups', 'A group’s apps and members.', 'M9'),
    path: '/groups/:id',
    title: () => 'Group',
    crumbs: () => [{ label: 'Groups', to: '/groups' }, { label: 'Group' }],
  },
  destination(
    'backups',
    'Encrypted copies of this master, kept in a git repository.',
    'M9',
  ),
  {
    path: '/account',
    title: () => 'Your account',
    description: 'Your name, emails, Appearance and password.',
    milestone: 'M9',
    icon: 'person',
    permission: 'builds.read',
    least: 'tester',
    masterOnly: false,
    crumbs: () => [{ label: 'Your account' }],
  },
  destination('catalog', 'The apps you may install, by platform.', 'M10'),
  {
    ...destination('catalog', 'An app’s branches and builds.', 'M10'),
    path: '/apps/:appId',
    title: () => 'App',
    crumbs: () => [{ label: 'Install apps', to: '/apps' }, { label: 'App' }],
  },
  {
    ...destination('catalog', 'A branch’s builds, to install.', 'M10'),
    path: '/apps/:appId/branches/:branchKey',
    title: () => 'Branch',
    crumbs: (p) => [
      { label: 'Install apps', to: '/apps' },
      { label: 'App', to: `/apps/${p.appId}` },
      { label: 'Branch' },
    ],
  },
  destination('devices', 'Register an iPhone or iPad for builds.', 'M10'),
  {
    ...destination('devices', 'Your device’s registration.', 'M10'),
    path: '/devices/complete/:token',
    title: () => 'Device registered',
    crumbs: () => [
      { label: 'Devices', to: '/devices' },
      { label: 'Device registered' },
    ],
  },
]

/** The pages a node registers. */
export const routesFor = (node: 'master' | 'host'): PageRoute[] =>
  PAGE_ROUTES.filter((route) => node === 'master' || !route.masterOnly)

/**
 * Where the app leaves for the node's own pages, outside the /_web mount:
 * `here` is the address the document was loaded at (the node answered the
 * app there, so the app never leaves it), `go` loads another with a full
 * document load. Inside the mount there is none, and unported pages draw
 * their placeholder.
 */
export interface ServerPages {
  here: string
  go: (url: string) => void
}

export const ServerPagesContext = createContext<ServerPages | undefined>(
  undefined,
)

/** The node's own page at an address: a full load of it, or the placeholder. */
function ServerPage({
  placeholder,
}: {
  placeholder: () => JSX.Element
}): JSX.Element {
  const server = useContext(ServerPagesContext)
  const { pathname, search } = useLocation()
  const target = `${pathname}${search}`
  const leaving = server != null && server.here !== target
  useEffect(() => {
    if (leaving) server.go(target)
  }, [leaving, server, target])
  if (!leaving) return placeholder()
  return (
    <div className="m-page">
      <SkeletonText lines={4} label="Opening the page" />
    </div>
  )
}

/** One page: the 403 when the viewer's session lacks its permission. */
function RoutePage({ route }: { route: PageRoute }): JSX.Element {
  const params = useParams()
  const { session } = useShell()
  const title = route.title(params)
  const crumbs = route.crumbs(params)
  if (!session.permissions.includes(route.permission))
    return <Forbidden title={title} least={route.least} crumbs={crumbs} />
  const Ported = route.page
  if (Ported != null) return <Ported />
  return (
    <ServerPage
      placeholder={() => (
        <PlaceholderPage
          crumbs={crumbs}
          title={title}
          description={route.description}
          milestone={route.milestone}
          icon={route.icon}
        />
      )}
    />
  )
}

/**
 * `/`: on the master, Projects & apps for those who may read projects;
 * otherwise the viewer's first destination (Install apps for a tester),
 * which outside the mount is the node's own page at `/`.
 */
function Home(): JSX.Element {
  const { nav, session } = useShell()
  const profile = useProfile()
  const server = useContext(ServerPagesContext)
  if (
    profile.role === 'master' &&
    session.permissions.includes('projects.read')
  )
    return <DashboardPage />
  if (server != null && server.here !== '/')
    return <ServerPage placeholder={() => <></>} />
  return <Navigate to={homeFor(nav)} replace />
}

/** The whole app's routes for a node. */
export function AppRoutes({ node }: { node: NodeInfo }): JSX.Element {
  const profile = useProfile()
  // A master with no account yet: first-run setup, wherever it was opened.
  if (node.setupNeeded)
    return (
      <Routes>
        <Route path="*" element={<SetupPage />} />
      </Routes>
    )
  return (
    <Routes>
      {/* Signed out, in the bare shell: each node's own sign-in, and invitations on both. */}
      <Route
        path={profile.role === 'master' ? '/sign-in' : '/auth/login'}
        element={<SignInPage node={node} />}
      />
      <Route path="/auth/invite" element={<InvitePage />} />
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        {routesFor(profile.role).map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={<RoutePage route={route} />}
          />
        ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
