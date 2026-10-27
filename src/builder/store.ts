import { asPin } from '../node/pinnedFetch.js'
import { DatabaseSync } from 'node:sqlite'
import { isIP } from 'node:net'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { asObject, asString, asOptional } from 'cleaners'
import { noSymlinks, privateDirectory } from '../config.js'
import { integer, oneOf, text } from '../validation.js'
import {
  asDefinition,
  asRequest,
  asBuildSettings,
  commitHash,
  type BuilderConfig,
  type Definition,
  type JobRequest,
} from './config.js'

export const statuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
] as const
export type Status = (typeof statuses)[number]
const nullable =
  <T>(clean: (value: unknown) => T) =>
  (value: unknown): T | undefined =>
    value == null ? undefined : clean(value)
const asRow = asObject({
  id: text(36),
  app: text(160),
  branch: text(200),
  status: oneOf(statuses),
  created: integer(),
  started: nullable(integer()),
  finished: nullable(integer()),
  commit_sha: nullable(text(64)),
  requested_commit: nullable(commitHash),
  automatic: integer(0, 1),
  exit_code: nullable(integer(-2147483648, 2147483647)),
  result: nullable(asString),
  cancel: integer(0, 1),
  definition: asString,
  request: asString,
  quarantine: integer(0, 1),
  cleanup_error: nullable(text(2048)),
  quarantine_reason: nullable(text(2048)),
  client_ip: nullable(text(45)),
})
export type Job = Omit<
  ReturnType<typeof asRow>,
  'definition' | 'request' | 'result'
> & { definition: Definition; request: JobRequest; result?: unknown }
export function publicJob(job: Job): Omit<Job, 'definition' | 'request'> {
  const { definition: _definition, request: _request, ...out } = job
  void _definition
  void _request
  return out
}
export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
export interface AutomaticBranch {
  app: string
  branch: string
  enabled: boolean
  lastSuccessfulCommit?: string
  lastAttemptedCommit?: string
  lastJobId?: string
  lastChecked?: number
  observedCommit?: string
  pollError?: string
  attempts: number
}
export interface AppBuildSettings {
  defaultBranch: string
  automaticBranches: string[]
  branches: AutomaticBranch[]
}
export class BuilderStore {
  readonly db: DatabaseSync
  constructor(readonly config: BuilderConfig) {
    privateDirectory(config.workspace)
    for (const directory of ['logs', 'files', 'executions'])
      privateDirectory(path.join(config.workspace, directory))
    const marker = path.join(config.workspace, '.mason-builder')
    if (!existsSync(marker))
      writeFileSync(marker, '1\n', { flag: 'wx', mode: 0o600 })
    noSymlinks(marker)
    if (readFileSync(marker, 'utf8') !== '1\n')
      throw new Error('Invalid workspace marker')
    const file = path.join(config.workspace, 'builder.sqlite')
    noSymlinks(file)
    this.db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS builder_meta(version INTEGER NOT NULL) STRICT;
      INSERT INTO builder_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM builder_meta);
      CREATE TABLE IF NOT EXISTS builder_apps(slug TEXT PRIMARY KEY, definition TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS builder_keys(id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, app TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL,
        created INTEGER NOT NULL, started INTEGER, finished INTEGER, commit_sha TEXT, exit_code INTEGER, result TEXT,
        cancel INTEGER NOT NULL DEFAULT 0, definition TEXT NOT NULL, request TEXT NOT NULL,
        token TEXT UNIQUE, quarantine INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,created);
      CREATE TABLE IF NOT EXISTS workspaces(identity TEXT PRIMARY KEY, directory TEXT NOT NULL UNIQUE) STRICT;`)
    if (
      asObject({ version: integer() })(
        this.db.prepare('SELECT version FROM builder_meta').get(),
      ).version !== 1
    )
      throw new Error('Unknown builder schema')
    this.transaction(() => {
      const columns = new Set(
        this.db
          .prepare('PRAGMA table_info(jobs)')
          .all()
          .map((row) => row.name),
      )
      for (const column of ['cleanup_error', 'quarantine_reason'])
        if (!columns.has(column))
          this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`)
      if (!columns.has('requested_commit'))
        this.db.exec('ALTER TABLE jobs ADD COLUMN requested_commit TEXT')
      if (!columns.has('automatic'))
        this.db.exec(
          'ALTER TABLE jobs ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0',
        )
      if (!columns.has('client_ip'))
        this.db.exec('ALTER TABLE jobs ADD COLUMN client_ip TEXT')
      if (
        !this.db
          .prepare('PRAGMA table_info(builder_keys)')
          .all()
          .some((row) => row.name === 'admin')
      )
        this.db.exec(
          'ALTER TABLE builder_keys ADD COLUMN admin INTEGER NOT NULL DEFAULT 0',
        )
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS builder_app_settings(
          app TEXT PRIMARY KEY, default_branch TEXT NOT NULL) STRICT;
        INSERT OR IGNORE INTO builder_app_settings SELECT slug,'master' FROM builder_apps;
        CREATE TABLE IF NOT EXISTS automatic_branches(
          app TEXT NOT NULL, branch TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          last_successful_commit TEXT, last_attempted_commit TEXT, last_job_id TEXT,
          last_checked INTEGER, observed_commit TEXT, poll_error TEXT,
          PRIMARY KEY(app,branch)) STRICT;
        CREATE TABLE IF NOT EXISTS automatic_attempts(
          app TEXT NOT NULL, branch TEXT NOT NULL, commit_sha TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, succeeded INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(app,branch,commit_sha)) STRICT;`)
    })
    for (const suffix of ['-wal', '-shm'])
      if (existsSync(file + suffix)) chmodSync(file + suffix, 0o600)
  }
  close(): void {
    this.db.close()
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  importApp(input: unknown): void {
    const app = asDefinition(input)
    this.db
      .prepare(
        'INSERT INTO builder_apps VALUES(?,?) ON CONFLICT(slug) DO UPDATE SET definition=excluded.definition',
      )
      .run(app.slug, JSON.stringify(app))
    this.db
      .prepare("INSERT OR IGNORE INTO builder_app_settings VALUES(?,'master')")
      .run(app.slug)
  }
  /**
   * Adds or replaces an app definition from the admin API. Stored secret
   * values are never returned, so an env entry `{name, keep: true}` or a file
   * entry `{destination, keep: true}` reuses the stored value instead.
   */
  saveApp(slug: string, input: unknown): { created: boolean; app: Definition } {
    return this.transaction(() => {
      const stored = this.apps().find((app) => app.slug === slug)
      if (input == null || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Expected an app definition')
      const body = input as Record<string, unknown>
      if (body.slug !== undefined && body.slug !== slug)
        throw new Error('Slug does not match')
      const kept = <T extends Record<string, unknown>>(
        entries: unknown,
        key: string,
        previous: T[],
      ): unknown =>
        Array.isArray(entries)
          ? entries.map((entry: unknown) => {
              if (
                entry == null ||
                typeof entry !== 'object' ||
                (entry as Record<string, unknown>).keep === undefined
              )
                return entry
              const { keep, ...rest } = entry as Record<string, unknown>
              const old = previous.find((item) => item[key] === rest[key])
              if (keep !== true || old == null)
                throw new Error('No stored value to keep')
              return { ...old, ...rest }
            })
          : entries
      const app = asDefinition({
        ...body,
        slug,
        env: kept(body.env, 'name', stored?.env ?? []),
        files: kept(body.files, 'destination', stored?.files ?? []),
      })
      this.importApp(app)
      return { created: stored == null, app }
    })
  }
  apps(): Definition[] {
    return this.db
      .prepare('SELECT definition FROM builder_apps')
      .all()
      .map((row) =>
        asDefinition(
          JSON.parse(asObject({ definition: asString })(row).definition),
        ),
      )
  }
  /** Admin keys also manage app definitions through /api/admin. */
  key(file: string, admin = false): string {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex')
    noSymlinks(file)
    writeFileSync(file, token + '\n', { flag: 'wx', mode: 0o600 })
    this.db
      .prepare('INSERT INTO builder_keys(id,digest,admin) VALUES(?,?,?)')
      .run(id, hash(token), Number(admin))
    return id
  }
  isAdmin(id: string): boolean {
    return (
      this.db
        .prepare('SELECT id FROM builder_keys WHERE id=? AND admin=1')
        .get(id) != null
    )
  }
  authenticate(token: string): string | undefined {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined
    const row = this.db
      .prepare('SELECT id FROM builder_keys WHERE digest=?')
      .get(hash(token))
    return row == null ? undefined : asObject({ id: text(36) })(row).id
  }
  revoke(id: string): void {
    this.db.prepare('DELETE FROM builder_keys WHERE id=?').run(text(36)(id))
  }
  enqueue(input: unknown, key: string, clientIp?: string): Job {
    return this.transaction(() =>
      this.insertJob(input, key, undefined, false, clientIp),
    )
  }
  enqueuePinned(input: unknown, key: string, commit: string): Job {
    return this.transaction(() =>
      this.insertJob(input, key, commitHash(commit)),
    )
  }
  private insertJob(
    input: unknown,
    key: string,
    requestedCommit?: string,
    automatic = false,
    clientIp?: string,
  ): Job {
    let request = asRequest(input)
    const token =
      request.idempotencyKey == null
        ? null
        : hash(key + ':' + request.idempotencyKey)
    if (token != null) {
      const old = this.db.prepare('SELECT * FROM jobs WHERE token=?').get(token)
      if (old != null) {
        const job = this.clean(old)
        request = asRequest({
          ...request,
          branch: request.branch ?? job.branch,
        })
        if (JSON.stringify(job.request) !== JSON.stringify(request))
          throw new Error('Idempotency conflict')
        return job
      }
    }
    const app = this.apps().find(
      (app) => app.slug === request.app && app.enabled,
    )
    if (!app) throw new Error('Unknown or disabled app')
    const branch = request.branch ?? this.buildSettings(app.slug).defaultBranch
    request = asRequest({
      ...request,
      branch,
    })
    const serialized = JSON.stringify(request)
    const injected = new Set(app.files.map((file) => file.env))
    if (
      request.envVars.some((map) =>
        Object.keys(map).some((name) => injected.has(name)),
      )
    )
      throw new Error('Cannot override an injected file environment variable')
    if (
      request.platforms != null &&
      (request.platforms.length === 0 ||
        new Set(request.platforms).size !== request.platforms.length ||
        request.platforms.some((p) => !app.platforms.includes(p)))
    )
      throw new Error('Unsupported platforms')
    const count = asObject({ n: integer() })(
      this.db
        .prepare(
          "SELECT count(*) n FROM jobs WHERE status IN ('queued','running')",
        )
        .get(),
    ).n
    if (count >= 100) throw new Error('Queue is full')
    const id = randomUUID()
    const address =
      !automatic && clientIp != null && isIP(clientIp) !== 0 ? clientIp : null
    this.db
      .prepare(
        "INSERT INTO jobs(id,app,branch,status,created,definition,request,token,requested_commit,automatic,client_ip) VALUES(?,?,?,'queued',?,?,?,?,?,?,?)",
      )
      .run(
        id,
        request.app,
        branch,
        Date.now(),
        JSON.stringify(app),
        serialized,
        token,
        requestedCommit ?? null,
        Number(automatic),
        address,
      )
    return this.job(id)!
  }
  buildSettings(app: string): AppBuildSettings {
    const row = this.db
      .prepare('SELECT default_branch FROM builder_app_settings WHERE app=?')
      .get(app)
    if (row == null) throw new Error('Unknown app')
    const branches = this.automaticBranches(app)
    return {
      defaultBranch: asObject({ default_branch: asString })(row).default_branch,
      automaticBranches: branches.filter((b) => b.enabled).map((b) => b.branch),
      branches,
    }
  }
  configureBuilds(app: string, input: unknown): void {
    const settings = asBuildSettings(input)
    this.transaction(() => {
      this.buildSettings(app)
      this.db
        .prepare('UPDATE builder_app_settings SET default_branch=? WHERE app=?')
        .run(settings.defaultBranch, app)
      this.db
        .prepare('UPDATE automatic_branches SET enabled=0 WHERE app=?')
        .run(app)
      for (const branch of settings.automaticBranches)
        this.db
          .prepare(
            `INSERT INTO automatic_branches(app,branch) VALUES(?,?)
          ON CONFLICT(app,branch) DO UPDATE SET enabled=1`,
          )
          .run(app, branch)
    })
  }
  automaticBranches(app?: string): AutomaticBranch[] {
    return this.db
      .prepare(
        `SELECT b.*,coalesce(a.attempts,0) attempts
      FROM automatic_branches b LEFT JOIN automatic_attempts a
      ON a.app=b.app AND a.branch=b.branch AND a.commit_sha=b.last_attempted_commit
      WHERE (? IS NULL OR b.app=?) ORDER BY b.app,b.branch`,
      )
      .all(app ?? null, app ?? null)
      .map((value) => {
        const row = asObject({
          app: asString,
          branch: asString,
          enabled: integer(0, 1),
          last_successful_commit: nullable(commitHash),
          last_attempted_commit: nullable(commitHash),
          last_job_id: nullable(text(36)),
          last_checked: nullable(integer()),
          observed_commit: nullable(commitHash),
          poll_error: nullable(asString),
          attempts: integer(0, 3),
        })(value)
        return {
          app: row.app,
          branch: row.branch,
          enabled: row.enabled === 1,
          lastSuccessfulCommit: row.last_successful_commit,
          lastAttemptedCommit: row.last_attempted_commit,
          lastJobId: row.last_job_id,
          lastChecked: row.last_checked,
          observedCommit: row.observed_commit,
          pollError: row.poll_error,
          attempts: row.attempts,
        }
      })
  }
  recordPoll(app: string, branch: string, commit?: string): void {
    this.db
      .prepare(
        `UPDATE automatic_branches SET last_checked=?,observed_commit=?,poll_error=?
      WHERE app=? AND branch=? AND enabled=1`,
      )
      .run(
        Date.now(),
        commit == null ? null : commitHash(commit),
        commit == null ? 'Could not read branch head' : null,
        app,
        branch,
      )
  }
  enqueueAutomatic(
    app: string,
    branch: string,
    commit: string,
  ): Job | undefined {
    commitHash(commit)
    return this.transaction(() => {
      const rule = this.automaticBranches(app).find(
        (r) => r.branch === branch && r.enabled,
      )
      if (rule == null || !this.apps().some((a) => a.slug === app && a.enabled))
        return undefined
      const pending = this.pending()
      if (pending.length >= 100) return undefined
      if (
        pending.some(
          (j) =>
            (j.app === app && j.branch === branch) ||
            (j.quarantine && j.status !== 'running'),
        )
      )
        return undefined
      const attempt = this.db
        .prepare(
          `SELECT attempts,succeeded FROM automatic_attempts
        WHERE app=? AND branch=? AND commit_sha=?`,
        )
        .get(app, branch, commit)
      if (
        attempt != null &&
        (attempt.succeeded === 1 || Number(attempt.attempts) >= 3)
      )
        return undefined
      const job = this.insertJob({ app, branch }, 'automatic', commit, true)
      this.db
        .prepare(
          `INSERT INTO automatic_attempts(app,branch,commit_sha,attempts) VALUES(?,?,?,1)
        ON CONFLICT(app,branch,commit_sha) DO UPDATE SET attempts=attempts+1`,
        )
        .run(app, branch, commit)
      this.db
        .prepare(
          `UPDATE automatic_branches SET last_attempted_commit=?,last_job_id=?
        WHERE app=? AND branch=?`,
        )
        .run(commit, job.id, app, branch)
      return job
    })
  }
  private clean(value: unknown): Job {
    const row = asRow(value)
    return {
      ...row,
      definition: asDefinition(JSON.parse(row.definition)),
      request: asRequest(JSON.parse(row.request)),
      result: row.result == null ? undefined : JSON.parse(row.result),
    }
  }
  job(id: string): Job | undefined {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE id=?')
      .get(text(36)(id))
    return row == null ? undefined : this.clean(row)
  }
  pending(): Job[] {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('queued','running') OR quarantine=1 ORDER BY created,id",
      )
      .all()
      .map((row) => this.clean(row))
  }
  recent(): Job[] {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE status NOT IN ('queued','running') ORDER BY COALESCE(finished,created) DESC,created DESC,id DESC LIMIT 5",
      )
      .all()
      .map((row) => this.clean(row))
  }
  claim(): Job | undefined {
    return this.transaction(() => {
      const pending = this.pending()
      if (pending.some((job) => job.status === 'running' || job.quarantine))
        return undefined
      const job = pending.find((job) => job.status === 'queued')
      if (job == null) return undefined
      this.db
        .prepare(
          "UPDATE jobs SET status='running',started=?,quarantine=1 WHERE id=?",
        )
        .run(Date.now(), job.id)
      return this.job(job.id)
    })
  }
  cancel(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET cancel=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,finished=CASE WHEN status='queued' THEN ? ELSE finished END WHERE id=? AND status IN ('queued','running')",
        )
        .run(Date.now(), id).changes !== 0
    )
  }
  finish(
    id: string,
    status: Status,
    code?: number,
    result?: unknown,
    quarantine = false,
    details: {
      cleanupError?: string
      quarantineReason?: string
    } = {},
  ): void {
    const serialized = result == null ? null : JSON.stringify(result)
    if (serialized != null && serialized.length > 65536)
      throw new Error('Result too large')
    this.transaction(() => {
      this.db
        .prepare(
          'UPDATE jobs SET status=?,finished=?,exit_code=?,result=?,quarantine=?,cleanup_error=?,quarantine_reason=? WHERE id=?',
        )
        .run(
          oneOf(statuses)(status),
          Date.now(),
          code ?? null,
          serialized,
          Number(quarantine),
          details.cleanupError == null
            ? null
            : text(2048)(details.cleanupError),
          !quarantine || details.quarantineReason == null
            ? null
            : text(2048)(details.quarantineReason),
          id,
        )
      const job = this.job(id)
      if (
        status === 'succeeded' &&
        job?.automatic &&
        job.requested_commit != null &&
        job.commit_sha === job.requested_commit
      ) {
        this.db
          .prepare(
            `UPDATE automatic_branches SET last_successful_commit=? WHERE app=? AND branch=?`,
          )
          .run(job.commit_sha!, job.app, job.branch)
        this.db
          .prepare(
            `UPDATE automatic_attempts SET succeeded=1 WHERE app=? AND branch=? AND commit_sha=?`,
          )
          .run(job.app, job.branch, job.commit_sha!)
      }
    })
  }
  releaseQuarantine(id: string): void {
    this.db
      .prepare('UPDATE jobs SET quarantine=0,quarantine_reason=NULL WHERE id=?')
      .run(id)
  }
  commit(id: string, sha: string): void {
    commitHash(sha)
    const job = this.job(id)
    if (job?.requested_commit != null && job.requested_commit !== sha)
      throw new Error('Requested commit changed')
    this.db.prepare('UPDATE jobs SET commit_sha=? WHERE id=?').run(sha, id)
  }
  own(identity: string, directory: string): boolean {
    const row = this.db
      .prepare('SELECT directory FROM workspaces WHERE identity=?')
      .get(identity)
    if (row == null) {
      if (existsSync(directory)) throw new Error('Foreign workspace path')
      this.db
        .prepare('INSERT INTO workspaces VALUES(?,?)')
        .run(identity, directory)
      return false
    }
    if (asObject({ directory: asString })(row).directory !== directory)
      throw new Error('Workspace identity mismatch')
    return true
  }
  prune(): void {
    this.db
      .prepare(
        "DELETE FROM jobs WHERE status NOT IN ('running','queued') AND quarantine=0 AND finished<?",
      )
      .run(Date.now() - 14 * 86400000)
  }
}
export function exclusiveLock(file: string): DatabaseSync {
  noSymlinks(file)
  const db = new DatabaseSync(file)
  chmodSync(file, 0o600)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS mutex(value INTEGER); BEGIN EXCLUSIVE')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
export const asClientConfig = asObject({
  url: text(2048),
  keyFile: text(4096),
  pollMs: asOptional(integer(50, 10000), 1000),
  /** Public-key pin of a master serving its own self-signed certificate. */
  pin: asOptional(asPin),
})
