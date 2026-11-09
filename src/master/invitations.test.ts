import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { Agent, fetch } from 'undici'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
} from '../auth/passwordProtocol.js'
import { startNode, type RunningNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { localOperator } from './roles.js'

const admin = localOperator
const HOST = 'https://builds.example.test'
const insecure = new Agent({ connect: { rejectUnauthorized: false } })

/** A browser on one node's listener: its cookies and the origin its pages send. */
class Browser {
  readonly cookies = new Map<string, string>()
  constructor(
    readonly base: () => string,
    readonly origin: () => string,
  ) {}
  async send(
    method: string,
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{
    status: number
    text: string
    // Replies are read field by field in assertions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: any
    headers: Headers
  }> {
    const response = await fetch(this.base() + route, {
      method,
      redirect: 'manual',
      dispatcher: insecure,
      headers: {
        cookie: [...this.cookies]
          .map(([name, value]) => `${name}=${value}`)
          .join('; '),
        origin: this.origin(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]!
      const index = pair.indexOf('=')
      if (pair.slice(index + 1) === '')
        this.cookies.delete(pair.slice(0, index))
      else this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    const text = await response.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return {
      status: response.status,
      text,
      json,
      headers: response.headers as unknown as Headers,
    }
  }
}

const parameters = (salt: string): ReturnType<typeof clientParameters> =>
  clientParameters(salt.repeat(16), DEFAULT_PASSWORD_COSTS)
const password = async (
  text: string,
  salt: string,
): Promise<{
  clientHash: string
  clientParameters: ReturnType<typeof clientParameters>
}> => ({
  clientHash: await clientPasswordHash(text, parameters(salt)),
  clientParameters: parameters(salt),
})

describe('Invitation links', function () {
  this.timeout(180_000)
  let c: Cluster
  let host: RunningNode
  const master = (): NonNullable<RunningNode['master']> => c.master.master!
  const masterUrl = (): string =>
    c.master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  const onMaster = (): Browser => new Browser(masterUrl, masterUrl)
  const onHost = (): Browser =>
    new Browser(
      () => c.hosts.get('host')!.web!.url,
      () => HOST,
    )
  const tokenOf = (url: string): string => url.split('#')[1]!
  before(async () => {
    c = await cluster(
      mkdtempSync(
        path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'invite-'),
      ),
    )
    host = await c.startHost('host')
  })
  after(async () => {
    await c?.close()
  })

  it('M2.4 an admin invites a person: the link once, at the host, only its hash kept, listed with its expiry and audited', async () => {
    // Without a host or master address, the link is where the admin reached the master.
    const early = await c.api('POST', '/api/v2/people', {
      name: 'Early Bird',
      emails: ['early@example.test'],
      invite: true,
    })
    assert.equal(early.status, 201)
    assert.match(
      early.json.invitation.url,
      /^https:\/\/127\.0\.0\.1:\d+\/auth\/invite#[A-Za-z0-9_-]{43}$/,
    )
    await master().settings.set(admin, 'master', {
      origin: 'https://mason-admin.example.test:9300',
    })
    const viaMaster = await c.api(
      'POST',
      `/api/v2/people/${early.json.id}/invitation`,
    )
    assert.match(
      viaMaster.json.url,
      /^https:\/\/mason-admin\.example\.test:9300\/auth\/invite#/,
    )
    await master().settings.set(admin, 'host', { origin: HOST })
    await c.until(
      () => host.host!.cache.host()?.origin === HOST,
      20000,
      'the host origin',
    )

    const added = await c.api('POST', '/api/v2/people', {
      name: 'Tess Tester',
      emails: ['tess@example.test'],
      invite: true,
    })
    assert.equal(added.status, 201)
    const { url, expiresAt } = added.json.invitation
    assert(url.startsWith(`${HOST}/auth/invite#`))
    const now = master().database.now()
    assert(Math.abs(expiresAt - (now + 7 * 86_400_000)) < 60_000)
    const token = tokenOf(url)
    const listed = await c.api('GET', '/api/v2/people')
    assert(!listed.text.includes(token), 'the token is never listed')
    const tess = listed.json.find(
      (person: { name: string }) => person.name === 'Tess Tester',
    )
    assert.deepEqual(tess.invitation, { expiresAt })
    const stored = master()
      .database.db.prepare(
        'SELECT token_hash FROM person_invitations WHERE account_id=?',
      )
      .get(tess.id) as { token_hash: string }
    assert.match(stored.token_hash, /^[0-9a-f]{64}$/)
    assert(!JSON.stringify(stored).includes(token))
    const short = await c.api(
      'POST',
      `/api/v2/people/${early.json.id}/invitation`,
      { days: 2 },
    )
    assert(Math.abs(short.json.expiresAt - (now + 2 * 86_400_000)) < 60_000)
    assert.equal(
      (
        await c.api('POST', `/api/v2/people/${early.json.id}/invitation`, {
          days: 31,
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await c.api('POST', '/api/v2/people', {
          name: 'X',
          emails: ['x@example.test'],
          invite: 'yes',
        })
      ).status,
      400,
    )
    const actions = master()
      .database.db.prepare(
        "SELECT action FROM audit WHERE action LIKE 'person.invite%' AND target=?",
      )
      .all(String(tess.id))
      .map((row) => row.action)
    assert.deepEqual(actions, ['person.invite'])
    assert.equal(
      (await c.api('POST', '/api/v2/people/424242/invitation')).status,
      404,
    )
  })

  it('M2.5 on the master the link lets a person choose a username and password, signs them in, and works once', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Dev One',
      role: 'developer',
      emails: ['dev@example.test'],
      invite: true,
    })
    const token = tokenOf(made.json.invitation.url)
    const b = onMaster()
    const page = await b.send('GET', '/auth/invite')
    assert.equal(page.status, 200)
    assert.match(page.text, /data-mason="invite"/)
    assert.match(
      page.headers.get('content-security-policy')!,
      /'wasm-unsafe-eval'/,
    )
    assert.doesNotMatch(page.text, new RegExp(token))
    // Another origin's page may not use or even look up a token.
    const foreign = await b.send(
      'POST',
      '/auth/invite/lookup',
      { token },
      { origin: 'https://evil.example.test' },
    )
    assert.equal(foreign.status, 400)
    assert.equal(foreign.json.error, 'Untrusted origin')
    // With a confirmed email they may skip the username (M2.11); without
    // one, they must choose it.
    assert.deepEqual(
      (await b.send('POST', '/auth/invite/lookup', { token })).json,
      { name: 'Dev One', usernameRequired: false },
    )
    master()
      .database.db.prepare(
        'UPDATE account_emails SET confirmed=0 WHERE account_id=?',
      )
      .run(made.json.id)
    const found = await b.send('POST', '/auth/invite/lookup', { token })
    assert.deepEqual(found.json, { name: 'Dev One', usernameRequired: true })
    assert.equal(
      (await b.send('POST', '/auth/invite/lookup', { token: 'short' })).status,
      404,
    )
    assert.equal(
      (await b.send('POST', '/auth/invite', { token, password: 'raw' })).status,
      400,
      'a raw password is refused',
    )
    const secret = await password('Dev-Horse-9', 'd1')
    const missing = await b.send('POST', '/auth/invite', { token, ...secret })
    assert.equal(missing.status, 400)
    assert.equal(missing.json.error, 'Choose a username')
    const taken = await b.send('POST', '/auth/invite', {
      token,
      username: 'PAUL',
      ...secret,
    })
    assert.equal(taken.status, 409)
    assert.equal(
      (await b.send('POST', '/auth/invite', '{not json' as unknown)).status,
      400,
    )
    const accepted = await b.send('POST', '/auth/invite', {
      token,
      username: 'dev1',
      ...secret,
    })
    assert.equal(accepted.status, 200, accepted.text)
    assert.match(
      accepted.headers.get('set-cookie')!,
      /__Host-mason-master=.+SameSite=Strict/,
    )
    const session = await b.send('GET', '/api/v2/session')
    assert.equal(session.json.name, 'Dev One')
    assert.equal(session.json.role, 'developer')
    const person = master().people.get(admin, made.json.id)
    assert.equal(person.username, 'dev1')
    assert.equal(person.password, true)
    assert.equal(person.invitation, undefined)
    // Used once.
    const again = await onMaster().send('POST', '/auth/invite', {
      token,
      username: 'dev2',
      ...secret,
    })
    assert.equal(again.status, 404)
    assert.equal(
      again.json.error,
      'This invitation link is not valid or has expired',
    )
    // The password signs in on the master.
    const signIn = await onMaster().send('POST', '/api/v2/session', {
      username: 'dev1',
      clientHash: secret.clientHash,
    })
    assert.equal(signIn.status, 200)
    const audit = master()
      .database.db.prepare(
        "SELECT actor,via FROM audit WHERE action='person.invite.accept' AND target=?",
      )
      .get(String(made.json.id)) as { actor: number; via: string }
    assert.deepEqual(
      { ...audit },
      { actor: made.json.id, via: `account:${made.json.id}` },
    )
  })

  it('M2.11 a person with a confirmed email accepts an invitation without a username and signs in by that email', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Mail Only',
      emails: ['mail.only@example.test'],
      invite: true,
    })
    const token = tokenOf(made.json.invitation.url)
    const b = onMaster()
    assert.deepEqual(
      (await b.send('POST', '/auth/invite/lookup', { token })).json,
      { name: 'Mail Only', usernameRequired: false },
    )
    const secret = await password('Mail-Horse-9', 'a1')
    const accepted = await b.send('POST', '/auth/invite', {
      token,
      username: '',
      ...secret,
    })
    assert.equal(accepted.status, 200, accepted.text)
    const person = master().people.get(admin, made.json.id)
    assert.equal(person.username, undefined)
    assert.equal(person.password, true)
    const signIn = await onMaster().send('POST', '/api/v2/session', {
      identifier: 'mail.only@example.test',
      clientHash: secret.clientHash,
    })
    assert.equal(signIn.status, 200, signIn.text)
  })

  it('M2.6 on the host the link sets the password through the master, signs the person in there, and the password then signs in on the host', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Hilda Host',
      emails: ['hilda@example.test'],
      username: 'hilda',
      invite: true,
    })
    const token = tokenOf(made.json.invitation.url)
    const b = onHost()
    const page = await b.send('GET', '/auth/invite')
    assert.equal(page.status, 200)
    assert.match(page.text, /data-lookup="\/auth\/invite\/lookup"/)
    assert.match(
      page.headers.get('content-security-policy')!,
      /'wasm-unsafe-eval'/,
    )
    const foreign = await b.send(
      'POST',
      '/auth/invite/lookup',
      { token },
      { origin: 'https://evil.example.test' },
    )
    assert.equal(foreign.json.error, 'Untrusted origin')
    const found = await b.send('POST', '/auth/invite/lookup', { token })
    assert.deepEqual(found.json, {
      name: 'Hilda Host',
      username: 'hilda',
      usernameRequired: false,
    })
    const secret = await password('Hilda-Horse-9', 'e2')
    const accepted = await b.send('POST', '/auth/invite', {
      token,
      // Someone with a username keeps it.
      username: 'other',
      ...secret,
    })
    assert.equal(accepted.status, 200, accepted.text)
    assert(b.cookies.has('__Host-mason-session'))
    const home = await b.send('GET', '/')
    assert.equal(home.status, 200)
    assert.match(home.text, /aria-label="Your account"/)
    assert.equal(master().people.get(admin, made.json.id).username, 'hilda')
    const reused = await onHost().send('POST', '/auth/invite', {
      token,
      ...secret,
    })
    assert.equal(reused.status, 400)
    assert.equal(
      reused.json.error,
      'This invitation link is not valid or has expired',
    )
    // The password the person chose signs in on the host.
    const fresh = onHost()
    const signedIn = await fresh.send('POST', '/auth/password', {
      username: 'hilda',
      clientHash: secret.clientHash,
    })
    assert.equal(signedIn.status, 200, signedIn.text)
    assert.deepEqual(signedIn.json, { signedIn: true })
  })

  it('M2.7 a new link replaces the old; an expired, revoked, disabled or removed person’s link is refused', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Rita Revoked',
      emails: ['rita@example.test'],
      invite: true,
    })
    const id = made.json.id as number
    const first = tokenOf(made.json.invitation.url)
    const lookup = async (token: string): Promise<number> =>
      (await onMaster().send('POST', '/auth/invite/lookup', { token })).status
    const second = tokenOf(
      (await c.api('POST', `/api/v2/people/${id}/invitation`)).json.url,
    )
    assert.equal(await lookup(first), 404, 'replaced')
    assert.equal(await lookup(second), 200)
    master()
      .database.db.prepare(
        'UPDATE person_invitations SET expires_at=? WHERE account_id=?',
      )
      .run(master().database.now() - 1, id)
    assert.equal(await lookup(second), 404, 'expired')
    assert.equal(master().people.get(admin, id).invitation, undefined)
    master().auth.prune()
    assert.equal(
      master()
        .database.db.prepare(
          'SELECT 1 FROM person_invitations WHERE account_id=?',
        )
        .get(id),
      undefined,
      'pruned',
    )
    const third = tokenOf(
      (await c.api('POST', `/api/v2/people/${id}/invitation`)).json.url,
    )
    assert.equal(
      (await c.api('DELETE', `/api/v2/people/${id}/invitation`)).status,
      200,
    )
    assert.equal(await lookup(third), 404, 'revoked')
    assert.equal(
      (await c.api('DELETE', `/api/v2/people/${id}/invitation`)).status,
      200,
      'revoking none is fine',
    )
    const fourth = tokenOf(
      (await c.api('POST', `/api/v2/people/${id}/invitation`)).json.url,
    )
    await c.api('PUT', `/api/v2/people/${id}`, { disabled: true })
    assert.equal(await lookup(fourth), 404, 'disabled')
    const refused = await c.api('POST', `/api/v2/people/${id}/invitation`)
    assert.equal(refused.status, 409)
    await c.api('PUT', `/api/v2/people/${id}`, { disabled: false })
    const fifth = tokenOf(
      (await c.api('POST', `/api/v2/people/${id}/invitation`)).json.url,
    )
    await c.api('DELETE', `/api/v2/people/${id}`)
    assert.equal(await lookup(fifth), 404, 'removed')
    const actions = master()
      .database.db.prepare(
        "SELECT action FROM audit WHERE action LIKE 'person.invite%' AND target=?",
      )
      .all(String(id))
      .map((row) => row.action)
    assert.deepEqual(actions, [
      'person.invite',
      'person.invite',
      'person.invite',
      'person.invite.revoke',
      'person.invite',
      'person.invite',
    ])
  })

  it('M2.9 a manager cannot move the host address invitation links open at, and a disabled person is not added with an invitation', async () => {
    const manager = master().keys.create(admin, {
      role: 'manager',
      name: 'host address',
    }).token
    const moved = await c.api(
      'PUT',
      '/api/v2/settings/host',
      { origin: 'https://evil.example.test' },
      manager,
    )
    assert.equal(moved.status, 403)
    assert.equal(
      (master().settings.value('host') as { origin: string }).origin,
      HOST,
    )
    assert.equal(
      (await c.api('PUT', '/api/v2/settings/host', { origin: HOST })).status,
      200,
      'an administrator may',
    )
    const before = master().people.list(admin).length
    const refused = await c.api('POST', '/api/v2/people', {
      name: 'Dora Disabled',
      emails: ['dora@example.test'],
      disabled: true,
      invite: true,
    })
    assert.equal(refused.status, 400)
    assert.equal(refused.json.error, 'A disabled person cannot be invited')
    assert.equal(master().people.list(admin).length, before, 'nobody added')
  })

  it('M2.10 only an administrator pairs or unpairs a host node, whose links and sign-ins it would receive', async () => {
    const extra = await startNode(
      {
        role: 'host',
        data: mkdtempSync(
          path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'extra-host-'),
        ),
        port: 0,
        linkPort: 0,
        listen: '127.0.0.1',
        heartbeatMs: 0,
      },
      () => undefined,
    )
    try {
      const manager = master().keys.create(admin, {
        role: 'manager',
        name: 'pairing manager',
      }).token
      const pairing = {
        address: `127.0.0.1:${extra.link!.port}`,
        key: extra.pairing!.key()!,
      }
      const refused = await c.api('POST', '/api/v2/nodes', pairing, manager)
      assert.equal(refused.status, 403, refused.text)
      assert.equal(refused.json.error, 'Only an administrator pairs a host')
      assert.equal(
        master()
          .registry.list()
          .filter((node) => node.role === 'host').length,
        1,
      )
      const paired = await c.api('POST', '/api/v2/nodes', pairing)
      assert.equal(paired.status, 201, paired.text)
      assert.equal(paired.json.role, 'host')
      const route = `/api/v2/nodes/${encodeURIComponent(paired.json.fingerprint)}`
      assert.equal(
        (await c.api('DELETE', route, undefined, manager)).status,
        403,
      )
      assert.equal((await c.api('DELETE', route)).status, 200)
    } finally {
      await extra.close()
    }
  })

  it('M2.8 the People page offers Invite, shows a pending link’s expiry, and the Add form can invite at once', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Paula Page',
      emails: ['paula@example.test'],
      invite: true,
    })
    const b = onMaster()
    const secret = await password('Correct-Horse-9', '0f')
    assert.equal(
      (
        await b.send('POST', '/api/v2/session', {
          username: 'paul',
          clientHash: secret.clientHash,
        })
      ).status,
      200,
    )
    const page = await b.send('GET', '/people')
    assert.equal(page.status, 200)
    assert.match(page.text, />Invite again<\/button>/)
    assert.match(page.text, /<small class="hint">Expires <time/)
    assert(
      page.text.includes(
        `data-path="/api/v2/people/${made.json.id}/invitation" data-method="DELETE"`,
      ),
    )
    assert.match(page.text, /data-then="link"/)
    assert.match(page.text, /name="invite" type="checkbox"/)
    assert(!page.text.includes(tokenOf(made.json.invitation.url)))
  })

  /** An administrator's browser session on the master, and its CSRF proof. */
  const adminSession = async (): Promise<{ b: Browser; csrf: string }> => {
    const b = onMaster()
    const secret = await password('Correct-Horse-9', '0f')
    const signedIn = await b.send('POST', '/api/v2/session', {
      username: 'paul',
      clientHash: secret.clientHash,
    })
    assert.equal(signedIn.status, 200)
    return { b, csrf: signedIn.json.csrf as string }
  }

  it('M4.3 an administrator sets a person’s password and username: their sessions end, it is audited, and it signs them in on the master and the host', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Sam Set',
      emails: ['sam@example.test'],
      invite: true,
    })
    const id = made.json.id as number
    // Sam is signed in on the master already, through an invitation.
    const sam = onMaster()
    const first = await password('Sam-First-9', 'a3')
    assert.equal(
      (
        await sam.send('POST', '/auth/invite', {
          token: tokenOf(made.json.invitation.url),
          username: 'sam-first',
          ...first,
        })
      ).status,
      200,
    )
    assert.equal((await sam.send('GET', '/api/v2/session')).status, 200)
    const before = master().people.get(admin, id).permissionVersion
    const { b, csrf } = await adminSession()
    const chosen = await password('Sam-Second-9', 'b4')
    const set = await b.send(
      'PUT',
      `/api/v2/people/${id}`,
      { username: 'sam', password: chosen },
      { 'x-mason-csrf': csrf },
    )
    assert.equal(set.status, 200, set.text)
    assert.equal(set.json.username, 'sam')
    assert.equal(set.json.password, true)
    assert(set.json.permissionVersion > before)
    assert(!set.text.includes(chosen.clientHash))
    assert.equal(
      (await sam.send('GET', '/api/v2/session')).status,
      401,
      'their sessions end',
    )
    const paul = master()
      .database.db.prepare('SELECT id FROM accounts WHERE username=?')
      .get('paul') as { id: number }
    const audit = master()
      .database.db.prepare(
        "SELECT actor FROM audit WHERE action='person.password' AND target=?",
      )
      .all(String(id))
      .map((row) => row.actor)
    assert.deepEqual(audit, [paul.id])
    // The old password is gone; the new one signs in on the master…
    assert.equal(
      (
        await onMaster().send('POST', '/api/v2/session', {
          username: 'sam',
          clientHash: first.clientHash,
        })
      ).status,
      401,
    )
    const master1 = await onMaster().send('POST', '/api/v2/session', {
      username: 'sam',
      clientHash: chosen.clientHash,
    })
    assert.equal(master1.status, 200)
    assert.equal(master1.json.name, 'Sam Set')
    // …and on the host.
    const host1 = await onHost().send('POST', '/auth/password', {
      username: 'sam',
      clientHash: chosen.clientHash,
    })
    assert.equal(host1.status, 200, host1.text)
  })

  it('M2.13 a password signs in on the host by email, through its form and the link, and a page sending username still works', async () => {
    const chosen = await password('Ivy-Horse-9', 'e7')
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Ivy Email',
      emails: ['ivy.mail@example.test', 'ivy.two@example.test'],
      password: chosen,
    })
    assert.equal(made.status, 201, made.text)
    await c.until(
      () =>
        host
          .host!.cache.db.prepare('SELECT 1 FROM accounts WHERE id=?')
          .get(made.json.id) != null,
    )
    const parameters = await onHost().send(
      'POST',
      '/auth/password/parameters',
      { identifier: 'IVY.TWO@example.test' },
    )
    assert.equal(parameters.status, 200, parameters.text)
    assert.deepEqual(parameters.json, chosen.clientParameters)
    for (const body of [
      { identifier: 'ivy.mail@example.test', clientHash: chosen.clientHash },
      { identifier: 'Ivy.Two@example.test', clientHash: chosen.clientHash },
      { username: 'ivy.mail@example.test', clientHash: chosen.clientHash },
    ]) {
      const signedIn = await onHost().send('POST', '/auth/password', body)
      assert.equal(
        signedIn.status,
        200,
        `${JSON.stringify(body)} ${signedIn.text}`,
      )
    }
    // Her account page on the host knows she has a password (M4).
    const ivy = onHost()
    await ivy.send('POST', '/auth/password', {
      identifier: 'ivy.mail@example.test',
      clientHash: chosen.clientHash,
    })
    assert.match(
      (await ivy.send('GET', '/account')).text,
      /data-open="password-own">Change password</,
    )
    const wrong = await onHost().send('POST', '/auth/password', {
      identifier: 'ivy.mail@example.test',
      clientHash: '0'.repeat(64),
    })
    assert.equal(wrong.status, 401)
  })

  it('M4.4 only an administrator sets another’s password, a person only their own, and a new password must meet the minimum costs', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Morgan Manager',
      username: 'morgan',
      role: 'manager',
      emails: ['morgan@example.test'],
    })
    const target = await c.api('POST', '/api/v2/people', {
      name: 'Nobody Yet',
      emails: ['nobody@example.test'],
    })
    const chosen = await password('Morgan-Horse-9', 'c5')
    const manager = master().keys.create(admin, {
      role: 'manager',
      name: 'manager key',
    }).token
    const refused = await c.api(
      'PUT',
      `/api/v2/people/${target.json.id}`,
      { username: 'nobody', password: chosen },
      manager,
    )
    assert.equal(refused.status, 403)
    assert.equal(master().people.get(admin, target.json.id).password, false)
    // A manager may still set their own password.
    const self = onMaster()
    await master().people.update(admin, made.json.id, { password: chosen })
    const signedIn = await self.send('POST', '/api/v2/session', {
      username: 'morgan',
      clientHash: chosen.clientHash,
    })
    const own = await self.send(
      'PUT',
      `/api/v2/people/${made.json.id}`,
      { password: await password('Morgan-Again-9', 'c6') },
      { 'x-mason-csrf': signedIn.json.csrf },
    )
    assert.equal(own.status, 200, own.text)
    const weak = {
      clientHash: chosen.clientHash,
      clientParameters: { ...chosen.clientParameters, iterations: 2 },
    }
    const low = await c.api('PUT', `/api/v2/people/${target.json.id}`, {
      username: 'nobody',
      password: weak,
    })
    assert.equal(low.status, 400)
    assert.match(low.json.error, /at least 32 MiB, 6 iterations and 4 lanes/)
    // A person with an email needs no username for a password.
    assert.equal(
      (
        await c.api('PUT', `/api/v2/people/${target.json.id}`, {
          password: chosen,
        })
      ).status,
      200,
    )
    assert.equal(
      (
        await c.api('PUT', `/api/v2/people/${target.json.id}`, {
          username: 'nobody',
          password: 'Plain-Text-9',
        })
      ).status,
      400,
    )
    assert.equal(master().people.get(admin, target.json.id).password, true)
  })

  it('M4.5 the People page lets an administrator set a password, and loads the password hashing it needs', async () => {
    const { b } = await adminSession()
    const page = await b.send('GET', '/people')
    assert.match(
      page.headers.get('content-security-policy')!,
      /'wasm-unsafe-eval'/,
    )
    assert.match(
      page.text,
      /<form data-mason="person-password" data-path="\/api\/v2\/people\/\d+">/,
    )
    assert.match(page.text, /Change password/)
    assert.match(page.text, /<form data-mason="person-add">/)
    assert.match(page.text, /name="confirm" type="password"/)
  })

  it('M4.6 setting a password, by an administrator or by the person, ends their invitation link', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Ivy Invited',
      username: 'ivy',
      emails: ['ivy@example.test'],
      invite: true,
    })
    const id = made.json.id as number
    const lookup = async (url: string): Promise<number> =>
      (
        await onMaster().send('POST', '/auth/invite/lookup', {
          token: tokenOf(url),
        })
      ).status
    assert.equal(await lookup(made.json.invitation.url), 200)
    const chosen = await password('Ivy-Horse-9', 'f1')
    const set = await c.api('PUT', `/api/v2/people/${id}`, {
      password: chosen,
    })
    assert.equal(set.status, 200, set.text)
    assert.equal(set.json.invitation, undefined)
    assert.equal(await lookup(made.json.invitation.url), 404)
    // Her own change ends a newer link too.
    const again = (await c.api('POST', `/api/v2/people/${id}/invitation`)).json
      .url as string
    const ivy = onMaster()
    const signedIn = await ivy.send('POST', '/api/v2/session', {
      username: 'ivy',
      clientHash: chosen.clientHash,
    })
    const own = await ivy.send(
      'PUT',
      `/api/v2/people/${id}`,
      { password: await password('Ivy-Again-9', 'f2') },
      { 'x-mason-csrf': signedIn.json.csrf },
    )
    assert.equal(own.status, 200, own.text)
    assert.equal(await lookup(again), 404)
    const actions = master()
      .database.db.prepare(
        "SELECT action,actor FROM audit WHERE action='person.invite.revoke' AND target=? ORDER BY id",
      )
      .all(String(id))
      .map((row) => row.actor)
    assert.equal(actions.length, 2)
    assert.equal(actions[1], id, 'her own change is audited as hers')
  })

  it('M4.8 disabling a person and setting their password at once revokes their link once and audits it', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Della Both',
      username: 'della',
      emails: ['della@example.test'],
      invite: true,
    })
    const id = made.json.id as number
    const changed = await c.api('PUT', `/api/v2/people/${id}`, {
      disabled: true,
      password: await password('Della-Horse-9', 'f3'),
    })
    assert.equal(changed.status, 200, changed.text)
    assert.equal(
      (
        await onMaster().send('POST', '/auth/invite/lookup', {
          token: tokenOf(made.json.invitation.url),
        })
      ).status,
      404,
    )
    const actions = master()
      .database.db.prepare(
        "SELECT action FROM audit WHERE target=? AND action IN ('person.password','person.invite.revoke') ORDER BY id",
      )
      .all(String(id))
      .map((row) => row.action)
    assert.deepEqual(actions, ['person.password', 'person.invite.revoke'])
  })

  it('M4.7 a person’s username may change case, but not to another’s in any case', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Sam Case',
      username: 'SamCase',
      emails: ['samcase@example.test'],
    })
    const lower = await c.api('PUT', `/api/v2/people/${made.json.id}`, {
      username: 'samcase',
    })
    assert.equal(lower.status, 200, lower.text)
    assert.equal(lower.json.username, 'samcase')
    const taken = await c.api('PUT', `/api/v2/people/${made.json.id}`, {
      username: 'PAUL',
    })
    assert.equal(taken.status, 409)
  })
})
