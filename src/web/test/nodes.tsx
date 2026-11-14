// The Nodes page under test: a cluster's answers (paired nodes, the cloud
// host and nodes, pools, the budget, accounts, catalogs, node types and the
// host setting), and the app opened at /nodes for a role.
import type { CloudAccountView, CloudCatalog } from '../../shared/api/cloud.js'
import type { CloudMachine, NodeCard, Pool } from '../../shared/api/nodes.js'
import type { Role } from '../../shared/permissions.js'
import {
  nodeInfo,
  renderApp,
  sessionFor,
  shellReplies,
  type Reply,
} from './render.js'

export const NOW = Date.now()

/** A worker, a busy Linux one, as `GET /api/v2/nodes` lists it. */
export const workerNode = (fields: Partial<NodeCard> = {}): NodeCard => ({
  id: 1,
  fingerprint: 'mldsa65:bern',
  role: 'worker',
  host: '192.168.1.20',
  port: 9310,
  name: 'bern',
  type: 'macos-arm64',
  labels: ['setup', 'mac-signing'],
  slots: 2,
  workspaceRoots: [],
  version: '0.6.0',
  addedAt: NOW - 86_400_000,
  lastSeen: NOW,
  connected: true,
  status: 'idle',
  checklist: [
    { id: 'xcode', title: 'Xcode 26.1 installed', done: true },
    { id: 'android', title: 'Accept the Android SDK licences', done: false },
  ],
  inventory: {
    version: '0.6.0',
    os: 'macos',
    osVersion: '15.1',
    arch: 'arm64',
    freeDisk: 120_400_000_000,
    xcodes: [{ version: '26.1' }, { version: '16.4' }],
    tools: {
      node: ['24.1'],
      java: ['21'],
      ruby: ['3.3'],
      cocoapods: { version: '1.16.2' },
      rust: [],
    },
  },
  ...fields,
})

/** A busy Linux worker with no Xcode and no checklist. */
export const linuxNode = (fields: Partial<NodeCard> = {}): NodeCard =>
  workerNode({
    id: 2,
    fingerprint: 'mldsa65:android',
    name: 'mason-android-1771',
    type: 'linux-x64',
    labels: ['android'],
    slots: 1,
    status: 'busy',
    stage: 'ec24b917 build-android',
    checklist: [],
    inventory: {
      os: 'linux',
      osVersion: '24.04',
      arch: 'x64',
      freeDisk: 48_200_000_000,
      xcodes: [],
      tools: { node: ['24.1'] },
    },
    ...fields,
  })

/** A host paired by hand. */
export const hostNode = (fields: Partial<NodeCard> = {}): NodeCard =>
  workerNode({
    id: 3,
    fingerprint: 'mldsa65:host',
    role: 'host',
    name: 'builds',
    type: '',
    labels: [],
    slots: 0,
    checklist: [],
    status: 'offline',
    inventory: undefined,
    ...fields,
  })

/** The cloud host, ready, with a DNS name and a Space. */
export const cloudHost = (
  fields: Partial<CloudMachine> = {},
): CloudMachine => ({
  name: 'builds',
  account: 'do-main',
  region: 'sfo3',
  size: 's-1vcpu-1gb',
  image: 'ubuntu-24-04-x64',
  state: 'ready',
  address: '203.0.113.5',
  version: '0.6.0',
  origin: 'https://builds.example.com',
  dns_domain: 'example.com',
  dns_name: 'builds',
  space_bucket: 'mason-builds',
  space_region: 'sfo3',
  space_pending: 0,
  labels: [],
  certificate: 'trusted',
  ...fields,
})

/** A permanent cloud node. */
export const cloudNode = (
  fields: Partial<CloudMachine> = {},
): CloudMachine => ({
  name: 'android-builder',
  account: 'do-main',
  region: 'sfo3',
  size: 's-4vcpu-8gb',
  state: 'ready',
  address: '164.92.4.77',
  version: '0.6.0',
  node_type: 'linux-x64',
  labels: ['android'],
  certificate: 'internal',
  ...fields,
})

/** A DigitalOcean pool with one machine. */
export const pool = (fields: Partial<Pool> = {}): Pool => ({
  name: 'linux-cloud',
  type: 'linux-x86',
  account: 'do-main',
  provider: 'digitalocean',
  region: 'sfo3',
  size: 's-2vcpu-4gb',
  image: 'ubuntu-24-04-x64',
  labels: ['setup'],
  maxNodes: 3,
  slots: 1,
  ttlMinutes: 60,
  maxHoursPerNode: 24,
  machines: [{ id: 48213, state: 'ready', address: '164.92.1.18' }],
  ...fields,
})

/** A NoMac pool, pairing. */
export const macPool = (fields: Partial<Pool> = {}): Pool =>
  pool({
    name: 'macos-cloud',
    type: 'macos-arm64',
    account: 'nomac',
    provider: 'nomac',
    region: 'nomac',
    size: 'standard',
    image: 'macos',
    maxNodes: 1,
    maxHoursPerNode: 8,
    machines: [{ id: 382594, state: 'pairing' }],
    ...fields,
  })

/** A DigitalOcean account an administrator keyed. */
export const doAccount = (
  fields: Partial<CloudAccountView> = {},
): CloudAccountView => ({
  id: 'do-main',
  name: 'DigitalOcean',
  provider: 'digitalocean',
  key: { set: true },
  adminKeyed: true,
  ...fields,
})

/** A NoMac account. */
export const nomacAccount = (
  fields: Partial<CloudAccountView> = {},
): CloudAccountView => ({
  id: 'nomac',
  name: 'NoMac',
  provider: 'nomac',
  key: { set: true },
  adminKeyed: true,
  ...fields,
})

/** A DigitalOcean catalog. */
export const catalog: CloudCatalog = {
  regions: [
    { slug: 'sfo3', name: 'San Francisco 3' },
    { slug: 'nyc3', name: 'New York 3' },
  ],
  sizes: [
    {
      slug: 's-1vcpu-1gb',
      description: '1 vCPU · 1 GB',
      priceMonthly: 6,
      regions: ['sfo3', 'nyc3'],
    },
    {
      slug: 's-2vcpu-4gb',
      description: '2 vCPU · 4 GB',
      priceMonthly: 24,
      regions: ['sfo3', 'nyc3'],
    },
    {
      slug: 's-4vcpu-8gb',
      description: '4 vCPU · 8 GB',
      priceMonthly: 48,
      regions: ['nyc3'],
    },
  ],
  images: [
    { slug: 'ubuntu-24-04-x64', name: 'Ubuntu 24.04 (LTS) x64' },
    { slug: 'debian-12-x64', name: 'Debian 12 x64' },
  ],
}

/** The `nodeTypes` area. */
export const nodeTypes = {
  'macos-arm64': {
    software: {
      xcode: ['26.1', '16.4'],
      node: '24',
      brew: { formulae: ['cocoapods', 'fastlane'], casks: ['temurin'] },
      docker: true,
    },
    settings: {},
    diskThresholdGb: 40,
  },
  'linux-x64': { software: {}, settings: {}, diskThresholdGb: 40 },
}

export const PATHS = {
  nodes: '/api/v2/nodes',
  hosts: '/api/v2/cloud/hosts',
  cloudNodes: '/api/v2/cloud/nodes',
  pools: '/api/v2/cloud/pools',
  budget: '/api/v2/cloud/budget',
  accounts: '/api/v2/cloud/accounts',
  types: '/api/v2/settings/nodeTypes',
  host: '/api/v2/settings/host',
  node: '/api/v2/node',
  catalog: '/api/v2/cloud/accounts/do-main/catalog',
  domains: '/api/v2/cloud/accounts/do-main/domains',
} as const

/** The master's release, for the install commands. */
export const RELEASE = { repository: 'EdgeApp/mason', version: '0.6.0' }

/** A cluster with two workers, a ready cloud host, a cloud node and two pools. */
export const nodesReplies = (
  extra: Record<string, Reply> = {},
): Record<string, Reply> => ({
  [PATHS.nodes]: [workerNode(), linuxNode()],
  [PATHS.hosts]: [cloudHost()],
  [PATHS.cloudNodes]: [cloudNode()],
  [PATHS.pools]: [pool(), macPool()],
  [PATHS.budget]: { monthly: 200 },
  [PATHS.accounts]: [doAccount(), nomacAccount()],
  [PATHS.types]: nodeTypes,
  [PATHS.host]: { origin: 'https://builds.example.com' },
  [PATHS.node]: nodeInfo('master', { release: RELEASE }),
  [PATHS.catalog]: catalog,
  [PATHS.domains]: ['example.com', 'example.org'],
  ...extra,
})

/** The app at /nodes for a role, with these answers. */
export const openNodes = (
  extra: Record<string, Reply> = {},
  role: Role = 'admin',
): ReturnType<typeof renderApp> =>
  renderApp({
    node: nodeInfo('master'),
    path: '/nodes',
    replies: shellReplies(role, 'master', nodesReplies(extra)),
  })

/** A reply that never answers: a read or a request still under way. */
export const pending = (): Promise<Response> =>
  new Promise<Response>(() => undefined)

/** A reply held until the test answers it: a request seen busy, then done. */
export function held(): {
  reply: (url: string, init: RequestInit) => Promise<Response>
  body: () => unknown
  answer: (status: number, body: unknown) => void
} {
  let answer: (response: Response) => void = () => undefined
  let sent: unknown
  return {
    reply: (_url, init): Promise<Response> => {
      sent = JSON.parse(String(init.body ?? 'null'))
      return new Promise<Response>((resolve) => {
        answer = resolve
      })
    },
    body: (): unknown => sent,
    answer: (status, body): void =>
      answer(new Response(JSON.stringify(body), { status })),
  }
}

/** Whether a button shows its busy state. */
export const isBusy = (button: HTMLElement): boolean =>
  button.getAttribute('aria-busy') === 'true'

/** The app at /nodes for a manager whose session lacks these permissions. */
export const openNodesWithout = (
  missing: string[],
  extra: Record<string, Reply> = {},
): ReturnType<typeof renderApp> => {
  const session = sessionFor('manager')
  return openNodes({
    '/api/v2/session': {
      ...session,
      permissions: session.permissions.filter(
        (permission) => !missing.includes(permission),
      ),
    },
    ...extra,
  })
}
