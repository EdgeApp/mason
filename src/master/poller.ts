import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { PushBranches } from '../pipeline/pushTriggers.js'
import type { MasterDatabase } from './database.js'
import { listHeads, type GitHub } from './github.js'
import type { Project, Projects } from './projects.js'
import type { Pushes } from './pushes.js'
import { isGlob, ruleFor } from './rules.js'

export const POLL_MS = 5 * 60 * 1000
/** At most this many changed automatic branches per project are decided per poll. */
export const MAX_AUTOMATIC_BRANCHES = 20

/** What the master knows of a project's branches, to order the changed ones. */
export interface Known {
  /** Whether the branch's head needs no decision: unchanged since the master decided it. */
  decided?: (branch: string, commit: string) => boolean
  /** Since when a changed branch has waited for its decision. */
  since?: (branch: string) => number | undefined
  /** The push branches of the project's workflows: what its default branch's last push setup recorded, else any branch's latest. */
  push?: PushBranches | undefined
}

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
 * Polls every enabled project and passes each new commit on a branch whose
 * first matching rule is `automatic` to the master's push decision. Every
 * poll lists all of a repository's heads and compares each automatic
 * branch's with what the master already decided for it; only the changed
 * ones, or ones never seen, are passed on, at most
 * `MAX_AUTOMATIC_BRANCHES` per project and poll: branches named by an exact
 * rule first, then branches the Masonfile's push triggers name literally,
 * then the rest, the longest-waiting first. The others wait for a later
 * poll, recorded as waiting. Deleted branches simply stop appearing; pull
 * requests from forks are not branches of the repository.
 */
export class Poller {
  private timer: NodeJS.Timeout | undefined
  private readonly abort = new AbortController()
  private active: Promise<void> | undefined
  private closed = false
  constructor(
    private readonly master: MasterDatabase,
    private readonly projects: Projects,
    private readonly pushes: Pick<
      Pushes,
      'later' | 'decided' | 'cached' | 'latest'
    >,
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

  /**
   * The automatic branches of a project to decide this poll, given its
   * repository's heads and what the master knows: those not yet decided,
   * in order, at most `MAX_AUTOMATIC_BRANCHES`.
   */
  static automaticBranches(
    project: Project,
    heads: Map<string, string>,
    known: Known = {},
  ): string[] {
    const exact = project.rules
      .filter((rule) => rule.mode === 'automatic' && !isGlob(rule.pattern))
      .map((rule) => rule.pattern)
    const literal = new Set(
      Object.values(known.push ?? {}).flatMap((branches) =>
        branches === true ? [] : branches.filter((glob) => !isGlob(glob)),
      ),
    )
    const rank = (branch: string): number => {
      const index = exact.indexOf(branch)
      return index >= 0 ? index : exact.length + (literal.has(branch) ? 0 : 1)
    }
    const since = (branch: string): number =>
      known.since?.(branch) ?? Number.POSITIVE_INFINITY
    return [...heads]
      .filter(
        ([branch, commit]) =>
          ruleFor(project.rules, branch)?.mode === 'automatic' &&
          known.decided?.(branch, commit) !== true,
      )
      .map(([branch]) => branch)
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (since(a) === since(b) ? 0 : since(a) < since(b) ? -1 : 1) ||
          (a < b ? -1 : a > b ? 1 : 0),
      )
      .slice(0, MAX_AUTOMATIC_BRANCHES)
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
        'INSERT INTO automatic_branches(project_id,branch,last_checked,observed_commit,poll_error) VALUES(?,?,?,?,?) ON CONFLICT(project_id,branch) DO UPDATE SET last_checked=excluded.last_checked,observed_commit=excluded.observed_commit,poll_error=excluded.poll_error,waiting_commit=NULL,waiting_since=NULL',
      )
      .run(
        project.id,
        branch,
        this.master.now(),
        commit ?? null,
        commit == null ? 'Could not read the repository' : null,
      )
  }

  /** A changed head left for a later poll; it keeps waiting since it first did. */
  private wait(project: Project, branch: string, commit: string): void {
    const now = this.master.now()
    this.master.db
      .prepare(
        'INSERT INTO automatic_branches(project_id,branch,last_checked,poll_error,waiting_commit,waiting_since) VALUES(?,?,?,NULL,?,?) ON CONFLICT(project_id,branch) DO UPDATE SET last_checked=excluded.last_checked,poll_error=NULL,waiting_commit=excluded.waiting_commit,waiting_since=COALESCE(automatic_branches.waiting_since,excluded.waiting_since)',
      )
      .run(project.id, branch, now, commit, now)
  }

  /**
   * Records what this poll saw of a project's automatic branches and
   * returns the ones to decide now, with their heads.
   */
  private changed(
    project: Project,
    heads: Map<string, string>,
  ): Array<[string, string]> {
    return this.master.transaction(() => {
      const waiting = new Map<string, number>()
      for (const row of this.master.db
        .prepare(
          'SELECT branch,waiting_since FROM automatic_branches WHERE project_id=? AND waiting_since IS NOT NULL',
        )
        .all(project.id))
        waiting.set(String(row.branch), Number(row.waiting_since))
      const automatic = new Map(
        [...heads].filter(
          ([branch]) => ruleFor(project.rules, branch)?.mode === 'automatic',
        ),
      )
      const decided = new Set(
        [...automatic]
          .filter(([branch, commit]) =>
            this.pushes.decided(project, branch, commit),
          )
          .map(([branch]) => branch),
      )
      const now = Poller.automaticBranches(project, automatic, {
        decided: (branch) => decided.has(branch),
        since: (branch) => waiting.get(branch),
        push:
          this.pushes.cached(project, project.defaultBranch) ??
          this.pushes.latest(project),
      })
      for (const [branch, commit] of automatic)
        if (decided.has(branch) || now.includes(branch))
          this.record(project, branch, commit)
        else this.wait(project, branch, commit)
      // A branch deleted, or no longer automatic, while it waited waits no more.
      for (const branch of waiting.keys())
        if (!automatic.has(branch))
          this.master.db
            .prepare(
              'UPDATE automatic_branches SET waiting_commit=NULL,waiting_since=NULL WHERE project_id=? AND branch=?',
            )
            .run(project.id, branch)
      return now.map((branch) => [branch, automatic.get(branch)!])
    })
  }

  private async run(): Promise<void> {
    // Each push is decided on its own, so one slow repository holds up no other.
    const decisions: Array<Promise<unknown>> = []
    try {
      await this.list(decisions)
    } finally {
      await Promise.allSettled(decisions)
    }
  }

  private async list(decisions: Array<Promise<unknown>>): Promise<void> {
    for (const project of this.projects.list()) {
      if (this.closed) return
      if (
        !project.enabled ||
        !project.rules.some((rule) => rule.mode === 'automatic')
      ) {
        // Nothing of a project that is not polled waits for a poll.
        this.master.db
          .prepare(
            'UPDATE automatic_branches SET waiting_commit=NULL,waiting_since=NULL WHERE project_id=? AND waiting_commit IS NOT NULL',
          )
          .run(project.id)
        continue
      }
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
      for (const [branch, commit] of this.changed(project, heads))
        decisions.push(this.pushes.later(project, branch, commit))
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer != null) clearInterval(this.timer)
    this.abort.abort()
    await this.active?.catch(() => undefined)
  }
}
