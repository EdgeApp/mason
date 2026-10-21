import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type express from 'express'
import { after, before, describe, it } from 'mocha'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
  type ArgonParameters,
} from '../auth/passwordProtocol.js'
import type { Stream } from '../link/link.js'
import { controlRequest } from '../node/control.js'
import { nodeMain, type MainIO } from '../node/main.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import { startNode, type RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { LOCKOUT, MasterAuth, SetupGate, SignInRefused } from './auth.js'
import { MasterDatabase } from './database.js'
import { createPasswordRecord } from './passwords.js'
import { asForwardRequest, isRunAction } from './forward.js'
import { policy, type Action } from './permissions.js'
import { localOperator, roles, type Role } from './roles.js'
import { masterApp } from './web.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const root = (name: string): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), name))
const quiet = (): void => undefined
const cliIO = (): MainIO & { lines: string[] } => {
  const lines: string[] = []
  return {
    lines,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    system: (): never => {
      throw new Error('unused')
    },
    stopped: async () => undefined,
    program: () => [],
  }
}
const parameters = (salt: string): ArgonParameters =>
  clientParameters(salt.repeat(16), DEFAULT_PASSWORD_COSTS)
const newPassword = async (
  password: string,
  salt = 'a1',
): Promise<{ clientHash: string; clientParameters: ArgonParameters }> => {
  const p = parameters(salt)
  return {
    clientHash: await clientPasswordHash(password, p),
    clientParameters: p,
  }
}

interface Reply {
  status: number
  json: Json
  text: string
  headers: { get: (name: string) => string | null }
}
/** A request to a node's web listener with an optional session cookie, CSRF proof and origin. */
async function request(
  node: RunningNode,
  method: string,
  route: string,
  options: {
    body?: unknown
    cookie?: string
    csrf?: string
    origin?: string
    bearer?: string
  } = {},
): Promise<Reply> {
  const url = node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  const response = await pinnedFetch(
    url + route,
    {
      method,
      redirect: 'manual',
      headers: {
        ...(options.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...(options.cookie == null ? {} : { cookie: options.cookie }),
        ...(options.csrf == null ? {} : { 'x-mason-csrf': options.csrf }),
        ...(options.origin == null ? {} : { origin: options.origin }),
        ...(options.bearer == null
          ? {}
          : { authorization: `Bearer ${options.bearer}` }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    },
    node.web!.certificate?.pin,
  )
  const text = await response.text()
  let json: Json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text, headers: response.headers }
}
const sessionCookie = (reply: Reply): string => {
  const set = reply.headers.get('set-cookie') ?? ''
  const match = /__Host-mason-master=([^;]+)/.exec(set)
  assert(match != null, `no session cookie in ${set}`)
  return `__Host-mason-master=${match[1]}`
}

describe('Master sign-in, setup, people and permissions', function () {
  this.timeout(180_000)
  let c: Cluster
  let host: RunningNode
  const admin = localOperator
  before(async () => {
    c = await cluster(root('accounts-'))
    host = await c.startHost('host')
  })
  after(async () => {
    await c?.close()
  })
  const master = (): NonNullable<RunningNode['master']> => c.master.master!
  const origin = (): string =>
    c.master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')

  /** Signs a username in through the API the browser uses. */
  const signIn = async (
    username: string,
    password: string,
  ): Promise<{ reply: Reply; cookie?: string; csrf?: string }> => {
    const p = await request(c.master, 'POST', '/api/v2/session/parameters', {
      body: { username },
    })
    assert.equal(p.status, 200, p.text)
    const reply = await request(c.master, 'POST', '/api/v2/session', {
      body: {
        username,
        clientHash: await clientPasswordHash(password, p.json),
      },
    })
    if (reply.status !== 200) return { reply }
    return { reply, cookie: sessionCookie(reply), csrf: reply.json.csrf }
  }

  it('U13.1 signs in with the client-hash protocol, a Secure host-only session cookie and CSRF on changes', async () => {
    // Unknown usernames get stable decoy parameters, different per name.
    const decoy = await request(
      c.master,
      'POST',
      '/api/v2/session/parameters',
      {
        body: { username: 'nobody' },
      },
    )
    const again = await request(
      c.master,
      'POST',
      '/api/v2/session/parameters',
      {
        body: { username: 'Nobody' },
      },
    )
    const other = await request(
      c.master,
      'POST',
      '/api/v2/session/parameters',
      {
        body: { username: 'someone' },
      },
    )
    assert.deepEqual(decoy.json, again.json)
    assert.notEqual(decoy.json.salt, other.json.salt)
    // Raw passwords are refused before anything is checked.
    const raw = await request(c.master, 'POST', '/api/v2/session', {
      body: { username: 'paul', password: 'Correct-Horse-9' },
    })
    assert.equal(raw.status, 400)
    assert.match(raw.json.error, /client password hash/)
    assert.equal((await signIn('paul', 'Wrong-Horse-9')).reply.status, 401)
    assert.equal((await signIn('nobody', 'Correct-Horse-9')).reply.status, 401)
    const { reply, cookie, csrf } = await signIn('paul', 'Correct-Horse-9')
    assert.equal(reply.status, 200, reply.text)
    assert.equal(reply.json.role, 'admin')
    const set = reply.headers.get('set-cookie')!
    assert.match(set, /__Host-mason-master=/)
    assert.match(set, /; Path=\//)
    assert.match(set, /; HttpOnly/)
    assert.match(set, /; Secure/)
    assert.match(set, /; SameSite=Strict/)
    assert.doesNotMatch(set, /Domain=/)
    const me = await request(c.master, 'GET', '/api/v2/session', { cookie })
    assert.equal(me.json.role, 'admin')
    // A session reads without a proof and changes nothing without one.
    assert.equal(
      (await request(c.master, 'GET', '/api/v2/keys', { cookie })).status,
      200,
    )
    const body = { role: 'tester', name: 'from a session' }
    assert.equal(
      (
        await request(c.master, 'POST', '/api/v2/keys', {
          cookie,
          body,
          origin: origin(),
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request(c.master, 'POST', '/api/v2/keys', {
          cookie,
          body,
          csrf,
          origin: 'https://evil.example',
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request(c.master, 'POST', '/api/v2/keys', {
          cookie,
          body,
          csrf,
          origin: origin(),
        })
      ).status,
      201,
    )
    // The home page needs the session; the session ends at sign-out.
    assert.equal((await request(c.master, 'GET', '/')).status, 303)
    const home = await request(c.master, 'GET', '/', { cookie })
    assert.equal(home.status, 200)
    assert.match(home.text, /<strong>paul<\/strong><small>admin · master/)
    assert.match(home.text, /Projects &amp; apps/)
    assert.match(home.text, /This master is not backed up/)
    // Only the pages that hash a password, and the worker, may run WebAssembly.
    assert.doesNotMatch(
      home.headers.get('content-security-policy')!,
      /wasm-unsafe-eval/,
    )
    assert.match(
      (await request(c.master, 'GET', '/sign-in')).headers.get(
        'content-security-policy',
      )!,
      /script-src 'self' 'wasm-unsafe-eval'/,
    )
    const bundle = await request(c.master, 'GET', '/assets/password-worker.js')
    assert.equal(bundle.status, 200)
    assert.match(bundle.headers.get('content-type')!, /javascript/)
    assert.match(
      bundle.headers.get('content-security-policy')!,
      /'wasm-unsafe-eval'/,
    )
    assert.equal(
      (
        await request(c.master, 'DELETE', '/api/v2/session', {
          cookie,
          csrf,
          origin: origin(),
        })
      ).status,
      200,
    )
    assert.equal(
      (await request(c.master, 'GET', '/api/v2/session', { cookie })).status,
      401,
    )
  })

  it('U13.1 locks an account after repeated failures and refuses during the lock without checking', async () => {
    await master().people.create(admin, {
      name: 'Lock',
      username: 'lock',
      role: 'developer',
      password: await newPassword('Lock-Horse-9'),
    })
    assert.equal((await signIn('lock', 'Lock-Horse-9')).reply.status, 200)
    for (let attempt = 0; attempt < LOCKOUT.account; attempt++)
      assert.equal((await signIn('lock', 'Wrong-Horse-9')).reply.status, 401)
    const locked = (await signIn('lock', 'Lock-Horse-9')).reply
    assert.equal(locked.status, 429)
    assert(locked.json.retryAt > Date.now())
    // Other accounts still sign in from the same address.
    assert.equal((await signIn('paul', 'Correct-Horse-9')).reply.status, 200)
  })

  it('U13.1 locks an address, expires locks and sessions, and ends sessions on a permission change', async () => {
    let clock = 1_000_000
    const database = new MasterDatabase(
      new DatabaseSync(':memory:'),
      () => clock,
    )
    const auth = new MasterAuth(database)
    database.db
      .prepare(
        "INSERT INTO accounts(name,username,password,role,created_at) VALUES('a','a',?,'admin',0)",
      )
      .run(
        await createPasswordRecord(
          await clientPasswordHash('Right-Horse-9', parameters('b2')),
          parameters('b2'),
        ),
      )
    const wrong = { username: 'a', clientHash: '11'.repeat(32) }
    for (let attempt = 0; attempt < LOCKOUT.address; attempt++)
      await assert.rejects(
        auth.signIn({ ...wrong, username: `user${attempt}` }, '10.0.0.9'),
        (error: unknown) =>
          error instanceof SignInRefused && error.retryAt == null,
      )
    await assert.rejects(
      auth.signIn(wrong, '10.0.0.9'),
      (error: unknown) =>
        error instanceof SignInRefused &&
        error.retryAt === clock + LOCKOUT.lockMs,
    )
    // Another address is not locked; the lock ends after its time.
    await assert.rejects(auth.signIn(wrong, '10.0.0.10'), /wrong/)
    clock += LOCKOUT.lockMs + 1
    await assert.rejects(auth.signIn(wrong, '10.0.0.9'), /wrong/)
    // Sessions end on expiry and on a permission change.
    const started = auth.start(1, '10.0.0.9')
    assert.equal(auth.session(started.token)?.role, 'admin')
    database.db
      .prepare('UPDATE accounts SET permission_version=permission_version+1')
      .run()
    assert.equal(auth.session(started.token), undefined)
    const next = auth.start(1, '10.0.0.9')
    clock += 15 * 24 * 60 * 60 * 1000
    assert.equal(auth.session(next.token), undefined)
    assert.equal(auth.session('short'), undefined)
    auth.signOut(undefined)
    auth.prune()
    assert.equal(
      database.db.prepare('SELECT COUNT(*) n FROM sign_in_failures').get()!.n,
      0,
    )
  })

  it('U13.2 the setup code gate doubles its wait after each wrong guess and refuses guesses during it', () => {
    let clock = 0
    const gate = new SetupGate(
      () => '123456',
      () => clock,
    )
    assert.equal(gate.waitUntil(), 0)
    const refused = (guess: unknown): number | undefined => {
      try {
        gate.check(guess)
        return undefined
      } catch (error) {
        return (error as SignInRefused).retryAt
      }
    }
    assert.equal(refused('000000'), 5000)
    // The right code during the wait is refused without being checked.
    assert.equal(refused('123456'), 5000)
    clock = 5000
    assert.equal(refused('111111'), 15_000)
    clock = 15_000
    assert.equal(refused('not a code'), 35_000)
    clock = 35_000
    assert.equal(refused('123456'), undefined)
    // A restart makes a new gate, with no wait.
    assert.equal(
      new SetupGate(
        () => '654321',
        () => clock,
      ).waitUntil(),
      0,
    )
    assert.throws(() => new SetupGate(() => undefined).check('123456'))
  })

  it('U13.2 first-run page: the setup code makes the first admin, then setup is gone and everything needs a session or key', async function () {
    this.timeout(60_000)
    const data = path.join(root('setup-'), 'master')
    const node = await startNode(
      { role: 'master', data, port: 0, listen: '127.0.0.1', heartbeatMs: 0 },
      quiet,
    )
    try {
      const page = await request(node, 'GET', '/')
      assert.match(page.text, /Set up this master/)
      assert.match(page.text, /data-mason="setup"/)
      assert.match(page.text, /data-mason="restore"/)
      // Before the first account: sign-in and backups lead to setup; other pages are 404.
      assert.equal(
        (await request(node, 'GET', '/sign-in')).headers.get('location'),
        '/',
      )
      assert.equal(
        (await request(node, 'GET', '/backups')).headers.get('location'),
        '/',
      )
      assert.equal((await request(node, 'GET', '/elsewhere')).status, 404)
      const code = (await import('node:fs'))
        .readFileSync(path.join(data, 'setup-code'), 'utf8')
        .trim()
      const account = {
        username: 'owner',
        ...(await newPassword('Owner-Horse-9')),
      }
      const wrong = await request(node, 'POST', '/api/setup', {
        body: { ...account, code: code === '000000' ? '111111' : '000000' },
      })
      assert.equal(wrong.status, 429)
      const wait = wrong.json.retryAt as number
      assert(wait > Date.now() + 4000)
      const early = await request(node, 'POST', '/api/setup', {
        body: { ...account, code },
      })
      assert.equal(early.status, 429)
      assert.equal(early.json.retryAt, wait)
      assert.equal(
        (await request(node, 'GET', '/api/setup')).json.waitUntil,
        wait,
      )
      await new Promise((resolve) =>
        setTimeout(resolve, wait - Date.now() + 50),
      )
      const created = await request(node, 'POST', '/api/setup', {
        body: { ...account, code },
      })
      assert.equal(created.status, 201, created.text)
      const cookie = sessionCookie(created)
      assert.equal(existsSync(path.join(data, 'setup-code')), false)
      assert.equal(
        node.master!.people.person(created.json.accountId)!.role,
        'admin',
      )
      assert.deepEqual((await request(node, 'GET', '/api/setup')).json, {
        configured: true,
      })
      assert.equal(
        (
          await request(node, 'POST', '/api/setup', {
            body: { ...account, code },
          })
        ).status,
        404,
      )
      const signedOut = await request(node, 'GET', '/')
      assert.equal(signedOut.status, 303)
      assert.equal(signedOut.headers.get('location'), '/sign-in')
      assert.equal((await request(node, 'GET', '/backups')).status, 303)
      assert.equal((await request(node, 'GET', '/api/v2/projects')).status, 401)
      assert.match(
        (await request(node, 'GET', '/sign-in')).text,
        /data-mason="sign-in"/,
      )
      const home = await request(node, 'GET', '/', { cookie })
      assert.equal(home.status, 200)
      assert.match(home.text, /This master is not backed up/)
      const backups = await request(node, 'GET', '/backups', { cookie })
      assert.match(backups.text, /data-mason="backup"/)
      assert.equal(
        (await request(node, 'GET', '/sign-in', { cookie })).status,
        303,
      )
    } finally {
      await node.close()
    }
  })

  it('U13.3/U13.14 people: roles, one address per method, disabling, and the last enabled admin', async () => {
    const people = master().people
    const mia = await people.create(admin, {
      name: 'Mia',
      username: 'mia',
      role: 'manager',
      addresses: { google: 'Mia@Example.test' },
      password: await newPassword('Mia-Horse-9'),
    })
    assert.deepEqual(mia.addresses, { google: 'mia@example.test' })
    await assert.rejects(
      people.create(admin, {
        name: 'Copy',
        addresses: { google: 'mia@example.test' },
      }),
      /Another person has that google address/,
    )
    await assert.rejects(
      people.create(admin, {
        name: 'Raw',
        username: 'raw',
        password: 'secret',
      }),
      /client password hash/,
    )
    await assert.rejects(people.create(admin, {}), /name or a username/)
    await assert.rejects(
      people.create(admin, {
        name: 'p',
        password: await newPassword('Password-1x'),
      }),
      /needs a username/,
    )
    await assert.rejects(
      people.create(admin, { username: 'mia' }),
      /username is taken/,
    )
    // A manager may not add, remove or re-role people.
    const managerActor = {
      role: 'manager' as const,
      accountId: mia.id,
      label: 'm',
    }
    await assert.rejects(
      people.create(managerActor, { name: 'X' }),
      /Not allowed for the manager role/,
    )
    assert.equal(
      people.list(managerActor).some((p) => p.id === mia.id),
      true,
    )
    // Each change bumps the permission version, which ends sessions.
    const { cookie } = await signIn('mia', 'Mia-Horse-9')
    const changed = await people.update(admin, mia.id, {
      role: 'developer',
      addresses: { google: null, teamstation: 'mia@team.test' },
    })
    assert.equal(changed.permissionVersion, mia.permissionVersion + 1)
    assert.deepEqual(changed.addresses, { teamstation: 'mia@team.test' })
    assert.equal(
      (await request(c.master, 'GET', '/api/v2/session', { cookie })).status,
      401,
    )
    // Someone may change their own password, and only that.
    const self = { role: 'developer' as const, accountId: mia.id, label: 's' }
    await people.update(self, mia.id, {
      password: await newPassword('Mia-Horse-10'),
    })
    await assert.rejects(
      people.update(self, mia.id, { role: 'admin' }),
      /Not allowed/,
    )
    assert.equal((await signIn('mia', 'Mia-Horse-10')).reply.status, 200)
    await people.update(admin, mia.id, { disabled: true })
    assert.equal((await signIn('mia', 'Mia-Horse-10')).reply.status, 401)
    // The last enabled admin.
    const paul = people.list(admin).find((p) => p.username === 'paul')!
    for (const change of [{ role: 'manager' }, { disabled: true }])
      await assert.rejects(
        people.update(admin, paul.id, change),
        /last enabled admin/,
      )
    assert.throws(() => people.remove(admin, paul.id), /last enabled admin/)
    const second = await people.create(admin, { name: 'Ada', role: 'admin' })
    await people.update(admin, second.id, { role: 'tester' })
    await assert.rejects(
      people.update(admin, paul.id, { role: 'manager' }),
      /last enabled admin/,
    )
    // Removing someone keeps the row for the audit history and revokes their keys.
    const key = master().keys.create(
      { role: 'admin', accountId: second.id, label: `account:${second.id}` },
      { role: 'tester' },
    )
    people.remove(admin, second.id)
    assert.equal(people.person(second.id), undefined)
    assert.equal(master().keys.get(key.id)!.revoked, true)
    assert.throws(() => people.remove(admin, second.id), /No such person/)
    await assert.rejects(people.update(admin, 9999, {}), /No such person/)
    assert.throws(() => people.get(admin, 9999), /No such person/)
    assert.equal(people.get(self, mia.id).id, mia.id)
    // The people API maps the same rules to status codes.
    const list = await c.api('GET', '/api/v2/people')
    assert(list.json.some((p: Json) => p.username === 'paul'))
    assert.equal(
      (await c.api('PUT', `/api/v2/people/${paul.id}`, { role: 'tester' }))
        .status,
      409,
    )
    assert.equal((await c.api('GET', '/api/v2/people/0')).status, 404)
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Via API',
      role: 'tester',
    })
    assert.equal(made.status, 201)
    assert.equal(
      (await c.api('GET', `/api/v2/people/${made.json.id}`)).json.name,
      'Via API',
    )
    assert.equal(
      (await c.api('DELETE', `/api/v2/people/${made.json.id}`)).status,
      200,
    )
  })

  it('U13.12 groups decide which apps a tester sees on the host, within a second', async () => {
    const people = master().people
    const repo = c.repo('fixtures/groups')
    master().saveProject(admin, 'groups', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
      apps: [
        { bundleId: 'test.groups.one', name: 'One', platforms: ['ios'] },
        { bundleId: 'test.groups.two', name: 'Two', platforms: ['ios'] },
      ],
    })
    const app = (slug: string): number =>
      Number(
        master()
          .database.db.prepare('SELECT id FROM apps WHERE slug=?')
          .get(slug)!.id,
      )
    const tess = await people.create(admin, {
      name: 'Tess',
      role: 'tester',
      addresses: { google: 'tess@example.test' },
    })
    const scope = (): ReadonlySet<number> | 'all' | undefined =>
      host
        .host!.cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
        .get(tess.id) == null
        ? undefined
        : host.host!.cache.scope(tess.id)
    await c.until(() => scope(), 2000, 'the tester on the host')
    assert.deepEqual([...(scope() as Set<number>)], [])
    const one = people.createGroup(admin, {
      name: 'Testers one',
      apps: [app('test.groups.one')],
      members: [tess.id],
    })
    const two = people.createGroup(admin, {
      name: 'Testers two',
      apps: [app('test.groups.two')],
    })
    await c.until(
      () => (scope() as Set<number>).size === 1,
      1000,
      'the group on the host',
    )
    assert.deepEqual([...(scope() as Set<number>)], [app('test.groups.one')])
    people.updateGroup(admin, two.id, { members: [tess.id] })
    await c.until(() => (scope() as Set<number>).size === 2, 1000, 'the union')
    people.updateGroup(admin, one.id, { apps: [] })
    await c.until(
      () => (scope() as Set<number>).size === 1,
      1000,
      'an app removed',
    )
    people.removeGroup(admin, two.id)
    await c.until(
      () => (scope() as Set<number>).size === 0,
      1000,
      'the group removed',
    )
    assert.throws(
      () => people.createGroup(admin, { name: 'Testers one' }),
      /exists/,
    )
    assert.throws(() => people.createGroup(admin, {}), /needs a name/)
    assert.throws(
      () =>
        people.updateGroup(admin, one.id, {
          name: 'Testers one',
          members: [424242],
        }),
      /No person/,
    )
    assert.throws(() => people.updateGroup(admin, 9999, {}), /No such group/)
    assert.throws(() => people.removeGroup(admin, 9999), /No such group/)
    assert.throws(
      () => people.createGroup(admin, { name: 'Bad', apps: [424242] }),
      /No app/,
    )
    people.createGroup(admin, { name: 'Other name' })
    assert.throws(
      () => people.updateGroup(admin, one.id, { name: 'Other name' }),
      /exists/,
    )
    people.updateGroup(admin, one.id, { name: 'Renamed' })
    // Developers, managers and admins see every app.
    const dev = await people.create(admin, { name: 'Dev', role: 'developer' })
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(dev.id),
      2000,
      'the developer on the host',
    )
    assert.equal(host.host!.cache.scope(dev.id), 'all')
    const groups = await c.api('GET', '/api/v2/groups')
    assert(groups.json.some((group: Json) => group.name === 'Renamed'))
    const made = await c.api('POST', '/api/v2/groups', { name: 'API group' })
    assert.equal(made.status, 201)
    assert.equal(
      (
        await c.api('PUT', `/api/v2/groups/${made.json.id}`, {
          name: 'API group 2',
        })
      ).json.name,
      'API group 2',
    )
    assert.equal(
      (await c.api('DELETE', `/api/v2/groups/${made.json.id}`)).status,
      200,
    )
  })

  /** Every API route of the master, as the express app registers it. */
  const routes = (): Array<{ method: string; path: string }> => {
    const app = masterApp({
      role: 'master',
      testEndpoints: false,
      configured: () => true,
      master: master(),
    })
    const out: Array<{ method: string; path: string }> = []
    const walk = (stack: Json[]): void => {
      for (const layer of stack) {
        if (layer.route != null) {
          for (const method of Object.keys(layer.route.methods))
            if (String(layer.route.path).startsWith('/api/'))
              out.push({ method: method.toUpperCase(), path: layer.route.path })
        } else if (layer.handle?.stack != null) walk(layer.handle.stack)
      }
    }
    walk((app as express.Express & { router: { stack: Json[] } }).router.stack)
    return out
  }

  it('U13.13 every API route is checked against the policy table for every role', async () => {
    // Open routes: sign-in and first-run setup.
    const open = [
      'GET /api/setup',
      'POST /api/setup',
      'POST /api/setup/restore',
      'POST /api/v2/session/parameters',
      'POST /api/v2/session',
      'GET /api/v2/session',
      'DELETE /api/v2/session',
    ]
    const table: Record<string, Action> = {
      'GET /api/v2/settings/backup': 'settings.read',
      'PUT /api/v2/settings/backup': 'settings.change',
      'POST /api/v2/settings/backup/confirm': 'backups.key',
      'GET /api/v2/backups': 'backups.run',
      'POST /api/v2/backups': 'backups.run',
      'GET /api/v2/people': 'people.read',
      'POST /api/v2/people': 'people.change',
      'GET /api/v2/people/:id': 'people.read',
      'PUT /api/v2/people/:id': 'people.change',
      'DELETE /api/v2/people/:id': 'people.change',
      'GET /api/v2/groups': 'groups.read',
      'POST /api/v2/groups': 'groups.change',
      'PUT /api/v2/groups/:id': 'groups.change',
      'DELETE /api/v2/groups/:id': 'groups.change',
      'GET /api/v2/projects': 'projects.read',
      'GET /api/v2/projects/:slug': 'projects.read',
      'PUT /api/v2/projects/:slug': 'projects.change',
      'DELETE /api/v2/projects/:slug': 'projects.change',
      'POST /api/v2/projects/:slug/apps': 'projects.change',
      'DELETE /api/v2/projects/:slug/apps/:bundleId': 'projects.change',
      'PUT /api/v2/projects/:slug/secrets': 'secrets.change',
      'PUT /api/v2/projects/:slug/rules': 'projects.change',
      'POST /api/v2/build-numbers/seed': 'buildNumbers.seed',
      'POST /api/jobs': 'runs.request',
      'GET /api/jobs/:id': 'runs.read',
      'GET /api/jobs/:id/log': 'runs.read',
      'GET /api/jobs/:id/logs': 'runs.read',
      'POST /api/jobs/:id/cancel': 'runs.request',
      'GET /api/queue': 'runs.read',
      'GET /api/apps': 'apps.read',
      'GET /api/apps/:slug/build-settings': 'apps.read',
      'PUT /api/apps/:slug/build-settings': 'projects.change',
      'GET /api/v2/runs': 'runs.read',
      'POST /api/v2/runs': 'runs.request',
      'GET /api/v2/runs/:id': 'runs.read',
      'POST /api/v2/runs/:id/cancel': 'runs.request',
      'POST /api/v2/runs/:id/restart': 'runs.request',
      'POST /api/v2/runs/:id/approve': 'runs.approve',
      'GET /api/v2/runs/:id/logs': 'runs.read',
      'GET /api/v2/settings/:area': 'settings.read',
      'PUT /api/v2/settings/:area': 'settings.change',
      'GET /api/v2/keys': 'keys.read',
      'POST /api/v2/keys': 'keys.create',
      'DELETE /api/v2/keys/:id': 'keys.revoke',
      'GET /api/v2/nodes': 'nodes.read',
      'POST /api/v2/nodes': 'nodes.change',
      'DELETE /api/v2/nodes/:fingerprint': 'nodes.change',
      'GET /api/v2/apple/certificates': 'apple.change',
      'POST /api/v2/apple/certificates': 'apple.change',
      'DELETE /api/v2/apple/certificates/:id': 'apple.change',
      'GET /api/v2/apple/profiles': 'apple.change',
      'GET /api/v2/apple/session': 'apple.change',
      'POST /api/v2/apple/session': 'apple.change',
      'POST /api/v2/apple/session/code': 'apple.change',
    }
    const registered = routes().map((route) => `${route.method} ${route.path}`)
    assert.deepEqual(
      [...new Set(registered)].sort(),
      [...open, ...Object.keys(table)].sort(),
    )
    const keys = Object.fromEntries(
      roles.map((role) => [
        role,
        master().keys.create(admin, { role, name: `policy ${role}` }).token,
      ]),
    ) as Record<Role, string>
    const fill = (route: string): string =>
      route
        .replace(':slug', 'no-such-project')
        .replace(':bundleId', 'no.such.app')
        .replace(':area', 'no-such-area')
        .replace(':fingerprint', 'no-such-node')
        .replace(':id', '424242')
    const failures: string[] = []
    for (const [route, action] of Object.entries(table)) {
      const [method, pathname] = route.split(' ') as [string, string]
      for (const role of roles) {
        const reply = await c.api(
          method,
          fill(pathname),
          method === 'GET' || method === 'DELETE' ? undefined : {},
          keys[role],
        )
        const allowed = roles.indexOf(role) >= roles.indexOf(policy[action])
        if ((reply.status === 403) === allowed)
          failures.push(`${route} as ${role}: ${reply.status} ${reply.text}`)
      }
    }
    assert.deepEqual(failures, [])
  })

  it('U13.4 keys act as their role within their project and branch scopes, and never above their creator', async () => {
    const repo = c.repo('fixtures/scoped')
    repo.commit({ 'Masonfile.ts': 'export function setup() {}' })
    master().saveProject(admin, 'scoped', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
    })
    const scoped = master().keys.create(admin, {
      role: 'developer',
      projects: ['scoped'],
      branches: ['feature/*'],
    }).token
    const listed = await c.api('GET', '/api/v2/projects', undefined, scoped)
    assert.deepEqual(
      listed.json.map((project: Json) => project.slug),
      ['scoped'],
    )
    assert.equal(
      (await c.api('GET', '/api/v2/projects/scoped', undefined, scoped)).status,
      200,
    )
    assert.equal(
      (await c.api('GET', '/api/v2/projects/groups', undefined, scoped)).status,
      403,
    )
    assert.equal(
      (await c.api('GET', '/api/apps', undefined, scoped)).json.length,
      1,
    )
    assert.deepEqual(
      (await c.api('GET', '/api/v2/runs', undefined, scoped)).json,
      [],
    )
    assert.deepEqual(
      (await c.api('GET', '/api/queue', undefined, scoped)).json,
      [],
    )
    const outside = await c.api(
      'POST',
      '/api/v2/runs',
      { project: 'scoped', branch: 'master' },
      scoped,
    )
    assert.equal(outside.status, 403)
    assert.equal(
      (
        await c.api(
          'POST',
          '/api/jobs',
          { app: 'scoped', branch: 'master' },
          scoped,
        )
      ).status,
      403,
    )
    const manager = master().keys.create(admin, {
      role: 'manager',
      projects: ['scoped'],
    }).token
    // A scoped key cannot reach anything that is not about a project.
    const settings = await c.api(
      'GET',
      '/api/v2/settings/github',
      undefined,
      manager,
    )
    assert.equal(settings.status, 403)
    assert.match(settings.json.error, /scoped to projects/)
    assert.equal(
      (
        await c.api(
          'PUT',
          '/api/v2/projects/scoped/rules',
          [{ pattern: '*', mode: 'request' }],
          manager,
        )
      ).status,
      200,
    )
    assert.equal(
      (
        await c.api(
          'PUT',
          '/api/v2/projects/groups/rules',
          [{ pattern: '*', mode: 'request' }],
          manager,
        )
      ).status,
      403,
    )
    // Nobody makes a key above their own role.
    const developer = master().keys.create(admin, { role: 'developer' }).token
    assert.equal(
      (await c.api('POST', '/api/v2/keys', { role: 'manager' }, developer))
        .status,
      403,
    )
    assert.equal(
      (await c.api('POST', '/api/v2/keys', { role: 'developer' }, developer))
        .status,
      201,
    )
  })

  it('U13.5 the host forwards API-key requests and run actions of its sessions, with CSRF, and 503 while the master is away', async () => {
    const repo = c.repo('fixtures/forward')
    repo.commit({
      'Masonfile.ts': `
import type { Setup, Stage } from '@mason/types'
export function setup(m: Setup) {
  m.apiVersion(1)
  m.stage('one', { on: 'linux', run: one })
}
export async function one(ctx: Stage) { return 1 }
`,
    })
    master().saveProject(admin, 'forward', {
      repository: repo.url,
      rules: [{ pattern: '*', mode: 'request' }],
    })
    const developer = master().keys.create(admin, { role: 'developer' }).token
    // An API key's request reaches the master as it is.
    const direct = await c.api('GET', '/api/v2/projects', undefined, developer)
    const forwarded = await request(host, 'GET', '/api/v2/projects', {
      bearer: developer,
    })
    assert.equal(forwarded.status, 200, forwarded.text)
    assert.deepEqual(forwarded.json, direct.json)
    assert.equal(
      (await request(host, 'GET', '/api/v2/projects', { bearer: 'mason_v1_x' }))
        .status,
      401,
    )
    assert.equal((await request(host, 'GET', '/api/queue')).status, 401)
    // Sign-in belongs to the master's own listener.
    assert.equal(
      (
        await request(host, 'POST', '/api/v2/session', {
          body: { username: 'paul', clientHash: '00'.repeat(32) },
          bearer: developer,
        })
      ).status,
      403,
    )
    // A host session may only make the run actions, with its proof.
    const dev = await master().people.create(admin, {
      name: 'Host developer',
      role: 'developer',
      addresses: { google: 'hostdev@example.test' },
    })
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(dev.id),
      2000,
      'the developer on the host',
    )
    const { token, session } = host.host!.accounts.startSession(dev.id)
    const cookie = `__Host-mason-session=${token}`
    const hostOrigin = host.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
    assert.equal(
      (await request(host, 'GET', '/api/v2/projects', { cookie })).status,
      403,
    )
    const body = { project: 'forward', branch: 'master' }
    assert.equal(
      (
        await request(host, 'POST', '/api/v2/runs', {
          cookie,
          body,
          origin: hostOrigin,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await request(host, 'POST', '/api/v2/runs', {
          cookie,
          body,
          csrf: session.csrf,
          origin: 'https://evil.example',
        })
      ).status,
      403,
    )
    const run = await request(host, 'POST', '/api/v2/runs', {
      cookie,
      body,
      csrf: session.csrf,
      origin: hostOrigin,
    })
    assert.equal(run.status, 202, run.text)
    const audit = master()
      .database.db.prepare(
        "SELECT actor,via FROM audit WHERE action='run.request' AND target=?",
      )
      .get(run.json.id)!
    assert.deepEqual({ ...audit }, { actor: dev.id, via: `host:${dev.id}` })
    const cancel = await request(
      host,
      'POST',
      `/api/v2/runs/${run.json.id}/cancel`,
      {
        cookie,
        body: {},
        csrf: session.csrf,
        origin: hostOrigin,
      },
    )
    assert.equal(cancel.status, 200, cancel.text)
    // A tester's session is refused by its role; a stale permission version by the master.
    const answer = async (
      params: unknown,
    ): Promise<{ status?: number; aborted?: string }> => {
      const chunks: Buffer[] = []
      let aborted: string | undefined
      await master().forwarder.forward(params, {
        write: async (chunk: Buffer) => {
          chunks.push(chunk)
        },
        end: () => undefined,
        abort: (reason: string) => {
          aborted = reason
        },
      } as unknown as Stream)
      if (aborted != null) return { aborted }
      const text = Buffer.concat(chunks).toString()
      return { status: JSON.parse(text.slice(0, text.indexOf('\n'))).status }
    }
    const version = master().people.person(dev.id)!.permissionVersion
    assert.equal(
      (
        await answer({
          method: 'POST',
          path: '/api/v2/runs',
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify(body)).toString('base64'),
          account: { id: dev.id, permissionVersion: version - 1 },
        })
      ).status,
      403,
    )
    assert.match(
      (
        await answer({
          method: 'GET',
          path: '/api/v2/projects',
          account: { id: dev.id, permissionVersion: version },
        })
      ).aborted!,
      /only request, cancel, restart or approve/,
    )
    const tester = await master().people.create(admin, {
      name: 'T',
      role: 'tester',
    })
    assert.equal(
      (
        await answer({
          method: 'POST',
          path: '/api/v2/runs',
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify(body)).toString('base64'),
          account: {
            id: tester.id,
            permissionVersion: tester.permissionVersion,
          },
        })
      ).status,
      403,
    )
    assert.match(
      (await answer({ method: 'GET', path: '/etc/passwd' })).aborted!,
      /not forwarded/,
    )
    // While the master is away the host answers 503.
    await c.drop('host', 500, async () => {
      await c.until(() => !host.host!.online(), 2000, 'offline')
      assert.equal(
        (await request(host, 'GET', '/api/v2/projects', { bearer: developer }))
          .status,
        503,
      )
    })
  })

  it('U13.5 forwarded requests are limited to the API paths and the four run actions', () => {
    assert.throws(
      () => asForwardRequest({ method: 'PATCH', path: '/api/v2/x' }),
      /Unsupported/,
    )
    for (const bad of [
      '/etc/passwd',
      '/api/v2/../x',
      '/api/v2/a\nb',
      '/api/admin/apps',
    ])
      assert.throws(
        () => asForwardRequest({ method: 'GET', path: bad }),
        /not forwarded/,
      )
    assert.throws(
      () =>
        asForwardRequest({
          method: 'GET',
          path: '/api/queue',
          authorization: 'a\r\nb',
        }),
      /Invalid authorization/,
    )
    assert.throws(
      () =>
        asForwardRequest({
          method: 'GET',
          path: '/api/queue',
          account: { id: 'x' },
        }),
      /Invalid account/,
    )
    assert.deepEqual(
      asForwardRequest({ method: 'GET', path: '/api/queue?x=1' }),
      {
        method: 'GET',
        path: '/api/queue?x=1',
      },
    )
    assert(isRunAction('POST', '/api/v2/runs'))
    assert(isRunAction('POST', '/api/v2/runs/abc/approve?x=1'))
    assert(isRunAction('POST', '/api/jobs/abc/cancel'))
    assert(!isRunAction('GET', '/api/v2/runs'))
    assert(!isRunAction('POST', '/api/v2/keys'))
  })

  it('U13.10 the master’s pages: Backups first for an administrator until they confirm the key, and sessions on every page', async () => {
    const { cookie } = await signIn('paul', 'Correct-Horse-9')
    assert.equal((await request(c.master, 'GET', '/elsewhere')).status, 303)
    assert.equal(
      (await request(c.master, 'GET', '/elsewhere', { cookie })).status,
      404,
    )
    const people = master().people
    await people.create(admin, {
      name: 'Pages developer',
      username: 'pagesdev',
      role: 'developer',
      password: await newPassword('Pages-Horse-9'),
    })
    const developer = await signIn('pagesdev', 'Pages-Horse-9')
    assert.equal(
      (await request(c.master, 'GET', '/backups', { cookie: developer.cookie }))
        .status,
      403,
    )
    const bare = path.join(c.root, 'pages-backup.git')
    ;(await import('node:child_process')).execFileSync('git', [
      'init',
      '-q',
      '--bare',
      bare,
    ])
    assert.equal(
      (
        await c.api('PUT', '/api/v2/settings/backup', {
          repository: bare,
          branch: 'b',
        })
      ).status,
      200,
    )
    const home = await request(c.master, 'GET', '/', { cookie })
    assert.equal(home.headers.get('location'), '/backups')
    let page = await request(c.master, 'GET', '/backups', { cookie })
    assert.match(page.text, /No backup has run yet/)
    assert.match(page.text, /data-mason="backup-confirm"/)
    assert.equal(
      (await c.api('POST', '/api/v2/backups', {})).json.backedUp,
      true,
    )
    page = await request(c.master, 'GET', '/backups', { cookie })
    assert.match(page.text, /Last backup /)
    assert.equal(
      (await c.api('POST', '/api/v2/settings/backup/confirm', {})).status,
      200,
    )
    page = await request(c.master, 'GET', '/backups', { cookie })
    assert.match(page.text, /You confirmed you stored this key/)
    assert.equal((await request(c.master, 'GET', '/', { cookie })).status, 200)
    await c.api('PUT', '/api/v2/settings/backup', {
      repository: path.join(c.root, 'missing.git'),
    })
    await c.api('POST', '/api/v2/backups', {})
    page = await request(c.master, 'GET', '/backups', { cookie })
    assert.match(page.text, /The last backup failed/)
    // `mason backup` exits 1 on a failure.
    const out = cliIO()
    assert.equal(await nodeMain(['backup', '--data', c.master.dir], out), 1)
    assert.match(out.lines.join('\n'), /The backup failed/)
    assert.equal(
      await nodeMain(['backup', 'now', '--data', c.master.dir], out),
      1,
    )
  })

  it('U13.3 mason people, mason groups and mason api act through the control socket and the API', async () => {
    const dir = c.master.dir
    const json = (name: string, value: unknown): string => {
      const file = path.join(c.root, name)
      writeFileSync(file, JSON.stringify(value))
      return file
    }
    const run = async (
      ...args: string[]
    ): Promise<{ code: number; text: string }> => {
      const out = cliIO()
      const code = await nodeMain(args, out)
      return { code, text: out.lines.join('\n') }
    }
    const added = await run(
      'people',
      'add',
      '--file',
      json('p.json', { name: 'CLI person', role: 'tester' }),
      '--data',
      dir,
    )
    assert.equal(added.code, 0, added.text)
    const id = String(JSON.parse(added.text).id)
    assert.match(
      (await run('people', 'list', '--data', dir)).text,
      /CLI person/,
    )
    assert.match(
      (
        await run(
          'people',
          'set',
          id,
          '--file',
          json('q.json', { name: 'CLI renamed' }),
          '--data',
          dir,
        )
      ).text,
      /CLI renamed/,
    )
    assert.match(
      (await run('people', 'remove', id, '--data', dir)).text,
      /Removed/,
    )
    const group = await run(
      'groups',
      'add',
      '--file',
      json('g.json', { name: 'CLI group' }),
      '--data',
      dir,
    )
    const groupId = String(JSON.parse(group.text).id)
    assert.match(
      (
        await run(
          'groups',
          'set',
          groupId,
          '--file',
          json('h.json', { name: 'CLI group 2' }),
          '--data',
          dir,
        )
      ).text,
      /CLI group 2/,
    )
    assert.match(
      (await run('groups', 'list', '--data', dir)).text,
      /CLI group 2/,
    )
    assert.equal(
      (await run('groups', 'remove', groupId, '--data', dir)).code,
      0,
    )
    const usage = await run('people', 'set', '--data', dir)
    assert.equal(usage.code, 1)
    assert.match(usage.text, /Usage: mason people/)
    // `mason api` with a key file, at the local master's address and pin.
    const developer = master().keys.create(admin, { role: 'developer' }).token
    const keyFile = path.join(c.root, 'dev.key')
    writeFileSync(keyFile, developer + '\n', { mode: 0o600 })
    const projects = await run(
      'api',
      'GET',
      '/api/v2/projects',
      '--key-file',
      keyFile,
      '--data',
      dir,
    )
    assert.equal(projects.code, 0, projects.text)
    assert(Array.isArray(JSON.parse(projects.text)))
    const refused = await run(
      'api',
      'PUT',
      '/api/v2/settings/github',
      '--file',
      json('s.json', {}),
      '--key-file',
      keyFile,
      '--data',
      dir,
    )
    assert.equal(refused.code, 1)
    assert.match(refused.text, /Not allowed for the developer role/)
    const status = (await controlRequest(dir, 'status')) as {
      web: string
      pin: string
    }
    process.env.MASON_API_KEY = developer
    try {
      const explicit = await run(
        'api',
        'delete',
        '/api/v2/keys/x',
        '--url',
        status.web.replace(/\/\/[^:]+:/, '//127.0.0.1:'),
        '--pin',
        status.pin,
      )
      assert.equal(explicit.code, 1)
      assert.match(explicit.text, /Not allowed/)
    } finally {
      delete process.env.MASON_API_KEY
    }
    assert.match(
      (await run('api', 'GET', '/api/v2/projects', '--data', dir)).text,
      /Give an API key/,
    )
    assert.match(
      (await run('api', 'GET', 'projects', '--key-file', keyFile)).text,
      /Usage: mason api/,
    )
  })

  it('U13.5 the host refuses a session request without a readable proof or origin, and answers 502 when the master refuses to forward', async () => {
    const dev = await master().people.create(admin, {
      name: 'Proof developer',
      role: 'developer',
    })
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(dev.id),
      2000,
      'the developer on the host',
    )
    const { token } = host.host!.accounts.startSession(dev.id)
    const url = host.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
    const post = async (
      headers: Record<string, string>,
      body: string,
    ): Promise<number> =>
      (
        await pinnedFetch(
          url + '/api/v2/runs',
          {
            method: 'POST',
            headers: { cookie: `__Host-mason-session=${token}`, ...headers },
            body,
          },
          host.web!.certificate!.pin,
        )
      ).status
    assert.equal(
      await post({ origin: url, 'content-type': 'text/plain' }, 'not json'),
      403,
    )
    assert.equal(
      await post(
        { origin: 'not a url', 'content-type': 'application/json' },
        '{}',
      ),
      403,
    )
    const developer = master().keys.create(admin, { role: 'developer' }).token
    const long = await request(
      host,
      'GET',
      `/api/v2/projects?${'x'.repeat(3000)}`,
      {
        bearer: developer,
      },
    )
    assert.equal(long.status, 502)
    assert.match(long.json.error, /not forwarded/)
  })
})
