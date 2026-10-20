import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { baseEnvironment } from '../builder/config.js'

const run = promisify(execFile)

/** How the master reaches a repository: a git URL with its credential environment, and the LFS endpoint. */
export interface Remote {
  url: string
  env: NodeJS.ProcessEnv
  lfs?: { url: string; headers: Record<string, string> }
}
export type RemoteResolver = (repository: string) => Promise<Remote>

/** `owner/name` of a normalized GitHub repository URL. */
export function repositoryName(repository: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(
      repository,
    )
  if (match == null) throw new Error('Not a GitHub repository')
  return `${match[1]}/${match[2]}`
}

/** The LFS endpoint and header of a GitHub remote reached with a token or App credential. */
export function githubLfs(remote: {
  url: string
  env: NodeJS.ProcessEnv
}): Remote['lfs'] {
  const header =
    remote.env.GIT_CONFIG_KEY_0 === 'http.https://github.com/.extraheader'
      ? remote.env.GIT_CONFIG_VALUE_0
      : undefined
  if (header == null || !remote.url.startsWith('https://github.com/'))
    return undefined
  return {
    url: `${remote.url.replace(/\.git$/, '')}.git/info/lfs`,
    headers: { Authorization: header.replace(/^AUTHORIZATION: /i, '') },
  }
}

const sha = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

/**
 * Bare mirrors of each project's repositories in `<data>/mirrors`. The master
 * is the only node with repository credentials; workers fetch from these
 * mirrors over their links.
 */
export class Mirrors {
  private readonly locks = new Map<string, Promise<unknown>>()
  constructor(
    readonly root: string,
    private readonly remote: RemoteResolver,
  ) {}

  dir(project: string, repository: string): string {
    return path.join(
      this.root,
      project,
      repositoryName(repository).replace('/', '__') + '.git',
    )
  }

  private async locked<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const next = previous.then(body, body)
    this.locks.set(
      key,
      next.catch(() => undefined),
    )
    return await next
  }

  private async git(
    dir: string,
    args: string[],
    env: NodeJS.ProcessEnv = baseEnvironment(),
  ): Promise<string> {
    const { stdout } = await run('git', ['-C', dir, ...args], {
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    })
    return stdout.trim()
  }

  async has(
    project: string,
    repository: string,
    commit: string,
  ): Promise<boolean> {
    const dir = this.dir(project, repository)
    if (!existsSync(dir) || !sha.test(commit)) return false
    try {
      await this.git(dir, ['cat-file', '-e', `${commit}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  /**
   * Makes sure the mirror exists and holds `commit` (or, with a branch, its
   * newest commit, which is returned). Fetches every branch and tag first and
   * the commit itself if it is still missing.
   */
  async ensure(
    project: string,
    repository: string,
    want: { commit?: string; branch?: string } = {},
  ): Promise<string | undefined> {
    const dir = this.dir(project, repository)
    return await this.locked(dir, async () => {
      if (
        want.commit != null &&
        (await this.has(project, repository, want.commit))
      )
        return want.commit
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        await this.git(dir, ['init', '--bare', '--quiet'])
        await this.git(dir, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
        await this.git(dir, ['config', 'uploadpack.allowFilter', 'true'])
      }
      const remote = await this.remote(repository)
      await this.git(
        dir,
        [
          'fetch',
          '--quiet',
          '--prune',
          remote.url,
          '+refs/heads/*:refs/heads/*',
          '+refs/tags/*:refs/tags/*',
        ],
        remote.env,
      )
      if (
        want.commit != null &&
        !(await this.has(project, repository, want.commit))
      )
        await this.git(
          dir,
          ['fetch', '--quiet', remote.url, want.commit],
          remote.env,
        ).catch(() => undefined)
      if (want.commit != null) {
        if (!(await this.has(project, repository, want.commit)))
          throw new Error(
            `${repositoryName(repository)} has no commit ${want.commit}`,
          )
        return want.commit
      }
      if (want.branch != null)
        return await this.git(dir, [
          'rev-parse',
          '--verify',
          `refs/heads/${want.branch}^{commit}`,
        ]).catch(() => {
          throw new Error(
            `${repositoryName(repository)} has no branch ${want.branch}`,
          )
        })
      return undefined
    })
  }

  /** `git upload-pack` on a mirror, for one worker fetch over its link. */
  uploadPack(
    project: string,
    repository: string,
    protocol?: string,
  ): ChildProcess {
    const dir = this.dir(project, repository)
    if (!existsSync(dir)) throw new Error('No mirror for that repository')
    return spawn('git', ['upload-pack', '--strict', dir], {
      env: {
        ...baseEnvironment(),
        ...(protocol != null && /^version=[0-2]$/.test(protocol)
          ? { GIT_PROTOCOL: protocol }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }

  /** Creates a tag on `commit` in the mirror and pushes it with the master's credentials. */
  async pushTag(
    project: string,
    repository: string,
    name: string,
    commit: string,
    message?: string,
  ): Promise<void> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) ||
      name.includes('..')
    )
      throw new Error('Invalid tag name')
    const dir = this.dir(project, repository)
    await this.locked(dir, async () => {
      const env = {
        ...baseEnvironment(),
        GIT_COMMITTER_NAME: 'Mason',
        GIT_COMMITTER_EMAIL: 'mason@localhost',
      }
      await this.git(
        dir,
        message == null
          ? ['tag', '--', name, commit]
          : ['tag', '-a', '-m', message, '--', name, commit],
        env,
      )
      const remote = await this.remote(repository)
      await this.git(
        dir,
        ['push', '--quiet', remote.url, `refs/tags/${name}:refs/tags/${name}`],
        remote.env,
      )
    })
  }

  /** Downloads one LFS object from the repository's LFS server. */
  async lfsObject(
    repository: string,
    oid: string,
    size: number,
  ): Promise<Readable> {
    if (!/^[0-9a-f]{64}$/.test(oid) || !Number.isSafeInteger(size) || size < 0)
      throw new Error('Invalid LFS object')
    const remote = await this.remote(repository)
    if (remote.lfs == null)
      throw new Error(
        'This GitHub connection cannot fetch LFS objects; use a token or GitHub App',
      )
    const response = await fetch(`${remote.lfs.url}/objects/batch`, {
      method: 'POST',
      headers: {
        ...remote.lfs.headers,
        Accept: 'application/vnd.git-lfs+json',
        'Content-Type': 'application/vnd.git-lfs+json',
      },
      body: JSON.stringify({
        operation: 'download',
        transfers: ['basic'],
        objects: [{ oid, size }],
      }),
    })
    if (!response.ok)
      throw new Error(`LFS batch request failed with ${response.status}`)
    const batch = (await response.json()) as {
      objects?: Array<{
        oid: string
        error?: { message?: string }
        actions?: {
          download?: { href: string; header?: Record<string, string> }
        }
      }>
    }
    const object = batch.objects?.find((entry) => entry.oid === oid)
    const download = object?.actions?.download
    if (download == null)
      throw new Error(object?.error?.message ?? 'LFS object unavailable')
    const body = await fetch(download.href, { headers: download.header ?? {} })
    if (!body.ok || body.body == null)
      throw new Error(`LFS download failed with ${body.status}`)
    return Readable.fromWeb(body.body as never)
  }
}
