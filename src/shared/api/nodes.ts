// The Nodes page's reads and requests (docs/api.md §8, §9, §12): a node's
// inventory and checklist as `GET /api/v2/nodes` answers them, the cloud
// host and cloud nodes in their record shape, pools with their machines,
// the `nodeTypes` and `host` settings areas as far as the page reads them,
// and the bodies the page sends.
import {
  asArray,
  asBoolean,
  asMaybe,
  asNumber,
  asObject,
  asOptional,
  asString,
  asUnknown,
  type Cleaner,
} from 'cleaners'
import { asNodeView, type NodeView } from './admin.js'
import { asRecord } from './runs.js'

/** `PUT /api/v2/nodes/:fingerprint`: a node's name, type, labels and slots. */
export const nodePath = (fingerprint: string): string =>
  `/api/v2/nodes/${encodeURIComponent(fingerprint)}`
/** `GET|POST /api/v2/cloud/hosts`: the cloud host, if any; making one. */
export const CLOUD_HOSTS_PATH = '/api/v2/cloud/hosts'
/** `DELETE /api/v2/cloud/hosts/:name`, and its `/reconcile` and `/space`. */
export const cloudHostPath = (
  name: string,
  action?: 'reconcile' | 'space',
): string =>
  `${CLOUD_HOSTS_PATH}/${encodeURIComponent(name)}${action == null ? '' : `/${action}`}`
/** `GET|POST /api/v2/cloud/nodes`: permanent cloud workers. */
export const CLOUD_NODES_PATH = '/api/v2/cloud/nodes'
/** `DELETE /api/v2/cloud/nodes/:name`, and its `/reconcile`. */
export const cloudNodePath = (name: string, action?: 'reconcile'): string =>
  `${CLOUD_NODES_PATH}/${encodeURIComponent(name)}${action == null ? '' : `/${action}`}`
/** `GET|POST /api/v2/cloud/pools`. */
export const CLOUD_POOLS_PATH = '/api/v2/cloud/pools'
/** `PUT|DELETE /api/v2/cloud/pools/:name`. */
export const cloudPoolPath = (name: string): string =>
  `${CLOUD_POOLS_PATH}/${encodeURIComponent(name)}`
/** `GET /api/v2/settings/nodeTypes`: every node type. */
export const NODE_TYPES_PATH = '/api/v2/settings/nodeTypes'
/** `GET /api/v2/settings/host`: the host's public origin, once set. */
export const HOST_SETTINGS_PATH = '/api/v2/settings/host'

/** The label a node carries to run setup stages (`src/pipeline/graph.ts`). */
export const SETUP_LABEL = 'setup'

/** DigitalOcean's Spaces regions (`src/master/cloud/regions.ts`). */
export const SPACES_REGIONS = [
  'sfo3',
  'nyc3',
  'ams3',
  'fra1',
  'lon1',
  'sgp1',
  'syd1',
  'blr1',
  'tor1',
  'atl1',
] as const

/** An Xcode a node reported. */
export interface NodeXcode {
  version: string
  beta?: boolean
}

/** What a node reported of itself. */
export interface NodeInventory {
  version?: string
  /** `macos`, `linux`, `windows`. */
  os?: string
  osVersion?: string
  arch?: string
  /** Bytes, decimal. */
  freeDisk?: number
  xcodes: NodeXcode[]
  /** Each tool's installed versions (a list), or a newer worker's own shape. */
  tools: Record<string, unknown>
}

/** A manual step that blocks a node, as the master checks it. */
export interface ChecklistItem {
  id?: string
  title: string
  /** Set once the step is done; a step the master lists is still to do. */
  done: boolean
}

/** A paired node with its inventory and checklist typed. */
export interface NodeCard extends Omit<NodeView, 'inventory' | 'checklist'> {
  inventory?: NodeInventory
  checklist: ChecklistItem[]
}

/** A machine the master made on DigitalOcean: the host, or a permanent node. */
export interface CloudMachine {
  name: string
  account: string
  region: string
  size: string
  image?: string
  /** `creating`, `installing`, `pairing`, `ready`, `updating`, `error`, `removing`. */
  state: string
  error?: string
  address?: string
  /** The release it runs, or the one it is updating to. */
  version?: string
  /** The origin a host serves. */
  origin?: string
  dns_domain?: string
  /** A record in the domain, `@` for the domain itself. */
  dns_name?: string
  space_bucket?: string
  space_region?: string
  /** The Space waits to be made at the host's next check. */
  space_pending?: number
  /** A permanent node's type. */
  node_type?: string
  labels: string[]
  /** A host's certificate: `internal` without a DNS name. */
  certificate?: string
}

/** A pool machine. */
export interface PoolMachine {
  id: number
  /** `creating`, `pairing`, `ready`, `retiring`, `snapshotting`, `destroyed`. */
  state: string
  address?: string
}

/** A pool, as `GET /api/v2/cloud/pools` lists it. */
export interface Pool {
  name: string
  type: string
  account: string
  provider?: string
  region: string
  size: string
  image: string
  labels: string[]
  maxNodes: number
  slots: number
  ttlMinutes: number
  maxHoursPerNode: number
  machines: PoolMachine[]
}

/** What a node type installs, as far as its summary says. */
export interface NodeTypeSoftware {
  xcode?: string[]
  node?: string
  java?: string
  rust?: string
  python?: string
  go?: string
  ruby?: string
  brew?: { formulae?: string[]; casks?: string[] }
  apt?: string[]
  dnf?: string[]
  android?: string[]
  docker?: boolean
}

/** The `host` settings area. */
export interface HostSettings {
  origin?: string
}

/** `POST /api/v2/nodes`. */
export interface NodePairing {
  address: string
  key: string
  type?: string
  labels?: string[]
}

/** `PUT /api/v2/nodes/:fingerprint`: a host takes only its name. */
export interface NodeChange {
  name: string
  type?: string
  labels?: string[]
  slots?: number
}

/** `POST /api/v2/cloud/hosts`. */
export interface CloudHostRequest {
  account: string
  name: string
  region: string
  size: string
  image: string
  dns?: { domain: string; name: string }
  space?: { bucket: string; region: string }
}

/** `POST /api/v2/cloud/nodes`. */
export interface CloudNodeRequest {
  account: string
  name: string
  type: string
  labels: string[]
  region: string
  size: string
  image: string
}

/** `POST /api/v2/cloud/pools`, `PUT …/:name` (NoMac pools leave region, size and image out). */
export interface PoolRequest {
  account: string
  name: string
  type: string
  region?: string
  size?: string
  image?: string
  labels: string[]
  maxNodes: number
  slots: number
  ttlMinutes: number
  maxHoursPerNode: number
}

/** `POST …/hosts/:name/space`. */
export interface SpaceRequest {
  bucket: string
  region: string
}

/** `DELETE …/hosts/:name`. */
export interface HostRemoval {
  confirm: string
  deleteSpace: boolean
}

export const asNodeXcode = asObject<NodeXcode>({
  version: asString,
  beta: asOptional(asBoolean),
})

export const asNodeInventory = asObject<NodeInventory>({
  version: asOptional(asString),
  os: asOptional(asString),
  osVersion: asOptional(asString),
  arch: asOptional(asString),
  freeDisk: asOptional(asNumber),
  xcodes: asOptional(asArray(asNodeXcode), () => []),
  tools: asOptional(asRecord(asUnknown), () => ({})),
})

/** A checklist item: older workers sent `text` where newer ones send `title`. */
export const asChecklistItem: Cleaner<ChecklistItem> = (raw) => {
  const item = asObject({
    id: asOptional(asString),
    title: asOptional(asString),
    text: asOptional(asString),
    done: asOptional(asBoolean, false),
  })(raw)
  return {
    ...(item.id == null ? {} : { id: item.id }),
    title: item.title ?? item.text ?? '',
    done: item.done,
  }
}

/** A node from `GET /api/v2/nodes`, its inventory and checklist typed; what does not read as either is left out. */
export const asNodeCard: Cleaner<NodeCard> = (raw) => {
  const { inventory, checklist, ...view } = asNodeView(raw)
  const typed = asMaybe(asNodeInventory)(inventory)
  return {
    ...view,
    ...(typed == null ? {} : { inventory: typed }),
    checklist: checklist.flatMap((item) => {
      const clean = asMaybe(asChecklistItem)(item)
      return clean == null ? [] : [clean]
    }),
  }
}
export const asNodeCards = asArray(asNodeCard)

export const asCloudMachine = asObject<CloudMachine>({
  name: asString,
  account: asString,
  region: asString,
  size: asString,
  image: asOptional(asString),
  state: asString,
  error: asOptional(asString),
  address: asOptional(asString),
  version: asOptional(asString),
  origin: asOptional(asString),
  dns_domain: asOptional(asString),
  dns_name: asOptional(asString),
  space_bucket: asOptional(asString),
  space_region: asOptional(asString),
  space_pending: asOptional(asNumber),
  node_type: asOptional(asString),
  labels: asOptional(asArray(asString), () => []),
  certificate: asOptional(asString),
})
export const asCloudMachines = asArray(asCloudMachine)

export const asPoolMachine = asObject<PoolMachine>({
  id: asNumber,
  state: asString,
  address: asOptional(asString),
})

export const asPool = asObject<Pool>({
  name: asString,
  type: asString,
  account: asString,
  provider: asOptional(asString),
  region: asString,
  size: asString,
  image: asString,
  labels: asArray(asString),
  maxNodes: asNumber,
  slots: asNumber,
  ttlMinutes: asNumber,
  maxHoursPerNode: asNumber,
  machines: asOptional(asArray(asPoolMachine), () => []),
})
export const asPools = asArray(asPool)

const asNames = asOptional(asArray(asString))

export const asNodeTypeSoftware = asObject<NodeTypeSoftware>({
  xcode: asNames,
  node: asOptional(asString),
  java: asOptional(asString),
  rust: asOptional(asString),
  python: asOptional(asString),
  go: asOptional(asString),
  ruby: asOptional(asString),
  brew: asOptional(asObject({ formulae: asNames, casks: asNames })),
  apt: asNames,
  dnf: asNames,
  android: asNames,
  docker: asOptional(asBoolean),
})

/** The `nodeTypes` area: each type's software; a type that does not read is summarised as managing nothing. */
export const asNodeTypes: Cleaner<Record<string, NodeTypeSoftware>> = (raw) => {
  const area = asRecord(asUnknown)(raw)
  return Object.fromEntries(
    Object.entries(area).map(([name, value]) => [
      name,
      asMaybe(asObject({ software: asNodeTypeSoftware }))(value)?.software ??
        {},
    ]),
  )
}

export const asHostSettings = asObject<HostSettings>({
  origin: asOptional(asString),
})

/** An answer the page uses only for its name: a paired or saved node, a made host. */
export const asNamed = asObject({ name: asOptional(asString) })
