import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { stepItems, stepTree } from './steps.js'

const step = (
  id: number,
  title: string,
  parent?: number,
  kind = 'sh',
): {
  id: number
  kind: string
  title: string
  status: string
  parent?: number
} => ({
  id,
  kind,
  title,
  status: 'succeeded',
  ...(parent == null ? {} : { parent }),
})

describe('Run page steps', () => {
  it('lists each section followed by its own steps, indented, so sections run at once never interleave', () => {
    const steps = [
      step(1, 'npm ci'),
      step(2, 'A', undefined, 'section'),
      step(3, 'B', undefined, 'section'),
      step(4, 'a1', 2),
      step(5, 'b1', 3),
      step(6, 'inner', 2, 'section'),
      step(7, 'a2', 6),
    ]
    assert.deepEqual(
      stepTree(steps).map(({ step, depth }) => [step.title, depth]),
      [
        ['npm ci', 0],
        ['A', 0],
        ['a1', 1],
        ['inner', 1],
        ['a2', 2],
        ['B', 0],
        ['b1', 1],
      ],
    )
    const html = stepItems('build/ios', steps, { open: 4, tab: 'timeline' })
    assert.match(
      html,
      /<li class="step section" data-depth="0"><a href="\?stage=build%2Fios&amp;step=2&amp;tab=timeline">/,
    )
    assert.match(
      html,
      /<li class="step open" data-depth="1"><a href="\?stage=build%2Fios&amp;step=4/,
    )
    assert.match(html, /<span class="mono">a2<\/span><small>sh<\/small>/)
  })

  it('lists a step whose section is missing, or a malformed cycle, at the top level, each once', () => {
    assert.deepEqual(
      stepTree([step(2, 'orphan', 9), step(3, 'self', 3)]).map(
        ({ step, depth }) => [step.title, depth],
      ),
      [
        ['orphan', 0],
        ['self', 0],
      ],
    )
    assert.deepEqual(
      stepTree([step(1, 'a', 2), step(2, 'b', 1)]).map(
        ({ step }) => step.title,
      ),
      ['a', 'b'],
    )
    const deep = Array.from({ length: 7 }, (_, index) =>
      step(
        index + 1,
        `s${index + 1}`,
        index === 0 ? undefined : index,
        'section',
      ),
    )
    assert.deepEqual(
      stepTree(deep).map(({ depth }) => depth),
      [0, 1, 2, 3, 4, 4, 4],
    )
    assert.equal(stepItems('x', []), '<li class="empty">No steps yet.</li>')
    assert.match(
      stepItems('x', [
        { id: 1, kind: 'sh', title: '<b>', status: 'running', ms: 61_000 },
      ]),
      /&lt;b&gt;<\/span><small>sh · 1m 1s<\/small>/,
    )
  })
})
