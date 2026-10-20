/**
 * The process a worker starts to run Masonfile code: `runner.js setup
 * <masonfile>` records the graph to `MASON_RESULT_FILE`; `runner.js stage`
 * receives its snapshot over the IPC channel and calls one stage function.
 * Node's type stripping loads `Masonfile.ts`, erasing `import type`, so no
 * package needs to be installed in the checkout.
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  createContext,
  type ContextResult,
  type StageSnapshot,
} from './context.js'
import { GraphError, Recorder, limits, type SetupContext } from './graph.js'
import { StepChannel, type Port } from './steps.js'

function report(error: unknown): void {
  process.stderr.write(
    error instanceof GraphError || !(error instanceof Error)
      ? `${String(error instanceof Error ? error.message : error)}\n`
      : `${error.stack ?? error.message}\n`,
  )
}

async function load(file: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>
}

export async function setupMain(masonfile: string): Promise<number> {
  try {
    const context = JSON.parse(
      process.env.MASON_SETUP_CONTEXT ?? '',
    ) as SetupContext
    const module = await load(masonfile)
    if (typeof module.setup !== 'function')
      throw new GraphError('The Masonfile does not export a setup function')
    const recorder = new Recorder(context, module)
    await (module.setup as (m: unknown) => unknown)(recorder.setup())
    writeFileSync(
      process.env.MASON_RESULT_FILE!,
      JSON.stringify(recorder.graph()),
      {
        mode: 0o600,
        flag: 'wx',
      },
    )
    return 0
  } catch (error) {
    report(error)
    return 1
  }
}

export async function stageMain(port: Port): Promise<number> {
  const channel = new StepChannel(port)
  const controller = new AbortController()
  const stop = (why: string) => (): void => {
    controller.abort(new Error(why))
  }
  process.on('SIGTERM', stop('Stage stopped'))
  channel.onNotice((type) => {
    if (type === 'cancel') stop('Stage cancelled')()
  })
  const snapshot = await new Promise<StageSnapshot>((resolve) => {
    channel.onNotice((type, data) => {
      if (type === 'init') resolve(data as StageSnapshot)
    })
    channel.notify('ready')
  })
  let result: {
    status: string
    value?: unknown
    reason?: string
    error?: string
  }
  try {
    const module = await load(snapshot.masonfile)
    const run = module[snapshot.function]
    if (typeof run !== 'function')
      throw new Error(
        `The Masonfile does not export a function named ${snapshot.function}`,
      )
    const out: ContextResult = {}
    const value: unknown = await (run as (ctx: unknown) => unknown)(
      createContext(snapshot, channel, controller.signal, out),
    )
    const json = JSON.stringify(value ?? null)
    if (Buffer.byteLength(json) > limits.outputBytes)
      throw new Error('A stage returns at most 64 KiB of JSON')
    result = {
      status: out.unstable == null ? 'succeeded' : 'unstable',
      value: JSON.parse(json),
      ...(out.unstable == null ? {} : { reason: out.unstable }),
    }
  } catch (error) {
    report(error)
    result = {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
  await channel.request('result', result)
  channel.close()
  return result.status === 'failed' ? 1 : 0
}

const [mode, file] = process.argv.slice(2)
if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const done = (code: number): void => {
    process.disconnect?.()
    process.exit(code)
  }
  if (mode === 'setup' && file != null) void setupMain(file).then(done)
  else if (mode === 'stage' && process.send != null)
    void stageMain(process as unknown as Port).then(done)
  else {
    process.stderr.write(
      'usage: runner.js setup <masonfile> | runner.js stage\n',
    )
    process.exit(2)
  }
}
