import { asArray, asObject, asString } from 'cleaners'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type Config, noSymlinks, privateDirectory } from './config.js'
import { migrate } from './schema.js'
import {
  asApp,
  asAppInput,
  asBuild,
  asChannel,
  asChannelInput,
  asFileKey,
  asFormat,
  asPublication,
  formats,
  integer,
  type Build,
  type Publication,
  text,
} from './validation.js'

const DAY = 86400000
const asCount = asObject({ total: integer() })
const asReservation = asObject({
  id: asString,
  owner: asString,
  bytes: integer(1),
  created_at: integer(),
  expires_at: integer(),
})
export class Store {
  readonly db: DatabaseSync
  readonly files: string
  readonly incoming: string
  constructor(
    readonly config: Config,
    readonly now: () => number = Date.now,
  ) {
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      noSymlinks(config.database + suffix)
    noSymlinks(config.storage)
    privateDirectory(path.dirname(config.database))
    privateDirectory(config.storage)
    const marker = path.join(config.storage, '.mason-store')
    if (!existsSync(marker)) {
      if (readdirSync(config.storage).length !== 0)
        throw new Error('Storage must be an empty dedicated directory')
      writeFileSync(
        marker,
        JSON.stringify({
          format: 'mason-store-v1',
          database: path.resolve(config.database),
        }),
        {
          flag: 'wx',
          mode: 0o600,
        },
      )
    }
    noSymlinks(marker)
    const markerStat = lstatSync(marker)
    if (!markerStat.isFile() || markerStat.size > 8192)
      throw new Error('Unknown storage format')
    const identity = asObject({ format: asString, database: asString })(
      JSON.parse(readFileSync(marker, 'utf8')),
    )
    if (
      identity.format !== 'mason-store-v1' ||
      identity.database !== path.resolve(config.database)
    )
      throw new Error('Unknown storage format')
    this.files = path.join(config.storage, 'files')
    this.incoming = path.join(config.storage, 'incoming')
    for (const dir of [this.files, this.incoming]) {
      noSymlinks(dir)
      privateDirectory(dir)
    }
    this.db = new DatabaseSync(config.database, {
      timeout: 5000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    })
    chmodSync(config.database, 0o600)
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      migrate(this.db)
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  close(): void {
    this.db.close()
  }
  transaction<T>(body: () => T): T {
    // An inner call joins the transaction already open.
    if (this.db.isTransaction) return body()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = body()
      this.db.exec('COMMIT')
      return out
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  addApp(value: unknown): number {
    const app = asAppInput(value)
    return integer(1)(
      Number(
        this.db
          .prepare(
            'INSERT INTO apps(slug,name,position,enabled) VALUES(?,?,?,?)',
          )
          .run(app.slug, app.name, app.position, Number(app.enabled))
          .lastInsertRowid,
      ),
    )
  }
  addChannel(value: unknown): number {
    const channel = asChannelInput(value)
    if (
      channel.allowedFormats.length === 0 ||
      new Set(channel.allowedFormats).size !== channel.allowedFormats.length ||
      channel.allowedFormats.some(
        (format) => !formats[channel.platform].includes(format),
      )
    )
      throw new Error('Invalid channel formats')
    return integer(1)(
      Number(
        this.db
          .prepare(
            'INSERT INTO channels(app_id,platform,channel_key,formats,enabled) VALUES(?,?,?,?,?)',
          )
          .run(
            channel.appId,
            channel.platform,
            channel.key,
            JSON.stringify(channel.allowedFormats),
            Number(channel.enabled),
          ).lastInsertRowid,
      ),
    )
  }
  /**
   * Which apps an account may see: every enabled app here; a host limits
   * testers to their groups' apps.
   */
  scope: (accountId: number) => ReadonlySet<number> | 'all' = () => 'all'
  visible(accountId: number, appId: number): boolean {
    const scope = this.scope(accountId)
    return scope === 'all' || scope.has(appId)
  }
  apps(): Array<ReturnType<typeof asApp>> {
    return this.db
      .prepare('SELECT * FROM apps WHERE enabled=1 ORDER BY position,id')
      .all()
      .map(asApp)
  }
  channel(id: number): ReturnType<typeof asChannel> {
    const out = asChannel(
      this.db
        .prepare(
          'SELECT c.* FROM channels c JOIN apps a ON a.id=c.app_id WHERE c.id=? AND c.enabled=1 AND a.enabled=1',
        )
        .get(integer(1)(id)),
    )
    asArray(asFormat)(JSON.parse(out.formats))
    return out
  }
  build(id: number): Build | undefined {
    const row = this.db
      .prepare(
        "SELECT b.* FROM builds b JOIN channels c ON c.id=b.channel_id JOIN apps a ON a.id=b.app_id WHERE b.id=? AND b.state='ready' AND b.expires_at>? AND a.enabled=1 AND c.enabled=1",
      )
      .get(integer(1)(id), this.now())
    return row == null ? undefined : this.cleanBuild(row)
  }
  builds(appId: number, branch?: string): Build[] {
    return this.db
      .prepare(
        "SELECT b.* FROM builds b JOIN channels c ON c.id=b.channel_id JOIN apps a ON a.id=b.app_id WHERE b.app_id=? AND (? IS NULL OR b.branch=?) AND b.state='ready' AND b.expires_at>? AND a.enabled=1 AND c.enabled=1 ORDER BY b.published_at DESC,b.id DESC",
      )
      .all(integer(1)(appId), branch ?? null, branch ?? null, this.now())
      .map((row) => this.cleanBuild(row))
  }
  private cleanBuild(row: unknown): Build {
    // SQLite NULL is not a missing optional value in cleaners.
    const raw = asObject({
      deleted_at: (value: unknown): number | undefined =>
        value === null ? undefined : integer()(value),
    })(row)
    const result = asBuild({ ...Object(row), deleted_at: raw.deleted_at })
    JSON.parse(result.custom_fields)
    return result
  }
  reserve(owner: string, bytes: number): string {
    owner = text(256)(owner)
    bytes = integer(1, this.config.packageBytes)(bytes)
    return this.transaction(() => {
      this.db
        .prepare('DELETE FROM reservations WHERE expires_at<=?')
        .run(this.now())
      const held = asCount(
        this.db
          .prepare('SELECT COALESCE(SUM(bytes),0) total FROM reservations')
          .get(),
      ).total
      const used = this.usage()
      const disk = statfsSync(this.config.storage)
      const count = asCount(
        this.db
          .prepare('SELECT COUNT(*) total FROM reservations WHERE owner=?')
          .get(owner),
      ).total
      const global = asCount(
        this.db.prepare('SELECT COUNT(*) total FROM reservations').get(),
      ).total
      if (count >= 2 || global >= 4)
        throw new Error('Upload concurrency exceeded')
      if (
        used + held + bytes > this.config.capacityBytes ||
        disk.bavail * disk.bsize - held - bytes < this.config.freeSpaceBytes
      )
        throw new Error('Storage capacity exceeded')
      const id = randomBytes(16).toString('hex')
      this.db
        .prepare('INSERT INTO reservations VALUES(?,?,?,?,?)')
        .run(id, owner, bytes, this.now(), this.now() + 90 * 60000)
      return id
    })
  }
  incomingPath(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid transfer ID')
    privateDirectory(this.incoming)
    return path.join(this.incoming, id + '.part')
  }
  cancel(id: string): void {
    const file = this.incomingPath(id)
    this.transaction(() => {
      this.remove(file)
      this.db.prepare('DELETE FROM reservations WHERE id=?').run(id)
    })
  }
  publish(
    id: string,
    value: unknown,
    authorize: () => void = () => undefined,
  ): Build {
    const input = asPublication(value)
    // The API bounds publisher metadata at 64 KiB before adding its storage envelope.
    if (input.changelog.length > 65536 || input.customFields.length > 131072)
      throw new Error('Metadata too large')
    const custom = JSON.parse(input.customFields)
    if (custom == null || typeof custom !== 'object' || Array.isArray(custom))
      throw new Error('Invalid custom fields')
    const source = this.incomingPath(id)
    return this.transaction(() => {
      authorize()
      const reservation = asReservation(
        this.db
          .prepare('SELECT * FROM reservations WHERE id=? AND expires_at>?')
          .get(id, this.now()),
      )
      if (input.size > reservation.bytes)
        throw new Error('Package exceeds reservation')
      const channel = this.channel(input.channelId)
      if (
        !asArray(asFormat)(JSON.parse(channel.formats)).includes(input.format)
      )
        throw new Error('Format does not match channel')
      const app = asApp(
        this.db.prepare('SELECT * FROM apps WHERE id=?').get(channel.app_id),
      )
      if (input.bundleId !== app.slug)
        throw new Error('Package does not match app')
      const prior = this.db
        .prepare(
          'SELECT * FROM builds WHERE channel_id=? AND branch=? AND (digest=? OR build_number=?)',
        )
        .all(channel.id, input.branch, input.digest, input.buildNumber)
        .map((row) => this.cleanBuild(row))
      if (prior.length !== 0) {
        const match = prior.find(
          (row) =>
            row.digest === input.digest &&
            row.branch === input.branch &&
            row.build_number === input.buildNumber,
        )
        if (
          match == null ||
          prior.length !== 1 ||
          match.expires_at <= this.now() ||
          match.state !== 'ready'
        )
          throw new Error('Build publication conflict')
        this.remove(source)
        this.db.prepare('DELETE FROM reservations WHERE id=?').run(id)
        return match
      }
      // Hash verification occurs while streaming to this owned immutable stage.
      // Publication only checks its descriptor; it never buffers package bytes.
      noSymlinks(source)
      const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.size !== input.size)
          throw new Error('Invalid staged file')
      } finally {
        closeSync(fd)
      }
      const fileKey = id + '.' + input.format
      const destination = this.filePath(fileKey)
      if (existsSync(destination)) throw new Error('Artifact already exists')
      renameSync(source, destination)
      chmodSync(destination, 0o400)
      const now = this.now()
      const published = this.insert(
        input,
        channel.app_id,
        channel.platform,
        fileKey,
        now,
      )
      this.db.prepare('DELETE FROM reservations WHERE id=?').run(id)
      return published
    })
  }
  private insert(
    input: Publication,
    appId: number,
    platform: string,
    fileKey: string,
    now: number,
  ): Build {
    const result = this.db
      .prepare(
        `INSERT INTO builds(app_id,channel_id,platform,branch,commit_hash,version,build_number,bundle_id,format,digest,size,file_key,published_at,expires_at,state,changelog,source,custom_fields)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?,?)`,
      )
      .run(
        appId,
        input.channelId,
        platform,
        input.branch,
        input.commit,
        input.version,
        input.buildNumber,
        input.bundleId,
        input.format,
        input.digest,
        input.size,
        fileKey,
        now,
        now + this.config.retentionDays * DAY,
        input.changelog,
        input.source,
        input.customFields,
      )
    return this.cleanBuild(
      this.db
        .prepare('SELECT * FROM builds WHERE id=?')
        .get(result.lastInsertRowid),
    )
  }
  filePath(key: string): string {
    asFileKey(key)
    privateDirectory(this.files)
    const file = path.join(this.files, key)
    noSymlinks(file)
    return file
  }
  usage(): number {
    let bytes = 0
    // Reservations account for active transfers at their maximum size. Count
    // all other owned bytes, including leftovers that have not been pruned.
    for (const [dir, staging] of [
      [this.files, false],
      [this.incoming, true],
    ] as const) {
      noSymlinks(dir)
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name)
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('Unexpected storage entry')
        const reserved =
          staging &&
          this.db
            .prepare('SELECT id FROM reservations WHERE id=?')
            .get(name.slice(0, 32)) != null
        if (!reserved) bytes += stat.size
      }
    }
    return integer()(bytes)
  }
  prune(): { builds: number; files: number } {
    return this.transaction(() => {
      const now = this.now()
      const expired = this.db
        .prepare(
          "SELECT * FROM builds WHERE state='deleting' OR state='ready' AND expires_at<=?",
        )
        .all(now)
        .map((row) => this.cleanBuild(row))
      for (const row of expired) {
        this.db
          .prepare("UPDATE builds SET state='deleting' WHERE id=?")
          .run(row.id)
        this.remove(this.filePath(row.file_key))
        this.db
          .prepare("UPDATE builds SET state='deleted',deleted_at=? WHERE id=?")
          .run(now, row.id)
      }
      this.db
        .prepare("DELETE FROM builds WHERE state='deleted' AND deleted_at<=?")
        .run(now - 7 * DAY)
      this.db.prepare('DELETE FROM reservations WHERE expires_at<=?').run(now)
      let removed = 0
      for (const [dir, staging] of [
        [this.files, false],
        [this.incoming, true],
      ] as const) {
        noSymlinks(dir)
        for (const name of readdirSync(dir)) {
          const file = path.join(dir, name)
          const stat = lstatSync(file)
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('Unexpected storage entry')
          if (
            staging
              ? !/^[a-f0-9]{32}\.part$/.test(name)
              : !/^[a-f0-9]{32}\.(ipa|apk|dmg|exe|msi)$/.test(name)
          )
            throw new Error('Unexpected storage file')
          const present = staging
            ? this.db
                .prepare('SELECT id FROM reservations WHERE id=?')
                .get(name.slice(0, 32))
            : this.db
                .prepare(
                  "SELECT id FROM builds WHERE file_key=? AND state!='deleted'",
                )
                .get(name)
          if (present == null && (!staging || stat.mtimeMs <= now - 2 * DAY)) {
            this.remove(file)
            removed++
          }
        }
      }
      return { builds: expired.length, files: removed }
    })
  }
  private remove(file: string): void {
    noSymlinks(file)
    try {
      if (!lstatSync(file).isFile()) throw new Error('Unexpected storage entry')
      unlinkSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
export const digest = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex')
