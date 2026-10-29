import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'mocha'
import { applyProjectTools } from '../../master/scheduler.js'
import type { Graph } from '../../pipeline/graph.js'
import {
  isLtsAlias,
  projectVersion,
  readProjectTools,
  readProjectVersion,
  wantedProjectTools,
  type NodeRelease,
  type ProjectTool,
} from './projectTools.js'

const checkout = (files: Record<string, string>): string => {
  const dir = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'pins-'))
  for (const [name, text] of Object.entries(files))
    writeFileSync(path.join(dir, name), text)
  return dir
}

const releases: NodeRelease[] = [
  { version: 'v25.1.0', lts: false },
  { version: 'v24.11.1', lts: 'Krypton' },
  { version: 'v24.9.0', lts: false },
  { version: 'v22.20.0', lts: 'Jod' },
]

/** What 'project' resolves to for `tool` in a checkout of `files`. */
const pinned = (
  tool: ProjectTool,
  files: Record<string, string>,
): { file: string; version?: string; problem?: string } | undefined => {
  const pin = readProjectVersion(checkout(files), tool)
  return pin == null ? undefined : projectVersion(tool, pin, releases)
}

describe('Versions a repository pins (tools: project)', () => {
  it('U1.1 Node.js: .nvmrc, .node-version, .tool-versions, engines.node; LTS aliases and ranges', () => {
    const all = {
      '.nvmrc': '# pinned\n22\n',
      '.node-version': '20.1.0\n',
      '.tool-versions': 'nodejs 18.20.0\n',
      'package.json': JSON.stringify({ engines: { node: '>=16' } }),
    }
    assert.deepEqual(pinned('node', all), { file: '.nvmrc', version: '22' })
    assert.deepEqual(pinned('node', { ...all, '.nvmrc': '\n' }), {
      file: '.node-version',
      version: '20.1.0',
    })
    assert.equal(
      pinned('node', { '.tool-versions': all['.tool-versions'] })!.version,
      '18.20.0',
    )
    assert.equal(
      pinned('node', { 'package.json': all['package.json'] })!.version,
      '16',
    )
    for (const [text, version] of [
      ['v24.11.1', '24.11.1'],
      ['22.x', '22'],
      ['lts/*', '24'],
      ['lts', '24'],
      ['LTS/Jod', '22'],
    ])
      assert.equal(pinned('node', { '.nvmrc': text! })!.version, version)
    assert.match(
      pinned('node', { '.nvmrc': 'lts/argon' })!.problem!,
      /no Node\.js LTS release matches lts\/argon/,
    )
    assert.match(
      pinned('node', { '.nvmrc': 'node' })!.problem!,
      /"node" is not a Node\.js version/,
    )
    assert.match(
      pinned('node', { 'package.json': '{"engines":{"node":"*"}}' })!.problem!,
      /names no node version/,
    )
    assert.equal(pinned('node', { 'package.json': '{not json' }), undefined)
    assert.equal(
      pinned('node', { 'package.json': '{"engines":{}}' }),
      undefined,
    )
    assert(isLtsAlias('lts/*') && isLtsAlias('LTS') && !isLtsAlias('22'))
  })

  it('U1.1 Rust: rust-toolchain.toml, rust-toolchain (plain or TOML), .tool-versions', () => {
    assert.deepEqual(
      pinned('rust', {
        'rust-toolchain.toml':
          '[toolchain]\nchannel = "1.82.0" # pinned\ncomponents = ["clippy"]\n',
        'rust-toolchain': 'nightly\n',
      }),
      { file: 'rust-toolchain.toml', version: '1.82.0' },
    )
    assert.equal(
      pinned('rust', { 'rust-toolchain': 'stable\n' })!.version,
      'stable',
    )
    assert.equal(
      pinned('rust', { 'rust-toolchain': "[toolchain]\nchannel = '1.80.1'\n" })!
        .version,
      '1.80.1',
    )
    assert.equal(
      pinned('rust', { '.tool-versions': 'rust 1.79.0' })!.version,
      '1.79.0',
    )
    assert.equal(
      pinned('rust', { 'rust-toolchain.toml': '[other]\nchannel = "x"\n' }),
      undefined,
    )
    assert.match(
      pinned('rust', { 'rust-toolchain': '$(rm -rf /)' })!.problem!,
      /not a Rust toolchain/,
    )
  })

  it('U1.1 Java, Python, Ruby, Go and Xcode pin files', () => {
    assert.equal(pinned('java', { '.java-version': '21\n' })!.version, '21')
    assert.equal(
      pinned('java', { '.sdkmanrc': 'gradle=8.10\njava=21.0.5-tem\n' })!
        .version,
      '21.0.5',
    )
    assert.equal(
      pinned('java', { '.tool-versions': 'java temurin-17.0.12+7' })!.version,
      '17.0.12',
    )
    assert.equal(
      pinned('python', { '.python-version': '3.12.7\n' })!.version,
      '3.12.7',
    )
    assert.equal(
      pinned('python', {
        'pyproject.toml': '[project]\nname = "x"\nrequires-python = ">=3.11"\n',
      })!.version,
      '3.11',
    )
    assert.equal(
      pinned('python', { '.tool-versions': 'python 3.13.1' })!.version,
      '3.13.1',
    )
    assert.match(
      pinned('python', { '.python-version': 'pypy3.10' })!.problem!,
      /not CPython/,
    )
    assert.equal(
      pinned('ruby', { '.ruby-version': 'ruby-3.3.5\n' })!.version,
      '3.3.5',
    )
    assert.equal(
      pinned('ruby', { Gemfile: "source 'x'\nruby '~> 3.3.0'\n" })!.version,
      '3.3',
    )
    assert.equal(
      pinned('ruby', { '.tool-versions': 'ruby 3.4.1' })!.version,
      '3.4.1',
    )
    assert.match(
      pinned('ruby', { '.ruby-version': 'jruby-9.4' })!.problem!,
      /not CRuby/,
    )
    assert.equal(
      pinned('go', { 'go.mod': 'module x\n\ngo 1.23.0\ntoolchain go1.23.4\n' })!
        .version,
      '1.23.4',
    )
    assert.equal(
      pinned('go', { 'go.mod': 'module x\ngo 1.22\n' })!.version,
      '1.22',
    )
    assert.equal(
      pinned('go', { '.tool-versions': 'golang 1.21.5' })!.version,
      '1.21.5',
    )
    assert.equal(
      pinned('xcode', { '.xcode-version': '26.1\n' })!.version,
      '26.1',
    )
    assert.match(
      pinned('xcode', { '.tool-versions': 'xcode $(rm)' })!.problem!,
      /not an Xcode version/,
    )
    assert.match(
      pinned('go', { 'go.mod': 'go tip\n' })!.problem!,
      /names no go version/,
    )
  })

  it('U1.1 reads only wanted tools, ignores oversized and non-file pins, and reports a failed release index', async () => {
    const dir = checkout({
      '.nvmrc': 'lts/*',
      '.python-version': '1'.repeat(70 * 1024),
      '.tool-versions': 'python 3.12\n',
    })
    mkdirSync(path.join(dir, '.ruby-version'))
    const index = async (): Promise<NodeRelease[]> => releases
    assert.deepEqual(
      await readProjectTools(dir, ['node', 'python', 'ruby'], index),
      {
        node: { file: '.nvmrc', version: '24' },
        python: { file: '.tool-versions', version: '3.12' },
      },
    )
    assert.deepEqual(await readProjectTools(dir, [], index), {})
    assert.deepEqual(
      await readProjectTools(dir, ['node'], async () => {
        throw new Error('offline')
      }),
      {
        node: {
          file: '.nvmrc',
          problem: 'the Node.js release index failed: offline',
        },
      },
    )
    assert.deepEqual(
      wantedProjectTools({
        workflows: [
          {
            stages: [
              { tools: { node: 'project', rust: '1.82.0' } },
              { tools: { go: 'project', xcode: 'project' } },
              {},
            ],
          },
        ],
      }).sort(),
      ['go', 'node', 'xcode'],
    )
    assert.deepEqual(wantedProjectTools(undefined), [])
  })

  it('U1.2 fills every project tool, keeps explicit versions, and fails only the running workflow naming the tool and files', () => {
    const graph = (): Graph =>
      ({
        workflows: [
          {
            name: 'build',
            stages: [
              {
                name: 'app',
                tools: { node: 'project', rust: 'project', xcode: '26' },
              },
              { name: 'own', tools: { node: '20' } },
              { name: 'none' },
            ],
          },
          { name: 'other', stages: [{ name: 'x', tools: { go: 'project' } }] },
        ],
      }) as unknown as Graph
    const filled = graph()
    assert.equal(
      applyProjectTools(
        filled,
        {
          node: { file: '.nvmrc', version: '22' },
          rust: { file: 'rust-toolchain.toml', version: '1.82.0' },
        },
        'build',
      ),
      undefined,
    )
    assert.deepEqual(
      filled.workflows.flatMap((workflow) =>
        workflow.stages.map((stage) => stage.tools),
      ),
      [
        { node: '22', rust: '1.82.0', xcode: '26' },
        { node: '20' },
        undefined,
        { go: 'project' },
      ],
    )
    assert.equal(
      applyProjectTools(graph(), undefined, 'build'),
      "app: tools.node is 'project' but the repository has no .nvmrc, .node-version, .tool-versions or package.json engines.node",
    )
    assert.equal(
      applyProjectTools(
        graph(),
        { node: { file: '.nvmrc', version: '22' } },
        'build',
      ),
      "app: tools.rust is 'project' but the repository has no rust-toolchain.toml, rust-toolchain or .tool-versions",
    )
    assert.equal(
      applyProjectTools(
        graph(),
        { go: { file: 'go.mod', problem: '"tip" names no go version' } },
        'other',
      ),
      `x: tools.go is 'project' but go.mod cannot be used: "tip" names no go version`,
    )
    assert.match(
      String(
        applyProjectTools(
          graph(),
          {
            node: { file: '.nvmrc', version: '$(rm)\n' },
            rust: { file: 'rust-toolchain', version: '1.82.0' },
          },
          'build',
        ),
      ),
      /\.nvmrc cannot be used: it names no node version/,
    )
    assert.equal(applyProjectTools(graph(), undefined, 'discover'), undefined)
  })
})
