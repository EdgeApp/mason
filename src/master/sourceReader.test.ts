import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { after, describe, it } from 'mocha'
import { SourceReader } from './sourceReader.js'

const good = `const n: number = 1
export function setup(m: unknown) { m.workflow('build', { triggers: [{ push: true, branches: ['main'] }] }, () => {}) }`

describe('Source reader', () => {
  const reader = new SourceReader()
  after(async () => {
    await reader.close()
  })

  it('M1 reads in a worker that an input breaking Node’s type stripping costs, never the master’s thread', async () => {
    // Inputs that break the stripping for the rest of a thread, with few brackets.
    for (const bad of [
      'if(1)'.repeat(2000) + ';',
      'a:'.repeat(5000) + ';',
      'while(1)'.repeat(2000) + ';',
    ]) {
      assert.equal((await reader.read(bad)).push, undefined, bad.slice(0, 10))
      assert.deepEqual(await reader.read(good), {
        push: { build: ['main'] },
        specifiers: [],
      })
    }
    // The master's own thread still strips.
    assert.match(stripTypeScriptTypes('const a: number = 1'), /const a\s+= 1/)
  })

  it('M1 replaces a worker that takes too long, and reads queued behind it with the next one, each timed from its start', async () => {
    reader.timeoutMs = 1
    const slow = reader.read(`// ${'x'.repeat(200_000)}\n${good}`)
    reader.timeoutMs = 10_000
    const queued = [reader.read(good), reader.read(good), reader.read(good)]
    assert.deepEqual(await slow, {})
    for (const facts of await Promise.all(queued))
      assert.deepEqual(facts.push, { build: ['main'] })
  })

  it('M1 reads a long file of many names in time linear in its length', async () => {
    const started = Date.now()
    assert.deepEqual(await reader.read('a;'.repeat(125_000)), {
      specifiers: [],
    })
    assert(Date.now() - started < 2000)
  })
})
