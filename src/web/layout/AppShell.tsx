// The signed-in app's frame: skip link, sidebar (wide), rail (medium), top
// bar, the page, the floating tab bar (narrow) and the ⌘K palette. It reads
// the session first (a 401 leaves for sign-in with a full load), then the
// node's status, kept current by /live.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react'
import { Outlet, useLocation, useNavigationType } from 'react-router'
import {
  asStatusInfo,
  STATUS_PATH,
  type SessionInfo,
} from '../../shared/api/index.js'
import { useApi } from '../api/context.js'
import { ApiError } from '../api/client.js'
import { useResource } from '../hooks/useResource.js'
import { useLiveState, useLiveStatus } from '../live/LiveProvider.js'
import { navFor } from '../profile/navigation.js'
import { useProfile } from '../profile/NodeProfile.js'
import { PAGE_TITLE_ID } from '../ui/PageHeader.js'
import { Skeleton, SkeletonText } from '../ui/Skeleton.js'
import { BareShell } from './BareShell.js'
import { CommandPalette } from './CommandPalette.js'
import { Maintenance, Unreachable } from './NodeStates.js'
import { Rail } from './Rail.js'
import { ShellContext, type PageMeta, type Shell } from './ShellContext.js'
import { Sidebar } from './Sidebar.js'
import { SkipLink } from './SkipLink.js'
import { TabBar } from './TabBar.js'
import { TopBar } from './TopBar.js'

/** How often the shell reads its status while /live is down. */
export const STATUS_POLL_MS = 10_000

/** Whether a key press opens the palette: ⌘K or Ctrl K, nothing else held. */
export const opensPalette = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey &&
  !event.isComposing &&
  event.key.toLowerCase() === 'k'

/** The page loading: the shell's shape, not a spinner. */
function ShellLoading(): JSX.Element {
  return (
    <BareShell>
      <div className="m-shell-loading">
        <Skeleton width="40%" height="2.5rem" />
        <SkeletonText lines={3} label="Loading Mason" />
      </div>
    </BareShell>
  )
}

/** The signed-in frame around every page. */
export function AppShell(): JSX.Element {
  const client = useApi()
  const [session, setSession] = useState<SessionInfo | undefined>()
  const [failure, setFailure] = useState<ApiError | undefined>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    client.session({ signal: abort.signal }).then(
      (info) => {
        setFailure(undefined)
        setSession(info)
      },
      (error: unknown) => {
        if (abort.signal.aborted) return
        setFailure(
          error instanceof ApiError ? error : new ApiError(0, String(error)),
        )
      },
    )
    return (): void => abort.abort()
  }, [client, attempt])
  if (session != null) return <SignedIn session={session} />
  // A 401 has already sent the browser to sign in.
  if (failure != null && failure.status !== 401)
    return (
      <Unreachable
        message={failure.message}
        retry={() => setAttempt((n) => n + 1)}
      />
    )
  return <ShellLoading />
}

/** The frame once the viewer is known. */
function SignedIn({ session }: { session: SessionInfo }): JSX.Element {
  const profile = useProfile()
  const read = useResource(STATUS_PATH, asStatusInfo)
  const live = useLiveStatus()
  // While /live is down (a host refuses it while its master is unreachable)
  // its last status is stale, so the status read stands in, read again now
  // and every few seconds until the socket is back.
  const socket = useLiveState()
  const polling = socket === 'reconnecting' || socket === 'closed'
  const { reload } = read
  useEffect(() => {
    if (!polling) return undefined
    reload()
    const timer = setInterval(reload, STATUS_POLL_MS)
    return (): void => clearInterval(timer)
  }, [polling, reload])
  const status = (polling ? undefined : live) ?? read.data
  const nav = useMemo(
    () => navFor(profile.role, session.permissions),
    [profile.role, session.permissions],
  )
  const [palette, setPalette] = useState(false)
  const [meta, setMetaState] = useState<PageMeta>({ title: '' })
  const setMeta = useCallback((next: PageMeta) => setMetaState(next), [])
  const openPalette = useCallback(() => setPalette(true), [])
  const shell = useMemo<Shell>(
    () => ({
      session,
      status,
      reloadStatus: read.reload,
      nav,
      openPalette,
      setMeta,
    }),
    [session, status, read.reload, nav, openPalette, setMeta],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!opensPalette(event)) return
      event.preventDefault()
      setPalette(true)
    }
    document.addEventListener('keydown', onKey)
    return (): void => document.removeEventListener('keydown', onKey)
  }, [])

  // On every route change, focus moves to the page's h1, which announces
  // it; a new page starts at its top, while Back keeps the browser's place.
  const { pathname } = useLocation()
  const navigation = useNavigationType()
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (navigation === 'PUSH') window.scrollTo?.(0, 0)
    document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true })
  }, [pathname, navigation])

  if (status?.link?.maintenance === true) return <Maintenance />
  return (
    <ShellContext.Provider value={shell}>
      <SkipLink />
      <div className="m-app">
        <Sidebar nav={nav} />
        <Rail nav={nav} />
        <TopBar meta={meta} />
        <main className="m-app__main" id="main" tabIndex={-1}>
          <Outlet />
        </main>
        <TabBar nav={nav} onSearch={openPalette} />
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </ShellContext.Provider>
  )
}
