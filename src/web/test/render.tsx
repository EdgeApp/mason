// Renders the app, a page or a component the way the app mounts it: a fake
// node behind the typed client (a table of replies), a fake /live, a node
// profile and a session, inside a memory router.
import { render, type RenderResult } from '@testing-library/react'
import type { JSX, ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type {
  NodeInfo,
  SessionInfo,
  StatusInfo,
} from '../../shared/api/index.js'
import { permissionsOf } from '../../master/permissions.js'
import type { Role } from '../../shared/permissions.js'
import { ApiClient } from '../api/client.js'
import { ApiProvider } from '../api/context.js'
import { LiveClient } from '../live/LiveClient.js'
import { Invalidations, LiveProvider } from '../live/LiveProvider.js'
import { profileFor, ProfileContext } from '../profile/NodeProfile.js'
import { AppRoutes } from '../profile/routes.js'
import { ToastProvider } from '../ui/Toast.js'
import { FakeLiveWindow } from './fakeLiveSocket.js'

/** The permissions a role holds, from the master's own policy table, as GET /api/v2/session answers them. */
export { permissionsOf }

/** A session for a role. */
export function sessionFor(role: Role, name = 'Paul Puey'): SessionInfo {
  return {
    accountId: 1,
    name,
    role,
    csrf: 'proof',
    permissions: permissionsOf(role),
    emails: [{ email: 'paul@example.test', confirmed: true }],
  }
}

/** A node's description. */
export function nodeInfo(
  role: 'master' | 'host' = 'master',
  fields: Partial<NodeInfo> = {},
): NodeInfo {
  return {
    role,
    version: '0.6.0',
    setupNeeded: false,
    signIn: { password: true, providers: [] },
    state: 'ok',
    testEndpoints: false,
    ...fields,
  }
}

/** The master's status with a healthy cluster. */
export const masterStatus: StatusInfo = {
  node: 'master',
  cluster: { idle: 2, total: 3, healthy: true },
  banners: [],
}

/** A reply: a value answered as JSON with 200, or a status and a body, or a function of the request. */
export type Reply =
  | unknown
  | { status: number; body?: unknown }
  | ((url: string, init: RequestInit) => Response | Promise<Response>)

/** Whether a reply names its own status. */
const withStatus = (
  reply: unknown,
): reply is { status: number; body?: unknown } =>
  typeof reply === 'object' &&
  reply != null &&
  'status' in reply &&
  typeof (reply as { status: unknown }).status === 'number' &&
  Object.keys(reply).every((key) => key === 'status' || key === 'body')

/** A fake node: answers `METHOD path` (or just `path` for GET, query included) from a table. */
export function fakeNode(table: Record<string, Reply>): {
  fetch: typeof fetch
  requests: string[]
  set: (key: string, reply: Reply) => void
} {
  const requests: string[] = []
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    requests.push(`${method} ${input}`)
    if (init.signal?.aborted === true)
      throw new DOMException('aborted', 'AbortError')
    const reply =
      table[`${method} ${input}`] ??
      (method === 'GET' ? table[input] : undefined) ??
      table[`${method} ${input.replace(/\?.*$/, '')}`] ??
      (method === 'GET' ? table[input.replace(/\?.*$/, '')] : undefined)
    if (reply === undefined)
      return new Response('{"error":"No such route"}', { status: 404 })
    if (typeof reply === 'function')
      return await (reply as (url: string, init: RequestInit) => Response)(
        input,
        init,
      )
    if (withStatus(reply))
      return new Response(
        reply.body === undefined ? '' : JSON.stringify(reply.body),
        {
          status: reply.status,
        },
      )
    return new Response(JSON.stringify(reply), { status: 200 })
  }) as typeof globalThis.fetch
  return {
    fetch,
    requests,
    set: (key, reply): void => {
      table[key] = reply
    },
  }
}

/** The replies a signed-in shell reads, for a role on a node. */
export function shellReplies(
  role: Role = 'admin',
  node: 'master' | 'host' = 'master',
  extra: Record<string, Reply> = {},
): Record<string, Reply> {
  return {
    '/api/v2/session': sessionFor(role),
    '/api/v2/status':
      node === 'master'
        ? masterStatus
        : {
            node: 'host',
            link: { online: true, maintenance: false },
            banners: [],
          },
    '/api/v2/notifications': [],
    '/api/v2/dashboard': dashboard([]),
    ...extra,
  }
}

/** A dashboard answer with these projects (name, slug, running runs). */
export function dashboard(
  projects: Array<{ slug: string; name: string; running?: number }>,
): unknown {
  return {
    tiles: { projects: projects.length, apps: 0, finished: 0, storage: 0 },
    counts: {
      all: 0,
      ios: 0,
      android: 0,
      macos: 0,
      windows: 0,
      linux: 0,
      web: 0,
      tvos: 0,
      other: 0,
    },
    filter: {},
    projects: projects.map((entry, n) => ({
      id: n + 1,
      slug: entry.slug,
      name: entry.name,
      defaultBranch: 'master',
      runs: Array.from({ length: entry.running ?? 0 }, (_, k) => ({
        id: `${entry.slug}-${k}`,
        branch: 'master',
        number: k + 1,
        status: 'running',
        workflow: 'build',
      })),
      apps: [],
    })),
    queue: [],
    builds: [],
  }
}

/** Where the router is: the test's view of the address. */
export const where: { path: string } = { path: '' }

function Location(): null {
  const location = useLocation()
  where.path = `${location.pathname}${location.search}`
  return null
}

export interface Harness extends RenderResult {
  client: ApiClient
  node: ReturnType<typeof fakeNode>
  live: FakeLiveWindow
  liveClient: LiveClient
  invalidations: Invalidations
  /** Where a 401 or sign-out sent the browser. */
  left: string[]
}

export interface HarnessOptions {
  replies?: Record<string, Reply>
  node?: NodeInfo
  path?: string
  /** Render this instead of the app's routes (inside the providers and router). */
  element?: ReactNode
  /** The element's route pattern, for useParams. */
  route?: string
}

/** Renders the app's routes (or one element) for a node, at an address. */
export function renderApp(options: HarnessOptions = {}): Harness {
  const info = options.node ?? nodeInfo()
  const node = fakeNode(options.replies ?? shellReplies('admin', info.role))
  const left: string[] = []
  const client = new ApiClient({
    signIn: (): string => profileFor(info).signIn(where.path),
    fetch: node.fetch,
    navigate: (url): void => {
      left.push(url)
    },
  })
  const live = new FakeLiveWindow()
  const liveClient = new LiveClient('wss://mason.test/live', live)
  const invalidations = new Invalidations()
  const tree: JSX.Element = (
    <ApiProvider client={client}>
      <ProfileContext.Provider value={profileFor(info)}>
        <LiveProvider client={liveClient} invalidations={invalidations}>
          <ToastProvider>
            <MemoryRouter initialEntries={[options.path ?? '/']}>
              <Location />
              {options.element == null ? (
                <AppRoutes node={info} />
              ) : (
                <Routes>
                  <Route
                    path={options.route ?? '*'}
                    element={options.element}
                  />
                </Routes>
              )}
            </MemoryRouter>
          </ToastProvider>
        </LiveProvider>
      </ProfileContext.Provider>
    </ApiProvider>
  )
  const result = render(tree)
  return { ...result, client, node, live, liveClient, invalidations, left }
}

/** Waits until a condition holds, flushing React between tries. */
export async function until(
  condition: () => boolean,
  what = 'the condition',
  ms = 2000,
): Promise<void> {
  const deadline = Date.now() + ms
  const { act } = await import('react')
  for (;;) {
    let done = false
    await act(async () => {
      done = condition()
      if (!done) await new Promise((resolve) => setTimeout(resolve, 10))
    })
    if (done) return
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
  }
}

/** Sets which media queries match, for a tier or a preference; returns the restore. */
export function matchMedia(matches: (query: string) => boolean): () => void {
  const original = window.matchMedia
  const listeners = new Set<() => void>()
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        listeners.delete(listener),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
  return () => {
    window.matchMedia = original
  }
}

/** The narrow tier: phones. */
export const narrow = (query: string): boolean =>
  query.includes('max-width: 46.49em')
/** The wide tier: the sidebar. */
export const wide = (query: string): boolean =>
  query.includes('min-width: 80em')
