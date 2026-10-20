import { asObject, asOptional, asString } from 'cleaners'

export interface ArgonParameters {
  algorithm: 'argon2id'
  version: 19
  memoryKiB: number
  iterations: number
  parallelism: number
  hashLength: 32
  salt: string
}
export type ClientPasswordCosts = Pick<
  ArgonParameters,
  'memoryKiB' | 'iterations' | 'parallelism'
>
export type PasswordKdf = (
  password: string,
  parameters: ArgonParameters,
) => Promise<string>

/** Client policy is adjustable; saved account parameters always take precedence at login. */
export const DEFAULT_PASSWORD_COSTS: ClientPasswordCosts = {
  memoryKiB: 32768,
  iterations: 6,
  parallelism: 4,
}

export const MAX_CLIENT_PASSWORD_ITERATIONS = 1024

export function asHex(raw: unknown, bytes: number): string {
  if (
    typeof raw !== 'string' ||
    !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(raw)
  )
    throw new TypeError(`Expected ${bytes} bytes encoded as lowercase hex`)
  return raw
}
export const asClientHash = (raw: unknown): string => asHex(raw, 32)
export function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (value) => parseInt(value, 16))
}
export function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(
    '',
  )
}

export function asArgonParameters(
  raw: unknown,
  server = false,
): ArgonParameters {
  if (raw == null || typeof raw !== 'object')
    throw new TypeError('Missing password parameters')
  const p = raw as ArgonParameters
  if (p.algorithm !== 'argon2id' || p.version !== 19 || p.hashLength !== 32)
    throw new TypeError('Unsupported password algorithm')
  if (
    !Number.isInteger(p.parallelism) ||
    p.parallelism < 1 ||
    p.parallelism > 4 ||
    !Number.isInteger(p.memoryKiB) ||
    p.memoryKiB < 19456 ||
    p.memoryKiB > 65536 ||
    p.memoryKiB % (4 * p.parallelism) !== 0 ||
    !Number.isInteger(p.iterations) ||
    p.iterations < 2 ||
    p.iterations >
      (server
        ? MAX_CLIENT_PASSWORD_ITERATIONS * 4
        : MAX_CLIENT_PASSWORD_ITERATIONS)
  )
    throw new TypeError('Password parameters are outside the supported limits')
  return {
    algorithm: 'argon2id',
    version: 19,
    memoryKiB: p.memoryKiB,
    iterations: p.iterations,
    parallelism: p.parallelism,
    hashLength: 32,
    salt: asHex(p.salt, 16),
  }
}
/** Stronger policy for new writes; saved credentials retain their original costs. */
export function asNewPasswordParameters(raw: unknown): ArgonParameters {
  const p = asArgonParameters(raw)
  if (
    p.memoryKiB < DEFAULT_PASSWORD_COSTS.memoryKiB ||
    p.iterations < DEFAULT_PASSWORD_COSTS.iterations ||
    p.parallelism < DEFAULT_PASSWORD_COSTS.parallelism
  )
    throw new TypeError(
      'New passwords require at least 32 MiB, 6 iterations and 4 lanes',
    )
  return p
}
export function clientParameters(
  salt: string,
  costs = DEFAULT_PASSWORD_COSTS,
): ArgonParameters {
  return asArgonParameters({
    ...costs,
    algorithm: 'argon2id',
    version: 19,
    hashLength: 32,
    salt,
  })
}

/** Identical UTF-8 on Hermes, browsers and Node; lone surrogates become U+FFFD. */
export function passwordBytes(password: string): Uint8Array {
  const bytes: number[] = []
  for (const character of password) {
    let c = character.codePointAt(0)!
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000)
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      )
  }
  return Uint8Array.from(bytes)
}
export function newPasswordRequirements(password: string): {
  length: boolean
  uppercase: boolean
  lowercase: boolean
  number: boolean
  long: boolean
  tooLong: boolean
  valid: boolean
} {
  const count = Array.from(password).length
  const long = count > 16
  const length = count >= 8
  const uppercase = /\p{Lu}/u.test(password)
  const lowercase = /\p{Ll}/u.test(password)
  const number = /\p{Nd}/u.test(password)
  const tooLong = passwordBytes(password).length > 1024
  return {
    length,
    uppercase,
    lowercase,
    number,
    long,
    tooLong,
    valid: length && !tooLong && (long || (uppercase && lowercase && number)),
  }
}
export function checkNewPassword(password: string): void {
  const requirements = newPasswordRequirements(password)
  if (requirements.tooLong)
    throw new Error('Use at most 1024 UTF-8 bytes for your password')
  if (!requirements.valid)
    throw new Error(
      'Use at least 8 characters with uppercase, lowercase and a number, or use 17 or more characters',
    )
}
export function rejectRawPassword(raw: unknown): void {
  if (
    raw != null &&
    typeof raw === 'object' &&
    ('password' in raw || 'currentPassword' in raw)
  )
    throw new TypeError(
      'This API requires a client password hash. Update the app or use an email code',
    )
}
export const asResetAuthorization = asObject({
  requestId: asString,
  code: asString,
})
export type ResetAuthorization = ReturnType<typeof asResetAuthorization>
const cleanUpdate = asObject({
  clientHash: asClientHash,
  clientParameters: asNewPasswordParameters,
  currentClientHash: asOptional(asClientHash),
  reset: asOptional(asResetAuthorization),
})
export function asPasswordUpdate(raw: unknown): ReturnType<typeof cleanUpdate> {
  rejectRawPassword(raw)
  return cleanUpdate(raw)
}
