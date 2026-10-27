import { isIP } from 'node:net'
import { connect } from 'node:tls'
import { Agent, fetch, type RequestInit, type Response } from 'undici'
import { publicKeyPin } from './certificate.js'

const agents = new Map<string, Agent>()

/** Validates a curl-style public-key pin, `sha256//<base64>`. */
export function asPin(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^sha256\/\/[A-Za-z0-9+/]{43}=$/.test(value)
  )
    throw new Error('Expected a pin like sha256//<base64 SHA-256>')
  return value
}

/**
 * An agent whose connections are trusted by public-key pin instead of a
 * certificate chain. The TLS socket is opened here and its peer key compared
 * with the pin before any request byte is written.
 */
export function pinnedAgent(pin: string): Agent {
  pin = asPin(pin)
  let agent = agents.get(pin)
  if (agent != null) return agent
  agent = new Agent({
    connect: (options, callback): void => {
      if (options.protocol !== 'https:') {
        callback(new Error('Pinned connections need HTTPS'), null)
        return
      }
      let settled = false
      const done = (error: Error | null): void => {
        if (settled) return
        settled = true
        if (error == null) callback(null, socket)
        else {
          socket.destroy()
          callback(error, null)
        }
      }
      const socket = connect({
        host: options.hostname,
        port: Number(options.port || 443),
        ...(isIP(options.hostname) === 0
          ? { servername: options.hostname }
          : {}),
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      })
      socket.once('secureConnect', () => {
        const raw = socket.getPeerCertificate(false)?.raw
        done(
          raw != null && publicKeyPin(raw) === pin
            ? null
            : new Error('Server certificate does not match the pin'),
        )
      })
      socket.once('error', (error) => done(error))
    },
  })
  agents.set(pin, agent)
  return agent
}

/** `fetch` that trusts the server by `pin` when one is given. */
export async function pinnedFetch(
  url: string | URL,
  init: RequestInit = {},
  pin?: string,
): Promise<Response> {
  return await fetch(
    url,
    pin == null ? init : { ...init, dispatcher: pinnedAgent(pin) },
  )
}
