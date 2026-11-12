import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
} from 'cleaners'

/** `GET /api/v2/projects/:slug/overview`, both nodes. */
export const projectOverviewPath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/overview`
/** `GET /api/v2/projects/:slug/runs?branch=&app=`, both nodes. */
export const projectRunsPath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/runs`
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
