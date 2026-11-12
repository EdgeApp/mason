import type { JSX } from 'react'
import { useLiveState } from '../live/LiveProvider.js'
import type { LiveState } from '../live/LiveClient.js'
import { StatusPill } from '../ui/StatusPill.js'

/** The footer's words for this browser's live connection. */
export function liveStatus(
  state: LiveState,
  masterUnreachable: boolean,
): { status: string; label: string; live?: boolean } {
  if (masterUnreachable)
    return { status: 'unreachable', label: 'Master unreachable' }
  switch (state) {
    case 'open':
      return { status: 'idle', label: 'Live', live: true }
    case 'connecting':
      return { status: 'reconnecting', label: 'Connecting…' }
    case 'reconnecting':
      return { status: 'reconnecting', label: 'Reconnecting…' }
    case 'unavailable':
      return { status: 'live_unavailable', label: 'Live updates unavailable' }
    case 'closed':
      return { status: 'offline', label: 'Offline' }
  }
}

/**
 * The sidebar's footer line: this browser's live connection (Live,
 * Reconnecting…, Offline), or on a host whose master is unreachable,
 * "Master unreachable" in warning tone, matching the banner.
 */
export function LiveFooter({
  masterUnreachable,
}: {
  masterUnreachable: boolean
}): JSX.Element {
  const state = useLiveState()
  const shown = liveStatus(state, masterUnreachable)
  return (
    <span aria-live="polite">
      <StatusPill
        status={shown.status}
        label={shown.label}
        quiet
        live={shown.live === true}
      />
    </span>
  )
}
