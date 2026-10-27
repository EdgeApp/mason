import { matches } from './rules.js'
import { atLeast, Forbidden, type Actor, type Role } from './roles.js'

/**
 * The policy table: every action the master's API, UI and host replication
 * check, and the lowest role allowed it. Each role includes the ones below.
 */
export const policy = {
  /** Their groups' published builds; register devices. */
  'builds.read': 'tester',
  'devices.register': 'tester',
  /** Every app, all runs, statuses, stage graphs, steps, full logs and artifacts. */
  'apps.read': 'developer',
  'projects.read': 'developer',
  'runs.read': 'developer',
  /** Request, cancel and restart runs; approvals also check the workflow's roles. */
  'runs.request': 'developer',
  'runs.approve': 'developer',
  /** API keys up to the creator's own role. */
  'keys.create': 'developer',
  /** Configure Mason. */
  'projects.change': 'manager',
  'secrets.change': 'manager',
  'buildNumbers.seed': 'manager',
  'settings.read': 'manager',
  'settings.change': 'manager',
  'nodes.read': 'manager',
  'nodes.change': 'manager',
  'keys.read': 'manager',
  'keys.revoke': 'manager',
  'apple.change': 'manager',
  'backups.run': 'manager',
  /** Groups: their apps and their people. */
  'groups.read': 'manager',
  'groups.change': 'manager',
  'people.read': 'manager',
  /** Add and remove people and set their roles. */
  'people.change': 'admin',
  /** The backup key is shown to administrators only. */
  'backups.key': 'admin',
} as const satisfies Record<string, Role>

export type Action = keyof typeof policy

/** Whether an actor's role allows an action. */
export function can(actor: Actor, action: Action): boolean {
  return atLeast(actor.role, policy[action])
}

/**
 * Refuses an action the actor's role does not allow, before the request
 * names its project: a list then shows only what a key's scopes cover.
 */
export function allowRole(actor: Actor, action: Action): void {
  if (!can(actor, action))
    throw new Forbidden(`Not allowed for the ${actor.role} role`)
}

/** What a request acts on, for a key's project and branch scopes. */
export interface Target {
  project?: string
  branch?: string
}

/** A key with project or branch scopes. */
export function scoped(actor: Actor): boolean {
  const scopes = actor.scopes
  return (
    scopes != null &&
    (scopes.projects.length !== 0 || scopes.branches.length !== 0)
  )
}

/** Whether a key's scopes cover a project and branch; unscoped actors cover everything. */
export function covers(actor: Actor, target: Target): boolean {
  if (!scoped(actor)) return true
  const scopes = actor.scopes!
  if (target.project == null) return false
  if (scopes.projects.length !== 0 && !scopes.projects.includes(target.project))
    return false
  if (
    target.branch != null &&
    scopes.branches.length !== 0 &&
    !scopes.branches.some((pattern) => matches(pattern, target.branch!))
  )
    return false
  return true
}

/**
 * Refuses an action the actor's role does not allow, and one outside a
 * scoped key's projects and branches; a scoped key cannot act on anything
 * that is not about a project.
 */
export function allow(actor: Actor, action: Action, target?: Target): void {
  allowRole(actor, action)
  if (!covers(actor, target ?? {}))
    throw new Forbidden(
      target?.project == null
        ? 'This key is scoped to projects and cannot do that'
        : 'This key does not cover that project or branch',
    )
}
