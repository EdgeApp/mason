import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Graph } from '../pipeline/graph.js'
import {
  graphPushBranches,
  MAX_SOURCE_BYTES,
  pushBuilds,
  type PushBranches,
} from '../pipeline/pushTriggers.js'
import type { MasterDatabase } from './database.js'
import type { Jobs } from './jobs.js'
import type { Mirrors } from './mirrors.js'
import type { Project } from './projects.js'
import { ruleFor } from './rules.js'
import { SourceReader } from './sourceReader.js'

/** The reader the master's decisions share, started when first needed. */
let shared: SourceReader | undefined

/** What became of a push; `by` is how the master knew whether to build it. */
export interface PushResult {
  status: 'scheduled' | 'unchanged' | 'ignored'
  job?: string
  reason?: string
  by?: Decision['by']
}

interface Decision {
  /** Undefined: only setup can tell, so the push builds and setup decides. */
  build?: boolean
  reason?: string
  by: 'script' | 'source' | 'cache' | 'setup' | 'none'
}

/** The files Mason loads a Masonfile from, in order. */
const masonfiles = (project: Project): string[] =>
  project.entrypoint == null
    ? ['Masonfile.ts', 'Masonfile.js']
    : [project.entrypoint]

/** At most this many files of a Masonfile and its local imports are hashed. */
export const MAX_SOURCES = 200
/** How long a decision waits for the mirror's fetch. */
const FETCH_MS = 20_000

/**
 * Decides each push on an automatic branch on the master, starting no node
 * for one it will not build. Cheapest first: a commit with no Masonfile
 * builds nothing; a Masonfile whose push triggers are written out literally
 * decides from its source; otherwise the triggers the branch's last setup
 * recorded decide, while its Masonfile and local imports are unchanged.
 * Only when neither can tell does the push build, and setup decides.
 */
export class Pushes {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly writes = new Set<Promise<void>>()
  constructor(
    private readonly options: {
      master: MasterDatabase
      jobs: Jobs
      /** Without the mirrors every push builds and setup decides, as before. */
      mirrors?: Pick<Mirrors, 'ensure' | 'file' | 'tree'>
      /** How long a decision waits for the mirror before leaving the push to setup. */
      fetchMs?: number
      /** Reads sources off the master's own thread; one shared reader by default. */
      reader?: Pick<SourceReader, 'read'>
      log?: (line: string) => void
    },
  ) {}
  private get db(): MasterDatabase['db'] {
    return this.options.master.db
  }
  private get reader(): Pick<SourceReader, 'read'> {
    return this.options.reader ?? (shared ??= new SourceReader())
  }

  private async locked<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.then(body, body)
    const settled = next.catch(() => undefined)
    this.locks.set(key, settled)
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key)
    })
    return await next
  }

  /** A push of `commit` to `branch`, from a webhook or the poll. One branch's pushes are decided in order. */
  async schedule(
    project: Project,
    branch: string,
    commit: string,
  ): Promise<PushResult> {
    if (ruleFor(project.rules, branch)?.mode !== 'automatic')
      return { status: 'ignored' }
    return await this.locked(`${project.id}:${branch}`, async () => {
      // A busy branch keeps the commit for when its run ends, decided then.
      if (this.busy(project, branch) || this.tried(project, branch, commit)) {
        const job = this.options.jobs.automatic(project, branch, commit)
        return job == null
          ? { status: 'unchanged' as const }
          : { status: 'scheduled' as const, job: job.id }
      }
      // A skipped commit is decided again only if where the Masonfile is looked for changes.
      const key = `${commit} ${project.format} ${project.entrypoint ?? ''}`
      const skipped = this.db
        .prepare(
          'SELECT skipped_key,skipped_reason FROM automatic_branches WHERE project_id=? AND branch=?',
        )
        .get(project.id, branch)
      if (skipped?.skipped_key === key)
        return {
          status: 'ignored' as const,
          reason: String(skipped.skipped_reason),
        }
      const decision = await this.decide(project, branch, commit)
      if (decision.build === false) {
        this.db
          .prepare(
            'INSERT INTO automatic_branches(project_id,branch,observed_commit,skipped_commit,skipped_key,skipped_reason) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,branch) DO UPDATE SET observed_commit=excluded.observed_commit,skipped_commit=excluded.skipped_commit,skipped_key=excluded.skipped_key,skipped_reason=excluded.skipped_reason',
          )
          .run(project.id, branch, commit, commit, key, decision.reason ?? null)
        return {
          status: 'ignored' as const,
          ...(decision.reason == null ? {} : { reason: decision.reason }),
          by: decision.by,
        }
      }
      const job = this.options.jobs.automatic(project, branch, commit)
      return job == null
        ? { status: 'unchanged' as const, by: decision.by }
        : { status: 'scheduled' as const, job: job.id, by: decision.by }
    })
  }

  /**
   * Decides a push without anyone waiting on it (a webhook, the poll, a
   * run's end); a failure is logged with the push it was. With no commit,
   * the newest one pushed while the branch was busy.
   */
  async later(
    project: Project,
    branch: string,
    commit?: string,
  ): Promise<void> {
    try {
      if (commit == null) await this.since(project, branch)
      else await this.schedule(project, branch, commit)
    } catch (error) {
      ;(this.options.log ?? console.error)(
        `Deciding the push of ${project.slug} ${branch}${commit == null ? '' : ` at ${commit.slice(0, 12)}`} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** When a branch's run ends: the newest commit pushed while it was busy. */
  async since(project: Project, branch: string): Promise<PushResult> {
    const commit = this.options.jobs.observedSince(project, branch)
    return commit == null
      ? { status: 'unchanged' }
      : await this.schedule(project, branch, commit)
  }

  private busy(project: Project, branch: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM jobs WHERE project_id=? AND branch=? AND status IN ('queued','running')",
        )
        .get(project.id, branch) != null
    )
  }

  /** A commit that built, or failed three times, is not built again. */
  private tried(project: Project, branch: string, commit: string): boolean {
    const row = this.db
      .prepare(
        'SELECT attempts,succeeded FROM automatic_attempts WHERE project_id=? AND branch=? AND commit_sha=?',
      )
      .get(project.id, branch, commit)
    return row != null && (row.succeeded === 1 || Number(row.attempts) >= 3)
  }

  /**
   * The Masonfile at a commit the mirror holds, or undefined when it has
   * none; `text` is absent when it is too large to read here.
   */
  private async masonfile(
    project: Project,
    commit: string,
  ): Promise<{ file: string; blob: string; text?: string } | undefined> {
    for (const file of masonfiles(project)) {
      const found = await this.options.mirrors!.file(
        project.slug,
        project.repository,
        commit,
        file,
        MAX_SOURCE_BYTES,
      )
      if (found != null) return { file, ...found }
    }
    return undefined
  }

  /**
   * Whether no Masonfile could be found where a node looks: a node follows
   * symlinked directories and, on macOS, ignores case, so a path through a
   * symlink or submodule, or a name that matches ignoring case, is left to
   * setup.
   */
  private async absent(project: Project, commit: string): Promise<boolean> {
    const mirrors = this.options.mirrors!
    for (const file of masonfiles(project)) {
      const parts = file.split('/').filter((part) => part !== '')
      let dir = ''
      for (const [index, part] of parts.entries()) {
        const entries = await mirrors.tree(
          project.slug,
          project.repository,
          commit,
          dir,
        )
        if (entries == null) return false
        const last = index === parts.length - 1
        const exact = entries.find((entry) => entry.name === part)
        if (
          entries.some(
            (entry) =>
              entry.name !== part &&
              entry.name.toLowerCase() === part.toLowerCase(),
          ) ||
          (exact != null && (last || exact.mode !== '040000'))
        )
          return false
        if (exact == null) break
        dir = dir === '' ? part : `${dir}/${part}`
      }
    }
    return true
  }

  private async decide(
    project: Project,
    branch: string,
    commit: string,
  ): Promise<Decision> {
    if (project.format === 'script') return { build: true, by: 'script' }
    const mirrors = this.options.mirrors
    if (mirrors == null) return { by: 'setup' }
    // A slow or failed fetch, or a mirror that cannot be read, leaves the push to setup.
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.read(project, branch, commit),
        new Promise<Decision>((resolve) => {
          timer = setTimeout(
            () => resolve({ by: 'setup' }),
            this.options.fetchMs ?? FETCH_MS,
          )
        }),
      ])
    } catch {
      return { by: 'setup' }
    } finally {
      clearTimeout(timer)
    }
  }

  private async read(
    project: Project,
    branch: string,
    commit: string,
  ): Promise<Decision> {
    await this.options.mirrors!.ensure(project.slug, project.repository, {
      commit,
    })
    const masonfile = await this.masonfile(project, commit)
    if (masonfile == null && !(await this.absent(project, commit)))
      return { by: 'setup' }
    if (masonfile == null)
      return {
        build: false,
        reason: `${commit.slice(0, 12)} has no Masonfile`,
        by: 'none',
      }
    if (masonfile.text == null) return { by: 'setup' }
    const verdict = (push: PushBranches, by: Decision['by']): Decision =>
      pushBuilds(push, branch)
        ? { build: true, by }
        : {
            build: false,
            reason: `${branch} is not in the push trigger's branches`,
            by,
          }
    const source = (await this.reader.read(masonfile.text)).push
    if (source != null) return verdict(source, 'source')
    const cached = this.db
      .prepare(
        'SELECT sources,triggers FROM push_triggers WHERE project_id=? AND branch=?',
      )
      .get(project.id, branch)
    if (cached == null) return { by: 'setup' }
    const sources = await this.sources(project, commit, masonfile)
    if (sources != null && cached.sources === sources)
      return verdict(
        JSON.parse(String(cached.triggers)) as PushBranches,
        'cache',
      )
    return { by: 'setup' }
  }

  /**
   * A hash of the blobs of the Masonfile and of every file it imports, and
   * theirs: what a setup's triggers can depend on besides the branch.
   * Undefined when the inputs cannot all be known: a file missing, too
   * large or not a regular file, one that loads anything but the
   * repository's own files by a literal relative path or reaches the
   * process (`process`, `require`, `import()`, `globalThis`…), or more than
   * MAX_SOURCES files.
   */
  private async sources(
    project: Project,
    commit: string,
    masonfile: { file: string; blob: string; text?: string },
  ): Promise<string | undefined> {
    const mirrors = this.options.mirrors!
    const seen = new Set([masonfile.file])
    const queue: Array<{
      file: string
      found?: { blob: string; text?: string } | undefined
    }> = [{ file: masonfile.file, found: masonfile }]
    const blobs: Array<[string, string]> = []
    while (queue.length > 0) {
      if (blobs.length >= MAX_SOURCES) return undefined
      const next = queue.shift()!
      const found =
        'found' in next
          ? next.found
          : await mirrors.file(
              project.slug,
              project.repository,
              commit,
              next.file,
              MAX_SOURCE_BYTES,
            )
      // A missing import may be reached another way (a symlinked directory).
      if (found == null) return undefined
      blobs.push([next.file, found.blob])
      if (!/\.[cm]?[jt]s$/.test(next.file)) continue
      if (found.text == null) return undefined
      const { specifiers } = await this.reader.read(found.text)
      if (specifiers == null) return undefined
      for (const specifier of specifiers) {
        // Only the repository's own files are hashed: a package, a built-in
        // or anything else could hold what setup reads.
        if (!specifier.startsWith('./') && !specifier.startsWith('../'))
          return undefined
        const target = path.posix.normalize(
          path.posix.join(path.posix.dirname(next.file), specifier),
        )
        if (target.startsWith('..')) return undefined
        if (seen.has(target)) continue
        seen.add(target)
        queue.push({ file: target })
      }
    }
    return createHash('sha256').update(JSON.stringify(blobs)).digest('hex')
  }

  /**
   * Keeps the push triggers a push's setup of `build` recorded for its
   * branch, with the sources they came from, for the pushes that follow.
   * Nothing is kept when the sources cannot all be known.
   */
  remember(
    project: Project,
    branch: string,
    commit: string,
    graph: Graph,
  ): void {
    if (this.options.mirrors == null || project.format === 'script') return
    const write = (async (): Promise<void> => {
      const masonfile = await this.masonfile(project, commit)
      const sources =
        masonfile == null || masonfile.text == null
          ? undefined
          : await this.sources(project, commit, masonfile)
      if (sources == null) {
        this.db
          .prepare('DELETE FROM push_triggers WHERE project_id=? AND branch=?')
          .run(project.id, branch)
        return
      }
      this.db
        .prepare(
          'INSERT INTO push_triggers(project_id,branch,sources,triggers,commit_sha,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,branch) DO UPDATE SET sources=excluded.sources,triggers=excluded.triggers,commit_sha=excluded.commit_sha,updated=excluded.updated',
        )
        .run(
          project.id,
          branch,
          sources,
          JSON.stringify(graphPushBranches(graph)),
          commit,
          this.options.master.now(),
        )
    })()
      .catch(() => undefined)
      .finally(() => this.writes.delete(write))
    this.writes.add(write)
  }

  /** Settles once the trigger caches being written have been. */
  async settled(): Promise<void> {
    await Promise.all([...this.writes])
  }
}
