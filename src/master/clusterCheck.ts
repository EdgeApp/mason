import { version as masonVersion } from '../version.js'
import type { Master } from './runtime.js'

/** One node's line in `mason cluster check`. */
export interface NodeCheck {
  name: string
  role: 'worker' | 'host'
  fingerprint: string
  linked: boolean
  version?: string
  /** Workers: when the master last heard the node's inventory. */
  inventoryAt?: number
  quarantine?: string
  /** A cloud host restarting into the release the master asked it for. */
  updating?: string
  /** The host: how many changes it has yet to apply, its outbox and refused messages. */
  cache?: { revision: number; lag: number; outbox: number; refused: number }
  problems: string[]
}

export interface ClusterReport {
  master: { version: string; revision: number }
  nodes: NodeCheck[]
  green: boolean
}

/** What the host answers to `host.status`. */
export interface HostStatus {
  revision: number
  outbox: number
  refused: number
  version: string
}

/**
 * Every node's state as the master sees it, and the host's own: linked or
 * not, the Mason version against the master's, the worker's last inventory
 * and quarantine, and the host's cache revision lag, outbox depth and
 * refused messages. Green only when nothing needs a person.
 */
export async function clusterCheck(
  master: Master,
  timeoutMs = 5000,
): Promise<ClusterReport> {
  const revision = master.changes.revision()
  const nodes: NodeCheck[] = []
  const cloudHosts = new Map(
    (master.cloudHosts?.list('all') ?? []).map((row) => [row.fingerprint, row]),
  )
  for (const node of master.registry.list()) {
    const link = master.registry.link(node.fingerprint)
    const linked = link != null || node.host === 'in-process'
    const check: NodeCheck = {
      name: node.name,
      role: node.role,
      fingerprint: node.fingerprint,
      linked,
      ...(node.version == null ? {} : { version: node.version }),
      problems: [],
    }
    const cloud = cloudHosts.get(node.fingerprint)
    if (cloud?.state === 'updating' && cloud.version != null)
      check.updating = cloud.version
    else if (cloud?.error != null) check.problems.push(cloud.error)
    // An updating host is not linked, or on its old release, for a while.
    if (!linked && check.updating == null) check.problems.push('not linked')
    const behind = (running: string): void => {
      if (
        running !== masonVersion &&
        check.updating == null &&
        !check.problems.some((problem) => problem.startsWith('runs Mason'))
      )
        check.problems.push(`runs Mason ${running}, the master ${masonVersion}`)
    }
    if (node.version != null) behind(node.version)
    if (node.role === 'worker') {
      const row = master.database.db
        .prepare(
          'SELECT quarantine,updated FROM worker_inventory WHERE fingerprint=?',
        )
        .get(node.fingerprint) as
        | { quarantine: string | null; updated: number }
        | undefined
      if (row == null) check.problems.push('has sent no inventory')
      else check.inventoryAt = row.updated
      if (row?.quarantine != null) {
        check.quarantine = row.quarantine
        check.problems.push(`is quarantined: ${row.quarantine}`)
      }
    } else if (link != null) {
      try {
        const status = (await link.request(
          'host.status',
          {},
          timeoutMs,
        )) as HostStatus
        check.cache = {
          revision: status.revision,
          lag: Math.max(0, revision - status.revision),
          outbox: status.outbox,
          refused: status.refused,
        }
        check.version = status.version
        behind(status.version)
        if (check.cache.lag > 0)
          check.problems.push(`is ${check.cache.lag} changes behind`)
        if (status.outbox > 0)
          check.problems.push(`has ${status.outbox} outbox messages waiting`)
        if (status.refused > 0)
          check.problems.push(`has ${status.refused} refused outbox messages`)
      } catch (error) {
        check.problems.push(`did not answer: ${(error as Error).message}`)
      }
    }
    nodes.push(check)
  }
  return {
    master: { version: masonVersion, revision },
    nodes,
    green: nodes.every(
      (node) => node.problems.length === 0 && node.updating == null,
    ),
  }
}

/** The report as the terminal shows it. */
export function formatCheck(report: ClusterReport, now = Date.now()): string {
  const lines = [
    `Master  Mason ${report.master.version}, revision ${report.master.revision}`,
  ]
  for (const node of report.nodes) {
    const facts = [
      node.linked ? 'linked' : 'NOT LINKED',
      node.version == null ? undefined : `Mason ${node.version}`,
      node.updating == null ? undefined : `updating to ${node.updating}`,
      node.inventoryAt == null
        ? undefined
        : `inventory ${Math.round((now - node.inventoryAt) / 1000)}s ago`,
      node.cache == null
        ? undefined
        : `cache ${node.cache.revision} (${node.cache.lag} behind), outbox ${node.cache.outbox}, refused ${node.cache.refused}`,
    ].filter((fact) => fact != null)
    lines.push(
      `${node.problems.length > 0 ? '✗' : node.updating != null ? '…' : '✓'} ${node.role.padEnd(6)} ${node.name}  ${facts.join(' · ')}`,
    )
    for (const problem of node.problems)
      lines.push(`    ${node.name} ${problem}`)
  }
  if (report.nodes.length === 0) lines.push('No nodes are paired.')
  const updating = report.nodes.filter((node) => node.updating != null)
  lines.push(
    report.green
      ? 'All green.'
      : report.nodes.every((node) => node.problems.length === 0)
        ? `Updating ${updating.map((node) => node.name).join(', ')} to the master’s release; check again in a few minutes.`
        : 'Something needs a person.',
  )
  return lines.join('\n')
}
