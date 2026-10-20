import { readFileSync } from 'node:fs'
import { checkExamples } from '../src/docs/docExamples.ts'

const errors = checkExamples(
  readFileSync('docs/masonfile.md', 'utf8'),
  'types/mason/index.d.ts',
)
for (const error of errors)
  console.error(`docs/masonfile.md:${error.line}: ${error.message}`)
process.exitCode = errors.length === 0 ? 0 : 1
