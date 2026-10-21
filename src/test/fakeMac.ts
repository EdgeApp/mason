import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { perform, type HelperContext } from '../helper/catalog.js'
import type { SystemRun } from '../worker/system/index.js'

const plist = (values: Record<string, string>): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>${Object.entries(values)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join('')}</dict></plist>
`

/** Writes a fake Xcode bundle: Info.plist and version.plist. */
export function fakeXcode(app: string, version: string, build: string): void {
  mkdirSync(path.join(app, 'Contents', 'Developer'), { recursive: true })
  writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    plist({ CFBundleShortVersionString: version }),
  )
  writeFileSync(
    path.join(app, 'Contents', 'version.plist'),
    plist({ ProductBuildVersion: build }),
  )
}

const bundleVersion = (
  app: string,
): { version: string; build: string } | undefined => {
  try {
    const info = readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8')
    const version =
      /<key>CFBundleShortVersionString<\/key><string>([^<]+)</.exec(info)?.[1]
    const build =
      /<key>ProductBuildVersion<\/key><string>([^<]+)</.exec(
        readFileSync(path.join(app, 'Contents', 'version.plist'), 'utf8'),
      )?.[1] ?? ''
    return version == null ? undefined : { version, build }
  } catch {
    return undefined
  }
}

interface Runtime {
  name: string
  version: string
  build: string
  identifier: string
  image: string
}

/**
 * One simulated Mac for the worker's system commands and its helper:
 * Xcodes in a fake `/Applications`, which of them launch, first launch,
 * simulator runtimes, Command Line Tools, Rosetta, Homebrew and settings.
 * Every command is recorded; `xcode-select` must never appear.
 */
export class FakeMac {
  readonly applications: string
  readonly work: string
  readonly calls: string[][] = []
  /** Versions that refuse to launch, with the error `xcodebuild` prints. */
  readonly noLaunch = new Map<string, string>()
  /** Bundles that still need first launch; all others are done. */
  readonly needsFirstLaunch = new Set<string>()
  runtimes: Runtime[] = []
  downloads = 0
  clt = false
  rosetta = false
  brew: { formulae: string[]; casks: string[] } | undefined = {
    formulae: [],
    casks: [],
  }
  settings = { noSleep: false, devToolsSecurity: false, automationMode: false }
  /** Items whose installs fail, by package or setting name. */
  readonly failing = new Set<string>()
  xcodeSelect = '/Applications/Xcode.app/Contents/Developer'

  constructor(root: string) {
    this.applications = path.join(root, 'Applications')
    mkdirSync(root, { recursive: true })
    this.work = mkdtempSync(path.join(root, 'helper-'))
    mkdirSync(this.applications, { recursive: true })
  }

  private app(env?: Record<string, string>): string | undefined {
    const dir = env?.DEVELOPER_DIR
    return dir == null ? undefined : path.dirname(path.dirname(dir))
  }

  private runtimeOf(name: string): Runtime {
    const [platform, version] = name.split(' ')
    return {
      name,
      version: version!,
      build: `B${version!.replace(/\./g, '')}`,
      identifier: `com.apple.CoreSimulator.SimRuntime.${platform}-${version!.replace(/\./g, '-')}`,
      image: randomUUID().toUpperCase(),
    }
  }

  /** The worker user's commands. */
  readonly run: SystemRun = async (command, args, options = {}) => {
    this.calls.push([
      command,
      ...args,
      ...(options.env?.DEVELOPER_DIR == null
        ? []
        : [`DEVELOPER_DIR=${options.env.DEVELOPER_DIR}`]),
    ])
    const ok = (
      stdout = '',
    ): { code: number; stdout: string; stderr: string } => ({
      code: 0,
      stdout,
      stderr: '',
    })
    const fail = (
      stderr = '',
      code = 1,
    ): { code: number; stdout: string; stderr: string } => ({
      code,
      stdout: '',
      stderr,
    })
    const app = this.app(options.env)
    if (command === 'xcodebuild') {
      const bundle = app == null ? undefined : bundleVersion(app)
      if (bundle == null)
        return fail('xcode-select: error: tool xcodebuild requires Xcode')
      const refusal = this.noLaunch.get(bundle.version)
      if (refusal != null) return fail(refusal, 134)
      if (args[0] === '-version')
        return ok(`Xcode ${bundle.version}\nBuild version ${bundle.build}\n`)
      if (args[0] === '-checkFirstLaunchStatus')
        return this.needsFirstLaunch.has(app!) ? fail('', 69) : ok()
      if (args[0] === '-showsdks')
        return ok(
          JSON.stringify([
            { canonicalName: `iphoneos${bundle.version}` },
            { canonicalName: `macosx${bundle.version}` },
          ]),
        )
      if (args[0] === '-downloadPlatform') {
        const platform = args[1]!
        const version = args[args.indexOf('-buildVersion') + 1]!
        const dir = args[args.indexOf('-exportPath') + 1]!
        if (this.failing.has(`${platform} ${version}`))
          return fail('Download failed')
        this.downloads++
        writeFileSync(
          path.join(dir, `${platform}_${version}_Simulator_Runtime.dmg`),
          `runtime:${platform} ${version}`,
        )
        return ok()
      }
      return fail(`unknown xcodebuild ${args.join(' ')}`)
    }
    if (command === 'xcrun' && args[0] === 'simctl') {
      if (args[1] === 'list')
        return ok(
          JSON.stringify({
            runtimes: this.runtimes.map((runtime) => ({
              name: runtime.name,
              version: runtime.version,
              buildversion: runtime.build,
              identifier: runtime.identifier,
              isAvailable: true,
            })),
          }),
        )
      if (args[1] === 'runtime' && args[2] === 'list')
        return ok(
          JSON.stringify(
            Object.fromEntries(
              this.runtimes.map((runtime) => [
                runtime.image,
                {
                  runtimeIdentifier: runtime.identifier,
                  deletable: true,
                  version: runtime.version,
                },
              ]),
            ),
          ),
        )
      if (args[1] === '--set') return ok()
      return fail()
    }
    if (command === 'xcode-select') return ok(this.xcodeSelect + '\n')
    if (command === 'pkgutil') return this.clt ? ok() : fail('No receipt')
    if (command === '/usr/bin/arch')
      return this.rosetta ? ok() : fail('Bad CPU type', 126)
    if (command === 'pmset')
      return ok(` sleep                ${this.settings.noSleep ? 0 : 10}\n`)
    if (command === 'DevToolsSecurity')
      return ok(
        `Developer mode is currently ${this.settings.devToolsSecurity ? 'enabled' : 'disabled'}.\n`,
      )
    if (command === 'automationmodetool')
      return ok(
        `This device ${this.settings.automationMode ? 'DOES NOT REQUIRE' : 'REQUIRES'} user authentication to enable Automation Mode.\n`,
      )
    if (command === 'stat') return ok('nobody\n')
    if (command.endsWith('/brew')) {
      if (this.brew == null) return fail('', 127)
      return ok(
        args.includes('--cask')
          ? this.brew.casks.join('\n')
          : this.brew.formulae.join('\n'),
      )
    }
    return fail('', 127)
  }

  /** The helper's root context over the same Mac. */
  context(): HelperContext {
    const user = {
      name: process.env.USER ?? 'mason',
      uid: process.getuid!(),
      gid: process.getgid!(),
      home: this.work,
    }
    return {
      platform: 'darwin',
      user,
      paths: {
        keyFile: path.join(this.work, 'master.pub'),
        prefix: path.join(this.work, 'opt'),
        bindir: path.join(this.work, 'bin'),
        applications: this.applications,
        work: path.join(this.work, 'expand'),
      },
      run: async (
        command,
        args,
        options = {},
      ): Promise<{ stdout: string; stderr: string }> => {
        this.calls.push([
          'root',
          command,
          ...args,
          ...(options.asUser === true ? ['(as user)'] : []),
        ])
        const app = this.app(options.env)
        const fail = (message: string): never => {
          throw new Error(message)
        }
        switch (command) {
          case 'pkgutil': {
            const text = readFileSync(args[1]!, 'utf8')
            return {
              stdout: text.startsWith('xcode:')
                ? 'Status: signed Apple Software\n'
                : 'Status: no signature\n',
              stderr: '',
            }
          }
          case 'xip': {
            const xip = args[1]!
            const [, version, build] = readFileSync(xip, 'utf8').split(':')
            fakeXcode(path.join(options.cwd!, 'Xcode.app'), version!, build!)
            return { stdout: '', stderr: '' }
          }
          case 'xcodebuild':
            if (args[0] === '-runFirstLaunch' && app != null)
              this.needsFirstLaunch.delete(app)
            if (args[0] === '-importPlatform') {
              const name = readFileSync(args[1]!, 'utf8').replace(
                /^runtime:/,
                '',
              )
              if (!this.runtimes.some((runtime) => runtime.name === name))
                this.runtimes.push(this.runtimeOf(name))
            }
            return { stdout: '', stderr: '' }
          case 'xcrun':
            if (args[1] === 'runtime' && args[2] === 'delete')
              this.runtimes = this.runtimes.filter(
                (runtime) => runtime.image !== args[3],
              )
            return { stdout: '', stderr: '' }
          case 'softwareupdate':
            if (args[0] === '--list')
              return {
                stdout: '* Label: Command Line Tools for Xcode-26.1\n',
                stderr: '',
              }
            if (args[0] === '--install-rosetta') this.rosetta = true
            else this.clt = true
            return { stdout: '', stderr: '' }
          case 'brew': {
            const cask = args.includes('--cask')
            const names = args.filter(
              (arg) => arg !== 'install' && arg !== '--cask',
            )
            for (const name of names)
              if (this.failing.has(name))
                fail(`Error: No available formula with the name "${name}"`)
            this.brew ??= { formulae: [], casks: [] }
            if (cask) this.brew.casks.push(...names)
            else this.brew.formulae.push(...names)
            return { stdout: '', stderr: '' }
          }
          case 'pmset':
            this.settings.noSleep = true
            return { stdout: '', stderr: '' }
          case 'DevToolsSecurity':
            if (this.failing.has('devToolsSecurity'))
              fail('DevToolsSecurity failed')
            this.settings.devToolsSecurity = true
            return { stdout: '', stderr: '' }
          case 'automationmodetool':
            this.settings.automationMode = true
            return { stdout: '', stderr: '' }
          default:
            return fail(`${command} is not on this fake Mac`)
        }
      },
      restartService: async () => undefined,
    }
  }

  /** The worker's helper option: the real catalog over the fake Mac. */
  readonly helper = async (
    op: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => await perform(op, args, this.context())

  installed(): string[] {
    return existsSync(this.applications)
      ? readdirSync(this.applications).sort()
      : []
  }
}

/** A runner for clusters that do not test system software: Xcode bundles launch, nothing else is installed. */
export function quietMac(): SystemRun {
  const mac = new FakeMac(
    mkdtempSync(path.join(process.env.MASON_TEST_ROOT ?? '/tmp', 'mac-')),
  )
  return mac.run
}
