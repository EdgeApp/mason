import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
} from 'cleaners'
import type { Role } from '../permissions.js'
import { asRoleName, asSessionEmail, type SessionEmail } from './session.js'

/** `GET /api/v2/account`, both nodes: the viewer's own record. */
export const ACCOUNT_PATH = '/api/v2/account'

/** What `GET /api/v2/account` answers. */
export interface AccountInfo {
  id: number
  name: string
  role: Role
  username?: string
  /** Whether the person has a password. */
  password: boolean
  emails: SessionEmail[]
  /** Whether changes can be saved now: on a host, only while its master is reachable. */
  editable: boolean
  /** Whether the password changes here: always on the master, and on a host for testers only. */
  passwordHere: boolean
}

export const asAccountInfo = asObject<AccountInfo>({
  id: asNumber,
  name: asString,
  role: asRoleName,
  username: asOptional(asString),
  password: asBoolean,
  emails: asArray(asSessionEmail),
  editable: asBoolean,
  passwordHere: asBoolean,
})
