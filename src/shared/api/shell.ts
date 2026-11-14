import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
} from 'cleaners'

/** `GET /api/v2/status`, both nodes: the top bar's state and the banners. */
export const STATUS_PATH = '/api/v2/status'
/** `GET /api/v2/notifications`, both nodes: what needs the viewer. */
export const NOTIFICATIONS_PATH = '/api/v2/notifications'
/** `GET /api/v2/search?q=`, both nodes: ⌘K search. */
export const SEARCH_PATH = '/api/v2/search'

/** Worker capacity and health, on the master. */
export interface ClusterStatus {
  /** Connected workers with nothing running. */
  idle: number
  total: number
  /** Whether every worker is connected. */
  healthy: boolean
}

/** A host's link to its master. */
export interface LinkStatus {
  /** Whether the link is open and the host has synced over it. */
  online: boolean
  /** When the host last heard from the master (ms since the epoch). */
  lastContact?: number
  /** Offline past the grace window: the host serves nothing. */
  maintenance: boolean
}

/** A banner the shell shows above every page. */
export interface Banner {
  /** `testEndpoints`, `backup` (the master's backup reminder) or `offline` (a host without its master). */
  kind: 'testEndpoints' | 'backup' | 'offline'
  text: string
  /** Where the banner's link goes. */
  href?: string
}

/** What `GET /api/v2/status` answers, and the `/live` `status` event carries. */
export interface StatusInfo {
  node: 'master' | 'host'
  /** The master's workers. */
  cluster?: ClusterStatus
  /** The host's link to the master. */
  link?: LinkStatus
  banners: Banner[]
}

/** Something that needs the viewer: an approval, or a master notice. */
export interface NotificationItem {
  kind: 'approval' | 'notice'
  text: string
  /** The run waiting for the approval. */
  href?: string
}

/** One ⌘K result. */
export interface SearchResult {
  kind: 'project' | 'app' | 'run' | 'commit' | 'branch'
  label: string
  detail: string
  href: string
}

export const asClusterStatus = asObject<ClusterStatus>({
  idle: asNumber,
  total: asNumber,
  healthy: asBoolean,
})

export const asLinkStatus = asObject<LinkStatus>({
  online: asBoolean,
  lastContact: asOptional(asNumber),
  maintenance: asBoolean,
})

export const asBanner = asObject<Banner>({
  kind: asValue('testEndpoints', 'backup', 'offline'),
  text: asString,
  href: asOptional(asString),
})

export const asStatusInfo = asObject<StatusInfo>({
  node: asValue('master', 'host'),
  cluster: asOptional(asClusterStatus),
  link: asOptional(asLinkStatus),
  banners: asArray(asBanner),
})

export const asNotificationItem = asObject<NotificationItem>({
  kind: asValue('approval', 'notice'),
  text: asString,
  href: asOptional(asString),
})
export const asNotifications = asArray(asNotificationItem)

export const asSearchResult = asObject<SearchResult>({
  kind: asValue('project', 'app', 'run', 'commit', 'branch'),
  label: asString,
  detail: asString,
  href: asString,
})
export const asSearchResults = asArray(asSearchResult)
