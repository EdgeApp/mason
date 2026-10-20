import { asArray, asBoolean, asOptional, asString } from 'cleaners'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { integer, object, text, asPlatform } from '../validation.js'
import { readPrivateJson } from '../config.js'

export function relativePath(value: unknown): string {
  const out = text(240)(value)
  if (
    out
      .split('/')
      .some(
        (p) =>
          !/^[a-zA-Z0-9_.-]+$/.test(p) ||
          p === '..' ||
          p === '.' ||
          p.toLowerCase() === '.git',
      )
  )
    throw new Error('Unsafe relative path')
  return out
}
export function branchName(value: unknown): string {
  const out = text(200)(value)
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(out) ||
    out.includes('..') ||
    out.includes('//') ||
    out.endsWith('/') ||
    out
      .split('/')
      .some((p) => p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'))
  )
    throw new Error('Invalid branch')
  return out
}
export function repository(value: unknown): string {
  const out = text(512)(value)
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(
      out,
    )
  if (
    !match ||
    match[1] === '.' ||
    match[1] === '..' ||
    match[2] === '.' ||
    match[2] === '..'
  )
    throw new Error('Expected a GitHub repository without credentials')
  const prefix = out.startsWith('git@')
    ? 'git@github.com:'
    : 'https://github.com/'
  return `${prefix}${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}.git`
}
export function envName(value: unknown): string {
  const out = text(100)(value)
  if (
    !/^[A-Z_][A-Z0-9_]*$/.test(out) ||
    out.startsWith('MASON_') ||
    [
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
    ].includes(out)
  )
    throw new Error('Reserved or invalid environment name')
  return out
}
function envValue(value: unknown): string {
  const out = asString(value)
  if (out.length > 65536 || out.includes('\0'))
    throw new Error('Invalid environment value')
  return out
}
function base64(value: unknown): string {
  const out = asString(value)
  if (
    out.length > 524288 ||
    Buffer.from(out, 'base64').toString('base64') !== out
  )
    throw new Error('Invalid file encoding')
  return out
}
const definition = object({
  slug: text(160),
  name: text(120),
  position: asOptional(integer(), 0),
  enabled: asOptional(asBoolean, true),
  repository,
  workspace: asOptional(relativePath, 'git-worktrees'),
  entrypoint: asOptional(relativePath),
  timeoutSeconds: asOptional(integer(1, 86400), 14400),
  platforms: asArray(asPlatform),
  env: asOptional(
    asArray(
      object({
        name: envName,
        value: envValue,
        secret: asOptional(asBoolean, true),
      }),
    ),
    [],
  ),
  files: asOptional(
    asArray(
      object({
        destination: relativePath,
        contents: base64,
        env: asOptional(envName),
      }),
    ),
    [],
  ),
})
export function asDefinition(value: unknown): ReturnType<typeof definition> {
  const out = definition(value)
  if (
    ['git', 'files', 'logs', 'executions'].includes(
      out.workspace.split('/')[0]!,
    )
  )
    throw new Error('Reserved workspace directory')
  if (
    out.platforms.length === 0 ||
    out.platforms.length > 4 ||
    new Set(out.platforms).size !== out.platforms.length ||
    out.env.length > 100 ||
    out.files.length > 20
  )
    throw new Error('Invalid configuration size')
  const names = [
    ...out.env.map((e) => e.name),
    ...out.files.flatMap((f) => (f.env == null ? [] : [f.env])),
  ]
  if (
    new Set(names).size !== names.length ||
    new Set(out.files.map((f) => f.destination)).size !== out.files.length
  )
    throw new Error('Duplicate configuration')
  if (
    out.files.some((f) =>
      ['Masonfile.ts', 'Masonfile.js', out.entrypoint].includes(f.destination),
    )
  )
    throw new Error('Cannot inject the entrypoint')
  if (JSON.stringify(out).length > 900000)
    throw new Error('App definition too large')
  return out
}
export type Definition = ReturnType<typeof asDefinition>
export const asBuilderConfig = object({
  workspace: text(4096),
  listenHost: asOptional(text(256), '127.0.0.1'),
  port: asOptional(integer(1, 65535), 9300),
})
export type BuilderConfig = ReturnType<typeof asBuilderConfig>
export function loadBuilderConfig(file: string): BuilderConfig {
  file = realpathSync(file)
  const config = asBuilderConfig(readPrivateJson(file))
  return {
    ...config,
    workspace: path.resolve(path.dirname(file), config.workspace),
  }
}
function asEnvVars(value: unknown): Array<Record<string, string>> {
  const entries = asArray((map: unknown) => {
    if (map == null || typeof map !== 'object' || Array.isArray(map))
      throw new Error('Expected an environment variable object')
    const entries = Object.entries(map)
    if (entries.length !== 1)
      throw new Error('Expected one environment variable per object')
    const [name, raw] = entries[0]!
    const value = envValue(raw)
    if (value.length > 4096) throw new Error('Environment override too long')
    return [envName(name), value] as const
  })(value)
  if (entries.length > 100) throw new Error('Too many environment overrides')
  if (new Set(entries.map(([name]) => name)).size !== entries.length)
    throw new Error('Duplicate environment override')
  const out = entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => ({ [name]: value }))
  if (Buffer.byteLength(JSON.stringify(out)) > 8192)
    throw new Error('Environment overrides too large')
  return out
}
export const asRequest = object({
  app: text(160),
  branch: asOptional(branchName),
  platforms: asOptional(asArray(asPlatform)),
  idempotencyKey: asOptional(text(100)),
  envVars: (value: unknown) => (value === undefined ? [] : asEnvVars(value)),
})
export type JobRequest = ReturnType<typeof asRequest>
export function commitHash(value: unknown): string {
  const out = asString(value)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(out))
    throw new Error('Invalid commit')
  return out
}
const buildSettings = object({
  defaultBranch: branchName,
  automaticBranches: asArray(branchName),
})
export function asBuildSettings(
  value: unknown,
): ReturnType<typeof buildSettings> {
  const out = buildSettings(value)
  if (
    out.automaticBranches.length > 20 ||
    new Set(out.automaticBranches).size !== out.automaticBranches.length
  )
    throw new Error('Invalid automatic branches')
  return out
}
export function baseEnvironment(
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return {
    // A launchd or systemd service starts with no locale, and tools such as
    // CocoaPods then refuse non-ASCII text.
    LANG: platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
    ...Object.fromEntries(
      [
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'TMPDIR',
        'LANG',
        'SSH_AUTH_SOCK',
        'DEVELOPER_DIR',
      ].flatMap((name) =>
        process.env[name] == null ? [] : [[name, process.env[name]!]],
      ),
    ),
  }
}
