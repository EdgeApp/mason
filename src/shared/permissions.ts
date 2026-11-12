// Role and permission names the server and the web app share. Which role
// each permission needs is the master's policy table
// (src/master/permissions.ts), typed against these names so the two cannot
// drift; the web app learns the viewer's set from GET /api/v2/session.

/** Account roles, lowest first; each includes everything below it. */
export const roles = ['tester', 'developer', 'manager', 'admin'] as const
export type Role = (typeof roles)[number]

/** Every action the master's API, UI and host replication check. */
export const permissions = [
  'builds.read',
  'devices.register',
  'apps.read',
  'projects.read',
  'runs.read',
  'runs.request',
  'runs.approve',
  'keys.create',
  'projects.change',
  'secrets.read',
  'secrets.change',
  'buildNumbers.seed',
  'settings.read',
  'settings.change',
  'nodes.read',
  'nodes.change',
  'keys.read',
  'keys.revoke',
  'apple.change',
  'backups.run',
  'groups.read',
  'groups.change',
  'people.read',
  'people.change',
  'signIn.change',
  'hosts.change',
  'backups.key',
] as const
export type Permission = (typeof permissions)[number]

/** Whether a value is a role's name. */
export const isRole = (value: unknown): value is Role =>
  (roles as readonly unknown[]).includes(value)
