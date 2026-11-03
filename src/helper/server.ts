import { execFile } from 'node:child_process'
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { baseEnvironment } from '../builder/config.js'
import { HELPER_LABEL } from '../node/service.js'
import { perform, Refused, type HelperContext } from './catalog.js'

const exec = promisify(execFile)

/** Where the helper listens and keeps the master key, per platform. */
export function helperPaths(platform: 'darwin' | 'linux'): {
  socket: string
  keyFile: string
  work: string
} {
  return platform === 'darwin'
    ? {
        socket: '/var/run/mason/helper.sock',
        keyFile: '/Library/Application Support/Mason/master.pub',
        work: '/Library/Application Support/Mason/work',
      }
    : {
        socket: '/run/mason/helper.sock',
        keyFile: '/etc/mason/master.pub',
        work: '/var/lib/mason-helper/work',
      }
}

/** Runs one program: the file, its arguments, environment, directory and standard input. */
export type HelperExec = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; input?: string },
) => Promise<{ stdout: string; stderr: string }>

const execProgram: HelperExec = async (file, args, options) => {
  const child = exec(file, args, {
    env: options.env,
    ...(options.cwd == null ? {} : { cwd: options.cwd }),
    maxBuffer: 64 * 1024 * 1024,
  })
  if (options.input != null) child.child.stdin?.end(options.input)
  const { stdout, stderr } = await child
  return { stdout: String(stdout), stderr: String(stderr) }
}

/** The real computer: commands run as root, or through `sudo -u` as the service's user. */
export function systemContext(
  platform: 'darwin' | 'linux',
  user: HelperContext['user'],
  paths: Partial<HelperContext['paths']> = {},
  program: HelperExec = execProgram,
): HelperContext {
  const defaults = helperPaths(platform)
  return {
    platform,
    user,
    paths: {
      keyFile: defaults.keyFile,
      prefix: '/opt/mason',
      bindir: '/usr/local/bin',
      applications: '/Applications',
      work: defaults.work,
      ...paths,
    },
    async run(
      command,
      args,
      options = {},
    ): Promise<{ stdout: string; stderr: string }> {
      const env = { ...baseEnvironment(), ...options.env }
      const [file, argv] = options.asUser
        ? ['sudo', ['-u', user.name, '-H', '--', command, ...args]]
        : [command, args]
      return await program(file, argv, {
        env,
        ...(options.cwd == null ? {} : { cwd: options.cwd }),
        ...(options.input == null ? {} : { input: options.input }),
      })
    },
    async restartService(): Promise<void> {
      const env = baseEnvironment()
      if (platform === 'darwin')
        await program(
          'launchctl',
          ['kickstart', '-k', `gui/${user.uid}/app.mason.worker`],
          { env },
        )
      else await program('systemctl', ['restart', 'mason-worker'], { env })
    },
    async restartHelper(): Promise<void> {
      const env = baseEnvironment()
      // The service manager stops and starts this process; on Linux the
      // restart is queued so systemctl does not wait on its own caller.
      if (platform === 'darwin')
        await program(
          'launchctl',
          ['kickstart', '-k', `system/${HELPER_LABEL}`],
          {
            env,
          },
        )
      else
        await program('systemctl', ['--no-block', 'restart', 'mason-helper'], {
          env,
        })
    },
  }
}

/**
 * Serves the catalog on a socket only the service's user (and root) can
 * open: the directory is root's, the socket is the user's with mode 0600.
 * Each line is one request `{ id, op, args }`; each answer one line. The
 * helper restarts itself only once every request in progress is answered,
 * and takes no new one meanwhile.
 */
export async function serveHelper(
  socket: string,
  context: HelperContext,
): Promise<net.Server> {
  let inProgress = 0
  let restarting = false
  let idle: Array<() => void> = []
  const settled = (): void => {
    if (--inProgress > 0) return
    const waiting = idle
    idle = []
    for (const resolve of waiting) resolve()
  }
  const served: HelperContext = {
    ...context,
    restartHelper: async (): Promise<void> => {
      // From now on no new request starts; those in progress finish.
      restarting = true
      while (inProgress > 0)
        await new Promise<void>((resolve) => idle.push(resolve))
      await context.restartHelper()
    },
  }
  mkdirSync(path.dirname(socket), { recursive: true, mode: 0o755 })
  if (existsSync(socket)) rmSync(socket, { force: true })
  const server = net.createServer((connection) => {
    let buffer = ''
    connection.setEncoding('utf8')
    connection.on('data', (text: string) => {
      buffer += text
      if (buffer.length > 1024 * 1024) {
        connection.destroy()
        return
      }
      for (
        let end = buffer.indexOf('\n');
        end >= 0;
        end = buffer.indexOf('\n')
      ) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let request: { id?: unknown; op?: unknown; args?: unknown }
        try {
          request = JSON.parse(line) as typeof request
        } catch {
          connection.end(
            JSON.stringify({ ok: false, error: 'Unreadable request' }) + '\n',
          )
          return
        }
        if (restarting) {
          connection.write(
            JSON.stringify({
              id: request.id,
              ok: false,
              error:
                'The helper is restarting into a new release; ask again in a moment',
            }) + '\n',
          )
          continue
        }
        inProgress++
        perform(request.op, request.args, served)
          .then(
            (result) =>
              connection.write(
                JSON.stringify({
                  id: request.id,
                  ok: true,
                  result: result ?? null,
                }) + '\n',
              ),
            (error: unknown) =>
              connection.write(
                JSON.stringify({
                  id: request.id,
                  ok: false,
                  refused: error instanceof Refused,
                  error: error instanceof Error ? error.message : String(error),
                }) + '\n',
              ),
          )
          .finally(settled)
      }
    })
    connection.on('error', () => undefined)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => {
      resolve()
    })
  })
  chmodSync(socket, 0o600)
  if (process.geteuid?.() === 0)
    chownSync(socket, context.user.uid, context.user.gid)
  return server
}

export class HelperUnavailable extends Error {}

/** Asks the helper for one operation. */
export async function helperRequest(
  socket: string,
  op: string,
  args: unknown,
  timeoutMs = 60 * 60 * 1000,
): Promise<unknown> {
  if (!existsSync(socket))
    throw new HelperUnavailable(
      'The privileged helper is not installed: run sudo mason worker --install',
    )
  return await new Promise((resolve, reject) => {
    const connection = net.createConnection(socket)
    let buffer = ''
    const timer = setTimeout(() => {
      connection.destroy()
      reject(new Error('The helper did not answer'))
    }, timeoutMs)
    connection.setEncoding('utf8')
    connection.on('connect', () =>
      connection.write(JSON.stringify({ id: 1, op, args }) + '\n'),
    )
    connection.on('data', (text: string) => {
      buffer += text
      const end = buffer.indexOf('\n')
      if (end < 0) return
      clearTimeout(timer)
      connection.end()
      const answer = JSON.parse(buffer.slice(0, end)) as {
        ok: boolean
        result?: unknown
        error?: string
      }
      if (answer.ok) resolve(answer.result)
      else reject(new Error(answer.error ?? 'The helper refused'))
    })
    connection.on('error', (error) => {
      clearTimeout(timer)
      reject(
        error.message.includes('EACCES')
          ? new HelperUnavailable('This account cannot reach the helper')
          : error,
      )
    })
  })
}
