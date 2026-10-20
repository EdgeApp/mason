import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createTlsServer } from 'node:tls'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { createCertificate } from '../node/certificate.js'
import { prepareDataDir } from '../node/dataDir.js'
import {
  loadIdentity,
  parsePairingKey,
  type Identity,
} from '../node/identity.js'
import { startNode, type RunningNode } from '../node/serve.js'
import { IN_PROCESS } from '../master/nodes.js'
import { nodeMain, type MainIO } from '../node/main.js'
import { version } from '../version.js'
import {
  checkMac,
  handshake,
  HandshakeRefused,
  pairingMac,
  transcript,
  type Hello,
} from './handshake.js'
import {
  CLOSE,
  Link,
  LinkError,
  MAX_MESSAGE,
  PROTOCOL_MAJOR,
  STREAM_WINDOW,
  type MethodTable,
} from './link.js'
import {
  certificateDigest,
  dialWire,
  parseAddress,
  PinMismatch,
} from './network.js'
import { memoryPair, Wire, type Frame } from './wire.js'

let root: string
const quiet = (): void => undefined

async function worker(
  name: string,
  extra: Partial<Parameters<typeof startNode>[0]> = {},
): Promise<RunningNode> {
  return await startNode(
    {
      role: 'worker',
      data: path.join(root, name),
      linkPort: 0,
      listen: '127.0.0.1',
      heartbeatMs: 0,
      ...extra,
    },
    quiet,
  )
}
async function master(
  name: string,
  extra: Partial<Parameters<typeof startNode>[0]> = {},
): Promise<RunningNode> {
  return await startNode(
    {
      role: 'master',
      data: path.join(root, name),
      port: 0,
      listen: '127.0.0.1',
      heartbeatMs: 0,
      redialBaseMs: 20,
      ...extra,
    },
    quiet,
  )
}
const keyOf = (node: RunningNode): string => node.pairing!.key()!
const addressOf = (node: RunningNode): string => `127.0.0.1:${node.link!.port}`
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Two links joined by in-process wires. */
function linkPair(
  masterMethods: MethodTable,
  workerMethods: MethodTable,
  peerRole: 'worker' | 'host' = 'worker',
): [Link, Link] {
  const [a, b] = memoryPair()
  return [
    new Link(a, {
      localRole: 'master',
      peerRole,
      dialer: true,
      methods: masterMethods,
    }),
    new Link(b, {
      localRole: peerRole,
      peerRole: 'master',
      dialer: false,
      methods: workerMethods,
    }),
  ]
}

/** A wire that records what is sent and lets a test inject frames. */
class TestWire extends Wire {
  sent: Frame[] = []
  closes: number[] = []
  send(data: Frame): void {
    this.sent.push(data)
  }
  close(code: number): void {
    this.closes.push(code)
    this.closedByPeer()
  }
  inject(data: Frame): void {
    this.deliver(data)
  }
  pong(): void {
    this.ponged()
  }
}

describe('Master-dialed links', function () {
  this.timeout(30000)
  beforeEach(() => {
    process.umask(0o077)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'link-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('parses node addresses given as URLs, IP addresses and DNS names', () => {
    assert.deepEqual(parseAddress('https://builder.local:9410/'), {
      host: 'builder.local',
      port: 9410,
    })
    assert.deepEqual(parseAddress('wss://[fd00::5]:9411'), {
      host: 'fd00::5',
      port: 9411,
    })
    assert.deepEqual(parseAddress('https://builder.local'), {
      host: 'builder.local',
      port: 9310,
    })
    assert.deepEqual(parseAddress('10.0.0.5:9412'), {
      host: '10.0.0.5',
      port: 9412,
    })
    assert.deepEqual(parseAddress('10.0.0.5'), { host: '10.0.0.5', port: 9310 })
    assert.deepEqual(parseAddress('fd00::7'), { host: 'fd00::7', port: 9310 })
    assert.deepEqual(parseAddress('[fd00::7]'), { host: 'fd00::7', port: 9310 })
    assert.deepEqual(parseAddress('[fd00::7]:1'), { host: 'fd00::7', port: 1 })
    assert.deepEqual(parseAddress(' kefir '), { host: 'kefir', port: 9310 })
    for (const bad of [
      '',
      'http://x',
      'https://u:p@x',
      'a b',
      'x:0',
      'x:70000',
    ])
      assert.throws(() => parseAddress(bad))
  })

  it('pairs a worker once with its key, sets it up from the master and redials it', async () => {
    const node = await worker('w')
    const m = await master('m')
    try {
      const key = keyOf(node)
      const record = await m.registry!.add(
        `https://127.0.0.1:${node.link!.port}`,
        key,
      )
      assert.equal(record.fingerprint, node.identity.fingerprint)
      assert.equal(record.role, 'worker')
      assert.equal(record.connected, true)
      assert.equal(node.pairing!.master()!.fingerprint, m.identity.fingerprint)
      assert.equal(node.pairing!.key(), undefined)
      assert.equal(node.status().pairing, 'paired')
      await until(() => node.pairing!.assignment() != null)
      const assigned = await m.registry!.assign(record.fingerprint, {
        name: 'builder-1',
        type: 'mac-xcode',
        labels: ['apple-signing'],
      })
      assert.deepEqual(
        [assigned.name, assigned.type, assigned.labels],
        ['builder-1', 'mac-xcode', ['apple-signing']],
      )
      assert.deepEqual(node.pairing!.assignment(), {
        name: 'builder-1',
        type: 'mac-xcode',
        labels: ['apple-signing'],
      })
      await assert.rejects(
        m.registry!.assign('mldsa65:none', {}),
        /No such node/,
      )
      // The key is spent: pairing it again, from this master or another, fails.
      await assert.rejects(
        m.registry!.add(addressOf(node), key),
        /already paired/,
      )
      const other = await master('m2')
      try {
        await assert.rejects(
          other.registry!.add(addressOf(node), key),
          HandshakeRefused,
        )
        assert.equal(other.registry!.list().length, 0)
      } finally {
        await other.close()
      }
      // The master redials after the node restarts.
      const data = node.dir
      const port = node.link!.port
      await node.close()
      await until(() => m.registry!.link(record.fingerprint) == null)
      const again = await worker('w', { linkPort: port })
      try {
        await until(() => m.registry!.link(record.fingerprint) != null)
        assert.equal(m.registry!.list()[0]!.connected, true)
        assert.equal(again.dir, data)
      } finally {
        await again.close()
      }
    } finally {
      await m.close()
      await node.close().catch(() => undefined)
    }
  })

  it('refuses a wrong secret and pairs over a DNS name', async () => {
    const node = await worker('w')
    const m = await master('m')
    try {
      const key = parsePairingKey(keyOf(node))
      const wrong = `mason1:${key.fingerprint}.${key.certificateHash}.${'A'.repeat(43)}`
      await assert.rejects(
        m.registry!.add(addressOf(node), wrong),
        HandshakeRefused,
      )
      assert.equal(node.pairing!.master(), undefined)
      const record = await m.registry!.add(
        `localhost:${node.link!.port}`,
        keyOf(node),
      )
      assert.equal(record.host, 'localhost')
    } finally {
      await m.close()
      await node.close()
    }
  })

  it('sends nothing to a node whose certificate does not match', async () => {
    const certificate = createCertificate(['127.0.0.1'])
    let bytes = 0
    const server = createTlsServer(
      {
        key: certificate.key,
        cert: certificate.cert,
        minVersion: 'TLSv1.3',
        ecdhCurve: 'X25519MLKEM768',
      },
      (socket) => socket.on('data', (chunk: Buffer) => (bytes += chunk.length)),
    ).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const m = await master('m')
    try {
      const identity = loadIdentity(prepareDataDir(path.join(root, 'fake')))
      const port = (server.address() as AddressInfo).port
      const key = `mason1:${identity.fingerprint}.${identity.certificateHash}.${'B'.repeat(43)}`
      await assert.rejects(
        m.registry!.add(`127.0.0.1:${port}`, key),
        PinMismatch,
      )
      await assert.rejects(
        dialWire({ host: '127.0.0.1', port }, 'x'.repeat(43)),
        PinMismatch,
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(bytes, 0)
      // A paired node whose certificate later differs from the stored hash.
      const node = await worker('w')
      try {
        const record = await m.registry!.add(addressOf(node), keyOf(node))
        m.registry!.db.prepare(
          'UPDATE nodes SET certificate_hash=?, port=? WHERE id=?',
        ).run('y'.repeat(43), port, record.id)
        node.links!.current()!.close()
        await until(() => m.registry!.link(record.fingerprint) == null)
        const before = bytes
        assert.equal(await m.registry!.dial(record.fingerprint), false)
        assert.equal(bytes, before)
      } finally {
        await node.close()
      }
    } finally {
      await m.close()
      server.close()
    }
  })

  it('refuses hellos and proofs that do not belong to this session', async () => {
    const a = loadIdentity(prepareDataDir(path.join(root, 'a')))
    const b = loadIdentity(prepareDataDir(path.join(root, 'b')))
    const exporter = Buffer.alloc(32, 1)
    const run = async (
      tamper: (frame: string, from: 'master' | 'node') => string | undefined,
      options: { nodeExporter?: Buffer; masterRole?: 'master' | 'worker' } = {},
    ): Promise<
      [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]
    > => {
      const [left, right] = memoryPair()
      // Frames pass through `tamper` on the way to the other side.
      const relay = (from: Wire, label: 'master' | 'node'): void => {
        const send = from.send.bind(from)
        from.send = (data: Frame): void => {
          const out = typeof data === 'string' ? tamper(data, label) : data
          if (out != null) send(out)
        }
      }
      relay(left, 'master')
      relay(right, 'node')
      return (await Promise.allSettled([
        handshake(left, {
          identity: a,
          role: options.masterRole ?? 'master',
          exporter,
          dialer: true,
          acceptHello: () => undefined,
          timeoutMs: 500,
        }),
        handshake(right, {
          identity: b,
          role: 'worker',
          exporter: options.nodeExporter ?? exporter,
          dialer: false,
          acceptHello: () => undefined,
          timeoutMs: 500,
        }),
      ])) as [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]
    }
    const ok = await run((frame) => frame)
    assert.deepEqual(
      ok.map((result) => result.status),
      ['fulfilled', 'fulfilled'],
    )
    // A different TLS session (exporter) breaks both signatures.
    const relayed = await run((frame) => frame, {
      nodeExporter: Buffer.alloc(32, 2),
    })
    assert.deepEqual(
      relayed.map((result) => result.status),
      ['rejected', 'rejected'],
    )
    // Proofs recorded from one session are refused in another.
    const recorded: string[] = []
    await run((frame) => {
      recorded.push(frame)
      return frame
    })
    const masterProof = recorded.find(
      (frame) => frame.includes('"proof"') && recorded.indexOf(frame) < 3,
    )!
    const replayed = await run((frame, from) =>
      from === 'master' && frame.includes('"proof"') ? masterProof : frame,
    )
    assert.equal(replayed[1].status, 'rejected')
    for (const [name, tamper] of [
      [
        'major',
        (hello: Hello): Hello => ({ ...hello, major: PROTOCOL_MAJOR + 1 }),
      ],
      ['protocol', (hello: Hello): Hello => ({ ...hello, protocol: 'other' })],
      ['nonce', (hello: Hello): Hello => ({ ...hello, nonce: 'c2hvcnQ=' })],
      [
        'fingerprint',
        (hello: Hello): Hello => ({
          ...hello,
          fingerprint: 'mldsa65:' + 'x'.repeat(43),
        }),
      ],
      [
        'key',
        (hello: Hello): Hello => ({
          ...hello,
          publicKey: Buffer.from('nonsense').toString('base64'),
        }),
      ],
      ['role', (hello: Hello): Hello => ({ ...hello, role: 'worker' })],
    ] as const) {
      const result = await run((frame, from) => {
        const message = JSON.parse(frame) as Hello
        return from === 'master' && message.kind === 'hello'
          ? JSON.stringify(tamper(message))
          : frame
      })
      assert.equal(result[1].status, 'rejected', name)
    }
    const garbage = await run((frame, from) =>
      from === 'master' ? 'not json' : frame,
    )
    assert.equal(garbage[1].status, 'rejected')
    const early = await run((frame, from) =>
      from === 'master' && frame.includes('"hello"')
        ? JSON.stringify({ kind: 'proof', signature: '' })
        : frame,
    )
    assert.equal(early[1].status, 'rejected')
    const unsigned = await run((frame, from) =>
      from === 'master' && frame.includes('"proof"')
        ? JSON.stringify({ kind: 'hello' })
        : frame,
    )
    assert.equal(unsigned[1].status, 'rejected')
    const silent = await run(() => undefined)
    assert.match(
      String((silent[0] as PromiseRejectedResult).reason),
      /timed out/,
    )
    const two = await run((frame) => frame, { masterRole: 'worker' })
    assert.deepEqual(
      two.map((result) => result.status),
      ['rejected', 'rejected'],
    )
    // Transcripts bind role, nonces, fingerprints and the session.
    const t = transcript(
      { role: 'master', nonce: 'n1', fingerprint: 'f1' },
      { nonce: 'n2', fingerprint: 'f2' },
      exporter,
    )
    assert.notDeepEqual(
      t,
      transcript(
        { role: 'master', nonce: 'n2', fingerprint: 'f1' },
        { nonce: 'n1', fingerprint: 'f2' },
        exporter,
      ),
    )
    assert(checkMac('secret', pairingMac('secret', t), t))
    assert(!checkMac('secret', pairingMac('other', t), t))
    assert(!checkMac('secret', undefined, t))
  })

  it('accepts links only from the paired master and refuses removed nodes', async () => {
    const node = await worker('w')
    const m = await master('m')
    const stranger = await master('s')
    try {
      const record = await m.registry!.add(addressOf(node), keyOf(node))
      // Another master that copies the node's record cannot link to it.
      const row = m
        .registry!.db.prepare('SELECT * FROM nodes WHERE id=?')
        .get(record.id) as Record<string, string | number>
      stranger
        .registry!.db.prepare(
          'INSERT INTO nodes(fingerprint,public_key,certificate_hash,role,host,port,name,added_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          row.fingerprint!,
          row.public_key!,
          row.certificate_hash!,
          row.role!,
          row.host!,
          row.port!,
          row.name!,
          row.added_at!,
        )
      assert.equal(await stranger.registry!.dial(record.fingerprint), false)
      assert.equal(
        node.links!.current()?.peer?.fingerprint,
        m.identity.fingerprint,
      )
      // Removal closes the live link, the node forgets its master and refuses it.
      const closed = once(node.links!.current()!, 'close')
      m.registry!.remove(record.fingerprint)
      await closed
      await until(() => node.pairing!.removed())
      assert.equal(node.pairing!.master(), undefined)
      assert.equal(node.status().pairing, 'removed')
      assert.equal(m.registry!.list().length, 0)
      assert.equal(await m.registry!.dial(record.fingerprint), false)
      assert.throws(
        () => m.registry!.remove(record.fingerprint),
        /No such node/,
      )
      await assert.rejects(
        m.registry!.add(
          addressOf(node),
          `mason1:${node.identity.fingerprint}.${node.identity.certificateHash}.${'C'.repeat(43)}`,
        ),
        HandshakeRefused,
      )
      // With --new-key the node pairs again.
      await node.close()
      const renewed = await worker('w', { newKey: true })
      try {
        assert.equal(renewed.pairing!.removed(), false)
        const again = await m.registry!.add(addressOf(renewed), keyOf(renewed))
        assert.notEqual(again.fingerprint, record.fingerprint)
      } finally {
        await renewed.close()
      }
    } finally {
      await m.close()
      await stranger.close()
      await node.close().catch(() => undefined)
    }
  })

  it('lets each role call only the methods registered for it, in both directions', async () => {
    const calls: string[] = []
    const [toWorker, fromMaster] = linkPair(
      { requests: { 'inventory.report': (params) => ({ got: params }) } },
      {
        requests: { 'tools.install': (params) => ({ installed: params }) },
        events: { 'stage.cancel': (params) => void calls.push(String(params)) },
      },
    )
    assert.deepEqual(await toWorker.request('tools.install', 'node'), {
      installed: 'node',
    })
    assert.deepEqual(await fromMaster.request('inventory.report', 7), {
      got: 7,
    })
    await assert.rejects(
      fromMaster.request('tools.install'),
      (error: LinkError) => error.code === 'not_allowed',
    )
    await assert.rejects(
      toWorker.request('inventory.report'),
      (error: LinkError) => error.code === 'not_allowed',
    )
    toWorker.event('stage.cancel', 'job-1')
    const refused = once(toWorker, 'refused')
    fromMaster.event('stage.cancel', 'x')
    assert.deepEqual(await refused, ['stage.cancel'])
    await until(() => calls.length === 1)
    assert.deepEqual(calls, ['job-1'])
    // A host may not call what the master accepts from workers.
    const [masterForHost, host] = linkPair(
      { requests: { 'cache.revision': () => 41 } },
      {},
      'host',
    )
    assert.equal(await host.request('cache.revision'), 41)
    await assert.rejects(host.request('tools.install'), /not allowed/)
    await assert.rejects(host.request('inventory.report'), /not allowed/)
    const failing = linkPair(
      {
        requests: {
          boom: () => {
            throw new Error('Exploded')
          },
        },
      },
      {},
    )
    await assert.rejects(failing[1].request('boom'), /Exploded/)
    await assert.rejects(
      failing[1].request('slow', undefined, 1),
      (error: LinkError) =>
        error.code === 'timeout' || error.code === 'not_allowed',
    )
    for (const link of [toWorker, fromMaster, masterForHost, host, ...failing])
      link.close()
    await assert.rejects(
      toWorker.request('tools.install'),
      (error: LinkError) => error.code === 'closed',
    )
    assert.throws(() => toWorker.event('x'), /closed/)
    assert.throws(() => toWorker.openStream('x'), /closed/)
  })

  it('closes on malformed, oversize, unknown or duplicate messages', async () => {
    const cases: Array<[string, Frame]> = [
      ['malformed', '{not json'],
      ['unknown kind', JSON.stringify({ kind: 'bogus' })],
      ['not an object', '42'],
      [
        'oversize',
        JSON.stringify({
          kind: 'event',
          method: 'x',
          params: 'y'.repeat(MAX_MESSAGE),
        }),
      ],
      [
        'bad request id',
        JSON.stringify({ kind: 'request', id: 2, method: 'x' }),
      ],
      ['bad method', JSON.stringify({ kind: 'request', id: 1, method: 5 })],
      [
        'unknown response',
        JSON.stringify({ kind: 'response', id: 99, result: 1 }),
      ],
      ['bad event', JSON.stringify({ kind: 'event', method: 5 })],
      [
        'bad stream id',
        JSON.stringify({ kind: 'stream', op: 'open', stream: -1 }),
      ],
      ['short frame', Buffer.alloc(2)],
    ]
    for (const [name, frame] of cases) {
      const wire = new TestWire()
      const link = new Link(wire, {
        localRole: 'worker',
        peerRole: 'master',
        dialer: false,
        methods: {},
      })
      wire.inject(frame)
      assert.deepEqual(wire.closes, [CLOSE.protocol], name)
      assert(link.closed)
    }
    const wire = new TestWire()
    new Link(wire, {
      localRole: 'worker',
      peerRole: 'master',
      dialer: false,
      methods: { requests: { echo: (p): unknown => p } },
    })
    wire.inject(JSON.stringify({ kind: 'request', id: 1, method: 'echo' }))
    wire.inject(JSON.stringify({ kind: 'request', id: 1, method: 'echo' }))
    assert.deepEqual(wire.closes, [CLOSE.protocol])
    const big = new TestWire()
    const link = new Link(big, {
      localRole: 'master',
      peerRole: 'worker',
      dialer: true,
      methods: {},
    })
    await assert.rejects(
      link.request('x', 'z'.repeat(MAX_MESSAGE)),
      /too large/,
    )
    big.inject(
      JSON.stringify({ kind: 'stream', op: 'credit', stream: 5, bytes: 1 }),
    )
    assert.deepEqual(big.closes, [])
    const stream = link.openStream('upload')
    big.inject(
      JSON.stringify({
        kind: 'stream',
        op: 'credit',
        stream: stream.id,
        bytes: STREAM_WINDOW + 1,
      }),
    )
    assert.deepEqual(big.closes, [CLOSE.protocol])
    const other = new TestWire()
    const second = new Link(other, {
      localRole: 'master',
      peerRole: 'worker',
      dialer: true,
      methods: {},
    })
    const s2 = second.openStream('upload')
    other.inject(
      JSON.stringify({ kind: 'stream', op: 'nonsense', stream: s2.id }),
    )
    assert.deepEqual(other.closes, [CLOSE.protocol])
    const dup = new TestWire()
    new Link(dup, {
      localRole: 'worker',
      peerRole: 'master',
      dialer: false,
      methods: { streams: { s: (): void => undefined } },
    })
    dup.inject(
      JSON.stringify({ kind: 'stream', op: 'open', stream: 1, method: 's' }),
    )
    dup.inject(
      JSON.stringify({ kind: 'stream', op: 'open', stream: 1, method: 's' }),
    )
    assert.deepEqual(dup.closes, [CLOSE.protocol])
  })

  it('streams bulk data within the credit window and aborts cleanly', async () => {
    let received = 0
    let consumed = 0
    let maxOutstanding = 0
    const [m, w] = linkPair(
      {},
      {
        streams: {
          upload: async (stream) => {
            stream.on('data', (chunk: Buffer) => (consumed += chunk.length))
            const data = await stream.collect()
            received = data.length
            await stream.write(Buffer.from('thanks'))
            stream.end()
          },
          refuse: (stream) => stream.abort('No space'),
          crash: () => {
            throw new Error('Handler crashed')
          },
        },
      },
    )
    const stream = m.openStream('upload', { name: 'stash' })
    const reply = stream.collect()
    const chunk = Buffer.alloc(STREAM_WINDOW * 3 + 17, 7)
    let sent = 0
    const original = m.sendFrame.bind(m)
    m.sendFrame = (frame: Buffer): void => {
      sent += frame.length - 4
      maxOutstanding = Math.max(maxOutstanding, sent - consumed)
      original(frame)
    }
    await stream.write(chunk)
    stream.end()
    stream.end()
    assert.equal((await reply).toString(), 'thanks')
    assert.equal(received, chunk.length)
    assert(maxOutstanding <= STREAM_WINDOW)
    assert(maxOutstanding > 0)
    await assert.rejects(stream.write(Buffer.from('late')), /ended/)
    const refused = m.openStream('refuse')
    await assert.rejects(refused.collect(), /^Error: No space$/)
    await assert.rejects(refused.write(Buffer.from('x')), /No space/)
    const crashed = m.openStream('crash')
    await assert.rejects(crashed.collect(), /Handler crashed/)
    const unknown = m.openStream('nothing-here')
    await assert.rejects(unknown.collect(), /nothing-here is not allowed/)
    const limited = w.openStream('upload')
    limited.abort()
    limited.abort()
    const capped = m.openStream('upload')
    m.close()
    await assert.rejects(capped.collect(), /closed/)
  })

  it('caps collected streams and closes a link whose heartbeat goes unanswered', async () => {
    const [m] = linkPair(
      {},
      {
        streams: {
          flood: async (stream) => {
            await stream.write(Buffer.alloc(100))
            stream.end()
          },
        },
      },
    )
    await assert.rejects(m.openStream('flood').collect(10), /too large/)
    m.close()
    const wire = new TestWire()
    wire.ping = (): void => undefined
    const link = new Link(wire, {
      localRole: 'master',
      peerRole: 'worker',
      dialer: true,
      methods: {},
      heartbeatMs: 20,
    })
    await once(link, 'close')
    assert.deepEqual(wire.closes, [CLOSE.heartbeat])
    const answered = new TestWire()
    let pings = 0
    answered.ping = (): void => {
      pings++
      setImmediate(() => answered.pong())
    }
    const alive = new Link(answered, {
      localRole: 'master',
      peerRole: 'worker',
      dialer: true,
      methods: {},
      heartbeatMs: 10,
    })
    await until(() => pings >= 5)
    assert.equal(alive.closed, false)
    alive.close()
  })

  it('backs off redials with jitter up to a cap, and the master has no link listener', async () => {
    const m = await master('m', { redialBaseMs: 1000 })
    try {
      assert.equal(m.link, undefined)
      const delays = Array.from({ length: 200 }, () =>
        m.registry!.redialDelay(1),
      )
      assert(Math.min(...delays) >= 750 && Math.max(...delays) <= 1250)
      assert(new Set(delays).size > 10)
      assert(
        m.registry!.redialDelay(4) >= 6000 &&
          m.registry!.redialDelay(4) <= 10000,
      )
      for (let i = 0; i < 50; i++) assert(m.registry!.redialDelay(20) <= 60000)
      assert.equal(m.registry!.redialDelay(0) <= 1250, true)
    } finally {
      await m.close()
    }
  })

  it('behaves the same in process and over the network', async () => {
    const methods: MethodTable = { requests: { double: (n) => Number(n) * 2 } }
    const workerMethods: MethodTable = {
      requests: { triple: (n) => Number(n) * 3 },
      streams: {
        echo: async (stream) => {
          await stream.write(await stream.collect())
          stream.end()
        },
      },
    }
    const exercise = async (master: Link, node: Link): Promise<void> => {
      assert.equal(await master.request('triple', 2), 6)
      assert.equal(await node.request('double', 5), 10)
      await assert.rejects(node.request('triple', 1), /not allowed/)
      const stream = master.openStream('echo')
      const back = stream.collect()
      await stream.write(Buffer.from('round trip'))
      stream.end()
      assert.equal((await back).toString(), 'round trip')
    }
    const [a, b] = linkPair(methods, workerMethods)
    await exercise(a, b)
    const node = await worker('w', { nodeMethods: workerMethods })
    const m = await master('m', { masterMethods: () => methods })
    try {
      const record = await m.registry!.add(addressOf(node), keyOf(node))
      await exercise(
        m.registry!.link(record.fingerprint)!,
        node.links!.current()!,
      )
    } finally {
      await m.close()
      await node.close()
    }
    // `mason master --worker` links its worker in process.
    const both = await master('mw', {
      coWorker: true,
      nodeMethods: workerMethods,
      masterMethods: () => methods,
    })
    try {
      const local = both.registry!.list()
      assert.equal(local.length, 1)
      assert.equal(local[0]!.host, IN_PROCESS)
      assert.equal(local[0]!.version, version)
      assert.equal(local[0]!.connected, true)
      await exercise(
        both.registry!.link(local[0]!.fingerprint)!,
        both.localWorker!,
      )
      both.registry!.start()
    } finally {
      await both.close()
    }
  })

  it('adds, lists and removes nodes from the command line', async () => {
    const node = await worker('w')
    const m = await master('m')
    const lines: string[] = []
    const errors: string[] = []
    const io: MainIO = {
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
      system: () => {
        throw new Error('unused')
      },
      stopped: async () => undefined,
      program: () => [],
    }
    try {
      assert.equal(await nodeMain(['nodes', 'list', '--data', m.dir], io), 0)
      assert.equal(lines.pop(), 'No nodes are paired.')
      assert.equal(
        await nodeMain(
          [
            'nodes',
            'add',
            '--data',
            m.dir,
            '--address',
            addressOf(node),
            '--key',
            keyOf(node),
          ],
          io,
        ),
        0,
      )
      assert.match(
        lines.pop()!,
        new RegExp(
          `^Paired worker .* \\(${node.identity.fingerprint}\\) at 127\\.0\\.0\\.1:${node.link!.port}$`,
        ),
      )
      assert.equal(await nodeMain(['nodes', 'list', '--data', m.dir], io), 0)
      assert.match(
        lines.pop()!,
        new RegExp(`^${node.identity.fingerprint}  worker  .*  linked$`),
      )
      assert.equal(
        await nodeMain(['nodes', 'list', '--data', m.dir, '--json'], io),
        0,
      )
      assert.equal(
        JSON.parse(lines.pop()!)[0].fingerprint,
        node.identity.fingerprint,
      )
      assert.equal(
        await nodeMain(
          ['nodes', 'add', '--data', m.dir, '--address', addressOf(node)],
          io,
        ),
        1,
      )
      assert.match(errors.pop()!, /Usage: mason nodes add/)
      assert.equal(
        await nodeMain(
          ['nodes', 'remove', node.identity.fingerprint, '--data', m.dir],
          io,
        ),
        0,
      )
      assert.equal(lines.pop(), `Removed ${node.identity.fingerprint}`)
      assert.equal(
        await nodeMain(
          ['nodes', 'remove', node.identity.fingerprint, '--data', m.dir],
          io,
        ),
        1,
      )
      assert.match(errors.pop()!, /No such node/)
      assert.equal(
        await nodeMain(['nodes', 'frobnicate', '--data', m.dir], io),
        1,
      )
      assert.match(errors.pop()!, /^Usage:/)
      // A worker has no nodes; a stopped master says it is not running.
      assert.equal(await nodeMain(['nodes', 'list', '--data', node.dir], io), 1)
      assert.match(errors.pop()!, /Unknown control command/)
      await m.close()
      assert.equal(await nodeMain(['nodes', 'list', '--data', m.dir], io), 1)
      assert.match(errors.pop()!, /not running/)
    } finally {
      await m.close()
      await node.close()
    }
  })

  it('pins the identity of a node at pairing, not its address', async () => {
    const node = await worker('w')
    const m = await master('m')
    try {
      const record = await m.registry!.add(addressOf(node), keyOf(node))
      assert.equal(
        (
          m
            .registry!.db.prepare(
              'SELECT certificate_hash FROM nodes WHERE id=?',
            )
            .get(record.id) as { certificate_hash: string }
        ).certificate_hash,
        certificateDigest(
          Buffer.from(
            node.identity.cert.split('\n').slice(1, -2).join(''),
            'base64',
          ),
        ),
      )
      const imposterIdentity: Identity = loadIdentity(
        prepareDataDir(path.join(root, 'imposter')),
      )
      assert.notEqual(imposterIdentity.fingerprint, record.fingerprint)
    } finally {
      await m.close()
      await node.close()
    }
  })
})
