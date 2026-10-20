import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { Json, NodeInfo } from '../../types/mason/index.js'
import { baseEnvironment, relativePath } from '../builder/config.js'
import {
  CommandFailure,
  Execution,
  MaskedLog,
  processSnapshot,
  type ProcessIdentity,
} from '../builder/execution.js'
import { noSymlinks } from '../config.js'
import { LinkError, type Link, type MethodTable } from '../link/link.js'
import { globExpression } from '../master/rules.js'
import {
  redact,
  type Assignment,
  type RunReport,
  type SetupAssignment,
  type StageAssignment,
} from '../pipeline/assignment.js'
import { inside } from '../pipeline/context.js'
import { runSetup, SetupFailed } from '../pipeline/setup.js'
import { runStage, secretForms, type StepRecord } from '../pipeline/stage.js'
import { baseInventory, type Inventory } from './baseInventory.js'
import { checkout } from './checkout.js'
import { GitBridge } from './gitProxy.js'
import { Journal } from './journal.js'

const run = promisify(execFile)

export interface WorkerOptions {
  /** The worker's data directory. */
  dir: string
  db: DatabaseSync
  version: string
  /** The master's current link. */
  link: () => Link | undefined
  /** Name, type and labels the master assigned. */
  assignment: () => { name: string; type: string; labels: string[] } | undefined
  inspect?: () => ProcessIdentity[]
  flushMs?: number
  /** Slots this worker offers; the master's setting for the node wins when lower. */
  slots?: number
}

const safe = (key: string): string =>
  key.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)

async function walk(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const out: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, dir), {
      withFileTypes: true,
    })) {
      if (entry.name === '.git') continue
      const relative = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) await visit(relative)
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative)
    }
  }
  await visit('')
  return out.sort()
}

/** The files under `root` matching any of `patterns` and none of `exclude`. */
export async function select(
  root: string,
  patterns: string | string[],
  exclude: string[] = [],
): Promise<string[]> {
  const include = (typeof patterns === 'string' ? [patterns] : patterns).map(
    globExpression,
  )
  const skip = exclude.map(globExpression)
  return (await walk(root)).filter(
    (file) =>
      include.some((pattern) => pattern.test(file)) &&
      !skip.some(
        (pattern) => pattern.test(file) || pattern.test(path.basename(file)),
      ),
  )
}

async function pack(
  root: string,
  files: string[],
  file: string,
): Promise<void> {
  const list = `${file}.list`
  writeFileSync(list, files.join('\n') + (files.length > 0 ? '\n' : ''), {
    mode: 0o600,
  })
  try {
    await run('tar', ['-czf', file, '-C', root, '-T', list], {
      env: baseEnvironment(),
    })
  } finally {
    rmSync(list, { force: true })
  }
}

async function unpack(file: string, into: string): Promise<void> {
  mkdirSync(into, { recursive: true })
  // Members are relative paths written by `pack`; tar refuses absolute and `..` members.
  await run('tar', ['-xzf', file, '-C', into], { env: baseEnvironment() })
}

/**
 * The worker role: runs the setup runs and stages its master assigns,
 * journals their records, and reports them when the master's link is up,
 * replaying from the last acknowledged record after a reconnect.
 */
export class WorkerRuntime {
  readonly journal: Journal
  readonly bridge: GitBridge
  private readonly controllers = new Map<string, AbortController>()
  private readonly executions = new Set<Promise<void>>()
  private readonly busy = new Set<number>()
  private readonly workspaceLocks = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | undefined
  private flushing: Promise<void> | undefined
  private again = false
  private stopped = false

  constructor(private readonly options: WorkerOptions) {
    this.journal = new Journal(options.db)
    this.bridge = new GitBridge(options.link)
  }

  private path(...parts: string[]): string {
    return path.join(this.options.dir, ...parts)
  }

  /** Recovers from a restart: runs that were in progress have no process any more. */
  async start(): Promise<void> {
    for (const entry of this.journal.runs('running'))
      this.journal.finish(entry.key, {
        status: 'interrupted',
        reason: 'The worker restarted while this ran',
      } satisfies RunReport)
    this.journal.prune()
    await this.bridge.listen()
    this.timer = setInterval(() => {
      this.flushSoon()
    }, this.options.flushMs ?? 250)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    for (const controller of this.controllers.values())
      controller.abort(new Error('The worker is stopping'))
    // Stopped runs finish writing their journal before the database closes.
    await Promise.allSettled([...this.executions])
    await this.flushing
    this.bridge.close()
  }

  inventory(): Inventory {
    const assigned = this.options.assignment()
    const quarantine = this.journal.quarantine()
    return baseInventory({
      dir: this.options.dir,
      ...(assigned == null ? {} : assigned),
      version: this.options.version,
      ...(this.options.slots == null ? {} : { slots: this.options.slots }),
      ...(quarantine == null ? {} : { quarantine }),
    })
  }

  /** Clears the quarantine after an operator checked the node (`mason recover`). */
  recover(): void {
    this.journal.setQuarantine(undefined)
  }

  /** Methods the worker accepts from its master. */
  methods(): MethodTable {
    return {
      requests: {
        'worker.state': () => ({
          inventory: this.inventory(),
          runs: this.journal
            .runs()
            .map((entry) => ({ key: entry.key, status: entry.status })),
        }),
        'setup.run': (params) => this.accept(params as SetupAssignment),
        'stage.run': (params) => this.accept(params as StageAssignment),
        'job.forget': (params): null => {
          this.forgetJob(String((params as { job?: unknown }).job))
          return null
        },
        'stage.cancel': (params): { known: boolean } => {
          const key = (params as { key?: unknown }).key
          this.controllers
            .get(String(key))
            ?.abort(new Error('Cancelled by the master'))
          return { known: this.controllers.has(String(key)) }
        },
      },
    }
  }

  private accept(assignment: Assignment): { accepted: true } {
    if (this.stopped) throw new Error('The worker is stopping')
    if (this.journal.quarantine() != null)
      throw new Error('This worker is quarantined')
    if (
      typeof assignment?.key !== 'string' ||
      typeof assignment.token !== 'string'
    )
      throw new Error('Invalid assignment')
    if (this.journal.get(assignment.key) != null) return { accepted: true }
    this.journal.start(
      assignment.key,
      assignment.kind === 'setup' ? 'setup' : 'stage',
      redact(assignment),
    )
    const controller = new AbortController()
    this.controllers.set(assignment.key, controller)
    const execution = this.execute(assignment, controller.signal).finally(
      () => {
        this.controllers.delete(assignment.key)
        this.executions.delete(execution)
        this.flushSoon()
      },
    )
    this.executions.add(execution)
    return { accepted: true }
  }

  private slot(): number {
    let slot = 0
    while (this.busy.has(slot)) slot++
    this.busy.add(slot)
    return slot
  }

  /** The stage's workspace: its slot's checkout, or a custom path under a workspace root. */
  private workspace(
    assignment: SetupAssignment | StageAssignment,
    slot: number,
  ): string {
    if (assignment.kind === 'setup')
      return this.path('checkouts', `setup-${slot}`, assignment.project)
    const custom = assignment.workspace.path
    if (custom == null)
      return this.path('checkouts', String(slot), assignment.project)
    if (custom.split('/').includes('..'))
      throw new Error('A workspace path cannot contain ..')
    if (path.isAbsolute(custom)) {
      const root = assignment.workspaceRoots.find(
        (entry) => custom === entry || custom.startsWith(entry + '/'),
      )
      if (root == null)
        throw new Error(
          `${custom} is not under one of this node's workspace roots`,
        )
      mkdirSync(root, { recursive: true, mode: 0o700 })
      return inside(root, path.relative(root, custom))
    }
    const root = this.path('workspaces')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    return inside(root, custom)
  }

  private async lockWorkspace(
    dir: string,
    log: (text: string) => void,
  ): Promise<() => void> {
    const previous = this.workspaceLocks.get(dir)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = (previous ?? Promise.resolve()).then(() => held)
    this.workspaceLocks.set(dir, chained)
    if (previous != null) {
      log(`Waiting for another stage to finish with ${dir}\n`)
      await previous
    }
    return () => {
      release()
      if (this.workspaceLocks.get(dir) === chained)
        this.workspaceLocks.delete(dir)
    }
  }

  private async execute(
    assignment: Assignment,
    signal: AbortSignal,
  ): Promise<void> {
    const { key } = assignment
    const secrets =
      assignment.kind === 'setup'
        ? []
        : [
            ...Object.values(assignment.secrets),
            ...[
              ...Object.values(assignment.files),
              ...(assignment.inject ?? []).map((file) => file.contents),
            ].map((contents) => Buffer.from(contents, 'base64').toString()),
          ]
    mkdirSync(this.path('logs'), { recursive: true, mode: 0o700 })
    const logFile = this.path('logs', `${safe(key)}.log`)
    rmSync(logFile, { force: true })
    let buffered = ''
    const flushLog = (): void => {
      if (buffered === '') return
      this.journal.append(key, 'log', buffered)
      buffered = ''
    }
    const log = new MaskedLog(
      logFile,
      secretForms(secrets),
      64 * 1024 * 1024,
      undefined,
      (text) => {
        buffered += text
        if (buffered.length >= 32 * 1024) flushLog()
      },
    )
    const logTimer = setInterval(flushLog, 100)
    const say = (text: string): void => {
      log.write(text)
    }
    const slot = this.slot()
    let release: (() => void) | undefined
    let source: string | undefined
    let report: RunReport
    try {
      const dir = this.workspace(assignment, slot)
      if (assignment.kind !== 'setup' && assignment.workspace.path != null)
        release = await this.lockWorkspace(dir, say)
      if (signal.aborted) throw signal.reason
      const ticket = { key, token: assignment.token }
      if (assignment.kind === 'setup' || assignment.checkout.enabled)
        await checkout({
          dir,
          repository: assignment.repository,
          commit: assignment.commit,
          repositories: assignment.repositories,
          ...(assignment.kind !== 'setup' && assignment.checkout.depth != null
            ? { depth: assignment.checkout.depth }
            : {}),
          submodules:
            assignment.kind !== 'setup' && assignment.checkout.submodules,
          lfs: assignment.kind !== 'setup' && assignment.checkout.lfs,
          mode:
            assignment.kind === 'setup' ? 'clean' : assignment.workspace.mode,
          bridge: this.bridge,
          ticket,
          log: say,
        })
      else {
        // No checkout: the workspace starts empty (or as left, with reuse), and
        // the Masonfile comes from a separate copy of the pinned commit.
        if (assignment.workspace.mode === 'clean')
          rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        source = this.path('sources', String(slot), assignment.project)
        await checkout({
          dir: source,
          repository: assignment.repository,
          commit: assignment.commit,
          repositories: [],
          submodules: false,
          lfs: false,
          mode: 'clean',
          bridge: this.bridge,
          ticket,
          log: say,
        })
      }
      if (signal.aborted) throw signal.reason
      if (assignment.kind === 'setup')
        report = await this.setup(assignment, dir, log, signal)
      else {
        for (const name of assignment.stashes)
          await this.download(assignment, name)
        for (const entry of assignment.cache)
          await this.restoreCache(assignment.project, entry.key, dir)
        report =
          assignment.kind === 'script'
            ? await this.script(assignment, dir, log, signal)
            : await this.stage(assignment, dir, log, signal, source ?? dir)
        if (report.status === 'succeeded' || report.status === 'unstable')
          for (const entry of assignment.cache)
            await this.saveCache(
              assignment.project,
              entry.key,
              entry.paths,
              dir,
            )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      say(`${message}\n`)
      report = {
        status: signal.aborted ? 'cancelled' : 'failed',
        reason: message,
      }
    } finally {
      release?.()
      this.busy.delete(slot)
    }
    if (report.quarantine != null) this.journal.setQuarantine(report.quarantine)
    log.write('', true)
    clearInterval(logTimer)
    flushLog()
    this.journal.finish(key, report)
  }

  private async setup(
    assignment: SetupAssignment,
    dir: string,
    log: MaskedLog,
    signal: AbortSignal,
  ): Promise<RunReport> {
    const entry =
      assignment.entrypoint ??
      (existsSync(path.join(dir, 'Masonfile.ts'))
        ? 'Masonfile.ts'
        : 'Masonfile.js')
    const masonfile = inside(dir, relativePath(entry))
    const scratch = this.path('tmp')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    try {
      const graph = await runSetup({
        masonfile,
        checkout: dir,
        context: assignment.context,
        scratch,
        log,
        timeoutSeconds: assignment.timeout,
        signal,
        ...(this.options.inspect == null
          ? {}
          : { inspect: this.options.inspect }),
      })
      return { status: 'succeeded', value: graph as Json }
    } catch (error) {
      if (error instanceof SetupFailed)
        return {
          status: signal.aborted
            ? 'cancelled'
            : error.message === 'Setup timed out'
              ? 'timed_out'
              : 'failed',
          reason: error.message,
        }
      throw error
    }
  }

  private node(): NodeInfo {
    const inventory = this.inventory()
    return {
      name: inventory.name,
      type: inventory.type,
      os: inventory.os,
      arch: inventory.arch,
      labels: inventory.labels,
    }
  }

  private async stage(
    assignment: StageAssignment,
    dir: string,
    log: MaskedLog,
    signal: AbortSignal,
    source: string,
  ): Promise<RunReport> {
    const entry =
      assignment.entrypoint ??
      (existsSync(path.join(source, 'Masonfile.ts'))
        ? 'Masonfile.ts'
        : 'Masonfile.js')
    const privateDir = this.path('tmp', `stage-${safe(assignment.key)}`)
    const result = await runStage({
      snapshot: {
        masonfile: inside(source, relativePath(entry)),
        function: assignment.function ?? '',
        workspace: dir,
        privateDir,
        run: assignment.run,
        stage: {
          name: assignment.stage,
          attempt: assignment.attempt,
          matrix: assignment.matrix,
        },
        node: this.node(),
        env: assignment.env,
        secrets: assignment.secrets,
        files: assignment.files,
        buildNumbers: assignment.buildNumbers,
        outputs: assignment.outputs,
      },
      log,
      timeout: assignment.timeout,
      ...(assignment.activityTimeout == null
        ? {}
        : { activityTimeout: assignment.activityTimeout }),
      continueOnError: assignment.continueOnError,
      signal,
      steps: async (method, args) =>
        await this.service(
          assignment,
          dir,
          (text) => log.write(text),
          method,
          args as unknown[],
        ),
      output: async (stage) => await this.output(assignment, stage, signal),
      onStep: (step: StepRecord) =>
        this.journal.append(assignment.key, 'step', JSON.stringify(step)),
      onDescribe: (text) =>
        this.journal.append(assignment.key, 'describe', text),
      ...(this.options.inspect == null
        ? {}
        : { inspect: this.options.inspect }),
    })
    return result
  }

  /** A script Masonfile, run exactly as the builder runs it: every secret and file in its environment. */
  private async script(
    assignment: StageAssignment,
    dir: string,
    log: MaskedLog,
    signal: AbortSignal,
  ): Promise<RunReport> {
    const entry =
      assignment.entrypoint ??
      (existsSync(path.join(dir, 'Masonfile.ts'))
        ? 'Masonfile.ts'
        : 'Masonfile.js')
    const masonfile = inside(dir, relativePath(entry))
    const resultFile = this.path('tmp', `result-${safe(assignment.key)}.json`)
    mkdirSync(path.dirname(resultFile), { recursive: true, mode: 0o700 })
    rmSync(resultFile, { force: true })
    const injected: string[] = []
    const fileEnv: Record<string, string> = {}
    for (const file of assignment.inject ?? []) {
      const target = inside(dir, relativePath(file.destination))
      mkdirSync(path.dirname(target), { recursive: true })
      rmSync(target, { force: true })
      writeFileSync(target, Buffer.from(file.contents, 'base64'), {
        mode: 0o600,
        flag: 'wx',
      })
      injected.push(target)
      if (file.env != null) fileEnv[file.env] = target
    }
    const execution = new Execution(
      log,
      this.options.inspect ?? processSnapshot,
    )
    let stopped: RunReport['status'] | undefined
    const stop = (why: 'cancelled' | 'timed_out') => (): void => {
      stopped ??= why
      void execution.stop()
    }
    const timer = setTimeout(stop('timed_out'), assignment.timeout * 1000)
    const cancel = stop('cancelled')
    signal.addEventListener('abort', cancel, { once: true })
    let exitCode: number | undefined
    let failed = false
    try {
      await execution.run(process.execPath, [masonfile], dir, {
        ...baseEnvironment(),
        ...assignment.env,
        ...assignment.secrets,
        ...fileEnv,
        MASON_APP: assignment.project,
        MASON_BRANCH: assignment.run.branch,
        MASON_COMMIT: assignment.commit,
        MASON_JOB_ID: assignment.job,
        MASON_WORKSPACE: dir,
        MASON_RESULT_FILE: resultFile,
        MASON_PLATFORMS: (assignment.platforms ?? []).join(','),
      })
    } catch (error) {
      failed = true
      if (error instanceof CommandFailure && error.code != null)
        exitCode = error.code
      if (stopped == null)
        log.write('\nBuild execution did not complete successfully.\n')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      for (const file of injected) rmSync(file, { force: true })
    }
    const safeStop = await execution.stop()
    let value: Json | undefined
    if (existsSync(resultFile)) {
      noSymlinks(resultFile)
      if (lstatSync(resultFile).isFile() && lstatSync(resultFile).size <= 65536)
        try {
          value = JSON.parse(readFileSync(resultFile, 'utf8')) as Json
        } catch {
          log.write('The build result file is not JSON; ignoring it.\n')
        }
      rmSync(resultFile, { force: true })
    }
    const status: RunReport['status'] =
      stopped ??
      (failed
        ? assignment.continueOnError
          ? 'unstable'
          : 'failed'
        : 'succeeded')
    return {
      status,
      ...(value === undefined ? {} : { value }),
      ...(exitCode == null ? {} : { exitCode }),
      ...(safeStop
        ? {}
        : {
            quarantine: execution.quarantineReason ?? 'Build processes remain',
          }),
    }
  }

  private async request<T>(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const link = this.options.link()
    if (link == null)
      throw new LinkError('The master is not connected', 'closed')
    return (await link.request(method, params, timeoutMs)) as T
  }

  /** Waits for the master's link. */
  private async connected(signal: AbortSignal): Promise<void> {
    while (this.options.link() == null) {
      if (signal.aborted) throw signal.reason
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /** `ctx.output` of a stage that was not finished when this one was assigned, waiting while the master is away. */
  private async output(
    assignment: StageAssignment,
    stage: string,
    signal: AbortSignal,
  ): Promise<Json> {
    for (;;) {
      await this.connected(signal)
      try {
        const answer = await this.request<{ pending?: true; value?: Json }>(
          'run.output',
          {
            key: assignment.key,
            token: assignment.token,
            stage,
          },
        )
        if (answer.pending !== true) return answer.value ?? null
      } catch (error) {
        if (!(error instanceof LinkError) || error.code !== 'closed')
          throw error
      }
    }
  }

  private async service(
    assignment: StageAssignment,
    dir: string,
    say: (text: string) => void,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const ticket = { key: assignment.key, token: assignment.token }
    switch (method) {
      case 'stash': {
        const [name, paths, options] = args as [
          string,
          string | string[],
          { exclude?: string[] },
        ]
        if (
          typeof name !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)
        )
          throw new Error('Invalid stash name')
        const files = await select(dir, paths, options?.exclude ?? [])
        if (files.length === 0)
          throw new Error(`Stash ${name} matched no files`)
        const target = this.path('stashes', assignment.job, `${name}.tar`)
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
        await pack(dir, files, target)
        this.journal.addUpload(assignment.key, name, target)
        // Upload now when the master is there; otherwise the stash goes with the result.
        try {
          await this.upload(assignment.key, ticket.token, name, target)
        } catch (error) {
          if (error instanceof LinkError && error.code === 'closed') return null
          // The master refused it (too large, or the stage is no longer assigned).
          this.journal.uploaded(assignment.key, name)
          throw error
        }
        return null
      }
      case 'unstash': {
        const [name, options] = args as [string, { into?: string }]
        const file = this.path('stashes', assignment.job, `${name}.tar`)
        if (!existsSync(file)) await this.download(assignment, name)
        await unpack(file, inside(dir, options?.into ?? '.'))
        return null
      }
      case 'cache.restore': {
        const [cacheKey] = args as [string]
        return await this.restoreCache(assignment.project, cacheKey, dir)
      }
      case 'cache.save': {
        const [cacheKey, paths] = args as [string, string[]]
        await this.saveCache(assignment.project, cacheKey, paths, dir)
        return null
      }
      case 'checkout': {
        const [, options] = args as [
          string,
          { repository: string; ref?: string; path: string },
        ]
        const { commit } = await this.request<{ commit: string }>(
          'git.prepare',
          {
            ...ticket,
            repository: options.repository,
            ...(options.ref == null ? {} : { ref: options.ref }),
          },
        )
        await checkout({
          dir: inside(dir, relativePath(options.path)),
          repository: options.repository,
          commit,
          repositories: [],
          submodules: false,
          lfs: false,
          mode: 'clean',
          bridge: this.bridge,
          ticket,
          log: say,
        })
        return null
      }
      case 'git.tag': {
        const [name, options] = args as [
          string,
          { message?: string; push?: boolean },
        ]
        await run(
          'git',
          options?.message == null
            ? ['tag', '--', name, assignment.commit]
            : [
                'tag',
                '-a',
                '-m',
                options.message,
                '--',
                name,
                assignment.commit,
              ],
          {
            cwd: dir,
            env: {
              ...baseEnvironment(),
              GIT_COMMITTER_NAME: 'Mason',
              GIT_COMMITTER_EMAIL: 'mason@localhost',
            },
          },
        )
        if (options?.push === true)
          await this.request('git.tag', {
            ...ticket,
            name,
            ...(options.message == null ? {} : { message: options.message }),
          })
        return null
      }
      default:
        throw new Error(`${method} is not available on this node yet`)
    }
  }

  private cacheFile(project: string, key: string): string {
    return this.path(
      'caches',
      project,
      `${createHash('sha256').update(key).digest('hex')}.tar.gz`,
    )
  }

  private async restoreCache(
    project: string,
    key: string,
    dir: string,
  ): Promise<boolean> {
    const file = this.cacheFile(project, key)
    if (!existsSync(file)) return false
    await unpack(file, dir)
    return true
  }

  private async saveCache(
    project: string,
    key: string,
    paths: string[],
    dir: string,
  ): Promise<void> {
    const files = await select(
      dir,
      paths
        .map((entry) =>
          entry.includes('*') ? entry : `${entry.replace(/\/$/, '')}/**`,
        )
        .concat(paths),
    )
    if (files.length === 0) return
    const file = this.cacheFile(project, key)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    await pack(dir, files, `${file}.part`)
    rmSync(file, { force: true })
    const { renameSync } = await import('node:fs')
    renameSync(`${file}.part`, file)
  }

  /** Streams a stash to the master; resolves when the master has stored it. */
  private async upload(
    key: string,
    token: string,
    name: string,
    file: string,
  ): Promise<void> {
    const link = this.options.link()
    if (link == null)
      throw new LinkError('The master is not connected', 'closed')
    const stream = link.openStream('stash.put', { key, token, name })
    const done = new Promise<void>((resolve, reject) => {
      stream.once('end', () => {
        resolve()
      })
      stream.once('abort', (reason: string) => {
        reject(new Error(`Stash ${name}: ${reason}`))
      })
    })
    done.catch(() => undefined)
    try {
      for await (const chunk of createReadStream(file))
        await stream.write(chunk as Buffer)
      stream.end()
      await done
    } catch (error) {
      // A dropped link is retried later; anything else is the master refusing the stash.
      if (link.closed)
        throw new LinkError('The master is not connected', 'closed')
      const reason = await Promise.race([
        done.then(
          () => error,
          (refused: unknown) => refused,
        ),
        new Promise<unknown>((resolve) =>
          setTimeout(() => resolve(error), 1000),
        ),
      ])
      throw reason instanceof Error ? reason : new Error(String(reason))
    }
    this.journal.uploaded(key, name)
  }

  /** Fetches a stash of the run from the master into the local stash directory. */
  private async download(
    assignment: StageAssignment,
    name: string,
  ): Promise<void> {
    const target = this.path('stashes', assignment.job, `${name}.tar`)
    if (existsSync(target)) return
    const link = this.options.link()
    if (link == null)
      throw new Error(
        `Stash ${name} is not on this node and the master is not connected`,
      )
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const partial = `${target}.part`
    const out = createWriteStream(partial, { mode: 0o600 })
    out.on('error', () => undefined)
    const stream = link.openStream('stash.get', {
      key: assignment.key,
      token: assignment.token,
      name,
    })
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => out.write(chunk))
      stream.once('end', () => {
        stream.end()
        out.end(() => {
          resolve()
        })
      })
      stream.once('abort', (reason: string) => {
        out.destroy()
        reject(new Error(`Stash ${name}: ${reason}`))
      })
    })
    const { renameSync } = await import('node:fs')
    renameSync(partial, target)
  }

  flushSoon(): void {
    if (this.flushing != null) {
      this.again = true
      return
    }
    this.flushing = this.flush()
      .catch(() => undefined)
      .finally(() => {
        this.flushing = undefined
        if (this.again && !this.stopped) {
          this.again = false
          this.flushSoon()
        }
      })
  }

  /** Sends unacknowledged records, pending stashes and finished results, in that order per run. */
  private async flush(): Promise<void> {
    for (const entry of this.journal.runs()) {
      if (this.options.link() == null) return
      if (entry.status === 'reported') continue
      const token = (entry.assignment as { token: string }).token
      for (;;) {
        const records = this.journal.pending(entry.key)
        if (records.length === 0) break
        const answer = await this.request<{ acked: number }>('stage.report', {
          key: entry.key,
          token,
          records,
        })
        this.journal.acknowledge(entry.key, answer.acked)
        if (answer.acked < records[records.length - 1]!.seq) break
      }
      if (entry.status !== 'finished') continue
      for (const upload of this.journal.uploads(entry.key))
        try {
          await this.upload(entry.key, token, upload.name, upload.file)
        } catch (error) {
          if (error instanceof LinkError && error.code === 'closed') throw error
          // A refused stash is not retried; the stages that unstash it fail.
          this.journal.uploaded(entry.key, upload.name)
        }
      if (this.journal.pending(entry.key, 1).length > 0) continue
      await this.request('stage.result', {
        key: entry.key,
        token,
        report: entry.result,
      })
      this.journal.reported(entry.key)
      rmSync(this.path('logs', `${safe(entry.key)}.log`), { force: true })
    }
  }

  /** Removes a finished job's local stashes. */
  forgetJob(job: string): void {
    if (/^[A-Za-z0-9-]{1,64}$/.test(job))
      rmSync(this.path('stashes', job), { recursive: true, force: true })
  }
}
