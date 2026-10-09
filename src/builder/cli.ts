import { BuilderStore } from './store.js'
import { loadBuilderConfig } from './config.js'
import { readPrivateJson } from '../config.js'
import { serveBuilder } from './server.js'
import { recover } from './worker.js'
import { buildClient } from './client.js'

export async function builderCommand(
  args: string[],
  output: (value: string) => void = console.log,
): Promise<void> {
  process.umask(0o077)
  const [command, ...rest] = args
  if (rest.length % 2) throw new Error('Expected named options')
  const options: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!
    if (!key.startsWith('--') || options[key] != null)
      throw new Error('Invalid option')
    options[key] = rest[i + 1]!
  }
  const allowed: Record<string, string[]> = {
    build: ['--client-config', '--app', '--branch', '--platform'],
    serve: ['--config'],
    'app-import': ['--config', '--file'],
    'key-create': ['--config', '--output'],
    'key-revoke': ['--config', '--id'],
    recover: ['--config', '--job', '--confirm-stopped'],
    apps: ['--config'],
  }
  if (
    command == null ||
    allowed[command] == null ||
    Object.keys(options).some((key) => !allowed[command]!.includes(key))
  )
    throw new Error('Unknown builder command or option')
  const required = (key: string): string => {
    if (!options[key]) throw new Error('Missing option')
    return options[key]!
  }
  if (command === 'build') {
    if (
      !(await buildClient(
        required('--client-config'),
        {
          app: required('--app'),
          branch: required('--branch'),
          platforms: options['--platform']?.split(','),
        },
        output,
      ))
    )
      process.exitCode = 1
    return
  }
  const store = new BuilderStore(loadBuilderConfig(required('--config')))
  if (command === 'serve') {
    const service = serveBuilder(store)
    let closing = false
    const stop = (): void => {
      if (closing) return
      closing = true
      void service.close().catch(() => {
        process.exitCode = 1
      })
    }
    service.server.once('error', () => {
      process.exitCode = 1
      stop()
    })
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    output('Mason builder started')
    return
  }
  try {
    if (command === 'app-import') {
      store.importApp(readPrivateJson(required('--file')))
      output('App configured')
    } else if (command === 'key-create')
      output(JSON.stringify({ id: store.key(required('--output')) }))
    else if (command === 'key-revoke') {
      store.revoke(required('--id'))
      output('Key revoked')
    } else if (command === 'recover') {
      recover(
        store,
        required('--job'),
        required('--confirm-stopped') === 'yes',
      )
      output('Quarantine released')
    } else
      output(
        JSON.stringify(
          store.apps().map(({ slug, name, platforms, enabled }) => ({
            slug,
            name,
            platforms,
            enabled,
          })),
        ),
      )
  } finally {
    store.close()
  }
}
