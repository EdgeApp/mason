// The app's live updates: one LiveClient for the page, its state for the
// sidebar's footer, and the invalidation bus that tells useResource which
// reads a /live event made stale.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react'
import type { StatusInfo } from '../../shared/api/index.js'
import { asStatusInfo } from '../../shared/api/index.js'
import type {
  LiveClient,
  LiveFrame,
  LiveState,
  LiveSubscribe,
} from './LiveClient.js'

/**
 * What a /live event makes stale: `status` (the shell: status,
 * notifications, the sidebar's projects), `queue` (the dashboard and the
 * queue), `run` (a run and the runs lists).
 */
export type Topic = 'status' | 'queue' | 'run'

/** Who to tell when a topic's reads are stale. */
export class Invalidations {
  private readonly listeners = new Map<Topic, Set<() => void>>()

  /** Calls `listener` whenever `topic` is invalidated; returns the unsubscribe. */
  on(topic: Topic, listener: () => void): () => void {
    const set = this.listeners.get(topic) ?? new Set()
    this.listeners.set(topic, set)
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  /** Marks every read of `topic` stale. */
  invalidate(topic: Topic): void {
    for (const listener of [...(this.listeners.get(topic) ?? [])]) listener()
  }
}

interface LiveContextValue {
  client: LiveClient | undefined
  invalidations: Invalidations
}

const LiveContext = createContext<LiveContextValue>({
  client: undefined,
  invalidations: new Invalidations(),
})

/** Gives the page its live client and invalidation bus. */
export function LiveProvider({
  client,
  invalidations,
  children,
}: {
  /** None where the page has no live updates (signed out). */
  client?: LiveClient
  invalidations?: Invalidations
  children: ReactNode
}): JSX.Element {
  const [bus] = useState(() => invalidations ?? new Invalidations())
  const value = useMemo(() => ({ client, invalidations: bus }), [client, bus])
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

/** The page's invalidation bus. */
export const useInvalidations = (): Invalidations =>
  useContext(LiveContext).invalidations

/** The page's live client, if it has live updates. */
export const useLiveClient = (): LiveClient | undefined =>
  useContext(LiveContext).client

/** The live socket's state, kept current. */
export function useLiveState(): LiveState {
  const { client } = useContext(LiveContext)
  return useSyncExternalStore(
    (changed): (() => void) =>
      client?.onState(changed) ?? ((): void => undefined),
    () => client?.state ?? 'closed',
  )
}

/**
 * Subscribes to a /live topic while the component is mounted; `frame` gets
 * every frame of it. Nothing happens without a live client.
 */
export function useLive(
  key: string,
  message: LiveSubscribe | undefined,
  frame: (frame: LiveFrame) => void,
): void {
  const { client } = useContext(LiveContext)
  const handler = useRef(frame)
  handler.current = frame
  const text = message == null ? undefined : JSON.stringify(message)
  useEffect(() => {
    if (client == null || text == null) return undefined
    const subscribe = JSON.parse(text) as LiveSubscribe
    return client.subscribe(
      key,
      () => subscribe,
      (event) => handler.current(event),
    )
  }, [client, key, text])
}

/**
 * The shell's `status` subscription: the latest status the node sent, and
 * each one invalidates the shell's reads.
 */
export function useLiveStatus(): StatusInfo | undefined {
  const invalidations = useInvalidations()
  const [status, setStatus] = useState<StatusInfo | undefined>()
  const onFrame = useCallback(
    (frame: LiveFrame) => {
      if (frame.event !== 'status') return
      try {
        setStatus(asStatusInfo(frame.data))
      } catch {
        return
      }
      invalidations.invalidate('status')
    },
    [invalidations],
  )
  useLive('shell-status', { subscribe: 'status' }, onFrame)
  return status
}
