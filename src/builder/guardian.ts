import { asMap, asString } from 'cleaners'
import {
  existsSync,
  readFileSync,
  lstatSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { asBuilderConfig, baseEnvironment } from './config.js'
import { BuilderStore, exclusiveLock, type Status } from './store.js'
import { CommandFailure, Execution, MaskedLog } from './execution.js'
import { Workspace, type RepositoryResolver } from './workspace.js'
import { noSymlinks, readPrivateJson } from '../config.js'

export async function executeJob(
  store: BuilderStore,
  id: string,
  disconnected: AbortSignal,
  resolver?: RepositoryResolver,
): Promise<void> {
  const lock = exclusiveLock(
    path.join(store.config.workspace, 'executions', id + '.sqlite'),
  )
  const job = store.job(id)
  if (job == null || job.status !== 'running') {
    lock.close()
    throw new Error('Job is not running')
  }
  const secrets = [
    ...job.definition.env.filter((e) => e.secret).map((e) => e.value),
    ...job.definition.files.map((f) =>
      Buffer.from(f.contents, 'base64').toString('utf8'),
    ),
  ]
  const log = new MaskedLog(
    path.join(store.config.workspace, 'logs', id + '.log'),
    secrets,
  )
  const execution = new Execution(log)
  const workspace = new Workspace(store, job, execution, resolver)
  let status: Status = 'failed',
    exitCode: number | undefined,
    result: unknown,
    stopping: Promise<boolean> | undefined
  const stop = (next: Status): void => {
    if (stopping == null) {
      status = next
      stopping = execution.stop()
    }
  }
  const disconnect = (): void => stop('interrupted')
  disconnected.addEventListener('abort', disconnect)
  if (disconnected.aborted) disconnect()
  const timer = setTimeout(
    () => stop('timed_out'),
    job.definition.timeoutSeconds * 1000,
  )
  const poll = setInterval(() => {
    try {
      if (store.job(id)?.cancel) stop('cancelled')
    } catch {
      stop('interrupted')
    }
  }, 100)
  const resultFile = path.join(
    store.config.workspace,
    'executions',
    id + '.result.json',
  )
  try {
    const commit = await workspace.prepare()
    const env = {
      ...baseEnvironment(),
      ...Object.fromEntries(
        job.definition.env.map((e) => [e.name, e.value]),
      ),
      ...workspace.inject(),
      MASON_APP: job.app,
      MASON_BRANCH: job.branch,
      MASON_COMMIT: commit,
      MASON_JOB_ID: id,
      MASON_WORKSPACE: workspace.checkout,
      MASON_RESULT_FILE: resultFile,
      MASON_PLATFORMS: (
        job.request.platforms ?? job.definition.platforms
      ).join(','),
    }
    await execution.run(
      process.execPath,
      [workspace.entrypoint()],
      workspace.checkout,
      env,
    )
    if (stopping == null) status = 'succeeded'
  } catch (error) {
    if (error instanceof CommandFailure && error.code != null)
      exitCode = error.code
    log.write('\nBuild execution did not complete successfully.\n')
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    disconnected.removeEventListener('abort', disconnect)
    const safe = await (stopping ?? execution.stop())
    let cleaned = safe
    try {
      if (safe) workspace.cleanup()
    } catch {
      cleaned = false
    }
    try {
      if (existsSync(resultFile)) {
        noSymlinks(resultFile)
        if (
          !lstatSync(resultFile).isFile() ||
          lstatSync(resultFile).size > 65536
        )
          throw new Error('Invalid result')
        const redact = (value: unknown): unknown => {
          const mask = (text: string): string =>
            secrets
              .filter(Boolean)
              .sort((a, b) => b.length - a.length)
              .reduce(
                (out, secret) => out.split(secret).join('[redacted]'),
                text,
              )
          if (typeof value === 'string') return mask(value)
          if (Array.isArray(value)) return value.map(redact)
          if (value != null && typeof value === 'object')
            return Object.fromEntries(
              Object.entries(value).map(([key, item]) => [
                mask(key),
                redact(item),
              ]),
            )
          return value
        }
        const redacted = redact(
          JSON.parse(readFileSync(resultFile, 'utf8')),
        )
        if (JSON.stringify(redacted).length > 65536)
          throw new Error('Result too large')
        result = redacted
        rmSync(resultFile)
      }
    } catch {
      if (status === 'succeeded') status = 'failed'
    }
    log.write('', true)
    store.finish(
      id,
      cleaned ? status : 'interrupted',
      status === 'succeeded' ? 0 : exitCode,
      result,
      !cleaned,
    )
    lock.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077)
  const abort = new AbortController()
  process.once('disconnect', () => abort.abort())
  process.once('SIGTERM', () => abort.abort())
  process.once('SIGINT', () => abort.abort())
  const bootstrap = process.argv[2]!
  const config = asBuilderConfig(readPrivateJson(bootstrap))
  const store = new BuilderStore(config)
  // Internal fixture resolver is supplied only by a private guardian bootstrap file.
  const fixtureFile = process.argv[4]
  const resolver =
    fixtureFile == null
      ? undefined
      : (repository: string): string => {
          const pairs = asMap(asString)(
            JSON.parse(readFileSync(fixtureFile, 'utf8')),
          )
          return pairs[repository] ?? repository
        }
  executeJob(store, process.argv[3]!, abort.signal, resolver)
    .catch(() => {
      process.exitCode = 1
    })
    .finally(() => {
      store.close()
      process.disconnect?.()
    })
}
export function writeBootstrap(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value), {
    flag: 'wx',
    mode: 0o600,
  })
}
