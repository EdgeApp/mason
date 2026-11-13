// The administration pages under test: fixture answers for Cloud, Groups
// and Backups, and the app opened at an address for a role (or a session
// narrowed to fewer permissions) on the master.
import { screen } from '@testing-library/react'
import type { AppItem, GroupDetail } from '../../shared/api/admin.js'
import type { BackupSettingView } from '../../shared/api/backups.js'
import type { CloudAccountView } from '../../shared/api/cloud.js'
import type { Permission, Role } from '../../shared/permissions.js'
import type { GroupPerson } from '../pages/admin/groups/groupsApi.js'
import {
  nodeInfo,
  renderApp,
  sessionFor,
  shellReplies,
  until,
  type Reply,
} from './render.js'

export const NOW = Date.now()
const MINUTE = 60_000

/** A DigitalOcean account an administrator keyed, checked 5 minutes ago and OK. */
export const doAccount = (
  fields: Partial<CloudAccountView> = {},
): CloudAccountView => ({
  id: 'do-main',
  name: 'DigitalOcean',
  provider: 'digitalocean',
  key: { set: true },
  adminKeyed: true,
  check: {
    state: 'ok',
    checkedAt: NOW - 5 * MINUTE,
    digitalocean: {
      email: 'ops@example.test',
      dropletLimit: 10,
      status: 'active',
    },
  },
  ...fields,
})

/** A NoMac account, checked 5 minutes ago and OK, its spending paused. */
export const nomacAccount = (
  fields: Partial<CloudAccountView> = {},
): CloudAccountView => ({
  id: 'nomac-1',
  name: 'NoMac',
  provider: 'nomac',
  key: { set: true },
  adminKeyed: false,
  check: {
    state: 'ok',
    checkedAt: NOW - 5 * MINUTE,
    nomac: {
      credit: 42.5,
      spendableSeconds: 12.3 * 3600,
      concurrency: 1,
      spendingBlocked: true,
    },
  },
  ...fields,
})

/** Every app, the third disabled. */
export const appsFixture = (): AppItem[] => [
  { id: 1, name: 'TeamStation', slug: 'app.teamstation.app', enabled: true },
  { id: 2, name: 'TeamStation TV', slug: 'app.teamstation.tv', enabled: true },
  { id: 3, name: 'Old Kiosk', slug: 'app.teamstation.kiosk', enabled: false },
  {
    id: 4,
    name: 'Director',
    slug: 'app.teamstation.director',
    enabled: true,
  },
  { id: 5, name: 'Scoreboard', slug: 'app.teamstation.score', enabled: true },
]

/** Everyone, as `GET /api/v2/people` answers (with fields the page ignores). */
export const peopleFixture = (): Array<
  GroupPerson & { role: string; username?: string }
> => [
  {
    id: 7,
    name: 'Sam Rivera',
    role: 'tester',
    emails: [{ email: 'sam@example.test' }, { email: 'sam@home.test' }],
  },
  {
    id: 8,
    name: 'Jo Park',
    role: 'tester',
    emails: [{ email: 'jo@example.test' }],
  },
  { id: 9, name: 'Ada Lovelace', role: 'manager', emails: [] },
  {
    id: 10,
    name: 'Grace Hopper',
    role: 'developer',
    emails: [{ email: 'grace@example.test' }],
  },
]

/** The Testers group: TeamStation and TeamStation TV, Sam and Jo. */
export const groupFixture = (
  fields: Partial<GroupDetail> = {},
): GroupDetail => ({
  id: 2,
  name: 'Testers',
  apps: [
    { id: 1, slug: 'app.teamstation.app' },
    { id: 2, slug: 'app.teamstation.tv' },
  ],
  members: [7, 8],
  createdAt: NOW - 86_400_000,
  ...fields,
})

/** Backups configured and backed up with the deploy key, for an administrator who has not confirmed the key. */
export const backupFixture = (
  fields: Partial<BackupSettingView> = {},
): BackupSettingView => ({
  repository: 'git@github.com:example/mason-backup.git',
  branch: 'master',
  auth: 'deployKey',
  deployKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnly mason-backup',
  configured: true,
  backedUp: true,
  lastSuccess: {
    at: NOW - 22 * MINUTE,
    commit: '3d9e1a7c5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    kind: 'commit',
    auth: 'deployKey',
  },
  backupKey: 'mason-backup-key-v1:Q0hBTkdFIE1FIFRPIEEgUkVBTCBLRVk',
  keyConfirmed: false,
  ...fields,
})

/** A role's session without some of its permissions (a custom narrower viewer). */
export const sessionWithout = (
  role: Role,
  without: Permission[],
): ReturnType<typeof sessionFor> => {
  const session = sessionFor(role)
  return {
    ...session,
    permissions: session.permissions.filter(
      (permission) => !without.includes(permission),
    ),
  }
}

/** The app on the master at an address, for a role (or a session), with these answers. */
export const openAdmin = (
  path: string,
  replies: Record<string, Reply>,
  role: Role = 'manager',
  session?: unknown,
): ReturnType<typeof renderApp> =>
  renderApp({
    node: nodeInfo('master'),
    path,
    replies: shellReplies(role, 'master', {
      ...(session == null ? {} : { '/api/v2/session': session }),
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

/** A reply that records each body it is sent and answers from a function of it. */
export const recorder = (
  answer: (body: unknown, count: number) => { status: number; body: unknown },
): {
  bodies: unknown[]
  reply: (url: string, init: RequestInit) => Response
} => {
  const bodies: unknown[] = []
  return {
    bodies,
    reply: (_url, init): Response => {
      const body: unknown = JSON.parse(String(init.body ?? 'null'))
      bodies.push(body)
      const out = answer(body, bodies.length)
      return new Response(JSON.stringify(out.body), { status: out.status })
    },
  }
}

/** A reply that waits until released, to see a busy state. */
export const held = (
  status: number,
  body: unknown,
): {
  reply: () => Promise<Response>
  release: () => void
} => {
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    reply: async (): Promise<Response> => {
      await gate
      return new Response(JSON.stringify(body), { status })
    },
    release: () => release(),
  }
}

/** Waits until a request was made. */
export const requested = async (
  app: ReturnType<typeof renderApp>,
  key: string,
): Promise<void> => {
  await until(() => app.node.requests.includes(key), key)
}
