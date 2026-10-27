import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { baseEnvironment } from '../builder/config.js'
import { canonical, type GitBridge, type Ticket } from './gitProxy.js'

const run = promisify(execFile)

/**
 * The environment of a worker's own git commands: no SSH agent, and no
 * system or user configuration, so no credential helper or URL rewrite
 * applies — the source can only come from the master.
 */
export function checkoutEnvironment(): NodeJS.ProcessEnv {
  const env = baseEnvironment()
  delete env.SSH_AUTH_SOCK
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Mason',
    GIT_AUTHOR_EMAIL: 'mason@localhost',
    GIT_COMMITTER_NAME: 'Mason',
    GIT_COMMITTER_EMAIL: 'mason@localhost',
  }
}

export interface CheckoutOptions {
  dir: string
  repository: string
  commit: string
  /** Other repositories the project lists, for submodules. */
  repositories: string[]
  depth?: number
  submodules: boolean
  lfs: boolean
  /** `clean` resets to the pinned commit and removes untracked files; `reuse` keeps them. */
  mode: 'clean' | 'reuse'
  bridge: GitBridge
  ticket: Ticket
  log: (text: string) => void
}

/**
 * Checks out the pinned commit from the master's mirror. Only the commands
 * run here get the bridge configuration; the checkout's own config never
 * allows `ext::`, so a later plain `git fetch` refuses it.
 */
export async function checkout(options: CheckoutOptions): Promise<void> {
  const { dir } = options
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const issued = options.bridge.issue(options.ticket)
  const bridged = {
    ...checkoutEnvironment(),
    ...options.bridge.environment(
      issued.id,
      [options.repository, ...options.repositories],
      options.lfs ? options.repository : undefined,
    ),
  }
  const git = async (
    args: string[],
    env: NodeJS.ProcessEnv = bridged,
  ): Promise<string> => {
    const { stdout, stderr } = await run('git', args, {
      cwd: dir,
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60 * 60 * 1000,
    })
    if (stderr.trim() !== '') options.log(stderr)
    return stdout.trim()
  }
  try {
    if (!existsSync(path.join(dir, '.git'))) {
      await git(['init', '--quiet'])
      await git(['remote', 'add', 'origin', canonical(options.repository)])
    } else
      await git(['remote', 'set-url', 'origin', canonical(options.repository)])
    // Repository hooks never run on a worker.
    await git(['config', 'core.hooksPath', '/dev/null'])
    options.log(`Fetching ${options.commit} from the master\n`)
    await git([
      'fetch',
      '--quiet',
      '--no-tags',
      ...(options.depth == null ? [] : [`--depth=${options.depth}`]),
      'origin',
      // A local ref lets the next fetch offer these objects, so only new ones transfer.
      `+${options.commit}:refs/mason/checkout`,
    ])
    await git(['checkout', '--quiet', '--force', '--detach', options.commit], {
      ...bridged,
      GIT_LFS_SKIP_SMUDGE: '1',
    })
    if (options.mode === 'clean') await git(['clean', '-ffdxq'])
    if (options.submodules && existsSync(path.join(dir, '.gitmodules'))) {
      options.log('Fetching submodules from the master\n')
      await git(
        [
          'submodule',
          'update',
          '--init',
          '--recursive',
          '--force',
          ...(options.depth == null ? [] : [`--depth=${options.depth}`]),
        ],
        { ...bridged, GIT_LFS_SKIP_SMUDGE: '1' },
      )
      if (options.mode === 'clean')
        await git(['submodule', 'foreach', '--recursive', 'git clean -ffdxq'])
    }
    if (options.lfs) {
      try {
        await run('git', ['lfs', 'version'], {
          cwd: dir,
          env: checkoutEnvironment(),
        })
      } catch {
        throw new Error('git-lfs is not installed on this node')
      }
      options.log('Fetching LFS objects from the master\n')
      // The filters go into this checkout's own config; nothing global is touched.
      await git(['lfs', 'install', '--local', '--skip-repo', '--skip-smudge'])
      await git(['lfs', 'pull'])
    }
  } finally {
    issued.revoke()
  }
}
