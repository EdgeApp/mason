// Addresses both the nodes and the web app need to agree on.

/**
 * The pages that hash a password with the Argon2id worker: sign-in on the
 * master and the host, first-run setup (the master's `/` before its first
 * account), invitations, Your account and People. Every page is served
 * under the shell's CSP; only the worker's own script may compile
 * WebAssembly. The app still enters these pages by a full document load
 * (`reloadDocument` links; `location.assign` after a 401 or signing out),
 * so the worker is fetched under the shell's current CSP into a clean
 * document, nothing kept from before sign-out: a hedge for a browser that
 * would refuse the worker's policy in a reused document.
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
 * never another origin (`//…`, `\`, or a control character, which the URL
 * parser drops: `/\t/x` is `//x`), a fragment, or the sign-in protocol.
 * Anything else is `/`.
 */
export function safeReturn(value: string | null | undefined): string {
  if (
    value == null ||
    value.length > 1024 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\#\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith('/auth/')
  )
    return '/'
  return value
}

/** A run's page. */
export const runHref = (id: string): string => `/runs/${encodeURIComponent(id)}`

/** Where an app ID's pages are: `/projects/:slug/apps/:appId`, its Runs and builds. */
export function appPath(slug: string, appId: string): string {
  return `/projects/${encodeURIComponent(slug)}/apps/${encodeURIComponent(appId)}`
}
