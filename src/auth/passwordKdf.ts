import { argon2id } from 'hash-wasm'
import {
  asArgonParameters,
  bytesHex,
  hexBytes,
  passwordBytes,
  type ArgonParameters,
} from './passwordProtocol.js'

/**
 * The client half of Mason's password protocol: an Argon2id hash of
 * the password's UTF-8 bytes, computed with hash-wasm as the browser does.
 */
export async function clientPasswordHash(
  password: string,
  parameters: ArgonParameters,
): Promise<string> {
  const p = asArgonParameters(parameters)
  if (password.length > 1024) throw new Error('Password is too long')
  const bytes = passwordBytes(password)
  if (bytes.length > 1024) throw new Error('Password is too long')
  try {
    const result = await argon2id({
      password: bytes,
      salt: hexBytes(p.salt),
      memorySize: p.memoryKiB,
      iterations: p.iterations,
      parallelism: p.parallelism,
      hashLength: p.hashLength,
      outputType: 'binary',
    })
    const encoded = bytesHex(result)
    result.fill(0)
    return encoded
  } finally {
    bytes.fill(0)
  }
}
