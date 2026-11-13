// People and Your account under test: the people the master lists, the
// viewer's own record, and the app opened at /people or /account for a role
// on a node. The viewer is account 1 (sessionFor), Paul Puey.
import type { AccountInfo } from '../../shared/api/account.js'
import type { Person } from '../../shared/api/people.js'
import type { Role } from '../../shared/permissions.js'
import {
  fakeHasher,
  nodeInfo,
  renderApp,
  shellReplies,
  type Reply,
} from './render.js'

export const NOW = Date.now()
export const DAY = 86_400_000

export const PEOPLE = '/api/v2/people'
export const ACCOUNT = '/api/v2/account'

/** A person, with these fields over the defaults. */
export const person = (
  id: number,
  name: string,
  fields: Partial<Person> = {},
): Person => ({
  id,
  name,
  role: 'tester',
  disabled: false,
  password: false,
  emails: [],
  groups: [],
  permissionVersion: 1,
  createdAt: NOW - 30 * DAY,
  ...fields,
})

/** The master's people: the viewer, an invited developer, a tester, a disabled manager. */
export const peopleFixture = (): Person[] => [
  person(1, 'Paul Puey', {
    role: 'admin',
    username: 'paul',
    password: true,
    emails: [{ email: 'paul@example.test', confirmed: true }],
  }),
  person(2, 'Ada Lovelace', {
    role: 'developer',
    emails: [
      { email: 'ada@example.test', confirmed: true },
      { email: 'ada.l@example.test', confirmed: false },
    ],
    invitation: { expiresAt: NOW + 5 * DAY },
  }),
  person(3, 'Sam Rivera', {
    username: 'sam',
    password: true,
    emails: [{ email: 'sam@example.test', confirmed: true }],
  }),
  person(4, 'Olive Old', { role: 'manager', disabled: true }),
]

/** The viewer's own record, as `GET /api/v2/account` answers it. */
export const accountFixture = (
  fields: Partial<AccountInfo> = {},
): AccountInfo => ({
  id: 1,
  name: 'Paul Puey',
  role: 'admin',
  username: 'paul',
  password: true,
  emails: [
    { email: 'paul@example.test', confirmed: true },
    { email: 'paul@other.example.test', confirmed: false },
  ],
  editable: true,
  passwordHere: true,
  ...fields,
})

/** A reply that never comes: the page stays loading. */
export const never = (): Promise<Response> => new Promise(() => undefined)

/** People at /people for a role, with these replies over the fixture. */
export const openPeople = (
  role: Role = 'admin',
  extra: Record<string, Reply> = {},
  hasher = fakeHasher(),
): ReturnType<typeof renderApp> & {
  hasher: ReturnType<typeof fakeHasher>
} => ({
  ...renderApp({
    node: nodeInfo('master'),
    path: '/people',
    hasher,
    replies: shellReplies(role, 'master', {
      [PEOPLE]: peopleFixture(),
      ...extra,
    }),
  }),
  hasher,
})

/** Your account on a node for a role, with the record's fields and these replies. */
export const openAccount = (
  fields: Partial<AccountInfo> = {},
  node: 'master' | 'host' = 'master',
  role: Role = 'admin',
  extra: Record<string, Reply> = {},
  hasher = fakeHasher(),
): ReturnType<typeof renderApp> & {
  hasher: ReturnType<typeof fakeHasher>
} => ({
  ...renderApp({
    node: nodeInfo(node),
    path: '/account',
    hasher,
    replies: shellReplies(role, node, {
      [ACCOUNT]: accountFixture({ role, ...fields }),
      ...extra,
    }),
  }),
  hasher,
})
