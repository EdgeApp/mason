import type { LiveSocket, LiveWindow } from '../browser/live.js'

/** A page's socket a test opens, feeds and drops. */
export class FakeLiveSocket implements LiveSocket {
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
  /** The node sends a frame. */
  frame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  /** The socket closes with a code. */
  drop(code: number): void {
    this.onclose?.({ code })
  }
}

/** A window whose sockets and timers a test runs by hand. */
export class FakeLiveWindow implements LiveWindow {
  readonly sockets: FakeLiveSocket[] = []
  readonly timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
  open = (url: string): FakeLiveSocket => {
    const socket = new FakeLiveSocket(url)
    this.sockets.push(socket)
    return socket
  }
  setTimeout = (run: () => void, ms: number): unknown => {
    const timer = { run, ms, cleared: false }
    this.timers.push(timer)
    return timer
  }
  clearTimeout = (timer: unknown): void => {
    if (timer != null) (timer as { cleared: boolean }).cleared = true
  }
  /** The newest socket. */
  get socket(): FakeLiveSocket {
    return this.sockets.at(-1)!
  }
  /** Runs the pending timer, returning how long it waited. */
  tick(): number {
    const timer = this.timers.find((entry) => !entry.cleared)!
    timer.cleared = true
    timer.run()
    return timer.ms
  }
}
