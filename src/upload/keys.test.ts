import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { asConfig } from '../config.js'
import { Store } from '../store.js'
import { importCredentials, keyCommand } from './keyCli.js'
import { ApiKeys, asApiToken, asCredentials, asScopes } from './keys.js'

let root: string,
  store: Store,
  keys: ApiKeys,
  now: number,
  app: number,
  other: number,
  configFile: string
function cli(args: string[], input?: string): string {
  return execFileSync(process.execPath, ['lib/cli.js', 'keys', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}
describe('Mason operator API keys', () => {
  beforeEach(() => {
    assert(process.env.MASON_TEST_ROOT)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT, 'keys-'))
    now = Date.now()
    store = new Store(
      asConfig({
        origin: 'https://builds.example.test',
        database: path.join(root, 'state.sqlite'),
        storage: path.join(root, 'packages'),
      }),
      () => now,
    )
    keys = new ApiKeys(store)
    app = store.addApp({
      slug: 'test.example.app',
      name: 'Example',
      position: 0,
    })
    other = store.addApp({
      slug: 'test.example.other',
      name: 'Other',
      position: 1,
    })
    configFile = path.join(root, 'config.json')
    writeFileSync(configFile, JSON.stringify(store.config), { mode: 0o600 })
  })
  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('creates scoped one-time tokens and immediately enforces revocation and expiration', () => {
    const credential = keys.create('CI', [app], now + 1000)
    assert.equal(keys.authenticate(credential.token, app).id, credential.id)
    assert.throws(() => keys.authenticate(credential.token, other))
    assert.throws(() =>
      keys.authenticate(credential.token.slice(0, -1) + 'x', app),
    )
    assert.throws(() =>
      keys.authenticate(
        'mason_v1_' + '0'.repeat(32) + '.' + 'x'.repeat(43),
        app,
      ),
    )
    assert.throws(() => keys.authenticate('invalid', app))
    assert.throws(() => keys.create('CI', [999]))
    assert.throws(() => keys.create('CI', 'all', now))
    assert(!JSON.stringify(keys.list()).includes(credential.token))
    assert.notEqual(
      store.db
        .prepare('SELECT hash FROM api_keys WHERE id=?')
        .get(credential.id)?.hash,
      credential.token,
    )
    now += 1000
    assert.throws(() => keys.authenticate(credential.token, app))
    const all = keys.create('All apps', 'all')
    assert.equal(keys.authenticate(all.token, other).apps, 'all')
    keys.revoke(all.id)
    assert.throws(() => keys.authenticate(all.token, app))
    assert.equal(
      keys.list().find((row) => row.id === all.id)?.revoked,
      true,
    )
    assert.throws(() => keys.revoke('0'.repeat(32)))
    assert.throws(() => keys.revoke('invalid'))
    for (const input of [[], [app, app], [0], {}, 'other'])
      assert.throws(() => asScopes(input))
    assert.throws(() => asApiToken('mason_v1_broken'))
    assert.throws(() => asCredentials({ ...all, schemaVersion: 2 }))
    assert.throws(() => asCredentials({ ...all, id: '0'.repeat(32) }))
  })
  it('atomically imports credentials privately and refuses unsafe destinations', () => {
    const credentials = keys.create('Agent', 'all'),
      file = path.join(root, 'credentials', 'mason.json')
    importCredentials(file, credentials)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(
      asCredentials(JSON.parse(readFileSync(file, 'utf8'))).token,
      credentials.token,
    )
    assert.throws(() => importCredentials(file, credentials))
    chmodSync(file, 0o644)
    importCredentials(file, credentials, true)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const link = path.join(root, 'link')
    symlinkSync(file, link)
    assert.throws(() => importCredentials(link, credentials, true))
    const directory = path.join(root, 'directory')
    mkdirSync(directory)
    assert.throws(() => importCredentials(directory, credentials, true))
    assert.throws(() =>
      importCredentials(path.join(root, 'invalid'), {
        ...credentials,
        origin: 'http://example.test',
      }),
    )
    assert(!existsSync(path.join(root, 'invalid')))
  })
  it('runs compiled create/list/revoke and pipes credentials into a separate import process', () => {
    const created = cli([
      'create',
      '--config',
      configFile,
      '--name',
      'Fixture',
      '--apps',
      String(app),
      '--json',
      '--expires',
      new Date(Date.now() + 86400000).toISOString(),
    ])
    const credentials = asCredentials(JSON.parse(created))
    assert.equal(keys.authenticate(credentials.token, app).name, 'Fixture')
    const file = path.join(root, 'saved.json')
    assert.match(cli(['import', '--file', file], created), /Saved/)
    assert.match(
      cli(['import', '--file', file, '--replace'], created),
      /Saved/,
    )
    const listed = cli(['list', '--config', configFile])
    assert(listed.includes('Fixture'))
    assert(!listed.includes(credentials.token))
    assert.match(
      cli(['revoke', '--config', configFile, '--id', credentials.id]),
      /revoked/,
    )
    assert.throws(() => keys.authenticate(credentials.token, app))
    assert.throws(() =>
      cli(
        ['import', '--file', path.join(root, 'oversized.json')],
        'x'.repeat(65537),
      ),
    )
    assert.throws(() =>
      cli(['import', '--file', path.join(root, 'bad.json')], 'not-json'),
    )
    const failed = spawnSync(
      process.execPath,
      ['lib/cli.js', 'keys', 'import', '--file', file],
      { input: created, encoding: 'utf8' },
    )
    assert.equal(failed.status, 1)
    assert(!failed.stderr.includes(credentials.token))
    assert(!failed.stdout.includes(credentials.token))
  })
  it('rejects unknown, missing and duplicate CLI flags without disclosing values', () => {
    for (const args of [
      [],
      ['unknown'],
      ['list', 'oops'],
      ['list', '--config'],
      ['list', '--config', '--name'],
      ['list', '--config', configFile, '--config', configFile],
      ['list', '--other', 'x'],
      ['create', '--config', configFile, '--name', 'CI', '--apps', 'all'],
      ['revoke', '--config', configFile],
      [
        'create',
        '--config',
        configFile,
        '--name',
        'CI',
        '--apps',
        'all',
        '--json',
        '--expires',
        'invalid',
      ],
    ])
      assert.throws(() => keyCommand(args, () => {}))
    let output = ''
    keyCommand(
      [
        'create',
        '--config',
        configFile,
        '--name',
        'All',
        '--apps',
        'all',
        '--json',
      ],
      (value) => {
        output = value
      },
    )
    assert.equal(asCredentials(JSON.parse(output)).name, 'All')
  })
})
