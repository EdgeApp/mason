import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { MasterDatabase } from './database.js'
import { listHeads, type GitHub } from './github.js'
import type { Jobs } from './jobs.js'
import type { Project, Projects } from './projects.js'
import { isGlob, ruleFor } from './rules.js'

export const POLL_MS = 5 * 60 * 1000
/** At most this many automatic branches are polled per project. */
export const MAX_AUTOMATIC_BRANCHES = 20

/** Branch heads of a project's repository. */
export type HeadLister = (
  project: Project,
  signal: AbortSignal,
) => Promise<Map<string, string>>

/** Lists heads with `git ls-remote`, using the master's GitHub connection. */
export function gitHeadLister(github: GitHub, scratchRoot: string): HeadLister {
  return async (project, signal) => {
    const scratch = mkdtempSync(path.join(scratchRoot, 'poll-'))
    try {
      const access = await github.gitAccess(project.repository, scratch)
      return await listHeads(access.url, access.env, signal)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

/**
 * Polls every enabled project and queues a job for each new commit on a
 * branch whose first matching rule is `automatic`. Exact rules come first,
 * then branches matching glob rules in name order, up to
 * `MAX_AUTOMATIC_BRANCHES` per project. Deleted branches simply stop
 * appearing; pull requests from forks are not branches of the repository.
 */
export class Poller {
  private timer: NodeJS.Timeout | undefined
  private readonly abort = new AbortController()
  private active: Promise<void> | undefined
  private closed = false
  constructor(
    private readonly master: MasterDatabase,
    private readonly projects: Projects,
    private readonly jobs: Jobs,
    private readonly lister: HeadLister,
  ) {}

  start(intervalMs = POLL_MS): void {
    this.timer = setInterval(
      () => void this.poll().catch(() => undefined),
      intervalMs,
    )
    this.timer.unref()
    void this.poll().catch(() => undefined)
  }

  /** Branches of a project to poll, given its repository's heads. */
  static automaticBranches(
    project: Project,
    heads: Map<string, string>,
  ): string[] {
    const exact = project.rules
      .filter((rule) => rule.mode === 'automatic' && !isGlob(rule.pattern))
      .map((rule) => rule.pattern)
      .filter(
        (branch) =>
          heads.has(branch) &&
          ruleFor(project.rules, branch)?.mode === 'automatic',
      )
    const globbed = [...heads.keys()]
      .filter(
        (branch) =>
          !exact.includes(branch) &&
          ruleFor(project.rules, branch)?.mode === 'automatic',
      )
      .sort()
    return [...exact, ...globbed].slice(0, MAX_AUTOMATIC_BRANCHES)
  }

  poll(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return (this.active ??= this.run().finally(() => {
      this.active = undefined
    }))
  }

  private record(project: Project, branch: string, commit?: string): void {
    this.master.db
      .prepare(
        'INSERT INTO automatic_branches(project_id,branch,last_checked,observed_commit,poll_error) VALUES(?,?,?,?,?) ON CONFLICT(project_id,branch) DO UPDATE SET last_checked=excluded.last_checked,observed_commit=excluded.observed_commit,poll_error=excluded.poll_error',
      )
      .run(
        project.id,
        branch,
        this.master.now(),
        commit ?? null,
        commit == null ? 'Could not read the repository' : null,
      )
  }

  private async run(): Promise<void> {
    for (const project of this.projects.list()) {
      if (this.closed) return
      if (
        !project.enabled ||
        !project.rules.some((rule) => rule.mode === 'automatic')
      )
        continue
      let heads: Map<string, string>
      try {
        heads = await this.lister(project, this.abort.signal)
      } catch {
        for (const rule of project.rules)
          if (rule.mode === 'automatic' && !isGlob(rule.pattern))
            this.record(project, rule.pattern)
        continue
      }
      if (this.closed) return
      for (const branch of Poller.automaticBranches(project, heads)) {
        const commit = heads.get(branch)!
        this.record(project, branch, commit)
        this.jobs.automatic(project, branch, commit)
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer != null) clearInterval(this.timer)
    this.abort.abort()
    await this.active?.catch(() => undefined)
  }
}
