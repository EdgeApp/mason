import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
} from 'cleaners'
import type { ArgonParameters } from '../../auth/passwordProtocol.js'
import type { Role } from '../permissions.js'
import { asRoleName, asSessionEmail, type SessionEmail } from './session.js'

/** `GET /api/v2/people` (`people.read`) lists; `POST` (`people.change`) adds. Master only. */
export const PEOPLE_PATH = '/api/v2/people'
/** `GET`, `PUT` (`people.change`, or the person's own name, emails and password) and `DELETE` one person. */
export const personPath = (id: number): string => `${PEOPLE_PATH}/${id}`
/** `POST` makes a person's invitation link and answers it once; `DELETE` revokes it. */
export const invitationPath = (id: number): string =>
  `${personPath(id)}/invitation`

/** A person as `GET /api/v2/people` lists them. */
export interface Person {
  id: number
  name: string
  username?: string
  role: Role
  disabled: boolean
  /** Whether the account can sign in to the master with a password. */
  password: boolean
  /** Their addresses, in order; an unconfirmed one signs nobody in. */
  emails: SessionEmail[]
  groups: number[]
  permissionVersion: number
  createdAt: number
  /** An unused, unexpired invitation link: when it expires. */
  invitation?: { expiresAt: number }
}

/** A password set from the browser: its client hash, never the password. */
export interface PasswordChange {
  clientHash: string
  clientParameters: ArgonParameters
}

/** The body of `PUT /api/v2/people/:id`: only what changes. */
export interface PersonChange {
  name?: string
  /** `null` clears it. */
  username?: string | null
  role?: Role
  disabled?: boolean
  /** The whole list, replacing the person's. */
  emails?: string[]
  /** Addresses they already have, to confirm (administrators). */
  confirmEmails?: string[]
  password?: PasswordChange
}

/** The body of `POST /api/v2/people`. */
export interface PersonAdd {
  name?: string
  username?: string
  role?: Role
  emails?: string[]
  password?: PasswordChange
  /** Make the invitation link at once, answered in `invitation.url`. */
  invite?: boolean
}

/** An invitation link, shown once: `POST …/invitation`, or a `POST` with `invite`. */
export interface Invitation {
  url: string
  expiresAt: number
}

/** What `POST /api/v2/people` answers: the person, with the link when one was made. */
export type AddedPerson = Omit<Person, 'invitation'> & {
  invitation?: { url?: string; expiresAt: number }
}

const personFields = {
  id: asNumber,
  name: asString,
  username: asOptional(asString),
  role: asRoleName,
  disabled: asBoolean,
  password: asBoolean,
  emails: asArray(asSessionEmail),
  groups: asArray(asNumber),
  permissionVersion: asNumber,
  createdAt: asNumber,
}

export const asPerson = asObject<Person>({
  ...personFields,
  invitation: asOptional(asObject({ expiresAt: asNumber })),
})

export const asPeople = asArray(asPerson)

export const asInvitation = asObject<Invitation>({
  url: asString,
  expiresAt: asNumber,
})

export const asAddedPerson = asObject<AddedPerson>({
  ...personFields,
  invitation: asOptional(
    asObject({ url: asOptional(asString), expiresAt: asNumber }),
  ),
})
