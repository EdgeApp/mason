// A fake /live for the web app's LiveClient: sockets the test opens,
// answers and closes, and timers it runs by hand.
import type { LiveFrame } from '../../shared/live.js'
import type { LiveSocket, LiveWindow } from '../live/LiveClient.js'

/** One socket the client opened, with what it sent. */
export class FakeSocket implements LiveSocket {
  readonly sent: unknown[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(readonly url: string) {}

  send(text: string): void {
    this.sent.push(JSON.parse(text))
  }

  close(): void {
    this.closed = true
  }

  /** The node accepts the socket. */
  accept(): void {
    this.onopen?.()
  }

  /** The node sends a frame (or raw text). */
  frame(frame: LiveFrame | string): void {
    this.onmessage?.({
      data: typeof frame === 'string' ? frame : JSON.stringify(frame),
    })
  }

  /** The node closes the socket with a code. */
  drop(code = 1006): void {
    this.onclose?.({ code })
  }
}

/** The window a LiveClient runs in: sockets and timers under the test's control. */
export class FakeLiveWindow implements LiveWindow {
  readonly sockets: FakeSocket[] = []
  readonly timers = new Map<number, { run: () => void; ms: number }>()
  private next = 0

  open = (url: string): LiveSocket => {
    const socket = new FakeSocket(url)
    this.sockets.push(socket)
    return socket
  }

  setTimeout = (run: () => void, ms: number): unknown => {
    this.next += 1
    this.timers.set(this.next, { run, ms })
    return this.next
  }

  clearTimeout = (timer: unknown): void => {
    this.timers.delete(timer as number)
  }

  /** The newest socket. */
  get socket(): FakeSocket {
    const socket = this.sockets[this.sockets.length - 1]
    if (socket == null) throw new Error('No socket was opened')
    return socket
  }

  /** Runs every pending timer once, returning their delays. */
  tick(): number[] {
    const due = [...this.timers.entries()]
    this.timers.clear()
    for (const [, timer] of due) timer.run()
    return due.map(([, timer]) => timer.ms)
  }
}
