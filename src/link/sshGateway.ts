import type { Duplex } from 'node:stream'
import type { ConnectionOptions } from 'node:tls'
import ssh2 from 'ssh2'
import { WebSocket, createWebSocketStream } from 'ws'

const { Client } = ssh2

/**
 * A port on a NoMac Mac, reached through NoMac's SSH gateway: a WebSocket
 * to the session's SSH endpoint carries an SSH connection, as the master's
 * NoMac key, to the Mac's host key that `/access` vouched for, and a
 * `direct-tcpip` channel in it to the port. The link's TLS then runs inside
 * the channel, so the node's certificate pin is checked as on any link.
 */

/** What `POST /mac/sessions/:id/access` answers. */
export interface GatewayAccess {
  session_id: string
  /** The gateway's HTTPS origin. */
  gateway: string
  token: string
  expires_at: string
  generation: number
  ssh: { username: string; host_key: string }
}

export class GatewayRefused extends Error {}

/** The base64 blob of an OpenSSH public key line, `ssh-ed25519 AAAA… comment`. */
function keyBlob(line: string): Buffer {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 2)
    throw new GatewayRefused('The Mac’s host key is malformed')
  return Buffer.from(parts[1]!, 'base64')
}

export async function openTunnel(options: {
  sessionId: string
  access: GatewayAccess
  /** The master's NoMac SSH key, OpenSSH format. */
  privateKey: string
  port: number
  timeoutMs?: number
  /** TLS options for the gateway (a test CA). */
  tls?: Pick<ConnectionOptions, 'ca'>
}): Promise<Duplex> {
  const { access } = options
  if (access.session_id !== options.sessionId)
    throw new GatewayRefused('The gateway answered for another session')
  const hostKey = keyBlob(access.ssh.host_key)
  const url = new URL(access.gateway)
  if (url.protocol !== 'https:')
    throw new GatewayRefused('The NoMac gateway must be an HTTPS origin')
  url.protocol = 'wss:'
  url.pathname = `/api/v1/mac/sessions/${encodeURIComponent(options.sessionId)}/ssh`
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${access.token}` },
    perMessageDeflate: false,
    handshakeTimeout: options.timeoutMs ?? 15_000,
    followRedirects: false,
    ...(options.tls?.ca == null ? {} : { ca: options.tls.ca }),
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
    ws.once('unexpected-response', (_request, response) => {
      response.resume()
      reject(
        new GatewayRefused(
          `The NoMac gateway refused the tunnel (HTTP ${response.statusCode})`,
        ),
      )
    })
  })
  const stream = createWebSocketStream(ws)
  const client = new Client()
  return await new Promise<Duplex>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      client.end()
      ws.terminate()
      reject(error)
    }
    client.once('error', fail)
    client.once('ready', () => {
      client.forwardOut(
        '127.0.0.1',
        0,
        '127.0.0.1',
        options.port,
        (error, channel) => {
          if (error != null) return fail(error)
          settled = true
          // The tunnel ends with its channel.
          channel.once('close', () => {
            client.end()
            ws.close()
          })
          resolve(channel)
        },
      )
    })
    client.connect({
      sock: stream,
      username: access.ssh.username,
      privateKey: options.privateKey,
      readyTimeout: options.timeoutMs ?? 15_000,
      // Only the host key NoMac reported for this session and generation.
      hostVerifier: (key: Buffer): boolean => key.equals(hostKey),
    })
  })
}
