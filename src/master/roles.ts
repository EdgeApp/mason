import { isRole, roles, type Role } from '../shared/permissions.js'

export { roles, type Role }

export const rank = (role: Role): number => roles.indexOf(role)
export const atLeast = (role: Role, minimum: Role): boolean =>
  rank(role) >= rank(minimum)

export function asRole(value: unknown): Role {
  if (!isRole(value))
    throw new Error('Expected a role: admin, manager, developer or tester')
  return value
}

/** Who did something, for authorization and the audit log. */
export interface Actor {
  role: Role
  accountId?: number
  keyId?: string
  /** `local operator`, `key:<id>`, `account:<id>` or `host:<account id>`. */
  label: string
  /** Key scopes, when the actor is an API key. */
  scopes?: { projects: string[]; branches: string[] }
  /** The account that made a key, when it has one: whose groups a tester-role key sees. */
  creator?: number
}

/** The owner of the data directory, through the control socket. */
export const localOperator: Actor = { role: 'admin', label: 'local operator' }

export class Forbidden extends Error {
  constructor(message = 'Not allowed for this role') {
    super(message)
  }
}
