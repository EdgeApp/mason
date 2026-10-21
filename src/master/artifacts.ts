import { randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { checkPublication, insertBuild } from '../store.js'
import type { Build, Format } from '../validation.js'
import type { MasterDatabase } from './database.js'

/** The formats each platform publishes. */
export const formatsFor: Record<string, Format[]> = {
  ios: ['ipa'],
  android: ['apk'],
  macos: ['dmg'],
  windows: ['exe', 'msi'],
}

/** Where workers reach the host: its worker origin, and its pin when it serves its own certificate. */
export interface HostAccess {
  origin: string
  pin?: string
}

export interface Reservation {
  id: string
  app: string
  platform: string
  buildNumber: string
}

/** A stage's upload token: its run, its reservations and how much it may upload. */
export interface UploadClaims extends HostAccess {
  kind: 'stage'
  run: string
  stage: string
  attempt: number
  project: number
  reservations: Reservation[]
  bytes: number
  expires: number
}

/** One publication's grant: the file the host may stage into one reservation. */
export interface GrantClaims extends HostAccess {
  kind: 'grant'
  run: string
  reservation: string
  app: string
  platform: string
  format: Format
  digest: string
  size: number
  version: string
  buildNumber: string
  expires: number
}

/** A download of one stored object, for `ctx.artifacts.fetch`. */
export interface DownloadClaims extends HostAccess {
  kind: 'download'
  key: string
  digest: string
  size: number
  expires: number
}

export type Claims = UploadClaims | GrantClaims | DownloadClaims

const PREFIX = 'mason-claims-v1\n'

/** `<base64url JSON>.<base64url ML-DSA signature>`, signed by the master. */
export function signClaims(claims: Claims, key: KeyObject): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${sign(null, Buffer.from(PREFIX + payload), key).toString('base64url')}`
}

export class InvalidClaims extends Error {}

/** Checks a token's signature, kind and expiry. */
export function verifyClaims<T extends Claims>(
  token: unknown,
  key: KeyObject,
  kind: T['kind'],
  now: number,
): T {
  if (typeof token !== 'string' || token.length > 64 * 1024)
    throw new InvalidClaims('No token')
  const [payload, signature] = token.split('.')
  if (payload == null || signature == null)
    throw new InvalidClaims('Malformed token')
  let valid = false
  try {
    valid = verify(
      null,
      Buffer.from(PREFIX + payload),
      key,
      Buffer.from(signature, 'base64url'),
    )
  } catch {
    valid = false
  }
  if (!valid) throw new InvalidClaims('The token’s signature does not verify')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as T
  if (claims.kind !== kind) throw new InvalidClaims(`Not a ${kind} token`)
  if (typeof claims.expires !== 'number' || claims.expires <= now)
    throw new InvalidClaims('The token has expired')
  return claims
}

const DAY = 86_400_000
/** A stage token outlives its stage by a day, for uploads confirmed after a link outage. */
const TOKEN_GRACE = DAY
const GRANT_MS = 2 * 3_600_000
const STAGE_BYTES = 4 * 1024 ** 3

/**
 * Publication and saved artifacts on the master: build reservations made at
 * stage assignment, signed upload tokens and grants, the `builds` rows the
 * host's staged uploads become, saved-artifact and test records, download
 * grants, and expiry through the change log.
 */
export class Artifacts {
  constructor(
    private readonly options: {
      master: MasterDatabase
      privateKey: KeyObject
      /** How workers reach the host; undefined until the host setting is made. */
      host: () => HostAccess | undefined
      retentionDays: () => number
    },
  ) {}

  private get db(): MasterDatabase['db'] {
    return this.options.master.db
  }
  private now(): number {
    return this.options.master.now()
  }

  /** One reservation per declared app and its enabled platforms, with the stage's reserved number. */
  reserve(
    run: { job: string; stage: string; attempt: number; project: number },
    publishes: string[],
    buildNumbers: Record<string, string>,
  ): Reservation[] {
    const out: Reservation[] = []
    for (const app of publishes) {
      const row = this.db
        .prepare('SELECT id FROM apps WHERE slug=?')
        .get(app) as { id: number } | undefined
      const number = buildNumbers[app]
      if (row == null || number == null) continue
      for (const channel of this.db
        .prepare(
          'SELECT platform FROM channels WHERE app_id=? AND enabled=1 ORDER BY platform',
        )
        .all(row.id) as Array<{ platform: string }>) {
        const id = randomBytes(16).toString('hex')
        this.db
          .prepare(
            'INSERT INTO build_reservations(id,job_id,stage,attempt,project_id,app_id,platform,build_number,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            run.job,
            run.stage,
            run.attempt,
            run.project,
            row.id,
            channel.platform,
            number,
            this.now(),
          )
        out.push({ id, app, platform: channel.platform, buildNumber: number })
      }
    }
    return out
  }

  /** The stage's signed upload token, or undefined while no host is configured. */
  uploadToken(
    run: { job: string; stage: string; attempt: number; project: number },
    reservations: Reservation[],
    timeoutSeconds: number,
  ): { token: string; origin: string; pin?: string } | undefined {
    const host = this.options.host()
    if (host == null) return undefined
    const claims: UploadClaims = {
      kind: 'stage',
      run: run.job,
      stage: run.stage,
      attempt: run.attempt,
      project: run.project,
      reservations,
      bytes: STAGE_BYTES,
      expires: this.now() + timeoutSeconds * 1000 + TOKEN_GRACE,
      ...host,
    }
    return { token: signClaims(claims, this.options.privateKey), ...host }
  }

  /** A grant for one publication of a stage, into its unused reservation for that app and platform. */
  grant(
    run: { job: string; stage: string; attempt: number },
    request: {
      app: string
      platform: string
      format: string
      digest: string
      size: number
      version: string
      buildNumber?: string
    },
  ): { grant: string; url: string; pin?: string; reservation: string } {
    const host = this.options.host()
    if (host == null)
      throw new Error('No host is configured: set the host setting')
    const formats = formatsFor[request.platform]
    if (formats == null || !formats.includes(request.format as Format))
      throw new Error(
        `A ${request.platform} build is published as ${formats?.join(' or ') ?? 'nothing'}, not ${request.format}`,
      )
    if (
      !/^[0-9a-f]{64}$/.test(request.digest) ||
      !Number.isSafeInteger(request.size) ||
      request.size <= 0
    )
      throw new Error('A publication needs the file’s SHA-256 and size')
    const row = this.db
      .prepare(
        `SELECT r.id,r.build_number FROM build_reservations r JOIN apps a ON a.id=r.app_id
         WHERE r.job_id=? AND r.stage=? AND r.attempt=? AND a.slug=? AND r.platform=? AND r.build_id IS NULL AND r.staged_at IS NULL`,
      )
      .get(run.job, run.stage, run.attempt, request.app, request.platform) as
      | { id: string; build_number: string }
      | undefined
    if (row == null)
      throw new Error(
        `This stage has no ${request.platform} reservation for ${request.app}; list it in publishes`,
      )
    if (request.buildNumber != null && request.buildNumber !== row.build_number)
      throw new Error(
        `The build number ${request.buildNumber} is not the reserved ${row.build_number}`,
      )
    const claims: GrantClaims = {
      kind: 'grant',
      run: run.job,
      reservation: row.id,
      app: request.app,
      platform: request.platform,
      format: request.format as Format,
      digest: request.digest,
      size: request.size,
      version: request.version,
      buildNumber: row.build_number,
      expires: this.now() + GRANT_MS,
      ...host,
    }
    return {
      grant: signClaims(claims, this.options.privateKey),
      url: `${host.origin}/api/artifacts/${row.id}`,
      reservation: row.id,
      ...(host.pin == null ? {} : { pin: host.pin }),
    }
  }

  /**
   * A staged upload the host checked: the reservation's `builds` row with
   * its reserved build number and the staged file's digest, size, version
   * and bundle ID. A used reservation, a version or build number that
   * differs from it, or an app outside the reservation is refused.
   */
  staged(payload: {
    reservation: string
    digest: string
    size: number
    format: Format
    version: string
    buildNumber: string
    bundleId: string
    fileKey: string
    changelog?: string
    metadata?: Record<string, unknown>
    provisioning?: unknown
  }): Build {
    return this.options.master.transaction(() => {
      const reservation = this.db
        .prepare(
          `SELECT r.*,a.slug,j.branch,j.commit_sha FROM build_reservations r JOIN apps a ON a.id=r.app_id JOIN jobs j ON j.id=r.job_id WHERE r.id=?`,
        )
        .get(payload.reservation) as
        | {
            id: string
            app_id: number
            platform: string
            build_number: string
            build_id: number | null
            slug: string
            branch: string
            commit_sha: string
            job_id: string
            stage: string
          }
        | undefined
      if (reservation == null) throw new Error('Unknown reservation')
      if (reservation.build_id != null) {
        const existing = this.db
          .prepare('SELECT * FROM builds WHERE id=?')
          .get(reservation.build_id)
        const build = existing as unknown as Build
        if (build.digest === payload.digest) return build
        throw new Error('The reservation is already used')
      }
      if (payload.buildNumber !== reservation.build_number)
        throw new Error(
          `The build number ${payload.buildNumber} is not the reserved ${reservation.build_number}`,
        )
      if (payload.bundleId !== reservation.slug)
        throw new Error('The package is not the reservation’s app')
      const channel = this.db
        .prepare('SELECT id FROM channels WHERE app_id=? AND platform=?')
        .get(reservation.app_id, reservation.platform) as
        | { id: number }
        | undefined
      if (channel == null)
        throw new Error('The app has no channel for that platform')
      const input = {
        channelId: channel.id,
        branch: reservation.branch,
        commit: reservation.commit_sha,
        bundleId: payload.bundleId,
        version: payload.version,
        buildNumber: payload.buildNumber,
        format: payload.format,
        size: payload.size,
        digest: payload.digest,
        changelog: payload.changelog ?? '',
        source: 'pipeline',
        customFields: JSON.stringify({
          mason: {
            run: reservation.job_id,
            stage: reservation.stage,
            ...(payload.metadata == null ? {} : { metadata: payload.metadata }),
          },
        }),
      }
      const now = this.now()
      const build =
        checkPublication(this.db, input, now) ??
        insertBuild(this.db, input, payload.fileKey, {
          now,
          retentionDays: this.options.retentionDays(),
        })
      this.db
        .prepare(
          'UPDATE build_reservations SET build_id=?,staged_at=COALESCE(staged_at,?) WHERE id=?',
        )
        .run(build.id, now, reservation.id)
      this.recordProvisioning(build, payload.provisioning)
      this.options.master.change('build', build.id)
      return build
    })
  }

  /** An ad hoc IPA's devices and expiry, as the host read them from its embedded profile. */
  private recordProvisioning(build: Build, value: unknown): void {
    if (value == null) return
    const p = value as {
      devices?: unknown
      expiresAt?: unknown
      team?: unknown
      appId?: unknown
    }
    if (
      !Array.isArray(p.devices) ||
      !p.devices.every(
        (device) =>
          typeof device === 'string' && /^[A-F0-9-]{20,40}$/.test(device),
      ) ||
      !Number.isSafeInteger(p.expiresAt) ||
      typeof p.team !== 'string' ||
      p.appId !== build.bundle_id
    )
      throw new Error('The provisioning profile does not match the build')
    this.db
      .prepare(
        'INSERT INTO build_provisioning(build_id,devices,expires_at,team) VALUES(?,?,?,?) ON CONFLICT(build_id) DO UPDATE SET devices=excluded.devices,expires_at=excluded.expires_at,team=excluded.team',
      )
      .run(build.id, JSON.stringify(p.devices), Number(p.expiresAt), p.team)
  }

  /** A Zealot-API upload the host staged: published like the standalone server, through the master. */
  zealot(payload: {
    channelId: number
    keyId: string
    branch: string
    commit: string
    bundleId: string
    version: string
    buildNumber: string
    format: Format
    size: number
    digest: string
    fileKey: string
    changelog: string
    source: string
    customFields: string
  }): Build {
    return this.options.master.transaction(() => {
      const key = this.db
        .prepare('SELECT apps,revoked,expires_at,role FROM api_keys WHERE id=?')
        .get(payload.keyId) as
        | {
            apps: string
            revoked: number
            expires_at: number | null
            role: string
          }
        | undefined
      const channel = this.db
        .prepare('SELECT app_id FROM channels WHERE id=?')
        .get(payload.channelId) as { app_id: number } | undefined
      if (
        key == null ||
        key.revoked === 1 ||
        (key.expires_at != null && key.expires_at <= this.now()) ||
        channel == null
      )
        throw new Error('Valid token and channel_key must precede the file')
      const scope = JSON.parse(key.apps) as 'all' | number[]
      if (
        !['upload', 'admin'].includes(key.role) ||
        (scope !== 'all' && !scope.includes(channel.app_id))
      )
        throw new Error('Valid token and channel_key must precede the file')
      const { keyId: _key, fileKey, ...input } = payload
      void _key
      const now = this.now()
      const build =
        checkPublication(this.db, input, now) ??
        insertBuild(this.db, input, fileKey, {
          now,
          retentionDays: this.options.retentionDays(),
        })
      this.recordProvisioning(
        build,
        (payload as { provisioning?: unknown }).provisioning,
      )
      this.options.master.change('build', build.id)
      return build
    })
  }

  /** A saved artifact the host stored for a run. */
  saved(payload: {
    run: string
    stage: string
    name: string
    kind: string
    size: number
    digest: string
    visibleTo?: string
    entry?: string
    storageKey: string
  }): void {
    if (
      this.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(payload.run) == null
    )
      throw new Error('Unknown run')
    this.db
      .prepare(
        `INSERT INTO run_artifacts(job_id,stage,name,kind,size,digest,visible_to,entry,storage_key,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(job_id,name) DO UPDATE SET stage=excluded.stage,kind=excluded.kind,size=excluded.size,digest=excluded.digest,
           visible_to=excluded.visible_to,entry=excluded.entry,storage_key=excluded.storage_key,created_at=excluded.created_at,deleting=0`,
      )
      .run(
        payload.run,
        payload.stage,
        payload.name,
        payload.kind,
        payload.size,
        payload.digest,
        payload.visibleTo ?? null,
        payload.entry ?? null,
        payload.storageKey,
        this.now(),
      )
    this.options.master.change('job', payload.run)
  }

  /** The host deleted a build's file or a saved artifact; the record follows. */
  deleted(payload: { build?: number; run?: string; name?: string }): void {
    if (payload.build != null) {
      this.db
        .prepare(
          "UPDATE builds SET state='deleted',deleted_at=? WHERE id=? AND state='deleting'",
        )
        .run(this.now(), payload.build)
      this.options.master.change('build', payload.build, 'delete')
    } else if (payload.run != null && payload.name != null) {
      this.db
        .prepare(
          'DELETE FROM run_artifacts WHERE job_id=? AND name=? AND deleting=1',
        )
        .run(payload.run, payload.name)
      this.options.master.change('job', payload.run)
    }
  }

  /** A stage's parsed test results, kept with the run. */
  tests(
    run: { job: string; stage: string; attempt: number },
    summary: unknown,
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO run_tests(job_id,stage,attempt,summary) VALUES(?,?,?,?)',
      )
      .run(run.job, run.stage, run.attempt, JSON.stringify(summary))
    this.options.master.change('job', run.job)
  }

  /**
   * `ctx.artifacts.fetch`: the latest matching run of the project (or the
   * given commit) that saved the artifact, and a download grant for it.
   */
  query(
    project: number,
    query: {
      workflow?: unknown
      branch?: unknown
      commit?: unknown
      status?: unknown
      name?: unknown
    },
  ): {
    name: string
    grant: string
    url: string
    pin?: string
    digest: string
    size: number
    run: string
  } {
    const host = this.options.host()
    if (host == null)
      throw new Error('No host is configured: set the host setting')
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value !== '' ? value : undefined
    const where = ['j.project_id=?', 'a.name=?', 'a.deleting=0']
    const values: Array<string | number> = [project, String(query.name)]
    if (text(query.workflow) != null) {
      where.push('j.workflow=?')
      values.push(text(query.workflow)!)
    }
    if (text(query.branch) != null) {
      where.push('j.branch=?')
      values.push(text(query.branch)!)
    }
    if (text(query.commit) != null) {
      where.push('j.commit_sha=?')
      values.push(text(query.commit)!)
    }
    if (query.status === 'success') where.push("j.status='succeeded'")
    const row = this.db
      .prepare(
        `SELECT a.*,j.id AS run FROM run_artifacts a JOIN jobs j ON j.id=a.job_id WHERE ${where.join(' AND ')} ORDER BY j.created DESC LIMIT 1`,
      )
      .get(...values) as
      | {
          name: string
          digest: string
          size: number
          storage_key: string
          run: string
        }
      | undefined
    if (row == null) throw new Error(`No run matches ${JSON.stringify(query)}`)
    const claims: DownloadClaims = {
      kind: 'download',
      key: row.storage_key,
      digest: row.digest,
      size: row.size,
      expires: this.now() + GRANT_MS,
      ...host,
    }
    const grant = signClaims(claims, this.options.privateKey)
    return {
      name: row.name,
      run: row.run,
      grant,
      url: `${host.origin}/api/artifacts/download?grant=${encodeURIComponent(grant)}`,
      digest: row.digest,
      size: row.size,
      ...(host.pin == null ? {} : { pin: host.pin }),
    }
  }

  /**
   * A stage's journal says the host staged an upload into this reservation
   * while the master was away: it stays reserved for the host's confirmation,
   * which can arrive after the run ends.
   */
  markStaged(job: string, reservation: string): void {
    this.db
      .prepare(
        'UPDATE build_reservations SET staged_at=? WHERE id=? AND job_id=? AND build_id IS NULL AND staged_at IS NULL',
      )
      .run(this.now(), reservation, job)
  }

  /** Unused reservations of a finished run; staged ones wait for the host. */
  release(job: string): void {
    this.db
      .prepare(
        'DELETE FROM build_reservations WHERE job_id=? AND build_id IS NULL AND staged_at IS NULL',
      )
      .run(job)
  }

  /**
   * The hourly expiry: builds past `expires_at` and saved artifacts past
   * `keep.artifactDays` become `deleting`; the host deletes their files and
   * confirms through its outbox.
   */
  expire(artifactDays: (job: string) => number | undefined): {
    builds: number
    artifacts: number
  } {
    const now = this.now()
    const builds = this.db
      .prepare("SELECT id FROM builds WHERE state='ready' AND expires_at<=?")
      .all(now) as Array<{ id: number }>
    for (const build of builds) {
      this.db
        .prepare("UPDATE builds SET state='deleting' WHERE id=?")
        .run(build.id)
      this.options.master.change('build', build.id)
    }
    let artifacts = 0
    for (const row of this.db
      .prepare(
        'SELECT job_id,name,created_at FROM run_artifacts WHERE deleting=0',
      )
      .all() as Array<{
      job_id: string
      name: string
      created_at: number
    }>) {
      const days = artifactDays(row.job_id)
      if (days == null || row.created_at + days * DAY > now) continue
      this.db
        .prepare(
          'UPDATE run_artifacts SET deleting=1 WHERE job_id=? AND name=?',
        )
        .run(row.job_id, row.name)
      this.options.master.change('job', row.job_id)
      artifacts++
    }
    return { builds: builds.length, artifacts }
  }

  /** A run's saved artifacts and test results, for the runs API. */
  forRun(job: string): { artifacts: unknown[]; tests: unknown[] } {
    return {
      artifacts: (
        this.db
          .prepare(
            'SELECT stage,name,kind,size,digest,visible_to,entry,created_at FROM run_artifacts WHERE job_id=? AND deleting=0 ORDER BY name',
          )
          .all(job) as Array<Record<string, unknown>>
      ).map((row) => ({
        stage: row.stage,
        name: row.name,
        kind: row.kind,
        size: row.size,
        digest: row.digest,
        ...(row.visible_to == null ? {} : { visibleTo: row.visible_to }),
        ...(row.entry == null ? {} : { entry: row.entry }),
        created: row.created_at,
      })),
      tests: (
        this.db
          .prepare(
            'SELECT stage,attempt,summary FROM run_tests WHERE job_id=? ORDER BY stage,attempt',
          )
          .all(job) as Array<{
          stage: string
          attempt: number
          summary: string
        }>
      ).map((row) => ({
        stage: row.stage,
        attempt: row.attempt,
        ...(JSON.parse(row.summary) as object),
      })),
    }
  }
}
