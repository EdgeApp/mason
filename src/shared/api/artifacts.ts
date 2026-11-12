import {
  asArray,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner,
} from 'cleaners'

/** `GET /api/v2/artifacts?project=&branch=`, both nodes: the latest runs. */
export const ARTIFACTS_PATH = '/api/v2/artifacts'
/** `GET /api/v2/artifacts/runs/:id`, both nodes: one run's artifacts. */
export const artifactRunPath = (id: string): string =>
  `/api/v2/artifacts/runs/${encodeURIComponent(id)}`

/** A run on the Artifacts pages. */
export interface ArtifactRun {
  id: string
  number: number
  workflow: string
  branch: string
  status: string
  project: { slug: string; name: string }
  commit: string | null
  description: string | null
  created: number
  started: number | null
  finished: number | null
}

/** A row of the Artifacts list: a run, its published builds' numbers and its saved artifacts. */
export interface ArtifactsRow extends ArtifactRun {
  /** The build numbers its published builds carry, each once. */
  buildNumbers: string[]
  /** How many published files the viewer may see. */
  builds: number
  /** Its saved artifacts: how many and their bytes. */
  artifacts: { count: number; size: number }
}

/** What `GET /api/v2/artifacts` answers: the latest 50 runs of every project or one. */
export interface ArtifactsList {
  /** The project it is narrowed to, by its slug and name. */
  project?: { slug: string; name: string }
  branch?: string
  runs: ArtifactsRow[]
  /** Every project, for the project select. */
  projects: Array<{ slug: string; name: string }>
  /** The narrowed-to project's branches, newest run first (none without a project). */
  branches: string[]
}

/** A build a run published, which the viewer may see. */
export interface PublishedBuild {
  id: number
  appId: number
  /** The app's name. */
  app: string
  platform: string
  version: string
  buildNumber: string
  size: number
  variant: string
  format: string
  /** What a build that only downloads runs on (an iPhone Simulator build). */
  downloadOnly?: string
}

/** A file a run saved. */
export interface SavedArtifact {
  name: string
  stage: string
  kind: string
  size: number
  created: number
  /** Where it downloads, under the artifact origin. */
  url: string
  /** A report's sandboxed viewer. */
  viewUrl?: string
}

/** What `GET /api/v2/artifacts/runs/:id` answers. */
export interface ArtifactRunDetail {
  run: ArtifactRun
  stages: Array<{
    name: string
    status: string
    kind: string
    started: number | null
    finished: number | null
  }>
  tests: Array<{
    stage: string
    passed: number
    failed: number
    skipped: number
  }>
  builds: PublishedBuild[]
  artifacts: SavedArtifact[]
  /** The origin artifacts are served from: the host's, or `''` for the node itself. */
  artifactOrigin: string
}

const asNullable =
  <T>(cleaner: Cleaner<T>): Cleaner<T | null> =>
  (raw) =>
    raw === null ? null : cleaner(raw)

const runFields = {
  id: asString,
  number: asNumber,
  workflow: asString,
  branch: asString,
  status: asString,
  project: asObject({ slug: asString, name: asString }),
  commit: asNullable(asString),
  description: asNullable(asString),
  created: asNumber,
  started: asNullable(asNumber),
  finished: asNullable(asNumber),
}

export const asArtifactRun = asObject<ArtifactRun>(runFields)

export const asArtifactsList = asObject<ArtifactsList>({
  project: asOptional(asObject({ slug: asString, name: asString })),
  branch: asOptional(asString),
  runs: asArray(
    asObject<ArtifactsRow>({
      ...runFields,
      buildNumbers: asArray(asString),
      builds: asNumber,
      artifacts: asObject({ count: asNumber, size: asNumber }),
    }),
  ),
  projects: asArray(asObject({ slug: asString, name: asString })),
  branches: asArray(asString),
})

export const asPublishedBuild = asObject<PublishedBuild>({
  id: asNumber,
  appId: asNumber,
  app: asString,
  platform: asString,
  version: asString,
  buildNumber: asString,
  size: asNumber,
  variant: asString,
  format: asString,
  downloadOnly: asOptional(asString),
})

export const asArtifactRunDetail = asObject<ArtifactRunDetail>({
  run: asArtifactRun,
  stages: asArray(
    asObject({
      name: asString,
      status: asString,
      kind: asString,
      started: asNullable(asNumber),
      finished: asNullable(asNumber),
    }),
  ),
  tests: asArray(
    asObject({
      stage: asString,
      passed: asNumber,
      failed: asNumber,
      skipped: asNumber,
    }),
  ),
  builds: asArray(asPublishedBuild),
  artifacts: asArray(
    asObject<SavedArtifact>({
      name: asString,
      stage: asString,
      kind: asString,
      size: asNumber,
      created: asNumber,
      url: asString,
      viewUrl: asOptional(asString),
    }),
  ),
  artifactOrigin: asString,
})

export { asNullable }
