// The page's side of the password worker: one request at a time, and the
// worker itself made only when a page first hashes a password. Pages take
// the hasher from context, so a test supplies a fake.
import { createContext, useContext } from 'react'
import type { ArgonParameters } from '../../auth/passwordProtocol.js'
import type { HashRequest, HashResponse } from './password.js'

/** The `<meta>` index.html names the worker's hashed file in. */
export const WORKER_META = 'mason-password-worker'

/** A worker, as much of one as this uses. */
export interface HashWorker {
  postMessage: (message: HashRequest) => void
  onmessage: ((event: { data: HashResponse }) => void) | null
  onerror?: ((event: { message?: string }) => void) | null
  terminate?: () => void
}

/** Hashes in the worker; a refusal there is an Error here. */
export interface Hasher {
  /** An account's password, with the parameters the node gave for it. */
  hash: (password: string, parameters: ArgonParameters) => Promise<string>
  /** A new password: costs calibrated here (about three seconds) and a fresh salt. */
  create: (
    password: string,
  ) => Promise<{ clientHash: string; clientParameters: ArgonParameters }>
}

/** Sends requests to a worker one at a time; `make` is called on the first. */
export function workerHasher(make: () => HashWorker): Hasher {
  let worker: HashWorker | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const ask = async (request: HashRequest): Promise<HashResponse> => {
    const answer = queue.then(
      async () =>
        await new Promise<HashResponse>((resolve) => {
          const current = (worker ??= make())
          current.onmessage = (event): void => {
            resolve(event.data)
          }
          // A worker that fails to load or to compile its WebAssembly; it
          // never answers again, so the next request makes another.
          current.onerror = (event): void => {
            current.terminate?.()
            if (worker === current) worker = undefined
            resolve({
              error:
                event.message == null || event.message === ''
                  ? 'This browser could not prepare the password; reload and try again'
                  : event.message,
            })
          }
          current.postMessage(request)
        }),
    )
    queue = answer.catch(() => undefined)
    return await answer
  }
  const checked = async (
    request: HashRequest,
  ): Promise<{ clientHash: string; clientParameters?: ArgonParameters }> => {
    const reply = await ask(request)
    if ('error' in reply) throw new Error(reply.error)
    return reply
  }
  return {
    hash: async (password, parameters) =>
      (await checked({ kind: 'hash', password, parameters })).clientHash,
    create: async (
      password,
    ): Promise<{ clientHash: string; clientParameters: ArgonParameters }> => {
      const reply = await checked({ kind: 'new', password })
      if (reply.clientParameters == null)
        throw new Error('The password worker gave no parameters')
      return {
        clientHash: reply.clientHash,
        clientParameters: reply.clientParameters,
      }
    },
  }
}

/** The worker's address, from index.html's `<meta>`. */
export function workerUrl(doc: Document = document): string {
  const url = doc
    .querySelector(`meta[name="${WORKER_META}"]`)
    ?.getAttribute('content')
  if (url == null || url === '')
    throw new Error('This page has no password worker; reload and try again')
  return url
}

/** The page's hasher: the bundle's module worker, made when first needed. */
export const browserHasher = (doc?: Document): Hasher =>
  workerHasher(
    () =>
      new Worker(workerUrl(doc ?? document), {
        type: 'module',
      }) as unknown as HashWorker,
  )

/** The app's hasher: the browser's worker, unless a test provides another. */
export const HasherContext = createContext<Hasher>(browserHasher())

export const useHasher = (): Hasher => useContext(HasherContext)
