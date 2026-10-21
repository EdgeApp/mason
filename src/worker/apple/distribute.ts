import { createHash } from 'node:crypto'
import {
  createReadStream,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { signV4 } from '../../host/storage.js'
import { packageIdentity } from '../../upload/metadata.js'
import type { Exec } from './archive.js'

/** What the TestFlight and notary steps need from the worker. */
export interface DistributeContext {
  dir: string
  scratch: string
  /** A request to the master about this stage. */
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>
  /** Waits until the master's link is back. */
  connected: () => Promise<void>
  exec: Exec
  log: (text: string) => void
  /** Keeps a file as a run artifact, when the stage can save artifacts. */
  keep?: (name: string, file: string) => Promise<void>
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** How often the master is asked for progress. */
  pollMs?: number
}

const sleepFor = (context: DistributeContext, ms: number): Promise<void> =>
  (
    context.sleep ??
    ((wait): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, wait)))
  )(ms)

/** A request that waits for the master when its link is down, rather than failing. */
async function patient<T>(
  context: DistributeContext,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  for (;;) {
    try {
      return await context.request<T>(method, params)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'closed' && code !== 'timeout') throw error
      await context.connected()
    }
  }
}

function inWorkspace(context: DistributeContext, file: string): string {
  const resolved = path.resolve(context.dir, file)
  if (!resolved.startsWith(context.dir + path.sep))
    throw new Error(`${file} is outside the workspace`)
  return resolved
}

/** A `.pkg`'s app version and build number, from the app inside it. */
async function pkgVersion(
  context: DistributeContext,
  file: string,
): Promise<{ version: string; buildNumber: string }> {
  const dir = mkdtempSync(path.join(context.scratch, 'pkg-'))
  try {
    const expanded = path.join(dir, 'x')
    const out = await context.exec(
      '/usr/sbin/pkgutil',
      ['--expand-full', file, expanded],
      {
        cwd: context.dir,
      },
    )
    if (out.code !== 0) throw new Error('pkgutil could not read the package')
    const find = (at: string, depth = 6): string | undefined => {
      if (depth < 0) return undefined
      for (const name of readdirSync(at)) {
        const next = path.join(at, name)
        if (name.endsWith('.app') && statSync(next).isDirectory()) return next
        if (statSync(next).isDirectory()) {
          const found = find(next, depth - 1)
          if (found != null) return found
        }
      }
      return undefined
    }
    const app = find(expanded)
    if (app == null) throw new Error('The package holds no app')
    const info = await context.exec(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')],
      { cwd: context.dir },
    )
    const values = JSON.parse(info.output) as Record<string, unknown>
    return {
      version: String(values.CFBundleShortVersionString),
      buildNumber: String(values.CFBundleVersion),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * `ctx.apple.testflight`: the master creates the build upload and passes
 * only Apple's pre-signed operations; this worker sends each part straight
 * to Apple, then the master completes the upload and runs the TestFlight
 * steps while this worker asks for progress. A dropped link only delays it.
 */
export async function testflight(
  context: DistributeContext,
  options: {
    path: string
    whatToTest?: string
    groups?: string[]
    usesNonExemptEncryption?: boolean
    waitForProcessing?: boolean
    notifyTesters?: boolean
  },
): Promise<{
  buildId: string
  version: string
  buildNumber: string
  state: string
}> {
  const file = inWorkspace(context, options.path)
  const pkg = file.endsWith('.pkg')
  if (!pkg && !file.endsWith('.ipa'))
    throw new Error('ctx.apple.testflight uploads an .ipa or a .pkg')
  const size = statSync(file).size
  const identity = pkg
    ? await pkgVersion(context, file)
    : await packageIdentity(file, 'ipa', {})
  const rest = {
    ...(options.whatToTest == null ? {} : { whatToTest: options.whatToTest }),
    ...(options.groups == null ? {} : { groups: options.groups }),
    ...(options.usesNonExemptEncryption == null
      ? {}
      : { usesNonExemptEncryption: options.usesNonExemptEncryption }),
    ...(options.waitForProcessing == null
      ? {}
      : { waitForProcessing: options.waitForProcessing }),
    ...(options.notifyTesters == null
      ? {}
      : { notifyTesters: options.notifyTesters }),
  }
  const started = await context.request<{
    id: string
    operations: Array<{
      method: string
      url: string
      offset: number
      length: number
      headers: Record<string, string>
    }>
  }>('apple.testflight.start', {
    fileName: path.basename(file),
    fileSize: size,
    version: identity.version,
    buildNumber: identity.buildNumber,
    options: rest,
  })
  context.log(
    `Uploading ${path.basename(file)} (${identity.version} build ${identity.buildNumber}) to App Store Connect in ${started.operations.length} part(s)\n`,
  )
  const handle = await open(file, 'r')
  try {
    for (const operation of started.operations) {
      const body = Buffer.alloc(operation.length)
      await handle.read(body, 0, operation.length, operation.offset)
      for (let attempt = 1; ; attempt++) {
        const response = await (context.fetch ?? fetch)(operation.url, {
          method: operation.method,
          headers: operation.headers,
          body,
          signal: AbortSignal.timeout(10 * 60_000),
        }).catch((error: unknown) => error as Error)
        if (!(response instanceof Error) && response.ok) break
        if (attempt >= 4)
          throw new Error(
            `Apple refused a part of the upload: ${response instanceof Error ? response.message : `HTTP ${response.status}`}`,
          )
        await sleepFor(context, 1000 * 2 ** attempt)
      }
    }
  } finally {
    await handle.close()
  }
  let status = await patient<{ state: string; result?: never; error?: string }>(
    context,
    'apple.testflight.complete',
    { id: started.id },
  )
  let reported = ''
  for (;;) {
    if (status.state === 'done')
      return status.result as unknown as {
        buildId: string
        version: string
        buildNumber: string
        state: string
      }
    if (status.state === 'failed')
      throw new Error(status.error ?? 'TestFlight failed')
    if (status.state !== reported) {
      context.log(`App Store Connect: ${status.state}\n`)
      reported = status.state
    }
    await sleepFor(context, context.pollMs ?? 15_000)
    status = await patient(context, 'apple.testflight.status', {
      id: started.id,
    })
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/**
 * `ctx.apple.notarize`: the master opens a notary submission and passes the
 * single-submission upload credentials; this worker uploads the file, the
 * master reports Apple's verdict, and an accepted file is stapled. A
 * rejection fails the stage with Apple's log kept as an artifact.
 */
export async function notarize(
  context: DistributeContext,
  options: { path: string; staple?: boolean },
): Promise<{ id: string; status: 'accepted' }> {
  const file = inWorkspace(context, options.path)
  if (!/\.(dmg|zip|pkg)$/.test(file))
    throw new Error('ctx.apple.notarize notarizes a .dmg, .zip or .pkg')
  const upload = await context.request<{
    id: string
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
    bucket: string
    object: string
    region: string
    endpoint?: string
  }>('apple.notary.start', {
    name: path.basename(file),
    sha256: await sha256(file),
  })
  context.log(
    `Uploading ${path.basename(file)} to Apple's notary service (submission ${upload.id})\n`,
  )
  const url = new URL(
    upload.endpoint == null
      ? `https://${upload.bucket}.s3.${upload.region}.amazonaws.com/${upload.object}`
      : `${upload.endpoint}/${upload.bucket}/${upload.object}`,
  )
  const body = readFileSync(file)
  const payloadHash = createHash('sha256').update(body).digest('hex')
  const headers = {
    'content-length': String(body.length),
    'x-amz-security-token': upload.sessionToken,
  }
  const signed = signV4(
    { method: 'PUT', url, headers, payloadHash },
    {
      accessKeyId: upload.accessKeyId,
      secretAccessKey: upload.secretAccessKey,
      region: upload.region,
      service: 's3',
    },
    new Date(),
  )
  const put = await (context.fetch ?? fetch)(url, {
    method: 'PUT',
    headers: { ...headers, ...signed },
    body,
    signal: AbortSignal.timeout(30 * 60_000),
  })
  if (!put.ok) throw new Error(`The notary upload failed: HTTP ${put.status}`)
  for (;;) {
    const status = await patient<{
      status: string
      detail?: string
      log?: string
    }>(context, 'apple.notary.status', { id: upload.id })
    if (status.status === 'accepted') break
    if (status.status === 'rejected') {
      if (status.log != null) {
        const log = path.join(context.scratch, 'notary-log.json')
        writeFileSync(log, status.log)
        await context.keep?.('notary-log', log).catch(() => undefined)
      }
      throw new Error(status.detail ?? 'Apple did not notarize the file')
    }
    await sleepFor(context, context.pollMs ?? 15_000)
  }
  context.log('Notarized by Apple\n')
  if (options.staple !== false) {
    const stapled = await context.exec(
      '/usr/bin/xcrun',
      ['stapler', 'staple', file],
      {
        cwd: context.dir,
        onLine: (line) => context.log(line + '\n'),
      },
    )
    if (stapled.code !== 0)
      throw new Error('xcrun stapler could not staple the ticket')
  }
  return { id: upload.id, status: 'accepted' }
}
