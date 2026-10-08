import { keyCommand } from './upload/keyCli.js'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { serve } from './server.js'
import { Accounts } from './auth/accounts.js'
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
    ].includes(command ?? '') ||
    flag !== '--config' ||
    file == null ||
    (command === 'admin-grant'
      ? argv.length !== 9 ||
        argv[3] !== '--provider' ||
        argv[5] !== '--subject' ||
        argv[7] !== '--email'
      : command === 'admin-revoke'
        ? argv.length !== 5 || argv[3] !== '--account'
        : argv.length !== 3)
  )
    throw new Error('Usage: mason migrate|prune|status|serve --config <file>')
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
    if (command === 'admin-grant')
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
    run(process.argv.slice(2))
  } catch {
    console.error(
      'Mason command failed. Check the command and private configuration.',
    )
    process.exitCode = 1
  }
}
