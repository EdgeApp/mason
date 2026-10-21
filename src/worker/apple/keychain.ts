import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { appleIntermediates } from './intermediates.js'

/** Runs `security` (or `openssl`) with arguments and secrets only in its environment. */
export type Command = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<string>
export const runCommand: Command = async (file, args, options = {}) =>
  await new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error != null)
          reject(
            new Error(
              `${path.basename(file)} ${args[0]} failed: ${stderr.trim().split('\n').pop() ?? error.message}`,
            ),
          )
        else resolve(stdout)
      },
    )
  })

const SECURITY = '/usr/bin/security'
/** macOS's own LibreSSL, whose PKCS#12 files `security import` reads. */
const OPENSSL = '/usr/bin/openssl'

/** The keychain paths in `security list-keychains` output. */
export function parseKeychains(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(/^"(.*)"$/, '$1'))
}

// One search-list change at a time in this process; each re-reads the list just before writing.
let queue: Promise<unknown> = Promise.resolve()
async function locked<T>(body: () => Promise<T>): Promise<T> {
  const next = queue.then(body, body)
  queue = next.catch(() => undefined)
  return await next
}

/**
 * Adds a keychain to the end of the user's search list. The list is read
 * immediately before it is written and written back with only this
 * keychain added, so another program's concurrent change survives; the
 * default keychain is never touched.
 */
export async function addToSearchList(
  keychain: string,
  run: Command = runCommand,
): Promise<void> {
  await locked(async () => {
    const current = parseKeychains(
      await run(SECURITY, ['list-keychains', '-d', 'user']),
    )
    if (current.includes(keychain)) return
    await run(SECURITY, [
      'list-keychains',
      '-d',
      'user',
      '-s',
      ...current,
      keychain,
    ])
  })
}

/** Removes only this keychain from the user's search list. */
export async function removeFromSearchList(
  keychain: string,
  run: Command = runCommand,
): Promise<void> {
  await locked(async () => {
    const current = parseKeychains(
      await run(SECURITY, ['list-keychains', '-d', 'user']),
    )
    if (!current.includes(keychain)) return
    await run(SECURITY, [
      'list-keychains',
      '-d',
      'user',
      '-s',
      ...current.filter((entry) => entry !== keychain),
    ])
  })
}

export interface StageKeychain {
  path: string
  password: string
}

/** Where a stage's keychain lives: its name ties it to the run for crash recovery. */
export function stageKeychainPath(dir: string, key: string): string {
  return path.join(
    dir,
    `mason-stage-${key.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 80)}.keychain-db`,
  )
}

/**
 * A temporary keychain for one stage: a random password, the signing
 * identity imported for `codesign` and the packaging tools with Apple's
 * intermediate authorities beside it, the partition list set so nothing
 * prompts, and the keychain appended to the search list so `xcodebuild`
 * finds the identity.
 */
export async function createStageKeychain(
  keychain: string,
  identity: { certificate: string; privateKey: string; sha1: string },
  run: Command = runCommand,
): Promise<StageKeychain> {
  const password = randomBytes(24).toString('base64url')
  const env = {
    MASON_KEYCHAIN_PASSWORD: password,
    MASON_P12_PASSWORD: password,
  }
  await run(SECURITY, ['create-keychain', '-p', password, keychain], { env })
  try {
    await run(SECURITY, ['set-keychain-settings', '-lut', '21600', keychain])
    await run(SECURITY, ['unlock-keychain', '-p', password, keychain])
    const pem = `${keychain}.identity.pem`
    const p12 = `${keychain}.identity.p12`
    try {
      writeFileSync(pem, identity.privateKey + '\n' + identity.certificate, {
        mode: 0o600,
      })
      await run(
        OPENSSL,
        [
          'pkcs12',
          '-export',
          '-in',
          pem,
          '-out',
          p12,
          '-passout',
          'env:MASON_P12_PASSWORD',
        ],
        { env },
      )
      await run(SECURITY, [
        'import',
        p12,
        '-k',
        keychain,
        '-f',
        'pkcs12',
        '-P',
        password,
        '-T',
        '/usr/bin/codesign',
        '-T',
        '/usr/bin/productsign',
        '-T',
        '/usr/bin/productbuild',
        '-T',
        '/usr/bin/security',
      ])
    } finally {
      rmSync(pem, { force: true })
      rmSync(p12, { force: true })
    }
    // Apple's intermediates, so the identity's chain builds from this
    // keychain alone and codesign accepts it.
    const authorities = appleIntermediates.map((entry) => {
      const file = `${keychain}.${entry.name}.pem`
      writeFileSync(file, entry.pem + '\n', { mode: 0o600 })
      return file
    })
    try {
      await run(SECURITY, ['add-certificates', '-k', keychain, ...authorities])
    } finally {
      for (const file of authorities) rmSync(file, { force: true })
    }
    await run(SECURITY, [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      password,
      keychain,
    ])
    const identities = await run(SECURITY, [
      'find-identity',
      '-p',
      'codesigning',
      keychain,
    ])
    if (!identities.toUpperCase().includes(identity.sha1.toUpperCase()))
      throw new Error(
        'The signing identity did not import into the stage keychain',
      )
    await addToSearchList(keychain, run)
    return { path: keychain, password }
  } catch (error) {
    await removeStageKeychain(keychain, run).catch(() => undefined)
    throw error
  }
}

/** Takes the stage keychain off the search list and deletes it. */
export async function removeStageKeychain(
  keychain: string,
  run: Command = runCommand,
): Promise<void> {
  await removeFromSearchList(keychain, run)
  if (existsSync(keychain))
    await run(SECURITY, ['delete-keychain', keychain]).catch(() => undefined)
  rmSync(keychain, { force: true })
}
