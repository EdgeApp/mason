import { execFile } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { privateDirectory } from '../config.js'
import { restoreIdentity } from './identity.js'
import type { MasterDatabase } from './database.js'
import { generateSshKey, githubRepositoryName, gitReason } from './github.js'
import { MASTER_SCHEMA } from './schema.js'
import type { SettingsArea, SettingValue } from './settings.js'

const run = promisify(execFile)
const MAGIC = Buffer.from('MASONBK1')
const AAD = Buffer.from('mason-backup-v1')
const KEY_PREFIX = 'mason-backup-key-v1:'
const DAY = 24 * 60 * 60 * 1000
/** Daily snapshots older than this are deleted in the next commit. */
export const DAILY_DAYS = 30
const WEEK = 7 * DAY

/** The `backup` setting: where snapshots go and the deploy key that pushes them. */
export interface BackupSetting extends SettingValue {
  repository: string
  branch: string
  /** `deployKey`: the master's generated SSH key; `github`: its GitHub connection. */
  auth: 'deployKey' | 'github'
  deployKey?: { privateKey: string; publicKey: string }
}

/** A git URL: SSH, HTTPS or (for tests) a local path or `file://`. */
function asRepository(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 500 ||
    /[\s\0]/.test(value) ||
    value.startsWith('-') ||
    !(
      /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(value) ||
      /^(ssh|https):\/\/[^\s]+$/.test(value) ||
      /^file:\/\/\//.test(value) ||
      path.isAbsolute(value)
    )
  )
    throw new Error(
      'backup.repository is a git URL such as git@github.com:owner/repo.git',
    )
  return value
}
function asBranch(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) ||
    value.includes('..') ||
    value.endsWith('/') ||
    value.endsWith('.lock')
  )
    throw new Error('backup.branch is a branch name')
  return value
}

/** The `backup` settings area; the deploy key is made the first time and is write-only. */
export const backupArea: SettingsArea = {
  validate: (input, previous) => {
    const value = (input ?? {}) as Record<string, unknown>
    const stored = previous as BackupSetting | undefined
    const auth = value.auth ?? stored?.auth ?? 'deployKey'
    if (auth !== 'deployKey' && auth !== 'github')
      throw new Error('backup.auth is deployKey or github')
    return {
      repository: asRepository(value.repository ?? stored?.repository),
      branch: asBranch(value.branch ?? stored?.branch ?? 'master'),
      auth,
      ...(auth === 'deployKey'
        ? { deployKey: stored?.deployKey ?? generateSshKey() }
        : {}),
    } satisfies BackupSetting
  },
  secrets: [],
  redact: (value) => {
    const setting = value as BackupSetting
    const { deployKey, ...rest } = setting
    return {
      ...rest,
      ...(deployKey == null ? {} : { deployKey: deployKey.publicKey }),
    }
  },
}

/** Encrypts a snapshot under the backup key: magic, nonce, ciphertext, tag. */
export function seal(key: Buffer, plain: Buffer): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(AAD)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()])
}
/** Decrypts a snapshot; a wrong key or a changed byte fails authentication. */
export function open(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < MAGIC.length + 28 || !sealed.subarray(0, 8).equals(MAGIC))
    throw new Error('Not a Mason backup')
  const nonce = sealed.subarray(8, 20)
  const tag = sealed.subarray(sealed.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(20, sealed.length - 16)),
      decipher.final(),
    ])
  } catch {
    throw new Error('The backup key does not open this backup')
  }
}

/** Reads a backup key as an administrator stores it. */
export function parseBackupKey(text: string): Buffer {
  const value = text.trim()
  const raw = value.startsWith(KEY_PREFIX) ? value.slice(KEY_PREFIX.length) : ''
  const key = Buffer.from(raw, 'base64url')
  if (key.length !== 32 || key.toString('base64url') !== raw)
    throw new Error('That is not a Mason backup key')
  return key
}
export const formatBackupKey = (key: Buffer): string =>
  KEY_PREFIX + key.toString('base64url')

const dayOf = (time: number): string =>
  new Date(time).toISOString().slice(0, 10)
const monthOf = (time: number): string =>
  new Date(time).toISOString().slice(0, 7)

/** Git with the repository's credentials. */
type Git = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<string>
/** A git run its timeout killed; execFile's own error names only the command. */
class GitTimedOut extends Error {
  override name = 'GitTimedOut'
}
const gitVerb = (args: string[]): string =>
  args.find((arg) => /^[a-z][a-z-]*$/.test(arg)) ?? ''
/**
 * Minutes a git run may take. A transfer grows with the backups (a new
 * backup repository fetches the month's history), and its stalls are caught
 * by ssh keep-alives and the HTTP low-speed limit, so it gets an hour; the
 * rest are local and get ten minutes. Either way a run that hangs cannot
 * hold the backup queue, and every secret change in it, for good.
 */
export const gitMinutes = (args: string[]): number =>
  ['fetch', 'push', 'clone', 'ls-remote'].includes(gitVerb(args)) ? 60 : 10
/** `git`, with a run its timeout killed reported as timed out. */
const timed =
  (git: Git): Git =>
  async (args, options) => {
    try {
      return await git(args, options)
    } catch (error) {
      if ((error as { killed?: unknown }).killed !== true) throw error
      throw new GitTimedOut(
        `git ${gitVerb(args)} timed out after ${gitMinutes(args)} minutes`,
      )
    }
  }
const realGit: Git = async (args, options) =>
  (
    await run('git', args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: gitMinutes(args) * 60 * 1000,
      killSignal: 'SIGKILL',
    })
  ).stdout

export interface BackupStatus {
  configured: boolean
  /** Whether the latest backup succeeded. */
  backedUp: boolean
  /** `auth` is what pushed it: the deploy key or the GitHub connection. */
  lastSuccess?: {
    at: number
    commit: string
    kind: string
    auth?: 'deployKey' | 'github'
  }
  lastFailure?: { at: number; error: string }
}

/** A change a backup carries: applied to the snapshot copy before it is sealed. */
export type BackupMutation = (db: DatabaseSync) => void

/**
 * Whether the remote refused this credential, so the next one may be
 * tried, as opposed to a failure on the way there. git ends an ssh failure
 * of either kind with "Could not read from remote repository", so a host
 * that could not be reached is never taken for a refusal.
 */
function refusedByRemote(error: unknown): boolean {
  const text = `${(error as Error)?.message ?? ''}\n${String((error as { stderr?: unknown })?.stderr ?? '')}`
  if (
    /Could not resolve host|Connection timed out|Operation timed out|Network is unreachable|Connection refused|No route to host|Connection reset|Connection closed by|closed by remote host|Connection to \S+ closed|Broken pipe|kex_exchange_identification/i.test(
      text,
    )
  )
    return false
  return /Permission denied|denied to|Repository not found|Could not read from remote repository|Authentication failed|returned error: 40[13]|Write access/i.test(
    text,
  )
}

/** A backup carrying a change that was not pushed; its message is git's reason. */
export class BackupFailed extends Error {}

/** A change that failed on the snapshot copy, before anything was pushed. */
class MutationFailed extends Error {
  constructor(override readonly cause: unknown) {
    super('The change failed on the snapshot copy')
  }
}

/**
 * The hourly encrypted backup: a `VACUUM INTO` snapshot sealed with
 * AES-256-GCM under the backup key, committed as `latest.enc` and
 * `daily/YYYY-MM-DD.enc` to the backup repository and pushed. The first
 * backup of each month replaces the branch with one orphan commit and
 * force-pushes it, refusing when the branch holds a commit the master did
 * not write. The plaintext never stays on disk and the key never leaves
 * the data directory.
 */
export class Backups {
  /** Every backup and every change waits here for the one before it. */
  private queue: Promise<unknown> = Promise.resolve()
  /** A plain backup queued or running, which later `backup()` calls share. */
  private shared: Promise<BackupStatus> | undefined
  /** Set by `stop`: every backup from then on is refused. */
  private stopping = false
  constructor(
    private readonly options: {
      master: MasterDatabase
      /** The data directory: the backup key and the repository clone. */
      dir: string
      /** A private scratch directory for snapshots and key files. */
      scratch: string
      setting: () => BackupSetting | undefined
      /** The master's identity in its commits. */
      fingerprint: string
      /** Git access through the GitHub connection, for `auth: 'github'` and when the deploy key is refused. */
      github?: (repository: string) => Promise<{
        url: string
        env: NodeJS.ProcessEnv
      }>
      /** Whether the master has a GitHub connection; without one a refused deploy key has no fallback. */
      hasGitHub?: () => boolean
      git?: Git
      /** Push attempts with each credential (the deploy key, then the GitHub connection) before it is given up. */
      attempts?: number
    },
  ) {}
  private get db(): MasterDatabase['db'] {
    return this.options.master.db
  }
  private now(): number {
    return this.options.master.now()
  }
  private get keyFile(): string {
    return path.join(this.options.dir, 'backup.key')
  }
  private get email(): string {
    return `master+${createHash('sha256').update(this.options.fingerprint).digest('hex').slice(0, 16)}@mason.invalid`
  }

  /** The backup key, made the first time backups are configured. */
  key(): Buffer {
    if (!existsSync(this.keyFile))
      writeFileSync(this.keyFile, formatBackupKey(randomBytes(32)) + '\n', {
        mode: 0o600,
        flag: 'wx',
      })
    return parseBackupKey(readFileSync(this.keyFile, 'utf8'))
  }
  keyText(): string {
    return formatBackupKey(this.key())
  }
  /** The digest an administrator's confirmation is recorded against. */
  keyDigest(): string {
    return createHash('sha256').update(this.key()).digest('hex')
  }

  /** Records that an administrator stored the current key. */
  confirm(accountId: number): void {
    this.db
      .prepare(
        'INSERT INTO backup_confirmations(account_id,key_digest,confirmed_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET key_digest=excluded.key_digest,confirmed_at=excluded.confirmed_at',
      )
      .run(accountId, this.keyDigest(), this.now())
  }
  /** Whether an administrator still has to confirm they stored the key. */
  needsConfirmation(accountId: number): boolean {
    if (this.options.setting() == null) return false
    const row = this.db
      .prepare('SELECT key_digest FROM backup_confirmations WHERE account_id=?')
      .get(accountId) as { key_digest: string } | undefined
    return row?.key_digest !== this.keyDigest()
  }

  status(): BackupStatus {
    const success = this.db
      .prepare(
        "SELECT finished_at,commit_sha,kind,auth FROM backup_runs WHERE status='succeeded' ORDER BY id DESC LIMIT 1",
      )
      .get() as
      | {
          finished_at: number
          commit_sha: string
          kind: string
          auth: string | null
        }
      | undefined
    const failure = this.db
      .prepare(
        "SELECT finished_at,error FROM backup_runs WHERE status='failed' ORDER BY id DESC LIMIT 1",
      )
      .get() as { finished_at: number; error: string } | undefined
    const latest = this.db
      .prepare(
        "SELECT status FROM backup_runs WHERE status!='running' ORDER BY id DESC LIMIT 1",
      )
      .get() as { status: string } | undefined
    return {
      configured: this.options.setting() != null,
      backedUp:
        this.options.setting() != null && latest?.status === 'succeeded',
      ...(success == null
        ? {}
        : {
            lastSuccess: {
              at: success.finished_at,
              commit: success.commit_sha,
              kind: success.kind,
              ...(success.auth === 'deployKey' || success.auth === 'github'
                ? { auth: success.auth }
                : {}),
            },
          }),
      ...(failure == null
        ? {}
        : { lastFailure: { at: failure.finished_at, error: failure.error } }),
    }
  }

  /** What `mason status` and the master's pages say about backups. */
  notice(): string | undefined {
    const status = this.status()
    if (status.backedUp) return undefined
    if (status.lastFailure != null && status.configured)
      return `The last backup failed: ${status.lastFailure.error}`
    return 'This master is not backed up'
  }

  /**
   * The weekly reminder while the master is not backed up; returns the
   * reminder when one is due and records it.
   */
  remind(): string | undefined {
    const notice = this.notice()
    if (notice == null) return undefined
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key='backup_reminded_at'")
      .get() as { value: string } | undefined
    if (row != null && Number(row.value) > this.now() - WEEK) return undefined
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES('backup_reminded_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(this.now()))
    return notice
  }

  /**
   * Refuses every backup from now on, so a change still queued is refused
   * rather than pushed, and resolves once the queue is empty: the database
   * stays open until the change in progress is applied.
   */
  async stop(): Promise<void> {
    this.stopping = true
    for (let tail = this.queue; ; tail = this.queue) {
      await tail
      if (tail === this.queue) return
    }
  }

  /** Runs `work` once everything queued before it has finished. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }

  /** Takes, encrypts, commits and pushes a backup; one at a time, after any change in progress. */
  async backup(): Promise<BackupStatus> {
    this.shared ??= this.exclusive(async () => {
      await this.once()
      return this.status()
    }).finally(() => {
      this.shared = undefined
    })
    return await this.shared
  }

  /**
   * Runs `work` with the queue to itself: no backup and no other change
   * starts until it settles. `push(mutate)` backs up the database with
   * `mutate` applied to the snapshot copy only, and rejects when that
   * backup is not pushed; the live database is `work`'s to change after.
   */
  async change<T>(
    work: (push: (mutate: BackupMutation) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return await this.exclusive(
      async () =>
        await work(async (mutate) => {
          const error = await this.once(mutate)
          if (error != null) throw new BackupFailed(gitReason(error))
        }),
    )
  }

  /**
   * One backup, recorded in `backup_runs`; resolves with why it failed, if
   * it did. When the master is stopping it throws `BackupFailed`, recording
   * nothing, so a change is refused as one whose backup was not pushed. When
   * backups are not configured, or `mutate` fails on the snapshot copy, it
   * throws that error itself, recording nothing: neither is a failed backup.
   */
  private async once(mutate?: BackupMutation): Promise<Error | undefined> {
    if (this.stopping) throw new BackupFailed('the master is stopping')
    const setting = this.options.setting()
    if (setting == null) throw new Error('Backups are not configured')
    privateDirectory(this.options.scratch)
    const work = mkdtempSync(path.join(this.options.scratch, 'backup-'))
    const id = Number(
      this.db
        .prepare(
          "INSERT INTO backup_runs(started_at,status) VALUES(?,'running')",
        )
        .run(this.now()).lastInsertRowid,
    )
    let attempts = 0
    let failure: Error | undefined
    try {
      const sealed = this.snapshot(work, mutate)
      const pushed = await this.pushSealed(
        setting,
        work,
        sealed,
        () => attempts++,
      )
      this.db
        .prepare(
          "UPDATE backup_runs SET status='succeeded',finished_at=?,kind=?,commit_sha=?,attempts=?,auth=? WHERE id=?",
        )
        .run(this.now(), pushed.kind, pushed.commit, attempts, pushed.auth, id)
    } catch (error) {
      // The change failed on the copy: not a failed backup, so no run is kept.
      if (error instanceof MutationFailed) {
        this.db.prepare('DELETE FROM backup_runs WHERE id=?').run(id)
        throw error.cause
      }
      failure = error as Error
      this.db
        .prepare(
          "UPDATE backup_runs SET status='failed',finished_at=?,error=?,attempts=? WHERE id=?",
        )
        .run(
          this.now(),
          String(failure.message).slice(0, 1000),
          Math.max(attempts, 1),
          id,
        )
    } finally {
      rmSync(work, { recursive: true, force: true })
      // Runs beyond the last hundred are not kept.
      this.db
        .prepare(
          'DELETE FROM backup_runs WHERE id <= (SELECT MAX(id) - 100 FROM backup_runs)',
        )
        .run()
    }
    return failure
  }

  /**
   * Commits and pushes with the deploy key, falling back to the GitHub
   * connection when GitHub refuses the key; or with the connection alone.
   */
  private async pushSealed(
    setting: BackupSetting,
    work: string,
    sealed: Buffer,
    attempt: () => void,
  ): Promise<{ kind: string; commit: string; auth: 'deployKey' | 'github' }> {
    const withAccess = async (access: {
      url: string
      env: NodeJS.ProcessEnv
    }): Promise<{ kind: string; commit: string }> => {
      const tries = this.options.attempts ?? 3
      for (let tried = 1; ; tried++) {
        attempt()
        try {
          return await this.commit(setting, access.url, access.env, sealed)
        } catch (error) {
          // A refused credential is not retried: the next one is tried at once.
          // Nor is a timeout, which held the queue for its whole limit already.
          if (
            tried >= tries ||
            (error as Error).name === 'ForeignCommit' ||
            error instanceof GitTimedOut ||
            refusedByRemote(error)
          )
            throw error
        }
      }
    }
    if (setting.auth === 'github')
      return {
        ...(await withAccess(await this.githubAccess(setting))),
        auth: 'github',
      }
    try {
      return {
        ...(await withAccess(this.deployKeyAccess(setting, work))),
        auth: 'deployKey',
      }
    } catch (error) {
      if (!refusedByRemote(error)) throw error
      const first = gitReason(error)
      if (this.options.hasGitHub?.() !== true)
        throw new Error(
          `The deploy key was refused (${first}), and the master has no GitHub connection`,
        )
      if (githubRepositoryName(setting.repository) == null)
        throw new Error(
          `The deploy key was refused (${first}), and ${setting.repository} is not on GitHub`,
        )
      try {
        return {
          ...(await withAccess(await this.githubAccess(setting))),
          auth: 'github',
        }
      } catch (fallback) {
        if ((fallback as Error).name === 'ForeignCommit') throw fallback
        throw new Error(
          refusedByRemote(fallback)
            ? `The deploy key was refused (${first}); the GitHub connection was refused too (${gitReason(fallback)})`
            : `The deploy key was refused (${first}); the GitHub connection failed (${gitReason(fallback)})`,
        )
      }
    }
  }

  /** A consistent snapshot, with `mutate` applied to the copy, sealed; the plaintext file is removed at once. */
  private snapshot(work: string, mutate?: BackupMutation): Buffer {
    const file = path.join(work, 'snapshot.sqlite')
    this.db.prepare('VACUUM INTO ?').run(file)
    try {
      if (mutate != null) {
        const copy = new DatabaseSync(file)
        try {
          copy.exec('BEGIN')
          try {
            mutate(copy)
          } catch (error) {
            throw new MutationFailed(error)
          }
          copy.exec('COMMIT')
        } finally {
          copy.close()
        }
      }
      return seal(this.key(), readFileSync(file))
    } finally {
      rmSync(file, { force: true })
    }
  }

  private gitBase(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      // An HTTPS transfer slower than 1 KB/s for a minute is given up.
      GIT_HTTP_LOW_SPEED_LIMIT: '1000',
      GIT_HTTP_LOW_SPEED_TIME: '60',
    }
  }

  private async githubAccess(
    setting: BackupSetting,
  ): Promise<{ url: string; env: NodeJS.ProcessEnv }> {
    if (this.options.github == null)
      throw new Error('The master has no GitHub connection')
    const access = await this.options.github(setting.repository)
    return { url: access.url, env: { ...this.gitBase(), ...access.env } }
  }

  private deployKeyAccess(
    setting: BackupSetting,
    work: string,
  ): { url: string; env: NodeJS.ProcessEnv } {
    const keyFile = path.join(work, 'deploy_key')
    writeFileSync(keyFile, setting.deployKey!.privateKey, { mode: 0o600 })
    const knownHosts = path.join(this.options.dir, 'backup_known_hosts')
    return {
      url: setting.repository,
      env: {
        ...this.gitBase(),
        GIT_SSH_COMMAND: `ssh -i '${keyFile}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='${knownHosts}' -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4`,
      },
    }
  }

  private async commit(
    setting: BackupSetting,
    url: string,
    env: NodeJS.ProcessEnv,
    sealed: Buffer,
  ): Promise<{ kind: string; commit: string }> {
    const git = timed(this.options.git ?? realGit)
    const repo = path.join(this.options.dir, 'backup-repo')
    if (!existsSync(path.join(repo, '.git'))) {
      rmSync(repo, { recursive: true, force: true })
      mkdirSync(repo, { recursive: true, mode: 0o700 })
      await git(['init', '-q'], { cwd: repo, env })
    }
    const g = async (...args: string[]): Promise<string> =>
      await git(
        [
          '-c',
          'user.name=Mason master',
          '-c',
          `user.email=${this.email}`,
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: repo, env },
      )
    let remote: string | undefined
    try {
      await g(
        'fetch',
        '-q',
        '--no-tags',
        url,
        `+refs/heads/${setting.branch}:refs/remotes/backup/head`,
      )
      remote = (await g('rev-parse', 'refs/remotes/backup/head')).trim()
    } catch (error) {
      if (error instanceof GitTimedOut) throw error
      // A branch that does not exist yet starts with the first backup.
      const listed = await g('ls-remote', '--heads', url, setting.branch)
      if (listed.trim() !== '') throw error
    }
    if (remote != null) {
      const authors = (await g('log', '--format=%ae', remote))
        .split('\n')
        .filter((line) => line !== '')
      if (authors.some((author) => author !== this.email)) {
        const error = new Error(
          'The backup branch has a commit the master did not write; refusing to replace it',
        )
        error.name = 'ForeignCommit'
        throw error
      }
    }
    const lastMonth =
      remote == null
        ? undefined
        : monthOf(
            Number((await g('log', '-1', '--format=%ct', remote)).trim()) *
              1000,
          )
    const orphan = remote == null || lastMonth !== monthOf(this.now())
    // Start from the branch's files, or none.
    await g('checkout', '-q', '--orphan', 'mason-backup-work')
    await g('rm', '-rqf', '--ignore-unmatch', '.')
    if (remote != null) await g('checkout', '-q', remote, '--', '.')
    const daily = path.join(repo, 'daily')
    mkdirSync(daily, { recursive: true })
    const today = dayOf(this.now())
    writeFileSync(path.join(repo, 'latest.enc'), sealed)
    writeFileSync(path.join(daily, `${today}.enc`), sealed)
    const oldest = dayOf(this.now() - DAILY_DAYS * DAY)
    for (const name of readdirSync(daily))
      if (/^\d{4}-\d{2}-\d{2}\.enc$/.test(name) && name.slice(0, 10) < oldest)
        rmSync(path.join(daily, name))
    await g('add', '-A', '.')
    const message = `Mason backup ${new Date(this.now()).toISOString()}`
    const tree = (await g('write-tree')).trim()
    const commit = (
      orphan
        ? await g('commit-tree', tree, '-m', message)
        : await g('commit-tree', tree, '-p', remote!, '-m', message)
    ).trim()
    await g(
      'push',
      '-q',
      ...(orphan && remote != null ? ['--force'] : []),
      url,
      `${commit}:refs/heads/${setting.branch}`,
    )
    return { kind: orphan ? 'orphan' : 'commit', commit }
  }
}

/**
 * Rebuilds a master database from its backup: clones the branch, opens
 * `latest.enc` or the dated daily snapshot with the key, checks the
 * database, and writes it to `target`.
 */
export async function restoreBackup(options: {
  repository: string
  branch?: string
  key: string
  date?: string
  target: string
  scratch: string
  env?: NodeJS.ProcessEnv
  git?: Git
}): Promise<{ file: string; tables: Record<string, number> }> {
  const key = parseBackupKey(options.key)
  const repository = asRepository(options.repository)
  const branch = asBranch(options.branch ?? 'master')
  if (options.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(options.date))
    throw new Error('The date is YYYY-MM-DD')
  const git = timed(options.git ?? realGit)
  privateDirectory(options.scratch)
  const work = mkdtempSync(path.join(options.scratch, 'restore-'))
  try {
    const env = options.env ?? {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_TERMINAL_PROMPT: '0',
    }
    await git(
      [
        'clone',
        '-q',
        '--depth',
        '1',
        '--branch',
        branch,
        '--',
        repository,
        'repo',
      ],
      { cwd: work, env },
    )
    const name =
      options.date == null
        ? 'latest.enc'
        : path.join('daily', `${options.date}.enc`)
    const sealedFile = path.join(work, 'repo', name)
    if (!existsSync(sealedFile))
      throw new Error(
        options.date == null
          ? 'The backup branch has no latest.enc'
          : `No backup from ${options.date}`,
      )
    const plain = open(key, readFileSync(sealedFile))
    const restored = path.join(work, 'restored.sqlite')
    writeFileSync(restored, plain, { mode: 0o600 })
    plain.fill(0)
    const db = new DatabaseSync(restored)
    const tables: Record<string, number> = {}
    try {
      const check = db.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string
      }
      if (check.integrity_check !== 'ok')
        throw new Error('The restored database is damaged')
      const schema = db
        .prepare("SELECT value FROM meta WHERE key='master_schema'")
        .get() as { value: string } | undefined
      if (schema == null) throw new Error('Not a Mason master database')
      if (Number(schema.value) > MASTER_SCHEMA)
        throw new Error('The backup is from a newer Mason version')
      for (const table of [
        'accounts',
        'projects',
        'apps',
        'builds',
        'api_keys',
      ])
        tables[table] = Number(
          (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number })
            .n,
        )
      // Sessions belong to the master that made them.
      db.exec('DELETE FROM master_sessions; DELETE FROM sign_in_failures')
    } finally {
      db.close()
    }
    renameSync(restored, options.target)
    return { file: options.target, tables }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Where a restore from the first-run page waits for the next start. */
export const PENDING_RESTORE = 'restore.sqlite'

/**
 * Swaps a pending restore in before the master opens its database, when
 * the database it replaces has no account yet; a configured master keeps
 * its data and the pending file is set aside.
 */
export function applyPendingRestore(
  dir: string,
  log: (line: string) => void = console.log,
): boolean {
  const pending = path.join(dir, PENDING_RESTORE)
  if (!existsSync(pending)) return false
  const current = path.join(dir, 'master.sqlite')
  if (existsSync(current)) {
    const db = new DatabaseSync(current, { readOnly: true })
    let configured = false
    try {
      configured =
        db
          .prepare(
            "SELECT 1 FROM accounts WHERE role='admin' AND password IS NOT NULL AND disabled=0 LIMIT 1",
          )
          .get() != null
    } catch {
      configured = false
    } finally {
      db.close()
    }
    if (configured) {
      renameSync(pending, `${pending}.refused-${Date.now()}`)
      log('A pending restore was set aside: this master is already set up')
      return false
    }
    const aside = `${current}.before-restore-${Date.now()}`
    renameSync(current, aside)
    for (const suffix of ['-wal', '-shm'])
      if (existsSync(current + suffix))
        renameSync(current + suffix, aside + suffix)
  }
  renameSync(pending, current)
  // Nodes accept only the master they paired with: take the backup's identity.
  const restored = restoreIdentity(dir)
  log(
    restored == null
      ? 'Started from the restored backup; it holds no master identity, so nodes pair again'
      : `Started from the restored backup as master ${restored}`,
  )
  return true
}
