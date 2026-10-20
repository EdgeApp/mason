import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { calibratePasswordCosts } from './passwordCalibration.js'
import { clientPasswordHash } from './passwordKdf.js'
import {
  asArgonParameters,
  asNewPasswordParameters,
  asPasswordUpdate,
  bytesHex,
  checkNewPassword,
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
  hexBytes,
  newPasswordRequirements,
  passwordBytes,
  rejectRawPassword,
} from './passwordProtocol.js'

const proof = 'ab'.repeat(32)
const salt = '000102030405060708090a0b0c0d0e0f'

describe('Argon2 password protocol', function () {
  this.timeout(30000)
  it('encodes passwords as UTF-8, replacing lone surrogates', () => {
    for (const value of ['ascii', 'é', '漢字', '😀'])
      assert.deepEqual(
        Buffer.from(passwordBytes(value)),
        Buffer.from(value, 'utf8'),
      )
    assert.deepEqual(
      Buffer.from(passwordBytes('\ud800')),
      Buffer.from('�', 'utf8'),
    )
    assert.equal(bytesHex(hexBytes('00ff10')), '00ff10')
  })
  it('validates parameters, client hashes and new passwords', () => {
    const p = clientParameters(salt)
    assert.deepEqual(asArgonParameters(p), p)
    for (const bad of [
      null,
      { ...p, algorithm: 'argon2i' },
      { ...p, parallelism: 5 },
      { ...p, memoryKiB: 1024 },
      { ...p, memoryKiB: 32770 },
      { ...p, iterations: 1 },
      { ...p, iterations: 5000 },
      { ...p, salt: 'xyz' },
    ])
      assert.throws(() => asArgonParameters(bad))
    assert.equal(
      asArgonParameters({ ...p, iterations: 4000 }, true).iterations,
      4000,
    )
    assert.throws(
      () => asNewPasswordParameters({ ...p, iterations: 2 }),
      /at least 32 MiB/,
    )
    assert(newPasswordRequirements('Abcdefg1').valid)
    assert(newPasswordRequirements('a long password with no rules').valid)
    assert(!newPasswordRequirements('abcdefgh').valid)
    assert(newPasswordRequirements('é'.repeat(600)).tooLong)
    assert.throws(() => checkNewPassword('é'.repeat(600)), /1024/)
    assert.throws(() => checkNewPassword('short'), /8 characters/)
    checkNewPassword('Correct-Horse-9')
    assert.throws(
      () => rejectRawPassword({ password: 'x' }),
      /client password hash/,
    )
    assert.throws(
      () => rejectRawPassword({ currentPassword: 'x' }),
      /client password hash/,
    )
    rejectRawPassword({ clientHash: proof })
    assert.equal(
      asPasswordUpdate({ clientHash: proof, clientParameters: p }).clientHash,
      proof,
    )
    assert.throws(() => asPasswordUpdate({ password: 'x' }))
  })
  it('hashes on the client with hash-wasm and refuses overlong input', async () => {
    const p = clientParameters(salt)
    const hash = await clientPasswordHash('Correct-Horse-9', p)
    assert.match(hash, /^[a-f0-9]{64}$/)
    assert.equal(await clientPasswordHash('Correct-Horse-9', p), hash)
    await assert.rejects(clientPasswordHash('x'.repeat(1025), p), /too long/)
    await assert.rejects(clientPasswordHash('é'.repeat(600), p), /too long/)
  })
  it('calibrates iterations to the target time with a floor and a ceiling', async () => {
    for (const [duration, iterations] of [
      [4000, 6],
      [1500, 12],
      [1000, 18],
      [1, 1024],
    ] as const) {
      let clock = 0
      const result = await calibratePasswordCosts(
        async (_input, p) => {
          assert.equal(p.iterations, 6)
          return proof
        },
        undefined,
        undefined,
        () => (clock++ === 0 ? 100 : 100 + duration),
      )
      assert.deepEqual(result, {
        baselineMs: duration,
        costs: { ...DEFAULT_PASSWORD_COSTS, iterations },
      })
    }
    await assert.rejects(
      calibratePasswordCosts(async () => proof, undefined, -1),
      /positive/,
    )
    await assert.rejects(
      calibratePasswordCosts(
        async () => proof,
        undefined,
        undefined,
        () => 5,
      ),
      /measure/,
    )
    await assert.rejects(
      calibratePasswordCosts(async () => 'nonsense'),
      /hex/,
    )
  })
})
