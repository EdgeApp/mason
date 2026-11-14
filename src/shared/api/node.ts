import {
  asArray,
  asBoolean,
  asObject,
  asOptional,
  asString,
  asValue,
} from 'cleaners'

/** `GET /api/v2/node`, both nodes, no session: which node the app runs on. */
export const NODE_PATH = '/api/v2/node'

/** Whether the node serves normally, waits for its master (a host), or is in maintenance (a host past its offline grace window). */
export type NodeState = 'ok' | 'waitingForMaster' | 'maintenance'

/** A sign-in method a node offers besides the password. */
export interface SignInProvider {
  id: string
  name: string
}

/** What the web app needs before anyone signs in. */
export interface NodeInfo {
  role: 'master' | 'host'
  /** The Mason version the node runs. */
  version: string
  /** The master's public origin, once the `master` setting names one. */
  masterOrigin?: string
  /** The host's public origin, once the `host` setting names one. */
  hostOrigin?: string
  /** A master with no account yet: the app shows first-run setup. */
  setupNeeded: boolean
  signIn: { password: boolean; providers: SignInProvider[] }
  state: NodeState
  /** The node runs with `--test-endpoints`; the app shows a banner. */
  testEndpoints: boolean
  /** The GitHub repository and version of the release this node runs. */
  release?: { repository: string; version: string }
}

export const asSignInProvider = asObject<SignInProvider>({
  id: asString,
  name: asString,
})

export const asNodeInfo = asObject<NodeInfo>({
  role: asValue('master', 'host'),
  version: asString,
  masterOrigin: asOptional(asString),
  hostOrigin: asOptional(asString),
  setupNeeded: asBoolean,
  signIn: asObject({
    password: asBoolean,
    providers: asArray(asSignInProvider),
  }),
  state: asValue('ok', 'waitingForMaster', 'maintenance'),
  testEndpoints: asBoolean,
  release: asOptional(asObject({ repository: asString, version: asString })),
})
