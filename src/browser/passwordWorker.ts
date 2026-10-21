import { calibratePasswordCosts } from '../auth/passwordCalibration.js'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  bytesHex,
  clientParameters,
  type ArgonParameters,
  type PasswordKdf,
} from '../auth/passwordProtocol.js'

/** What a page asks the password worker. */
export type WorkerRequest =
  | { kind: 'hash'; password: string; parameters: ArgonParameters }
  | { kind: 'new'; password: string }

export type WorkerResponse =
  | { clientHash: string; clientParameters?: ArgonParameters }
  | { error: string }

/**
 * Computes the client half of the password protocol off the page's thread:
 * the Argon2id client hash with an account's parameters, or for a new
 * password, costs calibrated to about three seconds and a random salt.
 */
export async function respond(
  request: WorkerRequest,
  random: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
  kdf: PasswordKdf = clientPasswordHash,
): Promise<WorkerResponse> {
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

interface WorkerScope {
  onmessage: ((event: { data: WorkerRequest }) => void) | null
  postMessage: (message: WorkerResponse) => void
}
const scope = globalThis as unknown as Partial<WorkerScope> & {
  importScripts?: unknown
}
// Only inside a worker: a page or a test importing this module does nothing.
if (typeof scope.importScripts === 'function')
  scope.onmessage = (event): void => {
    void respond(event.data).then((answer) => scope.postMessage!(answer))
  }
