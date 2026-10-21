import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  rmSync,
  statfsSync,
} from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { NodeType } from '../../master/nodeTypes.js'
import type { FullInventory } from '../inventory.js'
import type { InstallRequest } from '../tools/index.js'
import {
  compareVersions,
  newestMatch,
  selectXcode,
  type XcodeInstall,
} from '../tools/versions.js'
import {
  developerDir,
  type SimulatorRuntime,
  type SystemInventory,
  type SystemRun,
} from './index.js'

/** One thing reconciliation installs, applies or removes. */
export type ReconcileItem =
  | { id: string; kind: 'xcode'; version: string }
  | { id: string; kind: 'runtime'; name: string }
  | { id: string; kind: 'commandLineTools' }
  | { id: string; kind: 'rosetta' }
  | { id: string; kind: 'brew'; formula?: string; cask?: string }
  | { id: string; kind: 'apt' | 'dnf'; package: string }
  | { id: string; kind: 'docker' }
  | {
      id: string
      kind: 'setting'
      name: 'noSleep' | 'devToolsSecurity' | 'automationMode'
    }
  | { id: string; kind: 'tool'; request: InstallRequest }
  | { id: string; kind: 'removeXcode'; version: string; path: string }
  | { id: string; kind: 'removeRuntime'; name: string; image: string }

/** Items a node cannot do without the privileged helper (Homebrew too: the helper runs it as the Mason user). */
export const needsHelper = (item: ReconcileItem): boolean =>
  item.kind !== 'tool'

/** A manual step only a person can do; stages whose requirements it lists are not placed on the node. */
export interface ChecklistItem {
  id: string
  title: string
  /** Requirement tags it blocks: `system` (any helper install), `xcode:<version>`, `brew`. */
  blocks: string[]
}

export interface NodeState {
  inventory: FullInventory & { system?: SystemInventory }
  /** Xcode bundles in use by running stages: never removed. */
  inUse: string[]
}

/** A Mason-installed Xcode: `Xcode-<version>.app`; `/Applications/Xcode.app` is the owner's. */
const masonVersion = (install: XcodeInstall): string | undefined =>
  /^Xcode-(\d[\w.-]*)\.app$/.exec(path.basename(install.path))?.[1]

/**
 * What a node must do to reach its type's state: installs for everything
 * the type lists and the node lacks, then — when free disk is below the
 * type's threshold — removals of unpinned Xcodes and runtimes, oldest first.
 */
export function reconcilePlan(
  type: NodeType,
  state: NodeState,
): ReconcileItem[] {
  const inventory = state.inventory
  const system = inventory.system
  const out: ReconcileItem[] = []
  const software = type.software
  const macos = inventory.os === 'macos'
  if (macos) {
    for (const version of software.xcode)
      if (
        selectXcode(version, inventory.xcodes) == null &&
        !inventory.xcodes.some((install) => masonVersion(install) === version)
      )
        out.push({ id: `xcode:${version}`, kind: 'xcode', version })
    const present = new Set(
      (system?.runtimes ?? []).map((runtime) => runtime.name),
    )
    for (const name of software.simulators)
      if (!present.has(name))
        out.push({ id: `runtime:${name}`, kind: 'runtime', name })
    if (software.commandLineTools && system?.commandLineTools !== true)
      out.push({ id: 'commandLineTools', kind: 'commandLineTools' })
    if (
      software.rosetta &&
      inventory.arch === 'arm64' &&
      system?.rosetta !== true
    )
      out.push({ id: 'rosetta', kind: 'rosetta' })
    for (const formula of software.brew.formulae)
      if (!(system?.brew?.formulae ?? []).includes(formula))
        out.push({ id: `brew:${formula}`, kind: 'brew', formula })
    for (const cask of software.brew.casks)
      if (!(system?.brew?.casks ?? []).includes(cask))
        out.push({ id: `brew-cask:${cask}`, kind: 'brew', cask })
    for (const name of [
      'noSleep',
      'devToolsSecurity',
      'automationMode',
    ] as const)
      if (type.settings[name] && system?.settings?.[name] !== true)
        out.push({ id: `setting:${name}`, kind: 'setting', name })
  } else if (inventory.os === 'linux') {
    const manager =
      system?.apt != null ? 'apt' : system?.dnf != null ? 'dnf' : undefined
    if (manager != null)
      for (const name of software[manager])
        if (!(system?.[manager] ?? []).includes(name))
          out.push({ id: `${manager}:${name}`, kind: manager, package: name })
    if (software.docker && system?.docker !== true)
      out.push({ id: 'docker', kind: 'docker' })
  }
  for (const tool of ['node', 'java', 'rust'] as const) {
    const version = software[tool]
    if (version != null && newestMatch(version, inventory.tools[tool]) == null)
      out.push({
        id: `${tool}:${version}`,
        kind: 'tool',
        request: { tool, version },
      })
  }
  const packages = software.android.filter(
    (pkg) => !inventory.tools.android.includes(pkg),
  )
  if (packages.length > 0)
    out.push({
      id: `android:${packages.join(',')}`,
      kind: 'tool',
      request: { tool: 'android', packages },
    })

  // Low disk: unpinned Mason-installed Xcodes, then unpinned runtimes, oldest first.
  if (inventory.freeDisk < type.diskThresholdGb * 1024 ** 3) {
    const xcodes = inventory.xcodes
      .filter((install) => {
        const version = masonVersion(install)
        return (
          version != null &&
          !software.xcode.includes(version) &&
          !state.inUse.includes(install.path)
        )
      })
      .sort((a, b) => compareVersions(a.version, b.version))
    for (const install of xcodes)
      out.push({
        id: `remove-xcode:${masonVersion(install)!}`,
        kind: 'removeXcode',
        version: masonVersion(install)!,
        path: install.path,
      })
    // A runtime cannot be tied to one stage, so none is removed while a stage runs.
    if (state.inUse.length === 0) {
      const runtimes = (system?.runtimes ?? [])
        .filter(
          (runtime): runtime is SimulatorRuntime & { image: string } =>
            runtime.image != null &&
            !software.simulators.includes(runtime.name),
        )
        .sort((a, b) => compareVersions(a.version, b.version))
      for (const runtime of runtimes)
        out.push({
          id: `remove-runtime:${runtime.name}`,
          kind: 'removeRuntime',
          name: runtime.name,
          image: runtime.image,
        })
    }
  }
  return out
}

/** Manual steps the node reports: what reconciliation or placement cannot do by itself. */
export function checklist(
  type: NodeType | undefined,
  state: NodeState,
  helper: boolean,
): ChecklistItem[] {
  const out: ChecklistItem[] = []
  const system = state.inventory.system
  if (!helper)
    out.push({
      id: 'helper',
      title:
        'Install the helper: run sudo mason worker --install on this computer',
      blocks: ['system'],
    })
  for (const install of state.inventory.xcodes) {
    const launch = system?.launches[install.path]
    if (launch != null && !launch.ok)
      out.push({
        id: `xcode-launch:${install.version}`,
        title: `Xcode ${install.version} does not run on macOS ${state.inventory.osVersion}: ${launch.error ?? 'it does not launch'}; upgrade macOS or remove it`,
        blocks: [`xcode:${install.version}`],
      })
  }
  if (
    state.inventory.os === 'macos' &&
    system != null &&
    system.brew == null &&
    type != null &&
    (type.software.brew.formulae.length > 0 ||
      type.software.brew.casks.length > 0)
  )
    out.push({
      id: 'brew',
      title:
        'Install Homebrew (https://brew.sh) as this computer’s administrator',
      blocks: ['brew'],
    })
  return out
}

export interface ItemContext {
  log: (text: string) => void
  /** Calls the privileged helper. */
  helper: (op: string, args: Record<string, unknown>) => Promise<unknown>
  /** Asks the master for an Xcode download authorization. */
  authorize: (version: string) => Promise<{ url: string; cookie: string }>
  /** Runs a tools-directory installer. */
  installTool: (request: InstallRequest) => Promise<void>
  /** The master's copy of an exported simulator runtime: fetched into `file`, or false when it has none. */
  fetchRuntime: (name: string, file: string) => Promise<boolean>
  /** Gives the master an exported runtime for the other nodes. */
  storeRuntime: (name: string, file: string) => Promise<void>
  run: SystemRun
  /** Scratch space owned by the worker's user. */
  scratch: string
  /** Installed Xcodes, for runtime work. */
  xcodes: () => XcodeInstall[]
  launches: (install: XcodeInstall) => Promise<boolean>
}

const platformOf = (name: string): { platform: string; version: string } => {
  const [platform, version] = name.split(' ')
  return {
    platform: platform === 'visionOS' ? 'visionOS' : platform!,
    version: version ?? '',
  }
}

/** Downloads an Xcode straight from Apple with the master's one-file authorization. */
export async function downloadXcode(
  version: string,
  context: ItemContext,
): Promise<string> {
  const auth = await context.authorize(version)
  const dir = path.join(context.scratch, 'xcode')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `Xcode-${version}.xip`)
  context.log(`Downloading Xcode ${version} from Apple\n`)
  const response = await fetch(auth.url, { headers: { Cookie: auth.cookie } })
  if (!response.ok || response.body == null)
    throw new Error(
      `Apple refused the Xcode ${version} download (${response.status})`,
    )
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(file, { mode: 0o600 }),
  )
  return file
}

/** The newest Xcode on the node that launches, for runtime downloads and imports. */
async function runtimeXcode(context: ItemContext): Promise<XcodeInstall> {
  const installs = [...context.xcodes()].sort((a, b) =>
    compareVersions(b.version, a.version),
  )
  for (const install of installs)
    if (!install.beta && (await context.launches(install))) return install
  throw new Error('No Xcode on this node launches; simulator runtimes need one')
}

/** Performs one item. Throws on failure; the caller carries on with the rest. */
export async function performItem(
  item: ReconcileItem,
  context: ItemContext,
): Promise<void> {
  switch (item.kind) {
    case 'xcode': {
      const xip = await downloadXcode(item.version, context)
      try {
        context.log(`Installing Xcode ${item.version}\n`)
        await context.helper('xcode.install', { version: item.version, xip })
      } finally {
        rmSync(xip, { force: true })
      }
      return
    }
    case 'runtime': {
      const xcode = await runtimeXcode(context)
      const dir = path.join(
        context.scratch,
        'runtimes',
        item.name.replace(/\s+/g, '-'),
      )
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try {
        let file = path.join(dir, 'runtime.dmg')
        if (await context.fetchRuntime(item.name, file))
          context.log(`Fetched ${item.name} from the master\n`)
        else {
          // The first node to need it exports it once; the master keeps it for the rest.
          const { platform, version } = platformOf(item.name)
          context.log(`Downloading ${item.name} with Xcode ${xcode.version}\n`)
          const exported = await context.run(
            'xcodebuild',
            [
              '-downloadPlatform',
              platform,
              '-buildVersion',
              version,
              '-exportPath',
              dir,
            ],
            {
              env: { DEVELOPER_DIR: developerDir(xcode.path) },
              timeoutMs: 4 * 60 * 60 * 1000,
            },
          )
          if (exported.code !== 0)
            throw new Error(
              `xcodebuild -downloadPlatform failed: ${(exported.stderr || exported.stdout).trim().split('\n').pop() ?? ''}`,
            )
          const image = readdirSync(dir).find((name) => name.endsWith('.dmg'))
          if (image == null)
            throw new Error('xcodebuild exported no runtime image')
          file = path.join(dir, image)
          await context.storeRuntime(item.name, file)
        }
        await context.helper('runtime.import', { file, xcode: xcode.path })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      return
    }
    case 'commandLineTools':
      await context.helper('clt.install', {})
      return
    case 'rosetta':
      await context.helper('rosetta.install', {})
      return
    case 'brew':
      await context.helper(
        'brew.install',
        item.formula != null
          ? { formulae: [item.formula] }
          : { casks: [item.cask] },
      )
      return
    case 'apt':
    case 'dnf':
      await context.helper(`${item.kind}.install`, { packages: [item.package] })
      return
    case 'docker':
      await context.helper('docker.install', {})
      return
    case 'setting':
      await context.helper('settings.apply', { name: item.name })
      return
    case 'tool':
      await context.installTool(item.request)
      return
    case 'removeXcode':
      await context.helper('xcode.remove', { version: item.version })
      return
    case 'removeRuntime':
      await context.helper('runtime.remove', { image: item.image })
      return
  }
}

export interface Progress {
  item: string
  state: 'running' | 'done' | 'failed' | 'blocked' | 'skipped'
  error?: string
}

/**
 * Runs a plan in order. A failed item is reported and the rest go on;
 * helper items wait as blocked when the helper is missing; removals stop
 * once free disk is back above the threshold.
 */
export async function reconcile(
  plan: ReconcileItem[],
  context: ItemContext & {
    helperReady: boolean
    progress: (progress: Progress) => void
    /** Free bytes now, and the threshold removals stop at. */
    freeDisk?: () => number
    thresholdBytes?: number
  },
): Promise<Progress[]> {
  const results: Progress[] = []
  const report = (progress: Progress): void => {
    context.progress(progress)
    if (progress.state !== 'running') results.push(progress)
  }
  for (const item of plan) {
    if (
      (item.kind === 'removeXcode' || item.kind === 'removeRuntime') &&
      context.freeDisk != null &&
      context.thresholdBytes != null &&
      context.freeDisk() >= context.thresholdBytes
    ) {
      report({ item: item.id, state: 'skipped' })
      continue
    }
    if (needsHelper(item) && !context.helperReady) {
      report({
        item: item.id,
        state: 'blocked',
        error: 'Waiting for the helper: run sudo mason worker --install',
      })
      continue
    }
    report({ item: item.id, state: 'running' })
    try {
      await performItem(item, context)
      report({ item: item.id, state: 'done' })
    } catch (error) {
      context.log(`${item.id}: ${(error as Error).message}\n`)
      report({
        item: item.id,
        state: 'failed',
        error: (error as Error).message,
      })
    }
  }
  return results
}

export const freeBytes = (dir: string): number => {
  const disk = statfsSync(dir)
  return disk.bavail * disk.bsize
}
