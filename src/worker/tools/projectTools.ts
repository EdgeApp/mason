import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { compareVersions } from './versions.js'

/** Tools a stage may set to `'project'`: the repository's pin file names the version. */
export const projectTools = [
  'node',
  'rust',
  'java',
  'python',
  'ruby',
  'go',
  'xcode',
] as const
export type ProjectTool = (typeof projectTools)[number]

/** The version a repository pins for one tool. */
export interface ProjectVersion {
  /** The file it came from: `.nvmrc`, `rust-toolchain.toml`, `.tool-versions`, … */
  file: string
  /** A version the tool's installer accepts, when the file names one. */
  version?: string
  /** Why the file's value was not used. */
  problem?: string
}

/** A Node.js release in `index.json`: `lts` is the codename, or false. */
export interface NodeRelease {
  version: string
  lts?: string | false
}

function small(dir: string, name: string): string | undefined {
  const file = path.join(dir, name)
  return existsSync(file) &&
    lstatSync(file).isFile() &&
    lstatSync(file).size < 64 * 1024
    ? readFileSync(file, 'utf8')
    : undefined
}

const firstLine = (text: string | undefined): string | undefined => {
  const line = text
    ?.split('\n')
    .map((entry) => entry.replace(/#.*/, '').trim())
    .find((entry) => entry !== '')
  return line === '' ? undefined : line
}

/** `.tool-versions` (asdf, mise) names per tool. */
const toolVersionsNames: Record<ProjectTool, string[]> = {
  node: ['nodejs', 'node'],
  rust: ['rust'],
  java: ['java'],
  python: ['python'],
  ruby: ['ruby'],
  go: ['golang', 'go'],
  xcode: ['xcode'],
}

function fromToolVersions(dir: string, tool: ProjectTool): string | undefined {
  for (const line of (small(dir, '.tool-versions') ?? '').split('\n')) {
    const [name, version] = line.replace(/#.*/, '').trim().split(/\s+/)
    if (name != null && toolVersionsNames[tool].includes(name) && version)
      return version
  }
  return undefined
}

/** A TOML string value under `[section]` (or at the top), enough for the pin files below. */
function tomlValue(
  text: string,
  section: string | undefined,
  key: string,
): string | undefined {
  let current: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header != null) {
      current = header[1]!.trim()
      continue
    }
    if (current !== section) continue
    const match = new RegExp(`^${key}\\s*=\\s*["']([^"']*)["']`).exec(line)
    if (match != null) return match[1]
  }
  return undefined
}

type Found = { file: string; text: string }
const found = (file: string, text: string | undefined): Found | undefined =>
  text == null || text.trim() === '' ? undefined : { file, text: text.trim() }

/** Where each tool's version is pinned, first match wins. */
const readers: Record<
  ProjectTool,
  Array<(dir: string) => Found | undefined>
> = {
  node: [
    (dir): Found | undefined =>
      found('.nvmrc', firstLine(small(dir, '.nvmrc'))),
    (dir): Found | undefined =>
      found('.node-version', firstLine(small(dir, '.node-version'))),
    (dir): Found | undefined =>
      found('.tool-versions', fromToolVersions(dir, 'node')),
    (dir): Found | undefined => {
      try {
        const engines = (
          JSON.parse(small(dir, 'package.json') ?? '{}') as {
            engines?: { node?: unknown }
          }
        ).engines?.node
        return typeof engines === 'string'
          ? found('package.json', engines)
          : undefined
      } catch {
        return undefined
      }
    },
  ],
  rust: [
    (dir): Found | undefined => {
      const text = small(dir, 'rust-toolchain.toml')
      return text == null
        ? undefined
        : found(
            'rust-toolchain.toml',
            tomlValue(text, 'toolchain', 'channel') ?? '',
          )
    },
    (dir): Found | undefined => {
      const text = small(dir, 'rust-toolchain')
      if (text == null) return undefined
      return found(
        'rust-toolchain',
        text.includes('[')
          ? (tomlValue(text, 'toolchain', 'channel') ?? '')
          : firstLine(text),
      )
    },
    (dir): Found | undefined =>
      found('.tool-versions', fromToolVersions(dir, 'rust')),
  ],
  java: [
    (dir): Found | undefined =>
      found('.java-version', firstLine(small(dir, '.java-version'))),
    (dir): Found | undefined => {
      const line = (small(dir, '.sdkmanrc') ?? '')
        .split('\n')
        .find((entry) => /^\s*java\s*=/.test(entry))
      return found('.sdkmanrc', line?.split('=')[1])
    },
    (dir): Found | undefined =>
      found('.tool-versions', fromToolVersions(dir, 'java')),
  ],
  python: [
    (dir): Found | undefined =>
      found('.python-version', firstLine(small(dir, '.python-version'))),
    (dir): Found | undefined =>
      found('.tool-versions', fromToolVersions(dir, 'python')),
    (dir): Found | undefined => {
      const text = small(dir, 'pyproject.toml')
      return text == null
        ? undefined
        : found(
            'pyproject.toml',
            tomlValue(text, 'project', 'requires-python') ?? '',
          )
    },
  ],
  ruby: [
    (dir): Found | undefined =>
      found('.ruby-version', firstLine(small(dir, '.ruby-version'))),
    (dir): Found | undefined =>
      found('.tool-versions', fromToolVersions(dir, 'ruby')),
    (dir): Found | undefined =>
      found(
        'Gemfile',
        /^\s*ruby\s*\(?\s*["']([^"']+)["']/m.exec(
          small(dir, 'Gemfile') ?? '',
        )?.[1],
      ),
  ],
  go: [
    (dir): Found | undefined => {
      const text = small(dir, 'go.mod') ?? ''
      return found(
        'go.mod',
        /^toolchain\s+go(\S+)/m.exec(text)?.[1] ??
          /^go\s+(\S+)/m.exec(text)?.[1],
      )
    },
    (dir): Found | undefined =>
      found('.tool-versions', fromToolVersions(dir, 'go')),
  ],
  xcode: [
    (dir): Found | undefined =>
      found('.xcode-version', firstLine(small(dir, '.xcode-version'))),
    (dir): Found | undefined =>
      found('.tool-versions', fromToolVersions(dir, 'xcode')),
  ],
}

/** The first file at the checkout's root that pins `tool`, as written. */
export function readProjectVersion(
  dir: string,
  tool: ProjectTool,
): Found | undefined {
  for (const read of readers[tool]) {
    const result = read(dir)
    if (result != null) return result
  }
  return undefined
}

/** The first version number in a range or a decorated name: `>=3.11`, `temurin-21.0.5+11`, `ruby-3.3.5`. */
const firstVersion = (text: string, parts: number): string | undefined =>
  new RegExp(`\\d+(?:\\.\\d+){0,${parts - 1}}`).exec(text)?.[0]

const ranged = (text: string): boolean => /[<>=^~*|, ]/.test(text)

/**
 * The version Mason installs for a pin file's value. Exact pins stay exact;
 * a range gives the first version it names (`>=3.11` → `3.11`), reduced to
 * the precision the tool's installer matches on.
 */
export function projectVersion(
  tool: ProjectTool,
  pin: Found,
  releases?: NodeRelease[],
): ProjectVersion {
  const { file } = pin
  const value = pin.text.trim()
  const fail = (problem: string): ProjectVersion => ({ file, problem })
  const named = (version: string | undefined): ProjectVersion =>
    version == null
      ? fail(`${JSON.stringify(value)} names no ${tool} version`)
      : { file, version }
  switch (tool) {
    case 'node': {
      const plain = value.replace(/^v(?=\d)/, '')
      const lts = /^lts\/(.+)$/i.exec(plain)?.[1]?.toLowerCase()
      if (lts != null || plain.toLowerCase() === 'lts') {
        const newest = (releases ?? [])
          .filter(
            (release) =>
              typeof release.lts === 'string' &&
              (lts == null || lts === '*' || release.lts.toLowerCase() === lts),
          )
          .map((release) => release.version.replace(/^v/, ''))
          .sort(compareVersions)
          .pop()
        return newest == null
          ? fail(`no Node.js LTS release matches ${plain}`)
          : { file, version: newest.split('.')[0]! }
      }
      if (file === 'package.json') return named(firstVersion(plain, 1))
      const exact = plain.replace(/(\.x)+$/i, '')
      return /^\d+(\.\d+){0,2}$/.test(exact)
        ? { file, version: exact }
        : fail(`${JSON.stringify(value)} is not a Node.js version`)
    }
    case 'rust':
      return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
        ? { file, version: value }
        : fail(`${JSON.stringify(value)} is not a Rust toolchain`)
    case 'java':
      // `21`, `21.0.5`, `21.0.5-tem`, `temurin-21.0.5+11`: Mason installs Temurin.
      return named(firstVersion(value, 3))
    case 'python':
      if (/^(pypy|graalpy|miniconda|anaconda|jython)/i.test(value))
        return fail(`${JSON.stringify(value)} is not CPython`)
      return named(firstVersion(value, ranged(value) ? 2 : 3))
    case 'ruby':
      if (/^(jruby|truffleruby|mruby)/i.test(value))
        return fail(`${JSON.stringify(value)} is not CRuby`)
      return named(firstVersion(value, ranged(value) ? 2 : 3))
    case 'go':
      return named(firstVersion(value, 3))
    case 'xcode':
      return /^[\w.<>= -]{1,40}$/.test(value)
        ? { file, version: value }
        : fail(`${JSON.stringify(value.slice(0, 40))} is not an Xcode version`)
  }
}

/** Whether a Node.js pin is an LTS alias, which needs the release index. */
export const isLtsAlias = (text: string): boolean => /^lts(\/|$)/i.test(text)

/** The tools a setup's graph sets to `'project'` in any stage. */
export function wantedProjectTools(graph: unknown): ProjectTool[] {
  const wanted = new Set<ProjectTool>()
  const workflows =
    (graph as { workflows?: Array<{ stages?: Array<{ tools?: unknown }> }> })
      ?.workflows ?? []
  for (const workflow of workflows)
    for (const stage of workflow.stages ?? []) {
      const tools = (stage.tools ?? {}) as Record<string, unknown>
      for (const tool of projectTools)
        if (tools[tool] === 'project') wanted.add(tool)
    }
  return [...wanted]
}

/**
 * Each wanted tool's pinned version. `nodeReleases` is fetched only for a
 * Node.js LTS alias.
 */
export async function readProjectTools(
  dir: string,
  wanted: ProjectTool[],
  nodeReleases: () => Promise<NodeRelease[]>,
): Promise<Partial<Record<ProjectTool, ProjectVersion>>> {
  const out: Partial<Record<ProjectTool, ProjectVersion>> = {}
  for (const tool of wanted) {
    const pin = readProjectVersion(dir, tool)
    if (pin == null) continue
    let releases: NodeRelease[] | undefined
    if (tool === 'node' && isLtsAlias(pin.text))
      try {
        releases = await nodeReleases()
      } catch (error) {
        out[tool] = {
          file: pin.file,
          problem: `the Node.js release index failed: ${(error as Error).message}`,
        }
        continue
      }
    out[tool] = projectVersion(tool, pin, releases)
  }
  return out
}

/** Where `'project'` looks for each tool, for the setup failure. */
export const projectFiles: Record<ProjectTool, string> = {
  node: '.nvmrc, .node-version, .tool-versions or package.json engines.node',
  rust: 'rust-toolchain.toml, rust-toolchain or .tool-versions',
  java: '.java-version, .sdkmanrc or .tool-versions',
  python: '.python-version, .tool-versions or pyproject.toml requires-python',
  ruby: '.ruby-version, .tool-versions or Gemfile ruby',
  go: 'go.mod or .tool-versions',
  xcode: '.xcode-version or .tool-versions',
}
