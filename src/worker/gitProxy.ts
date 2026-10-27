/**
 * Source code over the master's link. A worker's git runs `git fetch`
 * through git's `ext::` transport, which starts this file as a proxy; the
 * proxy connects to the worker's owner-only bridge socket, and the worker
 * carries the bytes over a link stream to `git upload-pack` on the master's
 * mirror. LFS objects come the same way through a git-lfs custom transfer
 * agent. Workers hold no repository credentials.
 */
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Link, Stream } from '../link/link.js'

export const proxyPath = fileURLToPath(
  new URL('./gitProxy.js', import.meta.url),
)

/** What a bridged connection asks for, sent as its first line. */
type Request =
  | {
      kind: 'upload-pack'
      ticket: string
      service: string
      repository: string
      protocol?: string
    }
  | {
      kind: 'lfs'
      ticket: string
      repository: string
      oid: string
      size: number
    }

/** Who a fetch is for: the stage (or setup run) key and its token. */
export interface Ticket {
  key: string
  token: string
}

/** ext:: arguments are split on spaces; `% ` keeps one inside an argument and `%%` is a percent sign. */
const extArg = (value: string): string =>
  value.replace(/%/g, '%%').replace(/ /g, '% ')

/** The canonical HTTPS form of a GitHub repository, which checkouts use as their origin. */
export function canonical(repository: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(
      repository,
    )
  if (match == null) throw new Error('Not a GitHub repository')
  return `https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}.git`
}

/** Every spelling git may use for a repository, so `insteadOf` catches each. */
function spellings(repository: string): string[] {
  const https = canonical(repository)
  const name = https.slice('https://github.com/'.length, -'.git'.length)
  return [
    https,
    `https://github.com/${name}`,
    `git@github.com:${name}.git`,
    `git@github.com:${name}`,
    `ssh://git@github.com/${name}.git`,
  ]
}

/**
 * The worker's end: an owner-only socket the proxies connect to, relayed to
 * the master over the current link.
 */
export class GitBridge {
  readonly socket: string
  private readonly dir: string
  private readonly server: net.Server
  private readonly tickets = new Map<string, Ticket>()

  constructor(private readonly link: () => Link | undefined) {
    // Unix socket paths are short; a private directory under the system temp keeps it valid.
    this.dir = mkdtempSync(path.join(os.tmpdir(), 'mason-git-'))
    this.socket = path.join(this.dir, 'bridge.sock')
    // git ends its side once its request is sent and keeps reading the pack.
    this.server = net.createServer({ allowHalfOpen: true }, (connection) => {
      this.accept(connection)
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.socket, () => {
        resolve()
      })
    })
  }

  close(): void {
    this.server.close()
    rmSync(this.dir, { recursive: true, force: true })
  }

  /** A ticket for one checkout; revoked by the returned function. */
  issue(ticket: Ticket): { id: string; revoke: () => void } {
    const id = randomBytes(16).toString('hex')
    this.tickets.set(id, ticket)
    return {
      id,
      revoke: (): void => {
        this.tickets.delete(id)
      },
    }
  }

  /**
   * Git configuration, as `GIT_CONFIG_COUNT` variables, that sends each
   * allowed repository through the bridge and allows `ext::` for this
   * command and the submodule fetches it starts — nothing else.
   */
  environment(
    ticket: string,
    repositories: string[],
    lfs?: string,
  ): Record<string, string> {
    const entries: Array<[string, string]> = [['protocol.ext.allow', 'always']]
    for (const repository of repositories) {
      const url = `ext::${extArg(process.execPath)} ${extArg(proxyPath)} %S ${extArg(this.socket)} ${ticket} ${extArg(canonical(repository))}`
      for (const spelling of spellings(repository))
        entries.push([`url.${url}.insteadOf`, spelling])
    }
    if (lfs != null)
      entries.push(
        ['lfs.standalonetransferagent', 'mason'],
        ['lfs.customtransfer.mason.path', process.execPath],
        [
          'lfs.customtransfer.mason.args',
          `"${proxyPath}" lfs "${this.socket}" ${ticket} ${canonical(lfs)}`,
        ],
        ['lfs.customtransfer.mason.concurrent', 'false'],
      )
    const env: Record<string, string> = {
      GIT_CONFIG_COUNT: String(entries.length),
    }
    entries.forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key
      env[`GIT_CONFIG_VALUE_${i}`] = value
    })
    return env
  }

  private accept(connection: net.Socket): void {
    let header = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk])
      const end = header.indexOf(10)
      if (end < 0) {
        if (header.length > 8192) connection.destroy()
        return
      }
      connection.off('data', onData)
      connection.pause()
      let request: Request
      try {
        request = JSON.parse(header.subarray(0, end).toString()) as Request
      } catch {
        connection.destroy()
        return
      }
      const rest = header.subarray(end + 1)
      const ticket = this.tickets.get(request.ticket)
      const link = this.link()
      if (ticket == null || link == null) {
        connection.end()
        return
      }
      const { ticket: _ignored, ...params } = request
      void _ignored
      let stream: Stream
      try {
        stream = link.openStream(
          request.kind === 'lfs' ? 'git.lfs' : 'git.upload-pack',
          {
            ...params,
            key: ticket.key,
            token: ticket.token,
          },
        )
      } catch {
        connection.destroy()
        return
      }
      relay(connection, stream, rest)
    }
    connection.on('data', onData)
    connection.on('error', () => undefined)
  }
}

/** Pipes a socket and a link stream into each other until both ends finish. */
function relay(connection: net.Socket, stream: Stream, first: Buffer): void {
  let writing = Promise.resolve()
  const send = (chunk: Buffer): void => {
    connection.pause()
    writing = writing
      .then(async () => {
        await stream.write(chunk)
      })
      .then(
        () => {
          connection.resume()
        },
        () => {
          connection.destroy()
        },
      )
  }
  if (first.length > 0) send(first)
  connection.on('data', send)
  connection.on('end', () => {
    void writing.then(() => {
      stream.end()
    })
  })
  connection.on('error', () => {
    stream.abort('Fetch connection failed')
  })
  let ended = false
  connection.on('close', () => {
    if (!ended) stream.abort('Fetch connection closed')
  })
  stream.on('data', (chunk: Buffer) => connection.write(chunk))
  stream.on('end', () => {
    ended = true
    connection.end()
  })
  stream.on('abort', () => connection.destroy())
  connection.resume()
}

/** Connects to the bridge and sends the request line. */
function connect(socket: string, request: Request): net.Socket {
  const connection = net.createConnection({ path: socket, allowHalfOpen: true })
  connection.write(JSON.stringify(request) + '\n')
  return connection
}

/** `gitProxy.js <service> <socket> <ticket> <repository>`, started by git's ext:: transport. */
export function proxyMain(args: string[]): void {
  const [service, socket, ticket, repository] = args
  const connection = connect(socket!, {
    kind: 'upload-pack',
    ticket: ticket!,
    service: service!,
    repository: repository!,
    // git's ext:: transport speaks the version git asks for in GIT_PROTOCOL (v0 when unset).
    ...(process.env.GIT_PROTOCOL == null
      ? {}
      : { protocol: process.env.GIT_PROTOCOL }),
  })
  process.stdin.pipe(connection)
  connection.pipe(process.stdout, { end: false })
  connection.on('error', (error) => {
    process.stderr.write(`mason: ${error.message}\n`)
    process.exit(128)
  })
  // The master has sent everything once its side ends; exit after stdout drains.
  connection.on('end', () => {
    process.stdout.write('', () => {
      process.exit(0)
    })
  })
  connection.on('close', () => {
    process.exit(0)
  })
}

/**
 * `gitProxy.js lfs <socket> <ticket>`: a git-lfs standalone custom transfer
 * agent that downloads each object from the master.
 */
export function lfsMain(args: string[]): void {
  const [socket, ticket, repository] = args
  const reply = (message: unknown): void => {
    process.stdout.write(JSON.stringify(message) + '\n')
  }
  const scratch = path.join(process.cwd(), '.git', 'lfs', 'tmp')
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    const event = JSON.parse(line) as {
      event: string
      oid?: string
      size?: number
      operation?: string
    }
    if (event.event === 'init') {
      reply(
        event.operation === 'download'
          ? {}
          : { error: { code: 1, message: 'Workers never upload LFS objects' } },
      )
    } else if (event.event === 'download') {
      mkdirSync(scratch, { recursive: true })
      const file = path.join(scratch, `mason-${event.oid}`)
      const out = createWriteStream(file)
      const connection = connect(socket!, {
        kind: 'lfs',
        ticket: ticket!,
        repository: repository!,
        oid: event.oid!,
        size: event.size!,
      })
      let size = 0
      connection.on('data', (chunk: Buffer) => {
        size += chunk.length
      })
      connection.pipe(out)
      out.on('finish', () => {
        reply(
          size === event.size
            ? { event: 'complete', oid: event.oid, path: file }
            : {
                event: 'complete',
                oid: event.oid,
                error: {
                  code: 2,
                  message: 'The master could not send that LFS object',
                },
              },
        )
      })
      connection.on('error', () => {
        out.destroy()
        reply({
          event: 'complete',
          oid: event.oid,
          error: { code: 2, message: 'LFS bridge failed' },
        })
      })
    } else if (event.event === 'terminate') process.exit(0)
  })
}

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [mode, ...rest] = process.argv.slice(2)
  if (mode === 'lfs') lfsMain(rest)
  else proxyMain([mode!, ...rest])
}
