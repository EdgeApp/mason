import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'mocha'

/** The repository, from src/web/theme or lib/web/theme alike. */
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const committed = path.join(repo, 'src', 'web', 'theme', 'tokens.css')

describe('scripts/tokens.mjs', () => {
  let scratch: string
  const generate = (
    ...args: string[]
  ): { status: number | null; stdout: string; stderr: string; css: string } => {
    const out = path.join(scratch, `tokens-${args.length}.css`)
    const run = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts', 'tokens.mjs'), '--out', out, ...args],
      { encoding: 'utf8' },
    )
    return { ...run, css: readFileSync(out, 'utf8') }
  }

  before(() => {
    scratch = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'tokens-'),
    )
  })
  after(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('passes contrast and regenerates the committed tokens.css unchanged', () => {
    const run = generate()
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /0 failing pair\(s\)/)
    assert.equal(run.css, readFileSync(committed, 'utf8'))
  })

  it('points the fonts at the node’s own /assets/fonts', () => {
    const css = readFileSync(committed, 'utf8')
    for (const font of [
      'geist-variable',
      'jetbrains-mono-variable',
      'material-symbols-outlined-subset',
    ])
      assert(css.includes(`url('/assets/fonts/${font}.woff2')`), font)
    assert.doesNotMatch(css, /url\('fonts\//)
  })

  it('fails, naming the pairs, when a role misses its contrast', () => {
    const run = generate('--set', 'dark.text-tertiary=#333333')
    assert.equal(run.status, 1)
    assert.match(run.stderr, /^dark: \| `text-tertiary` \| `canvas` \|/m)
    assert.match(run.stdout, /8 failing pair\(s\)/)
  })

  it('refuses an argument it does not know', () => {
    const run = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts', 'tokens.mjs'), '--set', 'sepia.text=#000'],
      { encoding: 'utf8' },
    )
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /Usage/)
  })
})
