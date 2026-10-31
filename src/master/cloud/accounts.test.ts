import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'mocha'
import { nodeMain, type MainIO } from '../../node/main.js'
import { pinnedFetch } from '../../node/pinnedFetch.js'
import { cluster, type Cluster } from '../../test/cluster.js'
import { MASTER_SESSION_COOKIE } from '../auth.js'
import { localOperator } from '../roles.js'
import { migrateMaster } from '../schema.js'
import { accountId, cloudAccountsArea, storedAccounts } from './accounts.js'

// Replies are read field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = (): string =>
  mkdtempSync(
    path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'accounts-'),
  )
const DO_KEY = 'dop_v1_' + 'a'.repeat(64)
const MAC_KEY = 'nmk_' + 'b'.repeat(40)
const WRONG = 'dop_v1_' + 'e'.repeat(64)

describe('Cloud accounts', function () {
  this.timeout(120_000)
  let c: Cluster
  let offset = 0
  let mode: 'ok' | 'timeout' | 'down' | 'odd' = 'ok'
  const calls: string[] = []
  const people: Record<string, number> = {}

  /** DigitalOcean and NoMac as the master's checks see them. */
  const providers = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    calls.push(target)
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    if (mode === 'timeout') {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    }
    if (mode === 'down')
      return new Response('<h1>Bad gateway</h1>', { status: 502 })
    if (mode === 'odd')
      return Response.json(
        { error: { message: 'Mac use is paused' } },
        { status: 409 },
      )
    if (auth.endsWith(WRONG))
      return Response.json(
        { id: 'unauthorized', message: 'Unable to authenticate you' },
        { status: 401 },
      )
    if (target === 'https://do.example.test/v2/account')
      return Response.json({
        account: {
          email: 'ops@example.com',
          droplet_limit: 25,
          status: 'active',
        },
      })
    if (target === 'https://nomac.example.test/api/v1/me')
      return Response.json({ org: { name: 'Example' } })
    if (target === 'https://nomac.example.test/api/v1/mac/credits')
      return Response.json({
        credits: {
          spendable_microunits: '10000000',
          spendable_seconds: 45000,
          concurrency_limit: 1,
          spending_blocked: false,
        },
      })
    return new Response('{}', { status: 404 })
  }) as typeof fetch

  const origin = (): string =>
    c.master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
  const request = async (
    method: string,
    route: string,
    options: { cookie?: string; csrf?: string; body?: unknown } = {},
  ): Promise<{ status: number; text: string; json: Json }> => {
    const response = await pinnedFetch(
      origin() + route,
      {
        method,
        redirect: 'manual',
        headers: {
          ...(options.cookie == null ? {} : { cookie: options.cookie }),
          ...(options.csrf == null
            ? {}
            : { 'x-mason-csrf': options.csrf, origin: origin() }),
          ...(options.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      },
      c.master.web!.certificate!.pin,
    )
    const text = await response.text()
    let json: Json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, text, json }
  }
  const signIn = (role: string): { cookie: string; csrf: string } => {
    const { token, session } = c.master.master!.auth.start(
      people[role]!,
      '127.0.0.1',
    )
    return { cookie: `${MASTER_SESSION_COOKIE}=${token}`, csrf: session.csrf }
  }
  const io = (stdin?: string): MainIO & { lines: string[] } => {
    const lines: string[] = []
    return {
      lines,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      ...(stdin == null ? {} : { stdin: async () => stdin }),
      system: (): never => {
        throw new Error('unused')
      },
      stopped: async () => undefined,
      program: () => [],
    }
  }

  before(async () => {
    c = await cluster(path.join(root(), 'cluster'), {
      workers: [],
      masterOptions: {
        now: () => Date.now() + offset,
        cloudAccounts: {
          fetch: providers,
          endpoints: {
            digitalocean: 'https://do.example.test/v2',
            nomac: 'https://nomac.example.test/api/v1',
          },
        },
      },
    })
    for (const role of ['admin', 'manager', 'developer'] as const)
      people[role] = (
        await c.master.master!.people.create(localOperator, {
          email: `${role}@example.test`,
          name: `${role} person`,
          role,
          addresses: { google: `${role}@example.test` },
        })
      ).id
  })
  after(async () => {
    await c?.close()
  })

  it('U1.1 validates provider, id, name and key, and keeps keys write-only', async () => {
    const settings = c.master.master!.settings
    const account = (
      extra: Record<string, unknown>,
    ): Record<string, unknown> => ({
      id: 'do',
      name: 'DigitalOcean',
      provider: 'digitalocean',
      key: DO_KEY,
      ...extra,
    })
    const refuses = async (
      accounts: unknown,
      pattern: RegExp,
    ): Promise<void> => {
      await assert.rejects(
        settings.set(localOperator, 'cloudAccounts', { accounts }),
        pattern,
      )
    }
    await refuses('none', /accounts is a list/)
    await refuses([account({ id: 'Not A Slug' })], /account.id is a slug/)
    await refuses(
      [account({ provider: 'aws' })],
      /provider is digitalocean or nomac/,
    )
    await refuses([account({ name: '' })], /name is up to 80 characters/)
    await refuses([account({ name: 'x'.repeat(81) })], /name is up to 80/)
    await refuses([account({ name: 'tab\there' })], /name is up to 80/)
    await refuses(
      [account({ key: 'short' })],
      /key is a DigitalOcean API token/,
    )
    await refuses(
      [account({ provider: 'nomac', key: DO_KEY })],
      /key is a NoMac API key/,
    )
    await refuses([account({ key: { keep: true } })], /no stored key to keep/)
    await refuses([account({}), account({})], /listed twice/)
    await refuses([null], /account.id is a slug/)
    await settings.set(localOperator, 'cloudAccounts', {
      accounts: [account({ name: '  DigitalOcean  ' })],
    })
    const shown = settings.get(localOperator, 'cloudAccounts') as Json
    assert.deepEqual(shown.accounts, [
      {
        id: 'do',
        name: 'DigitalOcean',
        provider: 'digitalocean',
        key: { set: true },
      },
    ])
    assert(!JSON.stringify(shown).includes(DO_KEY))
    // Keep reuses the stored key; a different provider cannot keep it.
    await settings.set(localOperator, 'cloudAccounts', {
      accounts: [account({ name: 'DO', key: { keep: true } })],
    })
    assert.equal(c.master.master!.cloudAccounts.get('do')!.key, DO_KEY)
    await refuses(
      [account({ provider: 'nomac', key: { keep: true } })],
      /no stored key/,
    )
    // An empty area is no accounts.
    await settings.set(localOperator, 'cloudAccounts', {})
    assert.deepEqual(c.master.master!.cloudAccounts.all(), [])
    assert.deepEqual(storedAccounts(undefined), [])
    assert.equal(accountId('DigitalOcean (prod)', []), 'digitalocean-prod')
    assert.equal(accountId('NoMac', ['nomac', 'nomac-2']), 'nomac-3')
    assert.equal(accountId('***', []), 'account')
    // A replaced provider counts as removal for what uses the account.
    const area = cloudAccountsArea((id) => (id === 'do' ? ['pool p'] : []))
    assert.throws(
      () =>
        area.validate(
          { accounts: [account({ provider: 'nomac', key: MAC_KEY })] },
          { accounts: [account({})] },
          { actor: localOperator, now: 0 },
        ),
      /Account do is used by pool p; change or remove it first/,
    )
  })

  it('U1.2 schema 11 moves cloud.token into the digitalocean account and names it in every pool', () => {
    const dir = root()
    const legacy = (cloud: unknown): DatabaseSync => {
      const db = new DatabaseSync(path.join(dir, `${Math.random()}.sqlite`))
      migrateMaster(db)
      // Back to schema 10 as a master upgraded from 0.1.8 has it.
      db.exec(`ALTER TABLE cloud_machines DROP COLUMN account;
        ALTER TABLE cloud_snapshots DROP COLUMN account;
        DROP TABLE cloud_hosts;
        UPDATE meta SET value='10' WHERE key='master_schema';`)
      if (cloud != null)
        db.prepare(
          "INSERT INTO settings(area,value,updated_at,updated_by) VALUES('cloud',?,0,'fixture')",
        ).run(JSON.stringify(cloud))
      db.exec(
        "INSERT INTO cloud_machines(pool,state,size,created_at) VALUES('linux','ready','s-1vcpu-1gb',0)",
      )
      migrateMaster(db)
      return db
    }
    const setting = (db: DatabaseSync, area: string): Json =>
      JSON.parse(
        (
          (db.prepare('SELECT value FROM settings WHERE area=?').get(area) as
            | { value: string }
            | undefined) ?? { value: 'null' }
        ).value,
      )
    const upgraded = legacy({
      token: DO_KEY,
      monthlyBudget: 50,
      pools: [
        { name: 'linux', type: 'linux' },
        { name: 'big', type: 'big', account: 'other' },
      ],
    })
    assert.deepEqual(setting(upgraded, 'cloudAccounts'), {
      accounts: [
        {
          id: 'digitalocean',
          name: 'DigitalOcean',
          provider: 'digitalocean',
          key: DO_KEY,
        },
      ],
    })
    assert.deepEqual(setting(upgraded, 'cloud'), {
      monthlyBudget: 50,
      // Schema 22 then labels every pool's machines for setup.
      pools: [
        {
          name: 'linux',
          type: 'linux',
          account: 'digitalocean',
          labels: ['setup'],
        },
        { name: 'big', type: 'big', account: 'other', labels: ['setup'] },
      ],
    })
    assert.equal(
      (
        upgraded.prepare('SELECT account FROM cloud_machines').get() as {
          account: string
        }
      ).account,
      'digitalocean',
    )
    upgraded.close()
    // Without a token there is no account; without a cloud area nothing changes.
    const tokenless = legacy({ monthlyBudget: 10 })
    assert.equal(setting(tokenless, 'cloudAccounts'), null)
    assert.deepEqual(setting(tokenless, 'cloud'), {
      monthlyBudget: 10,
      pools: [],
    })
    assert.equal(
      (
        tokenless.prepare('SELECT account FROM cloud_machines').get() as {
          account: string | null
        }
      ).account,
      null,
    )
    tokenless.close()
    const empty = legacy(undefined)
    assert.equal(setting(empty, 'cloud'), null)
    empty.close()
  })

  it('U1.3 checks show the DigitalOcean account and NoMac credit, each failure its own state, cached for a minute', async () => {
    const admin = c.admin
    const added = await c.api(
      'POST',
      '/api/v2/cloud/accounts',
      {
        provider: 'digitalocean',
        name: 'DigitalOcean',
        key: ` ${DO_KEY}\n`,
      },
      admin,
    )
    assert.equal(added.status, 201, added.text)
    assert.deepEqual(added.json, {
      id: 'digitalocean',
      name: 'DigitalOcean',
      provider: 'digitalocean',
      key: { set: true },
    })
    const mac = await c.api(
      'POST',
      '/api/v2/cloud/accounts',
      {
        id: 'mac',
        provider: 'nomac',
        name: 'NoMac',
        key: MAC_KEY,
      },
      admin,
    )
    assert.equal(mac.status, 201, mac.text)
    const taken = await c.api(
      'POST',
      '/api/v2/cloud/accounts',
      {
        id: 'mac',
        provider: 'nomac',
        name: 'Again',
        key: MAC_KEY,
      },
      admin,
    )
    assert.equal(taken.status, 400)
    assert.match(taken.json.error, /already exists/)

    const check = async (id: string): Promise<Json> => {
      const reply = await c.api(
        'POST',
        `/api/v2/cloud/accounts/${id}/check`,
        {},
        admin,
      )
      assert.equal(reply.status, 200, reply.text)
      return reply.json.check
    }
    const digitalocean = await check('digitalocean')
    assert.equal(digitalocean.state, 'ok')
    assert.deepEqual(digitalocean.digitalocean, {
      email: 'ops@example.com',
      dropletLimit: 25,
      status: 'active',
    })
    const nomac = await check('mac')
    assert.equal(nomac.state, 'ok')
    assert.deepEqual(nomac.nomac, {
      credit: 10,
      spendableSeconds: 45000,
      concurrency: 1,
      spendingBlocked: false,
    })
    mode = 'timeout'
    assert.equal((await check('digitalocean')).state, 'timeout')
    mode = 'down'
    const down = await check('mac')
    assert.equal(down.state, 'unavailable')
    assert.match(down.message, /NoMac answered 502/)
    mode = 'odd'
    const odd = await check('mac')
    assert.equal(odd.state, 'error')
    assert.match(odd.message, /409 Mac use is paused/)
    mode = 'ok'
    // A refused key.
    const wrong = await c.api(
      'POST',
      '/api/v2/cloud/accounts',
      {
        id: 'wrong',
        provider: 'digitalocean',
        name: 'Wrong',
        key: WRONG,
      },
      admin,
    )
    assert.equal(wrong.status, 201)
    const refused = await check('wrong')
    assert.equal(refused.state, 'refused')
    assert.match(refused.message, /DigitalOcean refused the key/)
    assert.equal(
      (await c.api('POST', '/api/v2/cloud/accounts/none/check', {}, admin))
        .status,
      404,
    )

    // The list shows the last checks; the page's checks reuse them for a minute.
    await check('mac')
    await check('digitalocean')
    const listed = await c.api(
      'GET',
      '/api/v2/cloud/accounts',
      undefined,
      admin,
    )
    assert.deepEqual(
      listed.json.map((entry: Json) => [entry.id, entry.check.state]),
      [
        ['digitalocean', 'ok'],
        ['mac', 'ok'],
        ['wrong', 'refused'],
      ],
    )
    assert(!listed.text.includes(DO_KEY) && !listed.text.includes(MAC_KEY))
    const accounts = c.master.master!.cloudAccounts
    calls.length = 0
    await accounts.checked(localOperator)
    assert.equal(calls.length, 0, 'cached')
    offset += 61_000
    await accounts.checked(localOperator)
    assert.equal(
      calls.length,
      4,
      'one DigitalOcean call each, and /me and /mac/credits',
    )
    // An unreachable provider is unavailable, not refused.
    const failing =
      new (accounts.constructor as typeof import('./accounts.js').CloudAccounts)(
        {
          settings: c.master.master!.settings,
          now: Date.now,
          fetch: (async () => {
            throw new TypeError('fetch failed')
          }) as typeof fetch,
        },
      )
    const unreachable = await failing.check(localOperator, 'digitalocean')
    assert.equal(unreachable.check!.state, 'unavailable')
    assert.match(unreachable.check!.message!, /unreachable: fetch failed/)
    const odder =
      new (accounts.constructor as typeof import('./accounts.js').CloudAccounts)(
        {
          settings: c.master.master!.settings,
          now: Date.now,
          fetch: (async () => Response.json({})) as typeof fetch,
        },
      )
    const blank = await odder.check(localOperator, 'mac')
    assert.deepEqual(blank.check!.nomac, {
      credit: 0,
      spendableSeconds: 0,
      concurrency: 0,
      spendingBlocked: false,
    })
    const blankDo = await odder.check(localOperator, 'digitalocean')
    assert.deepEqual(blankDo.check!.digitalocean, {
      email: '',
      dropletLimit: 0,
      status: '',
    })
  })

  it('U1.4 an account a pool uses cannot be removed, and the refusal names the pool', async () => {
    const admin = c.admin
    await c.master.master!.settings.set(localOperator, 'cloud', {
      pools: [
        {
          name: 'linux',
          type: 'linux',
          account: 'digitalocean',
          region: 'sfo3',
          size: 's-1vcpu-1gb',
          image: 'ubuntu-24-04-x64',
        },
      ],
    })
    const refused = await c.api(
      'DELETE',
      '/api/v2/cloud/accounts/digitalocean',
      undefined,
      admin,
    )
    assert.equal(refused.status, 400)
    assert.match(
      refused.json.error,
      /Account digitalocean is used by pool linux/,
    )
    const removed = await c.api(
      'DELETE',
      '/api/v2/cloud/accounts/wrong',
      undefined,
      admin,
    )
    assert.equal(removed.status, 200, removed.text)
    assert.equal(
      (await c.api('DELETE', '/api/v2/cloud/accounts/wrong', undefined, admin))
        .status,
      404,
    )
    // With the pool gone, the account can go.
    await c.master.master!.settings.set(localOperator, 'cloud', { pools: [] })
    assert.equal(
      (
        await c.api(
          'DELETE',
          '/api/v2/cloud/accounts/digitalocean',
          undefined,
          admin,
        )
      ).status,
      200,
    )
    assert.deepEqual(
      c.master.master!.cloudAccounts.all().map((account) => account.id),
      ['mac'],
    )
  })

  it('U1.5 /cloud is for administrators and managers, sends changes with CSRF, and never echoes a key', async () => {
    const admin = signIn('admin')
    const page = await request('GET', '/cloud', admin)
    assert.equal(page.status, 200)
    assert.match(page.text, /<h1>Cloud<\/h1>/)
    assert.match(page.text, /href="\/cloud"/)
    assert.match(page.text, /data-account="mac"/)
    assert.match(page.text, /\$10\.00 \(12\.5 hours\)/)
    assert.match(
      page.text,
      /<input id="account-key" name="key" type="password" autocomplete="off" required>/,
    )
    assert.match(
      page.text,
      /data-path="\/api\/v2\/cloud\/accounts\/mac\/check"/,
    )
    assert.match(
      page.text,
      /data-path="\/api\/v2\/cloud\/accounts\/mac" data-method="DELETE"/,
    )
    assert(!page.text.includes(MAC_KEY))
    const manager = await request('GET', '/cloud', signIn('manager'))
    assert.equal(manager.status, 200)
    assert.match(manager.text, /Add account/)
    const developer = await request('GET', '/cloud', signIn('developer'))
    assert.equal(developer.status, 403)
    assert.doesNotMatch(developer.text, /href="\/cloud"/)
    assert.equal((await request('GET', '/cloud')).status, 303)
    // Changes need the session's CSRF token.
    const body = { provider: 'digitalocean', name: 'Session', key: DO_KEY }
    const forged = await request('POST', '/api/v2/cloud/accounts', {
      cookie: admin.cookie,
      body,
    })
    assert.equal(forged.status, 403)
    const sent = await request('POST', '/api/v2/cloud/accounts', {
      ...admin,
      body,
    })
    assert.equal(sent.status, 201, sent.text)
    assert.equal(sent.json.id, 'session')
    const developerAdd = await request('POST', '/api/v2/cloud/accounts', {
      ...signIn('developer'),
      body: { ...body, name: 'Nope' },
    })
    assert.equal(developerAdd.status, 403)
    // Failed and unchecked accounts read as such.
    mode = 'down'
    await c.api('POST', '/api/v2/cloud/accounts/session/check', {}, c.admin)
    mode = 'ok'
    const failed = await request('GET', '/cloud', admin)
    assert.match(failed.text, /Unavailable: DigitalOcean answered 502/)
    const view = await import('../../view/admin.js')
    const now = Date.now()
    const rendered = view.cloudView({
      accounts: [
        { id: 'a', name: 'A', provider: 'nomac' },
        {
          id: 'b',
          name: 'B',
          provider: 'digitalocean',
          check: { state: 'refused', checkedAt: now, message: 'no' },
        },
        {
          id: 'c',
          name: 'C',
          provider: 'digitalocean',
          check: { state: 'timeout', checkedAt: now },
        },
        {
          id: 'd',
          name: 'D',
          provider: 'digitalocean',
          check: { state: 'error', checkedAt: now },
        },
        {
          id: 'e',
          name: 'E',
          provider: 'nomac',
          check: {
            state: 'ok',
            checkedAt: now - 120_000,
            nomac: {
              credit: 0,
              spendableSeconds: 0,
              concurrency: 1,
              spendingBlocked: true,
            },
          },
        },
      ],
      canChange: false,
      now,
    })
    assert.match(rendered, /Not checked yet/)
    assert.match(rendered, /Key refused: no/)
    assert.match(rendered, /No answer/)
    assert.match(rendered, /Check failed/)
    assert.match(rendered, /Paused for the account/)
    assert.match(rendered, /Checked 2m ago/)
    assert.doesNotMatch(rendered, /Add account|data-method="DELETE"/)
    assert.match(
      view.cloudView({ accounts: [], canChange: true, now }),
      /No cloud accounts yet/,
    )
    await c.api('DELETE', '/api/v2/cloud/accounts/session', undefined, c.admin)
  })

  it('U1.6 mason cloud accounts adds, lists, checks and removes, reading the key from stdin', async () => {
    const data = c.master.dir
    const fails = async (argv: string[], pattern: RegExp): Promise<void> => {
      const out = io()
      assert.equal(await nodeMain([...argv, '--data', data], out), 1)
      assert.match(out.lines.join('\n'), pattern)
    }
    const add = io(`${DO_KEY}\n`)
    assert.equal(
      await nodeMain(
        [
          'cloud',
          'accounts',
          'add',
          '--data',
          data,
          '--provider',
          'digitalocean',
          '--name',
          'Ops',
          '--key-stdin',
        ],
        add,
      ),
      0,
    )
    assert.deepEqual(add.lines, ['Added cloud account ops'])
    const withId = io(MAC_KEY)
    assert.equal(
      await nodeMain(
        [
          'cloud',
          'accounts',
          'add',
          '--data',
          data,
          '--provider',
          'nomac',
          '--name',
          'Mac two',
          '--id',
          'mac2',
          '--key-stdin',
        ],
        withId,
      ),
      0,
    )
    await fails(
      ['cloud', 'accounts', 'add', '--provider', 'nomac', '--name', 'x'],
      /--key-stdin/,
    )
    const checked = io()
    assert.equal(
      await nodeMain(
        ['cloud', 'accounts', 'check', 'ops', '--data', data],
        checked,
      ),
      0,
    )
    assert.deepEqual(checked.lines, [
      'ops  digitalocean  Ops  ok: ops@example.com, 25 droplets',
    ])
    const macChecked = io()
    assert.equal(
      await nodeMain(
        ['cloud', 'accounts', 'check', 'mac2', '--data', data],
        macChecked,
      ),
      0,
    )
    assert.deepEqual(macChecked.lines, [
      'mac2  nomac  Mac two  ok: $10.00 credit, 1 at a time',
    ])
    mode = 'down'
    const failed = io()
    assert.equal(
      await nodeMain(
        ['cloud', 'accounts', 'check', 'ops', '--data', data],
        failed,
      ),
      1,
    )
    assert.match(
      failed.lines[0]!,
      /^ops  digitalocean  Ops  unavailable: DigitalOcean answered 502/,
    )
    mode = 'ok'
    const listed = io()
    assert.equal(
      await nodeMain(['cloud', 'accounts', 'list', '--data', data], listed),
      0,
    )
    assert(listed.lines.some((line) => line.startsWith('mac  nomac  NoMac  ')))
    assert(
      listed.lines.some((line) =>
        line.startsWith('ops  digitalocean  Ops  unavailable'),
      ),
    )
    const fresh = io(MAC_KEY)
    await nodeMain(
      [
        'cloud',
        'accounts',
        'add',
        '--data',
        data,
        '--provider',
        'nomac',
        '--name',
        'Fresh',
        '--key-stdin',
      ],
      fresh,
    )
    const unchecked = io()
    await nodeMain(['cloud', 'accounts', 'list', '--data', data], unchecked)
    assert(unchecked.lines.includes('fresh  nomac  Fresh  not checked'))
    const json = io()
    assert.equal(
      await nodeMain(
        ['cloud', 'accounts', 'list', '--data', data, '--json'],
        json,
      ),
      0,
    )
    const parsed = JSON.parse(json.lines[0]!) as Json[]
    assert(parsed.every((entry) => entry.key.set === true))
    assert(!json.lines[0]!.includes(DO_KEY))
    for (const id of ['ops', 'mac2', 'fresh']) {
      const removed = io()
      assert.equal(
        await nodeMain(
          ['cloud', 'accounts', 'remove', id, '--data', data],
          removed,
        ),
        0,
      )
      assert.deepEqual(removed.lines, [`Removed cloud account ${id}`])
    }
    await fails(
      ['cloud', 'accounts', 'remove', 'ops'],
      /No cloud account named ops/,
    )
    await fails(['cloud', 'pools'], /Usage/)
    await fails(['cloud', 'accounts', 'rename'], /Usage/)
  })
})
