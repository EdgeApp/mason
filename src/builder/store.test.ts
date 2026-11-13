import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'mocha'
import {
  asBuilderConfig,
  asBuildSettings,
  asDefinition,
  asRequest,
  baseEnvironment,
  branchName,
  commitHash,
  envName,
  relativePath,
  repository,
} from './config.js'
import { BuilderStore, exclusiveLock, hash, publicJob } from './store.js'

let root: string, store: BuilderStore
const definition = {
  slug: 'app.example.fixture',
  name: 'Fixture',
  repository: 'https://github.com/example/fixture.git',
  platforms: ['ios'],
}
const request = { app: definition.slug, branch: 'master' }
const deployConfig = Buffer.from('{"upload":"secret-token"}').toString('base64')
const eddy = {
  name: 'Eddy',
  repository: 'git@github.com:example/eddy.git',
  platforms: ['macos'],
  env: [
    { name: 'BUILD_NUMBER_FILE', value: '/state/buildNum.json', secret: false },
    { name: 'UPLOAD_TOKEN', value: 'secret-token' },
  ],
  files: [
    {
      destination: 'deployConfig.json',
      contents: deployConfig,
      env: 'DEPLOY_CONFIG_FILE',
    },
  ],
}
function reopen(): void {
  const config = store.config
  store.close()
  store = new BuilderStore(config)
}
describe('Mason builder store', function () {
  this.timeout(20000)
  beforeEach(() => {
    process.umask(0o077)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'store-'))
    store = new BuilderStore(
      asBuilderConfig({ workspace: path.join(root, 'state') }),
    )
    store.importApp(definition)
  })
  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('validates repository, branch, environment and file configuration', () => {
    assert.equal(
      repository('git@github.com:EXAMPLE/Fixture.git'),
      'git@github.com:example/fixture.git',
    )
    assert.equal(
      repository('https://github.com/Example/Fixture'),
      'https://github.com/example/fixture.git',
    )
    for (const value of [
      'file:///tmp/repo',
      'https://user:pass@github.com/a/b',
      'https://example.test/a/b',
      'https://github.com/../b',
    ])
      assert.throws(() => repository(value))
    for (const value of [
      '../x',
      '/x',
      'x//y',
      'x.lock',
      'x..y',
      '-x',
      'x/',
      'x.',
      'x/.y',
    ])
      assert.throws(() => branchName(value))
    assert.equal(branchName('feature/example'), 'feature/example')
    for (const value of ['../x', '/x', '.git/config', 'x//y'])
      assert.throws(() => relativePath(value))
    assert.equal(relativePath('tools/Masonfile.ts'), 'tools/Masonfile.ts')
    for (const value of ['MASON_BRANCH', 'NODE_OPTIONS', 'a b'])
      assert.throws(() => envName(value))
    assert.equal(envName('APP_SERVER_URL'), 'APP_SERVER_URL')
    assert.throws(() =>
      asDefinition({
        ...definition,
        env: [{ name: 'VALUE', value: '\0' }],
      }),
    )
    assert.throws(() => asDefinition({ ...definition, platforms: [] }))
    assert.throws(() =>
      asDefinition({
        ...definition,
        env: [
          { name: 'VALUE', value: 'x' },
          { name: 'VALUE', value: 'y' },
        ],
      }),
    )
    assert.throws(() =>
      asDefinition({
        ...definition,
        files: [{ destination: 'Masonfile.ts', contents: '' }],
      }),
    )
    assert.throws(() =>
      asDefinition({
        ...definition,
        entrypoint: 'tools/build.ts',
        files: [{ destination: 'tools/build.ts', contents: '' }],
      }),
    )
    assert.throws(() =>
      asDefinition({
        ...definition,
        files: [{ destination: 'config', contents: '!' }],
      }),
    )
    for (const workspace of ['git', 'files/x', 'logs', 'executions'])
      assert.throws(
        () => asDefinition({ ...definition, workspace }),
        /Reserved workspace directory/,
      )
    assert.throws(
      () =>
        asDefinition({
          ...definition,
          files: Array.from({ length: 2 }, () => ({
            destination: 'same',
            contents: '',
          })),
        }),
      /Duplicate configuration/,
    )
    assert.throws(
      () =>
        asDefinition({
          ...definition,
          env: [{ name: 'CONFIG_FILE', value: 'x' }],
          files: [{ destination: 'config', contents: '', env: 'CONFIG_FILE' }],
        }),
      /Duplicate configuration/,
    )
    assert.throws(
      () => asDefinition({ ...definition, platforms: ['ios', 'ios'] }),
      /Invalid configuration size/,
    )
    assert.throws(
      () =>
        asDefinition({
          ...definition,
          env: Array.from({ length: 30 }, (_, i) => ({
            name: 'VALUE_' + i,
            value: 'x'.repeat(60000),
          })),
        }),
      /App definition too large/,
    )
    assert.deepEqual(asDefinition(definition), {
      ...definition,
      position: 0,
      enabled: true,
      workspace: 'git-worktrees',
      entrypoint: undefined,
      timeoutSeconds: 14400,
      env: [],
      files: [],
    })
    assert.throws(() => asRequest({ ...request, repository: 'no' }))
    assert.equal(commitHash('a'.repeat(64)), 'a'.repeat(64))
    for (const value of ['A'.repeat(40), 'a'.repeat(39), 7])
      assert.throws(() => commitHash(value), /Invalid commit|Expected/)
    assert.deepEqual(
      asBuildSettings({ defaultBranch: 'main', automaticBranches: ['main'] }),
      { defaultBranch: 'main', automaticBranches: ['main'] },
    )
    for (const settings of [
      { defaultBranch: 'main', automaticBranches: ['main', 'main'] },
      { defaultBranch: 'main', automaticBranches: ['../bad'] },
      { defaultBranch: 'main', automaticBranches: [], unknown: true },
      {
        defaultBranch: 'main',
        automaticBranches: Array.from({ length: 21 }, (_, i) => `f/${i}`),
      },
    ])
      assert.throws(() => asBuildSettings(settings))
    assert.deepEqual(asBuilderConfig({ workspace: 'state' }), {
      workspace: 'state',
      listenHost: '127.0.0.1',
      port: 9300,
    })
    assert.equal(baseEnvironment().NODE_OPTIONS, undefined)
    // A service has no locale: commands still get UTF-8; a set one is kept.
    const lang = process.env.LANG
    try {
      delete process.env.LANG
      assert.equal(baseEnvironment('darwin').LANG, 'en_US.UTF-8')
      assert.equal(baseEnvironment('linux').LANG, 'C.UTF-8')
      process.env.LANG = 'de_DE.UTF-8'
      assert.equal(baseEnvironment('darwin').LANG, 'de_DE.UTF-8')
    } finally {
      if (lang == null) delete process.env.LANG
      else process.env.LANG = lang
    }
  })
  it('validates and persists canonical per-job environment overrides', () => {
    for (const envVars of [
      null,
      {},
      ['x'],
      [{}],
      [[]],
      [null],
      JSON.parse(
        '[{"APP_SERVER_URL":"preview.example.test","__proto__":{"x":true}}]',
      ),
      JSON.parse('[{"__proto__":"invalid"}]'),
      [{ A: 'a', B: 'b' }],
      [{ A: 1 }],
      [{ A: 'a' }, { A: 'b' }],
      [{ MASON_APP: 'other' }],
      [{ NODE_OPTIONS: '--inspect' }],
      [{ 'a b': 'x' }],
      [{ A: '\0' }],
      [{ A: 'x'.repeat(4097) }],
      [{ A: '界'.repeat(3000) }],
      Array.from({ length: 101 }, (_, i) => ({ ['V' + i]: '' })),
    ])
      assert.throws(() => asRequest({ ...request, envVars }))
    const envVars = [{ Z: 'last' }, { A: '' }]
    const first = store.enqueue(
      { ...request, envVars, idempotencyKey: 'env' },
      'test',
    )
    assert.deepEqual(first.request.envVars, [{ A: '' }, { Z: 'last' }])
    assert.equal(
      store.enqueue(
        {
          ...request,
          envVars: [...envVars].reverse(),
          idempotencyKey: 'env',
        },
        'test',
      ).id,
      first.id,
    )
    assert.throws(() =>
      store.enqueue(
        { ...request, envVars: [{ A: 'changed' }], idempotencyKey: 'env' },
        'test',
      ),
    )
    reopen()
    assert.deepEqual(store.job(first.id)!.request.envVars, [
      { A: '' },
      { Z: 'last' },
    ])
    const legacy = store.enqueue(
      { ...request, idempotencyKey: 'legacy' },
      'test',
    )
    store.db
      .prepare('UPDATE jobs SET request=? WHERE id=?')
      .run(JSON.stringify({ ...request, idempotencyKey: 'legacy' }), legacy.id)
    assert.equal(
      store.enqueue(
        { ...request, envVars: [], idempotencyKey: 'legacy' },
        'test',
      ).id,
      legacy.id,
    )
    assert.deepEqual(store.job(legacy.id)!.request.envVars, [])
    store.importApp({
      ...definition,
      files: [
        { destination: 'private.json', contents: '', env: 'CONFIG_FILE' },
      ],
    })
    assert.throws(() =>
      store.enqueue(
        { ...request, envVars: [{ CONFIG_FILE: '/other' }] },
        'test',
      ),
    )
  })
  it('snapshots app configuration, scopes keys and preserves queued jobs', () => {
    const keyFile = path.join(root, 'key'),
      keyId = store.key(keyFile),
      key = readFileSync(keyFile, 'utf8').trim()
    assert.equal(statSync(keyFile).mode & 0o777, 0o600)
    assert.equal(store.authenticate(key), keyId)
    assert.equal(store.authenticate('bad'), undefined)
    assert.equal(store.authenticate('f'.repeat(64)), undefined)
    assert.throws(() => store.key(keyFile))
    const first = store.enqueue(
      { ...request, idempotencyKey: 'request' },
      keyId,
    )
    store.importApp({ ...definition, name: 'Changed' })
    assert.equal(store.job(first.id)!.definition.name, 'Fixture')
    assert.equal(
      store.enqueue({ ...request, idempotencyKey: 'request' }, keyId).id,
      first.id,
    )
    // The same idempotency key from another API key is a different request.
    assert.notEqual(
      store.enqueue({ ...request, idempotencyKey: 'request' }, 'other').id,
      first.id,
    )
    assert.throws(() =>
      store.enqueue(
        { ...request, branch: 'other', idempotencyKey: 'request' },
        keyId,
      ),
    )
    assert.throws(() =>
      store.enqueue({ ...request, platforms: ['android'] }, keyId),
    )
    assert.throws(() => store.enqueue({ ...request, platforms: [] }, keyId))
    assert.throws(() =>
      store.enqueue({ ...request, platforms: ['ios', 'ios'] }, keyId),
    )
    assert.throws(() => store.enqueue({ ...request, app: 'unknown' }, keyId))
    store.importApp({ ...definition, slug: 'app.example.off', enabled: false })
    assert.throws(
      () => store.enqueue({ ...request, app: 'app.example.off' }, keyId),
      /Unknown or disabled app/,
    )
    assert.equal(
      store.enqueue({ ...request, platforms: ['ios'] }, keyId).request
        .platforms![0],
      'ios',
    )
    assert.equal('definition' in publicJob(first), false)
    assert.equal('request' in publicJob(first), false)
    assert.equal(publicJob(first).id, first.id)
    store.revoke(keyId)
    assert.equal(store.authenticate(key), undefined)
    const reopened = new BuilderStore(store.config)
    assert.equal(reopened.pending().length, 3)
    reopened.close()
    assert.equal(store.cancel(first.id), true)
    assert.equal(store.job(first.id)!.status, 'cancelled')
    assert.equal(typeof store.job(first.id)!.finished, 'number')
    assert.equal(store.job(first.id)!.cancel, 1)
    assert.equal(store.cancel(first.id), false)
    assert.equal(store.job('00000000-0000-4000-8000-000000000001'), undefined)
    const lock = exclusiveLock(path.join(root, 'lock.sqlite'))
    assert.throws(() => exclusiveLock(path.join(root, 'lock.sqlite')))
    lock.close()
    exclusiveLock(path.join(root, 'lock.sqlite')).close()
    assert.equal(hash('x'), hash('x'))
    assert.match(hash('x'), /^[a-f0-9]{64}$/)
  })
  it('separates admin keys and adds the role to older key tables', () => {
    const admin = store.key(path.join(root, 'admin-key'), true)
    const build = store.key(path.join(root, 'build-key'))
    assert.equal(store.isAdmin(admin), true)
    assert.equal(store.isAdmin(build), false)
    assert.equal(store.isAdmin('unknown'), false)
    store.close()
    const legacy = new DatabaseSync(path.join(root, 'state', 'builder.sqlite'))
    legacy.exec(`DROP TABLE builder_keys;
      CREATE TABLE builder_keys(id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE) STRICT;
      INSERT INTO builder_keys VALUES('old','digest');`)
    legacy.close()
    store = new BuilderStore(
      asBuilderConfig({ workspace: path.join(root, 'state') }),
    )
    assert.equal(store.isAdmin('old'), false)
  })
  it('keeps stored secrets by reference when a definition changes', () => {
    const created = store.saveApp('app.edge.eddy', eddy)
    assert.equal(created.created, true)
    assert.equal(created.app.slug, 'app.edge.eddy')
    assert.equal(store.buildSettings('app.edge.eddy').defaultBranch, 'master')
    const changed = store.saveApp('app.edge.eddy', {
      ...eddy,
      slug: 'app.edge.eddy',
      name: 'Eddy (Edge)',
      env: [
        {
          name: 'BUILD_NUMBER_FILE',
          value: '/other/buildNum.json',
          secret: false,
        },
        { name: 'UPLOAD_TOKEN', keep: true },
        { name: 'EXTRA', value: 'x' },
      ],
      files: [{ destination: 'deployConfig.json', keep: true }],
    })
    assert.equal(changed.created, false)
    const stored = store.apps().find((app) => app.slug === 'app.edge.eddy')!
    assert.equal(stored.name, 'Eddy (Edge)')
    assert.deepEqual(stored.env, [
      {
        name: 'BUILD_NUMBER_FILE',
        value: '/other/buildNum.json',
        secret: false,
      },
      { name: 'UPLOAD_TOKEN', value: 'secret-token', secret: true },
      { name: 'EXTRA', value: 'x', secret: true },
    ])
    assert.deepEqual(stored.files, eddy.files)
    // Keeping a file may rebind its environment variable.
    store.saveApp('app.edge.eddy', {
      ...eddy,
      files: [
        { destination: 'deployConfig.json', keep: true, env: 'OTHER_CONFIG' },
      ],
    })
    const rebound = store.apps().find((app) => app.slug === 'app.edge.eddy')!
    assert.equal(rebound.files[0]!.env, 'OTHER_CONFIG')
    assert.equal(rebound.files[0]!.contents, deployConfig)
    for (const body of [
      { ...eddy, slug: 'app.edge.other' },
      { ...eddy, env: [{ name: 'MISSING', keep: true }] },
      { ...eddy, env: [{ name: 'UPLOAD_TOKEN', keep: false }] },
      { ...eddy, files: [{ destination: 'missing.json', keep: true }] },
      { ...eddy, platforms: [] },
      { ...eddy, unknown: true },
      [eddy],
      null,
      'text',
    ])
      assert.throws(() => store.saveApp('app.edge.eddy', body))
    assert.deepEqual(
      store.apps().find((app) => app.slug === 'app.edge.eddy'),
      rebound,
    )
    // A new app has no stored values to keep.
    assert.throws(
      () =>
        store.saveApp('app.edge.other', {
          ...eddy,
          env: [{ name: 'UPLOAD_TOKEN', keep: true }],
        }),
      /No stored value to keep/,
    )
    assert.equal(store.apps().length, 2)
  })
  it('claims one job at a time and holds the queue while a job is quarantined', () => {
    assert.equal(store.claim(), undefined)
    const first = store.enqueue({ ...request, branch: 'first' }, 'test')
    const second = store.enqueue({ ...request, branch: 'second' }, 'test')
    // Jobs made in the same millisecond would otherwise order by random ID.
    store.db
      .prepare('UPDATE jobs SET created=created+1 WHERE id=?')
      .run(second.id)
    const running = store.claim()!
    assert.equal(running.id, first.id)
    assert.equal(running.status, 'running')
    assert.equal(running.quarantine, 1)
    assert.equal(typeof running.started, 'number')
    assert.equal(store.claim(), undefined)
    store.finish(first.id, 'failed', 3, undefined, true, {
      cleanupError: 'Synthetic cleanup failure',
      quarantineReason: 'Synthetic process ownership uncertainty',
    })
    const held = store.job(first.id)!
    assert.equal(held.cleanup_error, 'Synthetic cleanup failure')
    assert.equal(
      held.quarantine_reason,
      'Synthetic process ownership uncertainty',
    )
    assert.equal(store.claim(), undefined)
    store.releaseQuarantine(first.id)
    assert.equal(store.claim()!.id, second.id)
    // A reason is kept only while the job holds the worker.
    store.finish(second.id, 'succeeded', 0, undefined, false, {
      quarantineReason: 'Ignored',
    })
    assert.equal(store.job(second.id)!.quarantine_reason, undefined)
    assert.equal(store.job(second.id)!.cleanup_error, undefined)
    // A running job is marked for cancellation and keeps running.
    const third = store.enqueue({ ...request, branch: 'third' }, 'test')
    store.claim()
    assert.equal(store.cancel(third.id), true)
    assert.equal(store.job(third.id)!.status, 'running')
    assert.equal(store.job(third.id)!.cancel, 1)
    assert.throws(() => store.finish(third.id, 'unknown' as 'failed'))
    assert.throws(
      () => store.finish(third.id, 'failed', 1, { text: 'x'.repeat(70000) }),
      /Result too large/,
    )
    assert.equal(store.job(third.id)!.status, 'running')
    store.finish(third.id, 'cancelled')
    assert.equal(store.job(third.id)!.status, 'cancelled')
    assert.equal(store.job(third.id)!.result, undefined)
  })
  it('records the checked-out commit and refuses one that differs from a pinned request', () => {
    const job = store.enqueue(request, 'test')
    store.commit(job.id, 'c'.repeat(40))
    assert.equal(store.job(job.id)!.commit_sha, 'c'.repeat(40))
    assert.throws(() => store.commit(job.id, 'not-a-commit'))
    const pinned = store.enqueuePinned(
      { ...request, branch: 'provisioning' },
      'test',
      'b'.repeat(40),
    )
    assert.equal(pinned.requested_commit, 'b'.repeat(40))
    assert.equal(pinned.automatic, 0)
    assert.throws(() => store.commit(pinned.id, 'c'.repeat(40)))
    store.commit(pinned.id, 'b'.repeat(40))
    assert.throws(() => store.enqueuePinned(request, 'test', 'not-a-commit'))
  })
  it('preserves terminal results and exit codes when releasing a quarantined job', () => {
    for (const status of ['succeeded', 'failed'] as const) {
      const job = store.enqueue(request, 'test')
      store.claim()
      store.finish(
        job.id,
        status,
        status === 'succeeded' ? 0 : 7,
        { status },
        true,
        {
          quarantineReason: 'Synthetic process ownership uncertainty',
        },
      )
      const before = store.job(job.id)!
      assert.equal(before.quarantine, 1)
      store.releaseQuarantine(job.id)
      const after = store.job(job.id)!
      assert.equal(after.status, before.status)
      assert.equal(after.exit_code, before.exit_code)
      assert.equal(after.finished, before.finished)
      assert.deepEqual(after.result, before.result)
      assert.equal(after.quarantine, 0)
      assert.equal(after.quarantine_reason, undefined)
    }
  })
  it('records the caller and the trigger of queued jobs', () => {
    store.configureBuilds(definition.slug, {
      defaultBranch: 'master',
      automaticBranches: ['release'],
    })
    const posted = store.enqueue(
      { ...request, idempotencyKey: 'queue-api' },
      'test',
      '127.0.0.1',
    )
    assert.equal(posted.client_ip, '127.0.0.1')
    const running = store.claim()
    assert.equal(running?.id, posted.id)
    const direct = store.enqueue(
      { ...request, branch: 'feature' },
      'test',
      '192.0.2.15',
    )
    const ipv6 = store.enqueue(
      { ...request, branch: 'ipv6' },
      'test',
      '2001:db8::1',
    )
    assert.equal(ipv6.client_ip, '2001:db8::1')
    const ignored = store.enqueue(
      { ...request, branch: 'ignored' },
      'test',
      'not-an-address',
    )
    assert.equal(ignored.client_ip, undefined)
    const repeated = store.enqueue(
      { ...request, branch: 'feature', idempotencyKey: 'same' },
      'test',
      '192.0.2.15',
    )
    // A replayed request keeps the address of its first submission.
    assert.equal(
      store.enqueue(
        { ...request, branch: 'feature', idempotencyKey: 'same' },
        'test',
        '198.51.100.9',
      ).client_ip,
      '192.0.2.15',
    )
    const polled = store.enqueueAutomatic(
      definition.slug,
      'release',
      'a'.repeat(40),
    )
    assert(polled)
    assert.equal(polled.client_ip, undefined)
    assert.equal(polled.automatic, 1)
    assert.equal(polled.requested_commit, 'a'.repeat(40))
    assert.equal(polled.commit_sha, undefined)
    const done = store.enqueue({ ...request, branch: 'done' }, 'test')
    store.finish(done.id, 'succeeded', 0, { ok: true })
    const held = store.enqueue({ ...request, branch: 'held' }, 'test')
    store.finish(held.id, 'failed', 1, { ok: false }, true, {
      quarantineReason: 'Synthetic hold',
    })
    const pending = store.pending()
    assert.deepEqual(
      pending.map((job) => job.id).sort(),
      [
        posted.id,
        direct.id,
        ipv6.id,
        ignored.id,
        repeated.id,
        polled.id,
        held.id,
      ].sort(),
    )
    for (let i = 1; i < pending.length; i++) {
      const previous = pending[i - 1]!
      const current = pending[i]!
      assert(
        previous.created < current.created ||
          (previous.created === current.created && previous.id < current.id),
      )
    }
    assert.equal(
      pending.find((job) => job.id === held.id)!.quarantine_reason,
      'Synthetic hold',
    )
    // Storage from before caller addresses keeps every queued job.
    const beforeUpgrade = store.pending().map((job) => ({
      ...job,
      client_ip: undefined,
    }))
    store.db.exec('ALTER TABLE jobs DROP COLUMN client_ip')
    reopen()
    assert.deepEqual(store.pending(), beforeUpgrade)
    assert.equal(store.job(posted.id)!.status, 'running')
    assert.equal(
      store.enqueue(
        { ...request, branch: 'after-upgrade' },
        'test',
        '192.0.2.20',
      ).client_ip,
      '192.0.2.20',
    )
  })
  it('refuses new jobs once the queue is full', () => {
    for (let i = 0; i < 100; i++)
      store.enqueue({ ...request, branch: 'b' + i }, 'test')
    assert.throws(() => store.enqueue(request, 'test'), /Queue is full/)
  })
  it('lists the five most recently finished builds', () => {
    const history = Array.from({ length: 7 }, (_, i) => {
      const job = store.enqueue({ ...request, branch: 'finished-' + i }, 'test')
      store.finish(job.id, i % 2 === 0 ? 'succeeded' : 'failed', i % 2)
      store.db
        .prepare('UPDATE jobs SET created=?,started=?,finished=? WHERE id=?')
        .run(10000 - i * 1000, 20000, 30000 + i * 1000, job.id)
      return job
    })
    store.enqueue({ ...request, branch: 'queued' }, 'test')
    assert.deepEqual(
      store.recent().map((job) => job.id),
      history
        .slice(2)
        .reverse()
        .map((job) => job.id),
    )
  })
  it('prunes only finished jobs older than two weeks that hold nothing', () => {
    const old = store.enqueue({ ...request, branch: 'old' }, 'test')
    store.finish(old.id, 'failed', 1)
    const held = store.enqueue({ ...request, branch: 'held' }, 'test')
    store.finish(held.id, 'failed', 1, undefined, true)
    const fresh = store.enqueue({ ...request, branch: 'fresh' }, 'test')
    store.finish(fresh.id, 'succeeded', 0)
    const queued = store.enqueue({ ...request, branch: 'queued' }, 'test')
    store.db
      .prepare('UPDATE jobs SET finished=?,created=? WHERE id IN (?,?,?)')
      .run(
        Date.now() - 15 * 86400000,
        Date.now() - 15 * 86400000,
        old.id,
        held.id,
        queued.id,
      )
    store.prune()
    assert.equal(store.job(old.id), undefined)
    assert(store.job(held.id))
    assert(store.job(fresh.id))
    assert(store.job(queued.id))
  })
  it('reserves workspace directories by identity', () => {
    const directory = path.join(store.config.workspace, 'checkout')
    assert.equal(store.own('checkout:shared', directory), false)
    mkdirSync(directory)
    assert.equal(store.own('checkout:shared', directory), true)
    assert.throws(
      () => store.own('checkout:shared', path.join(root, 'elsewhere')),
      /Workspace identity mismatch/,
    )
    const foreign = path.join(root, 'foreign')
    mkdirSync(foreign)
    assert.throws(
      () => store.own('checkout:other', foreign),
      /Foreign workspace path/,
    )
  })
  it('rolls back a failed transaction', () => {
    assert.throws(() =>
      store.transaction(() => {
        store.importApp({ ...definition, slug: 'app.example.rolled' })
        throw new Error('synthetic failure')
      }),
    )
    assert.deepEqual(
      store.apps().map((app) => app.slug),
      [definition.slug],
    )
    assert.equal(
      store.transaction(() => 'value'),
      'value',
    )
  })
  it('upgrades legacy job storage without losing completed build evidence', () => {
    const job = store.enqueue(request, 'test')
    store.finish(job.id, 'failed', 7, { compiler: 'synthetic failure' }, true)
    const before = store.job(job.id)!
    store.db.exec(
      'ALTER TABLE jobs DROP COLUMN cleanup_error; ALTER TABLE jobs DROP COLUMN quarantine_reason',
    )
    reopen()
    const after = store.job(job.id)!
    assert.equal(after.status, before.status)
    assert.equal(after.exit_code, before.exit_code)
    assert.deepEqual(after.result, before.result)
    store.finish(job.id, 'failed', 7, after.result, true, {
      quarantineReason: 'Synthetic process verification failure',
    })
    assert.equal(
      publicJob(store.job(job.id)!).quarantine_reason,
      'Synthetic process verification failure',
    )
  })
  it('adds automatic build storage to a builder from before branch polling', () => {
    const job = store.enqueue(request, 'test')
    store.finish(job.id, 'succeeded', 0)
    store.db.exec(`ALTER TABLE jobs DROP COLUMN requested_commit;
      ALTER TABLE jobs DROP COLUMN automatic;
      DROP TABLE builder_app_settings;
      DROP TABLE automatic_branches;
      DROP TABLE automatic_attempts;`)
    reopen()
    const after = store.job(job.id)!
    assert.equal(after.status, 'succeeded')
    assert.equal(after.automatic, 0)
    assert.equal(after.requested_commit, undefined)
    assert.deepEqual(store.buildSettings(definition.slug), {
      defaultBranch: 'master',
      automaticBranches: [],
      branches: [],
    })
    assert.throws(() => store.buildSettings('unknown'), /Unknown app/)
    assert.throws(() =>
      store.configureBuilds('unknown', {
        defaultBranch: 'master',
        automaticBranches: [],
      }),
    )
  })
  it('rejects symlinked state, an invalid workspace marker and an unknown schema', () => {
    const link = path.join(root, 'link')
    symlinkSync(store.config.workspace, link)
    assert.throws(() => new BuilderStore({ ...store.config, workspace: link }))
    const marked = path.join(root, 'marked')
    mkdirSync(marked, { mode: 0o700 })
    writeFileSync(path.join(marked, '.mason-builder'), '2\n', { mode: 0o600 })
    assert.throws(
      () => new BuilderStore({ ...store.config, workspace: marked }),
      /Invalid workspace marker/,
    )
    store.db.exec('UPDATE builder_meta SET version=2')
    store.close()
    assert.throws(
      () => (store = new BuilderStore(store.config)),
      /Unknown builder schema/,
    )
    const db = new DatabaseSync(path.join(root, 'state', 'builder.sqlite'))
    db.exec('UPDATE builder_meta SET version=1')
    db.close()
    store = new BuilderStore(store.config)
    assert.equal(
      statSync(path.join(root, 'state', 'builder.sqlite')).mode & 0o777,
      0o600,
    )
  })
})
