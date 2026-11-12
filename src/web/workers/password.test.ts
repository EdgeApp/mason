import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { clientPasswordHash } from '../../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
} from '../../auth/passwordProtocol.js'
import {
  respond,
  serve,
  type HashRequest,
  type HashResponse,
  type WorkerScope,
} from './password.js'

describe('The password worker', () => {
  it('computes the protocol’s client hash for an account’s parameters', async () => {
    const parameters = clientParameters('ab'.repeat(16), DEFAULT_PASSWORD_COSTS)
    assert.deepEqual(
      await respond({ kind: 'hash', password: 'Correct-Horse-9', parameters }),
      { clientHash: await clientPasswordHash('Correct-Horse-9', parameters) },
    )
  })

  it('calibrates a new password’s costs to about three seconds and gives it a random salt', async () => {
    const seen: number[] = []
    const answer = await respond(
      { kind: 'new', password: 'Owner-Horse-9' },
      (bytes) => bytes.fill(7),
      async (_password, parameters) => {
        seen.push(parameters.iterations)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return 'ab'.repeat(32)
      },
    )
    assert('clientParameters' in answer, JSON.stringify(answer))
    assert.equal(answer.clientParameters!.salt, '07'.repeat(16))
    assert(
      answer.clientParameters!.iterations > DEFAULT_PASSWORD_COSTS.iterations,
    )
    assert.equal(seen.length, 2)
    assert.equal(answer.clientHash, 'ab'.repeat(32))
  })

  it('answers a failure as a message, never a throw', async () => {
    assert.deepEqual(
      await respond({
        kind: 'hash',
        password: 'x'.repeat(2000),
        parameters: clientParameters('ab'.repeat(16)),
      }),
      { error: 'Password is too long' },
    )
  })

  it('answers each message its scope receives', async () => {
    const replies: HashResponse[] = []
    const scope: WorkerScope = {
      onmessage: null,
      postMessage: (message) => replies.push(message),
    }
    serve(scope, async (request: HashRequest) => ({
      clientHash: `hashed ${request.password}`,
    }))
    scope.onmessage!({ data: { kind: 'new', password: 'one' } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(replies, [{ clientHash: 'hashed one' }])
  })
})
