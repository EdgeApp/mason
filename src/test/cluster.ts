import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
} from '../auth/passwordProtocol.js'
import { baseEnvironment } from '../builder/config.js'
import type { MasterOptions } from '../master/runtime.js'
import { startNode, type NodeOptions, type RunningNode } from '../node/serve.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import { createFirstAdmin } from '../setup/setup.js'
import { listHeads } from '../master/github.js'
import { canonical } from '../worker/gitProxy.js'

const quiet = (): void => undefined

/** A local stand-in for a GitHub repository: a work tree and the bare repository the master fetches. */
export class FakeRepo {
  readonly work: string
  readonly bare: string
  /** An LFS endpoint the master's mirror uses for this repository. */
  lfs?: { url: string; headers: Record<string, string> }
  constructor(
    root: string,
    readonly name: string,
  ) {
    this.work = path.join(root, 'repos', name.replace('/', '__'), 'work')
    this.bare = path.join(root, 'repos', name.replace('/', '__'), 'repo.git')
    mkdirSync(this.work, { recursive: true })
    this.git('init', '-q', '-b', 'master')
    execFileSync('git', ['init', '-q', '--bare', this.bare], {
      env: this.env(),
    })
  }
  private env(): NodeJS.ProcessEnv {
    return {
      ...baseEnvironment(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    }
  }
  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.work,
      env: this.env(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  }
  /** `https://github.com/<name>.git`, as a project names it. */
  get url(): string {
    return canonical(`https://github.com/${this.name}.git`)
  }
  /** Writes files (null deletes), commits them on a branch and pushes it. */
  commit(
    files: Record<string, string | null>,
    branch = 'master',
    message = 'Change',
  ): string {
    const current = this.git('symbolic-ref', '--short', 'HEAD')
    if (current !== branch)
      try {
        this.git('checkout', '-q', branch)
      } catch {
        this.git('checkout', '-q', '-b', branch)
      }
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(this.work, file)
      if (contents == null) rmSync(target, { force: true })
      else {
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, contents)
      }
    }
    this.git('add', '-A')
    this.git('commit', '-q', '--allow-empty', '-m', message)
    this.git('push', '-q', '--force', this.bare, `${branch}:${branch}`)
    return this.git('rev-parse', 'HEAD')
  }
}

export interface WorkerSpec {
  name: string
  type?: string
  labels?: string[]
  slots?: number
  workspaceRoots?: string[]
}

export interface Cluster {
  root: string
  master: RunningNode
  admin: string
  workers: Map<string, RunningNode>
  fingerprints: Map<string, string>
  repos: Map<string, FakeRepo>
  repo(name: string): FakeRepo
  startWorker(spec: WorkerSpec): Promise<RunningNode>
  stopWorker(name: string): Promise<void>
  restartMaster(): Promise<void>
  /** Closes a worker's link and keeps the master from redialing it for `ms`; resolves once it is back. */
  drop(name: string, ms: number, during?: () => Promise<void>): Promise<void>
  fingerprint(name: string): string
  api(
    method: string,
    route: string,
    body?: unknown,
    key?: string,
    // API responses are read field by field in assertions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; json: any; text: string }>
  until<T>(
    check: () => T | undefined | false,
    ms?: number,
    label?: string,
  ): Promise<T>
  close(): Promise<void>
}

/**
 * A master with paired workers over real links, all in this process, and
 * repositories the master fetches from local bare repositories.
 */
export async function cluster(
  root: string,
  options: {
    workers?: WorkerSpec[]
    coWorker?: boolean
    master?: Partial<NodeOptions>
    masterOptions?: NodeOptions['masterOptions']
  } = {},
): Promise<Cluster> {
  const repos = new Map<string, FakeRepo>()
  const remote: MasterOptions['remote'] = async (repository) => {
    const repo = [...repos.values()].find(
      (entry) => entry.url === canonical(repository),
    )
    if (repo == null) throw new Error(`No fixture repository ${repository}`)
    return {
      url: repo.bare,
      env: { ...baseEnvironment(), GIT_CONFIG_NOSYSTEM: '1' },
      ...(repo.lfs == null ? {} : { lfs: repo.lfs }),
    }
  }
  const masterOptions: NodeOptions = {
    role: 'master',
    data: path.join(root, 'master'),
    port: 0,
    listen: '127.0.0.1',
    heartbeatMs: 0,
    redialBaseMs: 50,
    pollMs: 3600000,
    ...(options.coWorker ? { coWorker: true } : {}),
    ...options.master,
    masterOptions: {
      remote,
      headLister: async (project, signal) => {
        const repo = [...repos.values()].find(
          (entry) => entry.url === canonical(project.repository),
        )
        if (repo == null) throw new Error('No fixture repository')
        return await listHeads(repo.bare, baseEnvironment(), signal)
      },
      tickMs: 100,
      graceMs: 1000,
      ...options.masterOptions,
    },
  }
  let master = await startNode(masterOptions, quiet)
  const parameters = clientParameters('0f'.repeat(16), DEFAULT_PASSWORD_COSTS)
  const setup = await createFirstAdmin(
    master.master!.database,
    master.master!.keys,
    {
      username: 'paul',
      clientHash: await clientPasswordHash('Correct-Horse-9', parameters),
      clientParameters: parameters,
      apiKey: true,
    },
  )
  const workers = new Map<string, RunningNode>()
  const fingerprints = new Map<string, string>()
  const until = async <T>(
    check: () => T | undefined | false,
    ms = 30000,
    label = 'condition',
  ): Promise<T> => {
    const deadline = Date.now() + ms
    for (;;) {
      const value = check()
      if (value !== undefined && value !== false) return value
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const specs = new Map<string, WorkerSpec>()
  const startWorker = async (spec: WorkerSpec): Promise<RunningNode> => {
    specs.set(spec.name, spec)
    const node = await startNode(
      {
        role: 'worker',
        data: path.join(root, spec.name),
        linkPort: 0,
        listen: '127.0.0.1',
        heartbeatMs: 0,
        ...(spec.slots == null ? {} : { slots: spec.slots }),
        workerOptions: { flushMs: 50 },
      },
      quiet,
    )
    workers.set(spec.name, node)
    let fingerprint = fingerprints.get(spec.name)
    if (fingerprint == null) {
      const record = await master.master!.registry.add(
        `127.0.0.1:${node.link!.port}`,
        node.pairing!.key()!,
      )
      fingerprint = record.fingerprint
      fingerprints.set(spec.name, fingerprint)
    } else {
      // A restarted worker listens on a new port; point the master at it.
      master
        .master!.database.db.prepare(
          'UPDATE nodes SET port=? WHERE fingerprint=?',
        )
        .run(node.link!.port, fingerprint)
      master.master!.registry.start()
    }
    await master.master!.registry.assign(fingerprint, {
      name: spec.name,
      type: spec.type ?? '',
      labels: spec.labels ?? [],
      slots: spec.slots ?? 1,
      ...(spec.workspaceRoots == null
        ? {}
        : { workspaceRoots: spec.workspaceRoots }),
    })
    // The master learns the worker's inventory once the worker reports its assignment.
    await master.master!.scheduler.connected(
      fingerprint,
      master.master!.registry.link(fingerprint)!,
    )
    await until(
      () =>
        master
          .master!.database.db.prepare(
            'SELECT 1 FROM worker_inventory WHERE fingerprint=?',
          )
          .get(fingerprint),
      10000,
      `${spec.name}'s inventory`,
    )
    return node
  }
  for (const spec of options.workers ?? []) await startWorker(spec)
  const cluster: Cluster = {
    root,
    get master() {
      return master
    },
    admin: setup.token!,
    workers,
    fingerprints,
    repos,
    repo(name) {
      let repo = repos.get(name)
      if (repo == null) {
        repo = new FakeRepo(root, name)
        repos.set(name, repo)
      }
      return repo
    },
    startWorker,
    async stopWorker(name) {
      await workers.get(name)?.close()
      workers.delete(name)
    },
    fingerprint(name) {
      return fingerprints.get(name)!
    },
    async drop(name, ms, during) {
      const fingerprint = fingerprints.get(name)!
      const port = workers.get(name)!.link!.port
      const db = master.master!.database.db
      db.prepare('UPDATE nodes SET port=1 WHERE fingerprint=?').run(fingerprint)
      master.master!.registry.link(fingerprint)?.close()
      await until(
        () => master.master!.registry.link(fingerprint) == null,
        5000,
        `${name} to drop`,
      )
      await new Promise((resolve) => setTimeout(resolve, ms))
      await during?.()
      db.prepare('UPDATE nodes SET port=? WHERE fingerprint=?').run(
        port,
        fingerprint,
      )
      await master.master!.registry.dial(fingerprint)
      await until(
        () => master.master!.registry.link(fingerprint),
        10000,
        `${name} to relink`,
      )
    },
    async restartMaster() {
      await master.close()
      master = await startNode(masterOptions, quiet)
      for (const name of workers.keys())
        await until(
          () => master.master!.registry.link(fingerprints.get(name)!),
          20000,
          `${name} to relink`,
        )
    },
    async api(method, route, body, key) {
      const response = await pinnedFetch(
        master.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:') + route,
        {
          method,
          headers: {
            Authorization: `Bearer ${key ?? setup.token!}`,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        master.identity.pin,
      )
      const text = await response.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
      return { status: response.status, json, text }
    },
    until,
    async close() {
      for (const node of workers.values()) await node.close()
      await master.close()
    },
  }
  return cluster
}
