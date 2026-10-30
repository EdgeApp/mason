import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Json, StageStatus } from '../../types/mason/index.js'
import {
  Execution,
  processSnapshot,
  type MaskedLog,
  type ProcessIdentity,
} from '../builder/execution.js'
import { inside, type StageSnapshot } from './context.js'
import { NEEDS_DIRECTORY } from './variants.js'
import { runnerEnvironment, runnerPath } from './setup.js'
import { StepChannel, type Port, type RequestHandler } from './steps.js'

/**
 * The values inside a JSON secret (a keys.json, say) that a build may print
 * on their own: string values, at any depth, that look like tokens — at
 * least 16 characters, no whitespace, letters and digits both, not a URL.
 * Keys are not masked, nor are the URLs, names and words of a config file,
 * so a declared config.json leaves the log readable. A path is masked when
 * it looks like a token: a base64 token may start with a slash. A secret
 * that is not JSON has none.
 */
function jsonLeaves(value: string): string[] {
  if (!/^\s*[[{]/.test(value)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  const out: string[] = []
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      if (
        item.length >= 16 &&
        !/\s/.test(item) &&
        /[A-Za-z]/.test(item) &&
        /[0-9]/.test(item) &&
        !item.includes('://')
      )
        out.push(item)
    } else if (Array.isArray(item)) item.forEach(visit)
    else if (item != null && typeof item === 'object')
      for (const entry of Object.values(item)) visit(entry)
  }
  visit(parsed)
  return out
}

/**
 * A secret as it is masked: the value and its base64 and URL-encoded forms,
 * and the same for each string inside a JSON secret.
 */
export function secretForms(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => [value, ...jsonLeaves(value)])
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

/** One file a stage wrote, and what was at its path before, to put back. */
interface WrittenFile {
  target: string
  /** A copy of the file that was there, and its mode. */
  original?: string
  mode?: number
  /** Where a symlink that was there pointed. */
  link?: string
}

/**
 * Where the secret files written into `workspace` are listed, and copies of
 * what they replaced: beside the stage's private directory, named by the
 * workspace, so every stage in that checkout finds the same list.
 */
export function secretFilesPaths(
  workspace: string,
  privateDir: string,
): { manifest: string; originals: string } {
  const base = path.join(
    path.dirname(privateDir),
    `secret-files-${createHash('sha256').update(workspace).digest('hex').slice(0, 16)}`,
  )
  return { manifest: `${base}.json`, originals: `${base}-originals` }
}

function writeManifest(manifest: string, written: WrittenFile[]): void {
  // Written whole, then renamed: a worker killed mid-write leaves the last
  // complete manifest.
  writeFileSync(`${manifest}.tmp`, JSON.stringify(written), { mode: 0o600 })
  renameSync(`${manifest}.tmp`, manifest)
}

/**
 * Removes each written file (or whatever the stage left at its path, a
 * directory included) and puts back what it replaced, making its directory
 * again if the stage removed it. An entry whose removal or put-back fails is
 * reported and stays in the manifest, with its original, for the next try;
 * the manifest and originals go once none is left. Returns the entries left.
 */
function cleanWritten(
  written: WrittenFile[],
  paths: { manifest: string; originals: string },
  log: (text: string) => void,
): WrittenFile[] {
  const left: WrittenFile[] = []
  for (const file of [...written].reverse()) {
    try {
      rmSync(file.target, { recursive: true, force: true })
      if (file.link != null || file.original != null)
        mkdirSync(path.dirname(file.target), { recursive: true })
      if (file.link != null) symlinkSync(file.link, file.target)
      else if (file.original != null) {
        copyFileSync(file.original, file.target)
        chmodSync(file.target, file.mode ?? 0o644)
      }
    } catch (error) {
      left.unshift(file)
      log(
        `\nCould not remove the secret file ${file.target} and put back what it replaced (kept in ${paths.originals}): ${(error as Error).message}\n`,
      )
    }
  }
  if (left.length > 0) writeManifest(paths.manifest, left)
  else {
    rmSync(paths.originals, { recursive: true, force: true })
    rmSync(paths.manifest, { force: true })
  }
  return left
}

/**
 * Removes the secret files a worker that died mid-stage left in `workspace`,
 * putting back what they replaced. The worker runs this before the next
 * checkout there, so the originals go back onto the tree they came from and
 * the checkout then moves it on. A manifest that cannot be read, or entries
 * that could not be cleaned, are left for the next try; until then no stage
 * writes secret files there, unless a clean checkout resets the tree
 * (`forgetSecretFiles`).
 */
export function recoverSecretFiles(
  workspace: string,
  privateDir: string,
  log: (text: string) => void,
): void {
  const paths = secretFilesPaths(workspace, privateDir)
  if (!existsSync(paths.manifest)) return
  let written: WrittenFile[]
  try {
    written = JSON.parse(readFileSync(paths.manifest, 'utf8')) as WrittenFile[]
  } catch (error) {
    log(
      `\nCould not read the secret files an earlier stage left (${paths.manifest}): ${(error as Error).message}\n`,
    )
    return
  }
  cleanWritten(written, paths, log)
}

/**
 * Drops what `recoverSecretFiles` could not clean, once a clean checkout has
 * reset `workspace` to its commit: nothing the list names is there any more.
 */
export function forgetSecretFiles(workspace: string, privateDir: string): void {
  const paths = secretFilesPaths(workspace, privateDir)
  rmSync(paths.originals, { recursive: true, force: true })
  rmSync(paths.manifest, { force: true })
}

/**
 * Secret files a stage wrote into its checkout. Each path goes into a
 * manifest beside the private directory before the file is written, with a
 * copy of any file the checkout had there, so the files are removed (and
 * what they replaced put back) when the stage ends however it ends, and, if
 * the worker itself died, by `recoverSecretFiles` before the next checkout.
 */
class SecretFiles {
  private written: WrittenFile[] = []
  /** A manifest an earlier stage left that was not cleaned: kept, and so not written over. */
  private readonly left: boolean
  private readonly paths: { manifest: string; originals: string }
  constructor(
    private readonly snapshot: StageSnapshot,
    private readonly log: (text: string) => void,
  ) {
    this.paths = secretFilesPaths(snapshot.workspace, snapshot.privateDir)
    this.left = existsSync(this.paths.manifest)
  }

  /**
   * Writes `<directory>/<name>` inside the checkout, owner-only unless a
   * mode is given. The directory may be reached through a symlink that stays
   * in the checkout; a symlink or file at the target itself is set aside,
   * never written through, and put back by `clean`.
   */
  write(request: { name: string; directory: string; mode?: unknown }): string {
    const { name, directory } = request
    const contents = Object.hasOwn(this.snapshot.files, name)
      ? this.snapshot.files[name]
      : undefined
    if (contents == null)
      throw new Error(
        `Stage ${this.snapshot.stage.name} did not declare the secret file ${name}`,
      )
    if (typeof directory !== 'string' || directory === '')
      throw new Error(NEEDS_DIRECTORY)
    const mode = request.mode ?? 0o600
    if (
      typeof mode !== 'number' ||
      !Number.isInteger(mode) ||
      mode < 0o400 ||
      mode > 0o777
    )
      throw new Error('writeSecretFile takes a file mode from 0o400 to 0o777')
    if (this.left)
      throw new Error(
        `Secret files cannot be written here until the files listed in ${this.paths.manifest}, left by an earlier stage, are put back or removed and that list is deleted (or the workspace is checked out clean)`,
      )
    const where = path.join(directory, name)
    const parent = path.dirname(where)
    const real = inside(this.snapshot.workspace, parent)
    mkdirSync(real, { recursive: true })
    // Again, now the directories exist: no symlink can have led out of the checkout.
    if (inside(this.snapshot.workspace, parent) !== real)
      throw new Error(`${where} is outside the workspace`)
    const target = path.join(real, path.basename(where))
    const there = lstatSync(target, { throwIfNoEntry: false })
    if (there?.isDirectory()) throw new Error(`${where} is a directory`)
    if (!this.written.some((file) => file.target === target)) {
      const entry: WrittenFile = { target }
      if (there?.isSymbolicLink()) entry.link = readlinkSync(target)
      else if (there != null) {
        mkdirSync(this.paths.originals, { recursive: true, mode: 0o700 })
        entry.original = path.join(
          this.paths.originals,
          String(this.written.length + 1),
        )
        copyFileSync(target, entry.original)
        entry.mode = there.mode & 0o7777
      }
      this.written.push(entry)
      writeManifest(this.paths.manifest, this.written)
    }
    rmSync(target, { force: true })
    writeFileSync(target, Buffer.from(contents, 'base64'), {
      mode,
      flag: 'wx',
    })
    chmodSync(target, mode)
    return target
  }

  /** Removes every file this stage wrote and puts back what each replaced (see `cleanWritten`). */
  clean(): void {
    if (this.left || this.written.length === 0) return
    this.written = cleanWritten(this.written, this.paths, this.log)
  }
}

/**
 * Runs one stage function in a runner process under the guardian. The
 * snapshot, with the stage's declared secrets, goes to the runner over the
 * IPC channel; the runner sets declared values only in its commands'
 * environment, and secret files reach disk only as `secretFile` (the
 * private directory) and `writeSecretFile` (the checkout, written here and
 * removed at the end). The stage's timeout and `activityTimeout` are
 * enforced here.
 */
export async function runStage(options: StageOptions): Promise<StageResult> {
  const { snapshot } = options
  mkdirSync(snapshot.privateDir, { recursive: true, mode: 0o700 })
  const secretFiles = new SecretFiles(snapshot, (text) =>
    options.log.write(text),
  )
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
      if (method === 'writeSecretFile')
        return secretFiles.write(
          params as { name: string; directory: string; mode?: unknown },
        )
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
    secretFiles.clean()
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
