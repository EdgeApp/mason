import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asUnknown,
  asValue,
} from 'cleaners'
import { asRecord } from './runs.js'

/** `GET /api/v2/nodes`, master only: every node, with what it is doing. */
export const NODES_PATH = '/api/v2/nodes'
/** `GET /api/v2/cloud/budget`, master only: the monthly budget and its notice. */
export const CLOUD_BUDGET_PATH = '/api/v2/cloud/budget'
/** `GET /api/v2/cloud/accounts/:id/domains`, master only: a DigitalOcean account's DNS domains. */
export const cloudDomainsPath = (id: string): string =>
  `/api/v2/cloud/accounts/${encodeURIComponent(id)}/domains`
/** `GET /api/v2/apple/signing`, master only: what Settings → Apple shows. */
export const APPLE_SIGNING_PATH = '/api/v2/apple/signing'
/** `GET /api/v2/groups/:id`, master only. */
export const groupPath = (id: number): string => `/api/v2/groups/${id}`
/** `GET /api/v2/apps`, master only: every app, for a group's picker. */
export const APPS_PATH = '/api/v2/apps'
/** `GET /api/v2/projects/:slug/secrets/backups`, master only. */
export const secretsBackupsPath = (slug: string): string =>
  `/api/v2/projects/${encodeURIComponent(slug)}/secrets/backups`

/** A paired node, as the Nodes page lists it. */
export interface NodeView {
  id: number
  fingerprint: string
  role: 'worker' | 'host'
  host: string
  port: number
  name: string
  type: string
  labels: string[]
  slots: number
  workspaceRoots: string[]
  version: string
  addedAt: number
  lastSeen?: number
  connected: boolean
  /** A worker: idle, busy or offline; a host: idle while connected, else offline. */
  status: 'idle' | 'busy' | 'offline'
  /** The stage it runs now: `<run id> <stage>`. */
  stage?: string
  /** What it must still have done; each item as the master checks it. */
  checklist: unknown[]
  /** What it reported of itself. */
  inventory?: unknown
}

/** What `GET /api/v2/cloud/budget` answers. */
export interface CloudBudget {
  /** Dollars a month the pools may spend. */
  monthly: number
  /** Why pools stop growing, once they near or pass the budget. */
  notice?: string
}

/** What Settings → Apple shows. */
export interface AppleSigning {
  signedIn: boolean
  appleId?: string
  /** The Apple ID waits for its two-factor code. */
  needsCode: boolean
  notice?: string
  /** With the Apple ID signed in: its teams, or why they could not be read. */
  setup?: {
    keyName: string
    teams: Array<{ id: string; name: string }>
    /** Teams with a stored key: the key, and the distribution certificate held. */
    configured: Array<{
      id: string
      name: string
      keyId: string
      certificate?: { name: string; expiresAt: number }
    }>
    error?: string
  }
  /** Why each team's last setup failed, by team ID (`''` when its teams could not be read). */
  failures: Record<string, string>
  /** Teams being set up now. */
  settingUp: string[]
}

/** What `GET /api/v2/groups/:id` answers. */
export interface GroupDetail {
  id: number
  name: string
  apps: Array<{ id: number; slug: string }>
  /** Its members' account ids. */
  members: number[]
  createdAt: number
}

/** An app as `GET /api/v2/apps` lists it, also one no project owns. */
export interface AppItem {
  id: number
  name: string
  slug: string
  enabled: boolean
}

/** What `GET /api/v2/projects/:slug/secrets/backups` answers. */
export interface SecretsBackups {
  /** Secrets are only kept once backups are configured. */
  backupsConfigured: boolean
}

export const asNodeView = asObject<NodeView>({
  id: asNumber,
  fingerprint: asString,
  role: asValue('worker', 'host'),
  host: asString,
  port: asNumber,
  name: asString,
  type: asString,
  labels: asArray(asString),
  slots: asNumber,
  workspaceRoots: asArray(asString),
  version: asString,
  addedAt: asNumber,
  lastSeen: asOptional(asNumber),
  connected: asBoolean,
  status: asValue('idle', 'busy', 'offline'),
  stage: asOptional(asString),
  checklist: asArray(asUnknown),
  inventory: asUnknown,
})
export const asNodeViews = asArray(asNodeView)

export const asCloudBudget = asObject<CloudBudget>({
  monthly: asNumber,
  notice: asOptional(asString),
})

export const asCloudDomains = asArray(asString)

export const asAppleSigning = asObject<AppleSigning>({
  signedIn: asBoolean,
  appleId: asOptional(asString),
  needsCode: asBoolean,
  notice: asOptional(asString),
  setup: asOptional(
    asObject({
      keyName: asString,
      teams: asArray(asObject({ id: asString, name: asString })),
      configured: asArray(
        asObject({
          id: asString,
          name: asString,
          keyId: asString,
          certificate: asOptional(
            asObject({ name: asString, expiresAt: asNumber }),
          ),
        }),
      ),
      error: asOptional(asString),
    }),
  ),
  failures: asRecord(asString),
  settingUp: asArray(asString),
})

export const asGroupDetail = asObject<GroupDetail>({
  id: asNumber,
  name: asString,
  apps: asArray(asObject({ id: asNumber, slug: asString })),
  members: asArray(asNumber),
  createdAt: asNumber,
})

export const asAppItems = asArray(
  asObject<AppItem>({
    id: asNumber,
    name: asString,
    slug: asString,
    enabled: asBoolean,
  }),
)

export const asSecretsBackups = asObject<SecretsBackups>({
  backupsConfigured: asBoolean,
})
