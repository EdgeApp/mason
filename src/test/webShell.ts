// What a test sees when a node answers the React app's shell instead of a
// page: index.html with its root and its password worker, never cached,
// under the shell's policy (the worker alone may compile WebAssembly), and
// a provider sign-in's state in its <meta> when the node gave one.
import assert from 'node:assert/strict'
import {
  asSignInFlow,
  FLOW_META,
  type SignInFlow,
} from '../shared/api/index.js'
import { shellContentSecurityPolicy } from '../node/csp.js'

export interface ShellReply {
  status: number
  text: string
  headers: { get: (name: string) => string | null }
}

/** Asserts a reply is the app's shell; returns the sign-in state it carries, if any. */
export function assertShell(
  reply: ShellReply,
  status = 200,
): SignInFlow | undefined {
  assert.equal(reply.status, status, reply.text.slice(0, 300))
  assert.match(reply.text, /<div id="root"><\/div>/)
  assert.match(
    reply.text,
    /<meta name="mason-password-worker" content="\/assets\/web\/password-worker-[A-Z0-9]{8}\.js">/,
  )
  assert.equal(reply.headers.get('cache-control'), 'no-store')
  assert.equal(
    reply.headers.get('content-security-policy'),
    shellContentSecurityPolicy,
  )
  const meta = new RegExp(`<meta name="${FLOW_META}" content="([^"]*)">`).exec(
    reply.text,
  )
  if (meta == null) return undefined
  const json = meta[1]!
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
  return asSignInFlow(JSON.parse(json))
}
