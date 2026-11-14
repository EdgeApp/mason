import type { DatabaseSync } from 'node:sqlite'
import type { QueueEntry } from '../shared/api/dashboard.js'

export type { QueueEntry }

/** The queue panel's entries: running stages first, then queued ones, eight at most. */
export function queueEntries(db: DatabaseSync, now: number): QueueEntry[] {
  const typical = db.prepare(
    "SELECT AVG(s.finished-s.started) AS ms FROM job_stages s JOIN jobs j ON j.id=s.job_id WHERE j.project_id=? AND j.workflow=? AND s.name=? AND s.status='succeeded' AND s.finished IS NOT NULL AND s.started IS NOT NULL",
  )
  return (
    db
      .prepare(
        "SELECT j.id AS job,j.project_id,p.slug,j.workflow,j.number,j.branch,s.name,s.status,s.started FROM job_stages s JOIN jobs j ON j.id=s.job_id JOIN projects p ON p.id=j.project_id WHERE s.status IN ('running','queued') AND s.kind!='approval' AND s.name NOT LIKE '@%' ORDER BY s.status='running' DESC,j.created,s.position LIMIT 8",
      )
      .all() as Array<{
      job: string
      project_id: number
      slug: string
      workflow: string
      number: number
      branch: string
      name: string
      status: string
      started: number | null
    }>
  ).map((row) => {
    const elapsed = row.started == null ? undefined : now - row.started
    const usual = (
      typical.get(row.project_id, row.workflow, row.name) as {
        ms: number | null
      }
    ).ms
    return {
      job: row.job,
      project: row.slug,
      workflow: row.workflow,
      number: row.number,
      branch: row.branch,
      stage: row.name,
      status: row.status,
      ...(elapsed == null ? {} : { elapsed }),
      ...(elapsed == null || usual == null || usual <= 0
        ? {}
        : { progress: Math.min(0.99, elapsed / usual) }),
    }
  })
}
