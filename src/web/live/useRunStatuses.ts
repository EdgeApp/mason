// Keeps each unfinished run's status current from /live: a `status`
// subscription per run while it is queued, running or awaiting approval,
// which the node ends once the run finishes.
import { useEffect, useRef, useState } from 'react'
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
  // One subscription per run for as long as it stays in the list: a change
  // to the list subscribes only the runs it adds and ends only those it
  // drops, so a busy dashboard sends no burst of messages.
  const held = useRef(new Map<string, () => void>())
  useEffect(() => {
    if (client == null) return
    const now = new Set(key === '' ? [] : key.split('\n'))
    for (const [id, stop] of held.current)
      if (!now.has(id)) {
        stop()
        held.current.delete(id)
      }
    for (const id of now)
      if (!held.current.has(id))
        held.current.set(
          id,
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
  }, [client, key])
  useEffect(() => {
    const subscriptions = held.current
    return (): void => {
      for (const stop of subscriptions.values()) stop()
      subscriptions.clear()
    }
  }, [client])
  return statuses
}
