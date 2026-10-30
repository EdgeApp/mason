import { randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import { asObject, asOptional, asString, asUnknown } from 'cleaners'
import {
  checkPublication,
  cleanBuild,
  insertBuild,
  PublicationConflict,
} from '../store.js'
import {
  alreadyPublished,
  asDigest,
  asFileKey,
  asFormat,
  asVariant,
  integer,
  outsideBlock,
  type Build,
  type Format,
} from '../validation.js'
import type { MasterDatabase } from './database.js'

/**
 * The master's deliberate refusal of a publication: the same answer however
 * often it is asked (another file for a published variant, a number outside
 * the block, the wrong app). Any other error is a failure worth retrying.
 */
export class PublicationRefused extends Error {}

/** A staged publication the host confirms, as it arrives over the link. */
const asStagedPayload = asObject({
  reservation: asString,
  variant: asVariant,
  digest: asDigest,
  size: integer(1),
  format: asFormat,
  version: asString,
  buildNumber: asString,
  bundleId: asString,
  fileKey: asFileKey,
  changelog: asOptional(asString),
  metadata: asOptional(asObject(asUnknown)),
  provisioning: asUnknown,
})
export type StagedPayload = ReturnType<typeof asStagedPayload>

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
  /** The run's number for the app, N. */
  buildNumber: string
  /** How many numbers the run holds, N to N+block−1; absent means 1. */
  block?: number
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
  /** The publication's own number, inside the run's block. */
  buildNumber: string
  /** `''` for the default variant. */
  variant: string
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

  /** One reservation per declared app and its enabled platforms, with the run's number and block for it. */
  reserve(
    run: { job: string; stage: string; attempt: number; project: number },
    publishes: string[],
    buildNumbers: Record<string, string>,
    blocks: Record<string, number> = {},
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
        const block = blocks[app] ?? 1
        this.db
          .prepare(
            'INSERT INTO build_reservations(id,job_id,stage,attempt,project_id,app_id,platform,build_number,block,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
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
            block,
            this.now(),
          )
        out.push({
          id,
          app,
          platform: channel.platform,
          buildNumber: number,
          ...(block === 1 ? {} : { block }),
        })
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

  /**
   * A variant of an app and platform is published once per run, from any of
   * its stages or attempts. Another file is refused, and so is the same file
   * under another number; the same file under its build's own number is that
   * build. Undefined while the variant is free, or staged with this file.
   */
  private prior(
    job: string,
    appId: number,
    platform: string,
    publication: { variant: string; digest: string; buildNumber: string },
  ): Build | undefined {
    const row = this.db
      .prepare(
        `SELECT p.digest,p.build_id FROM build_publications p JOIN build_reservations r ON r.id=p.reservation_id
         WHERE r.job_id=? AND r.app_id=? AND r.platform=? AND p.variant=? ORDER BY p.build_id IS NULL LIMIT 1`,
      )
      .get(job, appId, platform, publication.variant) as
      | { digest: string | null; build_id: number | null }
      | undefined
    const refused = new PublicationRefused(
      alreadyPublished(publication.variant),
    )
    if (row?.digest != null && row.digest !== publication.digest) throw refused
    if (row?.build_id == null) return undefined
    const build = cleanBuild(
      this.db.prepare('SELECT * FROM builds WHERE id=?').get(row.build_id),
    )
    if (build.build_number !== publication.buildNumber) throw refused
    return build
  }

  /** A grant for one publication of a stage: a variant of an app and platform, into its reservation. */
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
      variant?: string
    },
  ): { grant: string; url: string; pin?: string; reservation: string } {
    const variant = asVariant(request.variant)
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
        `SELECT r.id,r.app_id,r.build_number,r.block FROM build_reservations r JOIN apps a ON a.id=r.app_id
         WHERE r.job_id=? AND r.stage=? AND r.attempt=? AND a.slug=? AND r.platform=?`,
      )
      .get(run.job, run.stage, run.attempt, request.app, request.platform) as
      | { id: string; app_id: number; build_number: string; block: number }
      | undefined
    if (row == null)
      throw new Error(
        `This stage has no ${request.platform} reservation for ${request.app}; list it in publishes`,
      )
    const buildNumber = request.buildNumber ?? row.build_number
    const outside = outsideBlock(
      buildNumber,
      row.build_number,
      Number(row.block),
    )
    if (outside != null) throw new Error(outside)
    this.prior(run.job, row.app_id, request.platform, {
      variant,
      digest: request.digest,
      buildNumber,
    })
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
      buildNumber,
      variant,
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
   * A staged upload the host checked: a `builds` row for one variant of the
   * reservation's app and platform, with the staged file's digest, size,
   * version, number and bundle ID. The same file under its build's own
   * number returns that build. Another file for a variant the run published,
   * the same file under another number, a number outside the run's block, or
   * an app outside the reservation is refused (`PublicationRefused`).
   */
  staged(value: unknown): Build {
    let payload: StagedPayload
    try {
      payload = asStagedPayload(value)
    } catch (error) {
      throw new PublicationRefused(
        `Invalid staged publication: ${(error as Error).message}`,
      )
    }
    return this.publishStaged(payload)
  }

  /**
   * Forgets what a refused confirmation stood for: an offline stage's
   * unconfirmed record of that file (or one from before digests were kept),
   * so the variant is open to the run again and `release` can drop the
   * reservation. Called outside any transaction the refusal rolls back.
   */
  forgetRefused(value: unknown): void {
    let payload: StagedPayload
    try {
      payload = asStagedPayload(value)
    } catch {
      return
    }
    this.db
      .prepare(
        'DELETE FROM build_publications WHERE reservation_id=? AND variant=? AND build_id IS NULL AND (digest=? OR digest IS NULL)',
      )
      .run(payload.reservation, payload.variant, payload.digest)
  }

  private publishStaged(payload: StagedPayload): Build {
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
            block: number
            slug: string
            branch: string
            commit_sha: string
            job_id: string
            stage: string
          }
        | undefined
      if (reservation == null)
        throw new PublicationRefused('Unknown reservation')
      const variant = payload.variant
      const prior = this.prior(
        reservation.job_id,
        reservation.app_id,
        reservation.platform,
        payload,
      )
      if (prior != null) return prior
      const outside = outsideBlock(
        payload.buildNumber,
        reservation.build_number,
        Number(reservation.block),
      )
      if (outside != null) throw new PublicationRefused(outside)
      if (payload.bundleId !== reservation.slug)
        throw new PublicationRefused('The package is not the reservation’s app')
      const channel = this.db
        .prepare('SELECT id FROM channels WHERE app_id=? AND platform=?')
        .get(reservation.app_id, reservation.platform) as
        | { id: number }
        | undefined
      if (channel == null)
        throw new PublicationRefused('The app has no channel for that platform')
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
        variant,
        run: reservation.job_id,
        customFields: JSON.stringify({
          mason: {
            run: reservation.job_id,
            stage: reservation.stage,
            ...(payload.metadata == null ? {} : { metadata: payload.metadata }),
          },
        }),
      }
      const now = this.now()
      // The store's refusals (format, app, another build of this file or
      // number on the branch) are final; any other error is a failure.
      let existing
      try {
        existing = checkPublication(this.db, input, now)
      } catch (error) {
        if (error instanceof PublicationConflict)
          throw new PublicationRefused(error.message)
        throw error
      }
      const build =
        existing ??
        insertBuild(this.db, input, payload.fileKey, {
          now,
          retentionDays: this.options.retentionDays(),
        })
      this.db
        .prepare(
          `INSERT INTO build_publications(reservation_id,variant,digest,build_id,staged_at) VALUES(?,?,?,?,?)
           ON CONFLICT(reservation_id,variant) DO UPDATE SET digest=excluded.digest,build_id=excluded.build_id,staged_at=COALESCE(staged_at,excluded.staged_at)`,
        )
        .run(reservation.id, variant, payload.digest, build.id, now)
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
      throw new PublicationRefused(
        'The provisioning profile does not match the build',
      )
    this.db
      .prepare(
        'INSERT INTO build_provisioning(build_id,devices,expires_at,team) VALUES(?,?,?,?) ON CONFLICT(build_id) DO UPDATE SET devices=excluded.devices,expires_at=excluded.expires_at,team=excluded.team',
      )
      .run(build.id, JSON.stringify(p.devices), Number(p.expiresAt), p.team)
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

  /**
   * Files that left Mason with their storage location: the builds and saved
   * artifacts stored in them are gone, on the master and, through the change
   * log, on the host. A saved artifact's files live under
   * `runs/<run>/<name>/`.
   */
  forgetFiles(keys: string[]): { builds: number; artifacts: number } {
    let builds = 0
    let artifacts = 0
    const runs = new Set<string>()
    const now = this.now()
    this.options.master.transaction(() => {
      for (const key of keys) {
        const build = this.db
          .prepare(
            "SELECT id FROM builds WHERE file_key=? AND state<>'deleted'",
          )
          .get(key) as { id: number } | undefined
        if (build != null) {
          this.db
            .prepare(
              "UPDATE builds SET state='deleted',deleted_at=? WHERE id=?",
            )
            .run(now, build.id)
          this.options.master.change('build', build.id, 'delete')
          builds++
        }
        const match = /^runs\/([^/]+)\/([^/]+)\//.exec(key)
        const owners = this.db
          .prepare(
            'SELECT job_id,name FROM run_artifacts WHERE storage_key=? OR (job_id=? AND name=?)',
          )
          .all(key, match?.[1] ?? '', match?.[2] ?? '') as Array<{
          job_id: string
          name: string
        }>
        for (const owner of owners) {
          this.db
            .prepare('DELETE FROM run_artifacts WHERE job_id=? AND name=?')
            .run(owner.job_id, owner.name)
          runs.add(owner.job_id)
          artifacts++
        }
      }
      for (const run of runs) this.options.master.change('job', run)
    })
    return { builds, artifacts }
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
   * A stage's journal says the host staged a file for one variant of this
   * reservation while the master was away: it is recorded with its digest,
   * so the run's other files for that variant are refused, and the
   * reservation stays for the host's confirmation, which can arrive after
   * the run ends (a refused one forgets the record).
   */
  markStaged(
    job: string,
    reservation: string,
    variant: unknown = '',
    digest?: string,
  ): void {
    const name = asVariant(variant)
    this.db
      .prepare(
        `INSERT INTO build_publications(reservation_id,variant,digest,staged_at)
         SELECT id,?,?,? FROM build_reservations WHERE id=? AND job_id=?
         ON CONFLICT(reservation_id,variant) DO NOTHING`,
      )
      .run(name, digest ?? null, this.now(), reservation, job)
  }

  /** Reservations of a finished run that published nothing; staged ones wait for the host. */
  release(job: string): void {
    this.db
      .prepare(
        `DELETE FROM build_reservations WHERE job_id=?
         AND NOT EXISTS (SELECT 1 FROM build_publications p WHERE p.reservation_id=build_reservations.id)`,
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
