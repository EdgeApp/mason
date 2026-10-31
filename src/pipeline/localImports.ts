// Whether a Masonfile can run on its own, without the rest of its
// repository: a stage with no checkout gets only the Masonfile when it
// imports no other file of the repository at run time. Pure, so the worker
// and its tests share it.

/** Line and block comments, so a commented-out import is not counted. */
const COMMENTS = /\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g

/** Each module specifier the text loads at run time, in order. */
const SPECIFIERS = [
  // import x from '…', import { x } from '…', import * as x from '…'
  /\bimport\s+(?!type\s)[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
  // import '…'
  /\bimport\s*(['"])([^'"]+)\1/g,
  // export { x } from '…', export * from '…'
  /\bexport\s+(?!type\s)[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
  // import('…'), require('…')
  /\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
]

/**
 * The relative modules (`./x`, `../y`) a Masonfile loads at run time, which
 * only a copy of its repository has. Type-only imports are erased before it
 * runs, and Node's built-ins and package names are not the repository's.
 */
export function localImports(text: string): string[] {
  const code = text.replace(COMMENTS, '$1')
  const out = new Set<string>()
  for (const pattern of SPECIFIERS)
    for (const match of code.matchAll(pattern)) {
      const specifier = match[2]!
      if (specifier.startsWith('./') || specifier.startsWith('../'))
        out.add(specifier)
    }
  return [...out]
}
