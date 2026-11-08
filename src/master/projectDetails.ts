import type { BuildNumbers } from './buildNumbers.js'
import type { Project } from './projects.js'
import type { Pushes } from './pushes.js'

/**
 * What a project's pages show beyond its name: the same object on the master,
 * which builds it, and on the host, which keeps the copy the master sends.
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

/** One build-number sequence: its scheme and the last number per branch (`''` across branches). */
export interface BuildNumberSequence {
  key: string
  format: string
  scope: string
  /** Other app IDs that take their numbers from it. */
  apps: string[]
  last: Array<{ branch: string; value: string }>
}

/** What the Masonfile tab says of a project with none. */
export const SCRIPT_PROJECT =
  'This project builds from a script; it has no Masonfile.'

/** A project's details as the master knows them. */
export function projectDetails(
  project: Project,
  buildNumbers: Pick<BuildNumbers, 'sequences'>,
  pushes: Pick<Pushes, 'cached' | 'latest'>,
): ProjectDetails {
  // The branches the build's push trigger names, from the default branch's last setup, else any branch's.
  const push =
    pushes.cached(project, project.defaultBranch) ?? pushes.latest(project)
  const pinned =
    push?.build == null
      ? []
      : push.build === true
        ? project.rules
            .filter((rule) => rule.mode === 'automatic')
            .map((rule) => rule.pattern)
        : push.build
  return {
    repository: project.repository,
    defaultBranch: project.defaultBranch,
    format: project.format,
    apps: project.apps.map((entry) => ({
      bundleId: entry.bundleId,
      platforms: entry.platforms,
      ...(entry.apple == null ? {} : { apple: { team: entry.apple.team } }),
    })),
    rules: project.rules.map((rule) => ({
      pattern: rule.pattern,
      mode: rule.mode,
    })),
    webhook: project.webhookSecret.set,
    ...(project.signingLabel == null
      ? {}
      : { signingLabel: project.signingLabel }),
    pinned,
    buildNumbers: buildNumbers.sequences(project.id).map((sequence) => ({
      key: sequence.key,
      format: sequence.scheme.format,
      scope: sequence.scheme.scope,
      apps: sequence.scheme.apps ?? [],
      last: sequence.last,
    })),
  }
}

/** The copy a host keeps, read back; undefined until the master sent one. */
export function storedDetails(value: unknown): ProjectDetails | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return JSON.parse(value) as ProjectDetails
  } catch {
    return undefined
  }
}
