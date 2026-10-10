import { spawn } from 'node:child_process'
import { baseEnvironment, commitHash } from './config.js'
import type { BuilderStore } from './store.js'

export const AUTOMATIC_POLL_MS = 5 * 60 * 1000
export type HeadResolver = (
  repository: string,
  branch: string,
  signal: AbortSignal,
) => Promise<string>

/** Inspect one exact remote ref without a checkout or interactive credentials. */
export const remoteHead: HeadResolver = async (
  repository,
  branch,
  signal,
) => {
  signal.throwIfAborted()
  return await new Promise((resolve, reject) => {
    const ref = 'refs/heads/' + branch
    const child = spawn(
      'git',
      ['ls-remote', '--exit-code', '--refs', repository, ref],
      {
        env: {
          ...baseEnvironment(),
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND:
            'ssh -o BatchMode=yes -o ConnectTimeout=10',
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    let output = '',
      stopped = false
    const stop = (): void => {
      stopped = true
      if (child.pid != null) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* Already exited. */
        }
      }
    }
    const timer = setTimeout(stop, 30000)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data: string) => {
      if (output.length + data.length > 65536) stop()
      else output += data
    })
    child.once('error', () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      reject(new Error('Branch lookup failed'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      try {
        const lines = output.trim().split('\n')
        const [sha, name] = lines[0]!.split('\t')
        if (
          stopped ||
          code !== 0 ||
          lines.length !== 1 ||
          name !== ref
        )
          throw new Error('Branch lookup failed')
        resolve(commitHash(sha))
      } catch {
        reject(new Error('Branch lookup failed'))
      }
    })
  })
}

export class AutomaticPoller {
  private readonly timer: NodeJS.Timeout
  private readonly abort = new AbortController()
  private active?: Promise<void>
  private closed = false
  constructor(
    private readonly store: BuilderStore,
    private readonly resolveHead: HeadResolver = remoteHead,
    intervalMs = AUTOMATIC_POLL_MS,
  ) {
    this.timer = setInterval(() => {
      void this.poll().catch(() => {})
    }, intervalMs)
    void this.poll().catch(() => {})
  }
  poll(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return (this.active ??= this.run().finally(() => {
      this.active = undefined
    }))
  }
  private async run(): Promise<void> {
    const apps = this.store.apps().filter((app) => app.enabled)
    const heads = new Map<string, Promise<string>>()
    for (const rule of this.store.automaticBranches()) {
      const app = apps.find((app) => app.slug === rule.app)
      if (!rule.enabled || app == null || this.closed) continue
      const key = app.repository + ':' + rule.branch
      let head = heads.get(key)
      if (head == null) {
        head = this.resolveHead(
          app.repository,
          rule.branch,
          this.abort.signal,
        )
        heads.set(key, head)
      }
      let commit: string
      try {
        commit = commitHash(await head)
      } catch {
        if (!this.closed) this.store.recordPoll(rule.app, rule.branch)
        continue
      }
      if (this.closed) return
      this.store.recordPoll(rule.app, rule.branch, commit)
      this.store.enqueueAutomatic(rule.app, rule.branch, commit)
    }
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    this.abort.abort()
    await this.active?.catch(() => {})
  }
}
