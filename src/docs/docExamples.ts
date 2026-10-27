import path from 'node:path'
import ts from 'typescript'

export interface CodeBlock {
  /** 1-based line of the first line of code inside the fence. */
  line: number
  source: string
}
export interface ExampleError {
  /** 1-based line in the Markdown document. */
  line: number
  message: string
}

/**
 * Fenced `ts` blocks of a Markdown document. A block whose info string also
 * says `fragment` is an excerpt that does not compile alone and is skipped,
 * as are other languages and indented code.
 */
export function codeBlocks(markdown: string): CodeBlock[] {
  const lines = markdown.split('\n')
  const blocks: CodeBlock[] = []
  let open: { fence: string; info: string[]; start: number } | undefined
  let body: string[] = []
  for (const [index, line] of lines.entries()) {
    if (open == null) {
      const match = /^(`{3,}|~{3,})\s*(.*)$/.exec(line)
      if (match != null) {
        open = {
          fence: match[1]!,
          info: match[2]!.trim().split(/\s+/),
          start: index + 2,
        }
        body = []
      }
      continue
    }
    if (
      line.startsWith(open.fence) &&
      line.slice(open.fence.length).trim() === ''
    ) {
      if (
        ['ts', 'typescript'].includes(open.info[0] ?? '') &&
        !open.info.includes('fragment')
      )
        blocks.push({ line: open.start, source: body.join('\n') + '\n' })
      open = undefined
      continue
    }
    body.push(line)
  }
  if (open != null)
    throw new Error(`Unclosed code fence at line ${open.start - 1}`)
  return blocks
}

/**
 * Typechecks every complete `ts` block as its own module against the Mason
 * type declarations, mapping each diagnostic back to its Markdown line. The
 * blocks are compiled in memory; nothing is written to disk.
 */
export function checkExamples(markdown: string, types: string): ExampleError[] {
  const blocks = codeBlocks(markdown)
  if (blocks.length === 0) return []
  const root = path.resolve('.mason-doc-examples')
  const files = new Map(
    blocks.map((block, index) => [
      path.join(root, `block-${index}.mts`),
      block,
    ]),
  )
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    verbatimModuleSyntax: true,
    types: [],
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
    paths: { '@mason/types': [path.resolve(types)] },
  }
  const host = ts.createCompilerHost(options)
  const fileExists = host.fileExists.bind(host)
  const readFile = host.readFile.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.fileExists = (file): boolean => files.has(file) || fileExists(file)
  host.readFile = (file): string | undefined =>
    files.get(file)?.source ?? readFile(file)
  host.getSourceFile = (
    file,
    language,
    onError,
    create,
  ): ts.SourceFile | undefined => {
    const block = files.get(file)
    return block == null
      ? getSourceFile(file, language, onError, create)
      : ts.createSourceFile(file, block.source, language)
  }
  const program = ts.createProgram([...files.keys()], options, host)
  const errors: ExampleError[] = []
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      '\n',
    )
    const block =
      diagnostic.file == null ? undefined : files.get(diagnostic.file.fileName)
    if (block == null || diagnostic.start == null) {
      errors.push({ line: 0, message })
      continue
    }
    const { line } = diagnostic.file!.getLineAndCharacterOfPosition(
      diagnostic.start,
    )
    errors.push({ line: block.line + line, message })
  }
  return errors.sort((a, b) => a.line - b.line)
}
