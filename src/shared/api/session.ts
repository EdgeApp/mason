import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  asValue,
  type Cleaner,
} from 'cleaners'
import {
  asArgonParameters,
  type ArgonParameters,
} from '../../auth/passwordProtocol.js'
import {
  permissions,
  roles,
  type Permission,
  type Role,
} from '../permissions.js'

/**
 * The session routes, on the master and (answered by the host itself) on
 * the host: `GET` reads it, `POST` signs in, `DELETE` signs out, and
 * `POST …/parameters` gives the password's hashing parameters.
 */
export const SESSION_PATH = '/api/v2/session'
export const SESSION_PARAMETERS_PATH = '/api/v2/session/parameters'

/** The CSRF header every request from a session sends unless it is a `GET`. */
export const CSRF_HEADER = 'X-Mason-CSRF'

/** One of the viewer's email addresses. */
export interface SessionEmail {
  email: string
  /** Whether it signs the person in; one they added themselves waits for an admin. */
  confirmed: boolean
}

/** `GET /api/v2/session`: who is signed in, and what they may do. */
export interface SessionInfo {
  accountId: number
  name: string
  role: Role
  /** The proof a non-`GET` request sends in `X-Mason-CSRF`. */
  csrf: string
  /** The permission names the viewer's role holds (src/shared/permissions.ts). */
  permissions: Permission[]
  emails: SessionEmail[]
}

/** `POST /api/v2/session/parameters`: whom to hash a password for. */
export interface SessionParametersRequest {
  /** A username, or one of the person's confirmed emails. */
  identifier: string
}

/** `POST /api/v2/session`: the client hash, never the password. */
export interface SignInRequest {
  identifier: string
  /** The 32-byte Argon2id hash of the password, as lowercase hex. */
  clientHash: string
}

/** What `POST /api/v2/session` answers with the cookie. */
export interface SignInReply {
  name: string
  role: Role
  csrf: string
}

export const asRoleName: Cleaner<Role> = asValue(...roles)
export const asPermissionName: Cleaner<Permission> = asValue(...permissions)

export const asSessionEmail = asObject<SessionEmail>({
  email: asString,
  confirmed: asBoolean,
})

export const asSessionInfo = asObject<SessionInfo>({
  accountId: asNumber,
  name: asString,
  role: asRoleName,
  csrf: asString,
  permissions: asArray(asPermissionName),
  emails: asArray(asSessionEmail),
})

export const asSignInReply = asObject<SignInReply>({
  name: asString,
  role: asRoleName,
  csrf: asString,
})

/** The Argon2id parameters the parameters route answers. */
export const asSessionParameters: Cleaner<ArgonParameters> = (raw) =>
  asArgonParameters(raw)
