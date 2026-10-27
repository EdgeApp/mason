import { createReadStream } from 'node:fs'
import { compareSemver, major } from '../release/install.js'
import type { FullInventory } from '../worker/inventory.js'
import type { NodeRegistry } from './nodes.js'
import type { Releases } from './releases.js'

export interface UpdateState {
  version: string
  status: 'sending' | 'installed' | 'failed'
  reason?: string
  at: number
}

/** The tarball platform of a worker, from its inventory. */
export const inventoryPlatform = (
  inventory: Pick<FullInventory, 'os' | 'arch'>,
): string =>
  `${inventory.os === 'macos' ? 'darwin' : 'linux'}-${inventory.arch}`

/**
 * Pushes the current release to each idle worker that runs an older version
 * of the same major version, signed with the master's key.
 */
export class Updates {
  private readonly states = new Map<string, UpdateState>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly registry: NodeRegistry,
    private readonly releases: Releases,
    private readonly inventory: (
      fingerprint: string,
    ) => FullInventory | undefined,
    /** Whether a worker has a stage or setup run in progress. */
    private readonly busy: (fingerprint: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  state(fingerprint: string): UpdateState | undefined {
    return this.states.get(fingerprint)
  }

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => {
      void this.tick()
    }, intervalMs)
    this.timer.unref()
  }
  stop(): void {
    clearInterval(this.timer)
  }

  async tick(): Promise<void> {
    const current = this.releases.current()
    if (current == null) return
    await Promise.all(
      this.registry
        .list()
        .filter((node) => node.role === 'worker')
        .map(async (node) => {
          const inventory = this.inventory(node.fingerprint)
          if (inventory == null || this.registry.link(node.fingerprint) == null)
            return
          const state = this.states.get(node.fingerprint)
          if (compareSemver(current, inventory.version) <= 0) {
            // The helper restarts a system install before its worker can
            // answer; the worker coming back on that version is the answer.
            if (
              state != null &&
              state.status !== 'installed' &&
              compareSemver(inventory.version, state.version) >= 0
            )
              this.states.set(node.fingerprint, {
                version: state.version,
                status: 'installed',
                at: this.now(),
              })
            return
          }
          if (state?.version === current && state.status !== 'failed') return
          // A failed push is retried after a minute, in case the worker was only busy.
          if (state?.version === current && this.now() - state.at < 60_000)
            return
          if (major(current) !== major(inventory.version)) {
            this.states.set(node.fingerprint, {
              version: current,
              status: 'failed',
              reason: `${node.name} runs ${inventory.version}; ${current} is another major version`,
              at: this.now(),
            })
            return
          }
          if (this.busy(node.fingerprint)) return
          await this.push(
            node.fingerprint,
            current,
            inventoryPlatform(inventory),
          )
        }),
    )
  }

  async push(
    fingerprint: string,
    version: string,
    platform: string,
  ): Promise<UpdateState> {
    const set = (
      status: UpdateState['status'],
      reason?: string,
    ): UpdateState => {
      const state = {
        version,
        status,
        ...(reason == null ? {} : { reason }),
        at: this.now(),
      }
      this.states.set(fingerprint, state)
      return state
    }
    const signed = await this.releases.signed(version, platform)
    if (signed == null)
      return set('failed', `Release ${version} has no ${platform} tarball`)
    const link = this.registry.link(fingerprint)
    if (link == null) return set('failed', 'The worker is not connected')
    set('sending')
    const { file, signature, ...manifest } = signed
    const stream = link.openStream('update.install', { manifest, signature })
    const answer = new Promise<UpdateState>((resolve) => {
      let reply = ''
      stream.on('data', (chunk: Buffer) => {
        reply += chunk.toString()
      })
      stream.once('end', () => {
        stream.end()
        resolve(
          reply.includes('"installed"')
            ? set('installed')
            : set('failed', 'The worker gave no answer'),
        )
      })
      stream.once('abort', (reason: string) => {
        resolve(set('failed', reason))
      })
    })
    try {
      for await (const chunk of createReadStream(file))
        await stream.write(chunk as Buffer)
      stream.end()
    } catch {
      // The worker refused before the whole tarball went; its reason comes with the abort.
    }
    return await answer
  }
}
