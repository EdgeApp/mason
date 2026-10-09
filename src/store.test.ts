import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { run } from './cli.js'
import {
  asConfig,
  loadConfig,
  noSymlinks,
  privateDirectory,
  readPrivateJson,
  type Config,
} from './config.js'
import { migrateBranchNumbers } from './branchNumbers.js'
import { Store, digest } from './store.js'
import {
  asFileKey,
  asFlag,
  asHttps,
  asOrigin,
  integer,
  object,
  text,
} from './validation.js'

const DAY = 86400000
let root: string
let store: Store
let config: Config
let now: number
let app: number
let channel: number
function stage(
  number = '1',
  content = 'fixture',
): { id: string; input: object } {
  const id = store.reserve('fixture-key', content.length)
  writeFileSync(store.incomingPath(id), content, { flag: 'wx', mode: 0o600 })
  return {
    id,
    input: {
      channelId: channel,
      branch: 'master',
      commit: 'abc123',
      version: '1.2.3',
      buildNumber: number,
      bundleId: 'test.example.app',
      format: 'apk',
      size: content.length,
      digest: digest(content),
    },
  }
}
function publish(
  number = '1',
  content = 'fixture',
): ReturnType<Store['publish']> {
  const transfer = stage(number, content)
  return store.publish(transfer.id, transfer.input)
}
describe('Mason durable store', () => {
  beforeEach(() => {
    const parent = process.env.MASON_TEST_ROOT
    assert(parent, 'Set MASON_TEST_ROOT to an owned test directory')
    mkdirSync(parent, { recursive: true })
    root = mkdtempSync(path.join(parent, 'mason-'))
    now = Date.now()
    config = asConfig({
      origin: 'https://builds.example.test',
      database: path.join(root, 'state.sqlite'),
      storage: path.join(root, 'packages'),
      freeSpaceBytes: 0,
      capacityBytes: 1024,
      packageBytes: 100,
    })
    store = new Store(config, () => now)
    app = store.addApp({
      slug: 'test.example.app',
      name: 'Example',
      position: 0,
    })
    channel = store.addChannel({
      appId: app,
      platform: 'android',
      key: 'fixture-channel',
      allowedFormats: ['apk'],
    })
  })
  afterEach(() => {
    try {
      store.close()
    } catch {
      /* A restart test may already close it. */
    }
    rmSync(root, { recursive: true, force: true })
  })
  it('preserves grants in a populated migration and scopes build numbers by branch', () => {
    const first = publish('77')
    store.db
      .exec(`INSERT INTO accounts(id,name,created_at) VALUES(1,'Fixture',0);
      INSERT INTO sessions VALUES('session',1,0,'csrf',0,9999999999999);
      INSERT INTO install_grants VALUES('grant',${first.id},'session',0,9999999999999);`)
    migrateBranchNumbers(store.db)
    assert.equal(
      store.db.prepare('SELECT build_id FROM install_grants').get()!
        .build_id,
      first.id,
    )
    assert.deepEqual(
      store.db.prepare('PRAGMA foreign_key_check').all(),
      [],
    )
    const next = stage('77', 'different')
    const other = store.publish(next.id, {
      ...next.input,
      branch: 'feature/example',
    })
    assert.equal(other.build_number, first.build_number)
    assert.notEqual(other.branch, first.branch)
    const conflict = stage('77', 'conflict')
    assert.throws(
      () => store.publish(conflict.id, conflict.input),
      /conflict/,
    )
    store.cancel(conflict.id)
  })
  it('rejects unsafe existing state directories and replaceable ancestors', () => {
    const published = publish()
    for (const directory of [
      root,
      config.storage,
      store.files,
      store.incoming,
    ]) {
      for (const mode of [0o755, 0o770, 0o777]) {
        chmodSync(directory, mode)
        try {
          assert.throws(() => new Store(config), /State directories/)
          assert.equal(statSync(directory).mode & 0o777, mode)
        } finally {
          chmodSync(directory, 0o700)
        }
      }
    }
    const parent = path.join(root, 'shared')
    mkdirSync(parent, { mode: 0o700 })
    const nested = {
      ...config,
      storage: path.join(parent, 'private/packages'),
    }
    chmodSync(parent, 0o777)
    assert.throws(() => new Store(nested), /State directories/)
    assert(!existsSync(nested.storage))
    chmodSync(parent, 0o700)
    const reopened = new Store(config)
    reopened.close()
    chmodSync(store.files, 0o777)
    assert.throws(
      () => store.filePath(published.file_key),
      /State directories/,
    )
    chmodSync(store.files, 0o700)
    chmodSync(store.incoming, 0o777)
    assert.throws(
      () => store.incomingPath('a'.repeat(32)),
      /State directories/,
    )
    chmodSync(store.incoming, 0o700)
    const file = path.join(root, 'regular')
    writeFileSync(file, 'fixture')
    assert.throws(() => privateDirectory(file), /State directories/)
  })
  it('persists ordering, immutable publications and expiry across restart', () => {
    store.addApp({ slug: 'test.example.last', name: 'Last', position: 4 })
    store.addApp({ slug: 'test.example.middle', name: 'Middle', position: 2 })
    store.addApp({
      slug: 'test.example.hidden',
      name: 'Hidden',
      position: 1,
      enabled: false,
    })
    assert.deepEqual(
      store.apps().map((row) => row.name),
      ['Example', 'Middle', 'Last'],
    )
    const first = publish()
    now += 100
    const second = publish('2', 'different')
    assert.deepEqual(
      store.builds(app).map((row) => row.id),
      [second.id, first.id],
    )
    assert.equal(store.builds(app, 'missing').length, 0)
    assert.equal(store.usage(), 16)
    store.close()
    store = new Store(config, () => now)
    assert.equal(store.build(first.id)?.digest, digest('fixture'))
    const retry = stage('1')
    const repeated = store.publish(retry.id, retry.input)
    assert.equal(repeated.published_at, first.published_at)
    assert(!existsSync(store.incomingPath(retry.id)))
    now = first.expires_at
    assert.equal(store.build(first.id), undefined)
    assert.equal(store.builds(app).length, 1)
    assert.deepEqual(store.prune(), { builds: 1, files: 0 })
    assert(!existsSync(store.filePath(first.file_key)))
    assert(store.db.prepare('SELECT id FROM builds WHERE id=?').get(first.id))
    now += 7 * DAY
    store.prune()
    assert.equal(
      store.db.prepare('SELECT id FROM builds WHERE id=?').get(first.id),
      undefined,
    )
    assert.equal(store.apps().length, 3)
  })
  it('rejects malformed rows, channels, config, file keys and numbers', () => {
    for (const value of [
      NaN,
      Infinity,
      -1,
      1.1,
      '1',
      Number.MAX_SAFE_INTEGER + 1,
    ])
      assert.throws(() => integer()(value))
    assert.throws(() => asFlag(2))
    for (const value of ['', 'a\nb', 'x'.repeat(257), false])
      assert.throws(() => text()(value))
    assert.throws(() => object({})(null))
    assert.throws(() => object({})([]))
    assert.throws(() => object({})(JSON.parse('{"__proto__":{}}')))
    assert.throws(() => asConfig({ ...config, extra: true }))
    for (const url of [
      'http://example.test',
      'https://user:secret@example.test',
      'https://example.test/#x',
    ])
      assert.throws(() => asHttps(url))
    assert.throws(() => asOrigin('https://example.test/path'))
    assert.throws(() => asOrigin('https://example.test/?x=1'))
    assert.throws(() => asFileKey('../outside.apk'))
    assert.throws(() => store.channel(999))
    for (const allowedFormats of [[], ['ipa'], ['apk', 'apk'], ['unknown']])
      assert.throws(() =>
        store.addChannel({
          appId: app,
          platform: 'android',
          key: 'another',
          allowedFormats,
        }),
      )
    store.db
      .prepare('UPDATE channels SET formats=? WHERE id=?')
      .run('[false]', channel)
    assert.throws(() => store.channel(channel))
    store.db.prepare('UPDATE apps SET name=? WHERE id=?').run('', app)
    assert.throws(() => store.apps())
  })
  it('enforces owner-only private config and resolves relative paths', () => {
    const file = path.join(root, 'config.json')
    writeFileSync(
      file,
      JSON.stringify({
        ...config,
        database: 'relative.sqlite',
        storage: 'relative-store',
      }),
      { mode: 0o600 },
    )
    assert.equal(loadConfig(file).database, path.join(root, 'relative.sqlite'))
    const link = path.join(root, 'config-link')
    symlinkSync(file, link)
    assert.equal(loadConfig(link).storage, path.join(root, 'relative-store'))
    chmodSync(file, 0o644)
    assert.throws(() => loadConfig(file))
    chmodSync(file, 0o600)
    writeFileSync(file, '{')
    assert.throws(() => readPrivateJson(file))
    writeFileSync(file, ' '.repeat(1024 * 1024 + 1))
    assert.throws(() => readPrivateJson(file))
    assert.throws(() => readPrivateJson(root))
    assert.throws(() => loadConfig(path.join(root, 'absent')))
  })
  it('protects dedicated storage and rejects newer databases', () => {
    const occupied = path.join(root, 'occupied')
    mkdirSync(occupied)
    writeFileSync(path.join(occupied, 'keep'), 'safe')
    assert.throws(() => new Store({ ...config, storage: occupied }))
    assert.equal(readFileSync(path.join(occupied, 'keep'), 'utf8'), 'safe')
    const bad = path.join(root, 'bad')
    mkdirSync(bad)
    writeFileSync(path.join(bad, '.mason-store'), '{"format":"other"}')
    assert.throws(() => new Store({ ...config, storage: bad }))
    const link = path.join(root, 'linked')
    symlinkSync(occupied, link)
    assert.throws(() => noSymlinks(path.join(link, 'missing')))
    assert.throws(() => new Store({ ...config, storage: link }))
    const db = path.join(root, 'future.sqlite')
    const connection = new DatabaseSync(db)
    connection.exec('PRAGMA user_version=999')
    connection.close()
    assert.throws(
      () =>
        new Store({
          ...config,
          database: db,
          storage: path.join(root, 'future-packages'),
        }),
    )
    assert.throws(
      () =>
        new Store({ ...config, database: path.join(root, 'different.sqlite') }),
      /storage format/,
    )
  })
  it('bounds concurrent reservations, capacity and expired transfers', () => {
    const first = store.reserve('one', 1)
    store.reserve('one', 1)
    assert.throws(() => store.reserve('one', 1), /concurrency/)
    store.reserve('two', 1)
    store.reserve('two', 1)
    assert.throws(() => store.reserve('three', 1), /concurrency/)
    now += 91 * 60000
    const next = store.reserve('one', 1)
    assert.notEqual(next, first)
    store.cancel(next)
    store.cancel(next)
    assert.throws(() => store.reserve('one', 101))
    assert.throws(() => store.incomingPath('../outside'))
    store.close()
    store = new Store({ ...config, capacityBytes: 2 }, () => now)
    assert.throws(() => store.reserve('one', 3), /capacity/)
    store.close()
    store = new Store(
      { ...config, freeSpaceBytes: Number.MAX_SAFE_INTEGER },
      () => now,
    )
    assert.throws(() => store.reserve('one', 1), /capacity/)
  })
  it('publishes only valid reserved packages and rejects conflicting retries', () => {
    const first = publish()
    const conflict = stage('1', 'changed')
    assert.throws(() => store.publish(conflict.id, conflict.input), /conflict/)
    store.cancel(conflict.id)
    const transfer = stage('3')
    for (const override of [
      { size: 8 },
      { format: 'ipa' },
      { bundleId: 'wrong' },
      { digest: 'wrong' },
      { customFields: '[]' },
      { customFields: '{' },
      { customFields: 'x'.repeat(65537) },
      { changelog: 'x'.repeat(65537) },
    ])
      assert.throws(() =>
        store.publish(transfer.id, { ...transfer.input, ...override }),
      )
    assert.throws(
      () =>
        store.publish(transfer.id, transfer.input, () => {
          throw new Error('revoked')
        }),
      /revoked/,
    )
    writeFileSync(store.incomingPath(transfer.id), 'x')
    assert.throws(
      () =>
        store.publish(transfer.id, {
          ...transfer.input,
          digest: digest('unique'),
        }),
      /staged/,
    )
    store.cancel(transfer.id)
    const duplicate = stage('1')
    now = first.expires_at
    assert.throws(() => store.publish(duplicate.id, duplicate.input))
  })
  it('recovers orphans, stale transfers and deleting markers without following links', () => {
    const build = publish()
    store.db
      .prepare("UPDATE builds SET state='deleting' WHERE id=?")
      .run(build.id)
    const orphan = store.filePath('a'.repeat(32) + '.apk')
    writeFileSync(orphan, 'orphan')
    const old = store.incomingPath('b'.repeat(32))
    writeFileSync(old, 'old')
    utimesSync(old, (now - 3 * DAY) / 1000, (now - 3 * DAY) / 1000)
    const recent = store.incomingPath('c'.repeat(32))
    writeFileSync(recent, 'recent')
    assert.deepEqual(store.prune(), { builds: 1, files: 2 })
    assert(existsSync(recent))
    const outside = path.join(root, 'outside')
    writeFileSync(outside, 'safe')
    const bad = store.filePath('d'.repeat(32) + '.apk')
    symlinkSync(outside, bad)
    assert.throws(() => store.prune(), /entry/)
    assert.throws(() => store.filePath('d'.repeat(32) + '.apk'), /Symlink/)
    assert.equal(readFileSync(outside, 'utf8'), 'safe')
    rmSync(bad)
    const unknown = path.join(store.files, 'unexpected')
    writeFileSync(unknown, 'safe')
    assert.throws(() => store.prune(), /file/)
    assert(existsSync(unknown))
  })
  it('runs the actual compiled operator CLI and reports failures without secrets', () => {
    const file = path.join(root, 'config.json')
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
    const lines: string[] = []
    run(['migrate', '--config', file], (line) => lines.push(line))
    run(['status', '--config', file], (line) => lines.push(line))
    run(['prune', '--config', file], (line) => lines.push(line))
    assert.equal(lines[0], 'Mason database is ready')
    assert.deepEqual(JSON.parse(lines[1]!), { bytes: 0, apps: 1 })
    assert.throws(() => run(['unknown']))
    const stdout = execFileSync(
      process.execPath,
      ['lib/cli.js', 'status', '--config', file],
      { encoding: 'utf8' },
    )
    assert.equal(JSON.parse(stdout).apps, 1)
    const failure = spawnSync(
      process.execPath,
      ['lib/cli.js', 'status', '--config', 'missing-sensitive-path'],
      { encoding: 'utf8' },
    )
    assert.equal(failure.status, 1)
    assert(!failure.stderr.includes('missing-sensitive-path'))
  })
})
