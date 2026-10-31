import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type {
  ArtifactOptions,
  ArtifactQuery,
  Json,
  NodeInfo,
} from '../../types/mason/index.js'
import { baseEnvironment, relativePath } from '../builder/config.js'
import {
  CommandFailure,
  Execution,
  MaskedLog,
  processSnapshot,
  type ProcessIdentity,
} from '../builder/execution.js'
import { noSymlinks } from '../config.js'
import {
  LinkError,
  type Link,
  type MethodTable,
  type Stream,
} from '../link/link.js'
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
import {
  forgetSecretFiles,
  recoverSecretFiles,
  runStage,
  secretForms,
  type StepRecord,
} from '../pipeline/stage.js'
import { baseInventory } from './baseInventory.js'
import { fullInventory, type FullInventory } from './inventory.js'
import {
  install,
  installable,
  toolEnvironment,
  type InstallRequest,
} from './tools/index.js'
import { defaultSources, fetchText, type ToolSources } from './tools/common.js'
import {
  readProjectTools,
  wantedProjectTools,
  type NodeRelease,
} from './tools/projectTools.js'
import { launchingXcode } from './tools/versions.js'
import type { KeyObject } from 'node:crypto'
import { helperPaths, helperRequest } from '../helper/server.js'
import { runningInstall, type RunningInstall } from '../release/install.js'
import { receiveUpdate, restartProcess } from './update.js'
import type { NodeType } from '../master/nodeTypes.js'
import {
  developerDir,
  systemInventory,
  systemRun,
  type SystemInventory,
  type SystemRun,
} from './system/index.js'
import {
  checklist,
  freeBytes,
  performItem,
  reconcile,
  reconcilePlan,
  type ItemContext,
  type ReconcileItem,
} from './system/reconcile.js'
import {
  prepareXcode,
  removeSimulatorSet,
  simulatorSet,
} from './system/xcode.js'
import { xcodeLaunches } from './system/index.js'
import { checkout } from './checkout.js'
import {
  fetchArtifacts,
  publish,
  save,
  tests,
  type ArtifactContext,
} from './artifacts.js'
import type { TestFormat } from '../pipeline/tests.js'
import { GitBridge } from './gitProxy.js'
import { Journal } from './journal.js'
import { archive, type ArchiveContext, type Exec } from './apple/archive.js'
import {
  notarize,
  testflight,
  type DistributeContext,
} from './apple/distribute.js'
import { spawnExec } from './apple/exec.js'
import {
  createStageKeychain,
  removeStageKeychain,
  stageKeychainPath,
  type Command,
} from './apple/keychain.js'
import {
  exportOptions,
  installProfiles,
  removeProfiles,
  signingSnapshot,
  type SigningSnapshot,
} from './apple/profiles.js'
import type { StageSigning } from '../pipeline/assignment.js'

/** A signing stage's keychain, installed profiles and the settings it shows the stage. */
interface StageApple {
  signing: StageSigning
  keychain: string
  profiles: string[]
  exportOptions: string
  snapshot: SigningSnapshot
}

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
  /** Where Xcodes are installed; `/Applications`. */
  applications?: string
  /** Where installers download from. */
  toolSources?: ToolSources
  /** The paired master's public key, for its signed updates. */
  masterKey?: () => KeyObject | undefined
  /** The privileged helper's socket. */
  helperSocket?: string
  /** How often the worker checks whether its helper appeared. Default 15 s. */
  helperWatchMs?: number
  /** How this Mason was installed; the running process's install by default. */
  install?: RunningInstall
  /** Restarts into a newly installed release; exits for the service manager by default. */
  restart?: () => void
  /** Runs system commands (xcodebuild, simctl, pkgutil, …) as the worker's user. */
  systemRun?: SystemRun
  /** Runs `xcodebuild`, `codesign`, `plutil`, `stapler`; real tools otherwise. */
  appleExec?: Exec
  /** Runs `security` and `openssl` for stage keychains. */
  appleCommand?: Command
  /** The user's home, where Xcode reads provisioning profiles. */
  home?: string
  /** How the worker reaches Apple's upload URLs. */
  appleFetch?: typeof fetch
  /** How often TestFlight and notary progress is asked of the master. */
  applePollMs?: number
  /** Calls the privileged helper; through its socket by default. */
  helper?: (op: string, args: Record<string, unknown>) => Promise<unknown>
}

/** Tools a stage can ask for that the system installs rather than the tools directory. */
const systemTools = ['xcode', 'simulators', 'brew', 'apt', 'dnf'] as const

/**
 * A stage key as one file name: other characters, and `_` itself, become
 * `_<hex>`, so names stay distinct. No `%`, which some tools in a stage's
 * paths read as an escape (Xcode's clang-stat-cache cannot open such a path).
 */
export const safe = (key: string): string =>
  key.replace(/[^A-Za-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)

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
  private installing: Promise<void> = Promise.resolve()
  private readonly busy = new Set<number>()
  private readonly workspaceLocks = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | undefined
  private helperTimer: NodeJS.Timeout | undefined
  private helperSeen = false
  private flushing: Promise<void> | undefined
  private again = false
  private stopped = false
  /** System software and settings, refreshed in the background. */
  private system: SystemInventory | undefined
  private refreshing: Promise<void> | undefined
  /** The node type's definition the master last sent. */
  private nodeType: NodeType | undefined
  private reconciling: Promise<void> | undefined
  private reconcileAgain = false
  /** Xcode bundles running stages use, by run key. */
  private readonly inUse = new Map<string, string>()
  /** Each running stage's Xcode details and private simulator set, by run key. */
  private readonly prepared = new Map<
    string,
    {
      xcode?: NonNullable<NodeInfo['xcode']>
      simulatorSet?: string
      apple?: StageApple
    }
  >()

  constructor(private readonly options: WorkerOptions) {
    this.journal = new Journal(options.db)
    this.bridge = new GitBridge(options.link)
  }

  private path(...parts: string[]): string {
    return path.join(this.options.dir, ...parts)
  }

  /** Recovers from a restart: runs that were in progress have no process any more. */
  async start(): Promise<void> {
    // Signing material a stage held when the worker stopped goes before anything runs.
    for (const held of this.journal.signing())
      await this.releaseSigning(held.key, held.keychain, held.profiles)
    for (const entry of this.journal.runs('running'))
      this.journal.finish(entry.key, {
        status: 'interrupted',
        reason: 'The worker restarted while this ran',
      } satisfies RunReport)
    this.journal.prune()
    this.trustMaster()
    void this.refreshSystem()
    await this.bridge.listen()
    this.timer = setInterval(() => {
      this.flushSoon()
    }, this.options.flushMs ?? 250)
    this.timer.unref()
    // `mason worker --install` starts the worker before its helper.
    this.helperSeen = this.helperReady()
    this.helperTimer = setInterval(() => {
      this.watchHelper()
    }, this.options.helperWatchMs ?? 15_000)
    this.helperTimer.unref()
  }

  /**
   * When the helper appears or goes, hands it the master's key and tells the
   * master, so the node's checklist and placement follow at once.
   */
  watchHelper(): void {
    const ready = this.helperReady()
    if (ready === this.helperSeen || this.stopped) return
    this.helperSeen = ready
    if (ready) this.trustMaster()
    void this.refreshSystem()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    clearInterval(this.helperTimer)
    for (const controller of this.controllers.values())
      controller.abort(new Error('The worker is stopping'))
    // Stopped runs finish writing their journal before the database closes.
    await Promise.allSettled([...this.executions])
    await this.flushing
    this.bridge.close()
  }

  private get run(): SystemRun {
    return this.options.systemRun ?? systemRun
  }

  private async helper(
    op: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return await (
      this.options.helper ??
      ((name, values): Promise<unknown> =>
        helperRequest(this.helperSocket, name, values))
    )(op, args)
  }

  private helperReady(): boolean {
    return existsSync(this.helperSocket)
  }

  /** Re-reads system software and settings, then tells the master. */
  async refreshSystem(): Promise<void> {
    if (this.refreshing != null) return await this.refreshing
    this.refreshing = (async (): Promise<void> => {
      if (this.stopped) return
      const base = this.inventory()
      const system = await systemInventory({
        os: base.os,
        arch: base.arch,
        xcodes: base.xcodes,
        run: this.run,
      })
      // A worker that stopped meanwhile has closed its journal.
      if (this.stopped) return
      this.system = system
      const link = this.options.link()
      if (link != null && !link.closed && !this.stopped)
        try {
          link.event('node.inventory', { inventory: this.inventory() })
        } catch {
          // The next connection sends it.
        }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = undefined
      })
    return await this.refreshing
  }

  inventory(): FullInventory {
    const assigned = this.options.assignment()
    const quarantine = this.journal.quarantine()
    const full = this.baseFull(assigned, quarantine)
    const system = this.system
    const xcodes = full.xcodes.map((install) => {
      const launch = system?.launches[install.path]
      return launch == null
        ? install
        : {
            ...install,
            launches: launch.ok,
            ...(launch.error == null ? {} : { launchError: launch.error }),
          }
    })
    const state = {
      inventory: { ...full, xcodes, ...(system == null ? {} : { system }) },
      inUse: [...this.inUse.values()],
    }
    return {
      ...state.inventory,
      checklist: checklist(this.nodeType, state, full.helper === 'ready'),
    }
  }

  private baseFull(
    assigned: ReturnType<WorkerOptions['assignment']>,
    quarantine: string | undefined,
  ): FullInventory {
    return {
      ...fullInventory(
        baseInventory({
          dir: this.options.dir,
          ...(assigned == null ? {} : assigned),
          version: this.options.version,
          ...(this.options.slots == null ? {} : { slots: this.options.slots }),
          ...(quarantine == null ? {} : { quarantine }),
        }),
        {
          toolsDir: this.path('tools'),
          ...(this.options.applications == null
            ? {}
            : { applications: this.options.applications }),
        },
      ),
      helper: this.helperReady() ? 'ready' : 'missing',
    }
  }

  /** What system items need from the node and the master. */
  private itemContext(log: (text: string) => void): ItemContext {
    return {
      log,
      helper: async (op, args): Promise<unknown> => await this.helper(op, args),
      authorize: async (
        version,
      ): Promise<{ url: string; cookie: string; pin?: string }> => {
        const link = this.options.link()
        if (link == null) throw new Error('The master is not connected')
        return (await link.request(
          'xcode.authorize',
          { version },
          5 * 60 * 1000,
        )) as { url: string; cookie: string; pin?: string }
      },
      mirror: async (version, file): Promise<void> => {
        await this.mirrorXcode(version, file)
      },
      installTool: async (request): Promise<void> => {
        const answer = await this.installTool(request)
        log(answer.log)
        if (!answer.ok) throw new Error(answer.error)
      },
      fetchRuntime: async (name, file): Promise<boolean> =>
        await this.fetchRuntime(name, file),
      storeRuntime: async (name, file): Promise<void> => {
        await this.storeRuntime(name, file)
      },
      run: this.run,
      scratch: this.path('tmp', 'system'),
      xcodes: () => this.inventory().xcodes,
      launches: async (install) => (await xcodeLaunches(install, this.run)).ok,
    }
  }

  /** Brings the node to its type's state; a request during a pass runs another pass after it. */
  reconcileType(type: NodeType | undefined): Promise<void> {
    if (type != null) this.nodeType = type
    if (this.reconciling != null) {
      this.reconcileAgain = true
      return this.reconciling
    }
    this.reconciling = (async (): Promise<void> => {
      do {
        this.reconcileAgain = false
        const current = this.nodeType
        if (current == null || this.stopped) return
        await this.refreshSystem()
        const plan = reconcilePlan(current, {
          inventory: this.inventory(),
          inUse: [...this.inUse.values()],
        })
        if (plan.length === 0) continue
        let log = ''
        const results = await reconcile(plan, {
          ...this.itemContext((text) => {
            log += text
          }),
          helperReady: this.helperReady(),
          progress: (progress) => {
            this.options.link()?.event('node.progress', progress)
          },
          freeDisk: () => freeBytes(this.options.dir),
          thresholdBytes: current.diskThresholdGb * 1024 ** 3,
        })
        await this.refreshSystem()
        this.options.link()?.event('node.reconciled', {
          results,
          log: log.slice(-64 * 1024),
          inventory: this.inventory(),
        })
      } while (this.reconcileAgain && !this.stopped)
    })()
      .catch(() => undefined)
      .finally(() => {
        this.reconciling = undefined
      })
    return this.reconciling
  }

  /** Streams a downloaded Xcode to the master, which copies it to the host; refused once mirrored. */
  private async mirrorXcode(version: string, file: string): Promise<void> {
    const link = this.options.link()
    if (link == null) return
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file))
      hash.update(chunk as Buffer)
    const stream = link.openStream('xcode.mirror', {
      version,
      sha256: hash.digest('hex'),
      size: lstatSync(file).size,
    })
    const done = new Promise<void>((resolve, reject) => {
      stream.once('end', () => {
        resolve()
      })
      stream.once('abort', (reason: string) => {
        reject(new Error(reason))
      })
    })
    done.catch(() => undefined)
    try {
      for await (const chunk of createReadStream(file))
        await stream.write(chunk as Buffer)
      stream.end()
    } catch {
      // Refused (already mirrored, no host): the install goes on.
    }
    await done
  }

  private async fetchRuntime(name: string, file: string): Promise<boolean> {
    const link = this.options.link()
    if (link == null) throw new Error('The master is not connected')
    const { stored } = (await link.request('runtime.lookup', { name })) as {
      stored: boolean
    }
    if (!stored) return false
    const out = createWriteStream(file, { mode: 0o600 })
    const stream = link.openStream('runtime.get', { name })
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
        reject(new Error(`Runtime ${name}: ${reason}`))
      })
    })
    return true
  }

  private async storeRuntime(name: string, file: string): Promise<void> {
    const link = this.options.link()
    if (link == null) throw new Error('The master is not connected')
    const stream = link.openStream('runtime.put', { name })
    const done = new Promise<void>((resolve, reject) => {
      stream.once('end', () => {
        resolve()
      })
      stream.once('abort', (reason: string) => {
        reject(new Error(`Runtime ${name}: ${reason}`))
      })
    })
    done.catch(() => undefined)
    for await (const chunk of createReadStream(file))
      await stream.write(chunk as Buffer)
    stream.end()
    await done
  }

  /** A stage's system tools as reconciliation items: an Xcode, runtimes, packages. */
  private systemItems(request: {
    tool: string
    version?: string
    packages?: string[]
  }): ReconcileItem[] {
    const packages = request.packages ?? []
    switch (request.tool) {
      case 'xcode':
        return [
          {
            id: `xcode:${request.version ?? ''}`,
            kind: 'xcode',
            version: request.version ?? '',
          },
        ]
      case 'simulators':
        return packages.map((name) => ({
          id: `runtime:${name}`,
          kind: 'runtime',
          name,
        }))
      case 'brew':
        return packages.map((formula) => ({
          id: `brew:${formula}`,
          kind: 'brew',
          formula,
        }))
      default:
        return packages.map((name) => ({
          id: `${request.tool}:${name}`,
          kind: request.tool as 'apt' | 'dnf',
          package: name,
        }))
    }
  }

  /**
   * Runs one installer from the closed set, one at a time. The installer's
   * log comes back with the result, and the inventory after it.
   */
  private async installTool(params: unknown): Promise<{
    ok: boolean
    version?: string
    error?: string
    log: string
    inventory: FullInventory
  }> {
    const request = params as InstallRequest
    let log = ''
    const previous = this.installing
    let done!: () => void
    this.installing = new Promise<void>((resolve) => {
      done = resolve
    })
    await previous
    try {
      if ((systemTools as readonly string[]).includes(request?.tool)) {
        if (!this.helperReady())
          throw new Error(
            'The helper is not installed: run sudo mason worker --install',
          )
        const context = this.itemContext((text) => {
          log += text
        })
        // Tools-directory installs inside an item would wait on this one.
        context.installTool = async (): Promise<void> => {
          throw new Error('Not a system tool')
        }
        for (const item of this.systemItems(request))
          await performItem(item, context)
        await this.refreshSystem()
        return { ok: true, log, inventory: this.inventory() }
      }
      if (!(installable as readonly string[]).includes(request?.tool))
        throw new Error(`${String(request?.tool)} is not a tool Mason installs`)
      const base = this.inventory()
      // CocoaPods' native gems compile with the Xcode the stage asked for,
      // which an earlier request of the same stage may just have installed.
      let xcodeDir: string | undefined
      if (request.tool === 'cocoapods' && request.xcode != null) {
        const xcode = launchingXcode(request.xcode, base.xcodes ?? [])
        if (xcode == null)
          throw new Error(
            `No installed Xcode matches ${request.xcode}, which CocoaPods' native gems compile with`,
          )
        xcodeDir = developerDir(xcode.path)
      }
      const version = await install(request, {
        toolsDir: this.path('tools'),
        sources: this.options.toolSources ?? defaultSources,
        os: base.os,
        arch: base.arch,
        log: (text) => {
          log += text
        },
        ...(xcodeDir == null ? {} : { developerDir: xcodeDir }),
      })
      return { ok: true, version, log, inventory: this.inventory() }
    } catch (error) {
      return {
        ok: false,
        error: (error as Error).message,
        log,
        inventory: this.inventory(),
      }
    } finally {
      done()
    }
  }

  /**
   * Before a cloud machine is snapshotted: removes its identity, pairing,
   * stage directories and Mason keychains, keeps its tools and caches, takes
   * no further stage, and reports anything that would not go.
   */
  scrub(): { removed: string[]; remaining: string[] } {
    this.stopped = true
    for (const controller of this.controllers.values())
      controller.abort(new Error('The machine is retiring'))
    const targets = [
      ...[
        'identity.key',
        'identity.pub',
        'tls.crt',
        'tls.key',
        'pairing.json',
        'pairing-file.json',
        'master.json',
        'assigned.json',
      ].map((name) => this.path(name)),
      ...['checkouts', 'workspaces', 'sources', 'tmp', 'logs', 'keychains'].map(
        (name) => this.path(name),
      ),
    ]
    const keychains = path.join(
      process.env.HOME ?? '/nonexistent',
      'Library',
      'Keychains',
    )
    if (existsSync(keychains))
      for (const name of readdirSync(keychains))
        if (/^mason-.*\.keychain(-db)?$/.test(name))
          targets.push(path.join(keychains, name))
    const removed: string[] = []
    for (const target of targets) {
      if (!existsSync(target)) continue
      rmSync(target, { recursive: true, force: true })
      removed.push(path.basename(target))
    }
    return {
      removed,
      remaining: targets
        .filter((target) => existsSync(target))
        .map((target) => path.basename(target)),
    }
  }

  /** Clears the quarantine after an operator checked the node (`mason recover`). */
  recover(): void {
    this.journal.setQuarantine(undefined)
  }

  /** Methods the worker accepts from its master. */
  private get helperSocket(): string {
    return (
      this.options.helperSocket ??
      helperPaths(process.platform === 'darwin' ? 'darwin' : 'linux').socket
    )
  }

  /**
   * Hands the master's key to the privileged helper, which keeps the first
   * one it gets and refuses any other. Without a helper this waits for
   * `sudo mason worker --install`.
   */
  trustMaster(): void {
    const key = this.options.masterKey?.()
    if (key == null) return
    void helperRequest(this.helperSocket, 'key.set', {
      publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64'),
    }).catch(() => undefined)
  }

  methods(): MethodTable {
    const install = this.options.install ?? runningInstall()
    return {
      streams: {
        'update.install': async (stream, params): Promise<void> => {
          await receiveUpdate(stream, params, {
            masterKey: () => this.options.masterKey?.(),
            version: this.options.version,
            busy: () => this.executions.size > 0,
            install,
            scratch: this.path('tmp', 'updates'),
            helperSocket: this.helperSocket,
            restart: () => {
              ;(this.options.restart ?? ((): void => restartProcess(install)))()
            },
          })
        },
      },
      requests: {
        'worker.state': () => ({
          inventory: this.inventory(),
          runs: this.journal
            .runs()
            .map((entry) => ({ key: entry.key, status: entry.status })),
        }),
        'setup.run': (params) => this.accept(params as SetupAssignment),
        'stage.run': (params) => this.accept(params as StageAssignment),
        'tools.install': async (params) => await this.installTool(params),
        'node.scrub': (): { removed: string[]; remaining: string[] } =>
          this.scrub(),
        'node.reconcile': (params): { started: true } => {
          const type = (params as { type?: NodeType }).type
          void this.reconcileType(type)
          return { started: true }
        },
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

  /** A stage's private directory; its checkout's secret-file list sits beside it. */
  private stageDir(key: string): string {
    return this.path('tmp', `stage-${safe(key)}`)
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
      // Before the checkout moves the tree: what a dead worker's secret files
      // replaced goes back onto the commit it came from.
      if (assignment.kind !== 'setup') {
        recoverSecretFiles(dir, this.stageDir(assignment.key), say)
        await this.prepareStage(assignment, say)
      }
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
      // A clean checkout reset the tree: whatever recovery could not clean is gone.
      if (assignment.kind !== 'setup' && assignment.workspace.mode === 'clean')
        forgetSecretFiles(dir, this.stageDir(assignment.key))
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
      await this.releaseStage(key)
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
      // Stages that need Xcode and name none use the repository's .xcode-version.
      const file = path.join(dir, '.xcode-version')
      const xcodeVersion =
        existsSync(file) &&
        lstatSync(file).isFile() &&
        lstatSync(file).size < 256
          ? readFileSync(file, 'utf8')
          : undefined
      const wanted = wantedProjectTools(graph)
      const tools =
        wanted.length === 0
          ? undefined
          : await readProjectTools(
              dir,
              wanted,
              async () =>
                JSON.parse(
                  await fetchText(
                    `${(this.options.toolSources ?? defaultSources).node}/index.json`,
                    signal,
                  ),
                ) as NodeRelease[],
            )
      return {
        status: 'succeeded',
        value: graph as Json,
        ...(xcodeVersion == null ? {} : { xcodeVersion }),
        ...(tools == null ? {} : { projectTools: tools }),
      }
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

  /**
   * Readies a stage's Xcode (first launch when needed; the log starts with
   * `xcodebuild -version`, path and SDKs) and, for a stage that lists
   * simulators, a device set of its own.
   */
  private async prepareStage(
    assignment: StageAssignment,
    log: (text: string) => void,
  ): Promise<void> {
    const prepared: {
      xcode?: NonNullable<NodeInfo['xcode']>
      simulatorSet?: string
      apple?: StageApple
    } = {}
    this.prepared.set(assignment.key, prepared)
    if (assignment.developerDir != null) {
      this.inUse.set(
        assignment.key,
        path.dirname(path.dirname(assignment.developerDir)),
      )
      prepared.xcode = await prepareXcode(assignment.developerDir, {
        run: this.run,
        helper: async (op, args) => await this.helper(op, args),
        log,
      })
    }
    if ((assignment.tools?.simulators ?? []).length > 0)
      prepared.simulatorSet = simulatorSet(this.stageDir(assignment.key))
    if (assignment.apple != null) {
      const signing = assignment.apple
      const dir = this.path('keychains')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const keychain = stageKeychainPath(dir, assignment.key)
      // Recorded first, so a crash before the stage ends still removes it.
      this.journal.setSigning(assignment.key, { keychain, profiles: [] })
      await createStageKeychain(
        keychain,
        signing.identity,
        this.options.appleCommand,
      )
      const profiles = installProfiles(signing, this.options.home)
      this.journal.setSigning(assignment.key, { keychain, profiles })
      const exportFile = path.join(
        this.stageDir(assignment.key),
        'ExportOptions.plist',
      )
      mkdirSync(path.dirname(exportFile), { recursive: true, mode: 0o700 })
      writeFileSync(exportFile, exportOptions(signing))
      prepared.apple = {
        signing,
        keychain,
        profiles,
        exportOptions: exportFile,
        snapshot: signingSnapshot(signing, keychain, exportFile),
      }
      log(
        `Signing with ${signing.identity.name}; profiles ${signing.profiles.map((profile) => profile.name).join(', ')}\n`,
      )
    }
  }

  /** Removes a stage's keychain from the search list and deletes it with the profiles it installed. */
  private async releaseSigning(
    key: string,
    keychain: string,
    profiles: string[],
  ): Promise<void> {
    await removeStageKeychain(keychain, this.options.appleCommand).catch(
      () => undefined,
    )
    removeProfiles(profiles)
    this.journal.clearSigning(key)
  }

  /** Removes a stage's simulators and, when disk is short, lets reconciliation clean up. */
  private async releaseStage(key: string): Promise<void> {
    const prepared = this.prepared.get(key)
    this.prepared.delete(key)
    this.inUse.delete(key)
    for (const held of this.journal.signing())
      if (held.key === key)
        await this.releaseSigning(held.key, held.keychain, held.profiles)
    if (prepared?.simulatorSet != null)
      await removeSimulatorSet(
        prepared.simulatorSet,
        this.run,
        prepared.xcode == null
          ? {}
          : {
              DEVELOPER_DIR: path.join(
                prepared.xcode.path,
                'Contents',
                'Developer',
              ),
            },
      ).catch(() => undefined)
    const type = this.nodeType
    if (
      type != null &&
      !this.stopped &&
      freeBytes(this.options.dir) < type.diskThresholdGb * 1024 ** 3
    )
      void this.reconcileType(undefined)
  }

  /** A stage's non-secret environment, with its tools first on `PATH` and its Xcode. */
  private stageEnvironment(
    assignment: StageAssignment,
  ): Record<string, string> {
    const prepared = this.prepared.get(assignment.key)
    return {
      ...(prepared?.simulatorSet == null
        ? {}
        : { MASON_SIMULATOR_SET: prepared.simulatorSet }),
      ...assignment.env,
      ...toolEnvironment(
        assignment.tools,
        this.path('tools'),
        process.env.PATH ?? '',
      ),
      ...(assignment.developerDir == null
        ? {}
        : { DEVELOPER_DIR: assignment.developerDir }),
    }
  }

  private node(key?: string): NodeInfo {
    const inventory = this.inventory()
    const prepared = key == null ? undefined : this.prepared.get(key)
    return {
      name: inventory.name,
      type: inventory.type,
      os: inventory.os,
      arch: inventory.arch,
      labels: inventory.labels,
      ...(prepared?.xcode == null ? {} : { xcode: prepared.xcode }),
      ...(prepared?.simulatorSet == null
        ? {}
        : { simulatorSet: prepared.simulatorSet }),
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
    const privateDir = this.stageDir(assignment.key)
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
        node: this.node(assignment.key),
        env: this.stageEnvironment(assignment),
        secrets: assignment.secrets,
        files: assignment.files,
        buildNumbers: assignment.buildNumbers,
        outputs: assignment.outputs,
        ...(this.prepared.get(assignment.key)?.apple == null
          ? {}
          : {
              apple: {
                signing: this.prepared.get(assignment.key)!.apple!.snapshot,
              },
            }),
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
        ...this.stageEnvironment(assignment),
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
      case 'apple.archive':
        return await archive(
          this.appleContext(assignment, dir, say),
          args[1] as never,
        )
      case 'apple.testflight':
        return await testflight(
          this.distributeContext(assignment, dir, say),
          args[1] as never,
        )
      case 'apple.notarize':
        return await notarize(
          this.distributeContext(assignment, dir, say),
          args[1] as never,
        )
      case 'publish':
        return await publish(
          this.artifactContext(assignment, dir, say),
          args[1] as never,
        )
      case 'artifacts.save': {
        const [name, paths, options] = args as [
          string,
          string | string[],
          ArtifactOptions,
        ]
        await save(
          this.artifactContext(assignment, dir, say),
          name,
          paths,
          options,
        )
        return null
      }
      case 'artifacts.fetch': {
        const [query, into] = args as [ArtifactQuery, string]
        return await fetchArtifacts(
          this.artifactContext(assignment, dir, say),
          query,
          into,
        )
      }
      case 'tests': {
        const [format, paths] = args as [TestFormat, string | string[]]
        return await tests(
          this.artifactContext(assignment, dir, say),
          format,
          paths,
        )
      }
      default:
        throw new Error(`${method} is not available on this node yet`)
    }
  }

  /** Keeps a log file as a run artifact when the stage can save artifacts. */
  private keeper(
    assignment: StageAssignment,
    dir: string,
    say: (text: string) => void,
  ): ((name: string, file: string) => Promise<void>) | undefined {
    if (assignment.uploads == null) return undefined
    return async (name, file): Promise<void> => {
      const copy = path.join(dir, '.mason-logs', path.basename(file))
      mkdirSync(path.dirname(copy), { recursive: true })
      copyFileSync(file, copy)
      await save(
        this.artifactContext(assignment, dir, say),
        name,
        path.relative(dir, copy),
        { kind: 'file' },
      )
    }
  }

  private appleContext(
    assignment: StageAssignment,
    dir: string,
    say: (text: string) => void,
  ): ArchiveContext {
    const prepared = this.prepared.get(assignment.key)?.apple
    if (prepared == null)
      throw new Error('This stage declared no Apple signing')
    const scratch = path.join(this.stageDir(assignment.key), 'apple')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    const keep = this.keeper(assignment, dir, say)
    return {
      dir,
      scratch,
      signing: prepared.signing,
      keychain: prepared.keychain,
      exportOptions: prepared.exportOptions,
      exec: this.appleExec(assignment),
      log: say,
      entitlements: async (values) =>
        await this.request('apple.entitlements', {
          key: assignment.key,
          token: assignment.token,
          entitlements: values,
        }),
      reinstall: (profiles): void => {
        removeProfiles(prepared.profiles)
        prepared.signing = { ...prepared.signing, profiles }
        prepared.profiles = installProfiles(prepared.signing, this.options.home)
        this.journal.setSigning(assignment.key, {
          keychain: prepared.keychain,
          profiles: prepared.profiles,
        })
        writeFileSync(prepared.exportOptions, exportOptions(prepared.signing))
      },
      ...(keep == null ? {} : { keep }),
    }
  }

  /**
   * Runs the Apple steps' tools (xcodebuild, xcrun) with the stage's
   * environment under the call's own, so build phases see the stage's tools
   * and Xcode as `ctx.sh` does.
   */
  private appleExec(assignment: StageAssignment): Exec {
    const exec = this.options.appleExec ?? spawnExec
    return async (file, args, options) =>
      await exec(file, args, {
        ...options,
        env: { ...this.stageEnvironment(assignment), ...options.env },
      })
  }

  private distributeContext(
    assignment: StageAssignment,
    dir: string,
    say: (text: string) => void,
  ): DistributeContext {
    if (this.prepared.get(assignment.key)?.apple == null)
      throw new Error('This stage declared no Apple signing')
    const scratch = path.join(this.stageDir(assignment.key), 'apple')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    const keep = this.keeper(assignment, dir, say)
    return {
      dir,
      scratch,
      request: async <T>(
        method: string,
        params: Record<string, unknown>,
      ): Promise<T> =>
        await this.request<T>(
          method,
          { ...params, key: assignment.key, token: assignment.token },
          5 * 60_000,
        ),
      connected: async (): Promise<void> => {
        const controller = this.controllers.get(assignment.key)
        await this.connected(controller?.signal ?? new AbortController().signal)
      },
      exec: this.appleExec(assignment),
      log: say,
      ...(keep == null ? {} : { keep }),
      ...(this.options.appleFetch == null
        ? {}
        : { fetch: this.options.appleFetch }),
      ...(this.options.applePollMs == null
        ? {}
        : { pollMs: this.options.applePollMs }),
    }
  }

  private artifactContext(
    assignment: StageAssignment,
    dir: string,
    say: (text: string) => void,
  ): ArtifactContext {
    return {
      assignment,
      dir,
      scratch: this.path('tmp', 'artifacts'),
      request: async <T>(method: string, params: unknown): Promise<T> =>
        await this.request<T>(method, params, 5 * 60_000),
      stream: (method: string, params: unknown): Stream => {
        const link = this.options.link()
        if (link == null || link.closed)
          throw new LinkError('The master is not connected', 'closed')
        return link.openStream(method, params)
      },
      connected: async (): Promise<void> => {
        const controller = this.controllers.get(assignment.key)
        await this.connected(controller?.signal ?? new AbortController().signal)
      },
      journal: (kind, data): void => {
        this.journal.append(assignment.key, kind, data)
      },
      select,
      log: say,
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
