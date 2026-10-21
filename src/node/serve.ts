import { chmodSync, existsSync, readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { hostname, networkInterfaces } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { asObject, asOptional, asString } from 'cleaners'
import { hostApp } from '../host/web.js'
import { HostRuntime, type HostOptions } from '../host/runtime.js'
import { masterApp } from '../master/web.js'
import { version } from '../version.js'
import {
  serveControl,
  type ControlHandler,
  type ControlServer,
} from './control.js'
import {
  lockDataDir,
  lockHolder,
  prepareDataDir,
  readPrivate,
  writePrivate,
} from './dataDir.js'
import {
  applyPairingFile,
  clearSetupCode,
  fingerprint,
  loadIdentity,
  newSetupCode,
  PAIRING_FILE,
  type Identity,
} from './identity.js'
import { certificateHash, publicKeyPin } from './certificate.js'
import {
  listenWeb,
  webCertificate,
  type WebCertificate,
  type WebOptions,
} from './web.js'
import { createPublicKey, type KeyObject } from 'node:crypto'
import type { Server as HttpsServer } from 'node:https'
import { Link, type MethodTable } from '../link/link.js'
import { Pairing, serveNodeLinks, type NodeLinks } from '../link/nodeSide.js'
import { memoryPair } from '../link/wire.js'
import type { NodeRegistry } from '../master/nodes.js'
import { Master, type MasterOptions } from '../master/runtime.js'
import { privateDirectory } from '../config.js'
import { WorkerRuntime, type WorkerOptions } from '../worker/stage.js'

export type Role = 'master' | 'worker' | 'host'
export const defaultPorts = { master: 9300, host: 9200, link: 9310 }

export interface NodeOptions {
  role: Role
  /** `mason master --worker`: a worker in the master's process. */
  coWorker?: boolean
  data: string
  port?: number
  linkPort?: number
  listen?: string
  webCert?: string
  webKey?: string
  webPlain?: boolean
  newKey?: boolean
  testEndpoints?: boolean
  /** Methods the master accepts from each peer role (later milestones add them). */
  masterMethods?: (role: 'worker' | 'host') => MethodTable
  /** Methods a worker or host accepts from its master. */
  nodeMethods?: MethodTable
  heartbeatMs?: number
  redialBaseMs?: number
  /** Master internals for tests: GitHub API origin, branch heads, repository remotes, pass interval. */
  masterOptions?: Pick<
    MasterOptions,
    | 'github'
    | 'headLister'
    | 'remote'
    | 'tickMs'
    | 'timeZone'
    | 'graceMs'
    | 'stashLimit'
    | 'appleEndpoints'
    | 'cloud'
    | 'now'
  >
  pollMs?: number
  /** Stages a worker runs at once (the master's node setting can lower it). */
  slots?: number
  /** Host internals for tests: the clock and the OIDC transport. */
  hostOptions?: Pick<HostOptions, 'now' | 'transport'>
  /** Worker internals for tests. */
  workerOptions?: Pick<
    WorkerOptions,
    | 'inspect'
    | 'flushMs'
    | 'applications'
    | 'toolSources'
    | 'install'
    | 'restart'
    | 'helperSocket'
    | 'masterKey'
    | 'systemRun'
    | 'helper'
  >
}

export interface NodeStatus {
  role: Role
  roles: Role[]
  version: string
  data: string
  state: 'running' | 'stopped'
  pid?: number
  fingerprint?: string
  certificateHash?: string
  pin?: string
  web?: string
  link?: string
  pairing?: 'waiting' | 'paired' | 'removed'
  master?: string
  setup?: 'waiting' | 'configured'
  testEndpoints?: boolean
  /** What needs a person, such as the Apple ID's two-factor code. */
  notices?: string[]
  /** A host's cache: whether its master's link is up, and how current it is. */
  sync?: { online: boolean; revision: number; syncedAt?: number }
}

export interface RunningNode {
  options: NodeOptions
  dir: string
  identity: Identity
  web?: { server: Server; url: string; certificate?: WebCertificate }
  link?: { server: Server; port: number }
  control: ControlServer
  databases: Map<string, DatabaseSync>
  /** On a master: its paired nodes. */
  registry?: NodeRegistry
  master?: Master
  /** On a worker or host: its pairing and the master's link. */
  pairing?: Pairing
  links?: NodeLinks
  /** On `master --worker`: the worker's end of the in-process link. */
  localWorker?: Link
  /** On a worker, or a master with a worker: the worker role. */
  worker?: WorkerRuntime
  /** On a host: its cache and what it serves from it. */
  host?: HostRuntime
  status(): NodeStatus
  close(): Promise<void>
}

const asNodeFile = asObject({ role: asString, coWorker: asOptional(asString) })

/** An owner-only scratch directory inside the data directory. */
function privateScratch(dir: string): string {
  const scratch = path.join(dir, 'tmp')
  privateDirectory(scratch)
  return scratch
}

/** Records the data directory's role, refusing to reuse it for another one. */
export function claimRole(dir: string, role: Role): void {
  const file = path.join(dir, 'node.json')
  if (existsSync(file)) {
    const recorded = asNodeFile(JSON.parse(readPrivate(file))).role
    if (recorded !== role)
      throw new Error(
        `This data directory belongs to a ${recorded}; use another --data for a ${role}`,
      )
    return
  }
  writePrivate(file, JSON.stringify({ role }) + '\n')
}

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file, {
    timeout: 5000,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  })
  chmodSync(file, 0o600)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
  return db
}

/** The databases each role keeps in its data directory. */
export function databaseFiles(role: Role, coWorker = false): string[] {
  if (role === 'master')
    return coWorker ? ['master.sqlite', 'worker.sqlite'] : ['master.sqlite']
  return role === 'worker' ? ['worker.sqlite'] : ['host-cache.sqlite']
}

/** Whether a master database has its first local admin. */
export function masterConfigured(db: DatabaseSync): boolean {
  const columns = db.prepare('PRAGMA table_info(accounts)').all()
  if (!columns.some((column) => column.name === 'password')) return false
  return (
    db
      .prepare(
        "SELECT 1 FROM accounts WHERE role='admin' AND password IS NOT NULL AND disabled=0 LIMIT 1",
      )
      .get() != null
  )
}

/**
 * Addresses a listener can be reached at, for the operator to copy: the host
 * name and every non-internal address, leaving out link-local IPv6 ones.
 */
export function reachableAddresses(port: number, listen?: string): string[] {
  const format = (address: string): string =>
    `${address.includes(':') ? `[${address}]` : address}:${port}`
  if (listen != null && listen !== '0.0.0.0' && listen !== '::')
    return [format(listen)]
  const out = new Set<string>([format(hostname())])
  for (const list of Object.values(networkInterfaces()))
    for (const entry of list ?? [])
      if (!entry.internal && !/^fe80:/i.test(entry.address))
        out.add(format(entry.address))
  return [...out]
}

async function listenLink(
  identity: Identity,
  port: number,
  listen?: string,
): Promise<Server> {
  const server = createHttpsServer(
    {
      cert: identity.cert,
      key: identity.key,
      minVersion: 'TLSv1.3',
      ecdhCurve: 'X25519MLKEM768',
    },
    (_req, res) => {
      res.writeHead(426, { Connection: 'close' }).end()
    },
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, listen, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}

function boundPort(server: Server): number {
  const address = server.address()
  if (address == null || typeof address === 'string')
    throw new Error('Listener has no port')
  return address.port
}

/** Starts a node: takes the data directory, then serves its roles. */
export async function startNode(
  options: NodeOptions,
  log: (line: string) => void = console.log,
  handlers: Record<string, ControlHandler> = {},
): Promise<RunningNode> {
  if (options.coWorker && options.role !== 'master')
    throw new Error('--worker is only for a master')
  const dir = prepareDataDir(options.data)
  const lock = lockDataDir(dir)
  const cleanup: Array<() => Promise<void> | void> = [
    (): void => lock.release(),
  ]
  const close = async (): Promise<void> => {
    for (const step of cleanup.reverse()) await step()
    cleanup.length = 0
  }
  try {
    claimRole(dir, options.role)
    // A cloud machine's first start takes the pairing material its master made.
    const pairingFile = path.join(dir, PAIRING_FILE)
    if (options.role === 'worker' && existsSync(pairingFile))
      applyPairingFile(dir, pairingFile)
    const identity = loadIdentity(dir, { renew: options.newKey === true })
    const databases = new Map<string, DatabaseSync>()
    for (const name of databaseFiles(options.role, options.coWorker)) {
      // The host's cache is opened by its runtime, through the distribution store.
      if (name === 'host-cache.sqlite') continue
      const db = openDatabase(path.join(dir, name))
      databases.set(name, db)
      cleanup.push(() => db.close())
    }
    const webOptions: WebOptions = {
      port:
        options.port ??
        (options.role === 'host' ? defaultPorts.host : defaultPorts.master),
      ...(options.listen == null ? {} : { listen: options.listen }),
      ...(options.webCert == null ? {} : { webCert: options.webCert }),
      ...(options.webKey == null ? {} : { webKey: options.webKey }),
      ...(options.webPlain ? { webPlain: true } : {}),
    }
    const testEndpoints = options.testEndpoints === true
    let web: RunningNode['web']
    let link: RunningNode['link']
    let setupCode: string | undefined
    const masterDb = databases.get('master.sqlite')
    const master =
      masterDb == null
        ? undefined
        : new Master(masterDb, identity, {
            ...(options.masterMethods == null
              ? {}
              : { methods: options.masterMethods }),
            ...(options.heartbeatMs == null
              ? {}
              : { heartbeatMs: options.heartbeatMs }),
            ...(options.redialBaseMs == null
              ? {}
              : { redialBaseMs: options.redialBaseMs }),
            onConfigured: (): void => clearSetupCode(dir),
            ...options.masterOptions,
            scratch: privateScratch(dir),
            dir,
          })
    const configured = (): boolean => master?.configured() ?? false
    let hostLink: () => Link | undefined = () => undefined
    const hostRuntime =
      options.role === 'host'
        ? new HostRuntime({
            dir,
            link: (): Link | undefined => hostLink(),
            log,
            masterKey: (): KeyObject | undefined => {
              const paired = pairing?.master()
              return paired == null
                ? undefined
                : createPublicKey({
                    key: Buffer.from(paired.publicKey, 'base64'),
                    format: 'der',
                    type: 'spki',
                  })
            },
            ...options.hostOptions,
          })
        : undefined
    if (hostRuntime != null) {
      hostRuntime.start()
      const running = hostRuntime
      cleanup.push(async () => await running.stop())
    }
    if (options.role === 'master' || options.role === 'host') {
      const certificate = webCertificate(identity, webOptions)
      const app =
        master != null
          ? masterApp({ role: 'master', testEndpoints, configured, master })
          : hostApp({
              role: 'host',
              testEndpoints,
              ...(hostRuntime == null ? {} : { host: hostRuntime }),
            })
      const server = await listenWeb(app, certificate, webOptions)
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          }),
      )
      const scheme = certificate == null ? 'http' : 'https'
      const host = options.listen ?? hostname()
      web = {
        server,
        url: `${scheme}://${host.includes(':') ? `[${host}]` : host}:${boundPort(server)}`,
        ...(certificate == null ? {} : { certificate }),
      }
      if (hostRuntime != null)
        hostRuntime.web = {
          url: web.url,
          ...(certificate == null ? {} : { pin: certificate.pin }),
        }
    }
    if (options.role === 'worker' || options.role === 'host') {
      const server = await listenLink(
        identity,
        options.linkPort ?? defaultPorts.link,
        options.listen,
      )
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          }),
      )
      link = { server, port: boundPort(server) }
    }
    let pairing: Pairing | undefined
    let links: NodeLinks | undefined
    let worker: WorkerRuntime | undefined
    let workerLink: () => Link | undefined = () => undefined
    const workerDb = databases.get('worker.sqlite')
    if (workerDb != null) {
      // A worker beside a master keeps its files apart from the master's stashes and logs.
      const workerDir = options.coWorker ? path.join(dir, 'worker') : dir
      privateDirectory(workerDir)
      worker = new WorkerRuntime({
        dir: workerDir,
        db: workerDb,
        version,
        link: (): Link | undefined => workerLink(),
        assignment: (): typeof localAssignment =>
          pairing?.assignment() ?? localAssignment,
        masterKey: (): KeyObject | undefined => {
          if (options.coWorker) return identity.publicKey
          const master = pairing?.master()
          return master == null
            ? undefined
            : createPublicKey({
                key: Buffer.from(master.publicKey, 'base64'),
                format: 'der',
                type: 'spki',
              })
        },
        ...(options.slots == null ? {} : { slots: options.slots }),
        ...options.workerOptions,
      })
      await worker.start()
      const running = worker
      cleanup.push(async () => await running.stop())
    }
    let localAssignment:
      | { name: string; type: string; labels: string[] }
      | undefined
    const workerMethods = (): MethodTable => ({
      requests: {
        ...worker?.methods().requests,
        ...options.nodeMethods?.requests,
      },
      events: { ...options.nodeMethods?.events },
      streams: {
        ...worker?.methods().streams,
        ...options.nodeMethods?.streams,
      },
    })
    if (link != null) {
      pairing = new Pairing(dir, identity)
      if (options.newKey) pairing.reset()
      links = serveNodeLinks(link.server as HttpsServer, {
        pairing,
        role: options.role as 'worker' | 'host',
        methods:
          options.role === 'worker'
            ? workerMethods()
            : {
                requests: { ...options.nodeMethods?.requests },
                events: {
                  ...hostRuntime?.methods().events,
                  ...options.nodeMethods?.events,
                },
                streams: {
                  ...hostRuntime?.methods().streams,
                  ...options.nodeMethods?.streams,
                },
              },
        onLink: () => {
          worker?.flushSoon()
          void hostRuntime
            ?.connected()
            .catch((error: unknown) =>
              log(`Sync with the master failed: ${(error as Error).message}`),
            )
        },
        ...(options.heartbeatMs == null
          ? {}
          : { heartbeatMs: options.heartbeatMs }),
        onPaired: (fingerprint) => {
          log(`Paired with master ${fingerprint}`)
          worker?.trustMaster()
        },
        onRemoved: () =>
          log('Removed by its master; start with --new-key to pair it again.'),
      })
      const nodeLinks = links
      cleanup.push(() => nodeLinks.close())
      workerLink = (): Link | undefined => nodeLinks.current()
      hostLink = workerLink
    }
    let registry: NodeRegistry | undefined
    let localWorker: Link | undefined
    if (master != null) {
      const nodes = master.registry
      registry = nodes
      const running = master
      cleanup.push(async () => await running.stop())
      if (options.coWorker) {
        const [masterWire, workerWire] = memoryPair()
        const methods = workerMethods()
        localWorker = new Link(workerWire, {
          localRole: 'worker',
          peerRole: 'master',
          dialer: false,
          methods: {
            ...methods,
            requests: {
              ...methods.requests,
              'node.configure': (params): unknown => {
                localAssignment = params as typeof localAssignment
                return params
              },
            },
          },
          peer: { fingerprint: identity.fingerprint, version },
        })
        const local = localWorker
        workerLink = (): Link | undefined => (local.closed ? undefined : local)
        await nodes.attachLocal(masterWire, identity.fingerprint, hostname())
      }
      master.start(options.pollMs)
    }
    if (options.role === 'master' && !configured())
      setupCode = newSetupCode(dir)
    else if (options.role === 'master') clearSetupCode(dir)

    const status = (): NodeStatus => ({
      ...statusFromFiles(dir, options.role),
      state: 'running',
      pid: process.pid,
      roles: options.coWorker ? ['master', 'worker'] : [options.role],
      ...(web == null ? {} : { web: web.url }),
      ...(link == null ? {} : { link: `:${link.port}` }),
      ...(web?.certificate == null
        ? {}
        : {
            certificateHash: web.certificate.certificateHash,
            pin: web.certificate.pin,
          }),
      ...(options.role === 'master'
        ? { setup: configured() ? 'configured' : 'waiting' }
        : {}),
      testEndpoints,
      ...(hostRuntime == null
        ? {}
        : {
            sync: {
              online: hostRuntime.online(),
              revision: hostRuntime.cache.revision(),
              ...(hostRuntime.cache.syncedAt() == null
                ? {}
                : { syncedAt: hostRuntime.cache.syncedAt()! }),
            },
          }),
      ...(master == null || master.notices().length === 0
        ? {}
        : { notices: master.notices() }),
    })
    const nodeHandlers: Record<string, ControlHandler> = {
      ...(master == null
        ? { pairing: () => pairing?.key() ?? null }
        : master.controlHandlers()),
      ...(hostRuntime == null || !testEndpoints
        ? {}
        : {
            // E2E only: moves the host's clock forward to test the offline grace window.
            'test.clock': (args): { now: number } => {
              hostRuntime.advanceClock(Number(args.ms ?? 0))
              return { now: hostRuntime.now() }
            },
          }),
      ...(worker == null
        ? {}
        : {
            recover: (): null => {
              worker!.recover()
              return null
            },
          }),
    }
    const control = await serveControl(dir, {
      status,
      ...nodeHandlers,
      ...handlers,
    })
    cleanup.push(() => control.close())

    log(
      `Mason ${version} ${options.coWorker ? 'master with a worker' : options.role}`,
    )
    log(`Data: ${dir}`)
    log(`Fingerprint: ${identity.fingerprint}`)
    if (testEndpoints) log('Test endpoints are enabled.')
    if (web != null) {
      log(`Web: ${web.url}`)
      if (web.certificate != null)
        log(
          `Web certificate SHA-256: ${web.certificate.certificateHash}  pin: ${web.certificate.pin}`,
        )
    }
    if (setupCode != null)
      log(
        `Setup code: ${setupCode}  (enter it on the setup page, or run mason setup)`,
      )
    if (link != null && pairing != null) {
      log(`Link: ${reachableAddresses(link.port, options.listen).join(', ')}`)
      const paired = pairing.master()
      if (pairing.removed())
        log('Removed by its master; start with --new-key to pair it again.')
      else if (paired != null) log(`Paired with master ${paired.fingerprint}`)
      else if (pairing.key() == null)
        log('Waiting for the master that made this machine’s pairing file')
      else log(`Pairing key: ${pairing.key()!}`)
    }
    return {
      options,
      dir,
      identity,
      web,
      link,
      control,
      databases,
      ...(registry == null ? {} : { registry }),
      ...(master == null ? {} : { master }),
      ...(hostRuntime == null ? {} : { host: hostRuntime }),
      ...(pairing == null ? {} : { pairing }),
      ...(links == null ? {} : { links }),
      ...(localWorker == null ? {} : { localWorker }),
      ...(worker == null ? {} : { worker }),
      status,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

/** Status read from a data directory without a running node. */
export function statusFromFiles(dir: string, role?: Role): NodeStatus {
  const nodeFile = path.join(dir, 'node.json')
  const recorded = existsSync(nodeFile)
    ? (asNodeFile(JSON.parse(readPrivate(nodeFile))).role as Role)
    : undefined
  const actual = recorded ?? role ?? 'master'
  const out: NodeStatus = {
    role: actual,
    roles: [actual],
    version,
    data: dir,
    state: 'stopped',
  }
  const pub = path.join(dir, 'identity.pub')
  if (existsSync(pub))
    out.fingerprint = fingerprint(createPublicKey(readPrivate(pub)))
  const crt = path.join(dir, 'tls.crt')
  if (existsSync(crt)) {
    const cert = readFileSync(crt, 'utf8')
    out.certificateHash = certificateHash(cert)
    out.pin = publicKeyPin(cert)
  }
  if (actual === 'worker' || actual === 'host') {
    const masterFile = path.join(dir, 'master.json')
    if (existsSync(path.join(dir, 'removed'))) out.pairing = 'removed'
    else if (existsSync(masterFile)) {
      out.pairing = 'paired'
      out.master = (
        JSON.parse(readPrivate(masterFile)) as { fingerprint: string }
      ).fingerprint
    } else out.pairing = 'waiting'
  }
  if (actual === 'master') {
    const file = path.join(dir, 'master.sqlite')
    let configured = false
    if (existsSync(file)) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        configured = masterConfigured(db)
      } finally {
        db.close()
      }
    }
    out.setup = configured ? 'configured' : 'waiting'
  }
  return out
}

/** Status of a data directory: from the running node, or from its files. */
export async function nodeStatus(
  dir: string,
  request: (command: string) => Promise<unknown>,
): Promise<NodeStatus> {
  try {
    return (await request('status')) as NodeStatus
  } catch {
    const holder = lockHolder(dir)
    const status = statusFromFiles(dir)
    return holder.held
      ? {
          ...status,
          state: 'running',
          ...(holder.pid == null ? {} : { pid: holder.pid }),
        }
      : status
  }
}
