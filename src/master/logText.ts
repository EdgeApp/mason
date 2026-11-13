// A run log as text: the plain-text download, and where a byte offset falls.

/** Every escape sequence a terminal would act on, for the plain-text log. */
const escapes =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/** The log without escape sequences, for the plain-text download. */
export function plainLog(text: string): string {
  return text.replace(escapes, '')
}

/** The line number a byte offset of a log falls on, counting from 1. */
export function lineAt(text: Buffer, offset: number): number {
  let lines = 1
  const end = Math.min(offset, text.length)
  for (
    let i = text.indexOf(0x0a);
    i >= 0 && i < end;
    i = text.indexOf(0x0a, i + 1)
  )
    lines++
  return lines
}
