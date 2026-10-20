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
import {
  hostSystem,
  installService,
  uninstallService,
  type ServiceSystem,
} from './service.js'

export interface MainIO {
  out(line: string): void
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
Options: --data <dir> --port <n> --link-port <n> --listen <address>
  --web-cert <file> --web-key <file> --web-plain --new-key --test-endpoints
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

/** `mason nodes …`: the master's nodes, through its control socket. */
async function nodesCommand(argv: string[], io: MainIO): Promise<number> {
  const [action, ...rest] = argv
  const args = parseArgs(rest, ['--data', '--address', '--key'], ['--json'])
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
