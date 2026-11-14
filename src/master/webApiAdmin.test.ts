import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'mocha'
import { branchKey } from '../catalog/platform.js'
import { DEVICE_COOKIE } from '../devices/store.js'
import type { RunningNode } from '../node/serve.js'
import {
  asAppData,
  asAppItems,
  asAppleSigning,
  asAppsData,
  asBranchData,
  asCloudBudget,
  asCloudDomains,
  asCompleteData,
  asDevicesData,
  asGroupDetail,
  asInstallAnswer,
  asNodeViews,
  asPrepareAnswer,
  asRegistrationAnswer,
  asSecretsBackups,
} from '../shared/api/index.js'
import type { Role } from '../shared/permissions.js'
import {
  ALPHA,
  MASTER_ORIGIN,
  readFixture,
  shape,
  type ReadFixture,
  type Reply,
  type Who,
} from '../test/readFixture.js'
import { localOperator } from './roles.js'

const root = (): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'admin-'))

const roles: Role[] = ['tester', 'developer', 'manager', 'admin']

describe('Master web API: administration, Install apps and Devices', function () {
  this.timeout(300_000)
  let f: ReadFixture
  let master: RunningNode
  const as = (role: Role): Who => f.on('master', role)
  const get = async (route: string, who: Who): Promise<Reply> =>
    await f.request(master, 'GET', route, who)
  const post = async (
    route: string,
    who: Who,
    body: unknown = {},
  ): Promise<Reply> => await f.request(master, 'POST', route, who, body)
  const matrix = async (route: string, allowed: Role[]): Promise<void> => {
    for (const role of roles) {
      const reply = await get(route, as(role))
      assert.equal(
        reply.status,
        allowed.includes(role) ? 200 : 403,
        `${role} ${route}: ${reply.text}`,
      )
    }
    assert.equal((await get(route, {})).status, 401)
  }

  before(async () => {
    f = await readFixture(root())
    master = f.c.master
  })
  after(async () => {
    await f?.c.close()
  })

  it('GET /api/v2/nodes: each node busy, idle or offline, with its running stage', async () => {
    await matrix('/api/v2/nodes', ['manager', 'admin'])
    const nodes = asNodeViews((await get('/api/v2/nodes', as('manager'))).json)
    assert.deepEqual(nodes.map((node) => [node.role, node.status]).sort(), [
      ['host', 'idle'],
      ['worker', 'idle'],
    ])
    assert.equal(
      nodes.every((node) => node.stage === undefined),
      true,
    )
    // A worker holding a running stage names it.
    const worker = nodes.find((node) => node.role === 'worker')!
    const db = master.master!.database.db
    db.prepare(
      "UPDATE job_stages SET status='running',worker=? WHERE job_id=? AND name='compile'",
    ).run(worker.fingerprint, f.runs.built)
    try {
      const busy = (await get('/api/v2/nodes', as('admin'))).json.find(
        (node: { role: string }) => node.role === 'worker',
      )
      assert.equal(busy.stage, `${f.runs.built} compile`)
    } finally {
      db.prepare(
        "UPDATE job_stages SET status='succeeded' WHERE job_id=? AND name='compile'",
      ).run(f.runs.built)
    }
    assert.equal(
      (await get('/api/v2/nodes', { key: f.keys.manager })).status,
      200,
    )
  })

  it('GET /api/v2/cloud/budget and …/accounts/:id/domains; the accounts list says which an administrator keyed', async () => {
    await matrix('/api/v2/cloud/budget', ['manager', 'admin'])
    assert.deepEqual(
      shape(
        asCloudBudget,
        (await get('/api/v2/cloud/budget', as('manager'))).json,
      ),
      { monthly: 200 },
    )
    await master.master!.settings.set(localOperator, 'cloudAccounts', {
      accounts: [
        {
          id: 'mac',
          name: 'Macs',
          provider: 'nomac',
          key: 'nmk_' + 'a'.repeat(24),
        },
      ],
    })
    await matrix('/api/v2/cloud/accounts/mac/domains', ['manager', 'admin'])
    // NoMac has no DNS: no domains.
    assert.deepEqual(
      shape(
        asCloudDomains,
        (await get('/api/v2/cloud/accounts/mac/domains', as('admin'))).json,
      ),
      [],
    )
    assert.equal(
      (await get('/api/v2/cloud/accounts/none/domains', as('admin'))).status,
      404,
    )
    const accounts = (await get('/api/v2/cloud/accounts', as('manager'))).json
    assert.deepEqual(
      accounts.map((account: { id: string; adminKeyed: boolean }) => [
        account.id,
        account.adminKeyed,
      ]),
      [['mac', true]],
    )
  })

  it('GET /api/v2/apple/signing: the Apple ID, its teams, failures and teams being set up', async () => {
    await matrix('/api/v2/apple/signing', ['manager', 'admin'])
    assert.deepEqual(
      shape(
        asAppleSigning,
        (await get('/api/v2/apple/signing', as('manager'))).json,
      ),
      { signedIn: false, needsCode: false, failures: {}, settingUp: [] },
    )
  })

  it('GET /api/v2/settings/nodeTypes: each stored type in this release’s shape, an invalid one left out', async () => {
    master
      .master!.database.db.prepare(
        "INSERT INTO settings(area,value,updated_at,updated_by) VALUES('nodeTypes',?,0,'test') ON CONFLICT(area) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify({ legacy: {}, broken: { diskThresholdGb: -1 } }))
    const types = (await get('/api/v2/settings/nodeTypes', as('manager'))).json
    assert.deepEqual(Object.keys(types), ['legacy'])
    assert.equal(types.legacy.diskThresholdGb, 40)
  })

  it('GET /api/v2/groups/:id and GET /api/v2/apps: a group, and every app for its picker', async () => {
    const group = master.master!.people.groups(localOperator)[0]!
    await matrix(`/api/v2/groups/${group.id}`, ['manager', 'admin'])
    const read = shape(
      asGroupDetail,
      (await get(`/api/v2/groups/${group.id}`, as('manager'))).json,
    )
    assert.deepEqual(
      [read.name, read.members, read.apps.map((app) => app.slug)],
      ['Alpha testers', [f.people.tester], [ALPHA]],
    )
    assert.equal((await get('/api/v2/groups/424242', as('admin'))).status, 404)
    await matrix('/api/v2/apps', ['developer', 'manager', 'admin'])
    const apps = shape(
      asAppItems,
      (await get('/api/v2/apps', as('admin'))).json,
    )
    assert.deepEqual(
      apps.map((app) => [app.name, app.enabled]),
      [
        ['Alpha', true],
        ['Beta', true],
      ],
    )
  })

  it('GET /api/v2/projects/:slug/secrets/backups: whether secrets can be kept', async () => {
    await matrix('/api/v2/projects/reads/secrets/backups', [
      'developer',
      'manager',
      'admin',
    ])
    assert.deepEqual(
      shape(
        asSecretsBackups,
        (await get('/api/v2/projects/reads/secrets/backups', as('developer')))
          .json,
      ),
      { backupsConfigured: false },
    )
    // The list itself is unchanged.
    assert.deepEqual(
      (await get('/api/v2/projects/reads/secrets', as('developer'))).json,
      [],
    )
  })

  it('Install apps over the link: apps, an app, a branch, and Install as JSON', async () => {
    const tester = as('tester')
    const apps = shape(
      asAppsData,
      (await get('/api/v2/catalog/apps', tester)).json,
    )
    assert.deepEqual(
      apps.apps.map((app) => app.slug),
      [ALPHA],
    )
    const id = apps.apps[0]!.id
    const app = shape(
      asAppData,
      (await get(`/api/v2/catalog/apps/${id}?platform=android`, tester)).json,
    )
    assert.deepEqual(
      app.branches.map((branch) => branch.name),
      ['master'],
    )
    const branch = shape(
      asBranchData,
      (
        await get(
          `/api/v2/catalog/apps/${id}/branches/${branchKey('master')}?platform=android`,
          tester,
        )
      ).json,
    )
    assert.deepEqual(
      branch.builds.map((build) => [build.id, build.buildNumber]),
      [[f.build, '7']],
    )
    // Without the request proof, nothing installs.
    const unproven = await f.request(
      master,
      'POST',
      `/api/v2/catalog/builds/${f.build}/install`,
      { cookie: (tester as { cookie: string }).cookie, csrf: 'not-it' },
      {},
    )
    assert.equal(unproven.status, 403)
    const install = shape(
      asInstallAnswer,
      (await post(`/api/v2/catalog/builds/${f.build}/install`, tester)).json,
    )
    assert.equal(install.kind, 'download')
    assert.match(install.url!, /^\/install\/[A-Za-z0-9_-]{43}\/artifact$/)
    assert.equal(typeof install.expiresAt, 'number')
    const file = await get(install.url!, {})
    assert.equal(file.status, 200)
    assert.match(file.text, /^alpha android package/)
    // An app or build the tester may not see is unknown to her.
    assert.equal((await get('/api/v2/catalog/apps/424242', tester)).status, 404)
    assert.equal((await get('/api/v2/catalog/apps/nope', tester)).status, 404)
    assert.equal(
      (await post('/api/v2/catalog/builds/424242/install', tester)).status,
      404,
    )
    assert.equal((await get('/api/v2/catalog/apps', {})).status, 401)
    assert.equal(
      (await get('/api/v2/catalog/apps', { key: f.keys.manager })).status,
      401,
    )
  })

  it('Devices over the link: the list, a registration profile to download once, actions and completion', async () => {
    const tester = as('tester') as { cookie: string; csrf: string }
    const list = shape(
      asDevicesData,
      (await get('/api/v2/devices', tester)).json,
    )
    assert.deepEqual([list.devices, list.registration], [[], true])
    const made = shape(
      asRegistrationAnswer,
      (await post('/api/v2/devices/registrations', tester)).json,
    )
    assert.match(made.url, /^\/devices\/profiles\/[A-Za-z0-9_-]{43}$/)
    const profile = await get(made.url, {})
    assert.equal(profile.status, 200)
    assert.equal(
      profile.headers.get('content-type'),
      'application/x-apple-aspen-config; charset=utf-8',
    )
    assert.match(profile.text, /PayloadType/)
    assert.equal((await get(made.url, {})).status, 404)
    // A device of the tester's, registered on the master.
    const db = master.master!.database.db
    const now = Date.now()
    const device = Number(
      db
        .prepare(
          "INSERT INTO devices(udid,product,model,os_version,status,created_at,updated_at) VALUES(?,'iPhone14,5','iPhone 13','26.0','registered',?,?)",
        )
        .run('C'.repeat(40), now, now).lastInsertRowid,
    )
    db.prepare(
      'INSERT INTO account_devices(account_id,device_id,name,created_at) VALUES(?,?,?,?)',
    ).run(f.people.tester, device, 'Tess’s iPhone', now)
    master.master!.database.change('device', device)
    master.master!.database.change('account', f.people.tester)
    await f.c.until(
      () =>
        f.host
          .host!.cache.db.prepare(
            'SELECT 1 FROM account_devices WHERE device_id=?',
          )
          .get(device) != null,
      10_000,
      'the device on the host',
    )
    const selected = await post(`/api/v2/devices/${device}/select`, tester)
    assert.equal(selected.status, 200, selected.text)
    assert.equal(selected.json.selected, device)
    assert.match(
      selected.headers.getSetCookie().join(';'),
      new RegExp(`${DEVICE_COOKIE}=${device}`),
    )
    const chosen = {
      cookie: `${tester.cookie}; ${DEVICE_COOKIE}=${device}`,
      csrf: tester.csrf,
    }
    assert.equal((await get('/api/v2/devices', chosen)).json.selected, device)
    // Prepare for this device needs one selected.
    assert.deepEqual(
      shape(
        asPrepareAnswer,
        (await post(`/api/v2/catalog/builds/${f.build}/prepare`, tester)).json,
      ),
      { prepared: false },
    )
    const prepared = await post(
      `/api/v2/catalog/builds/${f.build}/prepare`,
      chosen,
    )
    // An Android build is not prepared for an iPhone.
    assert.deepEqual(
      [prepared.status, prepared.json],
      [400, { error: 'Device or build unavailable' }],
    )
    // Install an iOS build: register first without a device; with one, the
    // installer at the master's origin, or prepare a build not made for it.
    const provisioned = await f.publish('ios', '20', ['C'.repeat(40)])
    const unprovisioned = await f.publish('ios', '21')
    assert.deepEqual(
      (await post(`/api/v2/catalog/builds/${provisioned}/install`, tester))
        .json,
      { kind: 'register' },
    )
    const itms = shape(
      asInstallAnswer,
      (await post(`/api/v2/catalog/builds/${provisioned}/install`, chosen))
        .json,
    )
    assert.equal(itms.kind, 'itms')
    assert.equal(
      itms.url!.startsWith(
        'itms-services://?action=download-manifest&url=' +
          encodeURIComponent(`${MASTER_ORIGIN}/install/`),
      ),
      true,
    )
    assert.deepEqual(
      (await post(`/api/v2/catalog/builds/${unprovisioned}/install`, chosen))
        .json,
      { kind: 'prepare', buildId: unprovisioned },
    )
    const renamed = await post(`/api/v2/devices/${device}/rename`, chosen, {
      name: 'Work phone',
    })
    assert.equal(renamed.status, 200, renamed.text)
    assert.equal(
      (await post(`/api/v2/devices/${device}/explode`, chosen)).status,
      404,
    )
    assert.equal(
      (await post('/api/v2/devices/424242/select', chosen)).status,
      404,
    )
    const removed = await post(`/api/v2/devices/${device}/remove`, chosen)
    assert.equal(removed.status, 200, removed.text)
    assert.equal(removed.json.selected, undefined)
    assert.match(
      removed.headers.getSetCookie().join(';'),
      new RegExp(`${DEVICE_COOKIE}=;`),
    )
    assert.deepEqual(
      shape(
        asCompleteData,
        (await get('/api/v2/devices/complete/nope', tester)).json,
      ),
      { state: 'unavailable' },
    )
  })

  it('Install apps and Devices answer 503 while the host is away', async () => {
    const tester = as('tester')
    await f.c.drop('host', 500, async () => {
      for (const route of ['/api/v2/catalog/apps', '/api/v2/devices']) {
        const reply = await get(route, tester)
        assert.equal(reply.status, 503, reply.text)
        assert.match(reply.json.error, /cannot reach the Mason host/)
      }
    })
  })
})
