// The Argon2id password worker: bundle-web.mjs builds it into
// password-worker-[hash].js, which the node serves with the one policy that
// lets it compile WebAssembly. The page never hashes a password itself
// (src/web/workers/hasher.ts talks to it). Moved from
// src/browser/passwordWorker.ts, which the server pages keep until they go.
import { calibratePasswordCosts } from '../../auth/passwordCalibration.js'
import { clientPasswordHash } from '../../auth/passwordKdf.js'
import {
  bytesHex,
  clientParameters,
  type ArgonParameters,
  type PasswordKdf,
} from '../../auth/passwordProtocol.js'

/** What a page asks the worker: an account's password hashed with its parameters, or a new password. */
export type HashRequest =
  | { kind: 'hash'; password: string; parameters: ArgonParameters }
  | { kind: 'new'; password: string }

export type HashResponse =
  | { clientHash: string; clientParameters?: ArgonParameters }
  | { error: string }

/**
 * Computes the client half of the password protocol: the Argon2id client
 * hash with an account's parameters, or for a new password, costs calibrated
 * to about three seconds and a random salt.
 */
export async function respond(
  request: HashRequest,
  random: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
  kdf: PasswordKdf = clientPasswordHash,
): Promise<HashResponse> {
  try {
    if (request.kind === 'hash')
      return { clientHash: await kdf(request.password, request.parameters) }
    const calibration = await calibratePasswordCosts(kdf)
    const parameters = clientParameters(
      bytesHex(random(new Uint8Array(16))),
      calibration.costs,
    )
    return {
      clientHash: await kdf(request.password, parameters),
      clientParameters: parameters,
    }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

/** A worker's global scope, as much of it as this uses. */
export interface WorkerScope {
  onmessage: ((event: { data: HashRequest }) => void) | null
  postMessage: (message: HashResponse) => void
}

/** Answers each message the scope receives. */
export function serve(
  scope: WorkerScope,
  answer: (request: HashRequest) => Promise<HashResponse> = respond,
): void {
  scope.onmessage = (event): void => {
    void answer(event.data).then((reply) => scope.postMessage(reply))
  }
}

const scope = globalThis as unknown as WorkerScope & { importScripts?: unknown }
// Only inside a worker: a test importing this module does nothing.
if (typeof scope.importScripts === 'function') serve(scope)
