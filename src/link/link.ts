import { EventEmitter } from 'node:events'
import type { Frame, Wire } from './wire.js'

/** Link protocol major version; peers with another major are refused. */
export const PROTOCOL_MAJOR = 1
/** Largest JSON message. */
export const MAX_MESSAGE = 1024 * 1024
/** Bytes a stream receiver grants before the sender must wait. */
export const STREAM_WINDOW = 1024 * 1024
/** Largest binary chunk. */
export const MAX_CHUNK = 256 * 1024

export type Role = 'master' | 'worker' | 'host'

/** Codes a link closes with; the reason is always empty. */
export const CLOSE = {
  normal: 1000,
  protocol: 4000,
  refused: 4001,
  replaced: 4002,
  removed: 4003,
  heartbeat: 4004,
}

export class LinkError extends Error {
  constructor(
    message: string,
    readonly code: 'not_allowed' | 'failed' | 'closed' | 'timeout' = 'failed',
  ) {
    super(message)
  }
}

export type Handler = (
  params: unknown,
  link: Link,
) => Promise<unknown> | unknown
export type StreamHandler = (
  stream: Stream,
  params: unknown,
  link: Link,
) => Promise<void> | void

/** Methods one role accepts from one peer role. */
export interface MethodTable {
  requests?: Record<string, Handler>
  events?: Record<string, Handler>
  streams?: Record<string, StreamHandler>
}

type Message =
  | { kind: 'request'; id: number; method: string; params?: unknown }
  | {
      kind: 'response'
      id: number
      result?: unknown
      error?: string
      code?: string
    }
  | { kind: 'event'; method: string; params?: unknown }
  | {
      kind: 'stream'
      op: 'open' | 'credit' | 'end' | 'abort'
      stream: number
      method?: string
      params?: unknown
      bytes?: number
      /** Why a stream was aborted, for the other end's error. */
      reason?: string
    }

/**
 * A bulk-data stream inside a link. Data travels in binary frames; the
 * receiver grants credit as it consumes, and a writer waits when the credit
 * runs out.
 */
export class Stream extends EventEmitter {
  private credit = 0
  private waiters: Array<() => void> = []
  /** This end finished sending. */
  private sendEnded = false
  /** The peer finished sending. */
  private receiveEnded = false
  private aborted: string | undefined
  constructor(
    readonly id: number,
    private readonly link: Link,
  ) {
    super()
  }
  /** Writes one chunk, waiting for credit first. */
  async write(chunk: Buffer): Promise<void> {
    for (let offset = 0; offset < chunk.length; ) {
      if (this.aborted != null) throw new LinkError(this.aborted, 'closed')
      if (this.sendEnded) throw new LinkError('Stream ended', 'closed')
      if (this.credit === 0) {
        await new Promise<void>((resolve) => this.waiters.push(resolve))
        continue
      }
      const size = Math.min(chunk.length - offset, this.credit, MAX_CHUNK)
      const header = Buffer.alloc(4)
      header.writeUInt32BE(this.id)
      this.link.sendFrame(
        Buffer.concat([header, chunk.subarray(offset, offset + size)]),
      )
      this.credit -= size
      offset += size
    }
  }
  /** Ends this end's sending; the peer may still send until it ends too. */
  end(): void {
    if (this.sendEnded || this.aborted != null) return
    this.sendEnded = true
    this.link.sendMessage({ kind: 'stream', op: 'end', stream: this.id })
    if (this.receiveEnded) this.link.forgetStream(this.id)
  }
  abort(reason = 'Stream aborted'): void {
    if (this.aborted != null) return
    this.receiveAbort(reason)
    this.link.sendMessage({
      kind: 'stream',
      op: 'abort',
      stream: this.id,
      reason: reason.slice(0, 500),
    })
  }
  /** Reads every chunk until the end; rejects if the stream is aborted. */
  async collect(limit = Number.MAX_SAFE_INTEGER): Promise<Buffer> {
    if (this.aborted != null) throw new LinkError(this.aborted, 'closed')
    if (this.receiveEnded) return Buffer.alloc(0)
    const chunks: Buffer[] = []
    let size = 0
    return await new Promise<Buffer>((resolve, reject) => {
      this.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          this.abort('Stream too large')
          return
        }
        chunks.push(chunk)
      })
      this.once('end', () => resolve(Buffer.concat(chunks)))
      this.once('abort', (reason: string) =>
        reject(new LinkError(reason, 'closed')),
      )
    })
  }
  /** @internal */
  receiveData(chunk: Buffer): void {
    this.emit('data', chunk)
    // Consumed data is granted back to the writer.
    this.link.sendMessage({
      kind: 'stream',
      op: 'credit',
      stream: this.id,
      bytes: chunk.length,
    })
  }
  /** @internal */
  receiveCredit(bytes: number): void {
    this.credit += bytes
    for (const wake of this.waiters.splice(0)) wake()
  }
  /** @internal */
  receiveEnd(): void {
    if (this.receiveEnded) return
    this.receiveEnded = true
    this.emit('end')
    if (this.sendEnded) this.link.forgetStream(this.id)
  }
  /** @internal */
  receiveAbort(reason: string): void {
    if (this.aborted != null) return
    this.aborted = reason
    for (const wake of this.waiters.splice(0)) wake()
    this.emit('abort', reason)
    this.link.forgetStream(this.id)
  }
}

export interface LinkOptions {
  localRole: Role
  peerRole: Role
  /** Who opened the transport; the master always does. */
  dialer: boolean
  methods: MethodTable
  /** Heartbeat interval; a missing reply by the next beat closes the link. */
  heartbeatMs?: number
  requestTimeoutMs?: number
  /** Facts learned in the handshake. */
  peer?: { fingerprint: string; version: string; hostname?: string }
}

/**
 * One authenticated link between two roles. Requests and events flow in both
 * directions; each side accepts only the methods its table registers for
 * the peer's role and closes on any protocol violation.
 */
export class Link extends EventEmitter {
  private nextId: number
  private nextStream: number
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  private seen = new Set<number>()
  private streams = new Map<number, Stream>()
  private heartbeat: NodeJS.Timeout | undefined
  private awaitingPong = false
  closed = false
  readonly localRole: Role
  readonly peerRole: Role
  readonly peer: LinkOptions['peer']
  constructor(
    private readonly wire: Wire,
    private readonly options: LinkOptions,
  ) {
    super()
    this.localRole = options.localRole
    this.peerRole = options.peerRole
    this.peer = options.peer
    // Each side numbers its requests and streams in its own parity.
    this.nextId = options.dialer ? 1 : 2
    this.nextStream = options.dialer ? 1 : 2
    wire.onClose(() => this.shutdown())
    wire.onPong(() => {
      this.awaitingPong = false
    })
    const beat = options.heartbeatMs ?? 15000
    if (wire.ping != null && beat > 0) {
      this.heartbeat = setInterval(() => {
        if (this.awaitingPong) {
          this.close(CLOSE.heartbeat)
          return
        }
        this.awaitingPong = true
        wire.ping!()
      }, beat)
      this.heartbeat.unref()
    }
    wire.setReceiver((data) => this.receive(data))
  }

  /** Sends a request and resolves with the peer's result. */
  async request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed) throw new LinkError('Link closed', 'closed')
    const id = this.nextId
    this.nextId += 2
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(new LinkError(`${method} timed out`, 'timeout'))
        },
        timeoutMs ?? this.options.requestTimeoutMs ?? 60000,
      )
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      this.sendMessage({
        kind: 'request',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })
    })
  }

  /** Sends an event; nothing is returned. */
  event(method: string, params?: unknown): void {
    if (this.closed) throw new LinkError('Link closed', 'closed')
    this.sendMessage({
      kind: 'event',
      method,
      ...(params === undefined ? {} : { params }),
    })
  }

  /** Opens a stream to the peer's stream handler for `method`. */
  openStream(method: string, params?: unknown): Stream {
    if (this.closed) throw new LinkError('Link closed', 'closed')
    const id = this.nextStream
    this.nextStream += 2
    const stream = new Stream(id, this)
    this.streams.set(id, stream)
    this.sendMessage({
      kind: 'stream',
      op: 'open',
      stream: id,
      method,
      ...(params === undefined ? {} : { params }),
    })
    // Streams carry data both ways; each end grants the other a window.
    this.sendMessage({
      kind: 'stream',
      op: 'credit',
      stream: id,
      bytes: STREAM_WINDOW,
    })
    return stream
  }

  close(code = CLOSE.normal): void {
    if (this.closed) return
    this.wire.close(code)
    this.shutdown()
  }

  /** @internal */
  sendMessage(message: Message): void {
    if (this.closed) return
    const text = JSON.stringify(message)
    if (Buffer.byteLength(text) > MAX_MESSAGE)
      throw new LinkError('Message too large')
    this.wire.send(text)
  }
  /** @internal */
  sendFrame(frame: Buffer): void {
    if (!this.closed) this.wire.send(frame)
  }
  /** @internal */
  forgetStream(id: number): void {
    this.streams.delete(id)
  }

  private violation(): void {
    this.close(CLOSE.protocol)
  }

  private receive(data: Frame): void {
    if (this.closed) return
    if (typeof data !== 'string') {
      if (data.length < 4 || data.length > MAX_CHUNK + 4)
        return this.violation()
      // Frames for a stream that just closed are dropped.
      this.streams
        .get(data.readUInt32BE(0))
        ?.receiveData(Buffer.from(data.subarray(4)))
      return
    }
    if (Buffer.byteLength(data) > MAX_MESSAGE) return this.violation()
    let message: Message
    try {
      message = JSON.parse(data) as Message
    } catch {
      return this.violation()
    }
    if (message == null || typeof message !== 'object') return this.violation()
    switch (message.kind) {
      case 'request':
        return this.receiveRequest(message)
      case 'response':
        return this.receiveResponse(message)
      case 'event':
        return this.receiveEvent(message)
      case 'stream':
        return this.receiveStream(message)
      default:
        return this.violation()
    }
  }

  private receiveRequest(message: Extract<Message, { kind: 'request' }>): void {
    const { id, method } = message
    // Requests from the peer carry the peer's parity and are never reused.
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      (id % 2 === 1) !== !this.options.dialer ||
      this.seen.has(id) ||
      typeof method !== 'string'
    )
      return this.violation()
    this.seen.add(id)
    const handler = Object.hasOwn(this.options.methods.requests ?? {}, method)
      ? this.options.methods.requests![method]
      : undefined
    if (handler == null) {
      this.sendMessage({
        kind: 'response',
        id,
        error: `${method} is not allowed`,
        code: 'not_allowed',
      })
      return
    }
    void (async (): Promise<void> => {
      try {
        const result = await handler(message.params, this)
        this.sendMessage({ kind: 'response', id, result: result ?? null })
      } catch (error) {
        this.sendMessage({
          kind: 'response',
          id,
          error: error instanceof Error ? error.message : 'Request failed',
        })
      }
    })()
  }

  private receiveResponse(
    message: Extract<Message, { kind: 'response' }>,
  ): void {
    const pending = this.pending.get(message.id)
    if (pending == null) return this.violation()
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error != null)
      pending.reject(
        new LinkError(
          message.error,
          message.code === 'not_allowed' ? 'not_allowed' : 'failed',
        ),
      )
    else pending.resolve(message.result)
  }

  private receiveEvent(message: Extract<Message, { kind: 'event' }>): void {
    if (typeof message.method !== 'string') return this.violation()
    const handler = Object.hasOwn(
      this.options.methods.events ?? {},
      message.method,
    )
      ? this.options.methods.events![message.method]
      : undefined
    if (handler == null) {
      this.emit('refused', message.method)
      return
    }
    void (async (): Promise<void> => {
      try {
        await handler(message.params, this)
      } catch (error) {
        this.emit('error', error)
      }
    })()
  }

  private receiveStream(message: Extract<Message, { kind: 'stream' }>): void {
    const { op, stream: id } = message
    if (!Number.isSafeInteger(id) || id < 1) return this.violation()
    if (op === 'open') {
      const handler =
        typeof message.method === 'string' &&
        Object.hasOwn(this.options.methods.streams ?? {}, message.method)
          ? this.options.methods.streams![message.method]
          : undefined
      if ((id % 2 === 1) !== !this.options.dialer || this.streams.has(id))
        return this.violation()
      const stream = new Stream(id, this)
      this.streams.set(id, stream)
      if (handler == null) {
        stream.abort(`${String(message.method)} is not allowed`)
        return
      }
      this.sendMessage({
        kind: 'stream',
        op: 'credit',
        stream: id,
        bytes: STREAM_WINDOW,
      })
      void (async (): Promise<void> => {
        try {
          await handler(stream, message.params, this)
        } catch (error) {
          stream.abort(error instanceof Error ? error.message : 'Stream failed')
        }
      })()
      return
    }
    const stream = this.streams.get(id)
    if (stream == null) return
    if (op === 'credit') {
      if (
        !Number.isSafeInteger(message.bytes) ||
        message.bytes! < 1 ||
        message.bytes! > STREAM_WINDOW
      )
        return this.violation()
      stream.receiveCredit(message.bytes!)
    } else if (op === 'end') stream.receiveEnd()
    else if (op === 'abort')
      stream.receiveAbort(
        typeof message.reason === 'string' && message.reason !== ''
          ? message.reason.slice(0, 500)
          : 'Stream aborted by peer',
      )
    else this.violation()
  }

  private shutdown(): void {
    if (this.closed) return
    this.closed = true
    if (this.heartbeat != null) clearInterval(this.heartbeat)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new LinkError('Link closed', 'closed'))
    }
    this.pending.clear()
    for (const stream of this.streams.values())
      stream.receiveAbort('Link closed')
    this.streams.clear()
    this.emit('close')
  }
}
