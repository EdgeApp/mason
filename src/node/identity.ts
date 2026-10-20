import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { asObject, asString } from 'cleaners'
import {
  certificateHash,
  createCertificate,
  publicKeyPin,
} from './certificate.js'
import { readPrivate, writePrivate } from './dataDir.js'

export const PAIRING_PREFIX = 'mason1:'

/** `mldsa65:<base64url SHA-256 of the SPKI>`. */
export function fingerprint(publicKey: KeyObject): string {
  return (
    'mldsa65:' +
    createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64url')
  )
}

export interface Identity {
  dir: string
  privateKey: KeyObject
  publicKey: KeyObject
  fingerprint: string
  /** PEM TLS certificate and key, used by the link and web listeners. */
  cert: string
  key: string
  /** base64url SHA-256 of the certificate DER. */
  certificateHash: string
  /** Web listener public-key pin, `sha256//…`. */
  pin: string
}

const files = {
  privateKey: 'identity.key',
  publicKey: 'identity.pub',
  cert: 'tls.crt',
  key: 'tls.key',
  pairing: 'pairing.json',
}

/**
 * Loads the node's ML-DSA-65 identity and TLS certificate from the data
 * directory, creating them on first start or when `renew` is set.
 */
export function loadIdentity(
  dir: string,
  options: { renew?: boolean; names?: string[] } = {},
): Identity {
  const file = (name: string): string => path.join(dir, name)
  if (options.renew || !existsSync(file(files.privateKey))) {
    const pair = generateKeyPairSync('ml-dsa-65')
    const certificate = createCertificate(
      options.names ?? ['localhost', '127.0.0.1', '::1', hostname()],
    )
    writePrivate(
      file(files.privateKey),
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    )
    writePrivate(
      file(files.publicKey),
      pair.publicKey.export({ type: 'spki', format: 'pem' }),
    )
    writePrivate(file(files.cert), certificate.cert)
    writePrivate(file(files.key), certificate.key)
    rmSync(file(files.pairing), { force: true })
  }
  const privateKey = createPrivateKey(readPrivate(file(files.privateKey)))
  const publicKey = createPublicKey(readPrivate(file(files.publicKey)))
  if (
    privateKey.asymmetricKeyType !== 'ml-dsa-65' ||
    !createPublicKey(privateKey)
      .export({ type: 'spki', format: 'der' })
      .equals(publicKey.export({ type: 'spki', format: 'der' }))
  )
    throw new Error('Node identity files do not match')
  const cert = readPrivate(file(files.cert))
  const key = readPrivate(file(files.key))
  if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key)))
    throw new Error('Node certificate does not match its key')
  return {
    dir,
    privateKey,
    publicKey,
    fingerprint: fingerprint(publicKey),
    cert,
    key,
    certificateHash: certificateHash(cert),
    pin: publicKeyPin(cert),
  }
}

const asPairing = asObject({ nonce: asString, secretHash: asString })

/**
 * The secret is derived from the node's private key and a stored nonce, so
 * the node prints the same pairing key on every start while only the nonce
 * and the secret's hash are written down.
 */
function secretFor(identity: Identity, nonce: string): string {
  return createHmac(
    'sha256',
    identity.privateKey.export({ type: 'pkcs8', format: 'der' }),
  )
    .update('mason-pairing-v1:' + nonce)
    .digest('base64url')
}
const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex')

/** The pairing key a worker or host prints until it is paired. */
export function pairingKey(identity: Identity): string {
  const file = path.join(identity.dir, files.pairing)
  let nonce: string
  if (existsSync(file)) nonce = asPairing(JSON.parse(readPrivate(file))).nonce
  else {
    nonce = randomBytes(16).toString('base64url')
    writePrivate(
      file,
      JSON.stringify({
        nonce,
        secretHash: hashSecret(secretFor(identity, nonce)),
      }),
    )
  }
  return `${PAIRING_PREFIX}${identity.fingerprint}.${identity.certificateHash}.${secretFor(identity, nonce)}`
}

/** Checks a pairing secret against the stored hash. */
export function checkPairingSecret(
  identity: Identity,
  secret: string,
): boolean {
  const file = path.join(identity.dir, files.pairing)
  if (!existsSync(file)) return false
  const stored = Buffer.from(
    asPairing(JSON.parse(readPrivate(file))).secretHash,
    'hex',
  )
  const offered = Buffer.from(hashSecret(secret), 'hex')
  return stored.length === offered.length && timingSafeEqual(stored, offered)
}

/** Spends the pairing key once the node is paired. */
export function spendPairingKey(identity: Identity): void {
  rmSync(path.join(identity.dir, files.pairing), { force: true })
}

export interface ParsedPairingKey {
  fingerprint: string
  certificateHash: string
  secret: string
}

export function parsePairingKey(value: string): ParsedPairingKey {
  const match =
    /^mason1:(mldsa65:[A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(
      value.trim(),
    )
  if (match == null) throw new Error('Invalid pairing key')
  return {
    fingerprint: match[1]!,
    certificateHash: match[2]!,
    secret: match[3]!,
  }
}

/**
 * The master's six-digit setup code, new on every start while it is
 * unconfigured, written owner-only to the data directory.
 */
export function newSetupCode(dir: string): string {
  const code = String(randomInt(0, 1000000)).padStart(6, '0')
  writePrivate(path.join(dir, 'setup-code'), code + '\n')
  return code
}
export function clearSetupCode(dir: string): void {
  rmSync(path.join(dir, 'setup-code'), { force: true })
}
