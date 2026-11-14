// The Settings page's reads and answers (docs/api.md §3 API keys, §10
// Storage, §12 Settings, §13 Apple): paths, types and cleaners. Secret
// fields are write-only: a read shows them as `{ set: true }`, and a write
// sends `{ keep: true }` to keep the stored value.
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
  type Cleaner,
} from 'cleaners'
import { asRoleName } from './session.js'
import type { Role } from '../permissions.js'
import { asRecord } from './runs.js'

/** `GET|POST /api/v2/keys`: the keys, and a new one. */
export const KEYS_PATH = '/api/v2/keys'
/** `DELETE /api/v2/keys/:id`: revokes a key. */
export const keyPath = (id: string): string =>
  `${KEYS_PATH}/${encodeURIComponent(id)}`

/** `POST /api/v2/apple/session`: signs the Apple ID in. */
export const APPLE_SESSION_PATH = '/api/v2/apple/session'
/** `POST /api/v2/apple/session/code`: sends Apple's two-factor code. */
export const APPLE_SESSION_CODE_PATH = '/api/v2/apple/session/code'
/** `POST /api/v2/apple/setup`: checks a team's signing again. */
export const APPLE_SETUP_PATH = '/api/v2/apple/setup'

/** The settings areas the page reads. */
export type SettingsArea =
  | 'github'
  | 'host'
  | 'master'
  | 'signIn'
  | 'nodeTypes'
  | 'cloud'
/** `GET|PUT /api/v2/settings/:area`. */
export const settingsPath = (area: SettingsArea): string =>
  `/api/v2/settings/${area}`
/** `PUT|DELETE /api/v2/settings/signIn/methods/:id`. */
export const signInMethodPath = (id: string): string =>
  `/api/v2/settings/signIn/methods/${encodeURIComponent(id)}`
/** `PUT|DELETE /api/v2/settings/nodeTypes/:type`. */
export const nodeTypePath = (type: string): string =>
  `/api/v2/settings/nodeTypes/${encodeURIComponent(type)}`
/** `PUT /api/v2/settings/cloud/budget`: the pools' monthly budget. */
export const CLOUD_BUDGET_SETTING_PATH = '/api/v2/settings/cloud/budget'

/** `GET /api/v2/storage`: the storage setting and every location. */
export const STORAGE_PATH = '/api/v2/storage'
/** `POST /api/v2/storage/space`: adds an existing Space. */
export const STORAGE_SPACE_PATH = '/api/v2/storage/space'
/** `POST /api/v2/storage/space/new`: makes a new Space. */
export const STORAGE_NEW_SPACE_PATH = '/api/v2/storage/space/new'
/** `POST /api/v2/storage/disk`: new builds go to the host's disk. */
export const STORAGE_DISK_PATH = '/api/v2/storage/disk'
/** `POST /api/v2/storage/locations/:id/use`: new builds go there. */
export const storageUsePath = (id: string): string =>
  `/api/v2/storage/locations/${encodeURIComponent(id)}/use`
/** `DELETE /api/v2/storage/locations/:id`: removes a Space and its builds. */
export const storageLocationPath = (id: string): string =>
  `/api/v2/storage/locations/${encodeURIComponent(id)}`

/** The DigitalOcean regions that have Spaces, with their names. */
export const SPACES_REGION_CHOICES: ReadonlyArray<{
  value: string
  label: string
}> = [
  { value: 'sfo3', label: 'San Francisco (sfo3)' },
  { value: 'nyc3', label: 'New York (nyc3)' },
  { value: 'ams3', label: 'Amsterdam (ams3)' },
  { value: 'fra1', label: 'Frankfurt (fra1)' },
  { value: 'lon1', label: 'London (lon1)' },
  { value: 'sgp1', label: 'Singapore (sgp1)' },
  { value: 'syd1', label: 'Sydney (syd1)' },
  { value: 'blr1', label: 'Bangalore (blr1)' },
  { value: 'tor1', label: 'Toronto (tor1)' },
  { value: 'atl1', label: 'Atlanta (atl1)' },
]

/** A write-only field as a read shows it. */
export interface SecretSet {
  set: boolean
}

/** An API key as `GET /api/v2/keys` lists it; `token` only in the creation's answer. */
export interface ApiKey {
  id: string
  name: string
  role: Role
  projects: string[]
  branches: string[]
  createdAt: number
  expiresAt?: number
  revoked: boolean
  /** `builder` for an imported builder key, whose token has no id in it. */
  format: 'v1' | 'builder'
  token?: string
}

/** The Apple ID session, as the session routes answer it. */
export interface AppleSession {
  appleId?: string
  state: 'signedOut' | 'needsCode' | 'signedIn' | 'expired' | 'failed'
  notice?: string
  error?: string
}

/** What `POST /api/v2/apple/setup` answers. */
export interface AppleSetupResult {
  team: { id: string; name: string }
  key: string
  certificate: string
}

/** The `github` area: how Mason reaches GitHub, its secrets only as set. */
export interface GithubSetting {
  kind?: 'token' | 'app' | 'ssh'
  appId?: number
  installationId?: number
  /** The deploy key's public half. */
  publicKey?: string
}

/** The `host` area. */
export interface HostSetting {
  origin?: string
  workerOrigin?: string
  offlineGraceHours?: number
}

/** The `master` area: the master's own public origin. */
export interface MasterSetting {
  origin?: string
}

/** A sign-in method, every field but its client secret. */
export interface SignInMethod {
  id: string
  type: 'oidc' | 'oauth2'
  name: string
  issuer: string
  clientId: string
  enabled: boolean
  admitTesters: boolean
  authentication?: 'post' | 'basic'
  signingAlgorithm?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  userinfoEndpoint?: string
  scopes?: string[]
  claims?: {
    subject?: string
    name?: string
    email?: string
    emailVerified?: string
  }
}

/** The `signIn` area. */
export interface SignInSetting {
  methods: SignInMethod[]
}

/** A node type: the software and settings every node of it keeps. */
export interface NodeType {
  software: {
    xcode: string[]
    xcodeDefault?: string
    allowBeta: boolean
    simulators: string[]
    commandLineTools: boolean
    rosetta: boolean
    brew: { formulae: string[]; casks: string[] }
    apt: string[]
    dnf: string[]
    docker: boolean
    node?: string
    java?: string
    rust?: string
    python?: string
    go?: string
    ruby?: string
    android: string[]
  }
  settings: {
    noSleep: boolean
    devToolsSecurity: boolean
    automationMode: boolean
  }
  diskThresholdGb: number
  androidLicensesAccepted?: { by: string; at: number }
}

/** The `cloud` area, as the budget card reads it. */
export interface CloudSetting {
  monthlyBudget?: number
}

/** One place builds are stored. */
export interface StorageLocation {
  id: string
  kind: 'disk' | 'space'
  /** Whether new builds go here. */
  active: boolean
  bucket?: string
  region?: string
  endpoint?: string
  /** made: Mason made it; added: an administrator gave its key; host: made for a cloud host. */
  origin?: 'made' | 'added' | 'host'
  /** Whether Mason made the bucket, so removing it deletes it. */
  bucketOwned?: boolean
  account?: string
  host?: string
  addedAt?: number
  addedBy?: string
  /** Files and bytes the host holds there, when it answered. */
  usage?: { files: number; bytes: number }
}

/** What `GET /api/v2/storage` answers. */
export interface StorageView {
  driver?: 'disk' | 's3'
  locations: StorageLocation[]
}

/** What removing a location answers. */
export interface StorageRemoved {
  files: number
  bucketDeleted: boolean
}

const asStrings = asArray(asString)

export const asApiKey = asObject<ApiKey>({
  id: asString,
  name: asString,
  role: asRoleName,
  projects: asOptional(asStrings, []),
  branches: asOptional(asStrings, []),
  createdAt: asNumber,
  expiresAt: asOptional(asNumber),
  revoked: asBoolean,
  format: asOptional(asValue('v1', 'builder'), 'v1'),
  token: asOptional(asString),
})
export const asApiKeys = asArray(asApiKey)

export const asAppleSession = asObject<AppleSession>({
  appleId: asOptional(asString),
  state: asValue('signedOut', 'needsCode', 'signedIn', 'expired', 'failed'),
  notice: asOptional(asString),
  error: asOptional(asString),
})

export const asAppleSetupResult = asObject<AppleSetupResult>({
  team: asObject({ id: asString, name: asString }),
  key: asString,
  certificate: asString,
})

export const asGithubSetting = asObject<GithubSetting>({
  kind: asOptional(asValue('token', 'app', 'ssh')),
  appId: asOptional(asNumber),
  installationId: asOptional(asNumber),
  publicKey: asOptional(asString),
})

export const asHostSetting = asObject<HostSetting>({
  origin: asOptional(asString),
  workerOrigin: asOptional(asString),
  offlineGraceHours: asOptional(asNumber),
})

export const asMasterSetting = asObject<MasterSetting>({
  origin: asOptional(asString),
})

export const asSignInMethod = asObject<SignInMethod>({
  id: asString,
  type: asValue('oidc', 'oauth2'),
  name: asString,
  issuer: asString,
  clientId: asString,
  enabled: asOptional(asBoolean, true),
  admitTesters: asOptional(asBoolean, false),
  authentication: asOptional(asValue('post', 'basic')),
  signingAlgorithm: asOptional(asString),
  authorizationEndpoint: asOptional(asString),
  tokenEndpoint: asOptional(asString),
  userinfoEndpoint: asOptional(asString),
  scopes: asOptional(asStrings),
  claims: asOptional(
    asObject({
      subject: asOptional(asString),
      name: asOptional(asString),
      email: asOptional(asString),
      emailVerified: asOptional(asString),
    }),
  ),
})

export const asSignInSetting = asObject<SignInSetting>({
  methods: asOptional(asArray(asSignInMethod), []),
})

export const asNodeType = asObject<NodeType>({
  software: asObject({
    xcode: asOptional(asStrings, []),
    xcodeDefault: asOptional(asString),
    allowBeta: asOptional(asBoolean, false),
    simulators: asOptional(asStrings, []),
    commandLineTools: asOptional(asBoolean, false),
    rosetta: asOptional(asBoolean, false),
    brew: asOptional(
      asObject({
        formulae: asOptional(asStrings, []),
        casks: asOptional(asStrings, []),
      }),
      { formulae: [], casks: [] },
    ),
    apt: asOptional(asStrings, []),
    dnf: asOptional(asStrings, []),
    docker: asOptional(asBoolean, false),
    node: asOptional(asString),
    java: asOptional(asString),
    rust: asOptional(asString),
    python: asOptional(asString),
    go: asOptional(asString),
    ruby: asOptional(asString),
    android: asOptional(asStrings, []),
  }),
  settings: asOptional(
    asObject({
      noSleep: asOptional(asBoolean, false),
      devToolsSecurity: asOptional(asBoolean, false),
      automationMode: asOptional(asBoolean, false),
    }),
    { noSleep: false, devToolsSecurity: false, automationMode: false },
  ),
  diskThresholdGb: asOptional(asNumber, 40),
  androidLicensesAccepted: asOptional(asObject({ by: asString, at: asNumber })),
})
export const asNodeTypeSettings: Cleaner<Record<string, NodeType>> =
  asRecord(asNodeType)

export const asCloudSetting = asObject<CloudSetting>({
  monthlyBudget: asOptional(asNumber),
})

export const asStorageLocation = asObject<StorageLocation>({
  id: asString,
  kind: asValue('disk', 'space'),
  active: asBoolean,
  bucket: asOptional(asString),
  region: asOptional(asString),
  endpoint: asOptional(asString),
  origin: asOptional(asValue('made', 'added', 'host')),
  bucketOwned: asOptional(asBoolean),
  account: asOptional(asString),
  host: asOptional(asString),
  addedAt: asOptional(asNumber),
  addedBy: asOptional(asString),
  usage: asOptional(asObject({ files: asNumber, bytes: asNumber })),
})

export const asStorageView = asObject<StorageView>({
  driver: asOptional(asValue('disk', 's3')),
  locations: asOptional(asArray(asStorageLocation), []),
})

export const asStorageRemoved = asObject<StorageRemoved>({
  files: asNumber,
  bucketDeleted: asBoolean,
})
