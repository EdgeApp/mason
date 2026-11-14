import { readFileSync } from 'node:fs'
import { checkExamples } from '../src/docs/docExamples.ts'

let failed = false
for (const [document, modules] of [
  ['docs/masonfile.md', {}],
  ['docs/api.md', { '@mason/api': 'src/shared/api/index.ts' }],
] as const) {
  const errors = checkExamples(
    readFileSync(document, 'utf8'),
    'types/mason/index.d.ts',
    modules,
  )
  for (const error of errors)
    console.error(`${document}:${error.line}: ${error.message}`)
  failed ||= errors.length !== 0
}
process.exitCode = failed ? 1 : 0
