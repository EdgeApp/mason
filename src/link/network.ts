import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { Server } from 'node:https'
import { isIP } from 'node:net'
import { connect, type TLSSocket } from 'node:tls'
import { WebSocket, WebSocketServer } from 'ws'
import { EXPORTER_LABEL } from './handshake.js'
import { MAX_CHUNK, MAX_MESSAGE } from './link.js'
import { WebSocketWire } from './wire.js'

export const LINK_GROUP = 'X25519MLKEM768'
export const DEFAULT_LINK_PORT = 9310

export interface Address {
  host: string
  port: number
}

/** Parses a node address: a URL, `host:port`, `[v6]:port`, a bare host or IP. */
export function parseAddress(
  value: string,
  defaultPort = DEFAULT_LINK_PORT,
): Address {
  value = value.trim()
  if (value === '') throw new Error('Address is empty')
  // A NoMac Mac, reached through its SSH gateway rather than by address.
  const nomac = /^(nomac:[A-Za-z0-9_-]{1,80})(?::(\d+))?$/.exec(value)
  if (nomac != null)
    return {
      host: nomac[1]!,
      port: nomac[2] == null ? defaultPort : Number(nomac[2]),
    }
  if (/^[a-z]+:\/\//i.test(value)) {
    const url = new URL(value)
    if (
      !['https:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('Expected an https:// or wss:// node address')
    return {
      host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: url.port === '' ? defaultPort : Number(url.port),
    }
  }
  if (isIP(value) === 6) return { host: value, port: defaultPort }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  if (bracketed != null)
    return {
      host: bracketed[1]!,
      port: bracketed[2] == null ? defaultPort : Number(bracketed[2]),
    }
  const match = /^([A-Za-z0-9.-]+)(?::(\d+))?$/.exec(value)
  if (match == null) throw new Error(`Invalid node address ${value}`)
  const port = match[2] == null ? defaultPort : Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Invalid port in ${value}`)
  return { host: match[1]!, port }
}

export const certificateDigest = (raw: Buffer): string =>
  createHash('sha256').update(raw).digest('base64url')

export function exporter(socket: TLSSocket): Buffer {
  return socket.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0))
}

/** The negotiated key-exchange group of a TLS 1.3 socket. */
export function negotiatedGroup(socket: TLSSocket): string | undefined {
  const info = socket.getEphemeralKeyInfo() as { name?: string } | null
  return info?.name
}

export class PinMismatch extends Error {
  constructor() {
    super('The node certificate does not match')
  }
}

/**
 * Opens a link transport to a node. The TLS socket is opened here and its
 * certificate compared with `certificateHash` before anything is written; only
 * then is it handed to the WebSocket client.
 */
export async function dialWire(
  address: Address,
  certificateHash: string,
  timeoutMs = 10000,
  /**
   * The stream TLS runs over instead of a TCP connection to the address (a
   * tunnel); the node's certificate pin and key exchange are checked alike.
   */
  transport?: () => Promise<Duplex>,
): Promise<{ wire: WebSocketWire; exporter: Buffer }> {
  const tunnel = transport == null ? undefined : await transport()
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const tls = connect({
      ...(tunnel == null
        ? { host: address.host, port: address.port }
        : { socket: tunnel }),
      ...(tunnel == null && isIP(address.host) === 0
        ? { servername: address.host }
        : {}),
      minVersion: 'TLSv1.3',
      ecdhCurve: LINK_GROUP,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    })
    const timer = setTimeout(() => {
      tls.destroy()
      reject(new Error('Node did not answer'))
    }, timeoutMs)
    tls.once('secureConnect', () => {
      clearTimeout(timer)
      const raw = tls.getPeerCertificate(false)?.raw
      if (raw == null || certificateDigest(raw) !== certificateHash) {
        tls.destroy()
        reject(new PinMismatch())
        return
      }
      if (negotiatedGroup(tls) !== LINK_GROUP) {
        tls.destroy()
        reject(new Error('The node did not negotiate the hybrid key exchange'))
        return
      }
      resolve(tls)
    })
    tls.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  // Over a tunnel the URL only names the link; the socket is the tunnel's.
  const host =
    tunnel != null
      ? '127.0.0.1'
      : address.host.includes(':')
        ? `[${address.host}]`
        : address.host
  const ws = new WebSocket(`wss://${host}:${address.port}/link`, {
    createConnection: (): TLSSocket => socket,
    maxPayload: MAX_MESSAGE + MAX_CHUNK,
    perMessageDeflate: false,
  })
  // The wire listens from the start: the node's hello can arrive in the same
  // read as the upgrade's answer (it does through a tunnel), and ws emits it
  // right after 'open'.
  const wire = new WebSocketWire(ws)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
    ws.once('unexpected-response', () =>
      reject(new Error('The node refused the link')),
    )
  })
  return { wire, exporter: exporter(socket) }
}

/**
 * Accepts link transports on a node's link listener, handing each new wire
 * and its TLS exporter to `accept`.
 */
export function acceptWires(
  server: Server,
  accept: (wire: WebSocketWire, exporter: Buffer) => void,
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/link',
    maxPayload: MAX_MESSAGE + MAX_CHUNK,
    perMessageDeflate: false,
  })
  wss.on('connection', (ws, req) => {
    // The listener offers only the hybrid group, so no other can be negotiated
    // (Node reports the group on the client end of a TLS socket only).
    accept(new WebSocketWire(ws), exporter(req.socket as TLSSocket))
  })
  return wss
}
