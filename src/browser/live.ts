// One page's socket to /live on the node that served it, shared by every
// live part of the page. It reconnects after 1, 2, 4… up to 30 seconds and
// resubscribes, each subscription naming where it left off.

import { LIVE_UNAVAILABLE, type LiveFrame } from '../shared/live.js'

export { LIVE_UNAVAILABLE, type LiveFrame }

/** The parts of a WebSocket the client uses, so a test can supply them. */
export interface LiveSocket {
  send(text: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
}

/** What the client needs from the window. */
export interface LiveWindow {
  open: (url: string) => LiveSocket
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

/** The socket's state, for a page's "Reconnecting…" line. */
export type LiveState = 'open' | 'reconnecting' | 'closed' | 'unavailable'

/** Where a page's socket goes: `/live` on its own origin. */
export function liveUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live`
}

/** The wait before the next reconnect: 1, 2, 4… seconds, 30 at most. */
export const backoff = (attempt: number): number =>
  Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))

interface Subscription {
  /** The subscribe message, as of now: a log's resume point changes. */
  message: () => Record<string, unknown>
  frame: (frame: LiveFrame) => void
}

/**
 * A page's live socket. Each subscription is sent when the socket opens
 * and again on every reconnect; `end` and `gone` finish one, and the
 * socket closes when none is left. A close for policy (1008: the session
 * ended) or 4000 (no live updates here) stops reconnecting.
 */
export class LiveClient {
  private socket: LiveSocket | undefined
  /** Whether the socket has opened, so messages can be sent. */
  private open = false
  private readonly subscriptions = new Map<string, Subscription>()
  private attempt = 0
  private timer: unknown
  private stopped = false

  constructor(
    private readonly url: string,
    private readonly win: LiveWindow,
    private readonly state: (state: LiveState) => void = (): void => undefined,
  ) {}

  /** Subscribes under `key`; returns the unsubscribe. */
  subscribe(
    key: string,
    message: () => Record<string, unknown>,
    frame: (frame: LiveFrame) => void,
  ): () => void {
    const subscription = { message, frame }
    this.subscriptions.set(key, subscription)
    this.stopped = false
    if (this.socket == null && this.timer == null) this.connect()
    else this.send(key, subscription)
    return () => {
      if (this.subscriptions.get(key) !== subscription) return
      this.subscriptions.delete(key)
      this.write({ unsubscribe: key })
      if (this.subscriptions.size === 0) this.close()
    }
  }

  /** Closes the socket for good. */
  close(): void {
    this.stopped = true
    this.win.clearTimeout(this.timer)
    this.timer = undefined
    const socket = this.socket
    this.socket = undefined
    socket?.close()
    this.state('closed')
  }

  private write(message: unknown): void {
    if (this.open) this.socket?.send(JSON.stringify(message))
  }

  private send(key: string, subscription: Subscription): void {
    this.write({ ...subscription.message(), key })
  }

  private connect(): void {
    this.timer = undefined
    const socket = this.win.open(this.url)
    this.socket = socket
    this.open = false
    socket.onopen = (): void => {
      if (this.socket !== socket) return
      this.open = true
      this.state('open')
      for (const [key, subscription] of this.subscriptions)
        this.send(key, subscription)
    }
    socket.onmessage = (event): void => {
      if (this.socket !== socket) return
      // A frame means the node is serving again: the next drop waits a second.
      this.attempt = 0
      let frame: LiveFrame
      try {
        frame = JSON.parse(String(event.data)) as LiveFrame
      } catch {
        return
      }
      const subscription =
        frame.key == null ? undefined : this.subscriptions.get(frame.key)
      if (subscription == null) return
      if (frame.event === 'end' || frame.event === 'gone')
        this.subscriptions.delete(frame.key!)
      subscription.frame(frame)
      if (this.subscriptions.size === 0) this.close()
    }
    socket.onclose = (event): void => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.open = false
      if (this.stopped || event.code === 1008) {
        this.stopped = true
        this.state('closed')
        return
      }
      if (event.code === LIVE_UNAVAILABLE) {
        this.stopped = true
        this.state('unavailable')
        return
      }
      this.state('reconnecting')
      this.timer = this.win.setTimeout(
        () => this.connect(),
        backoff(this.attempt++),
      )
    }
  }
}
