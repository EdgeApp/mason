import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import {
  asCompleteData,
  asLayoutStage,
  asProjectCard,
  asRecord,
  asRunPage,
  runPath,
} from './index.js'
import { asString } from 'cleaners'

describe('The shared contract’s cleaners', () => {
  it('reads a record, a stage’s matrix and a registration’s end, and refuses what is not one', () => {
    assert.deepEqual(asRecord(asString)({ a: 'b' }), { a: 'b' })
    for (const bad of [null, [], 'text'])
      assert.throws(() => asRecord(asString)(bad), /Expected an object/)
    const stage = {
      name: 'android',
      kind: 'stage',
      needs: [],
      matrix: { arch: 'arm64', api: 35, debug: false },
    }
    assert.deepEqual(asLayoutStage(stage), { ...stage, group: undefined })
    assert.throws(
      () => asLayoutStage({ ...stage, matrix: { arch: ['arm64'] } }),
      /Expected a string, number or boolean/,
    )
    assert.deepEqual(asCompleteData({ state: 'registering' }), {
      state: 'registering',
    })
    assert.deepEqual(
      asCompleteData({
        state: 'registered',
        device: { id: 3, model: 'iPhone' },
      }),
      { state: 'registered', device: { id: 3, model: 'iPhone' } },
    )
    assert.throws(() => asCompleteData({ state: 'registered' }))
    assert.throws(() => asCompleteData({ state: 'lost' }))
    assert.throws(
      () =>
        asProjectCard({
          id: 1,
          slug: 'p',
          name: 'P',
          defaultBranch: null,
          webhook: 'yes',
          runs: [],
          apps: [],
        }),
      /Expected a boolean/,
    )
    assert.throws(() => asRunPage({ id: 'r' }))
    assert.equal(
      runPath('a b', ['graph', 'steps']),
      '/api/v2/runs/a%20b?include=graph,steps',
    )
  })
})
