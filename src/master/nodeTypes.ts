/**
 * Node types are desired state: the software every node of a type keeps and
 * the settings Mason needs for builds. The master stores them in the
 * `nodeTypes` settings area and sends each node its type's definition; the
 * node reconciles against its inventory.
 */

import {
  LinkError,
  type Link,
  type MethodTable,
  type Stream,
} from '../link/link.js'
import type { FullInventory } from '../worker/inventory.js'
import type { ChecklistItem, Progress } from '../worker/system/reconcile.js'
import type { AppleDownloads, AppleStatus } from './apple/developerDownloads.js'
import type { NodeRegistry } from './nodes.js'
import type { RuntimeStore } from './runtimes.js'
import type { Settings } from './settings.js'

export interface NodeTypeSoftware {
  /** Xcode versions to keep installed, side by side. */
  xcode: string[]
  /** The Xcode a stage uses when it names none and the repository has no `.xcode-version`. */
  xcodeDefault?: string
  /** Whether `latest-beta` may pick a beta. */
  allowBeta: boolean
  /** Simulator runtimes, `iOS 26.1`. */
  simulators: string[]
  commandLineTools: boolean
  rosetta: boolean
  brew: { formulae: string[]; casks: string[] }
  apt: string[]
  dnf: string[]
  docker: boolean
  node?: string
  java?: string
  rust?: string
  python?: string
  go?: string
  ruby?: string
  android: string[]
}

export interface NodeTypeSettings {
  noSleep: boolean
  devToolsSecurity: boolean
  automationMode: boolean
}

export interface NodeType {
  software: NodeTypeSoftware
  settings: NodeTypeSettings
  /** Unused Xcodes and runtimes are removed when free disk falls below this. */
  diskThresholdGb: number
  /** Who accepted the Android SDK licences for this type, and when. */
  androidLicensesAccepted?: { by: string; at: number }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

function list(value: unknown, what: string, pattern: RegExp): string[] {
  if (value == null) return []
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((item) => typeof item !== 'string' || !pattern.test(item))
  )
    throw new Error(`${what} must be a list of names`)
  return [...new Set(value as string[])]
}
const version = (value: unknown, what: string): string | undefined => {
  if (value == null) return undefined
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(value)
  )
    throw new Error(`${what} is a version`)
  return value
}
const flag = (value: unknown, what: string): boolean => {
  if (value == null) return false
  if (typeof value !== 'boolean') throw new Error(`${what} is true or false`)
  return value
}

const packageName = /^[a-z0-9][a-z0-9@._+-]{0,99}$/

/** Checks one node type's definition and fills its defaults. */
export function asNodeType(
  value: unknown,
  previous: NodeType | undefined,
  accepted: { by: string; at: number },
): NodeType {
  const input = isObject(value) ? value : {}
  const software = isObject(input.software) ? input.software : {}
  const settings = isObject(input.settings) ? input.settings : {}
  const brew = isObject(software.brew) ? software.brew : {}
  const xcode = list(
    software.xcode,
    'software.xcode',
    /^\d+(?:\.\d+){0,2}(?:-beta\d*|-rc\d*)?$/,
  )
  const xcodeDefault = version(software.xcodeDefault, 'software.xcodeDefault')
  if (xcodeDefault != null && !xcode.includes(xcodeDefault))
    throw new Error('software.xcodeDefault must be one of software.xcode')
  const threshold = input.diskThresholdGb ?? 40
  if (
    typeof threshold !== 'number' ||
    !Number.isFinite(threshold) ||
    threshold < 0
  )
    throw new Error('diskThresholdGb is a number of gigabytes')
  if (
    input.androidLicensesAccepted != null &&
    typeof input.androidLicensesAccepted !== 'boolean'
  )
    throw new Error('androidLicensesAccepted is true or false')
  const node = version(software.node, 'software.node')
  const java = version(software.java, 'software.java')
  const rust = version(software.rust, 'software.rust')
  const python = version(software.python, 'software.python')
  const go = version(software.go, 'software.go')
  const ruby = version(software.ruby, 'software.ruby')
  return {
    software: {
      xcode,
      ...(xcodeDefault == null ? {} : { xcodeDefault }),
      allowBeta: flag(software.allowBeta, 'software.allowBeta'),
      simulators: list(
        software.simulators,
        'software.simulators',
        /^(iOS|tvOS|watchOS|visionOS|xrOS) \d+(?:\.\d+){0,2}$/,
      ),
      commandLineTools: flag(
        software.commandLineTools,
        'software.commandLineTools',
      ),
      rosetta: flag(software.rosetta, 'software.rosetta'),
      brew: {
        formulae: list(brew.formulae, 'software.brew.formulae', packageName),
        casks: list(brew.casks, 'software.brew.casks', packageName),
      },
      apt: list(software.apt, 'software.apt', packageName),
      dnf: list(software.dnf, 'software.dnf', packageName),
      docker: flag(software.docker, 'software.docker'),
      ...(node == null ? {} : { node }),
      ...(java == null ? {} : { java }),
      ...(rust == null ? {} : { rust }),
      ...(python == null ? {} : { python }),
      ...(go == null ? {} : { go }),
      ...(ruby == null ? {} : { ruby }),
      android: list(
        software.android,
        'software.android',
        /^[A-Za-z0-9][A-Za-z0-9;._-]{0,99}$/,
      ),
    },
    settings: {
      noSleep: flag(settings.noSleep, 'settings.noSleep'),
      devToolsSecurity: flag(
        settings.devToolsSecurity,
        'settings.devToolsSecurity',
      ),
      automationMode: flag(settings.automationMode, 'settings.automationMode'),
    },
    diskThresholdGb: threshold,
    ...(input.androidLicensesAccepted === true
      ? {
          androidLicensesAccepted:
            previous?.androidLicensesAccepted ?? accepted,
        }
      : {}),
  }
}

/** The `nodeTypes` settings area: type name → definition. */
export function nodeTypesSetting(
  input: unknown,
  previous: Record<string, unknown> | undefined,
  context: { actor: { label: string }; now: number },
): Record<string, unknown> {
  if (!isObject(input))
    throw new Error('nodeTypes maps node type names to their settings')
  const out: Record<string, unknown> = {}
  for (const [type, value] of Object.entries(input)) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(type))
      throw new Error(`Invalid node type ${type}`)
    out[type] = asNodeType(value, previous?.[type] as NodeType | undefined, {
      by: context.actor.label,
      at: context.now,
    })
  }
  return out
}

/** A stored definition in this release's shape; types saved before node software existed get the defaults. */
export function storedNodeType(value: unknown): NodeType | undefined {
  if (value == null || typeof value !== 'object') return undefined
  const stored = value as Partial<NodeType>
  try {
    const { androidLicensesAccepted, ...rest } = stored
    return {
      ...asNodeType(rest, undefined, { by: '', at: 0 }),
      ...(androidLicensesAccepted == null ? {} : { androidLicensesAccepted }),
    }
  } catch {
    return undefined
  }
}

export interface NodeProgress {
  items: Record<string, Progress>
  at: number
  log?: string
}

/** A manual step on the master (the Apple ID code), shown on every node it blocks. */
export function masterChecklist(
  apple: AppleStatus,
  wantsXcode: boolean,
): ChecklistItem[] {
  if (apple.state === 'signedIn' || (!wantsXcode && apple.appleId == null))
    return []
  return [
    {
      id: 'apple',
      title:
        apple.notice ??
        'Sign in to an Apple ID for Xcode downloads: run mason apple sign-in on the master',
      blocks: ['apple'],
    },
  ]
}

/**
 * The master's side of node software: sends each worker its type's
 * definition when it connects and when the type changes, records the
 * progress it reports, and answers the worker's requests for Xcode download
 * authorizations and simulator runtimes.
 */
export class NodeStates {
  private readonly progress = new Map<string, NodeProgress>()
  constructor(
    private readonly options: {
      registry: NodeRegistry
      settings: Settings
      apple: AppleDownloads
      runtimes: RuntimeStore
      storeInventory: (fingerprint: string, inventory: FullInventory) => void
      /** The host's Xcode mirror: relay a node's first download, and authorize downloads from it. */
      mirror?: {
        authorize(
          version: string,
        ): { url: string; cookie: string; pin?: string } | undefined
        relay(
          params: { version: string; sha256: string; size: number },
          stream: Stream,
        ): Promise<void>
      }
      /** Whether a stage preparing on this worker asked for this system install. */
      requested: (
        fingerprint: string,
        tool: 'xcode' | 'simulators',
        name: string,
      ) => boolean
      now: () => number
    },
  ) {}

  type(name: string): NodeType | undefined {
    return storedNodeType(this.options.settings.value('nodeTypes')?.[name])
  }

  /** Sends a connected worker its type; it reconciles and reports progress. */
  reconcile(fingerprint: string): void {
    const node = this.options.registry.get(fingerprint)
    const link = this.options.registry.link(fingerprint)
    if (node?.role !== 'worker' || link == null) return
    const type = this.type(node.type)
    if (type == null) return
    void link.request('node.reconcile', { type }).catch(() => undefined)
  }

  /** After a type changes: every connected node of it reconciles. */
  reconcileAll(): void {
    for (const node of this.options.registry.list())
      this.reconcile(node.fingerprint)
  }

  details(fingerprint: string): { reconcile?: NodeProgress } {
    const progress = this.progress.get(fingerprint)
    return progress == null ? {} : { reconcile: progress }
  }

  /** Whether any node type keeps an Xcode, so the Apple sign-in is a checklist item. */
  wantsXcode(): boolean {
    return Object.values(this.options.settings.value('nodeTypes') ?? {}).some(
      (value) => (storedNodeType(value)?.software.xcode.length ?? 0) > 0,
    )
  }

  private worker(link: Link): {
    fingerprint: string
    type: NodeType | undefined
  } {
    const fingerprint = link.peer?.fingerprint
    const node =
      fingerprint == null ? undefined : this.options.registry.get(fingerprint)
    if (node?.role !== 'worker' || link.peerRole !== 'worker')
      throw new LinkError('Only workers ask for this', 'not_allowed')
    return { fingerprint: node.fingerprint, type: this.type(node.type) }
  }

  methods(): MethodTable {
    return {
      events: {
        'node.progress': (params, link): void => {
          const { fingerprint } = this.worker(link)
          const progress = params as Progress
          if (typeof progress?.item !== 'string') return
          const entry = this.progress.get(fingerprint) ?? { items: {}, at: 0 }
          entry.items[progress.item.slice(0, 200)] = {
            item: progress.item.slice(0, 200),
            state: progress.state,
            ...(progress.error == null
              ? {}
              : { error: String(progress.error).slice(0, 2000) }),
          }
          entry.at = this.options.now()
          this.progress.set(fingerprint, entry)
        },
        'node.inventory': (params, link): void => {
          const { fingerprint } = this.worker(link)
          const inventory = (params as { inventory?: FullInventory }).inventory
          if (inventory != null)
            this.options.storeInventory(fingerprint, inventory)
        },
        'node.reconciled': (params, link): void => {
          const { fingerprint } = this.worker(link)
          const { inventory, log } = params as {
            inventory?: FullInventory
            log?: string
          }
          if (inventory != null)
            this.options.storeInventory(fingerprint, inventory)
          const entry = this.progress.get(fingerprint) ?? { items: {}, at: 0 }
          entry.at = this.options.now()
          if (typeof log === 'string') entry.log = log.slice(-64 * 1024)
          this.progress.set(fingerprint, entry)
        },
      },
      requests: {
        /** One file's download authorization; never the Apple ID or its session. */
        'xcode.authorize': async (
          params,
          link,
        ): Promise<{ url: string; cookie: string; pin?: string }> => {
          const { fingerprint, type } = this.worker(link)
          const version = String(
            (params as { version?: unknown }).version ?? '',
          )
          if (
            !(type?.software.xcode.includes(version) ?? false) &&
            !this.options.requested(fingerprint, 'xcode', version)
          )
            throw new LinkError(
              `Xcode ${version} is not wanted on this node`,
              'not_allowed',
            )
          try {
            return await this.options.apple.authorize(version)
          } catch (error) {
            // With Apple's session lapsed, the host's mirror serves the version a node downloaded before.
            const mirror = this.options.mirror?.authorize(version)
            if (mirror != null) return mirror
            throw new LinkError((error as Error).message, 'failed')
          }
        },
        'runtime.lookup': (params, link): { stored: boolean } => {
          this.worker(link)
          return {
            stored: this.options.runtimes.has(
              (params as { name?: unknown }).name,
            ),
          }
        },
      },
      streams: {
        /** A node's first download of an Xcode, copied to the host's storage. */
        'xcode.mirror': async (stream, params, link): Promise<void> => {
          try {
            this.worker(link)
            const relay = this.options.mirror?.relay
            if (relay == null) throw new Error('No mirror')
            await relay(
              params as { version: string; sha256: string; size: number },
              stream,
            )
            stream.end()
          } catch (error) {
            stream.abort((error as Error).message)
          }
        },
        'runtime.get': async (stream, params, link): Promise<void> => {
          try {
            this.worker(link)
            const file = this.options.runtimes.open(
              (params as { name?: unknown }).name,
            )
            if (file == null) throw new Error('No such runtime')
            for await (const chunk of file) await stream.write(chunk as Buffer)
            stream.end()
          } catch (error) {
            stream.abort((error as Error).message)
          }
        },
        'runtime.put': async (stream, params, link): Promise<void> => {
          try {
            const { fingerprint, type } = this.worker(link)
            const name = String((params as { name?: unknown }).name ?? '')
            if (
              !(type?.software.simulators.includes(name) ?? false) &&
              !this.options.requested(fingerprint, 'simulators', name)
            )
              throw new Error(`${name} is not wanted on this node`)
            await this.options.runtimes.put(name, stream)
            stream.end()
          } catch (error) {
            stream.abort((error as Error).message)
          }
        },
      },
    }
  }
}
