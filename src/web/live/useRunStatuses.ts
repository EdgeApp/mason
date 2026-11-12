// Keeps each unfinished run's status current from /live: a `status`
// subscription per run while it is queued, running or awaiting approval,
// which the node ends once the run finishes.
import { useEffect, useState } from 'react'
import { useLiveClient } from './LiveProvider.js'

/** The statuses a run can still leave. */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'awaiting_approval',
])

/**
 * The latest status /live sent for each of these runs that was unfinished
 * when the page read it; a run /live has not spoken of keeps its own.
 */
export function useRunStatuses(
  runs: ReadonlyArray<{ id: string; status?: string | undefined }>,
): Record<string, string> {
  const client = useLiveClient()
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const watched = runs
    .filter((run) => run.status != null && ACTIVE_STATUSES.has(run.status))
    .map((run) => run.id)
  const key = [...new Set(watched)].sort().join('\n')
  useEffect(() => {
    if (client == null || key === '') return undefined
    const stops = key.split('\n').map((id) =>
      client.subscribe(
        `run-status:${id}`,
        () => ({ subscribe: 'status', run: id }),
        (frame) => {
          if (frame.event !== 'run') return
          const status = (frame.data as { status?: unknown } | undefined)
            ?.status
          if (typeof status !== 'string') return
          setStatuses((was) =>
            was[id] === status ? was : { ...was, [id]: status },
          )
        },
      ),
    )
    return (): void => {
      for (const stop of stops) stop()
    }
  }, [client, key])
  return statuses
}
