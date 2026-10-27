import {
  createHmac,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto'
import { hostname } from 'node:os'
import { fingerprint, type Identity } from '../node/identity.js'
import { version } from '../version.js'
import { PROTOCOL_MAJOR, type Role } from './link.js'
import type { Frame, Wire } from './wire.js'

export const PROTOCOL = 'mason-link'
export const EXPORTER_LABEL = 'EXPORTER-mason-link'

export interface Hello {
  kind: 'hello'
  protocol: string
  major: number
  version: string
  role: Role
  fingerprint: string
  publicKey: string
  nonce: string
  hostname: string
}
interface Proof {
  kind: 'proof'
  signature: string
  /** HMAC of the master's transcript under the node's pairing secret. */
  pairing?: string
}

export interface PeerInfo {
  role: Role
  fingerprint: string
  publicKey: KeyObject
  version: string
  hostname: string
}

export class HandshakeRefused extends Error {}

/** What a side signs: its own nonce first, bound to this TLS session. */
export function transcript(
  signer: { role: Role; nonce: string; fingerprint: string },
  other: { nonce: string; fingerprint: string },
  exporter: Buffer,
): Buffer {
  return Buffer.from(
    [
      'mason-link-v1',
      signer.role,
      signer.nonce,
      other.nonce,
      signer.fingerprint,
      other.fingerprint,
      exporter.toString('base64'),
    ].join('|'),
  )
}

export const pairingMac = (secret: string, masterTranscript: Buffer): string =>
  createHmac('sha256', secret)
    .update('pair|')
    .update(masterTranscript)
    .digest('base64')

const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface HandshakeOptions {
  identity: Identity
  role: Role
  /** Keying material exported from the TLS session both sides share. */
  exporter: Buffer
  /** Checks the peer's hello before any proof is sent. */
  acceptHello(hello: Hello, publicKey: KeyObject): void
  /** The master's pairing secret for the node, when pairing. */
  pairingSecret?: string
  /**
   * On a node: checks the master's pairing MAC (or its absence), given the
   * master's transcript.
   */
  checkPairing?(mac: string | undefined, masterTranscript: Buffer): void
  timeoutMs?: number
  /**
   * The dialing side waits for the other side's `ready`, sent only once that
   * side has accepted the dialer's proof (and pairing MAC).
   */
  dialer: boolean
}

/**
 * Exchanges hellos and signatures over a fresh wire. Each side signs a
 * transcript with its nonce, the peer's nonce, both fingerprints and the
 * TLS exporter, so a handshake relayed into another session fails.
 */
export async function handshake(
  wire: Wire,
  options: HandshakeOptions,
): Promise<PeerInfo> {
  const nonce = randomBytes(32).toString('base64')
  const own: Hello = {
    kind: 'hello',
    protocol: PROTOCOL,
    major: PROTOCOL_MAJOR,
    version,
    role: options.role,
    fingerprint: options.identity.fingerprint,
    publicKey: options.identity.publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64'),
    nonce,
    hostname: hostname(),
  }
  return await new Promise<PeerInfo>((resolve, reject) => {
    let peer: { hello: Hello; publicKey: KeyObject } | undefined
    let verified: PeerInfo | undefined
    let done = false
    const finish = (error: Error | undefined, info?: PeerInfo): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      wire.setReceiver(undefined)
      wire.offClose(onClose)
      if (error != null) reject(error)
      else resolve(info!)
    }
    const timer = setTimeout(
      () => finish(new HandshakeRefused('Handshake timed out')),
      options.timeoutMs ?? 10000,
    )
    timer.unref()
    const onClose = (): void =>
      finish(new HandshakeRefused('Link closed during handshake'))
    const onMessage = (data: Frame): void => {
      try {
        if (typeof data !== 'string' || data.length > 64 * 1024)
          throw new HandshakeRefused('Invalid handshake')
        const message = JSON.parse(data) as Hello | Proof
        if (peer == null) {
          if (message.kind !== 'hello')
            throw new HandshakeRefused('Expected hello')
          const hello = message
          if (
            hello.protocol !== PROTOCOL ||
            hello.major !== PROTOCOL_MAJOR ||
            typeof hello.nonce !== 'string' ||
            Buffer.from(hello.nonce, 'base64').length !== 32 ||
            typeof hello.version !== 'string' ||
            typeof hello.hostname !== 'string' ||
            !['master', 'worker', 'host'].includes(hello.role) ||
            (options.role === 'master') === (hello.role === 'master')
          )
            throw new HandshakeRefused('Incompatible peer')
          const publicKey = createPublicKey({
            key: Buffer.from(hello.publicKey, 'base64'),
            format: 'der',
            type: 'spki',
          })
          if (
            publicKey.asymmetricKeyType !== 'ml-dsa-65' ||
            fingerprint(publicKey) !== hello.fingerprint
          )
            throw new HandshakeRefused('Invalid peer key')
          options.acceptHello(hello, publicKey)
          peer = { hello, publicKey }
          const mine = transcript(own, hello, options.exporter)
          const proof: Proof = {
            kind: 'proof',
            signature: sign(null, mine, options.identity.privateKey).toString(
              'base64',
            ),
            ...(options.pairingSecret == null
              ? {}
              : { pairing: pairingMac(options.pairingSecret, mine) }),
          }
          wire.send(JSON.stringify(proof))
          return
        }
        if (verified != null) {
          if ((message as { kind?: string }).kind !== 'ready')
            throw new HandshakeRefused('Expected ready')
          finish(undefined, verified)
          return
        }
        if (message.kind !== 'proof' || typeof message.signature !== 'string')
          throw new HandshakeRefused('Expected proof')
        const theirs = transcript(peer.hello, own, options.exporter)
        if (
          !verify(
            null,
            theirs,
            peer.publicKey,
            Buffer.from(message.signature, 'base64'),
          )
        )
          throw new HandshakeRefused('Invalid signature')
        if (options.checkPairing != null) {
          if (message.pairing != null && typeof message.pairing !== 'string')
            throw new HandshakeRefused('Invalid pairing proof')
          options.checkPairing(message.pairing, theirs)
        }
        const info: PeerInfo = {
          role: peer.hello.role,
          fingerprint: peer.hello.fingerprint,
          publicKey: peer.publicKey,
          version: peer.hello.version,
          hostname: peer.hello.hostname,
        }
        if (options.dialer) verified = info
        else {
          wire.send(JSON.stringify({ kind: 'ready' }))
          finish(undefined, info)
        }
      } catch (error) {
        finish(
          error instanceof HandshakeRefused
            ? error
            : new HandshakeRefused('Invalid handshake'),
        )
      }
    }
    wire.onClose(onClose)
    wire.send(JSON.stringify(own))
    wire.setReceiver(onMessage)
  })
}

/** Verifies a pairing MAC in constant time. */
export function checkMac(
  secret: string,
  mac: string | undefined,
  masterTranscript: Buffer,
): boolean {
  return mac != null && equal(mac, pairingMac(secret, masterTranscript))
}
