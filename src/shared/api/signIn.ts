import {
  asBoolean,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  asUnknown,
  asValue,
  type Cleaner,
} from 'cleaners'
import type { ArgonParameters } from '../../auth/passwordProtocol.js'

/**
 * The signed-out pages' requests that are not the session's: first-run setup
 * and restore on the master, and an invitation's lookup and acceptance on
 * both nodes. None needs a session or a CSRF proof; the nodes check the
 * request's `Origin` instead.
 */
export const SETUP_RESTORE_PATH = '/api/setup/restore'
export const INVITE_LOOKUP_PATH = '/auth/invite/lookup'
export const INVITE_ACCEPT_PATH = '/auth/invite'

/** `POST /api/setup`: the first administrator, by the client hash of a new password. */
export interface SetupRequest {
  /** The six digits the master printed when it started. */
  code: string
  username: string
  clientHash: string
  clientParameters: ArgonParameters
}

/** What `POST /api/setup` answers (201) with the new administrator's cookie. */
export interface SetupReply {
  accountId: number
  username: string
}

/** `POST /api/setup/restore`: an unconfigured master rebuilt from its backup. */
export interface RestoreRequest {
  code: string
  repository: string
  /** The backup key file's text. */
  key: string
  /** The latest backup on or before this day (`YYYY-MM-DD`). */
  date?: string
}

/** `POST /auth/invite/lookup`: whom an invitation's token is for. */
export interface InvitationLookup {
  name: string
  /** The username they already have, which stays. */
  username?: string
  /** Whether they must choose one: false when a confirmed email signs them in. */
  usernameRequired?: boolean
}

/** `POST /auth/invite`: the token, a username and the new password's client hash. */
export interface InvitationAcceptance {
  token: string
  username: string
  clientHash: string
  clientParameters: ArgonParameters
}

export const asSetupReply = asObject<SetupReply>({
  accountId: asNumber,
  username: asString,
})

export const asInvitationLookup = asObject<InvitationLookup>({
  name: asString,
  username: asOptional(asString),
  usernameRequired: asOptional(asBoolean),
})

/** `POST /auth/invite` and the restore answer only that they worked. */
export const asSignedIn = asObject({ signedIn: asValue(true) })
export const asRestoreReply: Cleaner<unknown> = asUnknown

/**
 * A provider sign-in's page, where the node still answers the protocol
 * route (`/auth/start`, `/auth/switch`, `/auth/callback`) itself: the node
 * sends the app's shell with this in `<meta name="mason-flow">`, and the app
 * draws the state instead of the page it would otherwise route to.
 */
export type SignInFlow =
  /** The master's callback signed the browser in: continue to `next`. */
  | { state: 'signedIn'; next: string }
  /** The master refused the provider's answer, with a reason it may show. */
  | { state: 'failed'; message: string }
  /** The master offers no provider sign-in. */
  | { state: 'unavailable' }
  /** The host could not complete a sign-in request. */
  | { state: 'invalid'; message: string }
  /** A signed-in visitor started a provider on the host: switch accounts? */
  | {
      state: 'switch'
      name: string
      provider: { id: string; name: string }
      csrf: string
      return: string
    }
  /** That provider has no way to choose another account. */
  | { state: 'switchUnavailable' }
  /** The switch is confirmed: the link to the provider's account chooser. */
  | { state: 'chooseAccount'; provider: string; target: string }

/** The `<meta>` the node puts the flow in. */
export const FLOW_META = 'mason-flow'

export const asSignInFlow: Cleaner<SignInFlow> = asEither(
  asObject({ state: asValue('signedIn'), next: asString }),
  asObject({ state: asValue('failed'), message: asString }),
  asObject({ state: asValue('unavailable') }),
  asObject({ state: asValue('invalid'), message: asString }),
  asObject({
    state: asValue('switch'),
    name: asString,
    provider: asObject({ id: asString, name: asString }),
    csrf: asString,
    return: asString,
  }),
  asObject({ state: asValue('switchUnavailable') }),
  asObject({
    state: asValue('chooseAccount'),
    provider: asString,
    target: asString,
  }),
)
