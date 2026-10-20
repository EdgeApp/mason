import { createPublicKey } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import type { Server } from 'node:https'
import path from 'node:path'
import { asArray, asObject, asString } from 'cleaners'
import type { WebSocketServer } from 'ws'
import { readPrivate, writePrivate } from '../node/dataDir.js'
import {
  pairingKey,
  parsePairingKey,
  spendPairingKey,
  type Identity,
} from '../node/identity.js'
import { checkMac, handshake, HandshakeRefused } from './handshake.js'
import { CLOSE, Link, type MethodTable } from './link.js'
import { acceptWires } from './network.js'

const asMasterFile = asObject({ fingerprint: asString, publicKey: asString })
const asAssigned = asObject({
  name: asString,
  type: asString,
  labels: asArray(asString),
})
export type Assignment = ReturnType<typeof asAssigned>

/** A worker's or host's pairing with its master, kept in its data directory. */
export class Pairing {
  constructor(
    readonly dir: string,
    readonly identity: Identity,
  ) {}
  private file(name: string): string {
    return path.join(this.dir, name)
  }
  master(): { fingerprint: string; publicKey: string } | undefined {
    return existsSync(this.file('master.json'))
      ? asMasterFile(JSON.parse(readPrivate(this.file('master.json'))))
      : undefined
  }
  /** Set when the master removed this node; pairing again needs --new-key. */
  removed(): boolean {
    return existsSync(this.file('removed'))
  }
  /** The pairing key to print, or undefined when paired or removed. */
  key(): string | undefined {
    return this.master() != null || this.removed()
      ? undefined
      : pairingKey(this.identity)
  }
  assignment(): Assignment | undefined {
    return existsSync(this.file('assigned.json'))
      ? asAssigned(JSON.parse(readPrivate(this.file('assigned.json'))))
      : undefined
  }
  pair(fingerprint: string, publicKey: string): void {
    writePrivate(
      this.file('master.json'),
      JSON.stringify({ fingerprint, publicKey }) + '\n',
    )
    spendPairingKey(this.identity)
  }
  assign(value: unknown): Assignment {
    const assigned = asAssigned(value)
    writePrivate(this.file('assigned.json'), JSON.stringify(assigned) + '\n')
    return assigned
  }
  forget(): void {
    rmSync(this.file('master.json'), { force: true })
    rmSync(this.file('assigned.json'), { force: true })
    writePrivate(
      this.file('removed'),
      'Removed by its master; start with --new-key to pair again.\n',
    )
  }
  /** --new-key: a new identity may pair again. */
  reset(): void {
    rmSync(this.file('master.json'), { force: true })
    rmSync(this.file('assigned.json'), { force: true })
    rmSync(this.file('removed'), { force: true })
  }
}

export interface NodeLinkOptions {
  pairing: Pairing
  role: 'worker' | 'host'
  /** Methods this node accepts from its master. */
  methods: MethodTable
  heartbeatMs?: number
  handshakeTimeoutMs?: number
  onLink?(link: Link): void
  onPaired?(fingerprint: string): void
  onRemoved?(): void
}

export interface NodeLinks {
  current(): Link | undefined
  close(): void
  wss: WebSocketServer
}

/**
 * Serves the master's links on a node's link listener. An unpaired node
 * accepts one master that proves the pairing secret; a paired node accepts
 * only that master. A newer link replaces the current one.
 */
export function serveNodeLinks(
  server: Server,
  options: NodeLinkOptions,
): NodeLinks {
  const { pairing } = options
  let current: Link | undefined
  const wss = acceptWires(server, (wire, exporter) => {
    if (pairing.removed()) {
      wire.close(CLOSE.refused)
      return
    }
    const paired = pairing.master()
    let pairingSecret: string | undefined
    void handshake(wire, {
      identity: pairing.identity,
      role: options.role,
      exporter,
      dialer: false,
      timeoutMs: options.handshakeTimeoutMs ?? 10000,
      acceptHello(hello, publicKey) {
        if (hello.role !== 'master')
          throw new HandshakeRefused('Only a master may link')
        if (paired != null) {
          if (
            hello.fingerprint !== paired.fingerprint ||
            !createPublicKey({
              key: Buffer.from(paired.publicKey, 'base64'),
              format: 'der',
              type: 'spki',
            })
              .export({ type: 'spki', format: 'der' })
              .equals(publicKey.export({ type: 'spki', format: 'der' }))
          )
            throw new HandshakeRefused('Not this node’s master')
          return
        }
        const key = pairing.key()
        if (key == null) throw new HandshakeRefused('Not pairable')
        pairingSecret = parsePairingKey(key).secret
      },
      checkPairing(mac, masterTranscript) {
        if (paired != null) return
        if (
          pairingSecret == null ||
          !checkMac(pairingSecret, mac, masterTranscript)
        )
          throw new HandshakeRefused('Pairing refused')
      },
    }).then(
      (peer) => {
        if (paired == null) {
          // Two pairings racing on one key: only the first one stands.
          if (pairing.master() != null) {
            wire.close(CLOSE.refused)
            return
          }
          pairing.pair(
            peer.fingerprint,
            peer.publicKey
              .export({ type: 'spki', format: 'der' })
              .toString('base64'),
          )
          options.onPaired?.(peer.fingerprint)
        }
        const link = new Link(wire, {
          localRole: options.role,
          peerRole: 'master',
          dialer: false,
          heartbeatMs: options.heartbeatMs ?? 15000,
          peer: {
            fingerprint: peer.fingerprint,
            version: peer.version,
            hostname: peer.hostname,
          },
          methods: {
            ...options.methods,
            requests: {
              ...options.methods.requests,
              'node.configure': (params): Assignment => pairing.assign(params),
            },
            events: {
              ...options.methods.events,
              'node.removed': (_params, link): void => {
                pairing.forget()
                link.close(CLOSE.removed)
                options.onRemoved?.()
              },
            },
          },
        })
        const previous = current
        current = link
        previous?.close(CLOSE.replaced)
        link.on('close', () => {
          if (current === link) current = undefined
        })
        options.onLink?.(link)
      },
      () => wire.close(CLOSE.refused),
    )
  })
  return {
    current: () => current,
    close: (): void => {
      current?.close(CLOSE.normal)
      wss.close()
    },
    wss,
  }
}
