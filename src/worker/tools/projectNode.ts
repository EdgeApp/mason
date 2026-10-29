import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { compareVersions } from './versions.js'

/** The Node.js version a repository asks for, for stages with `tools.node: 'project'`. */
export interface ProjectNode {
  /** The file it came from: `.nvmrc`, `.node-version` or `package.json`. */
  file: string
  /** A major (`22`) or an exact version (`22.11.0`), when the file names one Mason can install. */
  version?: string
  /** Why the file's value was not used. */
  problem?: string
}

/** A Node.js release in `index.json`: `lts` is the codename, or false. */
export interface NodeRelease {
  version: string
  lts?: string | false
}

function small(file: string): string | undefined {
  return existsSync(file) &&
    lstatSync(file).isFile() &&
    lstatSync(file).size < 64 * 1024
    ? readFileSync(file, 'utf8')
    : undefined
}

/** The first of `.nvmrc`, `.node-version` and `package.json` `engines.node` at the checkout's root, as written. */
export function readProjectNode(
  dir: string,
): { file: string; text: string } | undefined {
  for (const file of ['.nvmrc', '.node-version']) {
    const text = small(path.join(dir, file))?.split('\n')[0]?.trim()
    if (text != null && text !== '') return { file, text }
  }
  try {
    const engines = (
      JSON.parse(small(path.join(dir, 'package.json')) ?? '{}') as {
        engines?: { node?: unknown }
      }
    ).engines?.node
    if (typeof engines === 'string' && engines.trim() !== '')
      return { file: 'package.json', text: engines.trim() }
  } catch {}
  return undefined
}

const major = (version: string): string => version.split('.')[0]!

/**
 * The version Mason installs for a version file's value. `.nvmrc` and
 * `.node-version` give a version (`v22.11.0`, `22`, `22.x`) or an LTS alias
 * (`lts/*`, `lts/jod`), which `releases` resolves to its newest major;
 * `engines.node` gives the major of the first version in its range
 * (`>=20`, `^20.5` → `20`).
 */
export function projectNodeVersion(
  file: string,
  text: string,
  releases?: NodeRelease[],
): ProjectNode {
  const value = text.trim().replace(/^v(?=\d)/, '')
  const lts = /^lts\/(.+)$/i.exec(value)?.[1]?.toLowerCase()
  if (lts != null || value.toLowerCase() === 'lts') {
    const matching = (releases ?? [])
      .filter(
        (release) =>
          typeof release.lts === 'string' &&
          (lts == null || lts === '*' || release.lts.toLowerCase() === lts),
      )
      .map((release) => release.version.replace(/^v/, ''))
      .sort(compareVersions)
    const newest = matching.pop()
    return newest == null
      ? { file, problem: `no Node.js LTS release matches ${value}` }
      : { file, version: major(newest) }
  }
  if (file !== 'package.json') {
    const version = value.replace(/(\.x)+$/i, '')
    if (/^\d+(\.\d+){0,2}$/.test(version)) return { file, version }
    return {
      file,
      problem: `${JSON.stringify(value)} is not a Node.js version`,
    }
  }
  const first = /\d+/.exec(value)?.[0]
  return first == null
    ? { file, problem: `${JSON.stringify(value)} names no Node.js version` }
    : { file, version: first }
}

/** Whether a version file's value is an LTS alias, which needs the release index. */
export const isLtsAlias = (text: string): boolean => /^lts(\/|$)/i.test(text)
