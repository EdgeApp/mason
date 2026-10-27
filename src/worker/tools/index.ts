import { readdirSync } from 'node:fs'
import path from 'node:path'
import type { Tools } from '../../../types/mason/index.js'
import {
  androidEnvironment,
  installAndroid,
  installedPackages,
  sdkRoot,
} from './android.js'
import { brewPath } from '../system/index.js'
import { readMarker, type InstallContext } from './common.js'
import { installJava, javaEnvironment, javaHome } from './java.js'
import { installNode, nodeEnvironment } from './node.js'
import { installRust, rustEnvironment } from './rust.js'
import { compareVersions, newestMatch } from './versions.js'

/** The only tools a master can ask a worker to install. There is no remote-command RPC. */
export const installable = ['node', 'rust', 'java', 'android'] as const
export type InstallableTool = (typeof installable)[number]

export interface InstallRequest {
  /** A tools-directory installer, or a system install (`xcode`, `simulators`, `brew`, `apt`, `dnf`) the worker does through its helper. */
  tool: InstallableTool | 'xcode' | 'simulators' | 'brew' | 'apt' | 'dnf'
  /** A version for node, rust, java and xcode; sdkmanager packages for android; names for the system tools. */
  version?: string
  packages?: string[]
  /** For android: whether the node's type records an administrator's licence acceptance. */
  acceptLicences?: boolean
  nodeType?: string
}

/** Tools in the tools directory: versions per tool, Android packages. */
export interface InstalledTools {
  node: string[]
  rust: string[]
  java: string[]
  android: string[]
}

function versions(toolsDir: string, tool: string): string[] {
  try {
    return readdirSync(path.join(toolsDir, tool), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          readMarker(path.join(toolsDir, tool, entry.name)) != null,
      )
      .map((entry) => entry.name)
      .sort(compareVersions)
  } catch {
    return []
  }
}

export function installedTools(toolsDir: string): InstalledTools {
  return {
    node: versions(toolsDir, 'node'),
    rust: versions(toolsDir, 'rust'),
    java: versions(toolsDir, 'java'),
    android: installedPackages(sdkRoot(toolsDir)),
  }
}

/** Runs one installer from the closed set; anything else is refused. */
export async function install(
  request: InstallRequest,
  context: InstallContext,
): Promise<string> {
  const version = request.version ?? ''
  switch (request.tool) {
    case 'node':
      return await installNode(version, context)
    case 'rust':
      return await installRust(version, context)
    case 'java':
      return await installJava(version, context)
    case 'android': {
      const java = installedTools(context.toolsDir).java.pop()
      await installAndroid(request.packages ?? [], {
        ...context,
        nodeType: request.nodeType ?? '',
        acceptLicences: request.acceptLicences === true,
        ...(java == null
          ? {}
          : { javaHome: javaHome(path.join(context.toolsDir, 'java', java)) }),
      })
      return (request.packages ?? []).join(',')
    }
    default:
      throw new Error(
        `${String((request as { tool?: unknown }).tool)} is not a tool Mason installs`,
      )
  }
}

/** What a stage's `tools` still needs on this node, as install requests. */
export function missingTools(
  tools: Tools | undefined,
  installed: InstalledTools,
): InstallRequest[] {
  if (tools == null) return []
  const out: InstallRequest[] = []
  for (const tool of ['node', 'rust', 'java'] as const) {
    const version = tools[tool]
    if (version != null && newestMatch(version, installed[tool]) == null)
      out.push({ tool, version })
  }
  const packages = (tools.android ?? []).filter(
    (pkg) => !installed.android.includes(pkg),
  )
  if (packages.length > 0) out.push({ tool: 'android', packages })
  return out
}

/**
 * The environment a stage gets for its `tools`: each tool's `bin` first on
 * `PATH`, and its home variables. A stage that lists Homebrew formulae gets
 * Homebrew's `bin` after them, since a service's own `PATH` lacks it.
 */
export function toolEnvironment(
  tools: Tools | undefined,
  toolsDir: string,
  basePath: string,
  brew: string | null = brewPath() ?? null,
): Record<string, string> {
  if (tools == null) return {}
  const installed = installedTools(toolsDir)
  const paths: string[] = []
  const env: Record<string, string> = {}
  const add = (part: { path: string[]; env: Record<string, string> }): void => {
    paths.push(...part.path)
    Object.assign(env, part.env)
  }
  const pick = (tool: 'node' | 'rust' | 'java'): string | undefined =>
    tools[tool] == null ? undefined : newestMatch(tools[tool], installed[tool])
  const node = pick('node')
  if (node != null) add(nodeEnvironment(path.join(toolsDir, 'node', node)))
  const rust = pick('rust')
  if (rust != null) add(rustEnvironment(path.join(toolsDir, 'rust', rust)))
  const java = pick('java')
  if (java != null) add(javaEnvironment(path.join(toolsDir, 'java', java)))
  if (tools.android != null) add(androidEnvironment(toolsDir))
  if ((tools.brew ?? []).length > 0 && brew != null)
    paths.push(path.dirname(brew))
  if (paths.length === 0) return env
  return { ...env, PATH: [...paths, basePath].join(path.delimiter) }
}
