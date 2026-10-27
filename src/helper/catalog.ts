import { createPublicKey, type KeyObject } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import {
  compareSemver,
  installTarball,
  major,
  verifyRelease,
  type ReleaseManifest,
} from '../release/install.js'

/** What the helper needs from the computer; tests replace the commands. */
export interface HelperContext {
  platform: 'darwin' | 'linux'
  /** The Mason service's user: the only account that can reach the socket. */
  user: { name: string; uid: number; gid: number; home: string }
  paths: {
    /** Root-owned master public key: /Library/Application Support/Mason/master.pub or /etc/mason/master.pub. */
    keyFile: string
    /** /opt/mason */
    prefix: string
    /** /usr/local/bin */
    bindir: string
    /** /Applications */
    applications: string
    /** Root-owned scratch space for expanding Xcode archives. */
    work: string
  }
  /** Runs a command as root, or as the service's user with `asUser`. */
  run(
    command: string,
    args: string[],
    options?: {
      asUser?: boolean
      env?: Record<string, string>
      cwd?: string
      input?: string
    },
  ): Promise<{ stdout: string; stderr: string }>
  /** Restarts the worker service so it runs the newly installed release. */
  restartService(): Promise<void>
}

export class Refused extends Error {}

const asObject = (value: unknown): Record<string, unknown> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw new Refused('Arguments must be an object')
  return value as Record<string, unknown>
}
const names = (
  value: unknown,
  what: string,
  pattern = /^[a-z0-9][a-z0-9@._+-]{0,99}$/,
): string[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 100 ||
    value.some((item) => typeof item !== 'string' || !pattern.test(item))
  )
    throw new Refused(`${what} must be a list of package names`)
  return value as string[]
}
const xcodeVersion = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^\d+(?:\.\d+){0,2}(?:-beta\d*|-rc\d*)?$/.test(value)
  )
    throw new Refused('Invalid Xcode version')
  return value
}
/** A regular file the service's user hands over; never a symlink. */
const userFile = (value: unknown, context: HelperContext): string => {
  if (typeof value !== 'string' || !path.isAbsolute(value))
    throw new Refused('A file is an absolute path')
  const stat = lstatSync(value)
  if (!stat.isFile()) throw new Refused('Not a regular file')
  if (stat.uid !== context.user.uid && stat.uid !== 0)
    throw new Refused('The file belongs to another user')
  return value
}
/** An Xcode bundle Mason installed: `<applications>/Xcode-<version>.app`. */
const masonXcode = (version: string, context: HelperContext): string =>
  path.join(context.paths.applications, `Xcode-${version}.app`)
/** Any Xcode bundle directly under the applications folder. */
const anyXcode = (value: unknown, context: HelperContext): string => {
  if (
    typeof value !== 'string' ||
    path.dirname(value) !== context.paths.applications ||
    !/^Xcode[A-Za-z0-9._-]*\.app$/.test(path.basename(value))
  )
    throw new Refused(
      `Xcode must be an app directly in ${context.paths.applications}`,
    )
  return value
}

export function storedKey(context: HelperContext): KeyObject | undefined {
  if (!existsSync(context.paths.keyFile)) return undefined
  return createPublicKey({
    key: Buffer.from(
      readFileSync(context.paths.keyFile, 'utf8').trim(),
      'base64',
    ),
    format: 'der',
    type: 'spki',
  })
}

function installedVersion(context: HelperContext): string | undefined {
  try {
    return readlinkSync(path.join(context.paths.prefix, 'current'))
  } catch {
    return undefined
  }
}

const developerEnv = (app: string): Record<string, string> => ({
  DEVELOPER_DIR: path.join(app, 'Contents', 'Developer'),
})

type Operation = (
  args: Record<string, unknown>,
  context: HelperContext,
) => Promise<unknown>

/**
 * Everything the helper can do. Each operation validates its arguments;
 * there is no way to run an arbitrary command.
 */
export const operations: Record<string, Operation> = {
  /** Stores the master's key the first time; any other key later is refused. */
  'key.set': async (args, context) => {
    const text = String(args.publicKey ?? '')
    let key: KeyObject
    try {
      key = createPublicKey({
        key: Buffer.from(text, 'base64'),
        format: 'der',
        type: 'spki',
      })
    } catch {
      throw new Refused('Not a public key')
    }
    const der = key.export({ type: 'spki', format: 'der' }).toString('base64')
    const stored = storedKey(context)
    if (stored != null) {
      if (
        stored.export({ type: 'spki', format: 'der' }).toString('base64') ===
        der
      )
        return { stored: false }
      throw new Refused(
        'A master key is already set; replace it with sudo mason worker --new-key',
      )
    }
    mkdirSync(path.dirname(context.paths.keyFile), {
      recursive: true,
      mode: 0o755,
    })
    writeFileSync(context.paths.keyFile, der + '\n', { mode: 0o644 })
    return { stored: true }
  },

  /** Installs a Mason release the master signed, then restarts the worker into it. */
  'release.install': async (args, context) => {
    const key = storedKey(context)
    if (key == null) throw new Refused('No master key is set')
    const manifest = asObject(args.manifest) as unknown as ReleaseManifest
    if (
      typeof args.signature !== 'string' ||
      !verifyRelease(manifest, args.signature, key)
    )
      throw new Refused(
        'The release signature does not verify with the master key',
      )
    const current = installedVersion(context)
    if (current != null) {
      if (major(manifest.version) !== major(current))
        throw new Refused(
          `Release ${manifest.version} is another major version than ${current}`,
        )
      if (compareSemver(manifest.version, current) < 0)
        throw new Refused(
          `Release ${manifest.version} is older than ${current}`,
        )
    }
    const dest = await installTarball(
      userFile(args.tarball, context),
      { prefix: context.paths.prefix, bindir: context.paths.bindir },
      manifest,
    )
    // Answer first: the worker waits for this answer, so restarting it now
    // would hold its shutdown until the service manager kills it.
    setTimeout(() => {
      context.restartService().catch(() => undefined)
    }, 1000)
    return { installed: dest }
  },

  /** Expands an Apple-signed Xcode archive and installs it beside the others as Xcode-<version>.app. */
  'xcode.install': async (args, context) => {
    const version = xcodeVersion(args.version)
    const xip = userFile(args.xip, context)
    const { stdout } = await context.run('pkgutil', ['--check-signature', xip])
    if (!/Status: signed Apple Software/.test(stdout))
      throw new Refused('The Xcode archive is not signed by Apple')
    const target = masonXcode(version, context)
    const work = path.join(context.paths.work, `xcode-${version}`)
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true, mode: 0o700 })
    try {
      await context.run('xip', ['--expand', xip], { cwd: work })
      const app = readdirSync(work).find((name) => /^Xcode.*\.app$/.test(name))
      if (app == null) throw new Refused('The archive holds no Xcode')
      rmSync(target, { recursive: true, force: true })
      renameSync(path.join(work, app), target)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
    await context.run('xcodebuild', ['-license', 'accept'], {
      env: developerEnv(target),
    })
    await context.run('xcodebuild', ['-runFirstLaunch'], {
      env: developerEnv(target),
    })
    return { installed: target }
  },
  'xcode.license': async (args, context) => {
    await context.run('xcodebuild', ['-license', 'accept'], {
      env: developerEnv(anyXcode(args.path, context)),
    })
    return null
  },
  'xcode.firstLaunch': async (args, context) => {
    await context.run('xcodebuild', ['-runFirstLaunch'], {
      env: developerEnv(anyXcode(args.path, context)),
    })
    return null
  },
  /** Removes an Xcode Mason installed; never another one. */
  'xcode.remove': async (args, context) => {
    const target = masonXcode(xcodeVersion(args.version), context)
    if (!existsSync(target))
      throw new Refused(`${path.basename(target)} is not installed`)
    rmSync(target, { recursive: true, force: true })
    return { removed: target }
  },
  'runtime.import': async (args, context) => {
    const file = userFile(args.file, context)
    await context.run('xcodebuild', ['-importPlatform', file], {
      env: developerEnv(anyXcode(args.xcode, context)),
    })
    return null
  },
  /** Deletes a simulator runtime disk image by its UUID. */
  'runtime.remove': async (args, context) => {
    if (
      typeof args.image !== 'string' ||
      !/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(
        args.image,
      )
    )
      throw new Refused('A runtime image is a UUID')
    await context.run('xcrun', ['simctl', 'runtime', 'delete', args.image])
    return null
  },

  'clt.install': async (_args, context) => {
    if (context.platform !== 'darwin')
      throw new Refused('Command Line Tools are for macOS')
    const marker =
      '/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress'
    writeFileSync(marker, '')
    try {
      const { stdout } = await context.run('softwareupdate', ['--list'])
      const label = /\* Label: (Command Line Tools for Xcode-[\d.]+)/.exec(
        stdout,
      )?.[1]
      if (label == null)
        throw new Refused('softwareupdate offers no Command Line Tools')
      await context.run('softwareupdate', ['--install', label])
      return { installed: label }
    } finally {
      rmSync(marker, { force: true })
    }
  },
  'rosetta.install': async (_args, context) => {
    if (context.platform !== 'darwin') throw new Refused('Rosetta is for macOS')
    await context.run('softwareupdate', [
      '--install-rosetta',
      '--agree-to-license',
    ])
    return null
  },
  /** Homebrew refuses to run as root, so it runs as the service's user. */
  'brew.install': async (args, context) => {
    const formulae =
      args.formulae == null ? [] : names(args.formulae, 'formulae')
    const casks = args.casks == null ? [] : names(args.casks, 'casks')
    if (formulae.length > 0)
      await context.run('brew', ['install', ...formulae], { asUser: true })
    if (casks.length > 0)
      await context.run('brew', ['install', '--cask', ...casks], {
        asUser: true,
      })
    return null
  },
  'apt.install': async (args, context) => {
    const packages = names(args.packages, 'packages')
    const env = { DEBIAN_FRONTEND: 'noninteractive' }
    await context.run('apt-get', ['update'], { env })
    await context.run('apt-get', ['install', '-y', ...packages], { env })
    return null
  },
  'dnf.install': async (args, context) => {
    await context.run('dnf', [
      'install',
      '-y',
      ...names(args.packages, 'packages'),
    ])
    return null
  },
  /** Docker Engine on Linux, with the service's user allowed to use it. */
  'docker.install': async (_args, context) => {
    if (context.platform !== 'linux')
      throw new Refused('Docker on macOS is installed by the computer’s owner')
    await context.run('apt-get', ['install', '-y', 'docker.io'], {
      env: { DEBIAN_FRONTEND: 'noninteractive' },
    })
    await context.run('usermod', ['-aG', 'docker', context.user.name])
    await context.run('systemctl', ['enable', '--now', 'docker'])
    return null
  },
  /** Settings builds need; machine-level choices (auto-login, FileVault) are never touched. */
  'settings.apply': async (args, context) => {
    switch (args.name) {
      case 'noSleep':
        await context.run('pmset', ['-a', 'sleep', '0'])
        return null
      case 'devToolsSecurity':
        await context.run('DevToolsSecurity', ['-enable'])
        return null
      case 'automationMode':
        await context.run('automationmodetool', [
          'enable-automationmode-without-authentication',
        ])
        return null
      default:
        throw new Refused('Unknown setting')
    }
  },
}

/** Runs one catalog operation; anything outside the catalog is refused. */
export async function perform(
  op: unknown,
  args: unknown,
  context: HelperContext,
): Promise<unknown> {
  if (typeof op !== 'string' || !Object.hasOwn(operations, op))
    throw new Refused(`${String(op)} is not a helper operation`)
  return await operations[op]!(asObject(args ?? {}), context)
}
