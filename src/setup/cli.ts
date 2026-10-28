import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { calibratePasswordCosts } from '../auth/passwordCalibration.js'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  checkNewPassword,
  clientParameters,
  type ClientPasswordCosts,
} from '../auth/passwordProtocol.js'
import {
  applyPendingRestore,
  PENDING_RESTORE,
  restoreBackup,
} from '../master/backup.js'
import { MasterDatabase } from '../master/database.js'
import { MasterKeys } from '../master/keys.js'
import { parseArgs, single } from '../node/args.js'
import { controlRequest, NotRunning } from '../node/control.js'
import {
  lockDataDir,
  prepareDataDir,
  resolveDataDir,
  writePrivate,
} from '../node/dataDir.js'
import { clearSetupCode } from '../node/identity.js'
import { claimRole } from '../node/serve.js'
import { asUsername, createFirstAdmin } from './setup.js'

export interface SetupIO {
  out(line: string): void
  /** Standard input, read whole. */
  stdin(): Promise<string>
  /** Client hash costs; calibrated to about three seconds when absent. */
  costs?: ClientPasswordCosts
}

/** Runs `fn` on the master's database with the data directory locked. */
export async function withStoppedMaster<T>(
  data: string,
  fn: (master: MasterDatabase) => Promise<T> | T,
): Promise<T> {
  const dir = prepareDataDir(data)
  const lock = lockDataDir(dir)
  try {
    claimRole(dir, 'master')
    const db = new DatabaseSync(path.join(dir, 'master.sqlite'), {
      timeout: 5000,
      enableForeignKeyConstraints: true,
    })
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      return await fn(new MasterDatabase(db))
    } finally {
      db.close()
    }
  } finally {
    lock.release()
  }
}

/**
 * `mason setup --username <name> --password-stdin [--api-key-out <file>]`.
 * The password is hashed here with Mason's client protocol; the master
 * only ever sees the client hash.
 */
export async function setupCommand(
  argv: string[],
  io: SetupIO,
): Promise<number> {
  const args = parseArgs(
    argv,
    [
      '--data',
      '--username',
      '--api-key-out',
      '--repository',
      '--key-file',
      '--branch',
      '--date',
    ],
    ['--password-stdin', '--restore'],
  )
  if (args.flags.has('--restore')) return await restoreCommand(args, io)
  const username = asUsername(single(args, '--username'))
  if (!args.flags.has('--password-stdin') || args.positional.length !== 0)
    throw new Error(
      'Usage: mason setup --username <name> --password-stdin [--api-key-out <file>]',
    )
  const data = resolveDataDir(single(args, '--data'))
  const keyFile = single(args, '--api-key-out')
  if (keyFile != null && existsSync(keyFile))
    throw new Error(`${keyFile} already exists`)
  const password = (await io.stdin()).replace(/\r?\n$/, '')
  checkNewPassword(password)
  const costs =
    io.costs ??
    (
      await calibratePasswordCosts(clientPasswordHash, undefined, 3000, () =>
        performance.now(),
      )
    ).costs
  const parameters = clientParameters(randomBytes(16).toString('hex'), costs)
  const request = {
    username,
    clientHash: await clientPasswordHash(password, parameters),
    clientParameters: parameters,
    apiKey: keyFile != null,
  }
  let result: { accountId: number; username: string; token?: string }
  try {
    result = (await controlRequest(data, 'setup', request)) as typeof result
  } catch (error) {
    if (!(error instanceof NotRunning)) throw error
    result = await withStoppedMaster(data, async (master) => {
      const out = await createFirstAdmin(
        master,
        new MasterKeys(master),
        request,
      )
      clearSetupCode(path.resolve(data))
      return out
    })
  }
  io.out(`Created admin ${result.username}; this master is now set up.`)
  if (keyFile != null && result.token != null) {
    writePrivate(keyFile, result.token + '\n')
    io.out(`Admin API key written to ${keyFile}`)
  }
  return 0
}

/**
 * `mason setup --restore --repository <url> --key-file <file> [--branch <name>]
 * [--date YYYY-MM-DD]`: rebuilds an unconfigured, stopped master from its
 * encrypted backup, under the data directory's lock.
 */
async function restoreCommand(
  args: ReturnType<typeof parseArgs>,
  io: SetupIO,
): Promise<number> {
  const repository = single(args, '--repository')
  const keyFile = single(args, '--key-file')
  if (repository == null || keyFile == null || args.positional.length !== 0)
    throw new Error(
      'Usage: mason setup --restore --repository <url> --key-file <file> [--branch <name>] [--date YYYY-MM-DD]',
    )
  const data = resolveDataDir(single(args, '--data'))
  const dir = prepareDataDir(data)
  let lock: ReturnType<typeof lockDataDir>
  try {
    lock = lockDataDir(dir)
  } catch {
    throw new Error('Stop the master before restoring it')
  }
  try {
    claimRole(dir, 'master')
    const file = path.join(dir, 'master.sqlite')
    if (existsSync(file)) {
      const db = new DatabaseSync(file, { enableForeignKeyConstraints: true })
      try {
        if (new MasterDatabase(db).configured())
          throw new Error(
            'This master is already set up; restore into an unconfigured master',
          )
      } finally {
        db.close()
      }
    }
    const branch = single(args, '--branch')
    const date = single(args, '--date')
    const restored = await restoreBackup({
      repository,
      key: readFileSync(keyFile, 'utf8'),
      ...(branch == null ? {} : { branch }),
      ...(date == null ? {} : { date }),
      target: path.join(dir, PENDING_RESTORE),
      scratch: path.join(dir, 'scratch'),
    })
    let started = ''
    applyPendingRestore(dir, (line) => {
      started = line
    })
    clearSetupCode(dir)
    io.out(
      `Restored the master from ${date == null ? 'its latest backup' : `the backup of ${date}`}: ${Object.entries(
        restored.tables,
      )
        .map(([table, count]) => `${count} ${table}`)
        .join(', ')}.`,
    )
    const identity = /as master (\S+)$/.exec(started)?.[1]
    io.out(
      identity == null
        ? 'The backup holds no master identity: nodes pair with this master again.'
        : `This master is ${identity} again, so its nodes reconnect without pairing. Stop the master the backup came from before starting this one: two masters with one identity take turns with the same nodes.`,
    )
    return 0
  } finally {
    lock.release()
  }
}

/** Reads all of standard input. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY)
    throw new Error('Pipe the password into --password-stdin')
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
