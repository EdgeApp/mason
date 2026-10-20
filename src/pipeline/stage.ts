import type { ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import type { Json, StageStatus } from '../../types/mason/index.js'
import {
  Execution,
  processSnapshot,
  type MaskedLog,
  type ProcessIdentity,
} from '../builder/execution.js'
import type { StageSnapshot } from './context.js'
import { runnerEnvironment, runnerPath } from './setup.js'
import { StepChannel, type Port, type RequestHandler } from './steps.js'

/** A secret as it is masked: the value and its base64 and URL-encoded forms. */
export function secretForms(values: string[]): string[] {
  return [
    ...new Set(
      values
        .filter((value) => value.length > 0)
        .flatMap((value) => [
          value,
          Buffer.from(value).toString('base64'),
          encodeURIComponent(value),
        ]),
    ),
  ]
}

/** Replaces every secret form inside the strings of a JSON value. */
export function maskValue(value: Json, secrets: string[]): Json {
  const forms = secretForms(secrets).sort((a, b) => b.length - a.length)
  const mask = (item: Json): Json => {
    if (typeof item === 'string')
      return forms.reduce(
        (text, form) => text.split(form).join('[redacted]'),
        item,
      )
    if (Array.isArray(item)) return item.map(mask)
    if (item != null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .filter((pair): pair is [string, Json] => pair[1] !== undefined)
          .map(([key, entry]) => [mask(key) as string, mask(entry)]),
      )
    return item
  }
  return mask(value)
}

export interface StepRecord {
  /** Numbers the steps of one attempt; a step's start and end share it. */
  id: number
  kind: string
  title: string
  status: 'running' | 'succeeded' | 'failed'
  ms?: number
}

export interface StageResult {
  status: Exclude<StageStatus, 'skipped'>
  /** The returned value, masked. */
  value?: Json
  /** Why the stage is unstable or failed. */
  reason?: string
  description?: string
}

export interface StageOptions {
  snapshot: StageSnapshot
  /** The masked log; built with `secretForms` of the snapshot's secrets and files. */
  log: Pick<MaskedLog, 'write'>
  /** Seconds. */
  timeout: number
  activityTimeout?: number
  continueOnError?: boolean
  signal?: AbortSignal
  /** Worker services the context asks for: stash, artifacts, publish, … */
  steps?: RequestHandler
  /** Late `ctx.output` lookups. */
  output?: (stage: string) => Promise<Json> | Json
  onStep?: (step: StepRecord) => void
  onDescribe?: (text: string) => void
  inspect?: () => ProcessIdentity[]
}

/**
 * Runs one stage function in a runner process under the guardian. The
 * snapshot, with the stage's declared secrets, goes over the IPC channel and
 * never into the environment or onto disk; the stage's timeout and
 * `activityTimeout` are enforced here.
 */
export async function runStage(options: StageOptions): Promise<StageResult> {
  const { snapshot } = options
  mkdirSync(snapshot.privateDir, { recursive: true, mode: 0o700 })
  const secrets = [
    ...Object.values(snapshot.secrets),
    ...Object.values(snapshot.files).map((contents) =>
      Buffer.from(contents, 'base64').toString(),
    ),
  ]
  let activity: NodeJS.Timeout | undefined
  let stopped: 'cancelled' | 'timed_out' | undefined
  let stopReason: string | undefined
  let stopping: Promise<boolean> | undefined
  const stop =
    (why: 'cancelled' | 'timed_out', message: string) => (): void => {
      if (stopped != null) return
      stopped = why
      stopReason = message
      log.write(`\n${message}\n`)
      // The stage's signal carries why, so its own error says so too.
      channel?.notify('cancel', { reason: message })
      stopping = execution.stop()
    }
  const touch = (): void => {
    if (options.activityTimeout == null) return
    clearTimeout(activity)
    activity = setTimeout(
      stop(
        'timed_out',
        `No output for ${options.activityTimeout} s; stopping the stage.`,
      ),
      options.activityTimeout * 1000,
    )
  }
  const log = {
    write: (text: string): void => {
      touch()
      options.log.write(text)
    },
  }
  const execution = new Execution(log, options.inspect ?? processSnapshot)
  let channel: StepChannel | undefined
  let result:
    | { status: string; value?: Json; reason?: string; error?: string }
    | undefined
  let description: string | undefined
  const connect = (child: ChildProcess): void => {
    channel = new StepChannel(child as unknown as Port)
    channel.onNotice((type, data) => {
      if (type === 'ready') channel!.notify('init', snapshot)
      else if (type === 'step') options.onStep?.(data as StepRecord)
      else if (type === 'describe') {
        description = maskValue(
          (data as { text: string }).text,
          secrets,
        ) as string
        options.onDescribe?.(description)
      }
    })
    channel.handle(async (method, params) => {
      if (method === 'result') {
        result = params as typeof result
        return null
      }
      if (method === 'output') {
        const stage = (params as { stage: string }).stage
        if (options.output == null)
          throw new Error(`Stage ${stage} has no output`)
        return await options.output(stage)
      }
      if (method === 'step' && options.steps != null) {
        const { method: name, args } = params as {
          method: string
          args: unknown
        }
        return await options.steps(name, args)
      }
      throw new Error(
        `${method === 'step' ? (params as { method: string }).method : method} is not available on this node`,
      )
    })
  }
  const timer = setTimeout(
    stop(
      'timed_out',
      `The stage passed its ${options.timeout} s timeout; stopping it.`,
    ),
    options.timeout * 1000,
  )
  // The worker aborts with why: it is stopping, the master asked, the machine retires.
  const cancel = (): void => {
    const why: unknown = options.signal?.reason
    stop(
      'cancelled',
      why instanceof Error && why.name !== 'AbortError'
        ? `The stage was cancelled: ${why.message.replace(/\.$/, '')}.`
        : 'The stage was cancelled.',
    )()
  }
  if (options.signal?.aborted === true) cancel()
  options.signal?.addEventListener('abort', cancel, { once: true })
  touch()
  try {
    await execution.run(
      process.execPath,
      [runnerPath, 'stage'],
      snapshot.workspace,
      { ...runnerEnvironment(), ...snapshot.env },
      false,
      connect,
    )
  } catch {
    // The status comes from the result the runner reported, or from why it was stopped.
  } finally {
    clearTimeout(timer)
    clearTimeout(activity)
    options.signal?.removeEventListener('abort', cancel)
    channel?.close()
    await (stopping ?? execution.stop())
    rmSync(snapshot.privateDir, { recursive: true, force: true })
  }
  const status: StageResult['status'] =
    stopped ??
    (result?.status === 'succeeded' || result?.status === 'unstable'
      ? result.status
      : 'failed')
  const out: StageResult = {
    status:
      options.continueOnError === true &&
      status !== 'cancelled' &&
      status !== 'succeeded'
        ? 'unstable'
        : status,
    ...(description == null ? {} : { description }),
  }
  if (stopped == null && result?.value !== undefined && status !== 'failed')
    out.value = maskValue(result.value, secrets)
  const reason =
    stopReason ??
    result?.reason ??
    result?.error ??
    (stopped == null && result == null
      ? 'The stage runner exited without a result'
      : undefined)
  if (reason != null) out.reason = maskValue(reason, secrets) as string
  return out
}
