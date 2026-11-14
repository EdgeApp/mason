// The web listeners' Content-Security-Policy headers.

export const contentSecurityPolicy =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
/**
 * The master's sign-in, first-run and password pages, and the password
 * worker, compile the Argon2id WebAssembly; no other page may.
 */
export const masterContentSecurityPolicy = contentSecurityPolicy.replace(
  "script-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'",
)
/** The React app's shell: the base policy, plus the password worker. */
export const shellContentSecurityPolicy = `${contentSecurityPolicy}; worker-src 'self'`
