import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { formatCheck, type ClusterReport } from '../master/clusterCheck.js'
import { spawn } from 'node:child_process'
import { helperPaths, serveHelper, systemContext } from '../helper/server.js'
import {
  runningInstall,
  serviceProgram,
  type RunningInstall,
} from '../release/install.js'
import { hostname } from 'node:os'
import path from 'node:path'
import { pinnedFetch } from './pinnedFetch.js'
import { parseArgs, parseRoleCommand, single } from './args.js'
import { controlRequest } from './control.js'
import { resolveDataDir } from './dataDir.js'
import {
  nodeStatus,
  startNode,
  type NodeStatus,
  type Role,
  type RunningNode,
} from './serve.js'
import type { NodeRecord } from '../master/nodes.js'
import type { MasterKey } from '../master/keys.js'
import { importDeployment } from '../master/import.js'
import { importHost } from '../host/import.js'
import type { ClientPasswordCosts } from '../auth/passwordProtocol.js'
import { readStdin, setupCommand, withStoppedMaster } from '../setup/cli.js'
import { prepareDataDir, writePrivate } from './dataDir.js'
import { PAIRING_FILE, readPairingFile } from './identity.js'
import {
  hostSystem,
  installService,
  uninstallService,
  type ServiceSystem,
  installHelperService,
  uninstallHelperService,
} from './service.js'

export interface MainIO {
  out(line: string): void
  /** Standard input, read whole (for --password-stdin). */
  stdin?(): Promise<string>
  /** Client password costs for `mason setup`; calibrated when absent. */
  passwordCosts?: ClientPasswordCosts
  err(line: string): void
  /** The operating system for `--install` and `--uninstall`. */
  system(): ServiceSystem
  /** Resolves when the process is asked to stop. */
  stopped(): Promise<void>
  /** How an installed service starts Mason. */
  program(): string[]
  /** Called once a node is serving, for tests. */
  started?(node: RunningNode): void
  /** How this Mason was installed; the running process's install by default. */
  install?: () => RunningInstall
  /** Asks a question on the terminal; `hidden` does not echo the answer. */
  prompt?(question: string, hidden: boolean): Promise<string>
}

/** Reads one line from the terminal, without echo for a password. */
export async function terminalPrompt(
  question: string,
  hidden: boolean,
): Promise<string> {
  const { createInterface } = await import('node:readline')
  const { openSync, createReadStream, createWriteStream } = await import(
    'node:fs'
  )
  const input = createReadStream('', { fd: openSync('/dev/tty', 'r') })
  const output = createWriteStream('', { fd: openSync('/dev/tty', 'w') })
  const rl = createInterface({ input, output, terminal: true })
  if (hidden)
    (
      rl as unknown as { _writeToOutput: (text: string) => void }
    )._writeToOutput = (text: string): void => {
      if (text.startsWith(question)) output.write(question)
    }
  try {
    return await new Promise((resolve) => {
      rl.question(question, (answer) => {
        if (hidden) output.write('\n')
        resolve(answer.trim())
      })
    })
  } finally {
    rl.close()
    input.destroy()
    output.end()
  }
}

export const processIO: MainIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  system: () => hostSystem(),
  stopped: () =>
    new Promise((resolve) => {
      const stop = (): void => {
        process.off('SIGTERM', stop)
        process.off('SIGINT', stop)
        resolve()
      }
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
    }),
  program: () =>
    serviceProgram(
      runningInstall(),
      process.execPath,
      realpathSync(process.argv[1]!),
    ),
}

const roles: readonly Role[] = ['master', 'worker', 'host']

const usage = `Usage:
  mason [master] [--worker] [options]   run the master (and a worker)
  mason worker [options]                 run a worker
  mason host [options]                   run the host
  mason status [--data <dir>] [--json]   show a node's state
  mason cluster check [--json] [--data <dir>]   every node linked, versions, inventory, host cache lag, outbox, quarantines
  mason nodes add --address <address> --key <pairing key> [--data <dir>]
  mason nodes list [--json] [--data <dir>]
  mason nodes remove <fingerprint> [--data <dir>]
  mason nodes set <name|fingerprint> [--name <n>] [--type <t>] [--label <l>]… [--slots <n>] [--workspace-root <dir>]…
  mason runs list [--project <slug>] [--workflow <w>] [--branch <b>] [--status <s>] [--json]
  mason runs cleanup                       apply retention now (the master does it hourly)
  mason recover                            clear a worker's guardian quarantine after checking it
  mason releases list | add <dir> | fetch <tag> | current [<version>]
  mason update [--version <x.y.z>]         install a newer release and restart the services
  mason apple sign-in [--apple-id <id>] [--password-stdin] | status | sign-out
  mason setup --username <name> --password-stdin [--api-key-out <file>]
  mason setup --restore --repository <url> --key-file <file> [--branch <b>] [--date YYYY-MM-DD]
  mason backup                             back up now (the master does it hourly once configured)
  mason people list | add --file <json> | set <id> --file <json> | remove <id>
  mason groups list | add --file <json> | set <id> --file <json> | remove <id>
  mason api <GET|POST|PUT|DELETE> <path> [--file <json>] [--key-file <file>] [--url <origin>] [--pin <pin>]
  mason import --distribution <db> --builder <db> [--data <dir>]
  mason host import --distribution <db> [--storage <dir>] [--data <dir>]
  mason host trust-root --file <pem> [--data <dir>]   a test Profile Service root (--test-endpoints only)
  mason keys create --role <role> [--name <n>] [--project <slug>]… [--branch <glob>]… [--app <id>]… --out <file>
  mason keys list | mason keys revoke <id>
  mason settings get <area> | mason settings set <area> --file <json>
  mason projects list | get <slug> | set <slug> --file <json> | remove <slug>
Options: --data <dir> --port <n> --link-port <n> --listen <address> --link-listen <address>
  --web-cert <file> --web-key <file> --web-plain --new-key --test-endpoints --slots <n>
  --install [--user <name>] --uninstall`

/**
 * The origin to reach a node on this computer: one listening on every
 * interface reports the computer's host name, which DNS may not resolve, so
 * loopback is used instead.
 */
export function localOrigin(web: string, host = hostname()): string {
  const url = new URL(web)
  if (url.hostname === host) url.hostname = '127.0.0.1'
  return url.origin
}

/** Waits for a node service to come up and answer on its control socket. */
async function waitForControl(
  data: string,
  command: string,
  attempts = 60,
  delayMs = 500,
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await controlRequest(data, command)
    } catch (error) {
      if (attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

function printStatus(status: NodeStatus, io: MainIO): void {
  const lines: Array<[string, string | undefined]> = [
    ['Role', status.roles.join(' + ')],
    [
      'State',
      status.state + (status.pid == null ? '' : ` (PID ${status.pid})`),
    ],
    ['Version', status.version],
    ['Data', status.data],
    ['Fingerprint', status.fingerprint],
    ['Web', status.web],
    ['Link', status.link],
    ['Certificate SHA-256', status.certificateHash],
    ['Pin', status.pin],
    ['Pairing', status.pairing],
    ['Setup', status.setup],
    ['Test endpoints', status.testEndpoints ? 'enabled' : undefined],
  ]
  for (const [label, value] of lines)
    if (value != null) io.out(`${label}: ${value}`)
  for (const notice of status.notices ?? []) io.out(`Notice: ${notice}`)
}

async function roleCommand(
  role: Role,
  argv: string[],
  io: MainIO,
): Promise<number> {
  const command = parseRoleCommand(role, argv)
  const helped = role === 'worker' || command.options.coWorker === true
  const system = (): ServiceSystem => io.system()
  if (command.uninstall) {
    const removed = uninstallService(
      { role, ...(command.user == null ? {} : { user: command.user }) },
      system(),
    )
    io.out(
      `Removed ${removed.label} (${removed.file}); the data directory is kept.`,
    )
    if (helped) {
      const helper = uninstallHelperService(
        system(),
        helperPaths(system().platform).keyFile,
      )
      io.out(`Removed ${helper.label} (${helper.file}) and its master key.`)
    }
    return 0
  }
  // As root, --new-key also makes the helper forget the master's key.
  if (
    command.options.newKey === true &&
    helped &&
    process.geteuid?.() === 0 &&
    system().euid === 0
  ) {
    rmSync(helperPaths(system().platform).keyFile, { force: true })
    io.out(
      'The helper forgot the master key; the worker pairs again with a new key.',
    )
    if (!command.install) return 0
  }
  if (command.install) {
    const installed = installService(
      {
        role,
        ...(command.options.coWorker ? { coWorker: true } : {}),
        ...(command.dataFlag == null ? {} : { data: command.dataFlag }),
        ...(command.user == null ? {} : { user: command.user }),
        ...(command.pairingFile == null
          ? {}
          : {
              pairingFile: JSON.stringify(
                readPairingFile(readFileSync(command.pairingFile, 'utf8')),
              ),
            }),
        program: io.program(),
        args: command.serviceArgs,
      },
      io.system(),
    )
    if (command.pairingFile != null) {
      rmSync(command.pairingFile, { force: true })
      io.out(
        'Moved the pairing file into the data directory; the master pairs with this machine itself.',
      )
    }
    io.out(
      `Installed ${installed.label} for ${installed.user} (${installed.file}); data in ${installed.data}.`,
    )
    if (helped) {
      const helper = installHelperService(
        {
          ...(command.user == null ? {} : { user: command.user }),
          program: io.program(),
        },
        system(),
      )
      io.out(`Installed ${helper.label} (${helper.file}).`)
    }
    if (command.pairingFile != null) return 0
    if (role === 'master') {
      const code = path.join(installed.data, 'setup-code')
      await waitForControl(installed.data, 'status')
      if (existsSync(code))
        io.out(`Setup code: ${readFileSync(code, 'utf8').trim()}`)
    } else
      io.out(
        `Pairing key: ${String(await waitForControl(installed.data, 'pairing'))}`,
      )
    return 0
  }
  if (command.pairingFile != null) {
    // In the foreground the pairing material goes into this user's data directory.
    const dir = prepareDataDir(command.options.data)
    writePrivate(
      path.join(dir, PAIRING_FILE),
      JSON.stringify(
        readPairingFile(readFileSync(command.pairingFile, 'utf8')),
      ),
    )
    rmSync(command.pairingFile, { force: true })
  }
  const node = await startNode(command.options, io.out)
  io.started?.(node)
  await io.stopped()
  await node.close()
  return 0
}

/** `mason import`: a stopped master's database from the current deployment. */
async function importCommand(argv: string[], io: MainIO): Promise<number> {
  const args = parseArgs(argv, ['--data', '--distribution', '--builder'], [])
  const distribution = single(args, '--distribution')
  const builder = single(args, '--builder')
  if (distribution == null || builder == null || args.positional.length !== 0)
    throw new Error(
      'Usage: mason import --distribution <db> --builder <db> [--data <dir>]',
    )
  for (const file of [distribution, builder])
    if (!existsSync(file)) throw new Error(`No database at ${file}`)
  const summary = await withStoppedMaster(
    resolveDataDir(single(args, '--data')),
    (master) => importDeployment(master, { distribution, builder }),
  )
  io.out(JSON.stringify(summary, null, 2))
  return 0
}

/** `mason keys …`: API keys, through the master's control socket. */
async function keysCommand(argv: string[], io: MainIO): Promise<number> {
  const [action, ...rest] = argv
  const args = parseArgs(
    rest,
    ['--data', '--role', '--name', '--project', '--branch', '--app', '--out'],
    ['--json'],
  )
  const data = resolveDataDir(single(args, '--data'))
  if (action === 'create') {
    const out = single(args, '--out')
    const role = single(args, '--role')
    if (out == null || role == null || args.positional.length !== 0)
      throw new Error('Usage: mason keys create --role <role> --out <file>')
    if (existsSync(out)) throw new Error(`${out} already exists`)
    const name = single(args, '--name')
    const key = (await controlRequest(data, 'keys.create', {
      role,
      ...(name == null ? {} : { name }),
      projects: args.values.get('--project') ?? [],
      branches: args.values.get('--branch') ?? [],
      apps: (args.values.get('--app') ?? []).map(Number),
    })) as MasterKey & { token: string }
    writePrivate(out, key.token + '\n')
    io.out(
      `Created ${key.role} key ${key.id} (${key.name}); the token is in ${out}`,
    )
    return 0
  }
  if (action === 'list') {
    const keys = (await controlRequest(data, 'keys.list')) as MasterKey[]
    if (args.flags.has('--json')) io.out(JSON.stringify(keys))
    else
      for (const key of keys)
        io.out(
          `${key.id}  ${key.role}  ${key.name}${key.revoked ? '  revoked' : ''}`,
        )
    return 0
  }
  if (action === 'revoke' && args.positional.length === 1) {
    await controlRequest(data, 'keys.revoke', { id: args.positional[0] })
    io.out(`Revoked ${args.positional[0]}`)
    return 0
  }
  throw new Error(usage)
}

/** `mason settings get|set <area>`, through the master's control socket. */
async function settingsCommand(argv: string[], io: MainIO): Promise<number> {
  const [action, area, ...rest] = argv
  const args = parseArgs(rest, ['--data', '--file'], [])
  const data = resolveDataDir(single(args, '--data'))
  if (area == null || args.positional.length !== 0) throw new Error(usage)
  if (action === 'get') {
    io.out(
      JSON.stringify(
        await controlRequest(data, 'settings.get', { area }),
        null,
        2,
      ),
    )
    return 0
  }
  const file = single(args, '--file')
  if (action === 'set' && file != null) {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
    io.out(
      JSON.stringify(
        await controlRequest(data, 'settings.set', { area, value }),
        null,
        2,
      ),
    )
    return 0
  }
  throw new Error(usage)
}

/** `mason people …` and `mason groups …`, through the master's control socket. */
async function peopleCommand(
  kind: 'people' | 'groups',
  argv: string[],
  io: MainIO,
): Promise<number> {
  const [action, ...rest] = argv
  const args = parseArgs(rest, ['--data', '--file'], ['--json'])
  const data = resolveDataDir(single(args, '--data'))
  const file = single(args, '--file')
  const value =
    file == null
      ? undefined
      : (JSON.parse(readFileSync(file, 'utf8')) as unknown)
  const print = (result: unknown): number => {
    io.out(JSON.stringify(result, null, 2))
    return 0
  }
  if (action === 'list' && args.positional.length === 0)
    return print(await controlRequest(data, `${kind}.list`))
  if (action === 'add' && value != null && args.positional.length === 0)
    return print(await controlRequest(data, `${kind}.add`, { value }))
  if (action === 'set' && value != null && args.positional.length === 1)
    return print(
      await controlRequest(data, `${kind}.set`, {
        id: Number(args.positional[0]),
        value,
      }),
    )
  if (action === 'remove' && args.positional.length === 1) {
    await controlRequest(data, `${kind}.remove`, {
      id: Number(args.positional[0]),
    })
    io.out(`Removed ${args.positional[0]}`)
    return 0
  }
  throw new Error(
    `Usage: mason ${kind} list | add --file <json> | set <id> --file <json> | remove <id>`,
  )
}

/**
 * `mason api <method> <path>`: one request to a master's API with an API key
 * (`--key-file`, or `MASON_API_KEY`), at the local master's web address and
 * pin unless `--url` and `--pin` name another. Prints the response body and
 * exits 1 on an error status.
 */
async function apiCommand(argv: string[], io: MainIO): Promise<number> {
  const args = parseArgs(
    argv,
    ['--data', '--file', '--key-file', '--url', '--pin'],
    [],
  )
  const [method, target] = args.positional
  if (
    method == null ||
    target == null ||
    args.positional.length !== 2 ||
    !['GET', 'POST', 'PUT', 'DELETE'].includes(method.toUpperCase()) ||
    !target.startsWith('/api/')
  )
    throw new Error(
      'Usage: mason api <GET|POST|PUT|DELETE> <path> [--file <json>] [--key-file <file>] [--url <origin>] [--pin <pin>]',
    )
  const keyFile = single(args, '--key-file')
  const token =
    keyFile == null
      ? process.env.MASON_API_KEY
      : readFileSync(keyFile, 'utf8').trim()
  if (token == null || token === '')
    throw new Error('Give an API key with --key-file or MASON_API_KEY')
  let url = single(args, '--url')
  let pin = single(args, '--pin')
  if (url == null) {
    const status = (await controlRequest(
      resolveDataDir(single(args, '--data')),
      'status',
    )) as { web?: string; pin?: string }
    if (status.web == null) throw new Error('This node has no web listener')
    url = localOrigin(status.web)
    pin ??= status.pin
  }
  const file = single(args, '--file')
  const response = await pinnedFetch(
    new URL(target, url).href,
    {
      method: method.toUpperCase(),
      headers: {
        authorization: `Bearer ${token}`,
        ...(file == null ? {} : { 'content-type': 'application/json' }),
      },
      ...(file == null ? {} : { body: readFileSync(file, 'utf8') }),
    },
    pin,
  )
  const text = await response.text()
  io.out(text === '' ? `HTTP ${response.status}` : text)
  return response.ok ? 0 : 1
}

/** `mason projects …`, through the master's control socket. */
async function projectsCommand(argv: string[], io: MainIO): Promise<number> {
  const [action, ...rest] = argv
  const args = parseArgs(rest, ['--data', '--file'], ['--json'])
  const data = resolveDataDir(single(args, '--data'))
  const [slug] = args.positional
  if (action === 'list' && slug == null) {
    const projects = (await controlRequest(data, 'projects.list')) as Array<{
      slug: string
      format: string
      repository: string
      apps: unknown[]
    }>
    if (args.flags.has('--json')) io.out(JSON.stringify(projects))
    else
      for (const project of projects)
        io.out(
          `${project.slug}  ${project.format}  ${project.repository}  ${project.apps.length} apps`,
        )
    return 0
  }
  if (action === 'get' && slug != null) {
    io.out(
      JSON.stringify(
        await controlRequest(data, 'projects.get', { slug }),
        null,
        2,
      ),
    )
    return 0
  }
  const file = single(args, '--file')
  if (action === 'set' && slug != null && file != null) {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
    io.out(
      JSON.stringify(
        await controlRequest(data, 'projects.set', { slug, value }),
        null,
        2,
      ),
    )
    return 0
  }
  if (action === 'remove' && slug != null) {
    await controlRequest(data, 'projects.remove', { slug })
    io.out(`Removed ${slug}`)
    return 0
  }
  throw new Error(usage)
}

/** `mason nodes …`: the master's nodes, through its control socket. */
/** `mason helper --user <name>`: the privileged helper, run as root by its service. */
async function helperCommand(argv: string[], io: MainIO): Promise<number> {
  const args = parseArgs(argv, ['--user'], [])
  const name = single(args, '--user')
  const system = io.system()
  if (system.euid !== 0)
    throw new Error('The helper runs as root, from its service')
  const user = name == null ? undefined : system.user(name)
  if (user == null) throw new Error('Usage: mason helper --user <name>')
  const server = await serveHelper(
    helperPaths(system.platform).socket,
    systemContext(system.platform, { name: name!, ...user }),
  )
  io.out(`Mason helper serving ${name!}`)
  await io.stopped()
  server.close()
  return 0
}

/**
 * `mason apple sign-in`: stores the Apple ID and password on the master and
 * signs in, then reads Apple's two-factor code from the terminal.
 */
async function appleCommand(argv: string[], io: MainIO): Promise<number> {
  const [action, ...rest] = argv
  const args = parseArgs(
    rest,
    ['--data', '--apple-id'],
    ['--password-stdin', '--json'],
  )
  const data = resolveDataDir(single(args, '--data'))
  const prompt = io.prompt ?? terminalPrompt
  const show = (status: {
    appleId?: string
    state: string
    notice?: string
    codeVia?: string
  }): void => {
    if (args.flags.has('--json')) {
      io.out(JSON.stringify(status))
      return
    }
    io.out(`Apple ID: ${status.appleId ?? '(none)'}`)
    io.out(`State: ${status.state}`)
    if (status.notice != null) io.out(`Notice: ${status.notice}`)
  }
  if (action === 'status') {
    show((await controlRequest(data, 'apple.status')) as never)
    return 0
  }
  if (action === 'sign-out') {
    await controlRequest(data, 'apple.signOut')
    io.out('Signed out; the stored password and session are deleted.')
    return 0
  }
  if (action !== 'sign-in') throw new Error(usage)
  const current = (await controlRequest(data, 'apple.status')) as {
    appleId?: string
  }
  const appleId =
    single(args, '--apple-id') ??
    current.appleId ??
    (await prompt('Apple ID: ', false))
  const password = args.flags.has('--password-stdin')
    ? (await (io.stdin ?? readStdin)()).replace(/\r?\n$/, '')
    : await prompt(`Password for ${appleId}: `, true)
  let status = (await controlRequest(data, 'apple.signIn', {
    appleId,
    password,
  })) as {
    state: string
    codeVia?: string
    error?: string
    appleId?: string
    notice?: string
  }
  for (
    let attempt = 0;
    status.state === 'needsCode' && attempt < 3;
    attempt++
  ) {
    const code = await prompt(
      `Two-factor code (sent to ${status.codeVia ?? 'a trusted device'}): `,
      false,
    )
    try {
      status = (await controlRequest(data, 'apple.code', {
        code,
      })) as typeof status
    } catch (error) {
      io.err((error as Error).message)
    }
  }
  show(status)
  return status.state === 'signedIn' ? 0 : 1
}

/** `mason releases list | add <dir> | fetch <tag> | current [<version>]`. */
async function releasesCommand(argv: string[], io: MainIO): Promise<number> {
  const [action, ...rest] = argv
  const args = parseArgs(rest, ['--data'], ['--json'])
  const data = resolveDataDir(single(args, '--data'))
  if (action === 'list') {
    const releases = (await controlRequest(data, 'releases.list')) as Array<{
      version: string
      platforms: string[]
      current: boolean
    }>
    if (args.flags.has('--json')) io.out(JSON.stringify(releases))
    else if (releases.length === 0) io.out('No releases are stored.')
    else
      for (const release of releases)
        io.out(
          `${release.current ? '* ' : '  '}${release.version}  ${release.platforms.join(' ')}`,
        )
    return 0
  }
  if (action === 'add' && args.positional.length === 1) {
    const version = await controlRequest(data, 'releases.add', {
      dir: path.resolve(args.positional[0]!),
    })
    io.out(`Stored release ${String(version)}`)
    return 0
  }
  if (action === 'fetch' && args.positional.length === 1) {
    const version = await controlRequest(data, 'releases.fetch', {
      tag: args.positional[0],
    })
    io.out(`Stored release ${String(version)}`)
    return 0
  }
  if (action === 'current' && args.positional.length <= 1) {
    const out = (await controlRequest(data, 'releases.current', {
      ...(args.positional.length === 1 ? { version: args.positional[0] } : {}),
    })) as { current: string | null }
    io.out(
      out.current == null
        ? 'No current release.'
        : `Current release: ${out.current}`,
    )
    return 0
  }
  throw new Error(usage)
}

/**
 * `mason update [--version <x.y.z>]`: installs a newer release the way
 * install.sh does and restarts this user's Mason services. The data
 * directories stay as they are.
 */
async function updateCommand(argv: string[], io: MainIO): Promise<number> {
  const args = parseArgs(argv, ['--version'], [])
  const install = io.install?.() ?? runningInstall()
  if (install.kind === 'checkout')
    throw new Error(
      'This Mason runs from a source checkout; update it with git',
    )
  const script = path.join(install.appRoot, 'release', 'install.sh')
  if (!existsSync(script))
    throw new Error(
      'This install has no copy of install.sh; run install.sh again',
    )
  const version = single(args, '--version')
  const status = await new Promise<number>((resolve) => {
    const child = spawn(
      'bash',
      [
        script,
        ...(install.kind === 'user' ? ['--user'] : []),
        ...(version == null ? [] : ['--version', version]),
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, MASON_PREFIX: install.prefix! },
      },
    )
    child.on('close', (code) => {
      resolve(code ?? 1)
    })
  })
  if (status !== 0) return status
  const system = io.system()
  const uid = Number(process.env.SUDO_UID ?? process.getuid?.() ?? 0)
  for (const role of ['master', 'worker', 'host'])
    if (system.platform === 'darwin')
      system.run(
        'launchctl',
        ['kickstart', '-k', `gui/${uid}/app.mason.${role}`],
        true,
      )
    else system.run('systemctl', ['try-restart', `mason-${role}`], true)
  io.out(
    'Restarted the Mason services of this account into the new release; their data directories are unchanged.',
  )
  return 0
}

async function runsCommand(argv: string[], io: MainIO): Promise<number> {
  const [action, ...rest] = argv
  const args = parseArgs(
    rest,
    ['--data', '--project', '--workflow', '--branch', '--status', '--limit'],
    ['--json'],
  )
  const data = resolveDataDir(single(args, '--data'))
  if (action === 'cleanup') {
    const out = (await controlRequest(data, 'runs.cleanup')) as {
      runs: number
      stashes: number
      graphs: number
    }
    io.out(
      `Removed ${out.runs} run(s), the stashes of ${out.stashes} run(s) and ${out.graphs} unused graph(s).`,
    )
    return 0
  }
  if (action === 'list') {
    const filter: Record<string, string> = {}
    for (const name of ['project', 'workflow', 'branch', 'status', 'limit']) {
      const value = single(args, `--${name}`)
      if (value != null) filter[name] = value
    }
    const runs = (await controlRequest(data, 'runs.list', filter)) as Array<{
      id: string
      project: string
      workflow: string
      number: number
      branch: string
      status: string
    }>
    if (args.flags.has('--json')) io.out(JSON.stringify(runs))
    else
      for (const run of runs)
        io.out(
          `${run.id}  ${run.project} ${run.workflow} #${run.number}  ${run.branch}  ${run.status}`,
        )
    return 0
  }
  throw new Error(usage)
}

async function nodesCommand(argv: string[], io: MainIO): Promise<number> {
  const [action, ...rest] = argv
  const args = parseArgs(
    rest,
    [
      '--data',
      '--address',
      '--key',
      '--name',
      '--type',
      '--label',
      '--slots',
      '--workspace-root',
    ],
    ['--json'],
  )
  const data = resolveDataDir(single(args, '--data'))
  if (action === 'add') {
    const address = single(args, '--address')
    const key = single(args, '--key')
    if (address == null || key == null || args.positional.length !== 0)
      throw new Error(
        'Usage: mason nodes add --address <address> --key <pairing key>',
      )
    const node = (await controlRequest(data, 'nodes.add', {
      address,
      key,
    })) as NodeRecord
    io.out(
      `Paired ${node.role} ${node.name} (${node.fingerprint}) at ${node.host}:${node.port}`,
    )
    return 0
  }
  if (action === 'list') {
    const nodes = (await controlRequest(data, 'nodes.list')) as NodeRecord[]
    if (args.flags.has('--json')) io.out(JSON.stringify(nodes))
    else if (nodes.length === 0) io.out('No nodes are paired.')
    else
      for (const node of nodes)
        io.out(
          `${node.fingerprint}  ${node.role}  ${node.name}  ${node.host}:${node.port}  ${node.connected ? 'linked' : 'not linked'}`,
        )
    return 0
  }
  if (action === 'set' && args.positional.length === 1) {
    const value: Record<string, unknown> = {}
    const name = single(args, '--name')
    if (name != null) value.name = name
    const type = single(args, '--type')
    if (type != null) value.type = type
    if (args.values.has('--label')) value.labels = args.values.get('--label')
    const slots = single(args, '--slots')
    if (slots != null) value.slots = Number(slots)
    if (args.values.has('--workspace-root'))
      value.workspaceRoots = args.values.get('--workspace-root')
    const node = (await controlRequest(data, 'nodes.set', {
      node: args.positional[0],
      value,
    })) as NodeRecord
    io.out(
      args.flags.has('--json')
        ? JSON.stringify(node)
        : `${node.name}: type ${node.type || '(none)'}, labels ${node.labels.join(',') || '(none)'}, ${node.slots} slot(s)`,
    )
    return 0
  }
  if (action === 'remove' && args.positional.length === 1) {
    await controlRequest(data, 'nodes.remove', {
      fingerprint: args.positional[0],
    })
    io.out(`Removed ${args.positional[0]}`)
    return 0
  }
  throw new Error(usage)
}

/** Runs a node command: `mason`, `mason worker`, `mason status`, … */
export async function nodeMain(
  argv: string[],
  io: MainIO = processIO,
): Promise<number> {
  try {
    const [first, ...rest] = argv
    if (first === 'help' || first === '--help') {
      io.out(usage)
      return 0
    }
    if (first == null || first.startsWith('--'))
      return await roleCommand('master', argv, io)
    if (first === 'host' && rest[0] === 'trust-root') {
      const args = parseArgs(rest.slice(1), ['--data', '--file'], [])
      const file = single(args, '--file')
      if (file == null || args.positional.length !== 0)
        throw new Error(
          'Usage: mason host trust-root --file <pem> [--data <dir>]',
        )
      await controlRequest(
        resolveDataDir(single(args, '--data')),
        'devices.trustRoot',
        {
          pem: readFileSync(file, 'utf8'),
        },
      )
      io.out('The host now also trusts that Profile Service root')
      return 0
    }
    if (first === 'host' && rest[0] === 'import') {
      const args = parseArgs(
        rest.slice(1),
        ['--data', '--distribution', '--storage'],
        [],
      )
      const distribution = single(args, '--distribution')
      if (distribution == null || args.positional.length !== 0)
        throw new Error(
          'Usage: mason host import --distribution <db> [--storage <dir>] [--data <dir>]',
        )
      if (!existsSync(distribution))
        throw new Error(`No database at ${distribution}`)
      const storage = single(args, '--storage')
      const summary = importHost(resolveDataDir(single(args, '--data')), {
        distribution,
        ...(storage == null ? {} : { storage }),
      })
      io.out(JSON.stringify(summary, null, 2))
      return 0
    }
    if ((roles as readonly string[]).includes(first))
      return await roleCommand(first as Role, rest, io)
    if (first === 'nodes') return await nodesCommand(rest, io)
    if (first === 'cluster' && rest[0] === 'check') {
      const args = parseArgs(rest.slice(1), ['--data'], ['--json'])
      const report = (await controlRequest(
        resolveDataDir(single(args, '--data')),
        'cluster.check',
      )) as ClusterReport
      io.out(
        args.flags.has('--json')
          ? JSON.stringify(report, null, 2)
          : formatCheck(report),
      )
      return report.green ? 0 : 1
    }
    if (first === 'setup')
      return await setupCommand(rest, {
        out: io.out,
        stdin: io.stdin ?? readStdin,
        ...(io.passwordCosts == null ? {} : { costs: io.passwordCosts }),
      })
    if (first === 'import') return await importCommand(rest, io)
    if (first === 'people' || first === 'groups')
      return await peopleCommand(first, rest, io)
    if (first === 'api') return await apiCommand(rest, io)
    if (first === 'backup') {
      const args = parseArgs(rest, ['--data'], [])
      if (args.positional.length !== 0) throw new Error('Usage: mason backup')
      const status = (await controlRequest(
        resolveDataDir(single(args, '--data')),
        'backup',
      )) as {
        backedUp: boolean
        lastSuccess?: { commit: string }
        lastFailure?: { error: string }
      }
      if (status.backedUp) {
        io.out(`Backed up: ${status.lastSuccess!.commit}`)
        return 0
      }
      io.out(
        `The backup failed: ${status.lastFailure?.error ?? 'unknown error'}`,
      )
      return 1
    }
    if (first === 'keys') return await keysCommand(rest, io)
    if (first === 'settings') return await settingsCommand(rest, io)
    if (first === 'projects') return await projectsCommand(rest, io)
    if (first === 'runs') return await runsCommand(rest, io)
    if (first === 'helper') return await helperCommand(rest, io)
    if (first === 'releases') return await releasesCommand(rest, io)
    if (first === 'update') return await updateCommand(rest, io)
    if (first === 'apple') return await appleCommand(rest, io)
    if (first === 'recover') {
      const args = parseArgs(rest, ['--data'], [])
      await controlRequest(resolveDataDir(single(args, '--data')), 'recover')
      io.out('Quarantine cleared; the worker takes stages again.')
      return 0
    }
    if (first === 'status') {
      const args = parseArgs(rest, ['--data'], ['--json'])
      if (args.positional.length !== 0) throw new Error(usage)
      const data = resolveDataDir(single(args, '--data'))
      if (!existsSync(data))
        throw new Error(`No Mason data directory at ${data}`)
      const status = await nodeStatus(data, (command) =>
        controlRequest(data, command),
      )
      if (args.flags.has('--json')) io.out(JSON.stringify(status))
      else printStatus(status, io)
      return 0
    }
    throw new Error(usage)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}
