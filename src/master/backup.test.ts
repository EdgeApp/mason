import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'mocha'
import { nodeMain, type MainIO } from '../node/main.js'
import { startNode } from '../node/serve.js'
import { cluster, type Cluster } from '../test/cluster.js'
import {
  applyPendingRestore,
  backupArea,
  Backups,
  formatBackupKey,
  open,
  parseBackupKey,
  PENDING_RESTORE,
  restoreBackup,
  seal,
  type BackupSetting,
} from './backup.js'
import { MasterDatabase } from './database.js'
import { localOperator } from './roles.js'
import { Settings } from './settings.js'

// API responses are read field by field in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const DAY = 24 * 60 * 60 * 1000
const root = (name: string): string =>
  mkdtempSync(path.join(realpathSync(process.env.MASON_TEST_ROOT!), name))
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  })
const io = (): MainIO & { lines: string[] } => {
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

describe('Encrypted git backups', function () {
  this.timeout(120_000)
  let dir: string
  let bare: string
  let clock = Date.UTC(2026, 9, 1, 12)
  let database: MasterDatabase
  let settings: Settings
  let backups: Backups
  before(async () => {
    dir = root('backup-')
    bare = path.join(dir, 'backup.git')
    git(dir, 'init', '-q', '--bare', bare)
    mkdirSync(path.join(dir, 'master'), { mode: 0o700 })
    database = new MasterDatabase(
      new DatabaseSync(path.join(dir, 'master', 'master.sqlite')),
      () => clock,
    )
    settings = new Settings(database)
    backups = new Backups({
      master: database,
      dir: path.join(dir, 'master'),
      scratch: path.join(dir, 'master', 'scratch'),
      setting: (): BackupSetting | undefined =>
        settings.value('backup') as BackupSetting | undefined,
      fingerprint: 'mldsa65:test',
      attempts: 2,
    })
    settings.register('backup', {
      ...backupArea,
      changed: () => {
        backups.key()
      },
    })
    database.db
      .prepare(
        "INSERT INTO accounts(name,username,password,role,created_at) VALUES('Ann Backup-Marker-7f3a9c','ann','{}','admin',0)",
      )
      .run()
  })
  const clone = (): string => {
    const out = mkdtempSync(path.join(dir, 'clone-'))
    git(out, 'clone', '-q', '--branch', 'backups', bare, 'repo')
    return path.join(out, 'repo')
  }

  it('U13.7/U13.10 is not backed up until configured; the setting makes a deploy key and a backup key', async () => {
    assert.equal(backups.notice(), 'This master is not backed up')
    await assert.rejects(backups.backup(), /not configured/)
    assert.equal(backups.needsConfirmation(1), false)
    await assert.rejects(
      settings.set(localOperator, 'backup', { repository: 'not a url' }),
      /git URL/,
    )
    await assert.rejects(
      settings.set(localOperator, 'backup', {
        repository: bare,
        branch: '../x',
      }),
      /branch name/,
    )
    await assert.rejects(
      settings.set(localOperator, 'backup', {
        repository: bare,
        auth: 'magic',
      }),
      /deployKey or github/,
    )
    const shown = await settings.set(localOperator, 'backup', {
      repository: bare,
      branch: 'backups',
    })
    assert.match(String(shown.deployKey), /^ssh-ed25519 /)
    assert.doesNotMatch(JSON.stringify(shown), /PRIVATE KEY/)
    const stored = settings.value('backup') as BackupSetting
    assert.match(stored.deployKey!.privateKey, /PRIVATE KEY/)
    // The deploy key is kept when the setting changes again.
    await settings.set(localOperator, 'backup', { branch: 'backups' })
    assert.equal(
      (settings.value('backup') as BackupSetting).deployKey!.publicKey,
      stored.deployKey!.publicKey,
    )
    const keyFile = path.join(dir, 'master', 'backup.key')
    assert.equal(statSync(keyFile).mode & 0o777, 0o600)
    assert.match(backups.keyText(), /^mason-backup-key-v1:/)
    assert.equal(backups.needsConfirmation(1), true)
    backups.confirm(1)
    assert.equal(backups.needsConfirmation(1), false)
  })

  it('U13.7 commits an encrypted snapshot, a new commit within the month and one orphan commit each month', async () => {
    const first = await backups.backup()
    assert.equal(first.backedUp, true, JSON.stringify(first))
    assert.equal(first.lastSuccess!.kind, 'orphan')
    assert.equal(backups.notice(), undefined)
    let repo = clone()
    const sealed = readFileSync(path.join(repo, 'latest.enc'))
    assert(!sealed.includes(Buffer.from('SQLite format 3')))
    assert(!sealed.includes(Buffer.from('Backup-Marker-7f3a9c')))
    const plain = open(parseBackupKey(backups.keyText()), sealed)
    assert.equal(plain.subarray(0, 15).toString(), 'SQLite format 3')
    assert.deepEqual(readdirSync(path.join(repo, 'daily')), ['2026-10-01.enc'])
    // No plaintext stays behind.
    assert.deepEqual(readdirSync(path.join(dir, 'master', 'scratch')), [])
    clock += DAY
    const second = await backups.backup()
    assert.equal(second.lastSuccess!.kind, 'commit')
    repo = clone()
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '2')
    assert.deepEqual(readdirSync(path.join(repo, 'daily')).sort(), [
      '2026-10-01.enc',
      '2026-10-02.enc',
    ])
    // A month later: one orphan commit, and daily files older than 30 days go.
    clock = Date.UTC(2026, 10, 5, 12)
    const third = await backups.backup()
    assert.equal(third.lastSuccess!.kind, 'orphan')
    repo = clone()
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '1')
    assert.deepEqual(readdirSync(path.join(repo, 'daily')), ['2026-11-05.enc'])
  })

  it('U13.7 refuses a branch holding a commit it did not write, and retries a failed push', async () => {
    const repo = clone()
    writeFileSync(path.join(repo, 'note.txt'), 'someone else')
    git(repo, 'add', '.')
    git(
      repo,
      '-c',
      'user.name=Someone',
      '-c',
      'user.email=someone@example.test',
      'commit',
      '-qm',
      'Not a backup',
    )
    git(repo, 'push', '-q', 'origin', 'backups')
    const refused = await backups.backup()
    assert.equal(refused.backedUp, false)
    assert.match(refused.lastFailure!.error, /did not write/)
    assert.match(backups.notice()!, /The last backup failed: .*did not write/)
    const attempts = database.db
      .prepare('SELECT attempts FROM backup_runs ORDER BY id DESC LIMIT 1')
      .get()!.attempts
    assert.equal(attempts, 1)
    // An unreachable repository is retried, then the failure is recorded.
    await settings.set(localOperator, 'backup', {
      repository: path.join(dir, 'missing.git'),
    })
    const failed = await backups.backup()
    assert.equal(failed.backedUp, false)
    assert.equal(
      database.db
        .prepare('SELECT attempts FROM backup_runs ORDER BY id DESC LIMIT 1')
        .get()!.attempts,
      2,
    )
    await settings.set(localOperator, 'backup', { repository: bare })
    // A GitHub-connection backup needs that connection.
    await settings.set(localOperator, 'backup', { auth: 'github' })
    assert.match(
      (await backups.backup()).lastFailure!.error,
      /no GitHub connection/,
    )
    await settings.set(localOperator, 'backup', { auth: 'deployKey' })
  })

  it('U13.10 reminds weekly while the master is not backed up', () => {
    database.db.prepare("DELETE FROM meta WHERE key='backup_reminded_at'").run()
    assert.match(backups.remind()!, /The last backup failed/)
    assert.equal(backups.remind(), undefined)
    clock += 6 * DAY
    assert.equal(backups.remind(), undefined)
    clock += DAY + 1
    assert.match(backups.remind()!, /The last backup failed/)
  })

  it('U13.9 restores the newest or a dated snapshot with the key; a wrong key or a changed byte fails', async () => {
    database.db.prepare("DELETE FROM meta WHERE key='backup_reminded_at'").run()
    await settings.set(localOperator, 'backup', { repository: bare })
    // Start the branch over so the master writes every commit again.
    git(dir, '--git-dir', bare, 'update-ref', '-d', 'refs/heads/backups')
    clock = Date.UTC(2026, 10, 6, 12)
    assert.equal((await backups.backup()).backedUp, true)
    assert.equal(backups.remind(), undefined)
    const key = backups.keyText()
    const target = path.join(dir, 'restored.sqlite')
    const restored = await restoreBackup({
      repository: bare,
      branch: 'backups',
      key,
      target,
      scratch: path.join(dir, 'restore-scratch'),
    })
    assert.equal(restored.tables.accounts, 1)
    const db = new DatabaseSync(target)
    assert.equal(
      (
        db
          .prepare("SELECT value FROM settings WHERE area='backup'")
          .get() as Json
      ).value.includes(bare),
      true,
    )
    db.close()
    const options = {
      repository: bare,
      branch: 'backups',
      target: path.join(dir, 'other.sqlite'),
      scratch: path.join(dir, 'restore-scratch'),
    }
    await restoreBackup({ ...options, key, date: '2026-11-06' })
    await assert.rejects(
      restoreBackup({ ...options, key, date: '2026-01-01' }),
      /No backup from 2026-01-01/,
    )
    await assert.rejects(
      restoreBackup({ ...options, key, date: 'yesterday' }),
      /YYYY-MM-DD/,
    )
    await assert.rejects(
      restoreBackup({
        ...options,
        key: formatBackupKey(Buffer.alloc(32, 7)),
      }),
      /does not open/,
    )
    await assert.rejects(
      restoreBackup({ ...options, key: 'nope' }),
      /not a Mason backup key/,
    )
    const sealed = seal(Buffer.alloc(32, 1), Buffer.from('plain'))
    sealed[25] = sealed[25]! ^ 1
    assert.throws(() => open(Buffer.alloc(32, 1), sealed), /does not open/)
    assert.throws(
      () => open(Buffer.alloc(32, 1), Buffer.from('short')),
      /Not a Mason backup/,
    )
  })

  it('U13.9 a pending restore replaces only an unconfigured master', () => {
    const target = mkdtempSync(path.join(dir, 'pending-'))
    const lines: string[] = []
    assert.equal(
      applyPendingRestore(target, (line) => lines.push(line)),
      false,
    )
    writeFileSync(path.join(target, PENDING_RESTORE), 'restored')
    const empty = new DatabaseSync(path.join(target, 'master.sqlite'))
    empty.close()
    assert.equal(
      applyPendingRestore(target, (line) => lines.push(line)),
      true,
    )
    assert.equal(
      readFileSync(path.join(target, 'master.sqlite'), 'utf8'),
      'restored',
    )
    // A configured master keeps its data.
    const configured = mkdtempSync(path.join(dir, 'configured-'))
    new MasterDatabase(
      new DatabaseSync(path.join(configured, 'master.sqlite')),
    ).db
      .prepare(
        "INSERT INTO accounts(name,username,password,role,created_at) VALUES('A','a','{}','admin',0)",
      )
      .run()
    writeFileSync(path.join(configured, PENDING_RESTORE), 'restored')
    assert.equal(
      applyPendingRestore(configured, (line) => lines.push(line)),
      false,
    )
    assert(!existsSync(path.join(configured, PENDING_RESTORE)))
    assert.match(lines.join('\n'), /already set up/)
  })
})

describe('Backups on a running master', function () {
  this.timeout(180_000)
  let c: Cluster
  let bare: string
  before(async () => {
    const dir = root('backup-cluster-')
    bare = path.join(dir, 'backup.git')
    git(dir, 'init', '-q', '--bare', bare)
    c = await cluster(dir)
  })
  after(async () => {
    await c?.close()
  })

  it('U13.8/U13.11 the backup settings API shows the key to administrators only and records each confirmation', async () => {
    const master = c.master.master!
    const manager = master.keys.create(localOperator, { role: 'manager' }).token
    const paul = master.people
      .list(localOperator)
      .find((p) => p.username === 'paul')!
    const admin = master.keys.create(
      { role: 'admin', accountId: paul.id, label: `account:${paul.id}` },
      { role: 'admin' },
    ).token
    const saved = await c.api(
      'PUT',
      '/api/v2/settings/backup',
      { repository: bare, branch: 'e2e' },
      admin,
    )
    assert.equal(saved.status, 200, saved.text)
    assert.match(saved.json.backupKey, /^mason-backup-key-v1:/)
    assert.equal(saved.json.keyConfirmed, false)
    assert.match(saved.json.deployKey, /^ssh-ed25519 /)
    const seen = await c.api(
      'GET',
      '/api/v2/settings/backup',
      undefined,
      manager,
    )
    assert.equal(seen.json.backupKey, undefined)
    assert.match(seen.json.deployKey, /^ssh-ed25519 /)
    assert.equal(
      (await c.api('POST', '/api/v2/settings/backup/confirm', {}, manager))
        .status,
      403,
    )
    // A key the local operator made has no account behind it.
    const operator = master.keys.create(localOperator, { role: 'admin' }).token
    assert.equal(
      (await c.api('POST', '/api/v2/settings/backup/confirm', {}, operator))
        .status,
      400,
    )
    assert.deepEqual(
      (await c.api('POST', '/api/v2/settings/backup/confirm', {}, admin)).json,
      { keyConfirmed: true },
    )
    assert.equal(
      (await c.api('GET', '/api/v2/settings/backup', undefined, admin)).json
        .keyConfirmed,
      true,
    )
    // The key never enters the database, so never a backup or the change log.
    const key = master.backups.keyText()
    const dump = master.database.db
      .prepare('SELECT group_concat(value) v FROM settings')
      .get() as { v: string }
    assert(!dump.v.includes(key.split(':')[1]!))
    // Backups run from the API and the CLI.
    const run = await c.api('POST', '/api/v2/backups', {}, manager)
    assert.equal(run.json.backedUp, true, run.text)
    const out = io()
    assert.equal(await nodeMain(['backup', '--data', c.master.dir], out), 0)
    assert.match(out.lines.join('\n'), /Backed up: [0-9a-f]{40}/)
    assert.equal(
      (await c.api('GET', '/api/v2/backups', undefined, manager)).json.backedUp,
      true,
    )
    assert.deepEqual(
      master.notices().filter((line) => /backed up/.test(line)),
      [],
    )
    await master.backupTick()
    // Restore with `mason setup --restore` into a stopped, unconfigured data directory.
    writeFileSync(path.join(c.root, 'backup.key'), key + '\n', { mode: 0o600 })
    const restored = path.join(c.root, 'restored')
    const cli = io()
    assert.equal(
      await nodeMain(
        [
          'setup',
          '--restore',
          '--repository',
          bare,
          '--branch',
          'e2e',
          '--key-file',
          path.join(c.root, 'backup.key'),
          '--data',
          restored,
        ],
        cli,
      ),
      0,
      cli.lines.join('\n'),
    )
    assert.match(
      cli.lines.join('\n'),
      /Restored the master from its latest backup: \d+ accounts/,
    )
    const db = new MasterDatabase(
      new DatabaseSync(path.join(restored, 'master.sqlite')),
    )
    assert.equal(db.configured(), true)
    assert(db.db.prepare("SELECT 1 FROM settings WHERE area='backup'").get())
    db.db.close()
    // A configured master is not restored over, nor a running one.
    const again = io()
    assert.equal(
      await nodeMain(
        [
          'setup',
          '--restore',
          '--repository',
          bare,
          '--branch',
          'e2e',
          '--key-file',
          path.join(c.root, 'backup.key'),
          '--data',
          restored,
        ],
        again,
      ),
      1,
    )
    assert.match(again.lines.join('\n'), /already set up/)
    const running = io()
    assert.equal(
      await nodeMain(
        [
          'setup',
          '--restore',
          '--repository',
          bare,
          '--key-file',
          path.join(c.root, 'backup.key'),
          '--data',
          c.master.dir,
        ],
        running,
      ),
      1,
    )
    assert.match(running.lines.join('\n'), /Stop the master/)
  })

  it('U13.9 restores through the first-run page, which takes effect on the next start', async () => {
    const data = path.join(c.root, 'web-restore')
    let restarted = 0
    const options = {
      role: 'master' as const,
      data,
      port: 0,
      listen: '127.0.0.1',
      heartbeatMs: 0,
      onRestore: (): void => {
        restarted++
      },
    }
    const node = await startNode(options, () => undefined)
    const code = readFileSync(path.join(data, 'setup-code'), 'utf8').trim()
    const post = async (body: unknown): Promise<Response> =>
      await fetch(
        node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:') +
          '/api/setup/restore',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // @ts-expect-error undici's dispatcher option
          dispatcher: (await import('../node/pinnedFetch.js')).pinnedAgent(
            node.web!.certificate!.pin,
          ),
        },
      )
    const key = c.master.master!.backups.keyText()
    try {
      const done = await post({ code, repository: bare, branch: 'e2e', key })
      assert.equal(done.status, 202, await done.clone().text())
      assert.equal(((await done.json()) as Json).restart, true)
      assert.equal(restarted, 1)
      assert(existsSync(path.join(data, PENDING_RESTORE)))
    } finally {
      await node.close()
    }
    const next = await startNode(options, () => undefined)
    try {
      assert.equal(next.master!.configured(), true)
      assert(!existsSync(path.join(data, PENDING_RESTORE)))
    } finally {
      await next.close()
    }
  })
})
