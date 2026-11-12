// Addresses both the nodes and the web app need to agree on.

/**
 * The pages that hash a password with the Argon2id worker: sign-in on the
 * master and the host, first-run setup (the master's `/` before its first
 * account), invitations, Your account and People. The app always enters
 * them by a full document load (`reloadDocument` links; `location.assign`
 * after a 401 or signing out), so the policy their address is served with
 * is the one they run under.
 */
export const PASSWORD_PATHS: readonly string[] = [
  '/sign-in',
  '/auth/login',
  '/auth/invite',
  '/account',
  '/people',
]

/** Whether an address (path, no query) is one of the password pages. */
export const isPasswordPath = (pathname: string): boolean =>
  PASSWORD_PATHS.includes(pathname.replace(/\/+$/, '') || '/')

/**
 * Where a page may send the browser after signing in: a path on this node,
 * never another origin (`//…`, `\`), a fragment, or the sign-in protocol.
 * Anything else is `/`.
 */
export function safeReturn(value: string | null | undefined): string {
  if (
    value == null ||
    value.length > 1024 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\#]/.test(value) ||
    value.startsWith('/auth/')
  )
    return '/'
  return value
}
