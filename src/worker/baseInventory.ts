import { execFileSync } from 'node:child_process'
import { statfsSync } from 'node:fs'
import os from 'node:os'
import type { Arch, Os } from '../../types/mason/index.js'

/** What a worker reports when its master's link opens; stored in `worker_inventory`. */
export interface Inventory {
  name: string
  type: string
  labels: string[]
  os: Os
  osVersion: string
  arch: Arch
  hostname: string
  /** Free bytes on the data directory's volume. */
  freeDisk: number
  /** Stages it runs at once. */
  slots: number
  /** Mason's version on the node. */
  version: string
  /** Why the guardian could not prove a stage's processes stopped; no stages are assigned until `recover`. */
  quarantine?: string
}

export function platformOs(platform = process.platform): Os {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

export function osVersion(platform = process.platform): string {
  try {
    if (platform === 'darwin')
      return execFileSync('sw_vers', ['-productVersion'], {
        encoding: 'utf8',
        timeout: 3000,
      }).trim()
  } catch {
    // Fall through to the kernel release.
  }
  return os.release()
}

export function baseInventory(options: {
  dir: string
  name?: string
  type?: string
  labels?: string[]
  slots?: number
  version: string
  quarantine?: string
}): Inventory {
  const disk = statfsSync(options.dir)
  return {
    name: options.name ?? os.hostname(),
    type: options.type ?? '',
    labels: options.labels ?? [],
    os: platformOs(),
    osVersion: osVersion(),
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    hostname: os.hostname(),
    freeDisk: disk.bavail * disk.bsize,
    slots: options.slots ?? 1,
    version: options.version,
    ...(options.quarantine == null ? {} : { quarantine: options.quarantine }),
  }
}
