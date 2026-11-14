// The Settings page under test: each area's answers, and the app opened at
// /settings on the master for a role, with helpers to hold a reply (to see a
// busy state), record what was sent, and wait for a request.
import { screen } from '@testing-library/react'
import type { AppleSigning } from '../../shared/api/admin.js'
import type { CloudAccountView } from '../../shared/api/cloud.js'
import type {
  ApiKey,
  GithubSetting,
  HostSetting,
  NodeType,
  SignInMethod,
  StorageLocation,
} from '../../shared/api/settings.js'
import type { Permission, Role } from '../../shared/permissions.js'
import {
  nodeInfo,
  renderApp,
  sessionFor,
  shellReplies,
  until,
  type Reply,
} from './render.js'

export const NOW = Date.now()
const DAY = 86_400_000

export const SIGNING = '/api/v2/apple/signing'
export const KEYS = '/api/v2/keys'
export const GITHUB = '/api/v2/settings/github'
export const HOST = '/api/v2/settings/host'
export const MASTER = '/api/v2/settings/master'
export const SIGN_IN = '/api/v2/settings/signIn'
export const NODE_TYPES = '/api/v2/settings/nodeTypes'
export const CLOUD = '/api/v2/settings/cloud'
export const STORAGE = '/api/v2/storage'
export const ACCOUNTS = '/api/v2/cloud/accounts'

/** The Apple ID signed in, with one team set up and one failed. */
export const signingFixture = (
  fields: Partial<AppleSigning> = {},
): AppleSigning => ({
  signedIn: true,
  appleId: 'builds@teamstation.app',
  needsCode: false,
  setup: {
    keyName: 'Mason',
    teams: [
      { id: 'V4AK4X7A2V', name: 'TeamStation Inc' },
      { id: 'G5LQ7MERPK', name: 'Edge Labs' },
      { id: 'ABCDE12345', name: 'Side Project' },
      { id: 'ZZZZZ99999', name: 'New Team' },
    ],
    configured: [
      {
        id: 'V4AK4X7A2V',
        name: 'TeamStation Inc',
        keyId: 'ABC123',
        certificate: {
          name: 'Apple Distribution: TeamStation Inc',
          expiresAt: Date.UTC(2027, 0, 1, 12),
        },
      },
      { id: 'OLDTEAM000', name: 'Old Team', keyId: 'OLD999' },
    ],
  },
  failures: {
    G5LQ7MERPK:
      'Apple refused the certificate request: the team has reached its limit of distribution certificates.',
  },
  settingUp: ['ABCDE12345'],
  ...fields,
})

/** The Apple ID signed out. */
export const signedOut = (
  fields: Partial<AppleSigning> = {},
): AppleSigning => ({
  signedIn: false,
  needsCode: false,
  failures: {},
  settingUp: [],
  ...fields,
})

export const apiKey = (fields: Partial<ApiKey> = {}): ApiKey => ({
  id: 'ab12cd34ef56ab12cd34ef56ab12cd34',
  name: 'ci-uploads',
  role: 'developer',
  projects: [],
  branches: [],
  createdAt: NOW - 11 * DAY,
  revoked: false,
  format: 'v1',
  ...fields,
})

export const keysFixture = (): ApiKey[] => [
  apiKey(),
  apiKey({
    id: '9f0e2aaaaaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'eddy-agent',
    role: 'tester',
    revoked: true,
  }),
  apiKey({
    id: 'builderbuilderbuilderbuilderbuil',
    name: 'old-builder',
    role: 'manager',
    format: 'builder',
  }),
]

export const githubApp: GithubSetting = {
  kind: 'app',
  appId: 1048213,
  installationId: 58212397,
}

export const hostFixture: HostSetting = {
  origin: 'https://builds.example.com',
  offlineGraceHours: 72,
}

export const methodFixture = (
  fields: Partial<SignInMethod> = {},
): SignInMethod => ({
  id: 'teamstation',
  type: 'oidc',
  name: 'TeamStation',
  issuer: 'https://auth.teamstation.app',
  clientId: 'mason-prod',
  enabled: true,
  admitTesters: true,
  authentication: 'post',
  signingAlgorithm: 'RS256',
  ...fields,
})

export const githubMethod = (): SignInMethod =>
  methodFixture({
    id: 'github',
    type: 'oauth2',
    name: 'GitHub',
    issuer: 'https://github.com',
    clientId: 'Iv1.abc',
    enabled: false,
    admitTesters: false,
    signingAlgorithm: undefined,
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    userinfoEndpoint: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email'],
    claims: { subject: 'id', name: 'name', email: 'email' },
  })

export const nodeType = (fields: Partial<NodeType> = {}): NodeType => ({
  software: {
    xcode: ['26.1', '16.4'],
    xcodeDefault: '26.1',
    allowBeta: false,
    simulators: ['iOS 26.1'],
    commandLineTools: true,
    rosetta: true,
    brew: { formulae: ['cocoapods', 'fastlane', 'jq'], casks: [] },
    apt: [],
    dnf: [],
    docker: false,
    node: '24',
    android: [],
  },
  settings: { noSleep: true, devToolsSecurity: true, automationMode: true },
  diskThresholdGb: 40,
  ...fields,
})

export const linuxType = (): NodeType =>
  nodeType({
    software: {
      xcode: [],
      allowBeta: false,
      simulators: [],
      commandLineTools: false,
      rosetta: false,
      brew: { formulae: [], casks: [] },
      apt: ['jq'],
      dnf: ['zip', 'git'],
      docker: true,
      java: '21',
      rust: 'stable',
      python: '3.12',
      go: '1.23',
      ruby: '3.3',
      android: ['platforms;android-35'],
    },
    settings: {
      noSleep: false,
      devToolsSecurity: false,
      automationMode: false,
    },
    diskThresholdGb: 60,
    androidLicensesAccepted: { by: 'Ada', at: Date.UTC(2026, 9, 1, 12) },
  })

export const diskLocation = (
  fields: Partial<StorageLocation> = {},
): StorageLocation => ({
  id: 'disk',
  kind: 'disk',
  active: false,
  usage: { files: 312, bytes: 100_400_000_000 },
  ...fields,
})

export const spaceLocation = (
  fields: Partial<StorageLocation> = {},
): StorageLocation => ({
  id: 'sp1',
  kind: 'space',
  active: true,
  bucket: 'mason-builds',
  region: 'sfo3',
  origin: 'made',
  bucketOwned: true,
  usage: { files: 1284, bytes: 212_400_000_000 },
  ...fields,
})

export const storageFixture = (): unknown => ({
  driver: 's3',
  locations: [
    spaceLocation(),
    diskLocation(),
    spaceLocation({
      id: 'sp2',
      active: false,
      bucket: 'old-builds',
      region: 'nyc3',
      origin: 'added',
      bucketOwned: false,
      usage: undefined,
    }),
    spaceLocation({
      id: 'sp3',
      active: false,
      bucket: 'host-builds',
      region: undefined,
      origin: 'host',
      host: 'builds.example.com',
      bucketOwned: true,
      usage: { files: 1, bytes: 512 },
    }),
  ],
})

export const accountsFixture = (): CloudAccountView[] => [
  {
    id: 'do-main',
    name: 'DigitalOcean',
    provider: 'digitalocean',
    key: { set: true },
    adminKeyed: true,
  },
  {
    id: 'nomac',
    name: 'NoMac',
    provider: 'nomac',
    key: { set: true },
    adminKeyed: true,
  },
]

/** Every area's answer. */
export const settingsReplies = (): Record<string, Reply> => ({
  [SIGNING]: signingFixture(),
  [KEYS]: keysFixture(),
  [GITHUB]: githubApp,
  [HOST]: hostFixture,
  [MASTER]: { origin: 'https://mason-admin.example.com:9300' },
  [SIGN_IN]: { methods: [methodFixture(), githubMethod()] },
  [NODE_TYPES]: { 'macos-arm64': nodeType(), 'linux-x64': linuxType() },
  [CLOUD]: { monthlyBudget: 200, pools: [] },
  [STORAGE]: storageFixture(),
  [ACCOUNTS]: accountsFixture(),
})

/** A role's session without some of its permissions. */
export const sessionWithout = (
  role: Role,
  without: Permission[],
): ReturnType<typeof sessionFor> => {
  const session = sessionFor(role)
  return {
    ...session,
    permissions: session.permissions.filter(
      (permission) => !without.includes(permission),
    ),
  }
}

/** The app on the master at an address, for a role, with these answers over the fixtures. */
export const openSettings = (
  extra: Record<string, Reply> = {},
  role: Role = 'admin',
  path = '/settings',
): ReturnType<typeof renderApp> =>
  renderApp({
    node: nodeInfo('master'),
    path,
    replies: shellReplies(role, 'master', { ...settingsReplies(), ...extra }),
  })

/** A card by its title, once it is drawn. */
export const card = async (name: string | RegExp): Promise<HTMLElement> =>
  await screen.findByRole('region', { name })

/** An element's text without its icons' glyphs. */
export const text = (node: Element | null): string =>
  (node?.textContent ?? '').replace(/[-]/g, '')

/** A reply that records each body it is sent and answers from a function of it. */
export const recorder = (
  answer: (body: unknown, count: number) => { status: number; body: unknown },
): {
  bodies: unknown[]
  reply: (url: string, init: RequestInit) => Response
} => {
  const bodies: unknown[] = []
  return {
    bodies,
    reply: (_url, init): Response => {
      const body: unknown = JSON.parse(String(init.body ?? 'null'))
      bodies.push(body)
      const out = answer(body, bodies.length)
      return new Response(JSON.stringify(out.body), { status: out.status })
    },
  }
}

/** A reply that waits until released, to see a busy state. */
export const held = (
  status: number,
  body: unknown,
): {
  reply: (url: string, init: RequestInit) => Promise<Response>
  bodies: unknown[]
  release: () => void
} => {
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const bodies: unknown[] = []
  return {
    bodies,
    reply: async (_url, init): Promise<Response> => {
      bodies.push(JSON.parse(String(init.body ?? 'null')))
      await gate
      return new Response(JSON.stringify(body), { status })
    },
    release: () => release(),
  }
}

/** Waits until a request was made. */
export const requested = async (
  app: ReturnType<typeof renderApp>,
  key: string,
): Promise<void> => {
  await until(() => app.node.requests.includes(key), key)
}

/** Waits for a toast's words. */
export const toasted = async (words: string | RegExp): Promise<void> => {
  await screen.findByText(words, { selector: '.m-toast__text' })
}
