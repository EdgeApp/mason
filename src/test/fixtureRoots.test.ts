import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Test launchers may supply a proving-artifact root. Otherwise the test process
// creates and removes its own private scratch directory.
if (process.env.MASON_TEST_ROOT == null || process.env.MASON_TEST_ROOT === '') {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mason-fixture-'))
  process.env.MASON_TEST_ROOT = root
  process.once('exit', () => {
    rmSync(root, { recursive: true, force: true })
  })
}
