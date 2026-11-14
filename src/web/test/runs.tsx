// A run as the node answers it for the run page, its log by number, and
// the page opened with them: the run page's web tests share these.
import { screen } from '@testing-library/react'
import type { RunLogPage, RunPage } from '../../shared/api/index.js'
import { nodeInfo, renderApp, shellReplies, type Reply } from './render.js'

const NOW = Date.now()
const START = NOW - 3_600_000
const project = { slug: 'fixture', name: 'Fixture' }

/** A finished run of three stages, a parallel pair and an approval. */
export const runFixture = (fields: Partial<RunPage> = {}): RunPage => ({
  id: 'r1',
  number: 182,
  workflow: 'build',
  branch: 'paul/offlineCache',
  commit: 'ec24b917a3c1d0ec24b917a3c1d0ec24b917a3c1',
  status: 'succeeded',
  created: START - 12_000,
  started: START,
  finished: START + 397_000,
  description: 'Fix player socket rehydration on device resume',
  reason: null,
  project,
  stages: [
    {
      name: 'checkout',
      kind: 'stage',
      status: 'succeeded',
      attempt: 1,
      started: START,
      finished: START + 21_000,
      node: 'bern',
    },
    {
      name: 'build/ios',
      kind: 'stage',
      status: 'succeeded',
      attempt: 2,
      started: START + 21_000,
      finished: START + 273_000,
      node: 'mason-android-1771',
    },
    {
      name: 'publish',
      kind: 'stage',
      status: 'succeeded',
      attempt: 1,
      started: START + 273_000,
      finished: START + 397_000,
      node: 'bern',
    },
  ],
  artifacts: [
    {
      stage: 'build/ios',
      name: 'TeamStation.ipa',
      kind: 'build',
      size: 84_100_000,
      url: 'https://host.test/runs/r1/artifacts/TeamStation.ipa',
    },
  ],
  graph: {
    stages: [
      { name: 'checkout', kind: 'stage', needs: [] },
      { name: 'build/ios', kind: 'stage', needs: ['checkout'], group: 'build' },
      { name: 'publish', kind: 'stage', needs: ['build/ios'] },
    ],
    post: [],
    approvals: {},
    params: {},
    workflows: [{ name: 'build', params: {} }],
  },
  layout: {
    bubbles: [
      {
        name: '@start',
        label: 'Start',
        kind: 'start',
        col: 0,
        row: 0,
        status: 'start',
        waitingFor: [],
        needs: [],
        dependents: [],
      },
      {
        name: 'checkout',
        label: 'checkout',
        kind: 'stage',
        col: 1,
        row: 0,
        status: 'succeeded',
        waitingFor: [],
        needs: [],
        dependents: ['build/ios'],
        node: 'bern',
        took: 21_000,
      },
      {
        name: 'build/ios',
        label: 'ios',
        kind: 'stage',
        col: 2,
        row: 0,
        status: 'succeeded',
        rowLabel: 'ios',
        waitingFor: [],
        needs: ['checkout'],
        dependents: ['publish'],
      },
      {
        name: 'publish',
        label: 'publish',
        kind: 'stage',
        col: 3,
        row: 0,
        status: 'succeeded',
        waitingFor: [],
        needs: ['build/ios'],
        dependents: [],
      },
      {
        name: '@end',
        label: 'End',
        kind: 'end',
        col: 4,
        row: 0,
        status: 'end',
        waitingFor: [],
        needs: [],
        dependents: [],
      },
    ],
    rails: [
      { from: '@start', to: 'checkout' },
      { from: 'checkout', to: 'build/ios' },
      { from: 'build/ios', to: 'publish' },
      { from: 'publish', to: '@end' },
    ],
    cols: 5,
    rows: 1,
  },
  steps: [
    {
      stage: 'build/ios',
      attempt: 2,
      id: 1,
      kind: 'sh',
      title: '\x1b[32mnpm ci\x1b[0m',
      status: 'succeeded',
      ms: 72_000,
      logStart: 0,
      logEnd: 100,
      parent: null,
    },
    {
      stage: 'build/ios',
      attempt: 2,
      id: 2,
      kind: 'section',
      title: 'Dependencies',
      status: 'succeeded',
      ms: 48_000,
      logStart: 100,
      logEnd: 200,
      parent: null,
    },
    {
      stage: 'build/ios',
      attempt: 2,
      id: 3,
      kind: 'sh',
      title: 'pod install',
      status: 'succeeded',
      ms: 41_000,
      logStart: 100,
      logEnd: 150,
      parent: 2,
    },
    {
      stage: 'build/ios',
      attempt: 1,
      id: 1,
      kind: 'sh',
      title: 'first attempt',
      status: 'failed',
      ms: 1_000,
      logStart: 0,
      logEnd: 10,
      parent: null,
    },
  ],
  history: [
    {
      id: 'r1',
      number: 182,
      status: 'succeeded',
      created: START - 12_000,
      stages: [
        { name: 'checkout', status: 'succeeded' },
        { name: 'build/ios', status: 'succeeded' },
      ],
    },
    {
      id: 'r0',
      number: 176,
      status: 'failed',
      created: START - 86_400_000,
      stages: [{ name: 'checkout', status: 'failed' }],
    },
  ],
  details: {
    trigger: 'push',
    requestedBy: 'Paul Puey',
    buildNumber: '26110902',
    params: { channel: 'testflight', notes: 'Offline cache' },
    nodes: ['bern', 'mason-android-1771'],
  },
  ...fields,
})

/** A log of `lines` lines, answering pages by number as the node does. */
export const logOf =
  (lines: number, text = (n: number): string => `line ${n}`) =>
  (url: string): Response => {
    const query = new URL(url, 'https://mason.test').searchParams
    const count = Number(query.get('count') ?? 500)
    const first =
      query.get('last') === '1'
        ? Math.max(1, lines - count + 1)
        : Math.min(Math.max(Number(query.get('from') ?? 1), 1), lines + 1)
    const body: RunLogPage = {
      start: 1,
      total: lines,
      first,
      text: Array.from(
        { length: Math.max(0, Math.min(count, lines - first + 1)) },
        (_, index) => `${text(first + index)}\n`,
      ).join(''),
      end: 0,
    }
    return new Response(JSON.stringify(body), { status: 200 })
  }

export const RUN_PATH = '/api/v2/runs/r1?include=graph,steps,history,details'

export const open = (
  path: string,
  replies: Record<string, Reply>,
  options: {
    node?: 'master' | 'host'
    role?: 'admin' | 'developer' | 'manager' | 'tester'
  } = {},
): ReturnType<typeof renderApp> =>
  renderApp({
    node: nodeInfo(options.node ?? 'master'),
    path,
    replies: shellReplies(options.role ?? 'admin', options.node ?? 'master', {
      '/api/v2/runs/r1/logs': logOf(40),
      ...replies,
    }),
  })

export const heading = async (name: string | RegExp): Promise<HTMLElement> =>
  await screen.findByRole('heading', { level: 1, name })
/** An element's text without its icons' glyphs. */
export const text = (node: Element): string =>
  (node.textContent ?? '').replace(/[-]/g, '')
