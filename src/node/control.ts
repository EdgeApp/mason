import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createConnection, createServer, type Server } from 'node:net'
import path from 'node:path'
import { privateDirectory } from '../config.js'

// Unix socket paths are limited to about 104 bytes.
const MAX_SOCKET_PATH = 100

/**
 * The control socket of a data directory: `<data>/control.sock`, or, when that
 * path is too long for a Unix socket, a per-directory socket in
 * `/tmp/mason-control-<uid>`, an owner-only directory of the data directory's
 * owner. Both paths are the same for the owner and for root.
 */
export function controlSocketPath(dir: string, kind = 'control'): string {
  const inside = path.join(dir, `${kind}.sock`)
  if (Buffer.byteLength(inside) <= MAX_SOCKET_PATH) return inside
  const owner = existsSync(dir) ? statSync(dir).uid : (process.getuid?.() ?? 0)
  const name = createHash('sha256').update(dir).digest('hex').slice(0, 24)
  return path.join(
    runtimeRoot(),
    `mason-control-${owner}`,
    kind === 'control' ? name + '.sock' : `${name}-${kind}.sock`,
  )
}
const runtimeRoot = (): string => realpathSync('/tmp')

export type ControlHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown

export interface ControlServer {
  path: string
  close(): Promise<void>
}

const MAX_REQUEST = 1024 * 1024

/**
 * Serves operator commands on the control socket. Each connection sends one
 * JSON line `{command, args}` and receives one JSON line
 * `{ok: true, result}` or `{ok: false, error}`. The socket is owner-only, so
 * a caller who can open it owns the data directory.
 */
export async function serveControl(
  dir: string,
  handlers: Record<string, ControlHandler>,
): Promise<ControlServer> {
  const socketPath = controlSocketPath(dir)
  if (path.dirname(socketPath) !== dir)
    privateDirectory(path.dirname(socketPath))
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket())
      throw new Error('Control socket path is not a socket')
    // The data directory lock is held, so this socket is a stale leftover.
    rmSync(socketPath)
  }
  const server: Server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_REQUEST) {
        socket.destroy()
        return
      }
      const end = buffer.indexOf('\n')
      if (end < 0) return
      const line = buffer.slice(0, end)
      socket.pause()
      void (async (): Promise<void> => {
        let reply: unknown
        try {
          const request = JSON.parse(line) as {
            command?: unknown
            args?: unknown
          }
          const handler =
            typeof request.command === 'string' &&
            Object.hasOwn(handlers, request.command)
              ? handlers[request.command]
              : undefined
          if (handler == null) throw new Error('Unknown control command')
          const args =
            request.args != null && typeof request.args === 'object'
              ? (request.args as Record<string, unknown>)
              : {}
          reply = { ok: true, result: (await handler(args)) ?? null }
        } catch (error) {
          reply = {
            ok: false,
            error: error instanceof Error ? error.message : 'Command failed',
          }
        }
        socket.end(JSON.stringify(reply) + '\n')
      })()
    })
    socket.on('error', () => socket.destroy())
  })
  const previous = process.umask(0o177)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } finally {
    process.umask(previous)
  }
  chmodSync(socketPath, 0o600)
  return {
    path: socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        rmSync(socketPath, { force: true })
      }),
  }
}

export class NotRunning extends Error {
  constructor() {
    super('The node is not running')
  }
}

/** Sends one command to a running node; throws `NotRunning` when none is. */
export async function controlRequest(
  dir: string,
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30000,
): Promise<unknown> {
  const socketPath = controlSocketPath(dir)
  if (!existsSync(socketPath)) throw new NotRunning()
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('The node did not answer'))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(JSON.stringify({ command, args }) + '\n')
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
    })
    socket.on('end', () => {
      clearTimeout(timer)
      try {
        const reply = JSON.parse(buffer) as {
          ok: boolean
          result?: unknown
          error?: string
        }
        if (reply.ok) resolve(reply.result)
        else reject(new Error(reply.error ?? 'Command failed'))
      } catch {
        reject(new Error('Invalid control reply'))
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(
        error.code === 'ECONNREFUSED' || error.code === 'ENOENT'
          ? new NotRunning()
          : error,
      )
    })
  })
}
