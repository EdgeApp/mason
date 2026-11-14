// A project's pages under test: the fixture project's answers, and the app
// opened at one of its addresses for a role on a node.
import { screen } from '@testing-library/react'
import type {
  ProjectApp,
  ProjectOverview,
  ProjectRuns,
} from '../../shared/api/index.js'
import type { Role } from '../../shared/permissions.js'
import {
  nodeInfo,
  renderApp,
  shellReplies,
  until,
  type Reply,
} from './render.js'

export const NOW = Date.now()
export const ALPHA = 'com.example.alpha'
export const BETA = 'com.example.beta'

/** The fixture project's overview on the master, for a manager. */
export const overviewFixture = (
  fields: Partial<ProjectOverview> = {},
): ProjectOverview => ({
  slug: 'fixture',
  name: 'Fixture',
  repository: 'git@github.com:example/fixture.git',
  defaultBranch: 'master',
  format: 'pipeline',
  apps: [
    {
      bundleId: ALPHA,
      platforms: ['ios', 'android'],
      apple: { team: 'V4AK4X7A2V' },
    },
    { bundleId: BETA, platforms: ['macos'] },
  ],
  rules: [
    { pattern: 'master', mode: 'automatic' },
    { pattern: 'release/*', mode: 'automatic' },
    { pattern: '*', mode: 'request' },
  ],
  webhook: true,
  signingLabel: 'mac-signing',
  pinned: ['master'],
  buildNumbers: [
    {
      key: 'mobile',
      format: 'YYMMDDCC',
      scope: 'app',
      apps: [ALPHA],
      last: [{ branch: '', value: '26110803' }],
    },
    {
      key: 'tv',
      format: 'N',
      scope: 'branch',
      apps: [],
      last: [
        { branch: 'develop', value: '290' },
        { branch: 'staging', value: '212' },
      ],
    },
  ],
  appNames: [
    { bundleId: ALPHA, name: 'Alpha' },
    { bundleId: BETA, name: 'Beta' },
  ],
  canSeed: true,
  secrets: true,
  workflows: [
    { name: 'build', params: {} },
    {
      name: 'release',
      params: { notes: { type: 'text', description: 'What changed.' } },
    },
  ],
  ...fields,
})

/** One run of Runs and builds. */
export const runRow = (
  number: number,
  status: string,
  fields: Partial<ProjectRuns['runs'][number]> = {},
): ProjectRuns['runs'][number] => ({
  id: `run-${number}`,
  number,
  workflow: 'build',
  branch: 'develop',
  status,
  at: NOW - 2 * 3_600_000,
  version: '4.18.2',
  buildNumber: '26110803',
  ...fields,
})

/** The fixture project's Runs and builds. */
export const runsFixture = (
  fields: Partial<ProjectRuns> = {},
): ProjectRuns => ({
  slug: 'fixture',
  name: 'Fixture',
  branches: [
    { branch: 'master', pinned: true, at: NOW - 3_600_000 },
    { branch: 'release/4.18', pinned: true },
    { branch: 'develop', pinned: false, at: NOW - 2 * 3_600_000 },
  ],
  runs: [
    runRow(182, 'running', {
      branch: 'paul/offline',
      version: '',
      buildNumber: '',
    }),
    runRow(181, 'succeeded'),
    runRow(179, 'unstable', { workflow: 'nightly', branch: 'master' }),
  ],
  more: false,
  ...fields,
})

/** Alpha's app ID page answer. */
export const appFixture = (fields: Partial<ProjectApp> = {}): ProjectApp => ({
  slug: 'fixture',
  name: 'Fixture',
  app: { id: 3, bundleId: ALPHA, name: 'Alpha', platforms: ['ios', 'android'] },
  sequence: {
    key: 'mobile',
    format: 'YYMMDDCC',
    scope: 'branch',
    apps: [ALPHA, BETA],
    last: [
      { branch: 'master', value: '26110803' },
      { branch: 'develop', value: '26110413' },
    ],
  },
  shared: [BETA],
  defaultScheme: { format: 'N', scope: 'app' },
  canSeed: true,
  ...fields,
})

/** The app at a project address, for a role on a node. */
export const openProject = (
  path: string,
  replies: Record<string, Reply>,
  role: Role = 'manager',
  node: 'master' | 'host' = 'master',
  status?: unknown,
): ReturnType<typeof renderApp> =>
  renderApp({
    node: nodeInfo(node),
    path,
    replies: shellReplies(role, node, {
      ...(status == null ? {} : { '/api/v2/status': status }),
      ...replies,
    }),
  })

/** The page's `h1` once it is drawn. */
export const heading = async (name: string | RegExp): Promise<HTMLElement> =>
  await screen.findByRole('heading', { level: 1, name })

/** An element's text without its icons' glyphs. */
export const text = (node: Element | null): string =>
  (node?.textContent ?? '').replace(/[-]/g, '')

/** The breadcrumbs' labels. */
export const crumbs = (): string[] =>
  [...document.querySelectorAll('.m-crumbs li')].map(text)

/** A tab bar's labels and the current one. */
export const tabs = (name: string): { labels: string[]; current: string } => {
  const bar = screen.getByRole('navigation', { name })
  const links = [...bar.querySelectorAll('a')]
  return {
    labels: links.map(text),
    current: text(
      links.find((link) => link.getAttribute('aria-current') === 'page') ??
        null,
    ),
  }
}

/** Bodies the fake node was sent, by `METHOD path`. */
export const sent = new Map<string, unknown>()

/** A reply that records its request's body and answers with a status. */
export const recording =
  (key: string, status: number, body: unknown) =>
  (_url: string, init: RequestInit): Response => {
    sent.set(key, JSON.parse(String(init.body ?? 'null')))
    return new Response(JSON.stringify(body), { status })
  }

/** Waits for a request, then answers what it was sent. */
export const bodyOf = async (
  app: ReturnType<typeof renderApp>,
  key: string,
): Promise<unknown> => {
  await until(() => app.node.requests.includes(key), key)
  return sent.get(key)
}
