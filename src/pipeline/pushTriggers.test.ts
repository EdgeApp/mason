import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import type { Setup } from '../../types/mason/index.js'
import { GraphError, Recorder, type Graph } from './graph.js'
import {
  graphPushBranches,
  MAX_SOURCE_BYTES,
  moduleSpecifiers,
  pushAllows,
  pushBuilds,
  sourcePushBranches,
} from './pushTriggers.js'

async function one(): Promise<void> {}

function record(setup: (m: Setup) => void): Graph {
  const recorder = new Recorder(
    {
      workflow: 'build',
      branch: 'master',
      commit: 'a'.repeat(40),
      trigger: 'push',
      params: {},
    },
    { setup, one },
  )
  setup(recorder.setup())
  return recorder.graph()
}

const masonfile = (body: string, before = ''): string => `
import type { Setup, Stage } from '@mason/types'
${before}
export function setup(m: Setup) {
  m.apiVersion(1)
${body}
}
export async function one(ctx: Stage) {}
`

describe('Push triggers', () => {
  it('M1 reads literal push branches from the source, typed or not, with build’s default when nothing names it', () => {
    assert.deepEqual(
      sourcePushBranches(
        masonfile(`  m.stage('one', { on: 'linux', run: one })`),
      ),
      { build: true },
    )
    assert.deepEqual(
      sourcePushBranches(
        masonfile(`
  const flavour: string = 'x'
  m.workflow('build', {
    triggers: [{ push: true, branches: ['master', 'develop', "release/**"] } as const, { request: true }],
  } satisfies object, (w) => { w.stage('one', { on: 'linux', run: one }) })
  m.workflow('nightly', { triggers: [{ schedule: '0 3 * * *', branches: ['master'] }] }, (w) => {})
  m.workflow('docs', { 'triggers': [{ push: true }, { push: true, branches: ['x'] }] }, (w) => {})
  m.workflow('lint', { triggers: [{ push: true, branches: ['a'] }, { push: true, branches: ['a', 'b'] }] }, (w) => {})
  if (m.branch === flavour) m.stage('one', { on: 'linux', run: one })`),
      ),
      {
        build: ['master', 'develop', 'release/**'],
        docs: true,
        lint: ['a', 'b'],
      },
    )
    // A build with no push trigger builds no push.
    assert.deepEqual(
      sourcePushBranches(
        masonfile(
          `  m.workflow('build', { triggers: [{ request: true }] }, () => {})`,
        ),
      ),
      {},
    )
    assert.deepEqual(
      sourcePushBranches(
        `export const setup = (m) => { m.workflow('build', { triggers: [{ push: true, branches: [] }] }, () => {}) }`,
      ),
      { build: [] },
    )
    assert.deepEqual(
      sourcePushBranches(
        `export const setup = function (m) { m.workflow('build', {}, () => {}) }`,
      ),
      { build: true },
    )
    // With no stage on `m` and no `m.workflow('build', …)` there is no build.
    assert.deepEqual(
      sourcePushBranches(
        masonfile(
          `  m.workflow('nightly', { triggers: [{ schedule: '0 3 * * *' }] }, (w) => {})`,
        ),
      ),
      {},
    )
    assert.deepEqual(
      sourcePushBranches(
        masonfile(`  m.post({ always: { on: 'linux', run: one } })`),
      ),
      { build: true },
    )
  })

  it('M1 leaves a Masonfile to setup when its push branches could depend on code', () => {
    const unreadable = [
      // Computed lists and triggers.
      masonfile(
        `  m.workflow('build', { triggers: [{ push: true, branches: BRANCHES }] }, () => {})`,
        `const BRANCHES = ['master']`,
      ),
      masonfile(
        `  m.workflow('build', { triggers: [{ push: true, branches: [...more] }] }, () => {})`,
        `const more = ['x']`,
      ),
      masonfile(
        `  m.workflow('build', { triggers: [{ push: true, branches: [\`x\`] }] }, () => {})`,
      ),
      masonfile(
        `  m.workflow('build', { triggers: [PUSH] }, () => {})`,
        `const PUSH = { push: true }`,
      ),
      masonfile(
        `  m.workflow('build', { triggers: TRIGGERS }, () => {})`,
        `const TRIGGERS = []`,
      ),
      masonfile(
        `  m.workflow('build', { triggers: [{ ...base }] }, () => {})`,
        `const base = {}`,
      ),
      masonfile(
        `  m.workflow('build', { triggers: [{ push: m.branch === 'x' }] }, () => {})`,
      ),
      masonfile(
        `  m.workflow('build', { triggers: [{ [key]: true }] }, () => {})`,
        `const key = 'push'`,
      ),
      masonfile(
        `  m.workflow('build', { triggers: [, { push: true }] }, () => {})`,
      ),
      masonfile(
        `  m.workflow('build', options, () => {})`,
        `const options = {}`,
      ),
      masonfile(
        `  m.workflow('build', { ...options }, () => {})`,
        `const options = {}`,
      ),
      masonfile(`  m.workflow('build')`),
      // A name that is not a literal, or declared twice.
      masonfile(`  m.workflow(name, {}, () => {})`, `const name = 'build'`),
      masonfile(
        `  m.workflow('build', {}, () => {})\n  m.workflow('build', {}, () => {})`,
      ),
      // A workflow declared only on some branches, or by other code given m.
      masonfile(
        `  if (m.branch === 'x') m.workflow('build', { triggers: [{ push: true }] }, () => {})`,
      ),
      masonfile(`  for (const name of ['a']) m.workflow('a', {}, () => {})`),
      masonfile(`  declare(m)`, `import { declare } from './ci/workflows.ts'`),
      masonfile(`  const n = m\n  n.workflow('build', {}, () => {})`),
      masonfile(`  m['workflow']('build', {}, () => {})`),
      masonfile(`  const w = m.workflow\n  w('build', {}, () => {})`),
      masonfile(`  void m.workflow('build', {}, () => {})`),
      // Code that reaches m without naming it, or replaces setup.
      `export function setup(m) { arguments[0].workflow('build', { triggers: [{ push: true }] }, () => {}) }`,
      `export function setup(m, w = m.workflow('build', { triggers: [{ push: true }] }, () => {})) { m.workflow('build', { triggers: [{ push: true, branches: [] }] }, () => {}) }`,
      `export function setup(m) { eval("m.workflow('docs', { triggers: [{ push: true }] }, () => {})"); m.workflow('build', { triggers: [{ push: true, branches: [] }] }, () => {}) }`,
      `const make = Function('m', 'm.workflow("x", {}, () => {})')\nexport function setup(m) { m.workflow('build', { triggers: [{ push: true, branches: [] }] }, () => {}) }`,
      `export function setup(m) { m.workflow('build', { triggers: [{ push: true, branches: ['main'] }] }, () => {}) }\nsetup = (m) => { m.workflow('build', {}, () => {}) }`,
      `export let setup = (m) => { m.workflow('build', { triggers: [{ push: true, branches: ['main'] }] }, () => {}) }\n;[setup] = [(m) => {}]`,
      // Any other mention of setup may rebind what Node calls.
      ...[
        `for (setup of [B]);`,
        `for (setup in { x: 1 });`,
        `for ([setup] of [[B]]);`,
        `var setup = B`,
        `{ var setup = B }`,
        `if (true) { var setup = B }`,
        `function setup(m) {}`,
        `const x = B\nexport { x as setup }`,
        `const x = B\nexport { x as 'setup' }`,
        `;({ setup } = { setup: B })`,
        `import { setup as other } from './x.ts'`,
        `Reflect.set(globalThis, 'x', 1)`,
      ].map(
        (rest) =>
          `const B = (m) => { m.workflow('build', { triggers: [{ push: true }] }, () => {}) }\nexport var setup = (m) => { m.workflow('build', { triggers: [{ push: true, branches: ['main'] }] }, () => {}) }\n${rest}`,
      ),
      // Module code that could change the built-ins the Recorder runs on.
      ...[
        `Object.hasOwn = () => false`,
        `JSON.stringify = () => '{}'`,
        `const J = JSON\nJ.stringify = () => '{}'`,
        `Map.prototype.set = function () { return this }`,
        `const p = new Map()['__proto__']\np.set = null`,
        `Reflect.get = () => undefined`,
        `const o = Object\no.defineProperty(Array, 'isArray', {})`,
        `delete Array.isArray`,
        `Array.isArray++`,
        `leaked = 1`,
        `;[Array.isArray] = [() => false]`,
        `for (Array.isArray of [() => false]);`,
        `const P = Proxy`,
        `const f = (() => {}).constructor`,
      ].map(
        (rest) =>
          `export function setup(m) { m.workflow('build', { triggers: [{ push: true, branches: ['main'] }] }, () => {}) }\n${rest}`,
      ),
      // A prototype or an accessor is not what the Recorder reads.
      `export function setup(m) { m.workflow('nightly', { __proto__: { triggers: [{ push: true }] } }, () => {}) }`,
      `export function setup(m) { m.workflow('build', { triggers: [{ push: true, branches: ['main'], __proto__: { branches: [] } }] }, () => {}) }`,
      `export function setup(m) { m.workflow('build', { triggers: [{ push: true, branches: ['main'] }], get triggers() { return [{ push: true }] } }, () => {}) }`,
      `export function setup(m) { m.workflow('build', { triggers() { return [] } }, () => {}) }`,
      // Too large, or nested too deeply, to parse safely on the master.
      `// ${'x'.repeat(MAX_SOURCE_BYTES)}\nexport function setup(m) { m.workflow('build', {}, () => {}) }`,
      // No setup the reader can see, or not a Masonfile at all.
      `export { setup } from './setup.ts'`,
      `export function setup({ workflow }) { workflow('build', {}, () => {}) }`,
      `export function setup() {}`,
      `export const setup = (m) => m.workflow('build', {}, () => {})`,
      `export function setup(m) { enum E { A } }`,
      'this is not code (',
    ]
    for (const source of unreadable)
      assert.equal(sourcePushBranches(source), undefined, source)
    // A member or property named setup, and labels, are not the binding.
    assert.deepEqual(
      sourcePushBranches(
        `const o = { setup: 1, run() {} }\nlet n = o.setup\nn = 2\nexport function setup(m) { m.workflow('build', { triggers: [{ push: true, branches: ['b'] }] }, () => {}) }`,
      ),
      { build: ['b'] },
    )
    // Declared names may be written; members of plain lists may be read.
    assert.deepEqual(
      sourcePushBranches(
        `let count = 0\nfor (const x of [1]) count += x\nconst first = ['a'][0]\nexport function setup(m) { m.workflow('build', { triggers: [{ push: true, branches: ['b'] }] }, () => {}) }`,
      ),
      { build: ['b'] },
    )
    // Other exports and declarations around setup are fine.
    assert.deepEqual(
      sourcePushBranches(
        `export const name = 'x'\nexport let setup2 = 1\nexport function other() {}\nexport const setup = (m) => { m.workflow('build', { triggers: [{ push: true, branches: ['b'] }] }, () => {}) }`,
      ),
      { build: ['b'] },
    )
  })

  it('M1 checks only the code that runs while setup does: stage functions may do anything', () => {
    // Shaped like an app's Masonfile: a build number from m.branch, a
    // helper setup calls, and stage functions that patch, write and read
    // the environment, referenced only as run: values.
    const edge = (setupExtra = '', topExtra = ''): string => `
import type { Setup, Stage } from '@mason/types'
import { readFile, writeFile } from 'node:fs/promises'
const APP = 'co.example.app'
const CONFIG_BRANCHES = ['develop', 'beta']
export function configsFor(branch: string): string[] {
  return CONFIG_BRANCHES.includes(branch) ? [branch] : []
}
export function versionSuffix(branch: string): string {
  const table: Record<string, string> = {}
  return Object.prototype.hasOwnProperty.call(table, branch) ? table[branch]! : ''
}
function patchJson(): void {
  JSON.stringify = () => '{}'
}
${topExtra}
export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber(APP, { format: 'YYMMDDCC', scope: m.branch === 'master' ? 'app' : 'branch' })
  const configs = configsFor(m.branch)
  ${setupExtra}
  m.workflow('build', { triggers: [{ push: true, branches: ['master', 'develop', 'staging', 'beta'] }, { request: true }] }, (w) => {
    const tested = w.stage('test', { on: 'linux', configs, run: runTests })
    w.parallel('build', {
      ios: { needs: [tested], on: 'mac', run: buildIos },
      android: { needs: [tested], on: 'linux', run: buildAndroid },
    })
  })
}
export async function runTests(ctx: Stage) {
  const settings: Record<string, string> = {}
  settings.suffix = versionSuffix(ctx.run.branch)
  process.env.CI = '1'
  await writeFile('x', String(await readFile('y')))
}
export async function buildIos(ctx: Stage) {
  const options = { env: { ...process.env } }
  delete options.env.HOME
  patchJson()
}
export async function buildAndroid(ctx: Stage) {
  globalThis.fetch = fetch
  return eval('1') + arguments.length
}
`
    const branches = { build: ['master', 'develop', 'staging', 'beta'] }
    assert.deepEqual(sourcePushBranches(edge()), branches)
    // The same file where setup can run the patching code does not read.
    for (const [setupExtra, topExtra] of [
      ['patchJson()', ''],
      ['const later = [patchJson]', ''],
      [
        'm.stage("x", { on: "linux", run: buildIos, timeout: helper(patchJson) })',
        'const helper = (f) => f',
      ],
      ['versionSuffix(m.branch)', 'export function wrap() {}'],
      ['', 'JSON.stringify = () => "{}"'],
      ['', 'patchJson()'],
      ['', 'export const steps = { run: buildIos, also: [buildAndroid] }'],
      ['', 'class Hook { static { Reflect.set(JSON, "stringify", null) } }'],
    ])
      assert.equal(
        sourcePushBranches(edge(setupExtra, topExtra)),
        undefined,
        `${setupExtra} / ${topExtra}`,
      )
  })

  it('M1 refuses deeply nested code before Node’s type stripping, which would fail for the rest of the process', () => {
    assert.equal(
      sourcePushBranches('const x = ' + '['.repeat(100_000)),
      undefined,
    )
    assert.equal(
      moduleSpecifiers('const x = ' + '{'.repeat(100_000)),
      undefined,
    )
    assert.deepEqual(
      sourcePushBranches(
        `const a: number[][] = [[1]]\nexport function setup(m: unknown) { m.workflow('build', { triggers: [{ push: true, branches: ['main'] }] }, () => {}) }`,
      ),
      { build: ['main'] },
    )
  })

  it('M1 lists the modules a file loads from its syntax tree, or nothing when it could load or read anything else', () => {
    assert.deepEqual(
      moduleSpecifiers(`import type { Setup } from '@mason/types'
import { a } from './a.ts'
import './side.ts'
export { b } from '../b.ts'
export * from 'node:path'
import data from './d.json' with { type: 'json' }
// import { gone } from './gone.ts'
const text = "import x from './not-code.ts'"
const o = { process: 1, require: 2 }
o.globalThis = 3
`),
      ['./a.ts', './side.ts', '../b.ts', 'node:path', './d.json'],
    )
    for (const source of [
      `const p = (() => {}).constructor('return process')()`,
      `const p = (() => {})['constructor']('return process')()`,
      `const p = x[name]`,
      `const u = import.meta.url`,
      `const m = await import('./c.ts')`,
      `const d = require('./d.cjs')`,
      `export const B = [process.env.BRANCH]`,
      `const b = process.getBuiltinModule('node:fs')`,
      `const f = globalThis['req' + 'uire']`,
      `const r = await fetch('https://example.test')`,
      `eval('1')`,
      'this is not code (',
    ])
      assert.equal(moduleSpecifiers(source), undefined, source)
  })

  it('M1 the Recorder reads only a workflow’s own triggers, as the source read does', () => {
    const proto = Object.prototype as { triggers?: unknown }
    proto.triggers = [{ push: true }]
    let polluted: Graph
    try {
      polluted = record((m) => {
        m.apiVersion(1)
        m.stage('one', { on: 'linux', run: one })
        m.workflow('nightly', {}, (w) => {
          w.stage('n', { on: 'linux', run: one })
        })
        m.workflow(
          'docs',
          Object.create({ triggers: [{ push: true }] }) as object,
          (w) => {
            w.stage('d', { on: 'linux', run: one })
          },
        )
      })
    } finally {
      delete proto.triggers
    }
    assert.deepEqual(graphPushBranches(polluted), { build: true })
  })

  it('M1 matches branches with the branch-rule globs, and reads a recorded graph’s push triggers', () => {
    assert(pushAllows({ push: true }, 'anything'))
    assert(pushAllows({ push: true, branches: ['release/*'] }, 'release/1'))
    assert(!pushAllows({ push: true, branches: ['release/*'] }, 'release/1/2'))
    assert(pushAllows({ push: true, branches: ['release/**'] }, 'release/1/2'))
    assert(!pushAllows({ request: true }, 'master'))
    assert(pushBuilds({ build: ['master'], docs: ['x'] }, 'x'))
    assert(!pushBuilds({ build: ['master'] }, 'feature/x'))
    assert(pushBuilds({ build: true }, 'feature/x'))
    assert(!pushBuilds({}, 'master'))
    const graph = record((m) => {
      m.apiVersion(1)
      m.workflow(
        'build',
        { triggers: [{ push: true, branches: ['master'] }, { request: true }] },
        () => {},
      )
      m.stage('one', { on: 'linux', run: one })
      m.workflow('docs', { triggers: [{ push: true }] }, () => {})
      m.workflow('nightly', { triggers: [{ request: true }] }, () => {})
    })
    assert.deepEqual(graphPushBranches(graph), {
      build: ['master'],
      docs: true,
    })
  })
  it('M1 refuses a push trigger whose branches are not a list of names', () => {
    for (const trigger of [
      { push: true, branches: 'master' },
      { push: true, branches: [''] },
      { push: true, branches: [1] },
      { push: 'yes' },
    ])
      assert.throws(
        () =>
          record((m) => {
            m.apiVersion(1)
            m.workflow('build', { triggers: [trigger as never] }, () => {})
          }),
        GraphError,
      )
  })
})
