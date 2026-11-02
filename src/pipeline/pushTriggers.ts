// Which branches a Masonfile's push triggers build, as the master decides a
// push before any node runs setup: from a graph a setup recorded, or from
// the Masonfile's source when its triggers are written out literally. Pure,
// so the master and its tests share it.

import { stripTypeScriptTypes } from 'node:module'
import { parse, type Node } from 'acorn'
import type { Trigger } from '../../types/mason/index.js'
import { matches } from '../master/rules.js'
import type { Graph } from './graph.js'

/**
 * Each workflow with a push trigger, and the branch globs it builds; `true`
 * is every branch whose master rule is automatic. A workflow with no push
 * trigger is not listed.
 */
export type PushBranches = Record<string, true | string[]>

/** Whether one push trigger builds a branch; the master's rule is checked first. */
export function pushAllows(trigger: Trigger, branch: string): boolean {
  if (!('push' in trigger)) return false
  const branches = (trigger as { branches?: string[] }).branches
  return branches == null || branches.some((glob) => matches(glob, branch))
}

/** Whether a push to the branch starts any workflow. */
export function pushBuilds(push: PushBranches, branch: string): boolean {
  return Object.values(push).some(
    (branches) =>
      branches === true || branches.some((glob) => matches(glob, branch)),
  )
}

/** The push triggers of a recorded graph. */
export function graphPushBranches(graph: Graph): PushBranches {
  const out: PushBranches = {}
  for (const workflow of graph.workflows) {
    const entry = merge(
      workflow.triggers
        .filter((trigger) => 'push' in trigger)
        .map(
          (trigger) => (trigger as { branches?: string[] }).branches ?? true,
        ),
    )
    if (entry != null) out[workflow.name] = entry
  }
  return out
}

/** Whether a recorded graph's `build` workflow runs when a device is registered. */
export function buildsForDevice(graph: Pick<Graph, 'workflows'>): boolean {
  return (
    graph.workflows
      .find((workflow) => workflow.name === 'build')
      ?.triggers.some((trigger) => 'deviceRegistered' in trigger) ?? false
  )
}

/** Several push triggers of one workflow as one entry: any of them builds. */
function merge(entries: Array<true | string[]>): true | string[] | undefined {
  if (entries.length === 0) return undefined
  if (entries.includes(true)) return true
  return [...new Set(entries.flat() as string[])]
}

// ── The source read ─────────────────────────────────────────────────────

type Any = Node & Record<string, unknown>

/** What declares a stage of `build` when called on `m`. */
const stageMethods = ['stage', 'parallel', 'matrix', 'approval', 'post']

let warned = false
/** Node's own type stripping, which runs the Masonfile itself, without its experimental-feature warning. */
function strip(source: string): string {
  if (warned) return stripTypeScriptTypes(source)
  const emit = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('stripTypeScriptTypes')) return
    ;(emit as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return stripTypeScriptTypes(source)
  } finally {
    process.emitWarning = emit
    warned = true
  }
}

/** The largest Masonfile, or file it imports, the master reads; a larger one is left to setup. */
export const MAX_SOURCE_BYTES = 256 * 1024
/** The deepest nesting of brackets the master parses; deeper code is left to setup. */
const MAX_DEPTH = 200

/** Whether brackets nest deeper than the parsers should be asked to follow. */
function tooDeep(source: string): boolean {
  let depth = 0
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i)
    // ( [ {
    if (code === 40 || code === 91 || code === 123) {
      if (++depth > MAX_DEPTH) return true
    } else if ((code === 41 || code === 93 || code === 125) && depth > 0)
      depth--
  }
  return false
}

/**
 * A module's syntax tree, its types stripped; undefined for one too large
 * or too deeply nested to parse, or not valid. Node's type stripping can
 * throw, and some inputs leave it failing for the rest of the thread, so
 * the master calls this only in a worker it replaces after any error.
 */
function parseModule(source: string): Any | undefined {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES || tooDeep(source))
    return undefined
  const stripped = strip(source)
  try {
    return parse(stripped, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    }) as unknown as Any
  } catch {
    return undefined
  }
}

/** Names that reach the rest of the process, files or the network: setup's triggers could depend on them. */
const ambient = [
  'process',
  'require',
  'globalThis',
  'global',
  'fetch',
  'eval',
  'Function',
  'WebSocket',
  'Worker',
]

/**
 * Each name the module refers to, with its identifiers: every identifier
 * but a member's or a property's plain name, and an export's alias.
 */
/** Whether an identifier refers to a binding: not a member's, a key's or a label's plain name. */
function isReference(node: Any, parent: Any | undefined): boolean {
  return !(
    parent != null &&
    parent.computed !== true &&
    (((parent.type === 'MemberExpression' ||
      parent.type === 'MethodDefinition' ||
      parent.type === 'PropertyDefinition') &&
      parent.property === node) ||
      ((parent.type === 'MethodDefinition' ||
        parent.type === 'PropertyDefinition') &&
        parent.key === node) ||
      (parent.type === 'Property' &&
        parent.key === node &&
        parent.shorthand !== true) ||
      ((parent.type === 'LabeledStatement' ||
        parent.type === 'BreakStatement' ||
        parent.type === 'ContinueStatement') &&
        parent.label === node))
  )
}

function references(code: Any[]): Map<string, Any[]> {
  const out = new Map<string, Any[]>()
  for (const root of code)
    walk(root, (node, parent) => {
      let name: string | undefined
      if (node.type === 'Identifier') {
        if (isReference(node, parent)) name = String(node.name)
      } else if (
        node.type === 'Literal' &&
        parent?.type === 'ExportSpecifier' &&
        typeof node.value === 'string'
      )
        name = node.value
      if (name == null) return
      const list = out.get(name)
      if (list == null) out.set(name, [node])
      else list.push(node)
    })
  return out
}

/**
 * The code that can run while the module loads or setup runs: every
 * top-level statement but a function declaration, `setup` with everything
 * defined in it, and, transitively, each top-level function that code
 * names other than as a property's value in an object literal (`run:
 * buildIos` declares a stage; a call, an argument, an assignment, a
 * return or a list element may run it).
 */
function evaluatedCode(program: Any, setup: Any): Any[] {
  const functions = new Map<string, Any>()
  const out: Any[] = []
  for (const statement of program.body as Any[]) {
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? (statement.declaration as Any | null)
        : statement
    if (declaration?.type === 'FunctionDeclaration' && declaration !== setup)
      functions.set(String((declaration.id as Any).name), declaration)
    else out.push(declaration === setup ? setup : statement)
  }
  const reached = new Set<string>()
  for (let index = 0; index < out.length; index++)
    walk(out[index]!, (node, parent) => {
      if (
        node.type !== 'Identifier' ||
        !isReference(node, parent) ||
        (parent?.type === 'Property' && parent.value === node)
      )
        return
      const name = String(node.name)
      const declaration = functions.get(name)
      if (declaration == null || reached.has(name) || declaration.id === node)
        return
      reached.add(name)
      out.push(declaration)
    })
  return out
}

/** A member's name: its plain or literal key; undefined when computed from anything else. */
function memberName(node: Any): string | undefined {
  const property = node.property as Any
  if (node.computed !== true) return String(property.name)
  return property.type === 'Literal' ? String(property.value) : undefined
}

/** Members that lead to a prototype or a constructor, and from there to code or built-ins. */
const reflective = [
  'constructor',
  'prototype',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
]

/** Adds the names a declaration's binding pattern binds. */
function bindingNames(pattern: Any | null | undefined, out: Set<string>): void {
  if (pattern == null) return
  if (pattern.type === 'Identifier') out.add(String(pattern.name))
  else if (pattern.type === 'ObjectPattern')
    for (const property of pattern.properties as Any[])
      bindingNames(
        (property.type === 'RestElement'
          ? property.argument
          : property.value) as Any,
        out,
      )
  else if (pattern.type === 'ArrayPattern')
    for (const element of pattern.elements as Array<Any | null>)
      bindingNames(element, out)
  else if (pattern.type === 'RestElement')
    bindingNames(pattern.argument as Any, out)
  else if (pattern.type === 'AssignmentPattern')
    bindingNames(pattern.left as Any, out)
}

/** Every name the module declares, in any scope. */
function declaredNames(program: Any): Set<string> {
  const out = new Set<string>()
  walk(program, (node) => {
    if (node.type === 'VariableDeclarator') bindingNames(node.id as Any, out)
    else if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      bindingNames(node.id as Any | null, out)
      for (const param of node.params as Any[]) bindingNames(param, out)
    } else if (
      node.type === 'ClassDeclaration' ||
      node.type === 'ClassExpression'
    )
      bindingNames(node.id as Any | null, out)
    else if (node.type === 'CatchClause') bindingNames(node.param as Any, out)
    else if (
      node.type === 'ImportSpecifier' ||
      node.type === 'ImportDefaultSpecifier' ||
      node.type === 'ImportNamespaceSpecifier'
    )
      bindingNames(node.local as Any, out)
  })
  return out
}

/**
 * Whether module code could change what the Recorder runs on (`Object.hasOwn`,
 * `JSON.stringify`, `Map.prototype.set`…), so its source says less than
 * setup would record: it writes to any member or to a name it does not
 * declare, deletes, or reaches `Object`, `Reflect`, `Proxy` or a
 * prototype or constructor. Writing to members of its own objects counts
 * too, since a local name may hold a built-in.
 */
function patches(
  code: Any[],
  names: Map<string, Any[]>,
  declared: Set<string>,
): boolean {
  if (['Object', 'Reflect', 'Proxy'].some((name) => names.has(name)))
    return true
  let found = false
  const target = (node: Any | null | undefined): void => {
    if (node == null) return
    if (node.type === 'Identifier') {
      if (!declared.has(String(node.name))) found = true
    } else if (node.type === 'MemberExpression') found = true
    else if (node.type === 'ObjectPattern')
      for (const property of node.properties as Any[])
        target(
          (property.type === 'RestElement'
            ? property.argument
            : property.value) as Any,
        )
    else if (node.type === 'ArrayPattern')
      for (const element of node.elements as Array<Any | null>) target(element)
    else if (node.type === 'RestElement') target(node.argument as Any)
    else if (node.type === 'AssignmentPattern') target(node.left as Any)
  }
  for (const root of code)
    walk(root, (node) => {
      if (node.type === 'AssignmentExpression') target(node.left as Any)
      else if (node.type === 'UpdateExpression') target(node.argument as Any)
      else if (
        (node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
        (node.left as Any).type !== 'VariableDeclaration'
      )
        target(node.left as Any)
      else if (node.type === 'UnaryExpression' && node.operator === 'delete')
        found = true
      else if (node.type === 'MemberExpression') {
        const name = memberName(node)
        if (name != null && reflective.includes(name)) found = true
      }
    })
  return found
}

/** What the master reads of one file without running it: its push triggers and the modules it loads, each undefined when that cannot be known. */
export interface SourceFacts {
  push?: PushBranches
  specifiers?: string[]
}

/**
 * Reads a Masonfile, or a file it imports, from its source. Throws when
 * Node's type stripping does; see {@link parseModule}.
 */
export function readSource(source: string): SourceFacts {
  const program = parseModule(source)
  if (program == null) return {}
  const names = references([program])
  const push = pushOf(program, names)
  const specifiers = specifiersOf(program, names)
  return {
    ...(push == null ? {} : { push }),
    ...(specifiers == null ? {} : { specifiers }),
  }
}

/**
 * Every module a file loads at run time, from its syntax tree: its
 * imports and re-exports. Undefined when the file cannot be parsed, or
 * could load or read anything else: a dynamic `import()`, or any use of
 * `process`, `require`, `globalThis`, `fetch`, `eval` or the like.
 */
export function moduleSpecifiers(source: string): string[] | undefined {
  try {
    return readSource(source).specifiers
  } catch {
    return undefined
  }
}

function specifiersOf(
  program: Any,
  names: Map<string, Any[]>,
): string[] | undefined {
  if (ambient.some((name) => names.has(name))) return undefined
  const out = new Set<string>()
  let known = true
  walk(program, (node) => {
    // `(() => {}).constructor('return process')()` reaches the process
    // without naming it, as may a computed member or `import.meta`.
    if (node.type === 'MetaProperty') known = false
    else if (node.type === 'MemberExpression') {
      const name = memberName(node)
      if (name == null || reflective.includes(name)) known = false
    }
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      (node.type === 'ExportNamedDeclaration' && node.source != null)
    ) {
      const source = node.source as Any
      if (typeof source.value === 'string') out.add(source.value)
      else known = false
    } else if (node.type === 'ImportExpression') known = false
  })
  return known ? [...out] : undefined
}

/** Every node under `node`, each with its parent. */
function walk(
  node: Any,
  visit: (node: Any, parent: Any | undefined) => void,
  parent?: Any,
): void {
  visit(node, parent)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || value == null || typeof value !== 'object') continue
    for (const child of Array.isArray(value) ? value : [value])
      if (child != null && typeof (child as Any).type === 'string')
        walk(child as Any, visit, node)
  }
}

/**
 * The function an `export function setup(m)` or `export const setup = (m)
 * => …` declares, with the identifier it binds.
 */
function setupFunction(program: Any): { fn: Any; binding: Any } | undefined {
  for (const statement of program.body as Any[]) {
    if (statement.type !== 'ExportNamedDeclaration') continue
    const declaration = statement.declaration as Any | null
    if (
      declaration?.type === 'FunctionDeclaration' &&
      (declaration.id as Any).name === 'setup'
    )
      return { fn: declaration, binding: declaration.id as Any }
    if (declaration?.type === 'VariableDeclaration')
      for (const declarator of declaration.declarations as Any[]) {
        const init = declarator.init as Any | null
        if (
          (declarator.id as Any).name === 'setup' &&
          (init?.type === 'ArrowFunctionExpression' ||
            init?.type === 'FunctionExpression')
        )
          return { fn: init, binding: declarator.id as Any }
      }
  }
  return undefined
}

/** A property's name when it is a plain key; undefined for a computed one or a spread. */
function key(property: Any): string | undefined {
  if (property.type !== 'Property' || property.computed === true)
    return undefined
  const name = property.key as Any
  return name.type === 'Identifier'
    ? String(name.name)
    : typeof name.value === 'string'
      ? name.value
      : undefined
}

/** An object literal's properties by name, or undefined unless every one is plain. */
function properties(node: Any): Map<string, Any> | undefined {
  if (node.type !== 'ObjectExpression') return undefined
  const out = new Map<string, Any>()
  for (const property of node.properties as Any[]) {
    const name = key(property)
    // A prototype or an accessor is not what the Recorder reads as written.
    if (
      name == null ||
      name === '__proto__' ||
      property.kind !== 'init' ||
      property.method === true
    )
      return undefined
    out.set(name, property.value as Any)
  }
  return out
}

/** A list literal of string literals. */
function literalStrings(node: Any): string[] | undefined {
  if (node.type !== 'ArrayExpression') return undefined
  const out: string[] = []
  for (const element of node.elements as Array<Any | null>) {
    if (element?.type !== 'Literal' || typeof element.value !== 'string')
      return undefined
    out.push(element.value)
  }
  return out
}

/**
 * The push branches of one `triggers` list; `null` when it has none, and
 * undefined when the list is not written out literally.
 */
function literalTriggers(node: Any): true | string[] | null | undefined {
  if (node.type !== 'ArrayExpression') return undefined
  const entries: Array<true | string[]> = []
  for (const element of node.elements as Array<Any | null>) {
    const fields = element == null ? undefined : properties(element)
    if (fields == null) return undefined
    const push = fields.get('push')
    if (push == null) continue
    if (push.type !== 'Literal' || push.value !== true) return undefined
    const branches = fields.get('branches')
    if (branches == null) entries.push(true)
    else {
      const list = literalStrings(branches)
      if (list == null) return undefined
      entries.push(list)
    }
  }
  return merge(entries) ?? null
}

/**
 * The push triggers a Masonfile declares, read from its source without
 * running it or anything it imports. Undefined unless the answer cannot
 * depend on the branch or on other code: `setup`'s parameter is only ever
 * used as `m.<name>`, and every `m.workflow` is a statement of `setup`'s own
 * body with a literal name and literal triggers. Stages declared on `m`
 * make a `build` with its default push trigger when no `m.workflow('build',
 * …)` names it.
 */
export function sourcePushBranches(source: string): PushBranches | undefined {
  try {
    return readSource(source).push
  } catch {
    return undefined
  }
}

function pushOf(
  program: Any,
  names: Map<string, Any[]>,
): PushBranches | undefined {
  const found = setupFunction(program)
  // Code that reaches `m` without naming it defeats the read, and so does
  // any other mention of `setup`: a declaration, assignment, loop head or
  // export alias may rebind what Node calls.
  if (
    found == null ||
    (names.get('setup') ?? []).some((node) => node !== found.binding)
  )
    return undefined
  // Only code that can run before setup returns could reach `m` or change
  // what the Recorder runs on; stage functions never run during setup.
  const code = evaluatedCode(program, found.fn)
  const used = references(code)
  if (
    ['arguments', 'eval', 'Function', 'globalThis'].some((name) =>
      used.has(name),
    ) ||
    patches(code, used, declaredNames(program))
  )
    return undefined
  const setup = found.fn
  const params = (setup.params as Any[] | undefined) ?? []
  const param = params[0]
  if (params.length !== 1 || param?.type !== 'Identifier') return undefined
  const m = String(param.name)
  const body = setup.body as Any
  if (body.type !== 'BlockStatement') return undefined
  const top = new Set(body.body as Any[])
  const declared: Array<{ call: Any; statement: Any | undefined }> = []
  let readable = true
  let stages = false
  const parents = new Map<Any, Any | undefined>()
  walk(body, (node, parent) => {
    parents.set(node, parent)
    if (node.type !== 'Identifier' || node.name !== m) return
    // `m` itself never leaves setup: a helper given it could declare anything.
    if (
      parent?.type !== 'MemberExpression' ||
      parent.object !== node ||
      parent.computed === true
    ) {
      readable = false
      return
    }
    const member = String((parent.property as Any).name)
    if (stageMethods.includes(member)) stages = true
    if (member !== 'workflow') return
    const call = parents.get(parent)
    if (call?.type !== 'CallExpression' || call.callee !== parent) {
      readable = false
      return
    }
    const statement = parents.get(call)
    declared.push({
      call,
      statement:
        statement?.type === 'ExpressionStatement' ? statement : undefined,
    })
  })
  if (!readable) return undefined
  const out: PushBranches = {}
  const seen = new Set<string>()
  for (const { call, statement } of declared) {
    const [name, options] = call.arguments as Any[]
    if (
      statement == null ||
      !top.has(statement) ||
      name?.type !== 'Literal' ||
      typeof name.value !== 'string' ||
      seen.has(name.value) ||
      options == null
    )
      return undefined
    seen.add(name.value)
    const fields = properties(options)
    if (fields == null) return undefined
    const triggers = fields.get('triggers')
    const push =
      triggers == null
        ? name.value === 'build'
          ? true
          : null
        : literalTriggers(triggers)
    if (push === undefined) return undefined
    if (push != null) out[name.value] = push
  }
  // Stages declared on `m` belong to `build`, and an empty `build` is none.
  if (!seen.has('build') && stages) out.build = true
  return out
}
