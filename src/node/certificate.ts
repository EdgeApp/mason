import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

// DER encoding of a self-signed ECDSA P-256 X.509 v3 certificate. Nodes pin
// certificates by hash, so the certificate only has to be well formed.
function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  for (let n = size; n > 0; n >>= 8) bytes.unshift(n & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}
const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts)
function oid(value: string): Buffer {
  const [first, second, ...rest] = value.split('.').map(Number)
  const bytes = [first! * 40 + second!]
  for (const arc of rest) {
    const chunk = [arc & 0x7f]
    for (let n = arc >> 7; n > 0; n >>= 7) chunk.unshift(0x80 | (n & 0x7f))
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(iso.slice(2), 'ascii'))
    : tlv(0x18, Buffer.from(iso, 'ascii'))
}
function name(common: string): Buffer {
  return sequence(
    tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(common, 'utf8')))),
  )
}
function ipBytes(address: string): Buffer {
  if (isIPv4(address)) return Buffer.from(address.split('.').map(Number))
  const [head, tail] = address.split('::')
  const words = (part: string | undefined): number[] =>
    part ? part.split(':').map((word) => parseInt(word, 16)) : []
  const left = words(head)
  const right = words(tail)
  const middle =
    tail == null ? [] : new Array(8 - left.length - right.length).fill(0)
  const all = [...left, ...middle, ...right]
  return Buffer.from(all.flatMap((word) => [word >> 8, word & 0xff]))
}

export interface NodeCertificate {
  /** PEM certificate. */
  cert: string
  /** PEM PKCS #8 private key. */
  key: string
}

/**
 * Creates a self-signed ECDSA P-256 certificate valid for `years` years,
 * naming the given DNS names and IP addresses.
 */
export function createCertificate(
  names: string[],
  now = new Date(),
  years = 20,
): NodeCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  })
  const ecdsaSha256 = sequence(oid('1.2.840.10045.4.3.2'))
  const serial = randomBytes(16)
  serial.writeUInt8((serial.readUInt8(0) & 0x7f) | 0x01, 0)
  const until = new Date(now)
  until.setUTCFullYear(until.getUTCFullYear() + years)
  const alternatives = names.map((value) =>
    isIPv4(value) || isIPv6(value)
      ? tlv(0x87, ipBytes(value))
      : tlv(0x82, Buffer.from(value, 'ascii')),
  )
  const extensions =
    alternatives.length === 0
      ? []
      : [
          tlv(
            0xa3,
            sequence(
              sequence(oid('2.5.29.17'), tlv(0x04, sequence(...alternatives))),
            ),
          ),
        ]
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ecdsaSha256,
    name('mason-node'),
    sequence(time(now), time(until)),
    name('mason-node'),
    publicKey.export({ type: 'spki', format: 'der' }),
    ...extensions,
  )
  const signature = sign('sha256', tbs, privateKey)
  const der = sequence(tbs, ecdsaSha256, tlv(0x03, Buffer.from([0]), signature))
  // 64 characters a line, with no blank line when the body fills its last line exactly.
  const body = der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** base64url SHA-256 of the certificate's DER encoding. */
export function certificateHash(cert: string | Buffer): string {
  const raw = Buffer.isBuffer(cert) ? cert : new X509Certificate(cert).raw
  return createHash('sha256').update(raw).digest('base64url')
}

/** curl-style public-key pin: `sha256//<base64 SHA-256 of the SPKI>`. */
export function publicKeyPin(cert: string | Buffer | KeyObject): string {
  const key =
    typeof cert === 'string' || Buffer.isBuffer(cert)
      ? new X509Certificate(cert).publicKey
      : cert
  return (
    'sha256//' +
    createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('base64')
  )
}
