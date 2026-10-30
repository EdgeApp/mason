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
  BackupFailed,
  Backups,
  formatBackupKey,
  gitMinutes,
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
    // A repository that does not exist refuses the key: recorded at once, not retried.
    await settings.set(localOperator, 'backup', {
      repository: path.join(dir, 'missing.git'),
    })
    const failed = await backups.backup()
    assert.equal(failed.backedUp, false)
    assert.equal(
      database.db
        .prepare('SELECT attempts FROM backup_runs ORDER BY id DESC LIMIT 1')
        .get()!.attempts,
      1,
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

describe('Backups one at a time, carrying changes, and falling back to the GitHub connection', function () {
  this.timeout(120_000)
  const clock = Date.UTC(2026, 9, 1, 12)
  /** Git that runs for real unless `refuse` names a URL or the run, as GitHub would refuse it. */
  type Rule = (args: string[]) => Error | undefined
  const refusal = (): Error =>
    Object.assign(new Error('Command failed: git push'), {
      stderr:
        'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n',
    })
  const setup = async (
    options: {
      repository?: (bare: string) => string
      auth?: 'deployKey' | 'github'
      rule?: Rule
      github?: boolean
      hasGitHub?: boolean
      githubRule?: Rule
    } = {},
  ): Promise<{
    dir: string
    bare: string
    database: MasterDatabase
    backups: Backups
    calls: string[]
    clone: () => string
  }> => {
    const dir = root('backup-change-')
    const bare = path.join(dir, 'backup.git')
    git(dir, 'init', '-q', '--bare', bare)
    mkdirSync(path.join(dir, 'master'), { mode: 0o700 })
    const database = new MasterDatabase(
      new DatabaseSync(path.join(dir, 'master', 'master.sqlite')),
      () => clock,
    )
    const settings = new Settings(database)
    const calls: string[] = []
    const githubUrl = `file://${bare}`
    const backups = new Backups({
      master: database,
      dir: path.join(dir, 'master'),
      scratch: path.join(dir, 'master', 'scratch'),
      setting: (): BackupSetting | undefined =>
        settings.value('backup') as BackupSetting | undefined,
      fingerprint: 'mldsa65:test',
      attempts: 2,
      ...(options.github === false
        ? {}
        : {
            github: async (): Promise<{
              url: string
              env: NodeJS.ProcessEnv
            }> => {
              calls.push('github-access')
              return { url: githubUrl, env: { MASON_TEST_ACCESS: 'github' } }
            },
          }),
      hasGitHub: (): boolean => options.hasGitHub ?? true,
      git: async (args, { cwd, env }): Promise<string> => {
        const github = env.MASON_TEST_ACCESS === 'github'
        calls.push(
          `${github ? 'github' : 'key'}:${args.find((arg) => /^(fetch|push|ls-remote)$/.test(arg)) ?? args[args.length - 1]}`,
        )
        const refused = (github ? options.githubRule : options.rule)?.(args)
        if (refused != null) throw refused
        return execFileSync('git', args, {
          cwd,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      },
    })
    settings.register('backup', {
      ...backupArea,
      changed: () => {
        backups.key()
      },
    })
    await settings.set(localOperator, 'backup', {
      repository: options.repository?.(bare) ?? bare,
      branch: 'backups',
      auth: options.auth ?? 'deployKey',
    })
    return {
      dir,
      bare,
      database,
      backups,
      calls,
      clone: (): string => {
        const out = mkdtempSync(path.join(dir, 'clone-'))
        git(out, 'clone', '-q', '--branch', 'backups', bare, 'repo')
        return path.join(out, 'repo')
      },
    }
  }
  const latest = (t: {
    backups: Backups
    clone: () => string
  }): DatabaseSync => {
    const file = path.join(t.clone(), 'restored.sqlite')
    writeFileSync(
      file,
      open(
        parseBackupKey(t.backups.keyText()),
        readFileSync(path.join(path.dirname(file), 'latest.enc')),
      ),
    )
    return new DatabaseSync(file)
  }
  const runs = (database: MasterDatabase): Json[] =>
    database.db
      .prepare('SELECT status,auth,error FROM backup_runs ORDER BY id')
      .all()
      .map((row) => ({ ...row }))

  it('U13.14 backups calls made while one is queued or running share it, and a change waits for the backup before it', async () => {
    const t = await setup()
    const [a, b] = [t.backups.backup(), t.backups.backup()]
    let before: Json[] = []
    const change = t.backups.change(async (push) => {
      // The backup asked for first has finished before the change starts.
      before = runs(t.database).map((run) => run.status)
      await push((db) => db.exec("INSERT INTO meta(key,value) VALUES('x','1')"))
    })
    assert.deepEqual(await a, await b)
    await change
    assert.deepEqual(before, ['succeeded'])
    assert.deepEqual(
      runs(t.database).map((run) => run.status),
      ['succeeded', 'succeeded'],
    )
    // A change holds the queue: a backup asked for meanwhile runs after it.
    const later: string[] = []
    const slow = t.backups.change(async (push) => {
      await push(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 50))
      later.push('change applied')
    })
    const after = t.backups.backup().then(() => later.push('backup'))
    await Promise.all([slow, after])
    assert.deepEqual(later, ['change applied', 'backup'])
  })

  it('U13.14 a change is in the pushed snapshot and not in the live database; a failed push rejects and records the failure', async () => {
    const t = await setup()
    await t.backups.change(async (push) => {
      await push((db) =>
        db.exec("INSERT INTO meta(key,value) VALUES('carried','yes')"),
      )
    })
    const pushed = latest(t)
    assert.equal(
      (
        pushed.prepare("SELECT value FROM meta WHERE key='carried'").get() as {
          value: string
        }
      ).value,
      'yes',
    )
    pushed.close()
    assert.equal(
      t.database.db.prepare("SELECT value FROM meta WHERE key='carried'").get(),
      undefined,
    )
    assert.equal(t.backups.status().lastSuccess!.auth, 'deployKey')
    // A push that fails: the change rejects with git's error, and the run is failed.
    const broken = await setup({
      rule: (args) =>
        args.includes('push') ? new Error('network is down') : undefined,
    })
    let ran = false
    await assert.rejects(
      broken.backups.change(async (push) => {
        await push((db) =>
          db.exec("INSERT INTO meta(key,value) VALUES('lost','yes')"),
        )
        ran = true
      }),
      /network is down/,
    )
    assert.equal(ran, false)
    assert.equal(runs(broken.database).at(-1)!.status, 'failed')
    assert.equal(
      broken.database.db
        .prepare("SELECT value FROM meta WHERE key='lost'")
        .get(),
      undefined,
    )
    // The queue goes on after a failed change.
    assert.equal((await broken.backups.backup()).backedUp, false)
  })

  it('U13.15 a deploy key GitHub refuses falls back to the GitHub connection', async () => {
    const t = await setup({
      repository: () => 'git@github.com:EdgeApp/backup-test.git',
      rule: (args) =>
        args.includes('git@github.com:EdgeApp/backup-test.git')
          ? refusal()
          : undefined,
    })
    const status = await t.backups.backup()
    assert.equal(status.backedUp, true, JSON.stringify(status))
    assert.equal(status.lastSuccess!.auth, 'github')
    assert(t.calls.includes('github-access'))
    assert.equal(git(t.clone(), 'rev-list', '--count', 'HEAD').trim(), '1')
  })

  it('U13.15 the fallback needs a connection and a GitHub repository, and says why when it has neither', async () => {
    const refusing: Rule = (args) =>
      args.some((arg) => /github\.com|gitlab\.com/.test(arg))
        ? refusal()
        : undefined
    const none = await setup({
      repository: () => 'git@github.com:EdgeApp/backup-test.git',
      rule: refusing,
      hasGitHub: false,
    })
    const noConnection = await none.backups.backup()
    assert.match(
      noConnection.lastFailure!.error,
      /^The deploy key was refused \(git@github\.com: Permission denied \(publickey\)\. fatal: Could not read from remote repository\.\), and the master has no GitHub connection$/,
    )
    assert(!none.calls.includes('github-access'))
    const gitlab = await setup({
      repository: () => 'git@gitlab.com:org/backup.git',
      rule: refusing,
    })
    assert.match(
      (await gitlab.backups.backup()).lastFailure!.error,
      /and git@gitlab\.com:org\/backup\.git is not on GitHub$/,
    )
    assert(!gitlab.calls.includes('github-access'))
    // ssh:// is not a form the connection gives credentials to.
    const sshUrl = await setup({
      repository: () => 'ssh://git@github.com/EdgeApp/backup-test.git',
      rule: refusing,
    })
    assert.match(
      (await sshUrl.backups.backup()).lastFailure!.error,
      /is not on GitHub$/,
    )
    // Both refused.
    const both = await setup({
      repository: () => 'git@github.com:EdgeApp/backup-test.git',
      rule: refusing,
      githubRule: (args) => (args.includes('push') ? refusal() : undefined),
    })
    assert.match(
      (await both.backups.backup()).lastFailure!.error,
      /^The deploy key was refused \(.*\); the GitHub connection was refused too \(git@github\.com: Permission denied/,
    )
    // The connection failing some other way says so.
    const flaky = await setup({
      repository: () => 'git@github.com:EdgeApp/backup-test.git',
      rule: refusing,
      githubRule: (args) =>
        args.includes('push') ? new Error('connection reset') : undefined,
    })
    assert.match(
      (await flaky.backups.backup()).lastFailure!.error,
      /the GitHub connection failed \(connection reset\)$/,
    )
  })

  it('U13.15 only a refusal falls back: other failures, a foreign commit and auth github do not try the other credential', async () => {
    const network = await setup({
      repository: () => 'git@github.com:EdgeApp/backup-test.git',
      rule: (args) =>
        args.includes('git@github.com:EdgeApp/backup-test.git')
          ? new Error('Could not resolve host: github.com')
          : undefined,
    })
    assert.match(
      (await network.backups.backup()).lastFailure!.error,
      /^Could not resolve host/,
    )
    assert(!network.calls.includes('github-access'))
    const foreign = await setup()
    await foreign.backups.backup()
    const repo = foreign.clone()
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
    assert.match(
      (await foreign.backups.backup()).lastFailure!.error,
      /did not write/,
    )
    assert(!foreign.calls.includes('github-access'))
    const viaGitHub = await setup({
      auth: 'github',
      repository: () => 'git@github.com:EdgeApp/backup-test.git',
    })
    const status = await viaGitHub.backups.backup()
    assert.equal(status.lastSuccess!.auth, 'github', JSON.stringify(status))
    assert(viaGitHub.calls.every((call) => !call.startsWith('key:')))
  })

  it('U13.15 a host that cannot be reached is not a refusal, and a refused key is not retried', async () => {
    // As execFile reports it: the command line, then git's stderr.
    const unreachable = (): Error => {
      const stderr =
        'ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.\n'
      return Object.assign(new Error(`Command failed: git fetch\n${stderr}`), {
        stderr,
      })
    }
    const offline = await setup({
      repository: () => 'git@github.com:EdgeApp/backup-test.git',
      rule: (args) =>
        args.includes('git@github.com:EdgeApp/backup-test.git')
          ? unreachable()
          : undefined,
    })
    assert.match(
      (await offline.backups.backup()).lastFailure!.error,
      /Connection timed out/,
    )
    assert(!offline.calls.includes('github-access'))
    // Two attempts are allowed, and the unreachable host gets both.
    assert.equal(offline.calls.filter((call) => call === 'key:fetch').length, 2)
    // OpenSSH's other ways of saying the connection dropped.
    for (const dropped of [
      'Connection closed by 140.82.112.3 port 22',
      'Connection to github.com closed by remote host.',
      'client_loop: send disconnect: Broken pipe',
    ]) {
      const t = await setup({
        repository: () => 'git@github.com:EdgeApp/backup-test.git',
        rule: (args) =>
          args.includes('git@github.com:EdgeApp/backup-test.git')
            ? Object.assign(
                new Error(`Command failed: git fetch\n${dropped}`),
                {
                  stderr: `${dropped}\nfatal: Could not read from remote repository.\n`,
                },
              )
            : undefined,
      })
      await t.backups.backup()
      assert(!t.calls.includes('github-access'), dropped)
      assert.equal(t.calls.filter((call) => call === 'key:fetch').length, 2)
    }
    const refused = await setup({
      repository: () => 'git@github.com:EdgeApp/backup-test.git',
      rule: (args) =>
        args.includes('git@github.com:EdgeApp/backup-test.git')
          ? refusal()
          : undefined,
    })
    assert.equal((await refused.backups.backup()).lastSuccess!.auth, 'github')
    assert.equal(refused.calls.filter((call) => call === 'key:fetch').length, 1)
    // A git its timeout killed, as execFile reports it: no stderr, so the
    // reason says it timed out, and it is neither retried nor followed by ls-remote.
    const stalled = await setup({
      repository: () => 'git@github.com:EdgeApp/backup-test.git',
      rule: (args) =>
        args.includes('git@github.com:EdgeApp/backup-test.git')
          ? Object.assign(new Error('Command failed: git -c x=y fetch -q'), {
              killed: true,
              signal: 'SIGKILL',
              stderr: '',
            })
          : undefined,
    })
    assert.equal(
      (await stalled.backups.backup()).lastFailure!.error,
      'git fetch timed out after 60 minutes',
    )
    // Transfers get an hour, local commands ten minutes.
    assert.equal(gitMinutes(['-c', 'a=b', 'fetch', '-q', 'url']), 60)
    assert.equal(gitMinutes(['push', 'url']), 60)
    assert.equal(gitMinutes(['clone', 'url', 'dir']), 60)
    assert.equal(gitMinutes(['ls-remote', '--heads', 'url']), 60)
    assert.equal(gitMinutes(['-c', 'a=b', 'commit', '-qm', 'x']), 10)
    // `git init -q`, then the one fetch.
    assert.deepEqual(
      stalled.calls.filter((call) => call.startsWith('key:')),
      ['key:-q', 'key:fetch'],
    )
    assert(!stalled.calls.includes('github-access'))
    await assert.rejects(
      stalled.backups.change(async (push) => {
        await push(() => undefined)
      }),
      (error: Error) =>
        error instanceof BackupFailed &&
        error.message === 'git fetch timed out after 60 minutes',
    )
  })

  it('U13.14 a plain backup that cannot take its snapshot is recorded as failed', async () => {
    const t = await setup()
    await t.backups.backup()
    const keyFile = path.join(t.dir, 'master', 'backup.key')
    const key = readFileSync(keyFile, 'utf8')
    writeFileSync(keyFile, 'not a key\n')
    try {
      const status = await t.backups.backup()
      assert.equal(status.backedUp, false)
      assert.match(status.lastFailure!.error, /not a Mason backup key/)
      assert.match(t.backups.notice()!, /The last backup failed/)
    } finally {
      writeFileSync(keyFile, key)
    }
  })

  it('U13.15 git runs with the stall limits: ssh keep-alives and a timeout on the deploy key, a low-speed limit on every access', async () => {
    const seen: NodeJS.ProcessEnv[] = []
    const t = await setup({
      rule: () => undefined,
    })
    ;(t.backups as unknown as { options: { git: unknown } }).options.git =
      async (
        args: string[],
        options: { cwd: string; env: NodeJS.ProcessEnv },
      ): Promise<string> => {
        seen.push(options.env)
        return execFileSync('git', args, {
          cwd: options.cwd,
          env: options.env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      }
    await t.backups.backup()
    const env = seen[0]!
    assert.match(String(env.GIT_SSH_COMMAND), /ConnectTimeout=20/)
    assert.match(String(env.GIT_SSH_COMMAND), /ServerAliveInterval=15/)
    assert.equal(env.GIT_HTTP_LOW_SPEED_LIMIT, '1000')
    assert.equal(env.GIT_HTTP_LOW_SPEED_TIME, '60')
  })

  it('U13.14 a change that fails on the snapshot copy rejects with its own error and records no backup', async () => {
    const t = await setup()
    await assert.rejects(
      t.backups.change(async (push) => {
        await push(() => {
          throw new Error('no such column: nope')
        })
      }),
      (error: Error) =>
        error.message === 'no such column: nope' &&
        error.name !== 'BackupFailed',
    )
    assert.deepEqual(runs(t.database), [])
    assert.equal(t.backups.notice(), 'This master is not backed up')
  })

  it('U13.15 with real git: a GitHub URL the deploy key cannot reach falls back to the connection', async () => {
    const dir = root('backup-real-')
    const bare = path.join(dir, 'backup.git')
    git(dir, 'init', '-q', '--bare', bare)
    const home = path.join(dir, 'home')
    mkdirSync(home)
    // The deploy key's git reaches a repository that does not exist, as GitHub answers a key it refuses.
    writeFileSync(
      path.join(home, '.gitconfig'),
      `[url "file://${path.join(dir, 'missing.git')}"]\n\tinsteadOf = git@github.com:EdgeApp/backup-test.git\n`,
    )
    mkdirSync(path.join(dir, 'master'), { mode: 0o700 })
    const database = new MasterDatabase(
      new DatabaseSync(path.join(dir, 'master', 'master.sqlite')),
      () => clock,
    )
    const settings = new Settings(database)
    const backups = new Backups({
      master: database,
      dir: path.join(dir, 'master'),
      scratch: path.join(dir, 'master', 'scratch'),
      setting: (): BackupSetting | undefined =>
        settings.value('backup') as BackupSetting | undefined,
      fingerprint: 'mldsa65:test',
      attempts: 1,
      github: async (): Promise<{ url: string; env: NodeJS.ProcessEnv }> => ({
        url: `file://${bare}`,
        env: {},
      }),
      hasGitHub: (): boolean => true,
    })
    settings.register('backup', {
      ...backupArea,
      changed: () => {
        backups.key()
      },
    })
    await settings.set(localOperator, 'backup', {
      repository: 'git@github.com:EdgeApp/backup-test.git',
      branch: 'backups',
    })
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      const status = await backups.backup()
      assert.equal(status.backedUp, true, JSON.stringify(status))
      assert.equal(status.lastSuccess!.auth, 'github')
    } finally {
      process.env.HOME = saved
    }
    assert.match(
      git(dir, '--git-dir', bare, 'log', '--format=%s', 'backups'),
      /^Mason backup /,
    )
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
    const manager = master.keys.create(localOperator, {
      role: 'manager',
    }).token
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

  it('U13.15 the running master offers the GitHub fallback only once a GitHub connection is saved', async () => {
    const master = c.master.master!
    const { hasGitHub } = (
      master.backups as unknown as { options: { hasGitHub: () => boolean } }
    ).options
    assert.equal(hasGitHub(), false)
    // Stored as the settings API stores a checked connection.
    master.database.db
      .prepare(
        "INSERT INTO settings(area,value,updated_at,updated_by) VALUES('github',?,0,'test')",
      )
      .run(JSON.stringify({ kind: 'token', token: 'ghp_fixture' }))
    assert.equal(hasGitHub(), true)
    master.database.db.prepare("DELETE FROM settings WHERE area='github'").run()
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
