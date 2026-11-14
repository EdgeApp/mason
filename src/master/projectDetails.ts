import type { BuildNumbers } from './buildNumbers.js'
import type { Project } from './projects.js'
import type { Pushes } from './pushes.js'
import type {
  BuildNumberSequence,
  ProjectDetails,
} from '../shared/api/projects.js'

export type { BuildNumberSequence, ProjectDetails }

/** What the Masonfile tab says of a project with none. */
export const SCRIPT_PROJECT =
  'This project builds from a script; it has no Masonfile.'

/**
 * The branches (or patterns) the project's push trigger builds, which its
 * pages list first: from the default branch's last setup, else any
 * branch's; a trigger on every push builds its automatic rules' branches.
 */
export function pushBranches(
  project: Project,
  pushes: Pick<Pushes, 'cached' | 'latest'>,
): string[] {
  const push =
    pushes.cached(project, project.defaultBranch) ?? pushes.latest(project)
  return push?.build == null
    ? []
    : push.build === true
      ? project.rules
          .filter((rule) => rule.mode === 'automatic')
          .map((rule) => rule.pattern)
      : push.build
}

/** A project's details as the master knows them. */
export function projectDetails(
  project: Project,
  buildNumbers: Pick<BuildNumbers, 'sequences'>,
  pushes: Pick<Pushes, 'cached' | 'latest'>,
): ProjectDetails {
  const pinned = pushBranches(project, pushes)
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
