import {
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  type ReadStream,
} from 'node:fs'
import path from 'node:path'
import type { Stream } from '../link/link.js'
import type { MasterDatabase } from './database.js'

/** Stashes of one job together stay under 2 GiB. */
export const STASH_LIMIT = 2 * 1024 * 1024 * 1024

export const stashName = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)
  )
    throw new Error('Invalid stash name')
  return value
}

export interface StashRecord {
  name: string
  stage: string
  size: number
}

/** Stashes a job's stages hand each other: tarballs in `<data>/stashes/<job>/`. */
export class Stashes {
  constructor(
    readonly master: MasterDatabase,
    readonly root: string,
    readonly limit = STASH_LIMIT,
  ) {}

  private dir(job: string): string {
    return path.join(this.root, job)
  }

  list(job: string): StashRecord[] {
    return this.master.db
      .prepare(
        "SELECT name,stage,size FROM stashes WHERE job_id=? AND file<>'' ORDER BY created,name",
      )
      .all(job)
      .map((row) => ({
        name: String(row.name),
        stage: String(row.stage),
        size: Number(row.size),
      }))
  }

  used(job: string): number {
    return Number(
      (
        this.master.db
          .prepare('SELECT COALESCE(SUM(size),0) n FROM stashes WHERE job_id=?')
          .get(job) as { n: number }
      ).n,
    )
  }

  /** Receives a stash over a link stream, refusing it past the job's limit; a stash of the same name is replaced. */
  async put(
    job: string,
    stage: string,
    nameValue: unknown,
    stream: Stream,
  ): Promise<number> {
    const name = stashName(nameValue)
    const dir = this.dir(job)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = path.join(
      dir,
      `.${name}.${process.pid}.${Date.now()}.part`,
    )
    const file = path.join(dir, `${name}.tar`)
    const previous =
      this.list(job).find((entry) => entry.name === name)?.size ?? 0
    const room = this.limit - (this.used(job) - previous)
    const out = createWriteStream(temporary, { mode: 0o600 })
    // Writes still queued when a refused stash is discarded fail harmlessly.
    out.on('error', () => undefined)
    let size = 0
    try {
      await new Promise<void>((resolve, reject) => {
        let refused = false
        stream.on('data', (chunk: Buffer) => {
          if (refused) return
          size += chunk.length
          if (size > room) {
            refused = true
            const message = `The run’s stashes are over ${Math.round(this.limit / 1024 / 1024)} MiB`
            stream.abort(message)
            reject(new Error(message))
            return
          }
          out.write(chunk)
        })
        stream.once('end', () => {
          out.end(() => {
            resolve()
          })
        })
        stream.once('abort', (reason: string) => {
          reject(new Error(reason))
        })
      })
      renameSync(temporary, file)
    } catch (error) {
      out.destroy()
      rmSync(temporary, { force: true })
      throw error
    }
    this.master.db
      .prepare(
        'INSERT INTO stashes(job_id,name,stage,size,file,created) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id,name) DO UPDATE SET stage=excluded.stage,size=excluded.size,file=excluded.file,created=excluded.created',
      )
      .run(job, name, stage, size, file, this.master.now())
    return size
  }

  open(job: string, nameValue: unknown): ReadStream | undefined {
    const name = stashName(nameValue)
    const row = this.master.db
      .prepare('SELECT file FROM stashes WHERE job_id=? AND name=?')
      .get(job, name)
    if (row == null || String(row.file) === '' || !existsSync(String(row.file)))
      return undefined
    return createReadStream(String(row.file))
  }

  /** Gives a restarted run the stashes of the stages it reuses, without copying their bytes. */
  share(from: string, to: string, stages: string[]): void {
    const dir = this.dir(to)
    for (const row of this.master.db
      .prepare("SELECT * FROM stashes WHERE job_id=? AND file<>''")
      .all(from)) {
      if (!stages.includes(String(row.stage)) || !existsSync(String(row.file)))
        continue
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, `${String(row.name)}.tar`)
      rmSync(file, { force: true })
      linkSync(String(row.file), file)
      this.master.db
        .prepare(
          'INSERT OR REPLACE INTO stashes(job_id,name,stage,size,file,created) VALUES(?,?,?,?,?,?)',
        )
        .run(
          to,
          String(row.name),
          String(row.stage),
          Number(row.size),
          file,
          this.master.now(),
        )
    }
  }

  /** Whether every stash the given stages made is still kept. */
  kept(job: string, stages: string[]): boolean {
    return this.master.db
      .prepare('SELECT file,stage FROM stashes WHERE job_id=?')
      .all(job)
      .every(
        (row) =>
          !stages.includes(String(row.stage)) ||
          (String(row.file) !== '' && existsSync(String(row.file))),
      )
  }

  /** Deletes a job's stash files; their records stay, so a restart can tell they expired. */
  remove(job: string): void {
    this.master.db.prepare("UPDATE stashes SET file='' WHERE job_id=?").run(job)
    rmSync(this.dir(job), { recursive: true, force: true })
  }
}
