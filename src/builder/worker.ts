import { fork, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
} from 'node:fs'
import path from 'node:path'
import { asArray } from 'cleaners'
import { text } from '../validation.js'
import { noSymlinks } from '../config.js'
import { fileURLToPath } from 'node:url'
import { BuilderStore, exclusiveLock } from './store.js'
import { baseEnvironment } from './config.js'
import { Workspace } from './workspace.js'
import { writeBootstrap } from './guardian.js'

export class Worker {
  private readonly lock
  private child?: ChildProcess
  private readonly timer: NodeJS.Timeout
  private closed = false
  private readonly bootstrap: string
  constructor(
    readonly store: BuilderStore,
    private readonly fixtureResolverFile?: string,
    private readonly guardianExecPath = process.execPath,
  ) {
    this.lock = exclusiveLock(
      path.join(store.config.workspace, 'worker.sqlite'),
    )
    this.bootstrap = path.join(
      store.config.workspace,
      'executions',
      'worker-config.json',
    )
    rmSync(this.bootstrap, { force: true })
    writeBootstrap(this.bootstrap, store.config)
    // A crash leaves the quarantine flag set. A surviving guardian may clear it
    // after stopping its execution; otherwise explicit operator recovery is required.
    for (const job of store.pending())
      if (job.status === 'running') {
        try {
          const lock = exclusiveLock(
            path.join(
              store.config.workspace,
              'executions',
              job.id + '.sqlite',
            ),
          )
          store.finish(job.id, 'interrupted', undefined, undefined, true)
          lock.close()
        } catch {
          /* A live guardian still owns this job. */
        }
      }
    this.timer = setInterval(() => this.tick(), 200)
    this.tick()
  }
  private tick(): void {
    if (this.closed || this.child != null) return
    this.store.prune()
    for (const name of readdirSync(
      path.join(this.store.config.workspace, 'logs'),
    )) {
      if (
        /^[a-f0-9-]{36}\.log$/.test(name) &&
        this.store.job(name.slice(0, -4)) == null
      )
        rmSync(path.join(this.store.config.workspace, 'logs', name))
    }
    for (const name of readdirSync(
      path.join(this.store.config.workspace, 'executions'),
    )) {
      if (
        /^[a-f0-9-]{36}\.(sqlite(?:-journal)?|result\.json|files\.json)$/.test(
          name,
        ) &&
        this.store.job(name.slice(0, 36)) == null
      )
        rmSync(path.join(this.store.config.workspace, 'executions', name))
    }
    const job = this.store.claim()
    if (job == null) return
    const args = [
      this.bootstrap,
      job.id,
      ...(this.fixtureResolverFile == null
        ? []
        : [this.fixtureResolverFile]),
    ]
    const child = fork(
      fileURLToPath(
        new URL('../../lib/builder/guardian.js', import.meta.url),
      ),
      args,
      {
        env: baseEnvironment(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        detached: true,
        execArgv: [],
        execPath: this.guardianExecPath,
      },
    )
    this.child = child
    child.once('error', () => {
      this.store.finish(job.id, 'interrupted', undefined, undefined, true)
      if (child.pid == null) this.child = undefined
    })
    child.once('exit', () => {
      if (this.store.job(job.id)?.status === 'running')
        this.store.finish(job.id, 'interrupted', undefined, undefined, true)
      this.child = undefined
    })
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    const child = this.child
    if (child != null) {
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.once('error', () => {
          if (child.pid == null) resolve()
        })
      })
      if (child.connected) child.disconnect()
      await exited
    }
    rmSync(this.bootstrap, { force: true })
    this.lock.close()
  }
}
export function recover(
  store: BuilderStore,
  id: string,
  confirmed: boolean,
): void {
  if (!confirmed)
    throw new Error(
      'Confirm all job processes have stopped before recovery',
    )
  const job = store.job(id)
  if (!job?.quarantine) throw new Error('Job is not quarantined')
  const workerLock = exclusiveLock(
    path.join(store.config.workspace, 'worker.sqlite'),
  )
  try {
    const executionLock = exclusiveLock(
      path.join(store.config.workspace, 'executions', id + '.sqlite'),
    )
    try {
      const manifest = path.join(
        store.config.workspace,
        'executions',
        id + '.files.json',
      )
      noSymlinks(manifest)
      if (existsSync(manifest)) {
        const files = asArray(text(4096))(
          JSON.parse(readFileSync(manifest, 'utf8')),
        )
        for (const file of files) {
          const relative = path.relative(store.config.workspace, file)
          if (relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('Invalid recovery path')
          noSymlinks(file)
          rmSync(file, { force: true })
        }
        rmSync(manifest)
      }
      Workspace.discardCheckout(store, job)
      store.finish(id, 'interrupted')
    } finally {
      executionLock.close()
    }
  } finally {
    workerLock.close()
  }
}
export function readLogPath(
  store: BuilderStore,
  id: string,
): string | undefined {
  if (!store.job(id)) return undefined
  const file = path.join(store.config.workspace, 'logs', id + '.log')
  return existsSync(file) && statSync(file).isFile() ? file : undefined
}
