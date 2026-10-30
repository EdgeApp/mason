/** Account roles, lowest first; each includes everything below it. */
export const roles = ['tester', 'developer', 'manager', 'admin'] as const
export type Role = (typeof roles)[number]

export const rank = (role: Role): number => roles.indexOf(role)
export const atLeast = (role: Role, minimum: Role): boolean =>
  rank(role) >= rank(minimum)

export function asRole(value: unknown): Role {
  if (
    typeof value !== 'string' ||
    !(roles as readonly string[]).includes(value)
  )
    throw new Error('Expected a role: admin, manager, developer or tester')
  return value as Role
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
}

/** The owner of the data directory, through the control socket. */
export const localOperator: Actor = { role: 'admin', label: 'local operator' }

export class Forbidden extends Error {
  constructor(message = 'Not allowed for this role') {
    super(message)
  }
}
