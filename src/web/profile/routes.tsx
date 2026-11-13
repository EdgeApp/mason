// Every page's route, declared once for both profiles: master-only routes
// are not registered on the host (their addresses answer 404 there). A
// page the viewer's session may not open reads its 403.
import type { ComponentType, JSX } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router'
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
import { AccountPage } from '../pages/account/Account.js'
import { BackupsPage } from '../pages/admin/backups/Backups.js'
import { BackupsFirst } from '../pages/admin/backups/BackupsFirst.js'
import { CloudPage } from '../pages/admin/cloud/Cloud.js'
import { GroupPage } from '../pages/admin/groups/Group.js'
import { GroupsPage } from '../pages/admin/groups/Groups.js'
import { NodesPage } from '../pages/admin/nodes/Nodes.js'
import { PeoplePage } from '../pages/admin/people/People.js'
import { SettingsPage } from '../pages/admin/settings/Settings.js'
import { ArtifactsPage } from '../pages/artifacts/Artifacts.js'
import { DashboardPage } from '../pages/dashboard/Dashboard.js'
import { AppBuildNumbersPage } from '../pages/projects/BuildNumbers.js'
import { MasonfilePage } from '../pages/projects/Masonfile.js'
import { ProjectOverviewPage } from '../pages/projects/Overview.js'
import { AppRunsPage, ProjectRunsPage } from '../pages/projects/Runs.js'
import { SecretsPage } from '../pages/projects/Secrets.js'
import { WizardPage } from '../pages/projects/Wizard.js'
import { RunPage } from '../pages/run/RunPage.js'
import { SearchPage } from '../pages/search/Search.js'
import { AppPage } from '../pages/catalog/App.js'
import { AppsPage } from '../pages/catalog/Apps.js'
import { BranchPage } from '../pages/catalog/Branch.js'
import { CompletePage } from '../pages/devices/Complete.js'
import { DevicesPage } from '../pages/devices/Devices.js'
import type { IconName } from '../ui/icons.js'
import { homeFor, navItem } from './navigation.js'
import { useProfile } from './NodeProfile.js'

type Params = Readonly<Partial<Record<string, string>>>

/** One page of the signed-in app. */
export interface PageRoute {
  path: string
  title: (params: Params) => string
  description: string
  icon: IconName
  /** What opens it, and who holds that (for the 403's words). */
  permission: Permission
  least: Role
  masterOnly: boolean
  /** The trail after the node's pill; the last is the page. */
  crumbs: (params: Params) => Crumb[]
  page: ComponentType
  /** To a viewer without this permission the page does not exist: 404, not 403. */
  hiddenWithout?: Permission
}

/** A route that is one of the navigation's destinations. */
function destination(
  key: string,
  description: string,
  page: ComponentType,
): PageRoute {
  const entry = navItem(key)!
  return {
    page,
    path: entry.href,
    title: () => entry.label,
    description,
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
  page: ComponentType,
  path: string,
  title: string,
  description: string,
  crumbs: (params: Params) => Crumb[],
  masterOnly = false,
): PageRoute {
  return {
    page,
    path,
    title: () => title,
    description,
    icon: 'folder',
    permission: 'projects.read',
    least: 'developer',
    masterOnly,
    crumbs,
    hiddenWithout: 'projects.read',
  }
}

/** Every signed-in page, in no particular order (the router ranks them). */
export const PAGE_ROUTES: readonly PageRoute[] = [
  {
    ...destination(
      'dashboard',
      'Every project’s app IDs, their latest builds and runs.',
      DashboardPage,
    ),
    hiddenWithout: 'projects.read',
  },
  destination(
    'artifacts',
    'Each run’s saved artifacts, test results and published builds.',
    ArtifactsPage,
  ),
  {
    page: SearchPage,
    path: '/search',
    title: () => 'Search',
    description: 'Projects, app IDs, runs, commits and branches.',
    icon: 'search',
    permission: 'builds.read',
    least: 'tester',
    masterOnly: false,
    crumbs: () => [{ label: 'Search' }],
  },
  {
    page: RunPage,
    path: '/runs/:id',
    title: () => 'Run',
    description: 'A run’s stages, steps, log and history.',
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
      WizardPage,
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
    ProjectOverviewPage,
    '/projects/:slug',
    'Overview',
    'The project’s app IDs, branch rules and build numbers.',
    (p) => [PROJECTS, { label: p.slug ?? '' }],
  ),
  projectPage(
    ProjectRunsPage,
    '/projects/:slug/runs',
    'Runs and builds',
    'The project’s branches and runs.',
    (p) => [PROJECTS, project(p), { label: 'Runs and builds' }],
  ),
  projectPage(
    MasonfilePage,
    '/projects/:slug/masonfile',
    'Masonfile',
    'The Masonfile at a commit.',
    (p) => [PROJECTS, project(p), { label: 'Masonfile' }],
  ),
  projectPage(
    SecretsPage,
    '/projects/:slug/secrets',
    'Secrets',
    'The project’s secret values and files, and who read them.',
    (p) => [PROJECTS, project(p), { label: 'Secrets' }],
    true,
  ),
  projectPage(
    AppRunsPage,
    '/projects/:slug/apps/:appId',
    'Runs and builds',
    'An app ID’s runs and builds.',
    (p) => [PROJECTS, project(p), { label: p.appId ?? '' }],
  ),
  projectPage(
    AppBuildNumbersPage,
    '/projects/:slug/apps/:appId/build-numbers',
    'Build numbers',
    'An app ID’s build-number sequence.',
    (p) => [PROJECTS, project(p), app(p), { label: 'Build numbers' }],
  ),
  destination(
    'nodes',
    'The workers and the host, their checks and pools.',
    NodesPage,
  ),
  destination('cloud', 'Cloud accounts and their checks.', CloudPage),
  destination(
    'settings',
    'Apple, signing, keys, GitHub, the host, storage, sign-in and node types.',
    SettingsPage,
  ),
  destination('people', 'Who signs in, their roles and emails.', PeoplePage),
  destination('groups', 'Which testers install which apps.', GroupsPage),
  {
    ...destination('groups', 'A group’s apps and members.', GroupPage),
    path: '/groups/:id',
    title: () => 'Group',
    crumbs: () => [{ label: 'Groups', to: '/groups' }, { label: 'Group' }],
  },
  destination(
    'backups',
    'Encrypted copies of this master, kept in a git repository.',
    BackupsPage,
  ),
  {
    page: AccountPage,
    path: '/account',
    title: () => 'Your account',
    description: 'Your name, emails, Appearance and password.',
    icon: 'person',
    permission: 'builds.read',
    least: 'tester',
    masterOnly: false,
    crumbs: () => [{ label: 'Your account' }],
  },
  destination('catalog', 'The apps you may install, by platform.', AppsPage),
  {
    ...destination('catalog', 'An app’s branches and builds.', AppPage),
    path: '/apps/:appId',
    title: () => 'App',
    crumbs: () => [{ label: 'Install apps', to: '/apps' }, { label: 'App' }],
  },
  {
    ...destination('catalog', 'A branch’s builds, to install.', BranchPage),
    path: '/apps/:appId/branches/:branchKey',
    title: () => 'Branch',
    crumbs: (p) => [
      { label: 'Install apps', to: '/apps' },
      { label: 'App', to: `/apps/${p.appId}` },
      { label: 'Branch' },
    ],
  },
  destination('devices', 'Register an iPhone or iPad for builds.', DevicesPage),
  {
    ...destination('devices', 'Your device’s registration.', CompletePage),
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

/** One page: the 403 when the viewer's session lacks its permission. */
function RoutePage({ route }: { route: PageRoute }): JSX.Element {
  const params = useParams()
  const { session } = useShell()
  const title = route.title(params)
  const crumbs = route.crumbs(params)
  if (
    route.hiddenWithout != null &&
    !session.permissions.includes(route.hiddenWithout)
  )
    return <NotFound />
  if (!session.permissions.includes(route.permission))
    return <Forbidden title={title} least={route.least} crumbs={crumbs} />
  const Ported = route.page
  return <Ported />
}

/**
 * `/`: on the master, Projects & apps for those who may read projects;
 * otherwise the viewer's first destination: Install apps for a tester (on
 * either node), Projects & apps for a developer on the host.
 */
function Home(): JSX.Element {
  const { nav, session } = useShell()
  const profile = useProfile()
  if (
    profile.role === 'master' &&
    session.permissions.includes('projects.read')
  )
    return (
      <BackupsFirst>
        <DashboardPage />
      </BackupsFirst>
    )
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
