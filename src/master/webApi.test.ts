import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { RunningNode } from '../node/serve.js'
import {
  asNodeInfo,
  asSessionInfo,
  type NodeInfo,
} from '../shared/api/index.js'
import { permissions, roles, type Role } from '../shared/permissions.js'
import { cluster, type Cluster } from '../test/cluster.js'
import { proofLog } from '../test/proofLog.js'
import { repository, version } from '../version.js'
import { policy, permissionsOf } from './permissions.js'
import { localOperator, rank } from './roles.js'
import { masterNodeInfo } from './web.js'

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'webapi-'))

interface Reply {
  status: number
  // API responses are read field by field in assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
  text: string
}

/** A request to a node's web listener, logged to the proof log. */
async function request(
  node: RunningNode,
  method: string,
  route: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await pinnedFetch(
    node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:') + route,
    { method, headers },
    node.web!.certificate?.pin,
  )
  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  proofLog(`${method} ${route}`, `${response.status} ${text}`)
  return { status: response.status, json, text }
}

describe('Master web API: node and session', function () {
  this.timeout(120_000)
  let c: Cluster
  before(async () => {
    c = await cluster(root(), { master: { testEndpoints: true } })
  })
  after(async () => {
    await c?.close()
  })
  const master = (): NonNullable<RunningNode['master']> => c.master.master!

  it('the shared permission names are exactly the policy table’s, and each role holds those at or below it', () => {
    assert.deepEqual(Object.keys(policy).sort(), [...permissions].sort())
    for (const role of roles)
      assert.deepEqual(
        permissionsOf(role),
        permissions.filter((name) => rank(role) >= rank(policy[name])),
      )
    assert.deepEqual(permissionsOf('tester'), [
      'builds.read',
      'devices.register',
    ])
    assert.deepEqual(permissionsOf('admin'), [...permissions])
  })

  it('GET /api/v2/node answers without a session: role, version, sign-in, state and test endpoints', async () => {
    const plain = await request(c.master, 'GET', '/api/v2/node')
    assert.equal(plain.status, 200, plain.text)
    const info: NodeInfo = asNodeInfo(plain.json)
    assert.deepEqual(plain.json, {
      role: 'master',
      version,
      setupNeeded: false,
      signIn: { password: true, providers: [] },
      state: 'ok',
      testEndpoints: true,
      ...(repository == null ? {} : { release: { repository, version } }),
    })
    assert.equal(info.masterOrigin, undefined)
    // The origins and the offered methods follow the settings.
    await master().settings.set(localOperator, 'master', {
      origin: 'https://mason.example.test',
    })
    await master().settings.set(localOperator, 'host', {
      origin: 'https://builds.example.test',
    })
    await master().settings.set(localOperator, 'signIn', {
      methods: [
        {
          id: 'google',
          name: 'Google',
          type: 'oidc',
          issuer: 'https://accounts.example.test',
          clientId: 'mason',
          clientSecret: 'never-shown',
        },
        {
          id: 'off',
          name: 'Off',
          type: 'oidc',
          issuer: 'https://accounts.example.test',
          clientId: 'mason',
          clientSecret: 'never-shown',
          enabled: false,
        },
      ],
    })
    const set = await request(c.master, 'GET', '/api/v2/node')
    assert.equal(set.json.masterOrigin, 'https://mason.example.test')
    assert.equal(set.json.hostOrigin, 'https://builds.example.test')
    assert.deepEqual(set.json.signIn, {
      password: true,
      providers: [{ id: 'google', name: 'Google' }],
    })
    assert.doesNotMatch(set.text, /never-shown/)
    // A master with no account yet asks for setup.
    assert.equal(
      masterNodeInfo({
        role: 'master',
        testEndpoints: false,
        configured: () => false,
        master: master(),
      }).setupNeeded,
      true,
    )
  })

  it('GET /api/v2/session names the permissions each role holds and the person’s emails', async () => {
    for (const role of roles) {
      const person = await master().people.create(localOperator, {
        name: `Session ${role}`,
        role,
        emails: [`${role}@example.com`, `${role}.second@example.com`],
      })
      const { token } = master().auth.start(person.id, '127.0.0.1')
      const reply = await request(c.master, 'GET', '/api/v2/session', {
        cookie: `__Host-mason-master=${token}`,
      })
      assert.equal(reply.status, 200, reply.text)
      const session = asSessionInfo(reply.json)
      assert.equal(session.accountId, person.id)
      assert.equal(session.role, role)
      assert.match(session.csrf, /^[A-Za-z0-9_-]{43}$/)
      assert.deepEqual(session.permissions, permissionsOf(role as Role))
      assert.deepEqual(session.emails, [
        { email: `${role}@example.com`, confirmed: true },
        { email: `${role}.second@example.com`, confirmed: true },
      ])
      assert.deepEqual(Object.keys(reply.json).sort(), [
        'accountId',
        'csrf',
        'emails',
        'name',
        'permissions',
        'role',
      ])
    }
  })

  it('GET /api/v2/session is a browser session’s only: an API key is not one', async () => {
    const key = master().keys.create(localOperator, {
      role: 'manager',
      name: 'session probe',
    }).token
    const reply = await request(c.master, 'GET', '/api/v2/session', {
      authorization: `Bearer ${key}`,
    })
    assert.equal(reply.status, 401)
    assert.deepEqual(reply.json, { error: 'Not signed in' })
  })
})
