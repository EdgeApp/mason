import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Request } from 'express'
import { after, before, describe, it } from 'mocha'
import { cluster, type Cluster } from '../test/cluster.js'
import { seedSecret } from '../test/secrets.js'
import {
  BackupFailed,
  backupArea,
  Backups,
  open,
  parseBackupKey,
  type BackupSetting,
} from './backup.js'
import { MasterDatabase } from './database.js'
import { Projects } from './projects.js'
import { localOperator, type Actor } from './roles.js'
import {
  asConfigs,
  resolveSecret,
  resolveSecrets,
} from '../pipeline/variants.js'
import { asForwardRequest } from './forward.js'
import {
  BackupRefused,
  isText,
  legacyRows,
  Secrets,
  type SecretsCaller,
} from './secrets.js'
import { requestAddress } from './secretsApi.js'
import { Settings } from './settings.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const root = (name: string): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), name))
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  })
const b64 = (text: string | Buffer): string =>
  Buffer.from(text).toString('base64')

describe('Secret variants: rules', () => {
  it('U18.10 resolves the variant of the latest config a stage lists, else the default, else none', () => {
    const variants = [
      { id: 1, configs: [] as string[] },
      { id: 2, configs: ['develop'] },
      { id: 3, configs: ['maestro', 'beta'] },
    ]
    assert.equal(resolveSecret(variants, ['develop', 'maestro'])!.id, 3)
    assert.equal(resolveSecret(variants, ['maestro', 'develop'])!.id, 2)
    assert.equal(resolveSecret(variants, ['develop'])!.id, 2)
    assert.equal(resolveSecret(variants, ['coinhub'])!.id, 1)
    assert.equal(resolveSecret(variants, [])!.id, 1)
    assert.equal(resolveSecret(variants.slice(1), ['coinhub']), undefined)
    const all = [
      { name: 'A', configs: [] as string[] },
      { name: 'A', configs: ['develop'] },
      { name: 'B', configs: ['beta'] },
    ]
    const resolved = resolveSecrets(all, ['A', 'B', 'C'], ['develop'])
    assert.deepEqual([...resolved.keys()], ['A'])
    assert.equal(resolved.get('A'), all[1])
  })

  it('U18.10 build configs are tokens, normalized; text is UTF-8 without NUL', () => {
    assert.deepEqual(asConfigs(''), [])
    assert.deepEqual(asConfigs(undefined), [])
    assert.deepEqual(asConfigs(' b , a ,b'), ['a', 'b'])
    assert.deepEqual(asConfigs(['x_1', 'y-2']), ['x_1', 'y-2'])
    for (const bad of ['a b', 'a;b', 'é', [1], { a: 1 }])
      assert.throws(() => asConfigs(bad), /build config/i)
    assert.throws(
      () => asConfigs(Array.from({ length: 21 }, (_, i) => `c${i}`)),
      /At most 20/,
    )
    assert.equal(isText(Buffer.from('{"a": "é"}\n')), true)
    assert.equal(isText(Buffer.from([0x7b, 0xff, 0x7d])), false)
    assert.equal(isText(Buffer.from('a\0b')), false)
  })

  it('U18.10 legacy secrets map to default variants, with names that never collide', () => {
    const rows = legacyRows('pipeline', {
      env: [
        { name: 'API_TOKEN', value: 'v', secret: true },
        { name: 'PLAIN', value: 'p', secret: false },
      ],
      files: [
        { destination: 'API_TOKEN', contents: b64('x') },
        { destination: 'X.file', contents: b64('y') },
        { destination: 'a.json', contents: b64('{}'), env: 'X' },
        { destination: 'X', contents: b64('z') },
        { destination: 'master/config.json', contents: b64('{}') },
        { destination: 'me@x.json', contents: b64('{}') },
        { destination: '.git/hooks', contents: b64(Buffer.from([0, 1])) },
      ],
    })
    assert.deepEqual(
      rows.map((row) => [row.name, row.kind, row.masked, row.destination]),
      [
        ['API_TOKEN', 'value', 1, null],
        ['PLAIN', 'value', 0, null],
        ['X', 'file', 1, null],
        ['_git/hooks', 'file', 1, null],
        ['API_TOKEN.file', 'file', 1, null],
        ['X.file', 'file', 1, null],
        ['X.file.file', 'file', 1, null],
        ['master/config.json', 'file', 1, null],
        ['me_x.json', 'file', 1, null],
      ],
    )
    assert.equal(rows.find((row) => row.name === 'X')!.pathEnv, 'X')
    assert.equal(rows.find((row) => row.name === '_git/hooks')!.text, 0)
    // Script projects name a file by where it goes, and keep that path to inject it at.
    const script = legacyRows('script', {
      env: [{ name: 'CONFIG', value: 'v', secret: true }],
      files: [
        { destination: 'CONFIG', contents: b64('{}'), env: 'CONFIG_FILE' },
      ],
    })
    assert.deepEqual(
      script.map((row) => [row.name, row.destination, row.pathEnv]),
      [
        ['CONFIG', null, null],
        ['CONFIG.file', 'CONFIG', 'CONFIG_FILE'],
      ],
    )
  })
})

describe('Secret variants: changes, views and their audit', function () {
  this.timeout(60_000)
  let dir: string
  let bare: string
  let database: MasterDatabase
  let settings: Settings
  let backups: Backups
  let secrets: Secrets
  let projects: Projects
  const manager: SecretsCaller = {
    actor: { role: 'manager', accountId: 1, label: 'account:1' },
    address: '10.0.0.5',
  }
  const developer: SecretsCaller = {
    actor: { role: 'developer', accountId: 2, label: 'account:2' },
    address: '10.0.0.6',
  }
  const tester: SecretsCaller = {
    actor: { role: 'tester', label: 'account:3', accountId: 3 },
    address: '10.0.0.7',
  }
  const pushes = (): number =>
    Number(git(dir, '--git-dir', bare, 'rev-list', '--count', 'backups').trim())
  const pushed = (): DatabaseSync => {
    const out = mkdtempSync(path.join(dir, 'clone-'))
    git(out, 'clone', '-q', '--branch', 'backups', bare, 'repo')
    const file = path.join(out, 'restored.sqlite')
    writeFileSync(
      file,
      open(
        parseBackupKey(backups.keyText()),
        readFileSync(path.join(out, 'repo', 'latest.enc')),
      ),
    )
    return new DatabaseSync(file)
  }
  const audit = (): Json[] =>
    database.db
      .prepare('SELECT * FROM secret_audit ORDER BY id')
      .all()
      .map((row) => ({ ...row }))

  before(async () => {
    dir = root('secrets-')
    bare = path.join(dir, 'backup.git')
    git(dir, 'init', '-q', '--bare', bare)
    mkdirSync(path.join(dir, 'master'), { mode: 0o700 })
    database = new MasterDatabase(
      new DatabaseSync(path.join(dir, 'master', 'master.sqlite')),
      () => Date.UTC(2026, 9, 29, 12),
    )
    settings = new Settings(database)
    backups = new Backups({
      master: database,
      dir: path.join(dir, 'master'),
      scratch: path.join(dir, 'master', 'scratch'),
      setting: (): BackupSetting | undefined =>
        settings.value('backup') as BackupSetting | undefined,
      fingerprint: 'mldsa65:test',
      attempts: 1,
    })
    settings.register('backup', {
      ...backupArea,
      changed: () => {
        backups.key()
      },
    })
    secrets = new Secrets(database, backups)
    projects = new Projects(database)
    for (const [name, role] of [
      ['Mia Manager', 'manager'],
      ['Dev Eloper', 'developer'],
      ['Tess Ter', 'tester'],
    ] as const)
      database.db
        .prepare(
          "INSERT INTO accounts(name,username,password,role,created_at) VALUES(?,?,'{}',?,0)",
        )
        .run(name, name.split(' ')[0]!.toLowerCase(), role)
    projects.save(localOperator, 'app', {
      repository: 'https://github.com/a/app',
    })
    projects.save(localOperator, 'other', {
      repository: 'https://github.com/a/other',
    })
    projects.save(localOperator, 'script', {
      repository: 'https://github.com/a/script',
      format: 'script',
    })
  })

  it('U18.11 refuses changes until backups are configured, while views still work', async () => {
    const id = seedSecret(database.db, 'other', {
      name: 'SEEDED',
      kind: 'value',
      value: 'seeded-value-1',
    })
    await assert.rejects(
      secrets.add(manager, 'app', { name: 'A', kind: 'value', value: '1' }),
      /Configure backups before changing secrets/,
    )
    assert.deepEqual(secrets.contents(manager, 'other', id), {
      value: 'seeded-value-1',
    })
    assert.deepEqual(
      audit().map((row) => [row.name, row.action, row.detail]),
      [
        ['A', 'refused', 'backups are not configured'],
        ['SEEDED', 'viewed', null],
      ],
    )
    await settings.set(localOperator, 'backup', {
      repository: bare,
      branch: 'backups',
    })
  })

  it('U18.11 adds values and files, each pushed in a backup before it is saved and audited', async () => {
    const token = await secrets.add(manager, 'app', {
      name: 'API_TOKEN',
      kind: 'value',
      configs: '',
      value: 'token-value-default',
    })
    assert.equal(pushes(), 1)
    const develop = await secrets.add(manager, 'app', {
      name: 'API_TOKEN',
      kind: 'value',
      configs: 'develop',
      value: 'token-value-develop',
    })
    const config = await secrets.add(manager, 'app', {
      name: 'config.json',
      kind: 'file',
      configs: 'beta, develop',
      contents: b64('{"a": 1}\n'),
    })
    const keystore = await secrets.add(manager, 'app', {
      name: 'release.jks',
      kind: 'file',
      contents: b64(Buffer.from([0xfe, 0xed, 0, 1])),
    })
    assert.equal(pushes(), 4)
    assert.deepEqual(
      [token, develop, config, keystore].map((v) => [
        v.name,
        v.kind,
        v.configs,
        v.text,
        v.bytes,
      ]),
      [
        ['API_TOKEN', 'value', [], true, 19],
        ['API_TOKEN', 'value', ['develop'], true, 19],
        ['config.json', 'file', ['beta', 'develop'], true, 9],
        ['release.jks', 'file', [], false, 4],
      ],
    )
    // The pushed backup holds every change so far.
    const copy = pushed()
    assert.equal(
      Number(
        (
          copy
            .prepare(
              'SELECT COUNT(*) n FROM project_secrets WHERE project_id=(SELECT id FROM projects WHERE slug=?)',
            )
            .get('app') as { n: number }
        ).n,
      ),
      4,
    )
    // And the audit row of each, the last one included.
    const restored = copy
      .prepare(
        "SELECT name,configs,account_id,address FROM secret_audit WHERE action='added' ORDER BY id",
      )
      .all()
      .map((row) => Object.values(row))
    copy.close()
    const added = audit().filter((row) => row.action === 'added')
    const expected = [
      ['API_TOKEN', '', 1, '10.0.0.5'],
      ['API_TOKEN', 'develop', 1, '10.0.0.5'],
      ['config.json', 'beta,develop', 1, '10.0.0.5'],
      ['release.jks', '', 1, '10.0.0.5'],
    ]
    assert.deepEqual(
      added.map((row) => [row.name, row.configs, row.account_id, row.address]),
      expected,
    )
    assert.deepEqual(restored, expected)
  })

  it('U18.11 refuses overlaps, a second default, a kind mismatch and bad input, without a push', async () => {
    const count = pushes()
    for (const [input, message] of [
      [
        { name: 'API_TOKEN', kind: 'value', configs: '', value: 'x' },
        /already has a variant for all configs/,
      ],
      [
        {
          name: 'API_TOKEN',
          kind: 'value',
          configs: 'beta,develop',
          value: 'x',
        },
        /already has a variant for develop/,
      ],
      [
        {
          name: 'API_TOKEN',
          kind: 'file',
          configs: 'beta',
          contents: b64('x'),
        },
        /API_TOKEN is already a value/,
      ],
      [
        {
          name: 'config.json',
          kind: 'file',
          configs: 'develop',
          contents: b64('x'),
        },
        /already has a variant for develop/,
      ],
      [
        { name: 'lower', kind: 'value', value: 'x' },
        /Reserved or invalid environment name/,
      ],
      [
        { name: 'MASON_X', kind: 'value', value: 'x' },
        /Reserved or invalid environment name/,
      ],
      [
        { name: 'PATH', kind: 'value', value: 'x' },
        /PATH is set by the build environment/,
      ],
      [
        { name: 'GIT_SSH_COMMAND', kind: 'value', value: 'x' },
        /set by the build environment/,
      ],
      [{ name: 5, kind: 'value', value: 'x' }, /Expected a string/],
      [
        { name: 'BIG', kind: 'value', value: 'x'.repeat(65 * 1024) },
        /over 64 KiB/,
      ],
      [{ name: 'NUL', kind: 'value', value: 'a\0b' }, /NUL/],
      [{ name: 'NOVALUE', kind: 'value' }, /is text/],
      [{ name: 'x.json', kind: 'file', contents: '***' }, /base64/],
      [
        {
          name: 'huge.bin',
          kind: 'file',
          contents: b64(Buffer.alloc(5 * 1024 * 1024 + 1)),
        },
        /over 5 MiB/,
      ],
      [
        { name: '.git/x', kind: 'file', contents: b64('x') },
        /Unsafe relative path/,
      ],
      [
        { name: 'cert+key.p12', kind: 'file', contents: b64('x') },
        /Unsafe relative path/,
      ],
      [
        { name: 'me@x.json', kind: 'file', contents: b64('x') },
        /Unsafe relative path/,
      ],
      [
        { name: '../x', kind: 'file', contents: b64('x') },
        /Unsafe relative path/,
      ],
      [
        {
          name: 'android/app/google-services.json',
          kind: 'file',
          contents: b64('x'),
        },
        /android\/app\/google-services\.json is a path: a secret file is named by its file name/,
      ],
      [{ name: 'A', kind: 'secret', value: 'x' }, /kind is value or file/],
      [
        { name: 'A', kind: 'value', value: 'x', masked: false },
        /for script projects/,
      ],
      [
        { name: 'A', kind: 'value', value: 'x', configs: 'a b' },
        /build config/,
      ],
    ] as const)
      await assert.rejects(secrets.add(manager, 'app', input), message)
    await assert.rejects(
      secrets.add(manager, 'app', 'nope'),
      /Expected an object/,
    )
    assert.equal(pushes(), count)
  })

  it('U18.11 serializes concurrent changes: two adds both land; a conflicting second add is refused', async () => {
    const count = pushes()
    const [a, b] = await Promise.all([
      secrets.add(manager, 'app', { name: 'ONE', kind: 'value', value: '1' }),
      secrets.add(manager, 'app', { name: 'TWO', kind: 'value', value: '2' }),
    ])
    assert.deepEqual([a.name, b.name], ['ONE', 'TWO'])
    assert.equal(pushes(), count + 2)
    // The second push holds the first change too.
    const copy = pushed()
    assert.equal(
      copy
        .prepare(
          "SELECT COUNT(*) n FROM project_secrets WHERE name IN ('ONE','TWO')",
        )
        .get()!.n,
      2,
    )
    copy.close()
    const results = await Promise.allSettled([
      secrets.add(manager, 'app', {
        name: 'RACE',
        kind: 'value',
        configs: 'develop',
        value: '1',
      }),
      secrets.add(manager, 'app', {
        name: 'RACE',
        kind: 'value',
        configs: 'develop,beta',
        value: '2',
      }),
    ])
    assert.equal(results[0].status, 'fulfilled')
    assert.equal(results[1].status, 'rejected')
    assert.match(
      String((results[1] as PromiseRejectedResult).reason),
      /RACE already has a variant for develop/,
    )
    assert.equal(pushes(), count + 3)
  })

  it('U18.11 edits values and text files, replaces files, changes configs and deletes, each audited', async () => {
    const list = secrets.list(manager, 'app')
    const id = (name: string, configs: string[] = []): number =>
      list.find((v) => v.name === name && v.configs.join() === configs.join())!
        .id
    assert.deepEqual(secrets.contents(manager, 'app', id('API_TOKEN')), {
      value: 'token-value-default',
    })
    await secrets.edit(manager, 'app', id('API_TOKEN'), { value: 'token-2' })
    assert.deepEqual(secrets.contents(manager, 'app', id('API_TOKEN')), {
      value: 'token-2',
    })
    const config = id('config.json', ['beta', 'develop'])
    assert.deepEqual(secrets.contents(manager, 'app', config), {
      text: '{"a": 1}\n',
    })
    await secrets.edit(manager, 'app', config, { text: '{"a": 2}\n' })
    assert.deepEqual(secrets.contents(manager, 'app', config), {
      text: '{"a": 2}\n',
    })
    const keystore = id('release.jks')
    assert.deepEqual(secrets.contents(manager, 'app', keystore), {
      contents: b64(Buffer.from([0xfe, 0xed, 0, 1])),
    })
    await assert.rejects(
      secrets.edit(manager, 'app', keystore, { text: 'x' }),
      /A binary file can only be replaced/,
    )
    await assert.rejects(
      secrets.edit(manager, 'app', config, { text: 'a\0b' }),
      /NUL/,
    )
    await assert.rejects(
      secrets.edit(manager, 'app', config, { text: 3 }),
      /Expected a string/,
    )
    await assert.rejects(
      secrets.replace(manager, 'app', id('API_TOKEN'), { contents: b64('x') }),
      /is a value: edit it instead/,
    )
    // A replaced binary that is now text can be edited.
    const replaced = await secrets.replace(manager, 'app', keystore, {
      contents: b64('now text'),
    })
    assert.equal(replaced.text, true)
    const changed = await secrets.setConfigs(manager, 'app', config, {
      configs: 'beta',
    })
    assert.deepEqual(changed.configs, ['beta'])
    await assert.rejects(
      secrets.setConfigs(manager, 'app', id('API_TOKEN', ['develop']), {
        configs: '',
      }),
      /already has a variant for all configs/,
    )
    await assert.rejects(
      secrets.setConfigs(manager, 'app', id('API_TOKEN', ['develop']), {
        configs: 'x y',
      }),
      /build config/,
    )
    assert.equal(await secrets.remove(manager, 'app', id('TWO')), null)
    assert(!secrets.list(manager, 'app').some((v) => v.name === 'TWO'))
    const rows = audit()
    const last = (action: string): Json =>
      rows.filter((row) => row.action === action).at(-1)
    assert.equal(last('edited').name, 'config.json')
    assert.equal(last('replaced').name, 'release.jks')
    assert.equal(last('configs changed').detail, 'beta, develop → beta')
    assert.equal(last('configs changed').configs, 'beta')
    assert.equal(last('deleted').name, 'TWO')
    assert(rows.filter((row) => row.action === 'viewed').length >= 5)
  })

  it('U18.11 developers see names and configs only; testers nothing; refusals are audited and ids stay in their project', async () => {
    const listed = secrets.list(developer, 'app')
    assert(listed.length > 0)
    assert(!JSON.stringify(listed).includes('token-'))
    assert(!JSON.stringify(listed).includes('contents'))
    const id = listed[0]!.id
    assert.throws(() => secrets.contents(developer, 'app', id), /Not allowed/)
    assert.throws(() => secrets.list(tester, 'app'), /Not allowed/)
    await assert.rejects(secrets.remove(developer, 'app', id), /Not allowed/)
    const refused = audit()
      .filter((row) => row.action === 'refused')
      .slice(-3)
    assert.deepEqual(
      refused.map((row) => [row.account_id, row.address, row.detail]),
      [
        [2, '10.0.0.6', 'Not allowed for the developer role'],
        [3, '10.0.0.7', 'Not allowed for the tester role'],
        [2, '10.0.0.6', 'Not allowed for the developer role'],
      ],
    )
    // An unknown project: 403 for a role that may not, with nothing to audit; 404 for one that may.
    const count = audit().length
    assert.throws(() => secrets.contents(developer, 'nope', 1), /Not allowed/)
    assert.equal(audit().length, count)
    assert.throws(
      () => secrets.contents(manager, 'nope', 1),
      /No project named nope/,
    )
    // A variant of another project is not found under this one, even for a key scoped to this one.
    const other = secrets.list(manager, 'other')[0]!.id
    const scoped: SecretsCaller = {
      actor: {
        role: 'admin',
        keyId: 'k1',
        label: 'key:k1',
        scopes: { projects: ['app'], branches: [] },
      },
      address: '10.0.0.8',
    }
    assert.throws(() => secrets.contents(scoped, 'app', other), /No secret/)
    for (const change of [
      (): Promise<unknown> =>
        secrets.edit(scoped, 'app', other, { value: 'x' }),
      (): Promise<unknown> =>
        secrets.replace(scoped, 'app', other, { contents: b64('x') }),
      (): Promise<unknown> =>
        secrets.setConfigs(scoped, 'app', other, { configs: 'a' }),
      (): Promise<unknown> => secrets.remove(scoped, 'app', other),
    ])
      await assert.rejects(change(), /No secret/)
    // A key outside its scope is refused, and the audit says it was the scope.
    assert.throws(
      () => secrets.contents(scoped, 'other', other),
      /does not cover that project/,
    )
    assert.equal(
      audit().at(-1).detail,
      'This key does not cover that project or branch',
    )
    assert.equal(secrets.contents(manager, 'other', other).constructor, Object)
  })

  it('U18.11 the audit lists who, by name or key, newest first, and never holds a value', async () => {
    database.db
      .prepare(
        "INSERT INTO api_keys(id,hash,name,apps,created_at,role,format) VALUES('k9','h9','Deploy bot','\"all\"',0,'manager','v1')",
      )
      .run()
    const key: SecretsCaller = {
      actor: { role: 'manager', keyId: 'k9', label: 'key:k9' },
      address: '10.0.0.9',
    }
    await secrets.add(key, 'app', {
      name: 'BOT_TOKEN',
      kind: 'value',
      value: 'bot-value-1',
    })
    const entries = secrets.audit(manager, 'app', 3)
    assert.equal(entries.length, 3)
    assert.deepEqual(
      [entries[0]!.who, entries[0]!.action, entries[0]!.address],
      ['API key Deploy bot', 'added', '10.0.0.9'],
    )
    assert(entries[0]!.id > entries[1]!.id)
    assert(
      secrets
        .audit(manager, 'app')
        .some((entry) => entry.who === 'Mia Manager'),
    )
    assert.equal(secrets.audit(manager, 'app', 0).length > 3, true)
    assert.throws(() => secrets.audit(developer, 'app'), /Not allowed/)
    const local: SecretsCaller = { actor: localOperator, address: 'local' }
    await secrets.add(local, 'app', {
      name: 'LOCAL',
      kind: 'value',
      value: 'l',
    })
    assert.equal(secrets.audit(manager, 'app', 1)[0]!.who, 'local operator')
    const dump = JSON.stringify(
      database.db.prepare('SELECT * FROM secret_audit').all(),
    )
    for (const value of ['token-value', 'token-2', 'bot-value-1', '{"a"'])
      assert(!dump.includes(value), value)
  })

  it('U18.11 script projects take masked and a path variable, and keep variables and paths unique', async () => {
    const plain = await secrets.add(manager, 'script', {
      name: 'SERVER',
      kind: 'value',
      value: 'https://x',
      masked: false,
    })
    assert.equal(plain.masked, false)
    const file = await secrets.add(manager, 'script', {
      name: 'config/app.json',
      kind: 'file',
      contents: b64('{}'),
      pathEnv: 'CONFIG_FILE',
    })
    assert.equal(file.pathEnv, 'CONFIG_FILE')
    // A migrated file renamed for a collision keeps the path it is injected at.
    seedSecret(database.db, 'script', {
      name: 'CONFIG.file',
      kind: 'file',
      contents: b64('{}'),
      destination: 'CONFIG',
    })
    for (const [input, message] of [
      [
        { name: 'CONFIG_FILE', kind: 'value', value: 'x' },
        /already set as a variable/,
      ],
      [
        {
          name: 'other.json',
          kind: 'file',
          contents: b64('{}'),
          pathEnv: 'SERVER',
        },
        /already set as a variable/,
      ],
      [
        { name: 'CONFIG', kind: 'file', contents: b64('{}') },
        /already injected at CONFIG/,
      ],
      [
        { name: 'V', kind: 'value', value: 'x', pathEnv: 'P' },
        /pathEnv is for files/,
      ],
      [
        { name: 'f.json', kind: 'file', contents: b64('x'), masked: true },
        /masked is for values/,
      ],
      [
        { name: 'W', kind: 'value', value: 'x', masked: 'no' },
        /masked is true or false/,
      ],
    ] as const)
      await assert.rejects(secrets.add(manager, 'script', input), message)
    await assert.rejects(
      secrets.add(manager, 'app', {
        name: 'f.json',
        kind: 'file',
        contents: b64('x'),
        pathEnv: 'P',
      }),
      /for script projects/,
    )
  })

  it('U18.11 script projects take no configs, ids are never reused, and a refused add audits a short name', async () => {
    await assert.rejects(
      secrets.add(manager, 'script', {
        name: 'X',
        kind: 'value',
        value: '1',
        configs: 'beta',
      }),
      /script project's secrets have no build configs/,
    )
    const plain = secrets
      .list(manager, 'script')
      .find((variant) => variant.name === 'SERVER')!
    await assert.rejects(
      secrets.setConfigs(manager, 'script', plain.id, { configs: 'beta' }),
      /no build configs/,
    )
    const last = await secrets.add(manager, 'app', {
      name: 'LAST',
      kind: 'value',
      value: '1',
    })
    await secrets.remove(manager, 'app', last.id)
    const next = await secrets.add(manager, 'app', {
      name: 'NEXT',
      kind: 'value',
      value: '1',
    })
    assert(next.id > last.id)
    await assert.rejects(
      secrets.add(developer, 'app', {
        name: 'N'.repeat(10_000),
        kind: 'value',
        value: '1',
      }),
      /Not allowed/,
    )
    assert.equal(audit().at(-1).name.length, 120)
    // A body the cleaners refuse: a 400 before anything is pushed.
    await assert.rejects(
      secrets.add(manager, 'app', 'nope'),
      /Expected an object/,
    )
    await assert.rejects(
      secrets.edit(manager, 'app', next.id, { value: 5 }),
      /Expected a string/,
    )
  })

  it('U18.11 a change waiting in the queue for a project deleted meanwhile is refused, and a change that fails on the snapshot copy is not a failed backup', async () => {
    let release: (() => void) | undefined
    const held = backups.change(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    // The held change has the queue once its work has started.
    while (release == null)
      await new Promise((resolve) => setImmediate(resolve))
    projects.save(localOperator, 'gone', {
      repository: 'https://github.com/a/gone',
    })
    const waiting = secrets.add(manager, 'gone', {
      name: 'X',
      kind: 'value',
      value: '1',
    })
    database.db.prepare("DELETE FROM projects WHERE slug='gone'").run()
    release()
    await held
    await assert.rejects(waiting, /No project named gone/)
    // A trigger copied into the snapshot makes the change itself fail there.
    database.db.exec(
      "CREATE TRIGGER refuse_bad BEFORE INSERT ON project_secrets WHEN NEW.name='BAD' BEGIN SELECT RAISE(ABORT,'bad row'); END",
    )
    const runs = (): number =>
      Number(
        (
          database.db.prepare('SELECT COUNT(*) n FROM backup_runs').get() as {
            n: number
          }
        ).n,
      )
    const before = runs()
    await assert.rejects(
      secrets.add(manager, 'app', { name: 'BAD', kind: 'value', value: '1' }),
      /^NotApplied: Not saved: bad row$|Not saved: bad row/,
    )
    database.db.exec('DROP TRIGGER refuse_bad')
    assert.equal(runs(), before)
    assert.equal(audit().at(-1).detail, 'not applied: bad row')
  })

  it('U18.11 ids from a route are positive integers; a project deleted during the push, and an audit that cannot be written, still give the intended refusal', async () => {
    const id = secrets.list(manager, 'app')[0]!.id
    for (const bad of [
      `0x${id.toString(16)}`,
      `${id}.0`,
      ` ${id}`,
      '1e1',
      '-1',
      '0',
    ])
      assert.throws(
        () => secrets.contents(manager, 'app', bad),
        /No secret/,
        bad,
      )
    // A stand-in queue that runs the change's work and deletes the project mid-push.
    projects.save(localOperator, 'gone2', {
      repository: 'https://github.com/a/gone2',
    })
    const fake = {
      status: () => ({ configured: true, backedUp: true }),
      change: async <T>(
        work: (push: (mutate: unknown) => Promise<void>) => Promise<T>,
      ): Promise<T> =>
        await work(async () => {
          database.db.prepare("DELETE FROM projects WHERE slug='gone2'").run()
        }),
    } as unknown as Backups
    await assert.rejects(
      new Secrets(database, fake).add(manager, 'gone2', {
        name: 'X',
        kind: 'value',
        value: '1',
      }),
      /No project named gone2/,
    )
    // The push fails and so does the audit write: the caller still gets BackupRefused.
    const refusing = {
      status: () => ({ configured: true, backedUp: true }),
      change: async <T>(
        work: (push: (mutate: unknown) => Promise<void>) => Promise<T>,
      ): Promise<T> =>
        await work(async () => {
          throw new BackupFailed('remote rejected')
        }),
    } as unknown as Backups
    database.db.exec(
      "CREATE TEMP TRIGGER no_audit BEFORE INSERT ON secret_audit BEGIN SELECT RAISE(ABORT,'database or disk is full'); END",
    )
    try {
      await assert.rejects(
        new Secrets(database, refusing).add(manager, 'app', {
          name: 'Y',
          kind: 'value',
          value: '1',
        }),
        (error: Error) =>
          error instanceof BackupRefused &&
          /could not be pushed \(remote rejected\)/.test(error.message),
      )
    } finally {
      database.db.exec('DROP TRIGGER temp.no_audit')
    }
  })

  it('U18.12 a host may forward only a short, single-line client address', () => {
    const request = {
      method: 'GET',
      path: '/api/v2/projects',
    }
    assert.equal(
      asForwardRequest({ ...request, address: '10.1.2.3' }).address,
      '10.1.2.3',
    )
    for (const address of [
      'a'.repeat(101),
      '10.1.2.3\r\nx-mason-forwarded-for: 9',
      5,
    ])
      assert.throws(
        () => asForwardRequest({ ...request, address }),
        /Invalid address/,
      )
  })

  it('U18.11 a push that fails refuses the change and leaves the live rows; one applied after a push that fails is NotApplied', async () => {
    const before = secrets.list(manager, 'app').length
    await settings.set(localOperator, 'backup', {
      repository: path.join(dir, 'missing.git'),
    })
    await assert.rejects(
      secrets.add(manager, 'app', { name: 'LOST', kind: 'value', value: 'x' }),
      /Not saved: the backup could not be pushed \(The deploy key was refused/,
    )
    assert.equal(secrets.list(manager, 'app').length, before)
    const refused = audit().at(-1)
    assert.equal(refused.action, 'refused')
    assert.match(refused.detail, /^backup: /)
    assert.match(backups.notice()!, /The last backup failed/)
    await settings.set(localOperator, 'backup', { repository: bare })
    // The banner clears with the next good backup.
    await secrets.add(manager, 'app', {
      name: 'FOUND',
      kind: 'value',
      value: 'x',
    })
    assert.equal(backups.notice(), undefined)
    // The live apply failing after the push (a disk error, here a trigger) is reported, and audited.
    // A temporary trigger lives in this connection only, so the backup's copy takes the row.
    database.db.exec(
      "CREATE TEMP TRIGGER no_more BEFORE INSERT ON project_secrets WHEN NEW.name='BROKEN' BEGIN SELECT RAISE(ABORT,'disk I/O error'); END",
    )
    await assert.rejects(
      secrets.add(manager, 'app', {
        name: 'BROKEN',
        kind: 'value',
        value: 'x',
      }),
      /Pushed to the backup but not saved: disk I\/O error/,
    )
    database.db.exec('DROP TRIGGER temp.no_more')
    assert.equal(
      audit().at(-1).detail,
      'pushed but not applied: disk I/O error',
    )
  })

  it('U18.11 stopping waits for the change in progress, and refuses (and audits) every change queued behind it', async () => {
    const stopping = new Backups({
      master: database,
      dir: path.join(dir, 'master'),
      scratch: path.join(dir, 'master', 'scratch'),
      setting: (): BackupSetting | undefined =>
        settings.value('backup') as BackupSetting | undefined,
      fingerprint: 'mldsa65:test',
      attempts: 1,
    })
    const stopSecrets = new Secrets(database, stopping)
    let release: (() => void) | undefined
    const held = stopping.change(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    while (release == null)
      await new Promise((resolve) => setImmediate(resolve))
    const before = pushes()
    const waiting = stopSecrets.add(manager, 'app', {
      name: 'QUEUED',
      kind: 'value',
      value: '1',
    })
    let stopped = false
    const stop = stopping.stop().then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(stopped, false)
    release()
    await held
    await stop
    await assert.rejects(
      waiting,
      /Not saved: the backup could not be pushed \(the master is stopping\)/,
    )
    assert.deepEqual(
      [audit().at(-1).name, audit().at(-1).action, audit().at(-1).detail],
      ['QUEUED', 'refused', 'backup: the master is stopping'],
    )
    assert.equal(pushes(), before)
    // And after it has stopped.
    await assert.rejects(stopping.backup(), /the master is stopping/)
  })
})

describe('Secret audit addresses', () => {
  it('U18.12 a forwarded request is audited from the host its client reached, and only on the API socket', () => {
    const request = (header?: string): Request =>
      ({
        ip: '::ffff:127.0.0.1',
        socket: {},
        get: (name: string) =>
          name.toLowerCase() === 'x-mason-forwarded-for' ? header : undefined,
      }) as unknown as Request
    assert.equal(
      requestAddress(request('10.1.2.3'), () => true),
      '10.1.2.3 via host',
    )
    assert.equal(
      requestAddress(request(), () => true),
      'via host',
    )
    assert.equal(
      requestAddress(request(''), () => true),
      'via host',
    )
    assert.equal(
      requestAddress(request('10.9.9.9'), () => false),
      '127.0.0.1',
    )
  })
})

describe('A master stopping during a secret change', function () {
  this.timeout(120_000)

  it('U18.11 Master.stop() waits for the change in progress, and the change queued behind it is refused and audited before stop() resolves', async () => {
    const dir = root('secrets-stop-')
    const bare = path.join(dir, 'backup.git')
    git(dir, 'init', '-q', '--bare', bare)
    const c = await cluster(dir)
    try {
      const master = c.master.master!
      master.saveProject(localOperator, 'demo', {
        repository: 'https://github.com/a/demo',
      })
      await master.settings.set(localOperator, 'backup', {
        repository: bare,
        branch: 'backups',
      })
      let release: (() => void) | undefined
      const held = master.backups.change(
        async () =>
          await new Promise<void>((resolve) => {
            release = resolve
          }),
      )
      while (release == null)
        await new Promise((resolve) => setImmediate(resolve))
      const queued = master.secrets.add(
        {
          actor: { role: 'manager', label: 'manager' },
          address: '10.0.0.9',
        },
        'demo',
        { name: 'QUEUED', kind: 'value', value: '1' },
      )
      const audited = (): unknown =>
        master.database.db
          .prepare(
            "SELECT action, detail FROM secret_audit WHERE name='QUEUED'",
          )
          .get()
      const state: { stopped: boolean; audit?: unknown } = { stopped: false }
      const stopping = master.stop().then(() => {
        state.stopped = true
        state.audit = audited()
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(state.stopped, false)
      release()
      await held
      await assert.rejects(
        queued,
        /Not saved: the backup could not be pushed \(the master is stopping\)/,
      )
      await stopping
      // The refusal was audited while the database was still the master's.
      assert.deepEqual(
        { ...(state.audit as object) },
        { action: 'refused', detail: 'backup: the master is stopping' },
      )
    } finally {
      await c.close()
    }
  })
})

describe('Secret variants over the API', function () {
  this.timeout(120_000)
  let c: Cluster
  let manager: string
  let developer: string
  before(async () => {
    const dir = root('secrets-api-')
    const bare = path.join(dir, 'backup.git')
    git(dir, 'init', '-q', '--bare', bare)
    c = await cluster(dir)
    const master = c.master.master!
    master.saveProject(localOperator, 'demo', {
      repository: 'https://github.com/a/demo',
    })
    await master.settings.set(localOperator, 'backup', {
      repository: bare,
      branch: 'backups',
    })
    const admin: Actor = { role: 'admin', label: 'test' }
    manager = master.keys.create(admin, { role: 'manager' }).token
    developer = master.keys.create(admin, { role: 'developer' }).token
  })
  after(async () => {
    await c?.close()
  })

  it('U18.12 adds, reads, edits, replaces, reconfigures and deletes through the routes, with a 5 MiB body limit ahead of the wizard', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7)
    const file = await c.api(
      'POST',
      '/api/v2/projects/demo/secrets',
      { name: 'release.jks', kind: 'file', contents: big.toString('base64') },
      manager,
    )
    assert.equal(file.status, 201, file.text)
    assert.equal(file.json.bytes, big.length)
    // A change answers with the variant, never its contents.
    assert.equal(file.json.contents, undefined)
    assert(file.text.length < 1000)
    const value = await c.api(
      'POST',
      '/api/v2/projects/demo/secrets',
      { name: 'API_TOKEN', kind: 'value', configs: 'develop', value: 'v-1' },
      manager,
    )
    assert.equal(value.status, 201, value.text)
    const huge = await c.api(
      'POST',
      '/api/v2/projects/demo/secrets',
      {
        name: 'huge.bin',
        kind: 'file',
        contents: Buffer.alloc(9 * 1024 * 1024).toString('base64'),
      },
      manager,
    )
    assert.equal(huge.status, 413)
    const list = await c.api(
      'GET',
      '/api/v2/projects/demo/secrets',
      undefined,
      developer,
    )
    assert.equal(list.status, 200)
    assert.deepEqual(
      list.json.map((v: Json) => [v.name, v.configs]),
      [
        ['API_TOKEN', ['develop']],
        ['release.jks', []],
      ],
    )
    assert(!list.text.includes('v-1'))
    const id = value.json.id
    assert.equal(
      (
        await c.api(
          'GET',
          `/api/v2/projects/demo/secrets/${id}`,
          undefined,
          developer,
        )
      ).status,
      403,
    )
    assert.deepEqual(
      (
        await c.api(
          'GET',
          `/api/v2/projects/demo/secrets/${id}`,
          undefined,
          manager,
        )
      ).json,
      { value: 'v-1' },
    )
    assert.equal(
      (
        await c.api(
          'PUT',
          `/api/v2/projects/demo/secrets/${id}`,
          { value: 'v-2' },
          manager,
        )
      ).status,
      200,
    )
    assert.equal(
      (
        await c.api(
          'PUT',
          `/api/v2/projects/demo/secrets/${file.json.id}/file`,
          { contents: b64('{}') },
          manager,
        )
      ).json.text,
      true,
    )
    assert.deepEqual(
      (
        await c.api(
          'PUT',
          `/api/v2/projects/demo/secrets/${id}/configs`,
          { configs: 'develop, maestro' },
          manager,
        )
      ).json.configs,
      ['develop', 'maestro'],
    )
    const overlap = await c.api(
      'POST',
      '/api/v2/projects/demo/secrets',
      { name: 'API_TOKEN', kind: 'value', configs: 'maestro', value: 'x' },
      manager,
    )
    assert.equal(overlap.status, 400)
    assert.match(overlap.json.error, /already has a variant for maestro/)
    assert.equal(
      (
        await c.api(
          'GET',
          '/api/v2/projects/demo/secrets/99999',
          undefined,
          manager,
        )
      ).status,
      404,
    )
    assert.equal(
      (await c.api('GET', '/api/v2/projects/nope/secrets', undefined, manager))
        .status,
      404,
    )
    const audit = await c.api(
      'GET',
      '/api/v2/projects/demo/secrets/audit?limit=50',
      undefined,
      manager,
    )
    assert.deepEqual(audit.json.map((e: Json) => e.action).reverse(), [
      'added',
      'added',
      'refused',
      'viewed',
      'edited',
      'replaced',
      'configs changed',
    ])
    assert.equal(audit.json.at(-1).address, '127.0.0.1')
    assert.equal(
      (
        await c.api(
          'GET',
          '/api/v2/projects/demo/secrets/audit',
          undefined,
          developer,
        )
      ).status,
      403,
    )
    assert.equal(
      (
        await c.api(
          'DELETE',
          `/api/v2/projects/demo/secrets/${id}`,
          undefined,
          manager,
        )
      ).status,
      200,
    )
    // The project's own document lists the variants, without contents.
    const project = await c.api(
      'GET',
      '/api/v2/projects/demo',
      undefined,
      developer,
    )
    assert.deepEqual(
      project.json.secrets.map((v: Json) => v.name),
      ['release.jks'],
    )
    assert.equal(project.json.env, undefined)
  })

  it('U18.12 a change pushed but not applied is a 500', async () => {
    const db = c.master.master!.database.db
    // Temporary: only the live connection has it, so the pushed copy takes the row.
    db.exec(
      "CREATE TEMP TRIGGER no_more BEFORE INSERT ON project_secrets WHEN NEW.name='BROKEN' BEGIN SELECT RAISE(ABORT,'disk I/O error'); END",
    )
    try {
      const broken = await c.api(
        'POST',
        '/api/v2/projects/demo/secrets',
        { name: 'BROKEN', kind: 'value', value: 'x' },
        manager,
      )
      assert.equal(broken.status, 500)
      assert.match(
        broken.json.error,
        /^Pushed to the backup but not saved: disk I\/O error/,
      )
    } finally {
      db.exec('DROP TRIGGER temp.no_more')
    }
  })

  it('U18.12 a failed push is a 502 and no backups is a 409', async () => {
    const master = c.master.master!
    const setting = master.settings.value('backup') as BackupSetting
    await master.settings.set(localOperator, 'backup', {
      repository: path.join(c.root, 'missing.git'),
    })
    const failed = await c.api(
      'POST',
      '/api/v2/projects/demo/secrets',
      { name: 'LOST', kind: 'value', value: 'x' },
      manager,
    )
    assert.equal(failed.status, 502)
    assert.match(
      failed.json.error,
      /^Not saved: the backup could not be pushed \(/,
    )
    await master.settings.set(localOperator, 'backup', {
      repository: setting.repository,
    })
    master.database.db.prepare("DELETE FROM settings WHERE area='backup'").run()
    const unconfigured = await c.api(
      'POST',
      '/api/v2/projects/demo/secrets',
      { name: 'LOST', kind: 'value', value: 'x' },
      manager,
    )
    assert.equal(unconfigured.status, 409)
    assert.match(
      unconfigured.json.error,
      /Configure backups before changing secrets/,
    )
  })
})
