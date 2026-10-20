import type { Graph } from '../pipeline/graph.js'
import type { MasterDatabase } from './database.js'
import type { Scheduler } from './scheduler.js'
import type { Stashes } from './stash.js'

const finished =
  "('succeeded','unstable','failed','cancelled','timed_out','interrupted')"

export interface CleanupResult {
  runs: number
  stashes: number
  graphs: number
}

/**
 * The master's hourly cleanup: each workflow's `keep` decides how many runs
 * (`runs`), how old (`days`) and how many runs' stashes (`stashes`, default
 * 3) stay. A run some running restart still reuses keeps its stashes.
 */
export class Retention {
  private timer: NodeJS.Timeout | undefined
  constructor(
    private readonly master: MasterDatabase,
    private readonly scheduler: Scheduler,
    private readonly stashes: Stashes,
  ) {}

  start(intervalMs = 3600_000): void {
    this.timer = setInterval(() => {
      this.cleanup()
    }, intervalMs)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
  }

  cleanup(now = this.master.now()): CleanupResult {
    const db = this.master.db
    const out: CleanupResult = { runs: 0, stashes: 0, graphs: 0 }
    const reused = new Set(
      db
        .prepare(
          "SELECT restart_of FROM jobs WHERE restart_of IS NOT NULL AND status IN ('queued','running')",
        )
        .all()
        .map((row) => String(row.restart_of)),
    )
    const groups = db
      .prepare(
        `SELECT DISTINCT project_id,workflow FROM jobs WHERE status IN ${finished}`,
      )
      .all()
    for (const group of groups) {
      const runs = db
        .prepare(
          `SELECT id,finished,graph_key FROM jobs WHERE project_id=? AND workflow=? AND status IN ${finished} ORDER BY created DESC, id DESC`,
        )
        .all(Number(group.project_id), String(group.workflow))
      // The newest run's Masonfile decides the workflow's retention.
      const graphRow =
        runs[0]?.graph_key == null
          ? undefined
          : db
              .prepare('SELECT graph FROM graphs WHERE key=?')
              .get(String(runs[0].graph_key))
      const keep =
        graphRow == null
          ? undefined
          : (JSON.parse(String(graphRow.graph)) as Graph).workflows.find(
              (workflow) => workflow.name === group.workflow,
            )?.keep
      runs.forEach((run, index) => {
        const id = String(run.id)
        const tooMany = keep?.runs != null && index >= keep.runs
        const tooOld =
          keep?.days != null &&
          Number(run.finished) < now - keep.days * 86400_000
        if ((tooMany || tooOld) && !reused.has(id)) {
          this.scheduler.removeRun(id)
          out.runs++
          return
        }
        if (
          index >= (keep?.stashes ?? 3) &&
          !reused.has(id) &&
          this.stashes.list(id).length > 0
        ) {
          this.stashes.remove(id)
          out.stashes++
        }
      })
    }
    const orphans = db
      .prepare(
        'DELETE FROM graphs WHERE created<? AND key NOT IN (SELECT graph_key FROM jobs WHERE graph_key IS NOT NULL)',
      )
      .run(now - 30 * 86400_000)
    out.graphs = Number(orphans.changes)
    db.prepare('DELETE FROM schedule_fires WHERE at<?').run(now - 7 * 86400_000)
    return out
  }
}
