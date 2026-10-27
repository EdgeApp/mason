import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isIP } from 'node:net'
import type { RequestListener } from 'node:http'
import type { Identity } from './identity.js'
import { certificateHash, publicKeyPin } from './certificate.js'

export interface WebOptions {
  port: number
  listen?: string
  webCert?: string
  webKey?: string
  webPlain?: boolean
}

export function isLoopback(address: string): boolean {
  if (address === 'localhost') return true
  if (isIP(address) === 4) return address.startsWith('127.')
  return address === '::1'
}

export interface WebCertificate {
  cert: string
  key: string
  /** base64url SHA-256 of the certificate DER. */
  certificateHash: string
  /** `sha256//…` public-key pin. */
  pin: string
}

/**
 * The certificate a web listener serves: `--web-cert`/`--web-key` when
 * given, otherwise the node's own self-signed certificate. `undefined` for a
 * `--web-plain` listener.
 */
export function webCertificate(
  identity: Identity,
  options: WebOptions,
): WebCertificate | undefined {
  if (options.webPlain) {
    if (options.listen == null || !isLoopback(options.listen))
      throw new Error('--web-plain needs a loopback --listen address')
    if (options.webCert != null || options.webKey != null)
      throw new Error('--web-plain cannot be combined with --web-cert')
    return undefined
  }
  if ((options.webCert == null) !== (options.webKey == null))
    throw new Error('--web-cert and --web-key go together')
  const cert =
    options.webCert == null
      ? identity.cert
      : readFileSync(options.webCert, 'utf8')
  const key =
    options.webKey == null ? identity.key : readFileSync(options.webKey, 'utf8')
  return {
    cert,
    key,
    certificateHash: certificateHash(cert),
    pin: publicKeyPin(cert),
  }
}

/** Starts an HTTPS (or, behind a local terminator, plain HTTP) web listener. */
export async function listenWeb(
  handler: RequestListener,
  certificate: WebCertificate | undefined,
  options: WebOptions,
): Promise<Server> {
  const server =
    certificate == null
      ? createHttpServer(handler)
      : createHttpsServer(
          {
            cert: certificate.cert,
            key: certificate.key,
            minVersion: 'TLSv1.2',
          },
          handler,
        )
  // Large package uploads outlast Node's default request deadline.
  server.requestTimeout = 90 * 60000
  server.headersTimeout = 60000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.listen, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server
}
