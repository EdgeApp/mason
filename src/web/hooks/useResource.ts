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
  /**
   * `data` answers an earlier path, whose query only differs from this one
   * (`keepAcrossQuery`): the new answer is on its way.
   */
  stale: boolean
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
  /**
   * The path's query carries a choice made on the page (a platform, a
   * filter): when only the query changes, the old answer stays, flagged
   * `stale`, until the new one arrives, so the page keeps its controls, its
   * focus and its scroll. A failed read drops it, so the page shows why.
   */
  keepAcrossQuery?: boolean
}

/** A path without its query. */
const withoutQuery = (path: string | null): string | null =>
  path?.replace(/\?.*$/, '') ?? null

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
    /** The path `data` answers. */
    answered: string | null
    data: T | undefined
    error: ApiError | undefined
    loading: boolean
  }>({
    path,
    answered: null,
    data: undefined,
    error: undefined,
    loading: path != null,
  })
  const [generation, setGeneration] = useState(0)
  const clean = useRef(cleaner)
  clean.current = cleaner
  const reload = useCallback(() => setGeneration((n) => n + 1), [])

  // A new path forgets the old answer at once, unless only its query changed
  // and the read keeps it across the query.
  if (state.path !== path) {
    const keep =
      options.keepAcrossQuery === true &&
      path != null &&
      withoutQuery(path) === withoutQuery(state.path)
    setState({
      path,
      answered: keep ? state.answered : null,
      data: keep ? state.data : undefined,
      error: undefined,
      loading: path != null,
    })
  }

  useEffect(() => {
    if (path == null) return undefined
    const abort = new AbortController()
    setState((was) => (was.loading ? was : { ...was, loading: true }))
    client.get(path, clean.current, { signal: abort.signal }).then(
      (data) => {
        if (!abort.signal.aborted)
          setState({
            path,
            answered: path,
            data,
            error: undefined,
            loading: false,
          })
      },
      (error: unknown) => {
        if (abort.signal.aborted) return
        setState((was) => ({
          ...was,
          // A kept answer belongs to another path: drop it, so the failure shows.
          ...(was.answered === path ? {} : { answered: null, data: undefined }),
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
    stale: state.data != null && state.answered !== path,
    error: state.error,
    loading: state.loading,
    reload,
  }
}
