import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { loadConfig, noSymlinks } from '../config.js'
import { Store } from '../store.js'
import { asId } from '../validation.js'
import { ApiKeys, asCredentials } from './keys.js'

export function importCredentials(
  file: string,
  value: unknown,
  replace = false,
): void {
  const credentials = asCredentials(value)
  file = path.resolve(file)
  noSymlinks(file)
  const parent = path.dirname(file)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  if (existsSync(file) && (!replace || !lstatSync(file).isFile()))
    throw new Error('Credential file already exists')
  const temporary = path.join(
    parent,
    `.mason-${randomBytes(16).toString('hex')}.tmp`,
  )
  let fd: number | undefined
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(fd, JSON.stringify(credentials, null, 2) + '\n')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    // Recheck before replacing an explicitly authorized destination.
    noSymlinks(file)
    if (existsSync(file) && !replace)
      throw new Error('Credential file already exists')
    if (!replace) linkSync(temporary, file)
    else renameSync(temporary, file)
  } finally {
    if (fd != null) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
function stdin(): unknown {
  const parts: Buffer[] = []
  let size = 0
  while (true) {
    const buffer = Buffer.alloc(4096),
      count = readSync(0, buffer, 0, buffer.length, null)
    if (count === 0) break
    size += count
    if (size > 65536) throw new Error('Credential input too large')
    parts.push(buffer.subarray(0, count))
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}
export function keyCommand(
  argv: string[],
  output: (value: string) => void,
): void {
  const [command, ...rest] = argv
  const flags = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!
    if (!key.startsWith('--') || flags.has(key))
      throw new Error('Invalid key command')
    if (key === '--json' || key === '--replace') flags.set(key, 'true')
    else {
      const value = rest[++i]
      if (value == null || value.startsWith('--'))
        throw new Error('Missing flag value')
      flags.set(key, value)
    }
  }
  const allowed =
    command === 'create'
      ? ['--config', '--name', '--apps', '--expires', '--json']
      : command === 'list'
        ? ['--config']
        : command === 'revoke'
          ? ['--config', '--id']
          : command === 'import'
            ? ['--file', '--replace']
            : []
  if (
    allowed.length === 0 ||
    [...flags.keys()].some((key) => !allowed.includes(key))
  )
    throw new Error('Invalid key command')
  function required(key: string): string {
    const value = flags.get(key)
    if (value == null) throw new Error('Missing required flag')
    return value
  }
  if (command === 'import') {
    importCredentials(required('--file'), stdin(), flags.has('--replace'))
    output('Saved Mason API credentials')
    return
  }
  const store = new Store(loadConfig(required('--config')))
  try {
    const keys = new ApiKeys(store)
    if (command === 'list') output(JSON.stringify(keys.list()))
    else if (command === 'revoke') {
      keys.revoke(required('--id'))
      output('API key revoked')
    } else {
      if (!flags.has('--json'))
        throw new Error('Use --json to receive the one-time credential')
      const apps = required('--apps'),
        expiry = flags.get('--expires')
      output(
        JSON.stringify(
          keys.create(
            required('--name'),
            apps === 'all'
              ? 'all'
              : apps.split(',').map((value) => asId(Number(value))),
            expiry == null ? undefined : Date.parse(expiry),
          ),
        ),
      )
    }
  } finally {
    store.close()
  }
}
