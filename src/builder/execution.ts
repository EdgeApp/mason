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
    readonly fullFile?: string,
  ) {
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
    if (fullFile != null)
      writeFileSync(fullFile, '', { flag: 'wx', mode: 0o600 })
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
    const redacted = Buffer.from(out)
    if (this.fullFile != null && redacted.length > 0)
      appendFileSync(this.fullFile, redacted)
    const data = redacted.subarray(
      0,
      Math.max(0, this.limit - this.bytes),
    )
    if (data.length) appendFileSync(this.file, data)
    this.bytes += data.length
  }
}
export interface ProcessIdentity {
  pid: number
  parent: number
  group: number
  start: string
  state?: string
}
export function processSnapshot(): ProcessIdentity[] {
  const rows = execFileSync(
    'ps',
    ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
    {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(
        line,
      )
      if (match == null) throw new Error('Invalid process inventory')
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        state: match[4]!,
        start: match[5]!.trim(),
      }
    })
  if (!rows.some((row) => row.pid === process.pid))
    throw new Error('Process inventory omitted the guardian')
  return rows
}
/** Tracks detached descendants too. This is containment for cooperative builds, not a sandbox. */
export class Execution {
  private readonly children = new Map<number, ProcessIdentity>()
  private readonly roots = new Set<number>()
  private readonly groups = new Map<number, string | undefined>()
  private readonly timer: NodeJS.Timeout
  private inspectionFailed = false
  quarantineReason?: string
  stopped = false
  constructor(
    private readonly log: MaskedLog,
    private readonly inspect: () => ProcessIdentity[] = processSnapshot,
    private readonly graceMs = 10000,
    private readonly stopMs = 14000,
  ) {
    this.timer = setInterval(() => {
      try {
        this.scan()
      } catch {
        this.inspectionError()
      }
    }, 50)
  }
  private inspectionError(): void {
    if (!this.inspectionFailed)
      this.log.write(
        'Process inspection temporarily unavailable; retrying.\n',
      )
    this.inspectionFailed = true
  }
  private scan(): ProcessIdentity[] {
    // Zombies cannot execute or retain build files and need no signal.
    const all = this.inspect().filter(
      (item) => !item.state?.startsWith('Z'),
    )
    if (this.inspectionFailed)
      this.log.write('Process inspection recovered.\n')
    this.inspectionFailed = false
    const owned = new Set<number>([process.pid])
    for (const pid of this.roots) {
      const previous = this.children.get(pid)
      if (
        previous == null ||
        all.some(
          (item) => item.pid === pid && item.start === previous.start,
        )
      )
        owned.add(pid)
    }
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
      ) {
        this.children.set(item.pid, item)
        const leader = all.find(
          (candidate) => candidate.pid === item.group,
        )
        if (
          !this.groups.has(item.group) ||
          (leader != null && owned.has(leader.pid))
        )
          this.groups.set(item.group, leader?.start)
      }
    for (const [group, start] of this.groups) {
      const leader = all.find((item) => item.pid === group)
      // A group cannot outlive a new process with its leader's PID. The OS
      // has recycled that ID; its new members are not part of this build.
      if (
        !all.some((item) => item.group === group) ||
        (start != null && leader != null && leader.start !== start)
      )
        this.groups.delete(group)
    }
    return all.filter(
      // Keep unobserved members of owned groups visible after a monitoring gap.
      // Only positively identified processes are ever signalled below.
      (item) =>
        this.children.get(item.pid)?.start === item.start ||
        this.groups.has(item.group),
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
        this.groups.set(child.pid, undefined)
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (data: string) => {
        if (capture) output = (output + data).slice(-65536)
        this.log.write(data)
      })
      child.stderr?.on('data', (data: string) => this.log.write(data))
      child.once('error', reject)
      // Drain both output pipes before finalizing the job's log.
      child.once('close', (code) => {
        if (child.pid != null) this.roots.delete(child.pid)
        if (code === 0 && !this.stopped) resolve(output.trim())
        else reject(new CommandFailure(code))
      })
      try {
        this.scan()
      } catch {
        this.inspectionError()
      }
    })
  }
  async stop(): Promise<boolean> {
    this.stopped = true
    this.quarantineReason = undefined
    clearInterval(this.timer)
    const forceAt = Date.now() + this.graceMs
    const deadline = Date.now() + this.stopMs
    const signalled = new Set<number>()
    let empty = 0
    let remaining: ProcessIdentity[] = []
    while (Date.now() < deadline) {
      try {
        remaining = this.scan()
      } catch {
        this.inspectionError()
        empty = 0
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      // Fresh terminal verification supersedes a transient monitoring failure.
      if (remaining.length === 0 && this.roots.size === 0) {
        if (++empty >= 2) return true
      } else empty = 0
      for (const item of remaining) {
        if (this.children.get(item.pid)?.start !== item.start)
          continue
        const force = Date.now() >= forceAt
        // Give only entrypoints TERM; allow their cleanup subprocesses to finish.
        if (
          !force &&
          (!this.roots.has(item.pid) || signalled.has(item.pid))
        )
          continue
        try {
          process.kill(item.pid, force ? 'SIGKILL' : 'SIGTERM')
          signalled.add(item.pid)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            this.log.write(
              'Could not signal an owned build process; verifying termination.\n',
            )
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    this.quarantineReason = this.inspectionFailed
      ? 'Process inspection remained unavailable at the cleanup deadline.'
      : 'Build processes or owned process groups remain after the cleanup deadline.'
    this.log.write(this.quarantineReason + '\n')
    if (!this.inspectionFailed && remaining.length > 0)
      this.log.write(
        'Unverified build processes: ' +
          remaining.map((item) =>
            `pid=${item.pid} parent=${item.parent} group=${item.group} state=${item.state ?? 'unknown'} ownership=${this.children.get(item.pid)?.start === item.start ? 'tracked' : 'group-only'}`,
          ).join('; ') + '\n',
      )
    return false
  }
}
