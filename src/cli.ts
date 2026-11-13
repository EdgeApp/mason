import { backfillDevices } from './devices/backfill.js'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { Accounts } from './auth/accounts.js'
import { rewriteTeamStationSubjects } from './auth/rewriteTeamStationSubjects.js'
import { asId } from './validation.js'
import { Store } from './store.js'
import { nodeMain } from './node/main.js'

/**
 * The message for a command the cluster retired with the standalone server
 * and builder, or undefined for any other command.
 */
export function retiredCommand(argv: string[]): string | undefined {
  const [command, action] = argv
  const name =
    command === 'builder'
      ? 'mason builder'
      : command === 'serve' && argv.includes('--config')
        ? 'mason serve --config'
        : command === 'keys' && action === 'import'
          ? 'mason keys import'
          : command === 'keys' && argv.includes('--config')
            ? 'mason keys --config'
            : undefined
  return name == null
    ? undefined
    : `\`${name}\` is retired: the cluster replaced the standalone server, the builder and their keys. See "Migrating from the standalone server and builder" in the README.`
}

/**
 * The legacy maintenance commands keep their exact syntax: every
 * `devices-*` command, and any command given `--config <file>`. They work
 * on the pre-cluster distribution database.
 */
export function isLegacyCommand(argv: string[]): boolean {
  return argv.includes('--config') || (argv[0]?.startsWith('devices-') ?? false)
}

export function run(
  argv: string[],
  output: (value: string) => void = console.log,
): void {
  const [command, flag, file] = argv
  if (
    ![
      'migrate',
      'prune',
      'status',
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
      'Usage: mason migrate|prune|status|accounts --config <file>; mason rewrite-teamstation-subjects --config <file> --provider <id> [--apply]; mason admin-grant --config <file> --provider <id> --subject <subject (usr_ for TeamStation)> --email <email>',
    )
  const store = new Store(loadConfig(file))
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
    const retired = retiredCommand(process.argv.slice(2))
    if (retired != null) {
      console.error(retired)
      process.exitCode = 1
    } else if (
      process.argv[2] === 'devices-inspect' &&
      process.argv[3] === '--config' &&
      process.argv.length === 5
    ) {
      void backfillDevices(process.argv[4]!).catch(() => {
        console.error('Mason device metadata inspection failed')
        process.exitCode = 1
      })
    } else if (isLegacyCommand(process.argv.slice(2)))
      run(process.argv.slice(2))
    else
      void nodeMain(process.argv.slice(2)).then((code) => {
        process.exitCode = code
      })
  } catch {
    console.error(
      'Mason command failed. Check the command and private configuration.',
    )
    process.exitCode = 1
  }
}
