import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { open as openZip, type Entry, type ZipFile } from 'yauzl'
import { baseEnvironment } from '../../builder/config.js'

const run = promisify(execFile)

/** Where each installer downloads from; tests point these at a local server. */
export interface ToolSources {
  node: string
  rust: string
  adoptium: string
  android: string
}

export const defaultSources: ToolSources = {
  node: 'https://nodejs.org/dist',
  rust: 'https://static.rust-lang.org',
  adoptium: 'https://api.adoptium.net',
  android: 'https://dl.google.com/android/repository',
}

export interface InstallContext {
  /** `<data>/tools`. */
  toolsDir: string
  sources: ToolSources
  os: 'macos' | 'linux' | 'windows'
  arch: 'arm64' | 'x64'
  log: (text: string) => void
  signal?: AbortSignal
}

export class ChecksumMismatch extends Error {}

/** Fetches text, failing on any status but 200. */
export async function fetchText(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    ...(signal == null ? {} : { signal }),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return await response.text()
}

/**
 * Downloads `url` to `file` and checks its digest against the published one;
 * a mismatched file is deleted, never extracted.
 */
export async function download(
  url: string,
  file: string,
  expected: { algorithm: 'sha256' | 'sha1'; digest: string },
  context: InstallContext,
): Promise<void> {
  context.log(`Downloading ${url}\n`)
  const response = await fetch(url, {
    ...(context.signal == null ? {} : { signal: context.signal }),
    redirect: 'follow',
  })
  if (!response.ok || response.body == null)
    throw new Error(`${url} answered ${response.status}`)
  mkdirSync(path.dirname(file), { recursive: true })
  const hash = createHash(expected.algorithm)
  const partial = `${file}.part`
  const source = Readable.fromWeb(response.body as never)
  source.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(source, createWriteStream(partial, { mode: 0o600 }))
  const digest = hash.digest('hex')
  if (digest !== expected.digest.toLowerCase()) {
    rmSync(partial, { force: true })
    throw new ChecksumMismatch(
      `Checksum mismatch for ${path.basename(file)}: expected ${expected.algorithm} ${expected.digest}, got ${digest}`,
    )
  }
  renameSync(partial, file)
  context.log(`Verified ${expected.algorithm} ${digest}\n`)
}

/**
 * Unpacks a zip in-process (a fresh Linux machine has no `unzip`), keeping
 * each file's mode and its symlinks. Entries and link targets must stay
 * inside `into`.
 */
async function extractZip(archive: string, into: string): Promise<void> {
  const root = path.resolve(into)
  const inside = (target: string): boolean => {
    const relative = path.relative(root, target)
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    )
  }
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    openZip(
      archive,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, file) => (error != null ? reject(error) : resolve(file!)),
    ),
  )
  const write = async (entry: Entry): Promise<void> => {
    const target = path.resolve(root, entry.fileName)
    if (!inside(target))
      throw new Error(`${entry.fileName} is outside the archive's directory`)
    const attributes = entry.externalFileAttributes >>> 16
    if (entry.fileName.endsWith('/') || (attributes & 0o170000) === 0o040000) {
      mkdirSync(target, { recursive: true })
      return
    }
    mkdirSync(path.dirname(target), { recursive: true })
    // A link already there is replaced, never written through.
    rmSync(target, { force: true })
    const stream = await new Promise<Readable>((resolve, reject) =>
      zip.openReadStream(entry, (error, opened) =>
        error != null ? reject(error) : resolve(opened!),
      ),
    )
    if ((attributes & 0o170000) === 0o120000) {
      const parts: Buffer[] = []
      for await (const chunk of stream) parts.push(chunk as Buffer)
      const link = Buffer.concat(parts).toString('utf8')
      if (!inside(path.resolve(path.dirname(target), link)))
        throw new Error(
          `${entry.fileName} links outside the archive's directory`,
        )
      symlinkSync(link, target)
      return
    }
    await pipeline(stream, createWriteStream(target))
    chmodSync(target, attributes & 0o777 || 0o644)
  }
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown): void => {
      zip.close()
      reject(error as Error)
    }
    zip.on('error', fail)
    zip.on('end', () => resolve())
    zip.on('entry', (entry: Entry) => {
      write(entry).then(() => zip.readEntry(), fail)
    })
    zip.readEntry()
  })
}

/** Unpacks a `.tar.*` or `.zip` archive into `into`, optionally dropping leading path components. */
export async function extract(
  archive: string,
  into: string,
  strip = 0,
): Promise<void> {
  mkdirSync(into, { recursive: true })
  if (archive.endsWith('.zip')) {
    await extractZip(archive, into)
    return
  }
  await run(
    'tar',
    [
      '-xf',
      archive,
      '-C',
      into,
      ...(strip > 0 ? [`--strip-components=${strip}`] : []),
    ],
    {
      env: baseEnvironment(),
      maxBuffer: 16 * 1024 * 1024,
    },
  )
}

export interface Marker {
  tool: string
  version: string
  digest: string
  source: string
  installed: number
}

export const markerFile = (dir: string): string =>
  path.join(dir, '.mason-tool.json')

export function writeMarker(dir: string, marker: Marker): void {
  writeFileSync(markerFile(dir), JSON.stringify(marker) + '\n')
}

export function readMarker(dir: string): Marker | undefined {
  try {
    return JSON.parse(readFileSync(markerFile(dir), 'utf8')) as Marker
  } catch {
    return undefined
  }
}

/** Runs an installer step, logging its output. */
export async function step(
  file: string,
  args: string[],
  context: InstallContext,
  env: NodeJS.ProcessEnv = baseEnvironment(),
  input?: string,
): Promise<void> {
  context.log(`$ ${[path.basename(file), ...args].join(' ')}\n`)
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { env, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stdout !== '')
          context.log(stdout.endsWith('\n') ? stdout : stdout + '\n')
        if (stderr !== '')
          context.log(stderr.endsWith('\n') ? stderr : stderr + '\n')
        if (error != null)
          reject(
            new Error(
              `${path.basename(file)} exited with ${String(error.code ?? error.message)}`,
            ),
          )
        else resolve()
      },
    )
    if (input != null) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

/** A fresh directory for an install, swapped into place only when the install finished. */
export function staging(final: string): {
  dir: string
  commit: () => void
  discard: () => void
} {
  const dir = `${final}.installing`
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    commit: (): void => {
      rmSync(final, { recursive: true, force: true })
      renameSync(dir, final)
    },
    discard: (): void => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export const exists = existsSync
