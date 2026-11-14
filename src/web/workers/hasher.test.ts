import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'mocha'
import { clientParameters } from '../../auth/passwordProtocol.js'
import type { HashRequest, HashResponse } from './password.js'
import {
  browserHasher,
  workerHasher,
  workerUrl,
  WORKER_META,
  type HashWorker,
} from './hasher.js'

/** A worker that answers each request after a tick, as the real one does. */
class FakeWorker implements HashWorker {
  static made: Array<{ url: string; options: unknown }> = []
  onmessage: ((event: { data: HashResponse }) => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null
  seen: HashRequest[] = []
  terminate?: () => void
  answer: (request: HashRequest) => HashResponse = (request) =>
    request.kind === 'hash'
      ? { clientHash: `hash:${request.password}` }
      : {
          clientHash: `new:${request.password}`,
          clientParameters: clientParameters('07'.repeat(16)),
        }
  constructor(url = '', options: unknown = undefined) {
    FakeWorker.made.push({ url, options })
  }
  postMessage(message: HashRequest): void {
    this.seen.push(message)
    setTimeout(() => this.onmessage?.({ data: this.answer(message) }), 1)
  }
}

const parameters = clientParameters('ab'.repeat(16))

describe('The page’s password hasher', () => {
  afterEach(() => {
    FakeWorker.made = []
    document.head.innerHTML = ''
  })

  it('makes the worker on the first request only, and asks it one request at a time', async () => {
    const worker = new FakeWorker()
    let made = 0
    const hasher = workerHasher(() => {
      made++
      return worker
    })
    assert.equal(made, 0)
    const [a, b, c] = await Promise.all([
      hasher.hash('one', parameters),
      hasher.hash('two', parameters),
      hasher.create('three'),
    ])
    assert.equal(a, 'hash:one')
    assert.equal(b, 'hash:two')
    assert.equal(c.clientHash, 'new:three')
    assert.equal(c.clientParameters.salt, '07'.repeat(16))
    assert.equal(made, 1)
    assert.deepEqual(
      worker.seen.map((request) => request.password),
      ['one', 'two', 'three'],
    )
  })

  it('throws the worker’s refusal, a load failure, and a new password without parameters', async () => {
    const worker = new FakeWorker()
    const hasher = workerHasher(() => worker)
    worker.answer = (): HashResponse => ({ error: 'Password is too long' })
    await assert.rejects(hasher.hash('x', parameters), /Password is too long/)
    worker.answer = (request): HashResponse => ({
      clientHash: `hash:${request.password}`,
    })
    await assert.rejects(hasher.create('x'), /gave no parameters/)
    // A worker that never loads (its script refused, its WebAssembly blocked).
    worker.postMessage = (): void => {
      setTimeout(() => worker.onerror?.({ message: 'CompileError: blocked' }))
    }
    await assert.rejects(hasher.hash('x', parameters), /CompileError: blocked/)
    worker.postMessage = (): void => {
      setTimeout(() => worker.onerror?.({}))
    }
    await assert.rejects(
      hasher.hash('x', parameters),
      /could not prepare the password/,
    )
    // The queue carries on after a failure.
    worker.postMessage = FakeWorker.prototype.postMessage.bind(worker)
    assert.equal(await hasher.hash('y', parameters), 'hash:y')
  })

  it('makes a new worker for the request after one fails to load', async () => {
    // The first worker's script fails; it would never answer again.
    const broken = new FakeWorker()
    let terminated = 0
    broken.postMessage = (): void => {
      setTimeout(() => broken.onerror?.({ message: 'Failed to load' }))
    }
    broken.terminate = (): void => {
      terminated++
    }
    const fresh = new FakeWorker()
    const made = [broken, fresh]
    const hasher = workerHasher(() => made.shift()!)
    await assert.rejects(hasher.hash('x', parameters), /Failed to load/)
    assert.equal(terminated, 1)
    assert.equal(await hasher.hash('y', parameters), 'hash:y')
    assert.deepEqual(made, [])
    assert.deepEqual(
      fresh.seen.map((request) => request.password),
      ['y'],
    )
  })

  it('runs the bundle’s module worker that index.html names', async () => {
    assert.throws(() => workerUrl(document), /no password worker/)
    const meta = document.createElement('meta')
    meta.name = WORKER_META
    meta.content = '/assets/web/password-worker-ABCDEFGH.js'
    document.head.append(meta)
    assert.equal(workerUrl(document), '/assets/web/password-worker-ABCDEFGH.js')
    const original = (globalThis as { Worker?: unknown }).Worker
    ;(globalThis as { Worker?: unknown }).Worker = FakeWorker
    try {
      assert.equal(await browserHasher().hash('pw', parameters), 'hash:pw')
      assert.deepEqual(FakeWorker.made, [
        {
          url: '/assets/web/password-worker-ABCDEFGH.js',
          options: { type: 'module' },
        },
      ])
    } finally {
      ;(globalThis as { Worker?: unknown }).Worker = original
    }
  })
})
