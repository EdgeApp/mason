import type { DatabaseSync } from 'node:sqlite'

/** One record a stage sends the master, in order: a log chunk, a step or the run description. */
export interface Record {
  seq: number
  kind: 'log' | 'step' | 'describe'
  data: string
}

export interface JournalRun {
  key: string
  kind: 'setup' | 'stage'
  /** The assignment, with secrets and files removed. */
  assignment: unknown
  status: 'running' | 'finished' | 'reported'
  result?: unknown
}

const SCHEMA = 1

/**
 * The worker's crash-recovery state in `worker.sqlite`: what it runs, the
 * records not yet acknowledged by the master, stashes waiting to upload,
 * results waiting to be reported, and its quarantine. Secrets are never
 * written here.
 */
export class Journal {
  constructor(readonly db: DatabaseSync) {
    const version = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
    )
    if (version > SCHEMA)
      throw new Error('worker.sqlite belongs to a newer Mason version')
    if (version < 1)
      db.exec(`
        CREATE TABLE runs (
          key TEXT PRIMARY KEY, kind TEXT NOT NULL, assignment TEXT NOT NULL,
          status TEXT NOT NULL, result TEXT, seq INTEGER NOT NULL DEFAULT 0,
          created INTEGER NOT NULL, finished INTEGER
        ) STRICT;
        CREATE TABLE records (
          key TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(key, seq)
        ) STRICT;
        CREATE TABLE uploads (
          key TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL, PRIMARY KEY(key, name)
        ) STRICT;
        CREATE TABLE state (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        PRAGMA user_version = 1;
      `)
  }

  start(key: string, kind: JournalRun['kind'], assignment: unknown): void {
    this.db
      .prepare(
        "INSERT INTO runs(key,kind,assignment,status,created) VALUES(?,?,?,'running',?) ON CONFLICT(key) DO NOTHING",
      )
      .run(key, kind, JSON.stringify(assignment), Date.now())
  }

  get(key: string): JournalRun | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE key=?').get(key)
    return row == null ? undefined : this.view(row)
  }

  private view(row: { [name: string]: unknown }): JournalRun {
    return {
      key: String(row.key),
      kind: row.kind as JournalRun['kind'],
      assignment: JSON.parse(String(row.assignment)) as unknown,
      status: row.status as JournalRun['status'],
      ...(row.result == null
        ? {}
        : { result: JSON.parse(String(row.result)) as unknown }),
    }
  }

  runs(status?: JournalRun['status']): JournalRun[] {
    return (
      status == null
        ? this.db
            .prepare(
              "SELECT * FROM runs WHERE status<>'reported' ORDER BY created",
            )
            .all()
        : this.db
            .prepare('SELECT * FROM runs WHERE status=? ORDER BY created')
            .all(status)
    ).map((row) => this.view(row))
  }

  /** Appends a record and returns its sequence number. */
  append(key: string, kind: Record['kind'], data: string): number {
    const row = this.db
      .prepare('UPDATE runs SET seq=seq+1 WHERE key=? RETURNING seq')
      .get(key) as { seq: number } | undefined
    if (row == null) throw new Error('Unknown run')
    this.db
      .prepare('INSERT INTO records(key,seq,kind,data) VALUES(?,?,?,?)')
      .run(key, row.seq, kind, data)
    return row.seq
  }

  /** Unacknowledged records in order, up to about `bytes` of data. */
  pending(key: string, bytes = 512 * 1024): Record[] {
    const out: Record[] = []
    let size = 0
    for (const row of this.db
      .prepare('SELECT seq,kind,data FROM records WHERE key=? ORDER BY seq')
      .iterate(key)) {
      const record = {
        seq: Number(row.seq),
        kind: row.kind as Record['kind'],
        data: String(row.data),
      }
      if (out.length > 0 && size + record.data.length > bytes) break
      out.push(record)
      size += record.data.length
    }
    return out
  }

  acknowledge(key: string, seq: number): void {
    this.db.prepare('DELETE FROM records WHERE key=? AND seq<=?').run(key, seq)
  }

  finish(key: string, result: unknown): void {
    this.db
      .prepare(
        "UPDATE runs SET status='finished',result=?,finished=? WHERE key=? AND status='running'",
      )
      .run(JSON.stringify(result), Date.now(), key)
  }

  reported(key: string): void {
    this.db.prepare("UPDATE runs SET status='reported' WHERE key=?").run(key)
    this.db.prepare('DELETE FROM records WHERE key=?').run(key)
  }

  /** Forgets reported runs older than a day. */
  prune(now = Date.now()): void {
    this.db
      .prepare("DELETE FROM runs WHERE status='reported' AND finished<?")
      .run(now - 86400000)
  }

  addUpload(key: string, name: string, file: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO uploads(key,name,file) VALUES(?,?,?)')
      .run(key, name, file)
  }
  uploads(key: string): Array<{ name: string; file: string }> {
    return this.db
      .prepare('SELECT name,file FROM uploads WHERE key=? ORDER BY name')
      .all(key)
      .map((row) => ({ name: String(row.name), file: String(row.file) }))
  }
  uploaded(key: string, name: string): void {
    this.db.prepare('DELETE FROM uploads WHERE key=? AND name=?').run(key, name)
  }

  quarantine(): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM state WHERE name='quarantine'")
      .get()
    return row == null ? undefined : String(row.value)
  }
  setQuarantine(reason: string | undefined): void {
    if (reason == null)
      this.db.prepare("DELETE FROM state WHERE name='quarantine'").run()
    else
      this.db
        .prepare(
          "INSERT INTO state(name,value) VALUES('quarantine',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        )
        .run(reason)
  }
}
