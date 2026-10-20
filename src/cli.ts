import { backfillDevices } from './devices/backfill.js'
import {
  runDeviceWorker,
  asWorkerConfig,
  DeviceWorker,
} from './devices/worker.js'
import { builderCommand } from './builder/cli.js'
import { keyCommand } from './upload/keyCli.js'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig, readPrivateJson } from './config.js'
import { serve } from './server.js'
import { Accounts } from './auth/accounts.js'
import { rewriteTeamStationSubjects } from './auth/rewriteTeamStationSubjects.js'
import { asId } from './validation.js'
import { Store } from './store.js'

export function run(
  argv: string[],
  output: (value: string) => void = console.log,
): void {
  if (argv[0] === 'keys') {
    keyCommand(argv.slice(1), output)
    return
  }
  const [command, flag, file] = argv
  if (
    ![
      'migrate',
      'prune',
      'status',
      'serve',
      'accounts',
      'admin-grant',
      'admin-revoke',
      'rewrite-teamstation-subjects',
    ].includes(command ?? '') ||
    flag !== '--config' ||
    file == null ||
    (command === 'admin-grant'
      ? argv.length !== 9 ||
        argv[3] !== '--provider' ||
        argv[5] !== '--subject' ||
        argv[7] !== '--email'
      : command === 'rewrite-teamstation-subjects'
        ? argv[3] !== '--provider' ||
          argv[4] == null ||
          !(argv.length === 5 || (argv.length === 6 && argv[5] === '--apply'))
        : command === 'admin-revoke'
          ? argv.length !== 5 || argv[3] !== '--account'
          : argv.length !== 3)
  )
    throw new Error(
      'Usage: mason migrate|prune|status|serve --config <file>; mason rewrite-teamstation-subjects --config <file> --provider <id> [--apply]; mason admin-grant --config <file> --provider <id> --subject <subject (usr_ for TeamStation)> --email <email>',
    )
  const store = new Store(loadConfig(file))
  if (command === 'serve') {
    const server = serve(store)
    server.once('error', () => {
      console.error('Mason could not start its listener')
      process.exitCode = 1
    })
    const stop = (): void => {
      server.close()
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    server.once('close', () => {
      process.off('SIGTERM', stop)
      process.off('SIGINT', stop)
    })
    return
  }
  try {
    const accounts = new Accounts(store)
    if (command === 'rewrite-teamstation-subjects') {
      const apply = argv[5] === '--apply'
      const result = rewriteTeamStationSubjects(store, argv[4]!, apply)
      output(
        `$ mason rewrite-teamstation-subjects --config <file> --provider ${argv[4]!}${apply ? ' --apply' : ''}`,
      )
      output(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', ...result }))
      if (result.collisions.length > 0) process.exitCode = 1
    } else if (command === 'admin-grant')
      output(
        JSON.stringify({
          account: accounts.promote(argv[4]!, argv[6]!, argv[8]!),
          admin: true,
        }),
      )
    else if (command === 'admin-revoke') {
      accounts.setAdmin(asId(Number(argv[4])), false)
      output('Administrator access revoked')
    } else if (command === 'accounts')
      output(
        JSON.stringify({
          accounts: accounts.list(),
          identities: accounts.identities(),
        }),
      )
    else if (command === 'prune') {
      accounts.prune()
      output(JSON.stringify(store.prune()))
    } else if (command === 'status')
      output(
        JSON.stringify({
          bytes: store.usage(),
          apps: store.apps().length,
        }),
      )
    else output('Mason database is ready')
  } finally {
    store.close()
  }
}
if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    if (
      process.argv[2] === 'devices-bootstrap' &&
      process.argv[3] === '--config' &&
      process.argv.length === 5
    ) {
      const worker = new DeviceWorker(
        asWorkerConfig(readPrivateJson(process.argv[4]!)),
      )
      void worker
        .bootstrap()
        .finally(() => worker.close())
        .catch(() => {
          console.error('Mason signing profile preparation failed')
          process.exitCode = 1
        })
    } else if (
      process.argv[2] === 'devices-inspect' &&
      process.argv[3] === '--config' &&
      process.argv.length === 5
    ) {
      void backfillDevices(process.argv[4]!).catch(() => {
        console.error('Mason device metadata inspection failed')
        process.exitCode = 1
      })
    } else if (
      process.argv[2] === 'devices-worker' &&
      process.argv[3] === '--config' &&
      process.argv.length === 5
    ) {
      void runDeviceWorker(process.argv[4]!).catch(() => {
        console.error('Mason device worker failed; check private settings')
        process.exitCode = 1
      })
    } else if (process.argv[2] === 'builder') {
      void builderCommand(process.argv.slice(3)).catch(() => {
        console.error(
          'Builder command failed. Check private configuration and job status.',
        )
        process.exitCode = 1
      })
    } else run(process.argv.slice(2))
  } catch {
    console.error(
      'Mason command failed. Check the command and private configuration.',
    )
    process.exitCode = 1
  }
}
