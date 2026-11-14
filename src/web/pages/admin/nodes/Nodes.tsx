// Nodes, on the master for managers and administrators (screen-09-nodes,
// screen-09b-nodes-host): the paired nodes with their checklists and Edit,
// Pair a node, the cloud nodes and pools in the main column; the host in
// every state, its storage and the node types in the aside. Pairing and
// editing need `nodes.change`; the host's making, reconciling and removal
// `hosts.change` (administrators); cloud nodes, pools and the host's Space
// `settings.change`. Every card loads, fails and empties on its own.
import { useState, type JSX } from 'react'
import {
  asCloudBudget,
  CLOUD_BUDGET_PATH,
  NODES_PATH,
} from '../../../../shared/api/admin.js'
import {
  asCloudAccountViews,
  CLOUD_ACCOUNTS_PATH,
} from '../../../../shared/api/cloud.js'
import { asNodeInfo, NODE_PATH } from '../../../../shared/api/node.js'
import {
  asCloudMachines,
  asHostSettings,
  asNodeCards,
  asNodeTypes,
  asPools,
  CLOUD_HOSTS_PATH,
  CLOUD_NODES_PATH,
  CLOUD_POOLS_PATH,
  HOST_SETTINGS_PATH,
  NODE_TYPES_PATH,
  type NodeCard,
} from '../../../../shared/api/nodes.js'
import type { Permission } from '../../../../shared/permissions.js'
import { useResource } from '../../../hooks/useResource.js'
import { Page } from '../../../layout/Page.js'
import { useShell } from '../../../layout/ShellContext.js'
import { Button } from '../../../ui/Button.js'
import { CloudNodesCard } from './cloudNodes.js'
import { HostCard } from './host.js'
import { EditNodeSheet, NodeList, PairNodeSheet } from './nodeCards.js'
import { NodeTypesCard } from './nodeTypes.js'
import type { Allowed } from './parts.js'
import { PoolsCard } from './pools.js'

/** `/nodes`, the master only. */
export function NodesPage(): JSX.Element {
  const { session } = useShell()
  const may = (permission: Permission): boolean =>
    session.permissions.includes(permission)
  const allowed: Allowed = {
    nodes: may('nodes.change'),
    hosts: may('hosts.change'),
    settings: may('settings.change'),
  }
  const nodes = useResource(NODES_PATH, asNodeCards, {
    invalidatedBy: ['status'],
  })
  const hosts = useResource(CLOUD_HOSTS_PATH, asCloudMachines)
  const cloudNodes = useResource(CLOUD_NODES_PATH, asCloudMachines)
  const pools = useResource(CLOUD_POOLS_PATH, asPools)
  const budget = useResource(CLOUD_BUDGET_PATH, asCloudBudget)
  const accounts = useResource(CLOUD_ACCOUNTS_PATH, asCloudAccountViews)
  const types = useResource(NODE_TYPES_PATH, asNodeTypes)
  const origin = useResource(HOST_SETTINGS_PATH, asHostSettings)
  const node = useResource(NODE_PATH, asNodeInfo)
  const [pairing, setPairing] = useState(false)
  const [editing, setEditing] = useState<NodeCard | undefined>()
  const release = node.data?.release
  const hostNode = nodes.data?.find((entry) => entry.role === 'host')
  /** The host changed: it, its origin, the nodes and the storage. */
  const hostChanged = (): void => {
    hosts.reload()
    origin.reload()
    nodes.reload()
  }
  return (
    <Page
      crumbs={[{ label: 'Nodes' }]}
      title="Nodes"
      description="Workers and the host, their software, and what each still needs from a person."
      actions={
        allowed.nodes && (
          <Button
            variant="primary"
            icon="lan"
            aria-haspopup="dialog"
            onClick={() => setPairing(true)}
          >
            Pair a node
          </Button>
        )
      }
    >
      <div className="m-split">
        <div className="m-stack m-stack--lg">
          <NodeList
            read={nodes}
            canChange={allowed.nodes}
            onPair={() => setPairing(true)}
            onEdit={setEditing}
          />
          <CloudNodesCard
            read={cloudNodes}
            accounts={accounts.data ?? []}
            canChange={allowed.settings}
            onChanged={() => {
              cloudNodes.reload()
              nodes.reload()
            }}
          />
          <PoolsCard
            read={pools}
            budget={budget}
            accounts={accounts}
            canChange={allowed.settings}
            onChanged={() => {
              pools.reload()
              budget.reload()
            }}
          />
        </div>
        <aside className="m-stack" aria-label="Host and node types">
          <HostCard
            hosts={hosts}
            origin={origin}
            hostNode={hostNode}
            accounts={accounts}
            allowed={allowed}
            release={release}
            onChanged={hostChanged}
          />
          <NodeTypesCard read={types} />
        </aside>
      </div>
      {allowed.nodes && (
        <>
          <PairNodeSheet
            open={pairing}
            release={release}
            onClose={() => setPairing(false)}
            onPaired={nodes.reload}
          />
          <EditNodeSheet
            node={editing}
            onClose={() => setEditing(undefined)}
            onSaved={nodes.reload}
          />
        </>
      )}
    </Page>
  )
}
