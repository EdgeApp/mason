import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'mocha'

// The prompts read the real terminal, so this drives them through a
// pseudo-terminal with expect(1); a machine without it skips the test.
const EXPECT = '/usr/bin/expect'

/**
 * Runs `prompts`, a module body that has `terminalPrompt` in scope, on a
 * pseudo-terminal that `dialogue`, an expect(1) script, answers.
 */
function drive(prompts: string, dialogue: string): SpawnSyncReturns<string> {
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
${prompts}
`,
  )
  const node = [
    process.execPath,
    ...(path.extname(here) === '.ts' ? ['--import', 'tsx'] : []),
    script,
  ]
  writeFileSync(
    path.join(dir, 'prompts.exp'),
    `set timeout 10
spawn ${node.map((part) => `{${part}}`).join(' ')}
${dialogue}
`,
  )
  // From the repository, so `--import tsx` finds tsx.
  return spawnSync(EXPECT, [path.join(dir, 'prompts.exp')], {
    encoding: 'utf8',
  })
}

const ESC = '\u001b['

/** The terminal's escape sequences in `text`: `ESC[11G` as `11G`. */
const sequences = (text: string): string[] =>
  text
    .split(ESC)
    .slice(1)
    .map((part) => /^[0-9;]*[A-Za-z]/.exec(part)?.[0] ?? '')

/** What reached the terminal after `prompt` and readline's cursor move to its end. */
const afterPrompt = (text: string, prompt: string): string =>
  text
    .slice(text.indexOf(prompt) + prompt.length)
    .replace(`${ESC}${prompt.length + 1}G`, '')

describe('terminal prompts', function () {
  this.timeout(30_000)

  it('U9.6 read the two-factor code after the password with one Enter each, and never echo the password or its length', function () {
    if (!existsSync(EXPECT)) this.skip()
    // One Enter after each answer; a second Enter would mean the first was
    // lost. The password is edited: a typo, Backspace, Left and Right.
    const run = drive(
      `const password = await terminalPrompt('Password: ', true)
const code = await terminalPrompt('Code: ', false)
console.log('RESULT ' + JSON.stringify({ password, code }))
process.exit(0)`,
      `expect "Password: "
send "hunter2x\\177\\033\\[D\\033\\[C\\r"
expect "Code: "
send "123456\\r"
expect {
  "RESULT" { expect -re {\\{.*\\}}; exit 0 }
  timeout { puts "NO ANSWER AFTER ONE ENTER"; exit 1 }
}`,
    )
    assert.equal(run.status, 0, run.stdout + run.stderr)
    const result = JSON.parse(/RESULT (\{.*\})/.exec(run.stdout)![1]!) as {
      password: string
      code: string
    }
    assert.deepEqual(result, { password: 'hunter2', code: '123456' })
    // Only the RESULT line names the password; the prompt never echoed it.
    assert.equal(run.stdout.split('hunter2').length - 1, 1, run.stdout)
    // Nor did the cursor move past the question while it was edited.
    const hidden = run.stdout.slice(0, run.stdout.indexOf('Code: '))
    assert.deepEqual(
      sequences(hidden).filter(
        (sequence) => sequence !== '1G' && sequence !== '0J',
      ),
      [`${'Password: '.length + 1}G`],
      JSON.stringify(hidden),
    )
  })

  it('U9.6 Ctrl-C at a prompt interrupts the command, and Ctrl-D ends the prompt unanswered', function () {
    if (!existsSync(EXPECT)) this.skip()
    const prompts = `try {
  console.log('ANSWERED ' + (await terminalPrompt('Password: ', true)))
} catch (error) {
  console.log('REFUSED ' + error.message)
}
process.exit(0)`
    // Ctrl-C ends the process by SIGINT, as it did in cooked mode.
    const interrupted = drive(
      prompts,
      `expect "Password: "
send "\\003"
expect {
  eof { puts "STATUS [wait]"; exit 0 }
  timeout { puts "HUNG AFTER CTRL-C"; exit 1 }
}`,
    )
    assert.equal(interrupted.status, 0, interrupted.stdout + interrupted.stderr)
    assert.match(interrupted.stdout, /STATUS .*CHILDKILLED SIGINT/)
    assert.doesNotMatch(interrupted.stdout, /ANSWERED|REFUSED/)
    // The shell's prompt comes back on a line of its own.
    assert.match(afterPrompt(interrupted.stdout, 'Password: '), /^\r?\n/)
    // Ctrl-D on an empty line rejects the prompt, so the command can say so.
    const ended = drive(
      prompts,
      `expect "Password: "
send "\\004"
expect {
  "REFUSED No answer was typed" { exit 0 }
  timeout { puts "HUNG AFTER CTRL-D"; exit 1 }
}`,
    )
    assert.equal(ended.status, 0, ended.stdout + ended.stderr)
    assert.match(afterPrompt(ended.stdout, 'Password: '), /^\r?\nREFUSED/)
  })
})
