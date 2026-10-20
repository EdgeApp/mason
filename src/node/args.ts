import { resolveDataDir } from './dataDir.js'
import type { NodeOptions, Role } from './serve.js'

export interface ParsedArgs {
  /** Positional words after the command. */
  positional: string[]
  /** `--name value` options; repeated options keep every value. */
  values: Map<string, string[]>
  /** `--flag` switches. */
  flags: Set<string>
}

/**
 * Parses `--name value` options and `--flag` switches. `valued` lists the
 * options that take a value; anything else starting with `--` must be in
 * `switches`.
 */
export function parseArgs(
  argv: string[],
  valued: readonly string[],
  switches: readonly string[],
): ParsedArgs {
  const out: ParsedArgs = {
    positional: [],
    values: new Map(),
    flags: new Set(),
  }
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!
    if (!word.startsWith('--')) {
      out.positional.push(word)
      continue
    }
    if (valued.includes(word)) {
      const value = argv[++i]
      if (value == null || value.startsWith('--'))
        throw new Error(`${word} needs a value`)
      out.values.set(word, [...(out.values.get(word) ?? []), value])
    } else if (switches.includes(word)) out.flags.add(word)
    else throw new Error(`Unknown option ${word}`)
  }
  return out
}

/** The single value of an option, or undefined. */
export function single(args: ParsedArgs, name: string): string | undefined {
  const values = args.values.get(name)
  if (values == null) return undefined
  if (values.length !== 1) throw new Error(`${name} may be given once`)
  return values[0]
}

export function port(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value == null) return undefined
  const out = Number(value)
  if (!Number.isInteger(out) || out < 0 || out > 65535 || !/^\d+$/.test(value))
    throw new Error(`${name} must be a port number`)
  return out
}

const roleValued = [
  '--data',
  '--port',
  '--link-port',
  '--listen',
  '--web-cert',
  '--web-key',
  '--user',
] as const
const roleSwitches = [
  '--web-plain',
  '--new-key',
  '--test-endpoints',
  '--install',
  '--uninstall',
  '--worker',
] as const

export interface RoleCommand {
  options: NodeOptions
  install: boolean
  uninstall: boolean
  user?: string
  /** `--data` as given; an installed service resolves the default for its user. */
  dataFlag?: string
  /** Options to pass on to an installed service. */
  serviceArgs: string[]
}

/** Parses `mason [master|worker|host] [options]`. */
export function parseRoleCommand(role: Role, argv: string[]): RoleCommand {
  const args = parseArgs(argv, roleValued, roleSwitches)
  if (args.positional.length !== 0)
    throw new Error(`Unexpected argument ${args.positional[0]}`)
  if (args.flags.has('--worker') && role !== 'master')
    throw new Error('--worker is only for a master')
  if (args.flags.has('--install') && args.flags.has('--uninstall'))
    throw new Error('Choose --install or --uninstall')
  if (args.values.has('--user') && !args.flags.has('--install'))
    throw new Error('--user is only for --install')
  const options: NodeOptions = {
    role,
    data: resolveDataDir(single(args, '--data')),
  }
  if (args.flags.has('--worker')) options.coWorker = true
  const portValue = port(single(args, '--port'), '--port')
  if (portValue != null) options.port = portValue
  const linkPort = port(single(args, '--link-port'), '--link-port')
  if (linkPort != null) options.linkPort = linkPort
  for (const [flag, key] of [
    ['--listen', 'listen'],
    ['--web-cert', 'webCert'],
    ['--web-key', 'webKey'],
  ] as const) {
    const value = single(args, flag)
    if (value != null) options[key] = value
  }
  if (args.flags.has('--web-plain')) options.webPlain = true
  if (args.flags.has('--new-key')) options.newKey = true
  if (args.flags.has('--test-endpoints')) options.testEndpoints = true
  const serviceArgs: string[] = []
  for (const name of [
    '--port',
    '--link-port',
    '--listen',
    '--web-cert',
    '--web-key',
  ])
    for (const value of args.values.get(name) ?? [])
      serviceArgs.push(name, value)
  for (const name of ['--web-plain', '--test-endpoints', '--worker'])
    if (args.flags.has(name)) serviceArgs.push(name)
  const user = single(args, '--user')
  const dataFlag = single(args, '--data')
  return {
    options,
    ...(dataFlag == null ? {} : { dataFlag }),
    install: args.flags.has('--install'),
    uninstall: args.flags.has('--uninstall'),
    ...(user == null ? {} : { user }),
    serviceArgs,
  }
}
