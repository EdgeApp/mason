import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type {
  ArtifactOptions,
  ArtifactQuery,
  PublishOptions,
  PublishResult,
  TestSummary,
} from '../../types/mason/index.js'
import { baseEnvironment } from '../builder/config.js'
import { LinkError } from '../link/link.js'
import { pinnedFetch } from '../node/pinnedFetch.js'
import type { StageAssignment } from '../pipeline/assignment.js'
import { inside } from '../pipeline/context.js'
import { parseTests, type TestFormat } from '../pipeline/tests.js'
import { packageIdentity } from '../upload/metadata.js'
import {
  asFormat,
  asVariant,
  outsideBlock,
  text,
  type Format,
} from '../validation.js'

const run = promisify(execFile)

/** What the artifact calls need from the worker running the stage. */
export interface ArtifactContext {
  assignment: StageAssignment
  /** The stage's workspace. */
  dir: string
  /** Scratch space owned by the worker. */
  scratch: string
  /** A request to the master; a LinkError `closed` when it is unreachable. */
  request<T>(method: string, params: unknown): Promise<T>
  /** Waits for the master's link. */
  connected(): Promise<void>
  /** Journals a record the master receives exactly once, after a reconnect if need be. */
  journal(kind: 'publication' | 'tests', data: string): void
  select(
    root: string,
    patterns: string | string[],
    exclude?: string[],
  ): Promise<string[]>
  log(text: string): void
}

const sha256 = async (file: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const ticket = (context: ArtifactContext): { key: string; token: string } => ({
  key: context.assignment.key,
  token: context.assignment.token,
})

/** Uploads a file to the host, by its pin when it serves its own certificate. */
async function upload(
  url: string,
  file: string,
  headers: Record<string, string>,
  pin: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await pinnedFetch(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(statSync(file).size),
        ...headers,
      },
      // A file stream is an async iterable body, sent half-duplex.
      body: createReadStream(file) as never,
      duplex: 'half',
    },
    pin,
  )
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { error: text.slice(0, 500) }
  }
  return { status: response.status, body }
}

/**
 * `ctx.publish`: hashes the file, asks the master for a grant into the
 * stage's reservation and uploads it to the host. While the master is away
 * the stage's token authorizes the upload with its fields; the host stages
 * it and the master publishes it when it returns.
 */
export async function publish(
  context: ArtifactContext,
  options: PublishOptions,
): Promise<PublishResult> {
  const uploads = context.assignment.uploads
  if (uploads == null)
    throw new Error(
      'This stage cannot publish: no host is configured, or the stage lists no publications',
    )
  const file = inside(
    context.dir,
    checkoutFile(checkoutPath(context.dir, options.path)),
  )
  const format: Format = asFormat(path.extname(file).slice(1).toLowerCase())
  const variant = asVariant(options.variant)
  const reservation = uploads.reservations.find(
    (entry) => entry.app === options.app && entry.platform === options.platform,
  )
  if (reservation == null)
    throw new Error(
      `This stage has no ${options.platform} publication of ${options.app}; list it in publishes`,
    )
  const size = statSync(file).size
  const digest = await sha256(file)
  let version = options.version
  // An IPA's or APK's own number is its publication's; a desktop file's is given.
  let packageNumber: string | undefined
  if (format === 'ipa' || format === 'apk') {
    const identity = await packageIdentity(file, format, {})
    version = identity.version
    packageNumber = identity.buildNumber
    if (options.buildNumber != null && options.buildNumber !== packageNumber)
      throw new Error(
        `${path.basename(file)} is build ${packageNumber}, not ${options.buildNumber}`,
      )
  }
  if (version == null) throw new Error(`A ${format} needs its version`)
  const buildNumber =
    packageNumber ?? options.buildNumber ?? reservation.buildNumber
  const outside = outsideBlock(
    buildNumber,
    reservation.buildNumber,
    reservation.block ?? 1,
  )
  if (outside != null) throw new Error(outside)
  const changelog: Record<string, string> =
    options.changelog == null
      ? {}
      : {
          'X-Mason-Changelog': encodeURIComponent(
            options.changelog.slice(0, 60_000),
          ),
        }
  let answer: { status: number; body: Record<string, unknown> }
  try {
    const grant = await context.request<{
      grant: string
      url: string
      pin?: string
    }>('artifacts.grant', {
      ...ticket(context),
      app: options.app,
      platform: options.platform,
      format,
      digest,
      size,
      version,
      buildNumber,
      variant,
    })
    answer = await upload(
      grant.url,
      file,
      { Authorization: `Bearer ${grant.grant}`, ...changelog },
      grant.pin,
    )
  } catch (error) {
    if (!(error instanceof LinkError && error.code === 'closed')) throw error
    // The master is away: the stage's token authorizes the reserved upload.
    context.log(
      `The master is unreachable; uploading ${path.basename(file)} with the stage’s token\n`,
    )
    answer = await upload(
      `${uploads.origin}/api/artifacts/${reservation.id}`,
      file,
      {
        'X-Mason-Token': uploads.token,
        'X-Mason-Format': format,
        'X-Mason-Version': version,
        'X-Mason-Build-Number': buildNumber,
        ...(variant === '' ? {} : { 'X-Mason-Variant': variant }),
        ...changelog,
      },
      uploads.pin,
    )
  }
  if (answer.status === 202) {
    context.journal(
      'publication',
      JSON.stringify({
        reservation: reservation.id,
        app: options.app,
        platform: options.platform,
        variant,
        digest,
      }),
    )
    return {
      buildId: 0,
      url: String(answer.body.url ?? uploads.origin),
      installUrl: String(answer.body.url ?? uploads.origin),
      visible: false,
      variant,
    }
  }
  if (answer.status !== 201)
    throw new Error(
      `The host refused ${path.basename(file)}: ${String(answer.body.error ?? answer.status)}`,
    )
  context.log(
    `Published ${options.app} ${version} (${buildNumber}) for ${options.platform}${variant === '' ? '' : `, variant ${variant}`}\n`,
  )
  return {
    buildId: Number(answer.body.buildId),
    url: String(answer.body.url),
    installUrl: String(answer.body.installUrl),
    visible: answer.body.visible === true,
    variant,
  }
}

/**
 * A path a stage gives, relative to its checkout or absolute inside it, as
 * `ctx.apple.archive` resolves with; anything else is refused.
 */
export function checkoutPath(dir: string, value: unknown): unknown {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value
  const relative = path.relative(dir, value)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`${value} is outside the checkout`)
  return relative
}

/**
 * A path in the checkout for `inside()`, which keeps it there: any file name
 * (Xcode names exports after the product, `TS Cameraman.ipa`), but nothing
 * in `.git`.
 */
export function checkoutFile(value: unknown): string {
  const out = text(1024)(value)
  if (
    out.includes('\0') ||
    out.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')
  )
    throw new Error('Unsafe relative path')
  return out
}

/** `ctx.artifacts.save`: the matching files, as one tar.gz kept with the run on the host. */
export async function save(
  context: ArtifactContext,
  name: string,
  paths: string | string[],
  options: ArtifactOptions,
): Promise<void> {
  const uploads = context.assignment.uploads
  if (uploads == null)
    throw new Error('This stage cannot save artifacts: no host is configured')
  const files = await context.select(
    context.dir,
    (typeof paths === 'string' ? [paths] : paths).map(
      (entry) => checkoutPath(context.dir, entry) as string,
    ),
  )
  if (files.length === 0) throw new Error(`Artifact ${name} matched no files`)
  mkdirSync(context.scratch, { recursive: true, mode: 0o700 })
  const archive = path.join(
    context.scratch,
    `artifact-${process.pid}-${Date.now()}.tar.gz`,
  )
  const list = `${archive}.list`
  writeFileSync(list, files.join('\n') + '\n', { mode: 0o600 })
  try {
    await run('tar', ['-czf', archive, '-C', context.dir, '-T', list], {
      env: baseEnvironment(),
    })
    for (;;) {
      try {
        const answer = await upload(
          `${uploads.origin}/api/runs/${context.assignment.job}/artifacts/${encodeURIComponent(name)}`,
          archive,
          {
            'X-Mason-Token': uploads.token,
            'X-Mason-Kind': options.kind ?? 'file',
            ...(options.entry == null
              ? {}
              : { 'X-Mason-Entry': options.entry }),
            ...(options.visibleTo == null
              ? {}
              : { 'X-Mason-Visible-To': options.visibleTo }),
          },
          uploads.pin,
        )
        if (answer.status !== 201)
          throw new Error(
            `The host refused artifact ${name}: ${String(answer.body.error ?? answer.status)}`,
          )
        context.log(`Saved artifact ${name} (${files.length} files)\n`)
        return
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        // The host is unreachable: try again shortly, as for the master.
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  } finally {
    rmSync(archive, { force: true })
    rmSync(list, { force: true })
  }
}

/**
 * `ctx.artifacts.fetch`: the latest matching run's artifact through a
 * download grant, its digest checked, unpacked into `into`. While the
 * master is away it waits for it.
 */
export async function fetchArtifacts(
  context: ArtifactContext,
  query: ArtifactQuery,
  into: string,
): Promise<string[]> {
  let found: {
    grant: string
    url: string
    pin?: string
    digest: string
    size: number
    name: string
  }
  for (;;)
    try {
      found = await context.request('artifacts.query', {
        ...ticket(context),
        query,
      })
      break
    } catch (error) {
      if (!(error instanceof LinkError && error.code === 'closed')) throw error
      await context.connected()
    }
  mkdirSync(context.scratch, { recursive: true, mode: 0o700 })
  const archive = path.join(
    context.scratch,
    `fetch-${process.pid}-${Date.now()}.tar.gz`,
  )
  try {
    const response = await pinnedFetch(found.url, {}, found.pin)
    if (!response.ok || response.body == null)
      throw new Error(
        `The host refused artifact ${found.name}: HTTP ${response.status}`,
      )
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(archive, { mode: 0o600 }),
    )
    if ((await sha256(archive)) !== found.digest)
      throw new Error(`Artifact ${found.name} does not match its digest`)
    const target = inside(context.dir, checkoutFile(into))
    mkdirSync(target, { recursive: true })
    const listed = await run('tar', ['-tzf', archive], {
      env: baseEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
    })
    await run('tar', ['-xzf', archive, '-C', target], {
      env: baseEnvironment(),
    })
    return listed.stdout
      .split('\n')
      .filter((line) => line !== '' && !line.endsWith('/'))
      .map((line) => path.join(target, line))
  } finally {
    rmSync(archive, { force: true })
  }
}

/** `ctx.tests`: the matching result files parsed and kept with the run. */
export async function tests(
  context: ArtifactContext,
  format: TestFormat,
  paths: string | string[],
): Promise<TestSummary> {
  const files = await context.select(context.dir, paths)
  if (files.length === 0)
    throw new Error(`No ${format} results match ${JSON.stringify(paths)}`)
  const summary = parseTests(
    format,
    files.map((file) => readFileSync(inside(context.dir, file), 'utf8')),
  )
  context.log(
    `Tests: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped\n`,
  )
  for (const failure of summary.failures.slice(0, 50))
    context.log(`  ✗ ${failure.name}: ${failure.message.split('\n')[0]}\n`)
  try {
    await context.request('artifacts.tests', { ...ticket(context), summary })
  } catch (error) {
    if (!(error instanceof LinkError && error.code === 'closed')) throw error
    context.journal('tests', JSON.stringify(summary))
  }
  return summary
}
