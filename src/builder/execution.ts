import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { baseEnvironment } from './config.js'

export class CommandFailure extends Error {
  constructor(readonly code: number | null) {
    super('Build command failed')
  }
}
export class MaskedLog {
  private pending = ''
  private bytes = 0
  private readonly width: number
  constructor(
    readonly file: string,
    private readonly secrets: string[],
    private readonly limit = 4 * 1024 * 1024,
  ) {
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
    this.secrets = secrets
      .filter((s) => s.length > 0)
      .sort((a, b) => b.length - a.length)
    this.width = Math.max(1, ...this.secrets.map((s) => s.length))
  }
  write(value: string, final = false): void {
    this.pending += value
    let end = final
      ? this.pending.length
      : Math.max(0, this.pending.length - this.width)
    let out = '',
      i = 0
    while (i < end) {
      const secret = this.secrets.find((s) => this.pending.startsWith(s, i))
      if (secret != null) {
        out += '[redacted]'
        i += secret.length
      } else out += this.pending[i++]
    }
    end = i
    this.pending = this.pending.slice(end)
    const data = Buffer.from(out).subarray(
      0,
      Math.max(0, this.limit - this.bytes),
    )
    if (data.length) appendFileSync(this.file, data)
    this.bytes += data.length
  }
}
interface ProcessIdentity {
  pid: number
  parent: number
  group: number
  start: string
}
function census(): ProcessIdentity[] {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 4 * 1024 * 1024,
  })
    .trim()
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)
      return match == null
        ? []
        : [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              group: Number(match[3]),
              start: match[4]!,
            },
          ]
    })
}
/** Tracks detached descendants too. This is containment for cooperative builds, not a sandbox. */
export class Execution {
  private readonly children = new Map<number, ProcessIdentity>()
  private readonly roots = new Set<number>()
  private readonly timer: NodeJS.Timeout
  private uncertain = false
  stopped = false
  constructor(private readonly log: MaskedLog) {
    this.timer = setInterval(() => {
      try {
        this.scan()
      } catch {
        this.uncertain = true
      }
    }, 50)
  }
  private scan(): ProcessIdentity[] {
    const all = census()
    const owned = new Set<number>([process.pid, ...this.roots])
    for (const item of all)
      if (this.children.get(item.pid)?.start === item.start)
        owned.add(item.pid)
    let changed = true
    while (changed) {
      changed = false
      for (const item of all)
        if (
          item.pid !== process.pid &&
          owned.has(item.parent) &&
          !owned.has(item.pid)
        ) {
          owned.add(item.pid)
          changed = true
        }
    }
    // ps itself is a short-lived direct child; never record it as build ownership.
    for (const item of all)
      if (
        owned.has(item.pid) &&
        item.pid !== process.pid &&
        (this.roots.has(item.pid) ||
          item.parent !== process.pid ||
          this.children.has(item.pid))
      )
        this.children.set(item.pid, item)
    return all.filter(
      (item) => this.children.get(item.pid)?.start === item.start,
    )
  }
  async run(
    command: string,
    args: string[],
    cwd: string,
    env = baseEnvironment(),
    capture = false,
  ): Promise<string> {
    if (this.stopped) throw new Error('Execution stopped')
    return await new Promise((resolve, reject) => {
      const child: ChildProcess = spawn(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      if (child.pid != null) {
        this.roots.add(child.pid)
        this.scan()
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (data: string) => {
        if (capture) output = (output + data).slice(-65536)
        else this.log.write(data)
      })
      child.stderr?.on('data', (data: string) => this.log.write(data))
      child.once('error', reject)
      child.once('exit', (code) => {
        if (child.pid != null) this.roots.delete(child.pid)
        if (code === 0 && !this.stopped) resolve(output.trim())
        else reject(new CommandFailure(code))
      })
    })
  }
  async stop(): Promise<boolean> {
    this.stopped = true
    clearInterval(this.timer)
    try {
      // Give entrypoints one TERM and time to restore signing state. Do not
      // signal cleanup children created during the cooperative grace period.
      const initial = this.scan()
      const roots = initial.filter((item) => this.roots.has(item.pid))
      for (const item of roots) {
        try {
          process.kill(item.pid, 'SIGTERM')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            this.uncertain = true
        }
      }
      const forceAt = Date.now() + 10000
      const deadline = forceAt + 4000
      while (Date.now() < deadline) {
        const remaining = this.scan()
        if (remaining.length === 0) return !this.uncertain
        if (Date.now() >= forceAt)
          for (const item of remaining) {
            try {
              process.kill(item.pid, 'SIGKILL')
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                this.uncertain = true
            }
          }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } catch {
      this.uncertain = true
    }
    return false
  }
}
