import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { bridge } from './bridge.js'
import { Link, type Stream } from './link.js'
import { memoryPair } from './wire.js'

/**
 * A master linked to a worker and to a host, as the cluster is. `toHost`
 * opens a stream on the master's host link; the host answers with `serve`.
 */
function hub(serve: (stream: Stream) => Promise<void> | void): {
  worker: Link
  bridged: Promise<{ done: Promise<void> }>
} {
  const [workerEnd, masterToWorker] = memoryPair()
  const [masterToHost, hostEnd] = memoryPair()
  new Link(hostEnd, {
    localRole: 'host',
    peerRole: 'master',
    dialer: false,
    methods: {
      streams: {
        relay: async (stream): Promise<void> => {
          await serve(stream)
        },
      },
    },
  })
  const hostLink = new Link(masterToHost, {
    localRole: 'master',
    peerRole: 'host',
    dialer: true,
    methods: {},
  })
  // Wrapped, so the bridge's own promise is handed over unsettled.
  let joined!: (value: { done: Promise<void> }) => void
  const bridged = new Promise<{ done: Promise<void> }>((resolve) => {
    joined = resolve
  })
  new Link(masterToWorker, {
    localRole: 'master',
    peerRole: 'worker',
    dialer: true,
    methods: {
      streams: {
        relay: (stream, params): void => {
          const done = bridge(stream, hostLink.openStream('relay', params))
          done.catch(() => undefined)
          joined({ done })
        },
      },
    },
  })
  const worker = new Link(workerEnd, {
    localRole: 'worker',
    peerRole: 'master',
    dialer: false,
    methods: {},
  })
  return { worker, bridged }
}

describe('Bridged streams', () => {
  it('relays both ways in order, paced by credit, and ends once both sides have', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7)
    const { worker, bridged } = hub(async (stream) => {
      const got = await stream.collect()
      await stream.write(Buffer.from(`got ${got.length}`))
      await stream.write(Buffer.from(` ${got.equals(big)}`))
      stream.end()
    })
    const stream = worker.openStream('relay', {})
    const answer = stream.collect()
    await stream.write(big)
    stream.end()
    assert.equal((await answer).toString(), `got ${big.length} true`)
    await (
      await bridged
    ).done
  })

  it('aborts the other side when either side aborts', async () => {
    let hostAborted: Promise<string> | undefined
    const { worker, bridged } = hub((stream) => {
      hostAborted = new Promise((resolve) => stream.once('abort', resolve))
    })
    const stream = worker.openStream('relay', {})
    await stream.write(Buffer.from('partial'))
    stream.abort('The node went away')
    await assert.rejects((await bridged).done, /The node went away/)
    assert.equal(await hostAborted, 'The node went away')
    // And the host's abort reaches the node.
    const second = hub((stream) => {
      stream.abort('Disk full')
    })
    const upload = second.worker.openStream('relay', {})
    await assert.rejects(upload.collect(), /Disk full/)
    await assert.rejects((await second.bridged).done, /Disk full/)
  })

  it('aborts both sides when the host goes while the node is still sending', async () => {
    const { worker, bridged } = hub((stream) => {
      stream.once('data', () => stream.abort('Disk full'))
    })
    const stream = worker.openStream('relay', {})
    const failed = stream.collect().catch((error: Error) => error.message)
    // Writes queued on the master fail once the host's side is gone.
    await stream.write(Buffer.alloc(3 * 1024 * 1024, 1)).catch(() => undefined)
    assert.match(String(await failed), /Disk full/)
    await assert.rejects((await bridged).done, /Disk full/)
  })
})
