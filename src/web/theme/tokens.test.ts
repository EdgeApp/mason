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
    // 8 opaque surfaces, the thumb, and 2 fills over 7 planes.
    assert.match(run.stdout, /23 failing pair\(s\)/)
  })

  it('checks text on a translucent fill over every plane it can sit on', () => {
    const run = generate('--set', 'light.text-tertiary=#5a6780')
    assert.equal(run.status, 1)
    assert.match(
      run.stderr,
      /^light: \| `text-tertiary` \| `fill-hover` \| 4\.35 \*\*FAIL\*\* \| 4\.5 \| text-tertiary on fill-hover over canvas \|$/m,
    )
    assert.match(run.stdout, /7 failing pair\(s\)/)
  })

  it('checks a tinted button’s hover over every plane', () => {
    const run = generate('--set', 'light.accent-soft-hover=#bccfff')
    assert.equal(run.status, 1)
    assert.match(
      run.stderr,
      /^light: \| `accent-soft-text` \| `accent-soft-hover` \| [0-9.]+ \*\*FAIL\*\* \| 4\.5 \| accent-soft-text on a hovered button over canvas \|$/m,
    )
  })

  it('draws no outline but where Increase Contrast asks for one', () => {
    const css = readFileSync(committed, 'utf8')
    const [themes, rest] = css.split('@media (prefers-contrast: more)')
    const contrast = rest!.split('/* Glass')[0]!
    // Both themes: no outline colour, and a fill, a thumb and halos instead.
    assert.equal(themes!.match(/--m-edge: transparent;/g)?.length, 2)
    for (const role of [
      'fill',
      'fill-hover',
      'thumb',
      'halo',
      'halo-sm',
      'halo-accent',
      'accent-soft-hover',
      'danger-soft-hover',
    ])
      assert.equal(
        themes!.match(new RegExp(`--m-${role}: `, 'g'))?.length,
        2,
        role,
      )
    // The always-dark log: no outline, but a light line under Increase Contrast.
    assert.match(themes!, /--m-term-edge: transparent;/)
    assert.equal(
      contrast.match(/--m-term-edge: rgba\(255,255,255,0\.22\);/g)?.length,
      2,
    )
    // Increase Contrast: the outline takes each theme's border colour.
    for (const block of contrast.split(/\[data-theme='light'\]/)) {
      const border = /--m-border: ([^;]+);/.exec(block)![1]
      assert.match(
        block,
        new RegExp(`--m-edge: ${border!.replace(/[().]/g, '\\$&')};`),
      )
    }
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
