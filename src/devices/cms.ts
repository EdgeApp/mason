import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

/** Verify CMS signatures against a configured Apple-only trust store. */
export async function verifyCms(
  bytes: Buffer,
  trust: string,
  device = false,
  openssl = 'openssl',
): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > 1024 * 1024)
    throw new Error('Invalid signed data size')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mason-cms-'))
  const input = path.join(dir, 'input.der'),
    output = path.join(dir, 'output.plist'),
    signer = path.join(dir, 'signer.pem')
  try {
    writeFileSync(input, bytes, { mode: 0o600 })
    await new Promise<void>((resolve, reject) =>
      execFile(
        openssl,
        [
          'cms',
          '-verify',
          '-binary',
          '-inform',
          'DER',
          '-in',
          input,
          '-out',
          output,
          '-signer',
          signer,
          '-CAfile',
          trust,
          '-no-CApath',
          '-purpose',
          'any',
          // Apple's built-in device identities can outlive their certificate dates.
          ...(device ? ['-no_check_time'] : []),
        ],
        { timeout: 10000, maxBuffer: 1024 * 1024 },
        (error) =>
          error
            ? reject(
                new Error('Device or profile signature could not be verified'),
              )
            : resolve(),
      ),
    )
    if (device) {
      const pem = readFileSync(signer, 'utf8')
      if (
        (pem.match(/BEGIN CERTIFICATE/g) ?? []).length !== 1 ||
        !/CN=Apple[^\n]*Device CA(?:\s|$)/.test(new X509Certificate(pem).issuer)
      )
        throw new Error('Expected an Apple device identity')
    }
    return readFileSync(output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
