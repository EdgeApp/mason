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
      email: 'early@example.test',
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
      email: 'tess@example.test',
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
          email: 'x@example.test',
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
      email: 'dev@example.test',
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
    const found = await b.send('POST', '/auth/invite/lookup', { token })
    assert.deepEqual(found.json, { name: 'Dev One' })
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

  it('M2.6 on the host the link sets the password through the master, signs the person in there, and the password then signs in on the host', async () => {
    const made = await c.api('POST', '/api/v2/people', {
      name: 'Hilda Host',
      email: 'hilda@example.test',
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
    assert.deepEqual(found.json, { name: 'Hilda Host', username: 'hilda' })
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
    assert.match(home.text, /Sign out/)
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
      email: 'rita@example.test',
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
      email: 'dora@example.test',
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
      email: 'paula@example.test',
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
    assert.match(page.text, /Invited · the link expires <time/)
    assert(
      page.text.includes(
        `data-path="/api/v2/people/${made.json.id}/invitation" data-method="DELETE"`,
      ),
    )
    assert.match(page.text, /data-then="link"/)
    assert.match(page.text, /name="invite" type="checkbox"/)
    assert(!page.text.includes(tokenOf(made.json.invitation.url)))
  })
})
