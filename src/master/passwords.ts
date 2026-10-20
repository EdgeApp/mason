import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { argon2id, hash } from 'argon2'
import {
  asArgonParameters,
  asClientHash,
  asNewPasswordParameters,
  clientParameters,
  type ArgonParameters,
} from '../auth/passwordProtocol.js'

/** A stored password: the client parameters and the server's hash of the client hash. */
export interface PasswordRecord {
  schema: 1
  client: ArgonParameters
  server: ArgonParameters
  hash: string
}
export const passwordSalt = (): string => randomBytes(16).toString('hex')

export function readPasswordRecord(
  stored: string | null | undefined,
): PasswordRecord | null {
  try {
    const raw = JSON.parse(stored ?? '') as PasswordRecord
    if (raw.schema !== 1) return null
    const client = asArgonParameters(raw.client)
    const server = asArgonParameters(raw.server, true)
    if (
      server.memoryKiB !== client.memoryKiB ||
      server.parallelism !== client.parallelism ||
      server.iterations !== client.iterations * 4 ||
      server.salt === client.salt
    )
      return null
    return { schema: 1, client, server, hash: asClientHash(raw.hash) }
  } catch {
    return null
  }
}

/**
 * Two native jobs at a time (at most 128 MiB of Argon2 memory), one per
 * account; overload fails at once instead of queuing password-equivalent input.
 */
export class PasswordHasher {
  private readonly active = new Set<string>()
  constructor(private readonly derive = nativeArgon) {}
  async run(
    input: Uint8Array,
    parameters: ArgonParameters,
    accountKey = parameters.salt,
  ): Promise<string> {
    if (this.active.size >= 2 || this.active.has(accountKey))
      throw new Error('Password verification is busy. Please try again')
    this.active.add(accountKey)
    try {
      return await this.derive(input, parameters)
    } finally {
      this.active.delete(accountKey)
    }
  }
}
export async function nativeArgon(
  input: Uint8Array,
  p: ArgonParameters,
): Promise<string> {
  const result = await hash(Buffer.from(input), {
    type: argon2id,
    version: p.version,
    memoryCost: p.memoryKiB,
    timeCost: p.iterations,
    parallelism: p.parallelism,
    hashLength: p.hashLength,
    salt: Buffer.from(p.salt, 'hex'),
    raw: true,
  })
  return result.toString('hex')
}
const hasher = new PasswordHasher()

/** Hashes a client hash again at four times the iterations, with its own salt. */
export async function createPasswordRecord(
  clientHash: string,
  parameters: unknown,
  accountKey?: string,
): Promise<string> {
  const client = asNewPasswordParameters(parameters)
  const input = Buffer.from(asClientHash(clientHash), 'hex')
  const server = {
    ...client,
    iterations: client.iterations * 4,
    salt: passwordSalt(),
  }
  try {
    const digest = await hasher.run(input, server, accountKey ?? client.salt)
    return JSON.stringify({
      schema: 1,
      client,
      server,
      hash: digest,
    } satisfies PasswordRecord)
  } finally {
    input.fill(0)
  }
}

export async function passwordMatches(
  clientHash: string,
  stored: string | null | undefined,
  accountKey?: string,
): Promise<boolean> {
  const record = readPasswordRecord(stored)
  if (record == null) return false
  const input = Buffer.from(asClientHash(clientHash), 'hex')
  try {
    const actual = await hasher.run(
      input,
      record.server,
      accountKey ?? record.client.salt,
    )
    return timingSafeEqual(
      Buffer.from(actual, 'hex'),
      Buffer.from(record.hash, 'hex'),
    )
  } finally {
    input.fill(0)
  }
}

/** Parameters for an unknown username, the same for every request. */
export function decoyParameters(
  username: string,
  secret: string,
): ArgonParameters {
  const salt = createHmac('sha256', secret)
    .update(`password-parameters:${username}`)
    .digest('hex')
    .slice(0, 32)
  return clientParameters(salt)
}
