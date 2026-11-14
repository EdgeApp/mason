// A read through the typed client, kept current: it loads when its path
// changes, reloads when a /live event invalidates one of its topics, and
// keeps showing what it had while it reloads.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Cleaner } from 'cleaners'
import { useApi } from '../api/context.js'
import { ApiError } from '../api/client.js'
import { useInvalidations, type Topic } from '../live/LiveProvider.js'

export interface Resource<T> {
  /** The latest answer, kept while a reload is under way. */
  data: T | undefined
  /** Why the latest load failed, until one succeeds. */
  error: ApiError | undefined
  /** A load is under way. */
  loading: boolean
  /** Loads it again now. */
  reload: () => void
}

export interface ResourceOptions {
  /** The /live topics whose events make this read stale. */
  invalidatedBy?: Topic[]
}

/** Reads `path` (none: nothing to read yet) through the app's client and `cleaner`. */
export function useResource<T>(
  path: string | null,
  cleaner: Cleaner<T>,
  options: ResourceOptions = {},
): Resource<T> {
  const client = useApi()
  const invalidations = useInvalidations()
  const [state, setState] = useState<{
    path: string | null
    data: T | undefined
    error: ApiError | undefined
    loading: boolean
  }>({ path, data: undefined, error: undefined, loading: path != null })
  const [generation, setGeneration] = useState(0)
  const clean = useRef(cleaner)
  clean.current = cleaner
  const reload = useCallback(() => setGeneration((n) => n + 1), [])

  // A new path forgets the old answer at once.
  if (state.path !== path)
    setState({ path, data: undefined, error: undefined, loading: path != null })

  useEffect(() => {
    if (path == null) return undefined
    const abort = new AbortController()
    setState((was) => (was.loading ? was : { ...was, loading: true }))
    client.get(path, clean.current, { signal: abort.signal }).then(
      (data) => {
        if (!abort.signal.aborted)
          setState({ path, data, error: undefined, loading: false })
      },
      (error: unknown) => {
        if (abort.signal.aborted) return
        setState((was) => ({
          ...was,
          error:
            error instanceof ApiError
              ? error
              : new ApiError(0, String((error as Error)?.message ?? error)),
          loading: false,
        }))
      },
    )
    return (): void => abort.abort()
  }, [client, path, generation])

  const topics = (options.invalidatedBy ?? []).join(',')
  useEffect(() => {
    if (topics === '') return undefined
    const off = topics
      .split(',')
      .map((topic) => invalidations.on(topic as Topic, reload))
    return (): void => {
      for (const stop of off) stop()
    }
  }, [invalidations, topics, reload])

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload,
  }
}
