import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'mocha'
import { checkExamples, codeBlocks } from './docExamples.js'

const types = 'types/mason/index.d.ts'
const setup = [
  "import type { Setup, Stage } from '@mason/types'",
  'export function setup(m: Setup) {',
  "  m.stage('test', { on: 'linux', run: test })",
  '}',
  'export async function test(ctx: Stage) {',
  "  await ctx.sh('npm test')",
  '}',
].join('\n')

describe('Masonfile documentation examples', function () {
  this.timeout(60000)
  it('finds fenced ts blocks with their first code line', () => {
    const markdown = [
      '# Title', // 1
      '```ts', // 2
      'const a = 1', // 3
      '```', // 4
      '```sh', // 5
      'echo hi', // 6
      '```', // 7
      '    const indented = true', // 8
      '```ts fragment', // 9
      "m.stage('x', {})", // 10
      '```', // 11
      '~~~typescript', // 12
      'const b = 2', // 13
      'const c = 3', // 14
      '~~~', // 15
      '```', // 16
      'plain', // 17
      '```', // 18
    ].join('\n')
    assert.deepEqual(codeBlocks(markdown), [
      { line: 3, source: 'const a = 1\n' },
      { line: 13, source: 'const b = 2\nconst c = 3\n' },
    ])
  })
  it('keeps a longer fence open past a shorter one', () => {
    const markdown = '````ts\nconst s = `\n```\n`\n````\n'
    assert.deepEqual(codeBlocks(markdown), [
      { line: 2, source: 'const s = `\n```\n`\n' },
    ])
  })
  it('refuses an unclosed fence', () => {
    assert.throws(() => codeBlocks('text\n```ts\nconst a = 1\n'), /line 2/)
  })
  it('passes a document whose examples typecheck', () => {
    assert.deepEqual(
      checkExamples(`Intro\n\n\`\`\`ts\n${setup}\n\`\`\`\n`, types),
      [],
    )
    assert.deepEqual(checkExamples('No code here.\n', types), [])
  })
  it('reports a broken example at its Markdown line', () => {
    const broken = [
      'Intro', // 1
      '', // 2
      '```ts', // 3
      setup, // 4-10
      '```', // 11
      '', // 12
      '```ts', // 13
      "import type { Setup } from '@mason/types'", // 14
      'export function setup(m: Setup) {', // 15
      "  m.stage('bad', { on: 'linux', run: 'not a function' })", // 16
      '}', // 17
      '```', // 18
    ].join('\n')
    const errors = checkExamples(broken, types)
    assert.equal(errors.length, 1)
    assert.equal(errors[0]!.line, 16)
    assert.match(errors[0]!.message, /StageFunction/)
  })
  it('typechecks every complete example in docs/masonfile.md', () => {
    const markdown = readFileSync('docs/masonfile.md', 'utf8')
    assert(codeBlocks(markdown).length >= 5)
    assert.deepEqual(checkExamples(markdown, types), [])
  })
})
