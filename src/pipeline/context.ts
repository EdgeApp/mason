import { spawn } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CommandOptions,
  CommandResult,
  Duration,
  Json,
  NodeInfo,
  RunInfo,
  Stage,
} from '../../types/mason/index.js'
import { globExpression } from '../master/rules.js'
import { seconds } from './graph.js'
import type { StepChannel } from './steps.js'

/** Everything a stage run needs, sent to the runner over the step channel. */
export interface StageSnapshot {
  /** Absolute path of the Masonfile. */
  masonfile: string
  /** The export to call. */
  function: string
  workspace: string
  /** Owner-only directory for secret files; deleted after the stage. */
  privateDir: string
  run: RunInfo
  stage: {
    name: string
    attempt: number
    matrix: Record<string, string | number | boolean>
  }
  node: NodeInfo
  /** Non-secret environment: the workflow's and the stage's. */
  env: Record<string, string>
  /** Only the secrets the stage declared. */
  secrets: Record<string, string>
  /** Only the secret files the stage declared, by name. */
  files: Record<string, string>
  buildNumbers: Record<string, string>
  /** Outputs of stages that finished before this one was assigned. */
  outputs: Record<string, Json>
  apple?: { signing: Stage['apple']['signing'] }
}

export class CommandError extends Error {
  constructor(
    readonly result: CommandResult,
    command: string,
  ) {
    super(`Command failed with exit code ${result.code}: ${command}`)
  }
}

const captureLimit = 1024 * 1024
const colour = { FORCE_COLOR: '1', CLICOLOR_FORCE: '1', TERM: 'xterm-256color' }

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Stage cancelled')
}

/** Resolves `relative` inside `root`, refusing a path or symlink that leaves it. */
export function inside(root: string, relative: string): string {
  const base = realpathSync(root)
  const target = path.resolve(base, relative)
  let existing = target
  while (!existsSync(existing)) existing = path.dirname(existing)
  const real = path.join(
    realpathSync(existing),
    path.relative(existing, target),
  )
  if (real !== base && !real.startsWith(base + path.sep))
    throw new Error(`${relative} is outside the workspace`)
  return real
}

async function walk(root: string, limit = 100000): Promise<string[]> {
  const out: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, dir), {
      withFileTypes: true,
    })) {
      if (entry.name === '.git') continue
      const relative = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) await visit(relative)
      else if (entry.isFile()) {
        out.push(relative)
        if (out.length > limit) throw new Error('Too many files to glob')
      }
    }
  }
  await visit('')
  return out.sort()
}

export interface ContextResult {
  unstable?: string
}

/**
 * The `Stage` context a stage function receives. Commands stream into the
 * runner's stdout and stderr, which the worker's masked log records; secrets
 * are handed out only by `secret` and `secretFile`, never through
 * `process.env`; worker services go over the step channel.
 */
export function createContext(
  snapshot: StageSnapshot,
  channel: StepChannel,
  signal: AbortSignal,
  out: ContextResult,
): Stage {
  const write = (text: string): void => {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n')
  }
  const step = async <T>(
    kind: string,
    title: string,
    body: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now()
    channel.notify('step', { kind, title, status: 'running' })
    try {
      const value = await body()
      channel.notify('step', {
        kind,
        title,
        status: 'succeeded',
        ms: Date.now() - started,
      })
      return value
    } catch (error) {
      channel.notify('step', {
        kind,
        title,
        status: 'failed',
        ms: Date.now() - started,
      })
      throw error
    }
  }
  const service = async <T>(method: string, ...args: unknown[]): Promise<T> =>
    await step(
      method,
      `${method} ${typeof args[0] === 'string' ? args[0] : ''}`.trim(),
      async () => await channel.request<T>('step', { method, args }),
    )
  const sleep = async (
    duration: Duration | number,
    abort = signal,
  ): Promise<void> => {
    const ms =
      typeof duration === 'number' ? duration : seconds(duration) * 1000
    if (abort.aborted) throw abortError(abort)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        abort.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(abortError(abort))
      }
      abort.addEventListener('abort', onAbort, { once: true })
    })
  }

  const command = async (
    file: string,
    args: string[],
    shown: string,
    options: CommandOptions = {},
  ): Promise<CommandResult> => {
    if (signal.aborted) throw abortError(signal)
    const cwd = inside(snapshot.workspace, options.cwd ?? '.')
    const env = {
      ...process.env,
      ...(options.color === false ? {} : colour),
      ...(options.env ?? {}),
    }
    write(`$ ${shown}`)
    return await step(
      file === '/bin/sh' ? 'sh' : 'exec',
      shown,
      async () =>
        await new Promise<CommandResult>((resolve, reject) => {
          const child = spawn(file, args, {
            cwd,
            env,
            detached: true,
            stdio: [options.input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          })
          let stdout = ''
          let stderr = ''
          // A quiet command's output in arrival order, for its failure.
          let recent = ''
          const keep = (data: Buffer): void => {
            if (options.quiet === true)
              recent = (recent + data.toString()).slice(-64 * 1024)
          }
          const kill = (): void => {
            try {
              if (child.pid != null) process.kill(-child.pid, 'SIGTERM')
            } catch {
              // The process group is already gone.
            }
          }
          const timer =
            options.timeout == null
              ? undefined
              : setTimeout(
                  () => {
                    write(
                      `Command timed out after ${options.timeout}: ${shown}`,
                    )
                    kill()
                  },
                  seconds(options.timeout) * 1000,
                )
          signal.addEventListener('abort', kill, { once: true })
          child.stdout!.on('data', (data: Buffer) => {
            if (stdout.length < captureLimit) stdout += data.toString()
            if (options.quiet !== true) process.stdout.write(data)
            keep(data)
          })
          child.stderr!.on('data', (data: Buffer) => {
            if (stderr.length < captureLimit) stderr += data.toString()
            if (options.quiet !== true) process.stderr.write(data)
            keep(data)
          })
          if (options.input != null) child.stdin?.end(options.input)
          child.once('error', (error) => {
            clearTimeout(timer)
            signal.removeEventListener('abort', kill)
            reject(error)
          })
          child.once('close', (code, killedBy) => {
            clearTimeout(timer)
            signal.removeEventListener('abort', kill)
            const result = {
              code: code ?? (killedBy == null ? 1 : 128),
              stdout: stdout.slice(0, captureLimit),
              stderr: stderr.slice(0, captureLimit),
            }
            if (signal.aborted) reject(abortError(signal))
            else if (result.code !== 0 && options.allowFailure !== true) {
              const tail = recent.trimEnd().split('\n').slice(-40).join('\n')
              if (tail !== '')
                write(`The quiet command failed; its last lines:\n${tail}`)
              reject(new CommandError(result, shown))
            } else resolve(result)
          })
        }),
    )
  }

  const declared = (
    kind: 'secret' | 'secret file',
    names: Record<string, string>,
    name: string,
  ): string => {
    const value = names[name]
    if (value == null)
      throw new Error(
        `Stage ${snapshot.stage.name} did not declare the ${kind} ${name}`,
      )
    return value
  }
  const secretFiles = new Map<string, string>()

  const context: Stage = {
    run: Object.freeze({ ...snapshot.run }),
    stage: Object.freeze({
      ...snapshot.stage,
      matrix: Object.freeze({ ...snapshot.stage.matrix }),
    }),
    node: Object.freeze({ ...snapshot.node }),
    workspace: snapshot.workspace,
    signal,
    sh: async (line, options) =>
      await command('/bin/sh', ['-c', line], line, options),
    exec: async (file, args = [], options) =>
      await command(file, args, [file, ...args].join(' '), options),
    secret: (name) => declared('secret', snapshot.secrets, name),
    secretFile: (name) => {
      const contents = declared('secret file', snapshot.files, name)
      let file = secretFiles.get(name)
      if (file == null) {
        file = path.join(snapshot.privateDir, `secret-${secretFiles.size + 1}`)
        // Owner-only, and never replacing a file that is already there.
        writeFileSync(file, contents, { mode: 0o600, flag: 'wx' })
        secretFiles.set(name, file)
      }
      return file
    },
    output: async <T extends Json = Json>(name: string): Promise<T> => {
      if (name in snapshot.outputs) return snapshot.outputs[name] as T
      return await channel.request<T>('output', { stage: name })
    },
    getBuildNumber: (key) => {
      const value = snapshot.buildNumbers[key]
      if (value == null)
        throw new Error(
          `Stage ${snapshot.stage.name} has no build number for ${key}; list it in buildNumbers or publishes`,
        )
      return value
    },
    stash: async (name, paths, options) =>
      await service('stash', name, paths, options ?? {}),
    unstash: async (name, options) =>
      await service('unstash', name, options ?? {}),
    artifacts: {
      save: async (name, paths, options) =>
        await service('artifacts.save', name, paths, options ?? {}),
      fetch: async (query, into) =>
        await service('artifacts.fetch', query, into),
    },
    tests: async (format, paths, options) =>
      await service('tests', format, paths, options ?? {}),
    publish: async (options) => await service('publish', options.app, options),
    log: {
      info: (message) => {
        write(message)
      },
      warn: (message) => {
        write(`\u001b[33mwarning: ${message}\u001b[0m`)
      },
      error: (message) => {
        write(`\u001b[31merror: ${message}\u001b[0m`)
      },
      section: async (title, body) => {
        write(`::group::${title}`)
        try {
          return await step('section', title, async () => await body())
        } finally {
          write('::endgroup::')
        }
      },
    },
    describe: (text) => {
      channel.notify('describe', { text: String(text).slice(0, 200) })
    },
    unstable: (reason) => {
      out.unstable = String(reason)
    },
    retry: async (attempts, body) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await body()
        } catch (error) {
          if (attempt >= attempts || signal.aborted) throw error
          write(
            `Attempt ${attempt} of ${attempts} failed: ${(error as Error).message}`,
          )
        }
      }
    },
    timeout: async (duration, body) => {
      const limit = AbortSignal.timeout(seconds(duration) * 1000)
      const both = AbortSignal.any([signal, limit])
      return await new Promise((resolve, reject) => {
        const onAbort = (): void => {
          reject(
            limit.aborted
              ? new Error(`Timed out after ${duration}`)
              : abortError(signal),
          )
        }
        both.addEventListener('abort', onAbort, { once: true })
        body(both)
          .then(resolve, reject)
          .finally(() => {
            both.removeEventListener('abort', onAbort)
          })
      })
    },
    sleep: async (duration) => {
      await sleep(duration)
    },
    waitUntil: async (condition, options = {}) => {
      const deadline = Date.now() + seconds(options.timeout ?? '10m') * 1000
      const interval = seconds(options.interval ?? '5s') * 1000
      for (;;) {
        if (await condition()) return
        if (Date.now() >= deadline)
          throw new Error(
            `Condition not met within ${options.timeout ?? '10m'}`,
          )
        await sleep(Math.min(interval, Math.max(0, deadline - Date.now())))
      }
    },
    cache: {
      restore: async (key, paths) => await service('cache.restore', key, paths),
      save: async (key, paths) => await service('cache.save', key, paths),
    },
    checkout: async (options) =>
      await service('checkout', options.repository, options),
    fs: {
      stat: async (file) => {
        const info = await stat(inside(snapshot.workspace, file))
        return {
          size: info.size,
          isFile: info.isFile(),
          isDirectory: info.isDirectory(),
          mtimeMs: info.mtimeMs,
        }
      },
      read: async (file) =>
        await readFile(inside(snapshot.workspace, file), 'utf8'),
      write: async (file, data) => {
        const target = inside(snapshot.workspace, file)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, data)
      },
      glob: async (patterns) => {
        const list = (typeof patterns === 'string' ? [patterns] : patterns).map(
          (pattern) => globExpression(pattern),
        )
        return (await walk(realpathSync(snapshot.workspace))).filter((file) =>
          list.some((expression) => expression.test(file)),
        )
      },
    },
    git: {
      tag: async (name, options) =>
        await service('git.tag', name, options ?? {}),
    },
    apple: {
      get signing() {
        if (snapshot.apple == null)
          throw new Error(
            `Stage ${snapshot.stage.name} declared no apple signing`,
          )
        return snapshot.apple.signing
      },
      archive: async (options) =>
        await service('apple.archive', options.scheme, options),
      testflight: async (options) =>
        await service('apple.testflight', options.path, options),
      notarize: async (options) =>
        await service('apple.notarize', options.path, options),
    },
  }
  return context
}
