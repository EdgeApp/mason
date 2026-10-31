import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'mocha'
import { MasterDatabase } from './database.js'
import { RunFeed, type FeedEvent } from './runFeed.js'

const turn = async (): Promise<void> =>
  await new Promise((resolve) => setImmediate(resolve))

describe('Run feed', () => {
  it('delivers a run’s changes and log growth together on the next turn, after the write, coalesced', async () => {
    const database = new MasterDatabase(new DatabaseSync(':memory:'))
    const logged = new Set<(job: string, stage: string) => void>()
    const feed = new RunFeed(database, logged)
    const heard: FeedEvent[][] = []
    const stop = feed.subscribe((events) => heard.push(events))
    feed.subscribe(() => {
      throw new Error('a broken page')
    })
    database.change('job', 'r1')
    database.change('job', 'r1')
    database.change('build', 7)
    for (const listener of logged) listener('r1', 'build/ios')
    for (const listener of logged) listener('r1', 'build/ios')
    // Nothing yet: the write's transaction may still be open.
    assert.deepEqual(heard, [])
    await turn()
    assert.deepEqual(heard, [
      [
        { kind: 'run', run: 'r1' },
        { kind: 'log', run: 'r1', stage: 'build/ios' },
      ],
    ])
    database.change('job', 'r2')
    await turn()
    assert.deepEqual(heard.at(-1), [{ kind: 'run', run: 'r2' }])
    stop()
    database.change('job', 'r3')
    await turn()
    assert.equal(heard.length, 2)
  })
})
