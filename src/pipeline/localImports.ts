// Whether a Masonfile can run on its own, without the rest of its
// repository: a stage with no checkout gets only the Masonfile when it
// imports no other file of the repository at run time. Pure, so the worker
// and its tests share it.

/**
 * The text without its line and block comments, so a commented-out import
 * is not counted; `//` after `:` or `\\` (a URL, an escape) is kept. One
 * pass, so no input takes longer than its length.
 */
function withoutComments(text: string): string {
  let out = ''
  let from = 0
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '/') continue
    const next = text[i + 1]
    if (next === '*') {
      const end = text.indexOf('*/', i + 2)
      out += text.slice(from, i)
      from = i = end < 0 ? text.length : end + 2
      i--
    } else if (next === '/' && (i === 0 || !/[:\\]/.test(text[i - 1]!))) {
      const end = text.indexOf('\n', i + 2)
      out += text.slice(from, i)
      from = i = end < 0 ? text.length : end
      i--
    }
  }
  return out + text.slice(from)
}

/**
 * Each module specifier the text loads at run time, in order. No two
 * repeated parts of a pattern can match the same text, so none backtracks
 * over a long run of spaces.
 */
const SPECIFIERS = [
  // import x from '…', import { x } from '…', import * as x from '…'
  /\bimport\s(?!\s*type\s)[^'"`;]{0,2000}?\bfrom\s*(['"])([^'"]+)\1/g,
  // import '…'
  /\bimport\s*(['"])([^'"]+)\1/g,
  // export { x } from '…', export * from '…'
  /\bexport\s(?!\s*type\s)[^'"`;]{0,2000}?\bfrom\s*(['"])([^'"]+)\1/g,
  // import('…'), require('…')
  /\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
]

/**
 * The relative modules (`./x`, `../y`) a Masonfile loads at run time, which
 * only a copy of its repository has. Type-only imports are erased before it
 * runs, and Node's built-ins and package names are not the repository's.
 */
export function localImports(text: string): string[] {
  const code = withoutComments(text)
  const out = new Set<string>()
  for (const pattern of SPECIFIERS)
    for (const match of code.matchAll(pattern)) {
      const specifier = match[2]!
      if (specifier.startsWith('./') || specifier.startsWith('../'))
        out.add(specifier)
    }
  return [...out]
}
