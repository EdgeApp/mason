import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { decodePlist } from '../devices/plist.js'
import type { Inventory } from './baseInventory.js'
import { installedTools, type InstalledTools } from './tools/index.js'
import type { XcodeInstall } from './tools/versions.js'
import type { SystemInventory } from './system/index.js'
import type { ChecklistItem } from './system/reconcile.js'

/** The inventory a worker reports on link open and after every install. */
export interface FullInventory extends Inventory {
  xcodes: XcodeInstall[]
  tools: InstalledTools
  /** Whether the privileged helper answers on this node. */
  helper?: 'ready' | 'missing'
  /** System software and settings beyond the tools directory. */
  system?: SystemInventory
  /** Manual steps only a person can do. */
  checklist?: ChecklistItem[]
}

/** Xcodes installed as `Xcode*.app` bundles: version, build, path and whether it is a beta. */
export function scanXcodes(applications = '/Applications'): XcodeInstall[] {
  let names: string[]
  try {
    names = readdirSync(applications).filter((name) =>
      /^Xcode.*\.app$/.test(name),
    )
  } catch {
    return []
  }
  const out: XcodeInstall[] = []
  for (const name of names) {
    const app = path.join(applications, name)
    try {
      const info = decodePlist(
        readFileSync(path.join(app, 'Contents', 'Info.plist')),
      )
      const versionFile = path.join(app, 'Contents', 'version.plist')
      const build = existsSync(versionFile)
        ? String(
            decodePlist(readFileSync(versionFile)).ProductBuildVersion ?? '',
          )
        : String(info.DTXcodeBuild ?? '')
      const version = String(info.CFBundleShortVersionString ?? '')
      if (version === '') continue
      out.push({ version, build, path: app, beta: /beta/i.test(name) })
    } catch {
      // Not a readable Xcode bundle.
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function fullInventory(
  base: Inventory,
  options: { applications?: string; toolsDir: string },
): FullInventory {
  return {
    ...base,
    xcodes: base.os === 'macos' ? scanXcodes(options.applications) : [],
    tools: installedTools(options.toolsDir),
  }
}
