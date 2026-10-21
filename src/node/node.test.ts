import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { Agent, fetch } from 'undici'
import { builderCommand } from '../builder/cli.js'
import { isLegacyCommand, run } from '../cli.js'
import { parseArgs, parseRoleCommand, port, single } from './args.js'
import { createCertificate, publicKeyPin } from './certificate.js'
import { controlRequest } from './control.js'
import { parsePairingKey } from './identity.js'
import { nodeMain, processIO, type MainIO } from './main.js'
import { asPin, pinnedAgent, pinnedFetch } from './pinnedFetch.js'
import {
  databaseFiles,
  defaultPorts,
  masterConfigured,
  nodeStatus,
  reachableAddresses,
  startNode,
  statusFromFiles,
  type RunningNode,
} from './serve.js'
import {
  hostSystem,
  installService,
  uninstallService,
  type ServiceSystem,
} from './service.js'
import { isLoopback, webCertificate } from './web.js'

let root: string
const cli = new URL('../cli.js', import.meta.url).pathname
const insecure = new Agent({ connect: { rejectUnauthorized: false } })

/** A MainIO that records output and stops when told to. */
function testIO(extra: Partial<MainIO> = {}): MainIO & {
  lines: string[]
  errors: string[]
  stop: () => void
  node: Promise<RunningNode>
} {
  let stop!: () => void
  const stopping = new Promise<void>((resolve) => {
    stop = resolve
  })
  let started!: (node: RunningNode) => void
  const node = new Promise<RunningNode>((resolve) => {
    started = resolve
  })
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    stop,
    node,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    system: (): ServiceSystem => {
      throw new Error('No system in tests')
    },
    stopped: () => stopping,
    program: () => ['/usr/bin/node', '/opt/mason/lib/cli.js'],
    started,
    ...extra,
  }
}

/** A fake operating system recording what service installation does. */
function fakeSystem(
  options: Partial<ServiceSystem> & {
    users?: Record<string, { uid: number; gid: number; home: string }>
  } = {},
): ServiceSystem & {
  files: Map<string, { content: string; uid: number; mode: number }>
  commands: string[]
  created: string[]
  dirs: string[]
} {
  const files = new Map<
    string,
    { content: string; uid: number; mode: number }
  >()
  const commands: string[] = []
  const created: string[] = []
  const dirs: string[] = []
  const users = { ...(options.users ?? {}) }
  return {
    platform: 'darwin',
    euid: 0,
    env: {},
    user: (name) => users[name],
    createSystemUser(name, home, groups): void {
      created.push(`${name} ${home} ${groups.join(',')}`)
      users[name] = { uid: 998, gid: 998, home }
    },
    groupExists: () => false,
    writeFile: (file, content, owner, mode) =>
      files.set(file, { content, uid: owner.uid, mode }),
    removeFile: (file): void => {
      files.delete(file)
    },
    makeDirectory: (dir, owner, mode) =>
      dirs.push(`${dir} ${owner.uid} ${mode.toString(8)}`),
    run: (command, args) => commands.push([command, ...args].join(' ')),
    files,
    commands,
    created,
    dirs,
    ...options,
  }
}

async function get(
  url: string,
  pin?: string,
): Promise<{ status: number; body: string }> {
  const response =
    pin == null
      ? await fetch(url, { dispatcher: insecure })
      : await pinnedFetch(url, {}, pin)
  return { status: response.status, body: await response.text() }
}

describe('Configuration-free nodes', function () {
  this.timeout(30000)
  beforeEach(() => {
    process.umask(0o077)
    root = mkdtempSync(path.join(process.env.MASON_TEST_ROOT!, 'node-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('parses role commands, their options and service arguments', () => {
    const parsed = parseRoleCommand('master', [
      '--worker',
      '--data',
      'd',
      '--port',
      '9501',
      '--listen',
      '127.0.0.1',
      '--web-plain',
      '--test-endpoints',
      '--new-key',
    ])
    assert.equal(parsed.options.data, path.resolve('d'))
    assert.equal(parsed.dataFlag, 'd')
    assert.equal(parsed.options.coWorker, true)
    assert.equal(parsed.options.port, 9501)
    assert.equal(parsed.options.webPlain, true)
    assert.equal(parsed.options.newKey, true)
    assert.deepEqual(parsed.serviceArgs, [
      '--port',
      '9501',
      '--listen',
      '127.0.0.1',
      '--web-plain',
      '--test-endpoints',
      '--worker',
    ])
    const worker = parseRoleCommand('worker', [
      '--link-port',
      '9511',
      '--web-cert',
      'c',
      '--web-key',
      'k',
      '--install',
      '--user',
      'paul',
    ])
    assert.equal(worker.options.linkPort, 9511)
    assert.equal(worker.options.webCert, 'c')
    assert.equal(worker.install, true)
    assert.equal(worker.user, 'paul')
    assert.equal(parseRoleCommand('host', []).dataFlag, undefined)
    for (const [role, argv, message] of [
      ['worker', ['--worker'], /only for a master/],
      ['master', ['--install', '--uninstall'], /Choose/],
      ['master', ['--user', 'paul'], /only for --install/],
      ['master', ['extra'], /Unexpected argument/],
      ['master', ['--port', 'x'], /port number/],
      ['master', ['--port', '70000'], /port number/],
      ['master', ['--port'], /needs a value/],
      ['master', ['--port', '--data'], /needs a value/],
      ['master', ['--bogus'], /Unknown option/],
      ['master', ['--data', 'a', '--data', 'b'], /once/],
    ] as const)
      assert.throws(() => parseRoleCommand(role, [...argv]), message)
    const args = parseArgs(
      ['a', '--x', '1', '--x', '2', '--y'],
      ['--x'],
      ['--y'],
    )
    assert.deepEqual(args.positional, ['a'])
    assert.deepEqual(args.values.get('--x'), ['1', '2'])
    assert(args.flags.has('--y'))
    assert.equal(single(args, '--z'), undefined)
    assert.equal(port(undefined, '--p'), undefined)
  })

  it('starts a master that prints its setup code, serves HTTPS with its own certificate and stops cleanly', async () => {
    const io = testIO()
    const done = nodeMain(
      ['--data', path.join(root, 'm'), '--port', '0', '--listen', '127.0.0.1'],
      io,
    )
    const node = await io.node
    assert.deepEqual(databaseFiles('master'), ['master.sqlite'])
    const code = readFileSync(path.join(node.dir, 'setup-code'), 'utf8').trim()
    assert.equal(
      statSync(path.join(node.dir, 'setup-code')).mode & 0o777,
      0o600,
    )
    assert(
      io.lines.some(
        (line) =>
          line ===
          `Setup code: ${code}  (enter it on the setup page, or run mason setup)`,
      ),
    )
    assert(io.lines.includes(`Fingerprint: ${node.identity.fingerprint}`))
    assert(io.lines.some((line) => line.includes(`pin: ${node.identity.pin}`)))
    assert(existsSync(path.join(node.dir, 'master.sqlite')))
    const url = node.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:')
    assert.match(node.web!.url, /^https:/)
    const health = await get(url + '/health', node.identity.pin)
    assert.equal(health.status, 200)
    assert.deepEqual(JSON.parse(health.body), {
      status: 'ready',
      role: 'master',
    })
    const home = await get(url + '/', node.identity.pin)
    assert.match(home.body, /Set up this master/)
    assert.equal((await get(url + '/missing', node.identity.pin)).status, 404)
    assert.equal(
      (await get(url + '/assets/style.css', node.identity.pin)).status,
      200,
    )
    const status = (await controlRequest(node.dir, 'status')) as Record<
      string,
      unknown
    >
    assert.equal(status.state, 'running')
    assert.equal(status.setup, 'waiting')
    assert.equal(status.pin, node.identity.pin)
    // Configuring the master (an account, from M4) changes what it reports.
    const db = node.databases.get('master.sqlite')!
    assert.equal(masterConfigured(db), false)
    db.exec(
      "INSERT INTO accounts(name,username,password,role,created_at) VALUES('x','x','{}','admin',1)",
    )
    assert.equal(masterConfigured(db), true)
    assert.match(
      (await get(url + '/', node.identity.pin)).body,
      /This master is set up/,
    )
    io.stop()
    assert.equal(await done, 0)
    assert(!existsSync(path.join(node.dir, 'lock.pid')))
    // Restarting a configured master prints no setup code and removes the file.
    const second = testIO()
    const again = nodeMain(
      ['--data', node.dir, '--port', '0', '--listen', '127.0.0.1'],
      second,
    )
    await second.node
    assert(!second.lines.some((line) => line.startsWith('Setup code')))
    assert(!existsSync(path.join(node.dir, 'setup-code')))
    second.stop()
    assert.equal(await again, 0)
    assert.equal(statusFromFiles(node.dir).setup, 'configured')
  })

  it('starts workers and hosts that print the same pairing key until they are paired', async () => {
    const data = path.join(root, 'w')
    const keys: string[] = []
    for (let i = 0; i < 2; i++) {
      const io = testIO()
      const done = nodeMain(
        ['worker', '--data', data, '--link-port', '0', '--listen', '127.0.0.1'],
        io,
      )
      const node = await io.node
      const key = io.lines
        .find((line) => line.startsWith('Pairing key: '))!
        .slice(13)
      keys.push(key)
      assert.equal(parsePairingKey(key).fingerprint, node.identity.fingerprint)
      assert.equal(
        parsePairingKey(key).certificateHash,
        node.identity.certificateHash,
      )
      assert.equal(await controlRequest(node.dir, 'pairing'), key)
      assert(io.lines.includes(`Link: 127.0.0.1:${node.link!.port}`))
      assert.equal(node.web, undefined)
      // The link listener speaks TLS 1.3 with the hybrid group only.
      const response = await fetch(`https://127.0.0.1:${node.link!.port}/`, {
        dispatcher: insecure,
      })
      assert.equal(response.status, 426)
      const status = (await controlRequest(node.dir, 'status')) as Record<
        string,
        unknown
      >
      assert.equal(status.pairing, 'waiting')
      assert.equal(status.role, 'worker')
      io.stop()
      assert.equal(await done, 0)
    }
    assert.equal(keys[0], keys[1])
    const renewed = testIO()
    const done = nodeMain(
      [
        'worker',
        '--data',
        data,
        '--link-port',
        '0',
        '--listen',
        '127.0.0.1',
        '--new-key',
      ],
      renewed,
    )
    await renewed.node
    assert.notEqual(
      renewed.lines.find((line) => line.startsWith('Pairing key: ')),
      `Pairing key: ${keys[0]}`,
    )
    renewed.stop()
    await done

    const hostIO = testIO()
    const hostDone = nodeMain(
      [
        'host',
        '--data',
        path.join(root, 'h'),
        '--port',
        '0',
        '--link-port',
        '0',
        '--listen',
        '127.0.0.1',
        '--test-endpoints',
      ],
      hostIO,
    )
    const host = await hostIO.node
    assert.deepEqual(databaseFiles('host'), ['host-cache.sqlite'])
    assert(hostIO.lines.some((line) => line.startsWith('Pairing key: ')))
    assert(hostIO.lines.includes('Test endpoints are enabled.'))
    const page = await get(
      host.web!.url.replace(/\/\/[^:]+:/, '//127.0.0.1:') + '/',
      host.identity.pin,
    )
    assert.equal(page.status, 503)
    assert.match(page.body, /Test endpoints are enabled/)
    assert.match(page.body, /waiting for its master/)
    hostIO.stop()
    assert.equal(await hostDone, 0)
  })

  it('runs a master with a worker in one process and keeps a data directory to one role', async () => {
    assert.deepEqual(databaseFiles('master', true), [
      'master.sqlite',
      'worker.sqlite',
    ])
    assert.deepEqual(databaseFiles('worker'), ['worker.sqlite'])
    const io = testIO()
    const data = path.join(root, 'mw')
    const done = nodeMain(
      [
        'master',
        '--worker',
        '--data',
        data,
        '--port',
        '0',
        '--listen',
        '127.0.0.1',
      ],
      io,
    )
    const node = await io.node
    assert(existsSync(path.join(data, 'worker.sqlite')))
    assert.equal(node.link, undefined)
    assert.equal(
      io.lines[0],
      'Mason 0.1.0 master with a worker'.replace(
        '0.1.0',
        node.status().version,
      ),
    )
    assert.deepEqual(node.status().roles, ['master', 'worker'])
    io.stop()
    await done
    const wrong = testIO()
    assert.equal(
      await nodeMain(['worker', '--data', data, '--link-port', '0'], wrong),
      1,
    )
    assert.match(
      wrong.errors[0]!,
      /belongs to a master; use another --data for a worker/,
    )
    await assert.rejects(
      startNode({ role: 'worker', coWorker: true, data: path.join(root, 'x') }),
      /only for a master/,
    )
  })

  it('refuses a second process on a data directory and frees it after a failed start', async () => {
    const io = testIO()
    const data = path.join(root, 'busy')
    const done = nodeMain(
      ['worker', '--data', data, '--link-port', '0', '--listen', '127.0.0.1'],
      io,
    )
    const node = await io.node
    const second = testIO()
    assert.equal(
      await nodeMain(['host', '--data', data, '--link-port', '0'], second),
      1,
    )
    assert.match(second.errors[0]!, new RegExp(`PID ${process.pid}`))
    // A listener that cannot bind releases the lock it took.
    const port = node.link!.port
    io.stop()
    await done
    const blocker = testIO()
    const blocked = nodeMain(
      [
        'worker',
        '--data',
        path.join(root, 'other'),
        '--link-port',
        String(port),
        '--listen',
        '127.0.0.1',
      ],
      blocker,
    )
    await blocker.node
    const clash = testIO()
    assert.equal(
      await nodeMain(
        [
          'worker',
          '--data',
          data,
          '--link-port',
          String(port),
          '--listen',
          '127.0.0.1',
        ],
        clash,
      ),
      1,
    )
    assert.match(clash.errors[0]!, /EADDRINUSE/)
    blocker.stop()
    await blocked
    const after = testIO()
    const ok = nodeMain(
      ['worker', '--data', data, '--link-port', '0', '--listen', '127.0.0.1'],
      after,
    )
    await after.node
    after.stop()
    assert.equal(await ok, 0)
  })

  it('reports status from a running node, from a stopped one, and without secrets', async () => {
    const data = path.join(root, 'w')
    const io = testIO()
    const done = nodeMain(
      ['worker', '--data', data, '--link-port', '0', '--listen', '127.0.0.1'],
      io,
    )
    const node = await io.node
    const key = io.lines.find((line) => line.startsWith('Pairing key: '))!
    const running = testIO()
    assert.equal(await nodeMain(['status', '--data', data], running), 0)
    assert(running.lines.includes('Role: worker'))
    assert(running.lines.includes(`State: running (PID ${process.pid})`))
    assert(running.lines.includes(`Fingerprint: ${node.identity.fingerprint}`))
    assert(running.lines.includes('Pairing: waiting'))
    assert(
      !running.lines.join('\n').includes(parsePairingKey(key.slice(13)).secret),
    )
    const json = testIO()
    assert.equal(await nodeMain(['status', '--data', data, '--json'], json), 0)
    assert.equal(JSON.parse(json.lines[0]!).state, 'running')
    // While the control socket is gone the lock still shows the node running.
    await node.control.close()
    const viaLock = await nodeStatus(data, (command) =>
      controlRequest(data, command),
    )
    assert.equal(viaLock.state, 'running')
    assert.equal(viaLock.pid, process.pid)
    io.stop()
    await done
    const stopped = testIO()
    assert.equal(await nodeMain(['status', '--data', data], stopped), 0)
    assert(stopped.lines.includes('State: stopped'))
    assert(stopped.lines.includes(`Pin: ${node.identity.pin}`))
    writeFileSync(path.join(data, 'master.json'), '{}', { mode: 0o600 })
    assert.equal(statusFromFiles(data).pairing, 'paired')
    const missing = testIO()
    assert.equal(
      await nodeMain(['status', '--data', path.join(root, 'none')], missing),
      1,
    )
    assert.match(missing.errors[0]!, /No Mason data directory/)
    assert.equal(await nodeMain(['status', 'extra'], testIO()), 1)
    const fresh = path.join(root, 'fresh')
    mkdirSync(fresh, { mode: 0o700 })
    assert.deepEqual(
      {
        role: statusFromFiles(fresh).role,
        setup: statusFromFiles(fresh).setup,
        fingerprint: statusFromFiles(fresh).fingerprint,
      },
      { role: 'master', setup: 'waiting', fingerprint: undefined },
    )
    const help = testIO()
    assert.equal(await nodeMain(['help'], help), 0)
    assert.match(help.lines[0]!, /^Usage:/)
    const unknown = testIO()
    assert.equal(await nodeMain(['frobnicate'], unknown), 1)
    assert.match(unknown.errors[0]!, /^Usage:/)
  })

  it('serves the web listener with --web-cert, or plain HTTP only on loopback', async () => {
    const certificate = createCertificate(['127.0.0.1'])
    writeFileSync(path.join(root, 'web.crt'), certificate.cert)
    writeFileSync(path.join(root, 'web.key'), certificate.key)
    const io = testIO()
    const done = nodeMain(
      [
        'host',
        '--data',
        path.join(root, 'h'),
        '--port',
        '0',
        '--link-port',
        '0',
        '--listen',
        '127.0.0.1',
        '--web-cert',
        path.join(root, 'web.crt'),
        '--web-key',
        path.join(root, 'web.key'),
      ],
      io,
    )
    const node = await io.node
    const pin = publicKeyPin(certificate.cert)
    assert.equal(node.web!.certificate!.pin, pin)
    assert.notEqual(pin, node.identity.pin)
    assert.equal((await get(node.web!.url + '/health', pin)).status, 200)
    io.stop()
    await done
    const plain = testIO()
    const plainDone = nodeMain(
      [
        '--data',
        path.join(root, 'p'),
        '--port',
        '0',
        '--listen',
        '127.0.0.1',
        '--web-plain',
      ],
      plain,
    )
    const plainNode = await plain.node
    assert.match(plainNode.web!.url, /^http:\/\/127\.0\.0\.1:/)
    assert.equal(plainNode.web!.certificate, undefined)
    assert.equal((await fetch(plainNode.web!.url + '/health')).status, 200)
    plain.stop()
    await plainDone
    const refused = testIO()
    assert.equal(
      await nodeMain(
        ['--data', path.join(root, 'q'), '--port', '0', '--web-plain'],
        refused,
      ),
      1,
    )
    assert.match(refused.errors[0]!, /loopback --listen/)
    const identity = plainNode.identity
    assert.throws(
      () =>
        webCertificate(identity, {
          port: 0,
          listen: '10.0.0.1',
          webPlain: true,
        }),
      /loopback/,
    )
    assert.throws(
      () =>
        webCertificate(identity, {
          port: 0,
          listen: '127.0.0.1',
          webPlain: true,
          webCert: 'x',
        }),
      /cannot be combined/,
    )
    assert.throws(
      () => webCertificate(identity, { port: 0, webCert: 'x' }),
      /go together/,
    )
    assert(
      isLoopback('localhost') && isLoopback('::1') && isLoopback('127.0.0.2'),
    )
    assert(!isLoopback('10.0.0.1') && !isLoopback('::'))
    const v6 = testIO()
    const v6Done = nodeMain(
      ['--data', path.join(root, 'v6'), '--port', '0', '--listen', '::1'],
      v6,
    )
    const v6Node = await v6.node
    assert.match(v6Node.web!.url, /^https:\/\/\[::1\]:/)
    v6.stop()
    await v6Done
  })

  it('lists reachable addresses without link-local IPv6 ones', () => {
    assert.deepEqual(reachableAddresses(9311, '10.0.0.5'), ['10.0.0.5:9311'])
    assert.deepEqual(reachableAddresses(9311, '::1'), ['[::1]:9311'])
    const all = reachableAddresses(9310)
    assert(all.length >= 1)
    assert(
      all.every((entry) => entry.endsWith(':9310') && !/^\[fe80:/i.test(entry)),
    )
    assert.deepEqual(defaultPorts, { master: 9300, host: 9200, link: 9310 })
  })

  it('installs a per-user LaunchAgent on macOS for the sudo user', () => {
    const system = fakeSystem({
      env: { SUDO_USER: 'paul' },
      users: { paul: { uid: 501, gid: 20, home: '/Users/paul' } },
    })
    const request = {
      role: 'worker' as const,
      program: ['/opt/mason/0.1.0/bin/node', '/opt/mason/0.1.0/lib/cli.js'],
      args: ['--link-port', '9410'],
    }
    const installed = installService(request, system)
    assert.equal(installed.label, 'app.mason.worker')
    assert.equal(
      installed.file,
      '/Users/paul/Library/LaunchAgents/app.mason.worker.plist',
    )
    assert.equal(installed.data, '/Users/paul/.mason')
    const file = system.files.get(installed.file)!
    assert.equal(file.uid, 501)
    assert.equal(file.mode, 0o644)
    assert.match(
      file.content,
      /<string>worker<\/string>\s*<string>--data<\/string>\s*<string>\/Users\/paul\/.mason<\/string>\s*<string>--link-port<\/string>\s*<string>9410<\/string>/,
    )
    assert.match(file.content, /<key>RunAtLoad<\/key><true\/>/)
    assert(system.dirs.includes('/Users/paul/.mason 501 700'))
    assert.deepEqual(system.commands, [
      'launchctl bootout gui/501/app.mason.worker',
      'launchctl bootstrap gui/501 /Users/paul/Library/LaunchAgents/app.mason.worker.plist',
    ])
    // Installing again rewrites the same file and reloads it.
    installService(request, system)
    assert.equal(system.files.size, 1)
    assert.equal(system.commands.length, 4)
    const master = installService(
      {
        role: 'master',
        coWorker: true,
        data: '/Users/paul/.mason-worker & co',
        program: ['mason'],
        args: ['--worker', '--port', '9400'],
      },
      system,
    )
    const content = system.files.get(master.file)!.content
    assert.match(
      content,
      /<string>master<\/string>\s*<string>--worker<\/string>/,
    )
    assert.equal((content.match(/--worker/g) ?? []).length, 1)
    assert.match(content, /&amp; co/)
    const removed = uninstallService({ role: 'worker' }, system)
    assert.equal(removed.file, installed.file)
    assert(!system.files.has(installed.file))
    assert.equal(
      system.commands.at(-1),
      'launchctl bootout gui/501/app.mason.worker',
    )
  })

  it('installs a systemd service on Linux, creating the mason user when only root exists', () => {
    const users = { deploy: { uid: 1000, gid: 1000, home: '/home/deploy' } }
    const sudo = fakeSystem({
      platform: 'linux',
      env: { SUDO_USER: 'deploy' },
      users,
    })
    const unit = installService(
      {
        role: 'host',
        program: ['/opt/mason/bin/mason'],
        args: ['--port', '9200', '--web-plain', '--listen', '127.0.0.1'],
      },
      sudo,
    )
    assert.equal(unit.file, '/etc/systemd/system/mason-host.service')
    const content = sudo.files.get(unit.file)!.content
    assert.match(content, /^User=deploy$/m)
    assert.match(
      content,
      /^ExecStart=\/opt\/mason\/bin\/mason host --data \/home\/deploy\/.mason --port 9200 --web-plain --listen 127.0.0.1$/m,
    )
    assert.equal(sudo.files.get(unit.file)!.uid, 0)
    assert.deepEqual(sudo.commands, [
      'systemctl daemon-reload',
      'systemctl enable mason-host',
      'systemctl restart mason-host',
    ])
    for (const env of [{}, { SUDO_USER: 'root' }]) {
      const rootOnly = fakeSystem({
        platform: 'linux',
        env,
        groupExists: (name) => name === 'docker',
      })
      const installed = installService(
        {
          role: 'worker',
          program: ['/opt/mason/bin/mason', 'with space'],
          args: [],
        },
        rootOnly,
      )
      assert.equal(installed.user, 'mason')
      assert.equal(installed.data, '/var/lib/mason/.mason')
      assert.deepEqual(rootOnly.created, ['mason /var/lib/mason docker'])
      assert.match(
        rootOnly.files.get(installed.file)!.content,
        /^ExecStart=\/opt\/mason\/bin\/mason "with space" worker/m,
      )
      installService({ role: 'worker', program: ['mason'], args: [] }, rootOnly)
      assert.equal(rootOnly.created.length, 1)
    }
    const explicit = fakeSystem({
      platform: 'linux',
      env: { SUDO_USER: 'deploy' },
      users: { ...users, ci: { uid: 1001, gid: 1001, home: '/srv/ci' } },
    })
    assert.equal(
      installService(
        {
          role: 'worker',
          user: 'ci',
          data: '/srv/ci/data',
          program: ['mason'],
          args: [],
        },
        explicit,
      ).data,
      '/srv/ci/data',
    )
    const removed = uninstallService({ role: 'host' }, sudo)
    assert.equal(removed.label, 'mason-host')
    assert(!sudo.files.has(unit.file))
    assert.deepEqual(sudo.commands.slice(-2), [
      'systemctl disable --now mason-host',
      'systemctl daemon-reload',
    ])
  })

  it('refuses services without root, as root on macOS, and for missing users', () => {
    const request = { role: 'worker' as const, program: ['mason'], args: [] }
    assert.throws(
      () => installService(request, fakeSystem({ euid: 501 })),
      /needs root/,
    )
    assert.throws(
      () => uninstallService(request, fakeSystem({ euid: 501 })),
      /needs root/,
    )
    assert.throws(
      () => installService(request, fakeSystem({ env: {} })),
      /pass --user/,
    )
    assert.throws(
      () => installService(request, fakeSystem({ env: { SUDO_USER: 'root' } })),
      /pass --user/,
    )
    assert.throws(
      () => uninstallService(request, fakeSystem({ env: {} })),
      /pass --user/,
    )
    assert.throws(
      () =>
        installService(request, fakeSystem({ env: { SUDO_USER: 'ghost' } })),
      /No user named ghost/,
    )
    assert.throws(
      () =>
        uninstallService(request, fakeSystem({ env: { SUDO_USER: 'ghost' } })),
      /No user named ghost/,
    )
    assert.throws(
      () =>
        installService(
          { ...request, user: 'admin' },
          fakeSystem({
            users: { admin: { uid: 0, gid: 0, home: '/var/root' } },
          }),
        ),
      /never runs as root/,
    )
    const broken = fakeSystem({
      platform: 'linux',
      createSystemUser: () => undefined,
    })
    assert.throws(() => installService(request, broken), /Could not create/)
  })

  it('reads users and runs commands through the real system adapter', () => {
    assert.throws(() => hostSystem('win32'), /macOS and Linux/)
    const calls: string[] = []
    const exec = (command: string, args: string[]): string => {
      calls.push([command, ...args].join(' '))
      if (command === 'id') return args[0] === '-u' ? '501\n' : '20\n'
      if (command === 'dscl') return 'NFSHomeDirectory: /Users/paul\n'
      if (command === 'getent' && args[0] === 'passwd')
        return 'deploy:x:1000:1000::/home/deploy:/bin/bash\n'
      if (command === 'getent' && args[1] === 'docker') return 'docker:x:999:\n'
      if (command === 'false' || command === 'getent') throw new Error('exit 2')
      return ''
    }
    const mac = hostSystem('darwin', exec)
    assert.deepEqual(mac.user('paul'), {
      uid: 501,
      gid: 20,
      home: '/Users/paul',
    })
    assert.equal(mac.user('bad name!'), undefined)
    const linux = hostSystem('linux', exec)
    assert.deepEqual(linux.user('deploy'), {
      uid: 501,
      gid: 20,
      home: '/home/deploy',
    })
    assert.equal(linux.groupExists('docker'), true)
    assert.equal(linux.groupExists('wheel'), false)
    linux.createSystemUser('mason', '/var/lib/mason', ['docker'])
    linux.createSystemUser('mason', '/var/lib/mason', [])
    assert(
      calls.includes(
        'useradd --system --create-home --home-dir /var/lib/mason --shell /usr/sbin/nologin --groups docker mason',
      ),
    )
    assert(
      calls.includes(
        'useradd --system --create-home --home-dir /var/lib/mason --shell /usr/sbin/nologin mason',
      ),
    )
    linux.run('false', [], true)
    assert.throws(() => linux.run('false', []), /exit 2/)
    linux.run('true', [])
    const failing = hostSystem('linux', (command) => {
      if (command === 'id') throw new Error('no such user')
      return ''
    })
    assert.equal(failing.user('nobody-here'), undefined)
    const homeless = hostSystem('linux', (command) =>
      command === 'getent' ? 'x:x:1:1::' : '1',
    )
    assert.equal(homeless.user('x'), undefined)
    const uid = process.getuid!()
    const gid = process.getgid!()
    const real = hostSystem()
    const dir = path.join(root, 'made')
    real.makeDirectory(dir, { uid, gid }, 0o700)
    real.makeDirectory(dir, { uid, gid }, 0o700)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    real.writeFile(path.join(dir, 'f'), 'x', { uid, gid }, 0o644)
    assert.equal(statSync(path.join(dir, 'f')).mode & 0o777, 0o644)
    real.removeFile(path.join(dir, 'f'))
    assert(!existsSync(path.join(dir, 'f')))
    assert.equal(processIO.program().length, 2)
  })

  it('installs and removes a service from the command line', async () => {
    const system = fakeSystem({
      env: { SUDO_USER: 'paul' },
      users: { paul: { uid: 501, gid: 20, home: root } },
    })
    const data = path.join(root, '.mason')
    // The fake service is started by hand so the command finds its socket.
    const service = testIO()
    const running = nodeMain(
      ['worker', '--data', data, '--link-port', '0', '--listen', '127.0.0.1'],
      service,
    )
    await service.node
    const io = testIO({ system: () => system })
    assert.equal(
      await nodeMain(['worker', '--install', '--link-port', '9410'], io),
      0,
    )
    assert.match(io.lines[0]!, /Installed app\.mason\.worker for paul/)
    // A worker's install adds the privileged helper's root service too.
    assert.match(io.lines[1]!, /Installed app\.mason\.helper/)
    assert.equal(
      io.lines[2],
      service.lines.find((line) => line.startsWith('Pairing key: ')),
    )
    const removal = testIO({ system: () => system })
    assert.equal(await nodeMain(['worker', '--uninstall'], removal), 0)
    assert.match(removal.lines[0]!, /Removed app\.mason\.worker/)
    assert.match(
      removal.lines[1]!,
      /Removed app\.mason\.helper .* and its master key/,
    )
    service.stop()
    await running
    const masterData = path.join(root, 'm')
    const masterService = testIO()
    const masterRunning = nodeMain(
      ['--data', masterData, '--port', '0', '--listen', '127.0.0.1'],
      masterService,
    )
    await masterService.node
    const masterIO = testIO({ system: () => system })
    assert.equal(
      await nodeMain(['master', '--install', '--data', masterData], masterIO),
      0,
    )
    assert.equal(
      masterIO.lines[1],
      `Setup code: ${readFileSync(path.join(masterData, 'setup-code'), 'utf8').trim()}`,
    )
    masterService.stop()
    await masterRunning
  })

  it('trusts a server by public-key pin and sends nothing to the wrong one', async () => {
    const good = createCertificate(['127.0.0.1'])
    const other = createCertificate(['127.0.0.1'])
    let requests = 0
    const server = createHttpsServer(
      { cert: good.cert, key: good.key },
      (_req, res) => {
        requests++
        res.end('ok')
      },
    ).listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`
    let applicationBytes = 0
    server.on('secureConnection', (socket) =>
      socket.on('data', (chunk: Buffer) => (applicationBytes += chunk.length)),
    )
    try {
      const response = await pinnedFetch(url, {}, publicKeyPin(good.cert))
      assert.equal(await response.text(), 'ok')
      assert.equal(
        pinnedAgent(publicKeyPin(good.cert)),
        pinnedAgent(publicKeyPin(good.cert)),
      )
      const before = applicationBytes
      await assert.rejects(
        pinnedFetch(url, {}, publicKeyPin(other.cert)),
        (error: Error) => {
          assert.match(
            String(
              (error.cause as Error | undefined)?.message ?? error.message,
            ),
            /does not match the pin/,
          )
          return true
        },
      )
      assert.equal(applicationBytes, before)
      assert.equal(requests, 1)
      await assert.rejects(pinnedFetch(url, {}), /fetch failed/)
      await assert.rejects(
        pinnedFetch(
          url.replace('https:', 'http:'),
          {},
          publicKeyPin(good.cert),
        ),
        /fetch failed/,
      )
      await assert.rejects(
        pinnedFetch('https://127.0.0.1:1/', {}, publicKeyPin(other.cert)),
        /fetch failed/,
      )
      assert.throws(() => asPin('sha256//short'), /Expected a pin/)
      assert.throws(() => asPin(42), /Expected a pin/)
    } finally {
      server.close()
    }
  })

  it('lets the builder client reach a master by pin', async () => {
    const certificate = createCertificate(['127.0.0.1'])
    let polls = 0
    const server = createHttpsServer(
      { cert: certificate.cert, key: certificate.key },
      (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.method === 'POST')
          res.end(JSON.stringify({ id: 'job-1', status: 'queued' }))
        else
          res.end(
            JSON.stringify({
              id: 'job-1',
              status: ++polls < 2 ? 'running' : 'succeeded',
            }),
          )
      },
    ).listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const key = path.join(root, 'key')
      writeFileSync(key, 'a'.repeat(64), { mode: 0o600 })
      const config = path.join(root, 'client.json')
      const write = (pin: string): void =>
        writeFileSync(
          config,
          JSON.stringify({
            url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
            keyFile: 'key',
            pollMs: 50,
            pin,
          }),
          { mode: 0o600 },
        )
      write(publicKeyPin(certificate.cert))
      const output: string[] = []
      await builderCommand(
        [
          'build',
          '--client-config',
          config,
          '--app',
          'app.example',
          '--branch',
          'master',
        ],
        (line) => output.push(line),
      )
      assert.equal(JSON.parse(output.at(-1)!).status, 'succeeded')
      write(publicKeyPin(createCertificate([]).cert))
      await assert.rejects(
        builderCommand(
          ['build', '--client-config', config, '--app', 'app.example'],
          () => undefined,
        ),
      )
      assert.equal(polls, 2)
    } finally {
      server.close()
    }
  })

  it('keeps the legacy commands on their old paths', async () => {
    assert(isLegacyCommand(['status', '--config', 'x']))
    assert(isLegacyCommand(['builder', 'serve']))
    assert(isLegacyCommand(['devices-inspect']))
    assert(isLegacyCommand(['keys', 'import', '--file', 'f']))
    assert(!isLegacyCommand(['keys', 'create', '--role', 'developer']))
    assert(!isLegacyCommand(['status']))
    assert(!isLegacyCommand([]))
    assert(!isLegacyCommand(['worker', '--data', 'd']))
    assert.throws(() => run(['status', '--config']), /Usage/)
    const runCli = async (
      args: string[],
    ): Promise<{ code: number; out: string; err: string }> => {
      const child = spawn(process.execPath, [cli, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => (out += chunk))
      child.stderr.on('data', (chunk: Buffer) => (err += chunk))
      const [code] = (await once(child, 'exit')) as [number]
      return { code, out, err }
    }
    const missing = path.join(root, 'missing.json')
    for (const command of [
      'devices-bootstrap',
      'devices-inspect',
      'devices-worker',
    ]) {
      const result = await runCli([command, '--config', missing])
      assert.equal(result.code, 1)
      assert.match(result.err, /failed/)
    }
    assert.match(
      (await runCli(['builder', 'apps', '--config', missing])).err,
      /Builder command failed/,
    )
    assert.match(
      (await runCli(['status', '--config', missing])).err,
      /Mason command failed/,
    )
    const help = await runCli(['help'])
    assert.equal(help.code, 0)
    assert.match(help.out, /mason worker/)
    const status = await runCli([
      'status',
      '--data',
      path.join(root, 'nothing'),
    ])
    assert.equal(status.code, 1)
    assert.match(status.err, /No Mason data directory/)
  })
})
