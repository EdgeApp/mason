// The web app's entry: bundle-web.mjs builds it into app-[hash].js, which
// index.html loads as a module. It reads GET /api/v2/node, picks the node's
// profile, and mounts the router on #root (with the /_web basename inside
// that mount).
import { StrictMode, useEffect, useState, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import {
  asNodeInfo,
  NODE_PATH,
  type NodeInfo,
  type SignInFlow,
} from '../shared/api/index.js'
import { ApiClient, ApiError } from './api/client.js'
import { ApiProvider } from './api/context.js'
import {
  Maintenance,
  Unreachable,
  WaitingForMaster,
} from './layout/NodeStates.js'
import { browserLiveWindow, LiveClient, liveUrl } from './live/LiveClient.js'
import { LiveProvider } from './live/LiveProvider.js'
import { FlowPage, readFlow } from './pages/auth/Flow.js'
import {
  masterProfile,
  profileFor,
  ProfileContext,
} from './profile/NodeProfile.js'
import {
  AppRoutes,
  ServerPagesContext,
  type ServerPages,
} from './profile/routes.js'
import { ToastProvider } from './ui/Toast.js'

/** Where the master and the host mount the app beside the server pages. */
export const WEB_BASENAME = '/_web'

/** The router's basename: `/_web` inside that mount, none outside it. */
export function basenameFor(pathname: string): string | undefined {
  return pathname === WEB_BASENAME || pathname.startsWith(`${WEB_BASENAME}/`)
    ? WEB_BASENAME
    : undefined
}

export interface AppProps {
  node: NodeInfo
  client: ApiClient
  live?: LiveClient
  basename?: string
  /** A provider sign-in's state the node answered this address with. */
  flow?: SignInFlow
}

/**
 * Outside the /_web mount, the node's own pages for the addresses the app
 * has not ported: a full load of them, never of the address this document
 * was loaded at (the node answered the app there).
 */
export function serverPages(win: Window = window): ServerPages {
  return {
    here: `${win.location.pathname}${win.location.search}`,
    go: (url) => win.location.replace(url),
  }
}

/** The app for a node: its profile, client, live updates, toasts and routes. */
export function App({
  node,
  client,
  live,
  basename,
  flow,
}: AppProps): JSX.Element {
  const profile = profileFor(node)
  const [server] = useState(() =>
    basename == null ? serverPages() : undefined,
  )
  if (flow != null)
    return (
      <ProfileContext.Provider value={profile}>
        <FlowPage flow={flow} />
      </ProfileContext.Provider>
    )
  if (node.state === 'waitingForMaster')
    return (
      <ProfileContext.Provider value={profile}>
        <WaitingForMaster />
      </ProfileContext.Provider>
    )
  if (node.state === 'maintenance')
    return (
      <ProfileContext.Provider value={profile}>
        <Maintenance />
      </ProfileContext.Provider>
    )
  return (
    <ApiProvider client={client}>
      <ProfileContext.Provider value={profile}>
        <LiveProvider {...(live == null ? {} : { client: live })}>
          <ToastProvider>
            <ServerPagesContext.Provider value={server}>
              <BrowserRouter basename={basename}>
                <AppRoutes node={node} />
              </BrowserRouter>
            </ServerPagesContext.Provider>
          </ToastProvider>
        </LiveProvider>
      </ProfileContext.Provider>
    </ApiProvider>
  )
}

/** Reads which node this is, then renders the app for it. */
export function Root({
  client,
  live,
  basename,
  flow,
  onNode,
}: Omit<AppProps, 'node'> & {
  /** Told which node this is, once it answers. */
  onNode?: (node: NodeInfo) => void
}): JSX.Element {
  const [node, setNode] = useState<NodeInfo | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    client.get(NODE_PATH, asNodeInfo, { redirect: false }).then(
      (info) => {
        onNode?.(info)
        setFailure(undefined)
        setNode(info)
      },
      (error: unknown) =>
        setFailure(error instanceof ApiError ? error.message : String(error)),
    )
  }, [client, attempt, onNode])
  if (node != null)
    return (
      <App
        node={node}
        client={client}
        {...(live == null ? {} : { live })}
        {...(basename == null ? {} : { basename })}
        {...(flow == null ? {} : { flow })}
      />
    )
  if (failure != null)
    return (
      <ProfileContext.Provider value={masterProfile('')}>
        <Unreachable message={failure} retry={() => setAttempt((n) => n + 1)} />
      </ProfileContext.Provider>
    )
  return <></>
}

/** Mounts the app on the page's #root, if it has one. */
export function start(
  doc: Document = document,
  /** How a 401 leaves for sign-in: a full load, by default. */
  navigate?: (url: string) => void,
): Root | undefined {
  const element = doc.getElementById('root')
  if (element == null) return undefined
  const win = doc.defaultView ?? window
  // The node's sign-in page, known once GET /api/v2/node answers.
  let signIn: (from: string) => string = () => '/sign-in'
  const client = new ApiClient({
    signIn: (): string =>
      signIn(`${win.location.pathname}${win.location.search}`),
    ...(navigate == null ? {} : { navigate }),
  })
  const onNode = (node: NodeInfo): void => {
    signIn = profileFor(node).signIn
  }
  const live = new LiveClient(liveUrl(win.location), browserLiveWindow(win))
  const flow = readFlow(doc)
  const root = createRoot(element)
  root.render(
    <StrictMode>
      <Root
        client={client}
        live={live}
        onNode={onNode}
        {...(flow == null ? {} : { flow })}
        {...(basenameFor(win.location.pathname) == null
          ? {}
          : { basename: basenameFor(win.location.pathname)! })}
      />
    </StrictMode>,
  )
  return root
}

start()
