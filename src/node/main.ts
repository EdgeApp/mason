import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
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
import type { ClientPasswordCosts } from '../auth/passwordProtocol.js'
import { readStdin, setupCommand, withStoppedMaster } from '../setup/cli.js'
import { writePrivate } from './dataDir.js'
import {
  hostSystem,
  installService,
  uninstallService,
  type ServiceSystem,
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
  program: () => [process.execPath, realpathSync(process.argv[1]!)],
}

const roles: readonly Role[] = ['master', 'worker', 'host']

const usage = `Usage:
  mason [master] [--worker] [options]   run the master (and a worker)
  mason worker [options]                 run a worker
  mason host [options]                   run the host
  mason status [--data <dir>] [--json]   show a node's state
  mason nodes add --address <address> --key <pairing key> [--data <dir>]
  mason nodes list [--json] [--data <dir>]
  mason nodes remove <fingerprint> [--data <dir>]
  mason nodes set <name|fingerprint> [--name <n>] [--type <t>] [--label <l>]… [--slots <n>] [--workspace-root <dir>]…
  mason runs list [--project <slug>] [--workflow <w>] [--branch <b>] [--status <s>] [--json]
  mason runs cleanup                       apply retention now (the master does it hourly)
  mason recover                            clear a worker's guardian quarantine after checking it
  mason setup --username <name> --password-stdin [--api-key-out <file>]
  mason import --distribution <db> --builder <db> [--data <dir>]
  mason keys create --role <role> [--name <n>] [--project <slug>]… [--branch <glob>]… [--app <id>]… --out <file>
  mason keys list | mason keys revoke <id>
  mason settings get <area> | mason settings set <area> --file <json>
  mason projects list | get <slug> | set <slug> --file <json> | remove <slug>
  mason build-numbers seed --project <slug> --key <key> --from <buildNum.json>
Options: --data <dir> --port <n> --link-port <n> --listen <address>
  --web-cert <file> --web-key <file> --web-plain --new-key --test-endpoints --slots <n>
  --install [--user <name>] --uninstall`

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
}

async function roleCommand(
  role: Role,
  argv: string[],
  io: MainIO,
): Promise<number> {
  const command = parseRoleCommand(role, argv)
  if (command.uninstall) {
    const removed = uninstallService(
      { role, ...(command.user == null ? {} : { user: command.user }) },
      io.system(),
    )
    io.out(
      `Removed ${removed.label} (${removed.file}); the data directory is kept.`,
    )
    return 0
  }
  if (command.install) {
    const installed = installService(
      {
        role,
        ...(command.options.coWorker ? { coWorker: true } : {}),
        ...(command.dataFlag == null ? {} : { data: command.dataFlag }),
        ...(command.user == null ? {} : { user: command.user }),
        program: io.program(),
        args: command.serviceArgs,
      },
      io.system(),
    )
    io.out(
      `Installed ${installed.label} for ${installed.user} (${installed.file}); data in ${installed.data}.`,
    )
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

/** `mason build-numbers seed`: reads a copy of buildNum.json and never writes it. */
async function buildNumbersCommand(
  argv: string[],
  io: MainIO,
): Promise<number> {
  const [action, ...rest] = argv
  const args = parseArgs(rest, ['--data', '--project', '--key', '--from'], [])
  const project = single(args, '--project')
  const key = single(args, '--key')
  const from = single(args, '--from')
  if (action !== 'seed' || project == null || key == null || from == null)
    throw new Error(
      'Usage: mason build-numbers seed --project <slug> --key <key> --from <buildNum.json>',
    )
  const entries = JSON.parse(readFileSync(from, 'utf8')) as unknown
  const result = (await controlRequest(
    resolveDataDir(single(args, '--data')),
    'buildNumbers.seed',
    { project, key, entries },
  )) as { branches: number }
  io.out(`Seeded ${result.branches} branches of ${project} ${key}`)
  return 0
}

/** `mason nodes …`: the master's nodes, through its control socket. */
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
    if ((roles as readonly string[]).includes(first))
      return await roleCommand(first as Role, rest, io)
    if (first === 'nodes') return await nodesCommand(rest, io)
    if (first === 'setup')
      return await setupCommand(rest, {
        out: io.out,
        stdin: io.stdin ?? readStdin,
        ...(io.passwordCosts == null ? {} : { costs: io.passwordCosts }),
      })
    if (first === 'import') return await importCommand(rest, io)
    if (first === 'keys') return await keysCommand(rest, io)
    if (first === 'settings') return await settingsCommand(rest, io)
    if (first === 'projects') return await projectsCommand(rest, io)
    if (first === 'build-numbers') return await buildNumbersCommand(rest, io)
    if (first === 'runs') return await runsCommand(rest, io)
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
