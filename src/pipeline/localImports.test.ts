import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { localImports } from './localImports.js'

describe('Masonfile local imports', () => {
  it('U7.28 finds the repository files a Masonfile loads at run time, and nothing a comment, a type or a package names', () => {
    assert.deepEqual(
      localImports(`
import type { Setup, Stage } from '@mason/types'
import type { Helper } from './types.ts'
import { readFile } from 'node:fs/promises'
import cleaners from 'cleaners'
// import { gone } from './commented.ts'
/* import './block.ts' */
const url = 'https://example.com/a' // a URL is no comment start
import { a } from './a.ts'
import b, { c } from "../b.js"
import './side.ts'
export { d } from './d.ts'
export type { E } from './e.ts'
export * from './f.ts'
const g = await import('./g.ts')
const h = require('../h.cjs')
import { a as again } from './a.ts'
`),
      [
        './a.ts',
        '../b.js',
        './side.ts',
        './d.ts',
        './f.ts',
        './g.ts',
        '../h.cjs',
      ],
    )
    assert.deepEqual(
      localImports(
        `import type { Setup } from '@mason/types'\nexport function setup(m: Setup) {}\n`,
      ),
      [],
    )
  })
})
