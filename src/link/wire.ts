import type { WebSocket } from 'ws'

export type Frame = string | Buffer
export type Receiver = (data: Frame) => void

/**
 * Frames in both directions. Incoming frames wait in a queue while no
 * receiver is attached, so nothing is lost between the handshake and the
 * link that follows it.
 */
export abstract class Wire {
  private receiver: Receiver | undefined
  private queue: Frame[] = []
  private closeListeners: Array<() => void> = []
  private pongListeners: Array<() => void> = []
  closed = false

  abstract send(data: Frame): void
  abstract close(code: number): void
  /** Sends a heartbeat the peer answers with a pong; absent in process. */
  ping?(): void

  /** Attaches (or detaches) the consumer, delivering queued frames first. */
  setReceiver(receiver: Receiver | undefined): void {
    this.receiver = receiver
    while (
      this.receiver === receiver &&
      receiver != null &&
      this.queue.length > 0
    )
      receiver(this.queue.shift()!)
  }
  onClose(listener: () => void): void {
    if (this.closed) listener()
    else this.closeListeners.push(listener)
  }
  offClose(listener: () => void): void {
    this.closeListeners = this.closeListeners.filter(
      (item) => item !== listener,
    )
  }
  onPong(listener: () => void): void {
    this.pongListeners.push(listener)
  }

  protected deliver(data: Frame): void {
    if (this.receiver == null) this.queue.push(data)
    else this.receiver(data)
  }
  protected closedByPeer(): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners.splice(0)) listener()
  }
  protected ponged(): void {
    for (const listener of this.pongListeners) listener()
  }
}

/** A wire over a WebSocket. Close reasons are always empty. */
export class WebSocketWire extends Wire {
  constructor(private readonly socket: WebSocket) {
    super()
    socket.on('message', (data, binary) => {
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data)
      this.deliver(binary ? buffer : buffer.toString('utf8'))
    })
    socket.on('close', () => this.closedByPeer())
    socket.on('error', () => socket.terminate())
    socket.on('pong', () => this.ponged())
  }
  send(data: Frame): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return
    this.socket.send(data, { binary: typeof data !== 'string' })
  }
  close(code: number): void {
    if (this.closed) return
    this.socket.close(code)
    // A peer that never answers the close is cut off.
    setTimeout(() => this.socket.terminate(), 2000).unref()
    this.closedByPeer()
  }
  ping(): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.ping()
  }
}

class MemoryWire extends Wire {
  peer!: MemoryWire
  send(data: Frame): void {
    if (this.closed) return
    // Frames are copied and delivered asynchronously, as over a network.
    const copy = typeof data === 'string' ? data : Buffer.from(data)
    setImmediate(() => {
      if (!this.peer.closed) this.peer.deliver(copy)
    })
  }
  close(): void {
    if (this.closed) return
    this.closedByPeer()
    setImmediate(() => this.peer.closedByPeer())
  }
}

/** Two connected in-process wires, for roles sharing one process. */
export function memoryPair(): [Wire, Wire] {
  const left = new MemoryWire()
  const right = new MemoryWire()
  left.peer = right
  right.peer = left
  return [left, right]
}
