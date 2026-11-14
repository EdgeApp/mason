import type { JSX } from 'react'
import type { ClusterStatus } from '../../shared/api/index.js'
import { StatusPill } from '../ui/StatusPill.js'

/** The workers' status: idle when some are, busy when none is, offline with none linked. */
export const workersStatus = (cluster: ClusterStatus): string =>
  cluster.total === 0 ? 'offline' : cluster.idle > 0 ? 'idle' : 'busy'

/** "2 / 3 workers idle", or "No workers" when none is linked. */
export const workersLabel = (
  cluster: ClusterStatus,
  compact = false,
): string =>
  cluster.total === 0
    ? 'No workers'
    : `${cluster.idle} / ${cluster.total}${compact ? ' idle' : ' workers idle'}`

/**
 * The master's cluster in the top bar: both chips on wide (workers idle,
 * cluster health), one compact chip toned by health on medium. Narrow puts
 * it in the account menu.
 */
export function ClusterChips({
  cluster,
  nodesLink,
}: {
  cluster: ClusterStatus
  /** The workers' chip opens Nodes, for those who may. */
  nodesLink: boolean
}): JSX.Element {
  const health = cluster.healthy ? 'healthy' : 'degraded'
  const name = `Cluster ${cluster.healthy ? 'healthy' : 'degraded'}, ${
    cluster.total === 0
      ? 'no workers'
      : `${cluster.idle} of ${cluster.total} workers idle`
  }`
  return (
    <>
      <span className="m-topbar__chips m-row">
        <StatusPill
          status={workersStatus(cluster)}
          label={workersLabel(cluster)}
          {...(nodesLink ? { to: '/nodes' } : {})}
        />
        <StatusPill status={health} />
      </span>
      <StatusPill
        className="m-topbar__cluster"
        status={health}
        label={workersLabel(cluster, true)}
        name={name}
        {...(nodesLink ? { to: '/nodes' } : {})}
      />
    </>
  )
}
