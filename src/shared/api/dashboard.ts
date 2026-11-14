import {
  asArray,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
} from 'cleaners'

/** `GET /api/v2/dashboard?platform=&project=`, both nodes: Projects & apps. */
export const DASHBOARD_PATH = '/api/v2/dashboard'
/** `GET /api/v2/queue`, both nodes: the running and queued stages. */
export const QUEUE_PATH = '/api/v2/queue'

/** The platforms Mason builds for, in the order the pages list them. */
export const platformNames = [
  'ios',
  'android',
  'macos',
  'windows',
  'tvos',
] as const
export type PlatformName = (typeof platformNames)[number]

/** The dashboard's filter: a platform and a project. */
export interface DashboardFilter {
  platform?: string
  project?: string
}

/** A worker on the master's dashboard. */
export interface WorkerNode {
  name: string
  status: 'idle' | 'busy' | 'offline'
  /** Type, operating system and slots. */
  detail: string
}

/** One project's card. */
export interface ProjectCard {
  id: number
  slug: string
  name: string
  defaultBranch: string | null
  repository?: string
  webhook?: boolean
  /** The latest run's commit and description. */
  latest?: { commit: string; description: string; at: number }
  runs: Array<{
    id: string
    branch: string
    number: number
    status: string
    workflow: string
  }>
  apps: Array<{
    id: number
    slug: string
    name: string
    platforms: string[]
    /** The latest build of each branch: push branches first, then the newest. */
    builds: Array<{
      branch: string
      buildNumber: string
      at: number
      /** The run that published it, and that run's status. */
      run?: string
      status?: string
    }>
    /** How many branches have a build: more than `builds` holds for an app built on very many. */
    branches: number
  }>
}

/** A queue panel's entry: a running or queued stage of a run. */
export interface QueueEntry {
  job: string
  project: string
  workflow: string
  number: number
  branch: string
  stage: string
  status: string
  /** How long it has run, in ms. */
  elapsed?: number
  /** Its share of the usual time for the stage, below 1. */
  progress?: number
}

/** What `GET /api/v2/dashboard` answers: everything Projects & apps shows. */
export interface DashboardData {
  tiles: {
    projects: number
    apps: number
    successRate?: number
    finished: number
    storage: number
  }
  counts: Record<'all' | PlatformName, number>
  filter: DashboardFilter
  projects: ProjectCard[]
  queue: QueueEntry[]
  builds: Array<{
    id: number
    app: string
    platform: string
    buildNumber: string
    version: string
    branch: string
    at: number
    size: number
  }>
  /** The master's workers; the host has none. */
  nodes?: WorkerNode[]
}

export const asWorkerNode = asObject<WorkerNode>({
  name: asString,
  status: asValue('idle', 'busy', 'offline'),
  detail: asString,
})

export const asQueueEntry = asObject<QueueEntry>({
  job: asString,
  project: asString,
  workflow: asString,
  number: asNumber,
  branch: asString,
  stage: asString,
  status: asString,
  elapsed: asOptional(asNumber),
  progress: asOptional(asNumber),
})
export const asQueue = asArray(asQueueEntry)

const asNullableString = (raw: unknown): string | null =>
  raw === null ? null : asString(raw)

export const asProjectCard = asObject<ProjectCard>({
  id: asNumber,
  slug: asString,
  name: asString,
  defaultBranch: asNullableString,
  repository: asOptional(asString),
  webhook: asOptional((raw) => {
    if (typeof raw !== 'boolean') throw new TypeError('Expected a boolean')
    return raw
  }),
  latest: asOptional(
    asObject({ commit: asString, description: asString, at: asNumber }),
  ),
  runs: asArray(
    asObject({
      id: asString,
      branch: asString,
      number: asNumber,
      status: asString,
      workflow: asString,
    }),
  ),
  apps: asArray(
    asObject({
      id: asNumber,
      slug: asString,
      name: asString,
      platforms: asArray(asString),
      builds: asArray(
        asObject({
          branch: asString,
          buildNumber: asString,
          at: asNumber,
          run: asOptional(asString),
          status: asOptional(asString),
        }),
      ),
      branches: asNumber,
    }),
  ),
})

export const asDashboardData = asObject<DashboardData>({
  tiles: asObject({
    projects: asNumber,
    apps: asNumber,
    successRate: asOptional(asNumber),
    finished: asNumber,
    storage: asNumber,
  }),
  counts: asObject({
    all: asNumber,
    ios: asNumber,
    android: asNumber,
    macos: asNumber,
    windows: asNumber,
    tvos: asNumber,
  }),
  filter: asObject({
    platform: asOptional(asString),
    project: asOptional(asString),
  }),
  projects: asArray(asProjectCard),
  queue: asQueue,
  builds: asArray(
    asObject({
      id: asNumber,
      app: asString,
      platform: asString,
      buildNumber: asString,
      version: asString,
      branch: asString,
      at: asNumber,
      size: asNumber,
    }),
  ),
  nodes: asOptional(asArray(asWorkerNode)),
})
