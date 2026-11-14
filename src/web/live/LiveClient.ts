// The app's one socket to /live on the node that served it, shared by
// every live part of the page. It reconnects after 1, 2, 4… up to
// 30 seconds and resubscribes, each subscription naming where it left off,
// and tells its listeners its state for the sidebar's footer.
import {
  LIVE_MESSAGE_BURST,
  LIVE_MESSAGES_PER_SECOND,
  LIVE_PATH,
  LIVE_TOO_MANY,
  LIVE_UNAVAILABLE,
  type LiveFrame,
  type LiveMessage,
} from '../../shared/live.js'

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

/**
 * The socket's state: `connecting` before it first opens, `open`,
 * `reconnecting` after a drop, `closed` (the session ended, or nothing is
 * subscribed) and `unavailable` (this node serves no live updates).
 */
export type LiveState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'unavailable'

/** Where a page's socket goes: `/live` on its own origin. */
export function liveUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${LIVE_PATH}`
}

/**
 * The client's own pace, below the node's budget: messages sent in time
 * still reach the node together when it falls behind (a busy event loop, a
 * lossy link, a host relaying to its master), and the headroom covers that.
 */
export const CLIENT_BURST = Math.floor((LIVE_MESSAGE_BURST * 4) / 5)
export const CLIENT_MESSAGES_PER_SECOND = Math.floor(
  (LIVE_MESSAGES_PER_SECOND * 3) / 4,
)

/** The wait before the next reconnect: 1, 2, 4… seconds, 30 at most. */
export const backoff = (attempt: number): number =>
  Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))

/** The browser's WebSocket and timers. */
export function browserLiveWindow(win: Window = window): LiveWindow {
  return {
    open: (url) =>
      new (win as Window & typeof globalThis).WebSocket(
        url,
      ) as unknown as LiveSocket,
    setTimeout: (run, ms) => win.setTimeout(run, ms),
    clearTimeout: (timer) => win.clearTimeout(timer as number),
  }
}

/** A subscribe message without its key, which the client adds. */
export type LiveSubscribe = Omit<
  Extract<LiveMessage, { subscribe: unknown }>,
  'key'
>

interface Subscription {
  /** The subscribe message, as of now: a log's resume point changes. */
  message: () => LiveSubscribe
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
  private readonly listeners = new Set<(state: LiveState) => void>()
  private attempt = 0
  private timer: unknown
  private stopped = false
  private current: LiveState = 'connecting'
  /**
   * What the client's pace still allows on this socket, as of `budgetAt`;
   * what it does not waits in `outbox` for the refill.
   */
  private budget = CLIENT_BURST
  private budgetAt = 0
  private readonly outbox: string[] = []
  private pacing: unknown

  constructor(
    private readonly url: string,
    private readonly win: LiveWindow,
  ) {}

  /** The socket's state now. */
  get state(): LiveState {
    return this.current
  }

  /** Calls `listener` on every change of state; returns the unsubscribe. */
  onState(listener: (state: LiveState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Subscribes under `key`; returns the unsubscribe. */
  subscribe(
    key: string,
    message: () => LiveSubscribe,
    frame: (frame: LiveFrame) => void,
  ): () => void {
    const subscription = { message, frame }
    this.subscriptions.set(key, subscription)
    if (this.current === 'unavailable')
      return () => this.drop(key, subscription)
    this.stopped = false
    if (this.socket == null && this.timer == null) {
      this.set(this.current === 'closed' ? 'connecting' : this.current)
      this.connect()
    } else this.send(key, subscription)
    return () => this.drop(key, subscription)
  }

  /** Closes the socket for good. */
  close(): void {
    this.stopped = true
    this.win.clearTimeout(this.timer)
    this.timer = undefined
    const socket = this.socket
    this.socket = undefined
    this.open = false
    this.unpace()
    socket?.close()
    if (this.current !== 'unavailable') this.set('closed')
  }

  private drop(key: string, subscription: Subscription): void {
    if (this.subscriptions.get(key) !== subscription) return
    this.subscriptions.delete(key)
    this.write({ unsubscribe: key })
    if (this.subscriptions.size === 0) this.close()
  }

  private set(state: LiveState): void {
    if (state === this.current) return
    this.current = state
    for (const listener of [...this.listeners]) listener(state)
  }

  private write(message: LiveMessage): void {
    if (!this.open) return
    this.outbox.push(JSON.stringify(message))
    this.flush()
  }

  /**
   * Sends what the client's pace allows and waits for its refill to send
   * the rest, so a burst (every subscription on a reconnect) stays within
   * the node's budget.
   */
  private flush(): void {
    const now = Date.now()
    const earned = Math.floor(
      ((now - this.budgetAt) * CLIENT_MESSAGES_PER_SECOND) / 1000,
    )
    if (earned > 0) {
      this.budget = Math.min(CLIENT_BURST, this.budget + earned)
      this.budgetAt = now
    }
    while (this.outbox.length > 0 && this.budget > 0) {
      this.budget -= 1
      this.socket?.send(this.outbox.shift()!)
    }
    if (this.outbox.length > 0 && this.pacing == null)
      this.pacing = this.win.setTimeout(() => {
        this.pacing = undefined
        // At least one message's worth of time has passed.
        this.budget = Math.min(CLIENT_BURST, this.budget + 1)
        this.budgetAt = Date.now()
        this.flush()
      }, 1000 / CLIENT_MESSAGES_PER_SECOND)
  }

  /**
   * The node refused a message over its budget: the client's pace starts
   * again from empty, and the subscription the refusal names is sent again
   * after the refill, or its end if the page has left it meanwhile.
   */
  private refused(key: string | undefined): void {
    this.budget = 0
    this.budgetAt = Date.now()
    this.win.clearTimeout(this.pacing)
    this.pacing = undefined
    if (key == null) this.flush()
    else {
      const subscription = this.subscriptions.get(key)
      if (subscription != null) this.send(key, subscription)
      else this.write({ unsubscribe: key })
    }
  }

  /** Forgets what waited to be sent: a new socket sends every subscription again. */
  private unpace(): void {
    this.outbox.length = 0
    this.win.clearTimeout(this.pacing)
    this.pacing = undefined
  }

  private send(key: string, subscription: Subscription): void {
    this.write({ ...subscription.message(), key } as LiveMessage)
  }

  private connect(): void {
    this.timer = undefined
    const socket = this.win.open(this.url)
    this.socket = socket
    this.open = false
    socket.onopen = (): void => {
      if (this.socket !== socket) return
      this.open = true
      this.unpace()
      this.budget = CLIENT_BURST
      this.budgetAt = Date.now()
      this.set('open')
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
      if (
        frame.event === 'error' &&
        (frame.data as { error?: unknown } | undefined)?.error === LIVE_TOO_MANY
      ) {
        this.refused(frame.key)
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
      this.unpace()
      if (this.stopped || event.code === 1008) {
        this.stopped = true
        this.set('closed')
        return
      }
      if (event.code === LIVE_UNAVAILABLE) {
        this.stopped = true
        this.set('unavailable')
        return
      }
      this.set('reconnecting')
      this.timer = this.win.setTimeout(
        () => this.connect(),
        backoff(this.attempt++),
      )
    }
  }
}
