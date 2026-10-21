import { XMLParser, XMLValidator } from 'fast-xml-parser'

export interface TestSummary {
  passed: number
  /** Failures plus errors. */
  failed: number
  skipped: number
  failures: Array<{ name: string; message: string }>
}

export class TestParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TestParseError'
  }
}

export type TestFormat = 'junit' | 'xunit' | 'tap'

const MAX_INPUT_BYTES = 50 * 1024 * 1024
const MAX_MESSAGE = 2000
const SEPARATOR = ' › '

interface XmlElement {
  tag: string
  attributes: Map<string, string>
  children: XmlElement[]
  text: string
}

/** Returns a summary with nothing counted. */
export function emptySummary(): TestSummary {
  return { passed: 0, failed: 0, skipped: 0, failures: [] }
}

function boundedInput(label: string, input: string): string {
  // A UTF-8 string is never shorter in bytes than in UTF-16 code units.
  if (
    input.length > MAX_INPUT_BYTES ||
    Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES
  )
    throw new TestParseError(`${label}: input exceeds 50 MB`)
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
}

function clip(message: string): string {
  const trimmed = message.trim()
  return trimmed.length > MAX_MESSAGE ? trimmed.slice(0, MAX_MESSAGE) : trimmed
}

function parseXml(label: string, xml: string): XmlElement[] {
  const input = boundedInput(label, xml)
  // Entity declarations are the classic expansion attack; reports never need them.
  if (/<!ENTITY/i.test(input))
    throw new TestParseError(`${label}: entity declarations are not allowed`)
  const valid = XMLValidator.validate(input)
  if (valid !== true) {
    const { msg, line, col } = valid.err
    throw new TestParseError(
      `${label}: invalid XML at line ${line}, column ${col}: ${msg}`,
    )
  }
  let parsed: unknown
  try {
    // preserveOrder keeps testcases and nested suites in document order, so
    // failures are reported in the order the report lists them.
    parsed = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
      // Decodes numeric character references such as &#10; in stack traces.
      htmlEntities: true,
    }).parse(input)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TestParseError(`${label}: invalid XML: ${reason}`)
  }
  return elements(parsed)
}

/** Converts fast-xml-parser's ordered output into a plain element tree. */
function elements(nodes: unknown): XmlElement[] {
  const out: XmlElement[] = []
  if (!Array.isArray(nodes)) return out
  for (const node of nodes) {
    if (node == null || typeof node !== 'object') continue
    const record = node as Record<string, unknown>
    const tag = Object.keys(record).find(
      (key: string): boolean => key !== ':@' && key !== '#text',
    )
    if (tag == null) continue
    const attributes = new Map<string, string>()
    const raw = record[':@']
    if (raw != null && typeof raw === 'object')
      for (const [key, value] of Object.entries(raw))
        if (typeof value === 'string') attributes.set(key, value)
    const content = record[tag]
    let text = ''
    if (Array.isArray(content))
      for (const child of content)
        if (child != null && typeof child === 'object') {
          const value: unknown = (child as Record<string, unknown>)['#text']
          if (typeof value === 'string') text += value
        }
    out.push({ tag, attributes, children: elements(content), text })
  }
  return out
}

function childrenOf(element: XmlElement, tag: string): XmlElement[] {
  return element.children.filter(
    (child: XmlElement): boolean => child.tag === tag,
  )
}

function rootOf(label: string, doc: XmlElement[], tags: string[]): XmlElement {
  const root = doc.find((element: XmlElement): boolean =>
    tags.includes(element.tag),
  )
  if (root == null)
    throw new TestParseError(
      `${label}: expected a <${tags.join('> or <')}> root element`,
    )
  return root
}

/** Parses a JUnit XML report, counting from its testcases. */
export function parseJUnit(xml: string): TestSummary {
  const root = rootOf('JUnit', parseXml('JUnit', xml), [
    'testsuites',
    'testsuite',
  ])
  const summary = emptySummary()
  walkSuite(
    root,
    root.tag === 'testsuite' ? root.attributes.get('name') : undefined,
  )
  return summary

  function walkSuite(suite: XmlElement, suiteName: string | undefined): void {
    for (const child of suite.children) {
      if (child.tag === 'testsuite')
        walkSuite(child, child.attributes.get('name') ?? suiteName)
      else if (child.tag === 'testcase') countCase(child, suiteName)
    }
  }

  function countCase(
    testcase: XmlElement,
    suiteName: string | undefined,
  ): void {
    const failure = testcase.children.find(
      (child: XmlElement): boolean =>
        child.tag === 'failure' || child.tag === 'error',
    )
    if (failure != null) {
      const name = testcase.attributes.get('name') ?? '(unnamed)'
      const owner = testcase.attributes.get('classname') || suiteName
      summary.failed++
      summary.failures.push({
        name: owner ? `${owner}${SEPARATOR}${name}` : name,
        message: clip(failure.attributes.get('message') || failure.text),
      })
    } else if (childrenOf(testcase, 'skipped').length > 0) summary.skipped++
    else summary.passed++
  }
}

/** Parses an xUnit.net v2 XML report. */
export function parseXUnit(xml: string): TestSummary {
  const root = rootOf('xUnit', parseXml('xUnit', xml), [
    'assemblies',
    'assembly',
  ])
  const assemblies =
    root.tag === 'assembly' ? [root] : childrenOf(root, 'assembly')
  const summary = emptySummary()
  for (const assembly of assemblies) {
    for (const collection of childrenOf(assembly, 'collection')) {
      for (const test of childrenOf(collection, 'test')) {
        const result = (test.attributes.get('result') ?? '').toLowerCase()
        if (result === 'pass') summary.passed++
        else if (result === 'fail') {
          summary.failed++
          summary.failures.push({
            name: test.attributes.get('name') ?? '(unnamed)',
            message: xunitMessage(test),
          })
        } else summary.skipped++
      }
    }
    // Fixture and cleanup failures fail the run without failing any one test.
    for (const errors of childrenOf(assembly, 'errors')) {
      for (const error of childrenOf(errors, 'error')) {
        summary.failed++
        summary.failures.push({
          name:
            error.attributes.get('name') ??
            error.attributes.get('type') ??
            '(error)',
          message: xunitMessage(error),
        })
      }
    }
  }
  return summary
}

function xunitMessage(element: XmlElement): string {
  const [failure] = childrenOf(element, 'failure')
  if (failure == null) return ''
  const [message] = childrenOf(failure, 'message')
  return clip(
    message?.text.trim() ||
      failure.text.trim() ||
      failure.attributes.get('exception-type') ||
      '',
  )
}

const TEST_LINE = /^(not )?ok\b(.*)$/
const PLAN_LINE = /^1\.\.(\d+)\b/
const BAIL_LINE = /^\s*Bail out!\s*(.*)$/
const DIRECTIVE = /^(skip|todo)\S*/i

/** Parses TAP output; lines that match nothing are ignored. */
export function parseTap(text: string): TestSummary {
  const lines = boundedInput('TAP', text).split(/\r?\n/)
  const summary = emptySummary()
  let planned: number | undefined
  let ran = 0
  let bailed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const bail = BAIL_LINE.exec(line)
    if (bail != null) {
      summary.failed++
      summary.failures.push({ name: 'Bail out!', message: clip(bail[1]!) })
      bailed = true
      break
    }
    const plan = PLAN_LINE.exec(line)
    if (plan != null) {
      planned = Number(plan[1])
      continue
    }
    const test = TEST_LINE.exec(line)
    if (test == null) continue
    ran++
    const { number, description, directive } = splitTestLine(test[2]!)
    const yaml = readYaml(lines, i + 1)
    i = yaml.end - 1
    if (directive != null) summary.skipped++
    else if (test[1] == null) summary.passed++
    else {
      summary.failed++
      summary.failures.push({
        name: description || `test ${number ?? ran}`,
        message: clip(yaml.message),
      })
    }
  }
  if (!bailed && planned != null && planned !== ran) {
    summary.failed++
    summary.failures.push({
      name: 'plan',
      message: `Planned ${planned} tests, ran ${ran}`,
    })
  }
  return summary
}

function splitTestLine(rest: string): {
  number: string | undefined
  description: string
  directive: string | undefined
} {
  const match = /^\s*(\d+)?\s*(?:-(?:\s|$))?\s*(.*)$/.exec(rest)!
  let description = match[2]!
  let directive: string | undefined
  // The first unescaped '#' starts a comment, which may hold a directive.
  const hash = /(?:^|[^\\])(#)/.exec(description)
  if (hash != null) {
    const at = hash.index + hash[0].length - 1
    const kind = DIRECTIVE.exec(description.slice(at + 1).trim())
    if (kind != null) directive = kind[1]!.toUpperCase()
    description = description.slice(0, at)
  }
  return {
    number: match[1],
    description: description.replace(/\\#/g, '#').trim(),
    directive,
  }
}

/** Reads an indented `---` … `...` block starting at `start`, if one is there. */
function readYaml(
  lines: string[],
  start: number,
): { end: number; message: string } {
  const open = /^(\s+)---\s*$/.exec(lines[start] ?? '')
  if (open == null) return { end: start, message: '' }
  const indent = open[1]!.length
  const body: string[] = []
  let end = start + 1
  for (; end < lines.length; end++) {
    const line = lines[end]!
    if (/^\s+\.\.\.\s*$/.test(line)) {
      end++
      break
    }
    // An unterminated block ends at the next unindented line.
    if (line.trim() !== '' && !/^\s/.test(line)) break
    body.push(line.slice(Math.min(indent, line.search(/\S|$/))))
  }
  return { end, message: yamlMessage(body) ?? body.join('\n').trim() }
}

function yamlMessage(body: string[]): string | undefined {
  const index = body.findIndex((line: string): boolean =>
    /^message:/.test(line),
  )
  if (index < 0) return undefined
  const value = body[index]!.slice('message:'.length).trim()
  if (/^[|>][-+]?$/.test(value)) {
    const block: string[] = []
    for (const line of body.slice(index + 1)) {
      if (line.trim() !== '' && !/^\s/.test(line)) break
      block.push(line.trim())
    }
    return block.join(value.startsWith('>') ? ' ' : '\n')
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
    try {
      const decoded: unknown = JSON.parse(value)
      if (typeof decoded === 'string') return decoded
    } catch {
      // YAML escapes are a superset of JSON's; fall back to the raw text.
    }
    return value.slice(1, -1)
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    return value.slice(1, -1).replace(/''/g, "'")
  return value
}

/** Parses each report in `texts` and sums the results in order. */
export function parseTests(format: TestFormat, texts: string[]): TestSummary {
  const parse =
    format === 'junit'
      ? parseJUnit
      : format === 'xunit'
        ? parseXUnit
        : format === 'tap'
          ? parseTap
          : undefined
  if (parse == null)
    throw new TestParseError(`Unknown test format: ${String(format)}`)
  const total = emptySummary()
  for (const text of texts) {
    const summary = parse(text)
    total.passed += summary.passed
    total.failed += summary.failed
    total.skipped += summary.skipped
    total.failures.push(...summary.failures)
  }
  return total
}
