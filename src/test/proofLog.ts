import { appendFileSync } from 'node:fs'

/**
 * Appends a request and what came back to the proof log named by
 * `MASON_PROOF_LOG`, as a `$` line and its output. Without it, does nothing.
 */
export function proofLog(command: string, output: string): void {
  const file = process.env.MASON_PROOF_LOG
  if (file == null || file === '') return
  appendFileSync(file, `$ ${command}\n${output.trimEnd()}\n\n`)
}
