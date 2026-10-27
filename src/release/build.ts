import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { baseEnvironment } from '../builder/config.js'
import { releasesRepository } from '../version.js'
import {
  download,
  extract,
  fetchText,
  type InstallContext,
} from '../worker/tools/common.js'

const run = promisify(execFile)

export const platforms = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
] as const
export type ReleasePlatform = (typeof platforms)[number]

export interface ReleaseOptions {
  /** The Mason repository (a checkout with `lib/` built). */
  repo: string
  version: string
  out: string
  platforms?: ReleasePlatform[]
  /** The Node.js runtime each tarball carries; the builder's own by default. */
  nodeVersion?: string
  /** nodejs.org/dist, or a mirror for tests. */
  nodeSource?: string
  log?: (text: string) => void
  /** Production `node_modules`; built with `npm ci --omit=dev` when omitted. */
  modules?: string
  /** Builds the darwin-x64 argon2 binary, which argon2's package does not ship. */
  buildArgon2X64?: (argon2Dir: string, nodeVersion: string) => Promise<string>
}

export const tarballName = (
  version: string,
  platform: ReleasePlatform,
): string => `mason-${version}-${platform}.tar.gz`

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** The launcher every tarball carries: its own Node runs Mason's CLI. */
const launcher = `#!/bin/sh
# Runs Mason with the Node.js runtime that ships beside it.
dir=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0" 2>/dev/null || echo "$0")")" && pwd)
exec "$dir/node/bin/node" "$dir/lib/cli.js" "$@"
`

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Every licence a tarball's dependencies carry, gathered into one notice. */
function licences(modules: string): string {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkg = path.join(dir, entry.name)
      if (entry.name.startsWith('@')) {
        visit(pkg)
        continue
      }
      const file = readdirSync(pkg).find((name) =>
        /^licen[cs]e(\.|$)/i.test(name),
      )
      if (file != null)
        out.push(
          `## ${path.relative(modules, pkg)}\n\n${readFileSync(path.join(pkg, file), 'utf8').trim()}\n`,
        )
      if (existsSync(path.join(pkg, 'node_modules')))
        visit(path.join(pkg, 'node_modules'))
    }
  }
  visit(modules)
  return out.sort().join('\n')
}

/** Cross-compiles argon2 for darwin-x64 with node-gyp. */
export async function buildArgon2X64(
  argon2Dir: string,
  nodeVersion: string,
): Promise<string> {
  await run(
    'npx',
    [
      '--yes',
      'node-gyp@11',
      'rebuild',
      '--arch=x64',
      `--target=${nodeVersion}`,
    ],
    {
      cwd: argon2Dir,
      env: baseEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  return path.join(argon2Dir, 'build', 'Release', 'argon2.node')
}

/**
 * Builds a release: one self-contained tarball per platform (the official
 * Node.js runtime verified against its SHASUMS256.txt, Mason's `lib/`,
 * production modules with that platform's argon2, licences and the `mason`
 * launcher), `install.sh`, and `SHA256SUMS` over them all.
 */
export async function buildRelease(options: ReleaseOptions): Promise<string[]> {
  if (!semver.test(options.version))
    throw new Error(`${options.version} is not a semver version`)
  const log = options.log ?? ((): void => undefined)
  const nodeVersion = options.nodeVersion ?? process.versions.node
  const nodeSource = options.nodeSource ?? 'https://nodejs.org/dist'
  const work = path.join(options.out, '.work')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  mkdirSync(options.out, { recursive: true })
  if (!existsSync(path.join(options.repo, 'lib', 'cli.js')))
    throw new Error('Build lib/ first (npm run build)')

  let modules = options.modules
  if (modules == null) {
    const deps = path.join(work, 'deps')
    mkdirSync(deps)
    for (const file of ['package.json', 'package-lock.json'])
      copyFileSync(path.join(options.repo, file), path.join(deps, file))
    log('$ npm ci --omit=dev --ignore-scripts\n')
    await run(
      'npm',
      ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd: deps,
        env: baseEnvironment(),
        maxBuffer: 64 * 1024 * 1024,
      },
    )
    modules = path.join(deps, 'node_modules')
  }
  const notice = licences(modules)
  const sums = await fetchText(`${nodeSource}/v${nodeVersion}/SHASUMS256.txt`)
  const files: string[] = []
  const context: InstallContext = {
    toolsDir: work,
    sources: { node: nodeSource, rust: '', adoptium: '', android: '' },
    os: 'macos',
    arch: 'arm64',
    log,
  }

  for (const platform of options.platforms ?? platforms) {
    const top = `mason-${options.version}`
    const root = path.join(work, platform, top)
    mkdirSync(root, { recursive: true })
    // The Node.js runtime, verified against the release's published sums.
    const runtime = `node-v${nodeVersion}-${platform}.tar.gz`
    const line = sums
      .split('\n')
      .find((entry) => entry.trim().endsWith(`  ${runtime}`))
    if (line == null)
      throw new Error(`Node.js ${nodeVersion} publishes no ${runtime}`)
    const archive = path.join(work, runtime)
    if (!existsSync(archive))
      await download(
        `${nodeSource}/v${nodeVersion}/${runtime}`,
        archive,
        { algorithm: 'sha256', digest: line.trim().split(/\s+/)[0]! },
        context,
      )
    const node = path.join(root, 'node')
    await extract(archive, node, 1)
    for (const extra of [
      'include',
      'share',
      'lib',
      'CHANGELOG.md',
      'README.md',
    ])
      rmSync(path.join(node, extra), { recursive: true, force: true })
    for (const name of readdirSync(path.join(node, 'bin')))
      if (name !== 'node') rmSync(path.join(node, 'bin', name), { force: true })
    // Mason itself, without its tests.
    cpSync(path.join(options.repo, 'lib'), path.join(root, 'lib'), {
      recursive: true,
      // Tests and their helpers stay out of a release.
      filter: (source) =>
        !source.endsWith('.test.js') &&
        path
          .relative(path.join(options.repo, 'lib'), source)
          .split(path.sep)[0] !== 'test',
    })
    // The fonts, icons and logo the pages are drawn with, and their licences.
    cpSync(path.join(options.repo, 'assets'), path.join(root, 'assets'), {
      recursive: true,
    })
    // Apple's Profile Service roots, which hosts verify device callbacks against.
    mkdirSync(path.join(root, 'src', 'devices'), { recursive: true })
    for (const name of readdirSync(path.join(options.repo, 'src', 'devices')))
      if (name.endsWith('.pem'))
        copyFileSync(
          path.join(options.repo, 'src', 'devices', name),
          path.join(root, 'src', 'devices', name),
        )
    const pkg = JSON.parse(
      readFileSync(path.join(options.repo, 'package.json'), 'utf8'),
    ) as Record<string, unknown>
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: pkg.name,
          version: options.version,
          private: true,
          type: 'module',
          // Where `mason releases fetch` and updates find later releases.
          ...(pkg.repository == null ? {} : { repository: pkg.repository }),
          ...(pkg.masonReleases == null
            ? {}
            : { masonReleases: pkg.masonReleases }),
          dependencies: pkg.dependencies,
        },
        null,
        2,
      ) + '\n',
    )
    cpSync(modules, path.join(root, 'node_modules'), { recursive: true })
    // Only this platform's argon2 binary. `npm ci` compiled one for the
    // building computer into build/, which node-gyp-build would load before
    // the prebuild, so it goes.
    rmSync(path.join(root, 'node_modules', 'argon2', 'build'), {
      recursive: true,
      force: true,
    })
    const prebuilds = path.join(root, 'node_modules', 'argon2', 'prebuilds')
    if (existsSync(prebuilds))
      for (const name of readdirSync(prebuilds))
        if (name !== platform)
          rmSync(path.join(prebuilds, name), { recursive: true, force: true })
    if (
      platform === 'darwin-x64' &&
      !existsSync(path.join(prebuilds, platform))
    ) {
      const built = await (options.buildArgon2X64 ?? buildArgon2X64)(
        path.join(modules, 'argon2'),
        nodeVersion,
      )
      mkdirSync(path.join(prebuilds, platform), { recursive: true })
      copyFileSync(built, path.join(prebuilds, platform, 'argon2.node'))
    }
    writeFileSync(path.join(root, 'THIRD_PARTY_LICENCES.md'), notice)
    writeFileSync(path.join(root, 'mason'), launcher, { mode: 0o755 })
    const tarball = path.join(
      options.out,
      tarballName(options.version, platform),
    )
    // No extended attributes, and on macOS no AppleDouble `._` files, which
    // Linux would unpack as real files beside each one.
    await run(
      'tar',
      ['--no-xattrs', '-czf', tarball, '-C', path.join(work, platform), top],
      { env: { ...baseEnvironment(), COPYFILE_DISABLE: '1' } },
    )
    files.push(tarball)
    log(`Built ${path.basename(tarball)}\n`)
  }
  const installer = path.join(options.out, 'install.sh')
  copyFileSync(path.join(options.repo, 'install.sh'), installer)
  files.push(installer)
  const lines: string[] = []
  for (const file of files)
    lines.push(`${await sha256(file)}  ${path.basename(file)}`)
  writeFileSync(path.join(options.out, 'SHA256SUMS'), lines.join('\n') + '\n')
  rmSync(work, { recursive: true, force: true })
  return [...files, path.join(options.out, 'SHA256SUMS')]
}

/** `scripts/release.ts --version <x.y.z> --out <dir> [--platform <p>]… [--publish <tag>]`. */
export async function releaseMain(
  argv: string[],
  repo: string,
  overrides: {
    /** Build options tests replace: sources, modules, the log. */
    build?: Partial<ReleaseOptions>
    /** Runs `gh` with these arguments. */
    gh?: (args: string[]) => Promise<void>
  } = {},
): Promise<number> {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i < 0 ? undefined : argv[i + 1]
  }
  const version = value('--version')
  const out = value('--out')
  if (version == null || out == null) {
    console.error(
      'Usage: scripts/release.ts --version <x.y.z> --out <dir> [--platform <p>]… [--publish <tag> [--repo <owner/name>]]',
    )
    return 2
  }
  const chosen = argv.flatMap((arg, i) =>
    arg === '--platform' ? [argv[i + 1] as ReleasePlatform] : [],
  )
  for (const platform of chosen)
    if (!platforms.includes(platform))
      throw new Error(`Unknown platform ${platform}`)
  const files = await buildRelease({
    repo,
    version,
    out: path.resolve(out),
    ...(chosen.length === 0 ? {} : { platforms: chosen }),
    log: (text) => process.stdout.write(text),
    ...overrides.build,
  })
  const tag = value('--publish')
  const gh =
    overrides.gh ??
    (async (args: string[]): Promise<void> => {
      await run('gh', args, { env: process.env })
    })
  // The GitHub repository: --repo, or the checkout's package.json.
  const publishTo =
    value('--repo') ??
    releasesRepository(
      JSON.parse(
        readFileSync(path.join(repo, 'package.json'), 'utf8'),
      ) as Parameters<typeof releasesRepository>[0],
    )
  if (tag != null && publishTo == null)
    throw new Error(
      'Name the GitHub repository to publish to with --repo owner/name, or in package.json',
    )
  if (tag != null && publishTo != null) {
    await gh([
      'release',
      'create',
      tag,
      '--repo',
      publishTo,
      '--title',
      `Mason ${version}`,
      '--notes',
      `Mason ${version}`,
      ...files,
    ])
    console.log(`Published ${tag}`)
  }
  return 0
}
