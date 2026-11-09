import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, it } from 'mocha'
import { proofLog } from './proofLog.js'

describe('Proof logs', () => {
  const saved = process.env.MASON_PROOF_LOG
  afterEach(() => {
    if (saved == null) delete process.env.MASON_PROOF_LOG
    else process.env.MASON_PROOF_LOG = saved
  })

  it('writes a $ line and its output only when MASON_PROOF_LOG names a file', () => {
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'proof-'),
    )
    try {
      const file = path.join(dir, 'proof.log')
      delete process.env.MASON_PROOF_LOG
      proofLog('GET /nothing', 'unused')
      process.env.MASON_PROOF_LOG = ''
      proofLog('GET /nothing', 'unused')
      process.env.MASON_PROOF_LOG = file
      proofLog('GET /a', 'HTTP 200\n')
      proofLog('GET /b', 'HTTP 404')
      assert.equal(
        readFileSync(file, 'utf8'),
        '$ GET /a\nHTTP 200\n\n$ GET /b\nHTTP 404\n\n',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
