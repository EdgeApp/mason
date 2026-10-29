import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'mocha'
import { applyNodeVersion } from '../../master/scheduler.js'
import type { Graph } from '../../pipeline/graph.js'
import {
  isLtsAlias,
  projectNodeVersion,
  readProjectNode,
  type NodeRelease,
} from './projectNode.js'

const checkout = (files: Record<string, string>): string => {
  const dir = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'node-'))
  for (const [name, text] of Object.entries(files))
    writeFileSync(path.join(dir, name), text)
  return dir
}

const releases: NodeRelease[] = [
  { version: 'v25.1.0', lts: false },
  { version: 'v24.11.1', lts: 'Krypton' },
  { version: 'v24.9.0', lts: false },
  { version: 'v22.20.0', lts: 'Jod' },
  { version: 'v22.9.0', lts: false },
]

describe('A repository’s Node.js version (tools.node: project)', () => {
  it('U2.1 reads .nvmrc, then .node-version, then package.json engines.node, ignoring empty, oversized and non-file entries', () => {
    const all = {
      '.nvmrc': '22\n# comment\n',
      '.node-version': '20.1.0\n',
      'package.json': JSON.stringify({ engines: { node: '>=18' } }),
    }
    assert.deepEqual(readProjectNode(checkout(all)), {
      file: '.nvmrc',
      text: '22',
    })
    assert.deepEqual(readProjectNode(checkout({ ...all, '.nvmrc': '\n' })), {
      file: '.node-version',
      text: '20.1.0',
    })
    const big = checkout({
      '.nvmrc': '1'.repeat(70 * 1024),
      'package.json': all['package.json'],
    })
    assert.deepEqual(readProjectNode(big), {
      file: 'package.json',
      text: '>=18',
    })
    const folder = checkout({})
    mkdirSync(path.join(folder, '.nvmrc'))
    assert.equal(readProjectNode(folder), undefined)
    assert.equal(
      readProjectNode(checkout({ 'package.json': '{not json' })),
      undefined,
    )
    assert.equal(
      readProjectNode(checkout({ 'package.json': '{"engines":{"node":3}}' })),
      undefined,
    )
  })

  it('U2.2 maps versions, LTS aliases and engines ranges to what Mason installs', () => {
    const version = (file: string, text: string): string | undefined =>
      projectNodeVersion(file, text, releases).version
    assert.equal(version('.nvmrc', 'v24.11.1'), '24.11.1')
    assert.equal(version('.nvmrc', '22'), '22')
    assert.equal(version('.node-version', '22.x'), '22')
    assert.equal(version('.nvmrc', 'lts/*'), '24')
    assert.equal(version('.nvmrc', 'lts'), '24')
    assert.equal(version('.nvmrc', 'lts/jod'), '22')
    assert.equal(version('.nvmrc', 'LTS/Jod'), '22')
    assert.equal(version('package.json', '>=20'), '20')
    assert.equal(version('package.json', '^20.5'), '20')
    assert.equal(version('package.json', '>=18 <23'), '18')
    assert.deepEqual(projectNodeVersion('.nvmrc', 'lts/argon', releases), {
      file: '.nvmrc',
      problem: 'no Node.js LTS release matches lts/argon',
    })
    assert.match(
      String(projectNodeVersion('.nvmrc', 'lts/*').problem),
      /no Node\.js LTS release/,
    )
    assert.match(
      String(projectNodeVersion('.nvmrc', 'node').problem),
      /"node" is not a Node\.js version/,
    )
    assert.match(
      String(projectNodeVersion('package.json', '*').problem),
      /names no Node\.js version/,
    )
    assert(isLtsAlias('lts/*') && isLtsAlias('LTS') && !isLtsAlias('22'))
  })

  it('U2.2 fills tools.node project in every stage, and fails only the workflow that runs without a version', () => {
    const graph = (): Graph =>
      ({
        workflows: [
          {
            name: 'build',
            stages: [
              { name: 'rn', tools: { node: 'project', xcode: '26' } },
              { name: 'own', tools: { node: '20' } },
              { name: 'none' },
            ],
          },
          {
            name: 'other',
            stages: [{ name: 'x', tools: { node: 'project' } }],
          },
        ],
      }) as unknown as Graph
    const filled = graph()
    assert.equal(
      applyNodeVersion(filled, { file: '.nvmrc', version: '22' }, 'build'),
      undefined,
    )
    assert.deepEqual(
      filled.workflows.flatMap((workflow) =>
        workflow.stages.map((stage) => stage.tools),
      ),
      [{ node: '22', xcode: '26' }, { node: '20' }, undefined, { node: '22' }],
    )
    assert.equal(
      applyNodeVersion(graph(), undefined, 'build'),
      "rn: tools.node is 'project' but the repository has no .nvmrc, .node-version or engines.node",
    )
    assert.equal(
      applyNodeVersion(
        graph(),
        { file: '.nvmrc', problem: '"node" is not a Node.js version' },
        'other',
      ),
      `x: tools.node is 'project' but .nvmrc cannot be used: "node" is not a Node.js version`,
    )
    assert.match(
      String(
        applyNodeVersion(
          graph(),
          { file: '.nvmrc', version: '$(rm)' },
          'build',
        ),
      ),
      /\.nvmrc cannot be used: it names no Node\.js version/,
    )
    // A workflow without such a stage runs, and discovery never fails here.
    assert.equal(applyNodeVersion(graph(), undefined, 'discover'), undefined)
  })
})
