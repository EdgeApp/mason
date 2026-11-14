import {
  asArray,
  asBoolean,
  asEither,
  asNull,
  asNumber,
  asObject,
  asOptional,
  asString,
  asUnknown,
} from 'cleaners'
import { asParamSpec, asRecord, type WorkflowSpec } from './runs.js'

/** `GET /api/v2/projects/:slug/overview`, both nodes. */
export const projectOverviewPath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/overview`
/** `GET /api/v2/projects/:slug/runs?branch=&app=&limit=`, both nodes. */
export const projectRunsPath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/runs`
/** How many runs Runs and builds asks for at first, and how many more each *Show more* adds. */
export const RUNS_PAGE = 50
/** The most runs one request answers. */
export const RUNS_LIMIT = 500
/** `GET /api/v2/projects/:slug/apps/:appId`, both nodes. */
export const projectAppPath = (slug: string, appId: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/apps/${encodeURIComponent(appId)}`
/** `GET /api/v2/projects/:slug/masonfile/commits`, both nodes. */
export const masonfileCommitsPath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/masonfile/commits`
/** `GET /api/v2/projects/:slug/masonfile?commit=`, both nodes. */
export const masonfilePath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/masonfile`

/** One build-number sequence: its scheme and the last number per branch (`''` across branches). */
export interface BuildNumberSequence {
  key: string
  format: string
  scope: string
  /** Other app IDs that take their numbers from it. */
  apps: string[]
  last: Array<{ branch: string; value: string }>
}

/**
 * What a project's pages show beyond its name: the same object on the
 * master, which builds it, and on the host, which keeps the copy the master
 * sends.
 */
export interface ProjectDetails {
  repository: string
  defaultBranch: string
  format: string
  apps: Array<{
    bundleId: string
    platforms: string[]
    apple?: { team: string }
  }>
  rules: Array<{ pattern: string; mode: string }>
  webhook: boolean
  signingLabel?: string
  /** The branches Runs and builds lists first: those its push trigger builds. */
  pinned: string[]
  buildNumbers: BuildNumberSequence[]
}

/** What `GET /api/v2/projects/:slug/overview` answers. */
export interface ProjectOverview extends ProjectDetails {
  slug: string
  name: string
  /** The app IDs' names and ids, in the project's order. */
  appNames: Array<{ bundleId: string; name: string }>
  /** Whether the viewer may set where a sequence stands: a manager on the master. */
  canSeed: boolean
  /** Whether the node has a Secrets tab: the master only. */
  secrets: boolean
  /**
   * The workflows of the Masonfile its latest run recorded (on the default
   * branch when it has one), with their parameters, for Request run.
   */
  workflows?: WorkflowSpec[]
}

/** A branch in the Runs and builds list; `pinned` ones are those its push trigger builds. */
export interface BranchItem {
  branch: string
  pinned: boolean
  /** When its latest run was made. */
  at?: number
}

/** One run of Runs and builds: its status, the app's version and build number, and when it started. */
export interface ProjectRunRow {
  id: string
  number: number
  workflow: string
  branch: string
  status: string
  at: number
  version: string
  buildNumber: string
}

/** An app ID as its pages head it. */
export interface AppHeading {
  id: number
  bundleId: string
  name: string
  platforms: string[]
}

/** What `GET /api/v2/projects/:slug/runs` answers, for the project or (`?app=`) one app ID. */
export interface ProjectRuns {
  slug: string
  name: string
  branch?: string
  app?: AppHeading
  branches: BranchItem[]
  runs: ProjectRunRow[]
  /** Whether older runs are left beyond `limit`. */
  more: boolean
}

/** What `GET /api/v2/projects/:slug/apps/:appId` answers. */
export interface ProjectApp {
  slug: string
  name: string
  app: AppHeading
  /** The sequence it takes its build numbers from; none for the default scheme. */
  sequence?: BuildNumberSequence
  /** The other app IDs that sequence numbers. */
  shared: string[]
  /** The scheme an app ID with no sequence takes. */
  defaultScheme: { format: string; scope: string }
  canSeed: boolean
}

/** A commit the Masonfile tab offers. */
export interface MasonfileCommit {
  sha: string
  branch: string
}

/** What `GET /api/v2/projects/:slug/masonfile` answers. */
export interface MasonfileText {
  commit: string
  file: string
  text: string
}

export const asBuildNumberSequence = asObject<BuildNumberSequence>({
  key: asString,
  format: asString,
  scope: asString,
  apps: asArray(asString),
  last: asArray(asObject({ branch: asString, value: asString })),
})

const detailFields = {
  repository: asString,
  defaultBranch: asString,
  format: asString,
  apps: asArray(
    asObject({
      bundleId: asString,
      platforms: asArray(asString),
      apple: asOptional(asObject({ team: asString })),
    }),
  ),
  rules: asArray(asObject({ pattern: asString, mode: asString })),
  webhook: asBoolean,
  signingLabel: asOptional(asString),
  pinned: asArray(asString),
  buildNumbers: asArray(asBuildNumberSequence),
}

export const asProjectDetails = asObject<ProjectDetails>(detailFields)

export const asProjectOverview = asObject<ProjectOverview>({
  ...detailFields,
  slug: asString,
  name: asString,
  appNames: asArray(asObject({ bundleId: asString, name: asString })),
  canSeed: asBoolean,
  secrets: asBoolean,
  workflows: asOptional(
    asArray(
      asObject<WorkflowSpec>({ name: asString, params: asRecord(asParamSpec) }),
    ),
  ),
})

export const asAppHeading = asObject<AppHeading>({
  id: asNumber,
  bundleId: asString,
  name: asString,
  platforms: asArray(asString),
})

export const asProjectRuns = asObject<ProjectRuns>({
  slug: asString,
  name: asString,
  branch: asOptional(asString),
  app: asOptional(asAppHeading),
  branches: asArray(
    asObject<BranchItem>({
      branch: asString,
      pinned: asBoolean,
      at: asOptional(asNumber),
    }),
  ),
  runs: asArray(
    asObject<ProjectRunRow>({
      id: asString,
      number: asNumber,
      workflow: asString,
      branch: asString,
      status: asString,
      at: asNumber,
      version: asString,
      buildNumber: asString,
    }),
  ),
  more: asBoolean,
})

export const asProjectApp = asObject<ProjectApp>({
  slug: asString,
  name: asString,
  app: asAppHeading,
  sequence: asOptional(asBuildNumberSequence),
  shared: asArray(asString),
  defaultScheme: asObject({ format: asString, scope: asString }),
  canSeed: asBoolean,
})

export const asMasonfileCommits = asArray(
  asObject<MasonfileCommit>({ sha: asString, branch: asString }),
)

export const asMasonfileText = asObject<MasonfileText>({
  commit: asString,
  file: asString,
  text: asString,
})

/** `POST /api/v2/build-numbers/seed`, the master: where a sequence stands. */
export const SEED_PATH = '/api/v2/build-numbers/seed'

/** What *Set where it stands* sends. */
export interface SeedRequest {
  project: string
  key: string
  /** A per-branch sequence's branch. */
  branch?: string
  last: string
}

/** `GET`, `PUT /api/v2/projects/:slug`, the master: the project itself. */
export const projectPath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}`
/** `POST /api/v2/projects/check`, the master: wizard step 1. */
export const PROJECT_CHECK_PATH = '/api/v2/projects/check'
/** `GET`, `POST /api/v2/projects/:slug/discover`, the master: wizard step 2. */
export const discoverPath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/discover`
/** `POST /api/v2/projects/:slug/wizard/apps|rules`, the master. */
export const wizardPath = (slug: string, step: 'apps' | 'rules'): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/wizard/${step}`
/** `POST /api/v2/projects/:slug/webhook`, the master. */
export const webhookPath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/webhook`

/** What the wizard reads of `GET /api/v2/projects/:slug`. */
export interface ProjectRecordView {
  slug: string
  name: string
  repository: string
  defaultBranch: string
  format: string
  webhookSecret: { set: boolean }
  apps: Array<{ bundleId: string }>
  rules: Array<{ pattern: string; mode: string }>
}

/** What `POST /api/v2/projects/check` answers: the repository the master can read. */
export interface RepositoryCheck {
  repository: string
  slug: string
  defaultBranch: string
}

/** An app ID a Masonfile declares. */
export interface DeclaredApp {
  bundleId: string
  platforms: string[]
  bundleIds?: string[]
}

/** What `GET /api/v2/projects/:slug/discover` answers: the latest discovery run, if any. */
export interface Discovery {
  run: string
  status: string
  reason: string | null
  apps?: DeclaredApp[]
  triggers?: Record<string, unknown[]>
}

export const asProjectRecordView = asObject<ProjectRecordView>({
  slug: asString,
  name: asString,
  repository: asString,
  defaultBranch: asString,
  format: asString,
  webhookSecret: asObject({ set: asBoolean }),
  apps: asArray(asObject({ bundleId: asString })),
  rules: asArray(asObject({ pattern: asString, mode: asString })),
})

export const asRepositoryCheck = asObject<RepositoryCheck>({
  repository: asString,
  slug: asString,
  defaultBranch: asString,
})

export const asDiscovery = asEither(
  asNull,
  asObject<Discovery>({
    run: asString,
    status: asString,
    reason: asEither(asString, asNull),
    apps: asOptional(
      asArray(
        asObject<DeclaredApp>({
          bundleId: asString,
          platforms: asArray(asString),
          bundleIds: asOptional(asArray(asString)),
        }),
      ),
    ),
    triggers: asOptional(asRecord(asArray(asUnknown))),
  }),
)

/** What the webhook route answers. */
export const asWebhookCreated = asObject({
  created: asUnknown,
  url: asString,
})
