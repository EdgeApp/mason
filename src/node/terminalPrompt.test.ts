import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'mocha'

// The prompts read the real terminal, so this drives them through a
// pseudo-terminal with expect(1); a machine without it skips the test.
const EXPECT = '/usr/bin/expect'

describe('terminal prompts', function () {
  this.timeout(30_000)

  it('U9.6 read the two-factor code after the password with one Enter each, and never echo the password', function () {
    if (!existsSync(EXPECT)) this.skip()
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'tty-'),
    )
    // The same module the test runs from: lib/node/main.js, or main.ts under tsx.
    const here = fileURLToPath(import.meta.url)
    const main = path.join(path.dirname(here), `main${path.extname(here)}`)
    const script = path.join(dir, 'prompts.mjs')
    writeFileSync(
      script,
      `const { terminalPrompt } = await import(${JSON.stringify(main)})
const password = await terminalPrompt('Password: ', true)
const code = await terminalPrompt('Code: ', false)
console.log('RESULT ' + JSON.stringify({ password, code }))
process.exit(0)
`,
    )
    const node = [
      process.execPath,
      ...(path.extname(here) === '.ts' ? ['--import', 'tsx'] : []),
      script,
    ]
    // One Enter after each answer; a second Enter would mean the first was lost.
    writeFileSync(
      path.join(dir, 'prompts.exp'),
      `set timeout 10
spawn ${node.map((part) => `{${part}}`).join(' ')}
expect "Password: "
send "hunter2\\r"
expect "Code: "
send "123456\\r"
expect {
  "RESULT" { expect -re {\\{.*\\}}; exit 0 }
  timeout { puts "NO ANSWER AFTER ONE ENTER"; exit 1 }
}
`,
    )
    // From the repository, so `--import tsx` finds tsx.
    const run = spawnSync(EXPECT, [path.join(dir, 'prompts.exp')], {
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    const result = JSON.parse(/RESULT (\{.*\})/.exec(run.stdout)![1]!) as {
      password: string
      code: string
    }
    assert.deepEqual(result, { password: 'hunter2', code: '123456' })
    // Only the RESULT line names the password; the prompt never echoed it.
    assert.equal(run.stdout.split('hunter2').length - 1, 1, run.stdout)
  })
})
