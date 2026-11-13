// Build numbers as a project's app ID reads them: the sequence it takes
// its numbers from and the app IDs that share it.
import type { BuildNumberSequence } from '../master/projectDetails.js'
import type { ProjectApp } from '../shared/api/projects.js'

/**
 * The sequence an app ID takes its build numbers from, as the scheduler
 * picks it: a shared sequence whose `apps` lists it, else its own key;
 * undefined for the default scheme.
 */
export function appSequence(
  sequences: BuildNumberSequence[],
  appId: string,
): BuildNumberSequence | undefined {
  return (
    sequences.find((sequence) => sequence.apps.includes(appId)) ??
    sequences.find((sequence) => sequence.key === appId)
  )
}

/** An app ID's sequence, the other app IDs it numbers, and the default scheme. */
export function appBuildNumbers(
  sequences: BuildNumberSequence[],
  projectApps: string[],
  appId: string,
): Pick<ProjectApp, 'sequence' | 'shared' | 'defaultScheme'> {
  const sequence = appSequence(sequences, appId)
  return {
    ...(sequence == null ? {} : { sequence }),
    shared:
      sequence == null
        ? []
        : [
            ...(sequence.key !== appId && projectApps.includes(sequence.key)
              ? [sequence.key]
              : []),
            ...sequence.apps.filter((app) => app !== appId),
          ],
    defaultScheme: { format: 'N', scope: 'app' },
  }
}
