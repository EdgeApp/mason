import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'mocha'
import type { PushBranches } from '../pipeline/pushTriggers.js'
import { MasterDatabase } from './database.js'
import { Jobs } from './jobs.js'
import { MAX_AUTOMATIC_BRANCHES, Poller } from './poller.js'
import { Projects, type Project } from './projects.js'
import { Pushes } from './pushes.js'
import { localOperator } from './roles.js'
import type { BranchRule } from './rules.js'

let counter = 0
const commit = (): string => (++counter).toString(16).padStart(40, 'c')
const names = (prefix: string, count: number): string[] =>
  Array.from(
    { length: count },
    (_, i) => `${prefix}${String(i).padStart(2, '0')}`,
  )

interface Setup {
  master: MasterDatabase
  projects: Projects
  jobs: Jobs
  heads: Map<string, string>
  project: () => Project
  poll: () => Promise<string[]>
  succeed: () => void
  push: (...branches: string[]) => void
  row: (branch: string) => Record<string, unknown> | undefined
}

/** A master whose poll passes pushes to a real decision, recording each branch it passes per poll. */
function setup(rules: BranchRule[], branches: string[]): Setup {
  let clock = 1000
  const master = new MasterDatabase(new DatabaseSync(':memory:'), () => clock)
  const projects = new Projects(master)
  projects.save(localOperator, 'p', { repository: 'https://github.com/a/b' })
  projects.setRules(localOperator, 'p', rules)
  const jobs = new Jobs(master, projects)
  const pushes = new Pushes({ master, jobs })
  const heads = new Map(branches.map((branch) => [branch, commit()]))
  let passed: string[] = []
  const poller = new Poller(
    master,
    projects,
    {
      later: async (project, branch, head): Promise<void> => {
        passed.push(branch)
        await pushes.later(project, branch, head)
      },
      decided: (project, branch, head): boolean =>
        pushes.decided(project, branch, head),
      cached: (project, branch): PushBranches | undefined =>
        pushes.cached(project, branch),
      latest: (project): PushBranches | undefined => pushes.latest(project),
    },
    async () => heads,
  )
  return {
    master,
    projects,
    jobs,
    heads,
    project: (): Project => projects.get('p'),
    /** One poll, a minute after the last; the branches it passed on. */
    async poll(): Promise<string[]> {
      clock += 60_000
      passed = []
      await poller.poll()
      return passed
    },
    /** Every queued run succeeds, so its commit is not built again. */
    succeed(): void {
      for (const job of jobs.pending()) {
        master.db
          .prepare("UPDATE jobs SET status='succeeded' WHERE id=?")
          .run(job.id)
        jobs.succeeded(job.id)
      }
    },
    push(...pushed: string[]): void {
      for (const branch of pushed) heads.set(branch, commit())
    },
    row(branch: string): Record<string, unknown> | undefined {
      return master.db
        .prepare('SELECT * FROM automatic_branches WHERE branch=?')
        .get(branch)
    },
  }
}

describe('Poller', () => {
  it('P1 orders changed branches: exact rules, then literal push branches, then the longest-waiting', () => {
    const projects = new Projects(
      new MasterDatabase(new DatabaseSync(':memory:')),
    )
    projects.save(localOperator, 'p', { repository: 'https://github.com/a/b' })
    projects.setRules(localOperator, 'p', [
      { pattern: 'zeta', mode: 'automatic' },
      { pattern: 'skip', mode: 'request' },
      { pattern: '*', mode: 'automatic' },
    ])
    const heads = new Map(
      [...names('a', 40), 'zeta', 'staging', 'omega', 'skip', 'x/y'].map(
        (branch) => [branch, commit()],
      ),
    )
    const decided = new Set(names('a', 5))
    const order = Poller.automaticBranches(projects.get('p'), heads, {
      decided: (branch) => decided.has(branch),
      since: (branch) =>
        new Map([
          ['omega', 1],
          ['a05', 2],
        ]).get(branch),
      push: { build: ['master', 'staging', 'feat-*'], deploy: true },
    })
    assert.deepEqual(order, [
      'zeta',
      'staging',
      'omega',
      'a05',
      ...names('a', 22).slice(6),
    ])
    assert.equal(order.length, MAX_AUTOMATIC_BRANCHES)
  })

  it('P2 decides a late branch the Masonfile pushes literally in the first poll', async () => {
    const m = setup(
      [{ pattern: '*', mode: 'automatic' }],
      [...names('b', 35), 'master', 'staging'],
    )
    m.master.db
      .prepare(
        "INSERT INTO push_triggers(project_id,branch,sources,triggers,commit_sha,updated) VALUES(?,'master','x',?,?,1)",
      )
      .run(
        m.project().id,
        JSON.stringify({ build: ['master', 'staging', 'release/*'] }),
        commit(),
      )
    const first = await m.poll()
    assert.equal(first.length, MAX_AUTOMATIC_BRANCHES)
    assert.deepEqual(first.slice(0, 2), ['master', 'staging'])
    assert(m.jobs.pending().some((job) => job.branch === 'staging'))
    // A later push to it jumps the branches still waiting.
    m.succeed()
    m.push('staging')
    assert.deepEqual((await m.poll()).slice(0, 1), ['staging'])
  })

  it('P3 passes on only changed heads, at most the cap per poll, the longest-waiting first', async () => {
    const m = setup([{ pattern: '*', mode: 'automatic' }], names('b', 30))
    m.push('zulu')
    assert.deepEqual(await m.poll(), names('b', 20))
    // The rest are seen and wait their turn.
    assert.equal(m.row('zulu')!.waiting_commit, m.heads.get('zulu'))
    assert.equal(m.row('zulu')!.observed_commit, null)
    // Branches whose runs are queued for their heads are not passed again.
    assert.deepEqual(await m.poll(), [...names('b', 30).slice(20), 'zulu'])
    assert.equal(m.row('zulu')!.waiting_commit, null)
    assert.equal(m.jobs.pending().length, 31)
    m.succeed()
    assert.deepEqual(await m.poll(), [])
    // Twenty-five change: twenty now, the other five first next time.
    m.push(...names('b', 24), 'zulu')
    assert.deepEqual(await m.poll(), names('b', 20))
    m.succeed()
    m.push(...names('b', 20))
    const next = await m.poll()
    assert.deepEqual(next, [
      ...names('b', 24).slice(20),
      'zulu',
      ...names('b', 15),
    ])
    assert.equal(m.row('b17')!.waiting_commit, m.heads.get('b17'))
    // A branch deleted while it waited stops waiting.
    m.heads.delete('b17')
    m.succeed()
    assert.deepEqual(await m.poll(), ['b15', 'b16', 'b18', 'b19'])
    assert.equal(m.row('b17')!.waiting_commit, null)
    // A commit the master skipped is not decided again.
    m.succeed()
    m.push('b00')
    m.master.db
      .prepare("UPDATE automatic_branches SET skipped_key=? WHERE branch='b00'")
      .run(`${m.heads.get('b00')} ${m.project().format} `)
    assert.deepEqual(await m.poll(), [])
  })

  it('P4 keeps exact rule branches first, ahead of branches that waited', async () => {
    const m = setup(
      [
        { pattern: 'release', mode: 'automatic' },
        { pattern: '*', mode: 'automatic' },
      ],
      [...names('b', 30), 'release'],
    )
    const first = await m.poll()
    assert.deepEqual(first, ['release', ...names('b', 19)])
    m.succeed()
    m.push('release')
    assert.deepEqual(await m.poll(), ['release', ...names('b', 30).slice(19)])
  })

  it('P5 a branch pushed again while it waits keeps its place; one no longer polled stops waiting', async () => {
    const m = setup([{ pattern: '*', mode: 'automatic' }], names('b', 45))
    await m.poll()
    const since = m.row('b44')!.waiting_since
    assert.equal(typeof since, 'number')
    // Pushed again, b44 still waits since it first did, behind b20…b39.
    m.push('b44')
    assert.deepEqual(await m.poll(), names('b', 40).slice(20))
    assert.deepEqual(
      [m.row('b44')!.waiting_commit, m.row('b44')!.waiting_since],
      [m.heads.get('b44'), since],
    )
    // A rule that no longer makes b40 automatic ends its wait.
    m.projects.setRules(localOperator, 'p', [
      { pattern: 'b40', mode: 'request' },
      { pattern: '*', mode: 'automatic' },
    ])
    m.succeed()
    m.push(...names('b', 20))
    assert.deepEqual(await m.poll(), [
      ...names('b', 45).slice(41),
      ...names('b', 16),
    ])
    assert.equal(m.row('b40')!.waiting_commit, null)
    assert.notEqual(m.row('b16')!.waiting_commit, null)
    // So does a project that is no longer polled.
    m.projects.save(localOperator, 'p', { enabled: false })
    assert.deepEqual(await m.poll(), [])
    assert.equal(
      m.master.db
        .prepare(
          'SELECT COUNT(*) n FROM automatic_branches WHERE waiting_commit IS NOT NULL',
        )
        .get()!.n,
      0,
    )
  })
})
