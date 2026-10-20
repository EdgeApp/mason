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
  // Lets a coverage run measure the runner; it is a directory path, not a secret.
  if (process.env.NODE_V8_COVERAGE != null)
    env.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE
  return env
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
  try {
    await execution.run(
      process.execPath,
      [runnerPath, 'setup', options.masonfile],
      options.checkout,
      {
        ...runnerEnvironment(),
        MASON_RESULT_FILE: resultFile,
        MASON_SETUP_CONTEXT: JSON.stringify(options.context),
      },
    )
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
    options.signal?.removeEventListener('abort', cancel)
    await execution.stop()
    if (existsSync(resultFile)) rmSync(resultFile, { force: true })
  }
}
