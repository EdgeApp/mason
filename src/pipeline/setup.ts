import type { ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { baseEnvironment } from '../builder/config.js'
import {
  CommandFailure,
  Execution,
  processSnapshot,
  type MaskedLog,
  type ProcessIdentity,
} from '../builder/execution.js'
import { noSymlinks } from '../config.js'
import { limits, type SetupContext } from './graph.js'

export const runnerPath = fileURLToPath(new URL('./runner.js', import.meta.url))

/** The environment every runner starts from: no secret, file or token, ever. */
export function runnerEnvironment(): Record<string, string> {
  const env = baseEnvironment() as Record<string, string>
  // Masonfile code never reaches the operator's SSH agent.
  delete env.SSH_AUTH_SOCK
  // Lets a coverage run measure the runner; it is a directory path, not a secret.
  if (process.env.NODE_V8_COVERAGE != null)
    env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE
  return env
}

/** How long a runner has to exit after it reported, before the worker stops it. */
export const RUNNER_EXIT_GRACE_MS = 5000

/**
 * Kills `runner`, which has reported what the worker needs, if it is still
 * running `graceMs` later: its exit can hang for good (see finish in
 * worker/gitProxy.ts), or a Masonfile can keep it open. Returns a function
 * that calls this off.
 */
export function stopLingering(
  runner: ChildProcess,
  graceMs: number,
  log: Pick<MaskedLog, 'write'>,
  message: string,
): () => void {
  if (runner.exitCode != null || runner.signalCode != null)
    return () => undefined
  const timer = setTimeout(() => {
    log.write(message)
    runner.kill('SIGKILL')
  }, graceMs)
  runner.once('exit', () => clearTimeout(timer))
  return () => clearTimeout(timer)
}

export class SetupFailed extends Error {}

export interface SetupOptions {
  /** Absolute path of the Masonfile inside the checkout. */
  masonfile: string
  checkout: string
  context: SetupContext
  /** Private directory for the result file. */
  scratch: string
  log: Pick<MaskedLog, 'write'>
  timeoutSeconds?: number
  signal?: AbortSignal
  inspect?: () => ProcessIdentity[]
  /** How long the runner has to exit once it recorded the graph; `RUNNER_EXIT_GRACE_MS` by default. */
  exitGraceMs?: number
}

/**
 * Runs `setup` in the checkout with no secrets and returns the graph it
 * recorded, unvalidated: the master validates it with `validateGraph`.
 * The run is contained by the guardian, so nothing it starts survives it.
 */
export async function runSetup(options: SetupOptions): Promise<unknown> {
  const resultFile = path.join(
    options.scratch,
    `setup-${process.pid}-${Date.now()}.json`,
  )
  let tail = ''
  const log = {
    write: (text: string): void => {
      tail = (tail + text).slice(-4000)
      options.log.write(text)
    },
  }
  const execution = new Execution(log, options.inspect ?? processSnapshot)
  let stopped: string | undefined
  const stop = (why: string) => (): void => {
    stopped ??= why
    void execution.stop()
  }
  const timer = setTimeout(
    stop('Setup timed out'),
    (options.timeoutSeconds ?? 300) * 1000,
  )
  const cancel = stop('Setup cancelled')
  options.signal?.addEventListener('abort', cancel, { once: true })
  let recorded = false
  let lingering: (() => void) | undefined
  try {
    await execution
      .run(
        process.execPath,
        [runnerPath, 'setup', options.masonfile],
        options.checkout,
        {
          ...runnerEnvironment(),
          MASON_RESULT_FILE: resultFile,
          MASON_SETUP_CONTEXT: JSON.stringify(options.context),
        },
        false,
        (runner) => {
          runner.on('message', (message: { setup?: unknown } | null) => {
            if (message?.setup !== 'recorded' || recorded) return
            recorded = true
            lingering = stopLingering(
              runner,
              options.exitGraceMs ?? RUNNER_EXIT_GRACE_MS,
              log,
              'Setup recorded its graph, but its runner did not exit; stopping it.\n',
            )
          })
        },
      )
      .catch((error: unknown) => {
        // A runner stopped after it recorded the graph still recorded it.
        if (!recorded || stopped != null) throw error
      })
    noSymlinks(resultFile)
    if (
      !lstatSync(resultFile).isFile() ||
      lstatSync(resultFile).size > limits.graphBytes
    )
      throw new SetupFailed('Setup returned an invalid graph file')
    return JSON.parse(readFileSync(resultFile, 'utf8')) as unknown
  } catch (error) {
    if (stopped != null) throw new SetupFailed(stopped)
    if (error instanceof CommandFailure || error instanceof SyntaxError)
      throw new SetupFailed(
        `Setup failed: ${tail.trim().split('\n').slice(-5).join('\n')}`,
      )
    throw error
  } finally {
    clearTimeout(timer)
    lingering?.()
    options.signal?.removeEventListener('abort', cancel)
    await execution.stop()
    if (existsSync(resultFile)) rmSync(resultFile, { force: true })
  }
}
