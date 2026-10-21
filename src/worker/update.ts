import { spawn } from 'node:child_process'
import type { KeyObject } from 'node:crypto'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Stream } from '../link/link.js'
import { helperRequest } from '../helper/server.js'
import {
  compareSemver,
  fileSha256,
  installTarball,
  major,
  releasePlatform,
  verifyRelease,
  type ReleaseManifest,
  type RunningInstall,
} from '../release/install.js'

export interface UpdateContext {
  /** The paired master's public key. */
  masterKey: () => KeyObject | undefined
  version: string
  /** Whether a stage or setup run is in progress. */
  busy: () => boolean
  install: RunningInstall
  scratch: string
  helperSocket: string
  /** Restarts into the new release once the master has the answer. */
  restart: () => void
  log?: (line: string) => void
}

const LIMIT = 1024 * 1024 * 1024

/** Refuses an offered release before any bytes move. */
export function checkOffer(
  manifest: ReleaseManifest,
  signature: string,
  context: UpdateContext,
): void {
  const key = context.masterKey()
  if (key == null) throw new Error('This worker has no master key')
  if (!verifyRelease(manifest, signature, key))
    throw new Error('The release signature does not verify with the master key')
  if (major(manifest.version) !== major(context.version))
    throw new Error(
      `Release ${manifest.version} is another major version than ${context.version}`,
    )
  if (compareSemver(manifest.version, context.version) <= 0)
    throw new Error(
      `Release ${manifest.version} is not newer than ${context.version}`,
    )
  if (manifest.platform !== releasePlatform())
    throw new Error(
      `Release ${manifest.platform} does not run on ${releasePlatform()}`,
    )
  if (context.install.kind === 'checkout')
    throw new Error(
      'This worker runs from a source checkout; install a release to receive updates',
    )
  if (context.busy())
    throw new Error(
      'A stage is running; the update waits until the worker is idle',
    )
}

/**
 * The `update.install` stream: the master sends `{ manifest, signature }` and
 * then the tarball; the worker answers `{ installed }` and restarts into it.
 */
export async function receiveUpdate(
  stream: Stream,
  params: unknown,
  context: UpdateContext,
): Promise<void> {
  const { manifest, signature } = (params ?? {}) as {
    manifest: ReleaseManifest
    signature: string
  }
  try {
    checkOffer(manifest, signature, context)
  } catch (error) {
    stream.abort((error as Error).message)
    return
  }
  mkdirSync(context.scratch, { recursive: true, mode: 0o700 })
  const file = path.join(
    context.scratch,
    `mason-${manifest.version}-${manifest.platform}.tar.gz`,
  )
  const out = createWriteStream(file, { mode: 0o600 })
  out.on('error', () => undefined)
  try {
    let size = 0
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > LIMIT) {
          stream.abort('The release is too large')
          reject(new Error('The release is too large'))
          return
        }
        out.write(chunk)
      })
      stream.once('end', () => {
        out.end(() => {
          resolve()
        })
      })
      stream.once('abort', (reason: string) => {
        reject(new Error(reason))
      })
    })
    if ((await fileSha256(file)) !== manifest.sha256)
      throw new Error('The release does not match its signed digest')
    if (context.install.kind === 'user')
      await installTarball(
        file,
        {
          prefix: context.install.prefix!,
          bindir: path.join(homedir(), '.local', 'bin'),
        },
        manifest,
      )
    // A system install is the helper's: it checks the signature again with its own copy of the key.
    else {
      // The helper keeps the first master key it is given and refuses any
      // other. It may not have been listening when the worker paired.
      await helperRequest(context.helperSocket, 'key.set', {
        publicKey: context
          .masterKey()!
          .export({ type: 'spki', format: 'der' })
          .toString('base64'),
      })
      await helperRequest(context.helperSocket, 'release.install', {
        tarball: file,
        manifest,
        signature,
      })
    }
    context.log?.(`Installed Mason ${manifest.version}; restarting into it.`)
    await stream.write(
      Buffer.from(JSON.stringify({ installed: manifest.version })),
    )
    stream.end()
    if (context.install.kind === 'user')
      setTimeout(context.restart, 500).unref()
  } catch (error) {
    stream.abort((error as Error).message)
  } finally {
    rmSync(file, { force: true })
  }
}

/** Restarts this process: a service manager starts the new release; otherwise it starts it itself. */
export function restartProcess(install: RunningInstall): void {
  const managed =
    process.env.XPC_SERVICE_NAME?.startsWith('app.mason.') === true ||
    process.env.INVOCATION_ID != null
  if (!managed && install.prefix != null)
    spawn(
      path.join(install.prefix, 'current', 'mason'),
      process.argv.slice(2),
      { detached: true, stdio: 'inherit' },
    ).unref()
  process.exit(0)
}
