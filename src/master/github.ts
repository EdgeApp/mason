import { execFileSync, spawn } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { baseEnvironment, commitHash } from '../builder/config.js'
import { writePrivate } from '../node/dataDir.js'
import { keepSecret, type SettingValue, type SettingsArea } from './settings.js'

/** How the master reaches GitHub; it is the only node with credentials. */
export type GitHubConnection =
  | { kind: 'token'; token: string }
  | { kind: 'app'; appId: number; installationId: number; privateKey: string }
  | { kind: 'ssh'; privateKey: string; publicKey: string }

export interface GitHubOptions {
  /** API origin, for tests; GitHub's own otherwise. */
  apiBase?: string
  fetch?: typeof fetch
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16384)
    throw new Error(`${name} is required`)
  return value
}

/** A new SSH deploy key: ed25519, made with ssh-keygen. */
export function generateSshKey(): { privateKey: string; publicKey: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mason-ssh-'))
  try {
    const file = path.join(dir, 'key')
    execFileSync(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', 'mason-master', '-f', file],
      { stdio: 'ignore' },
    )
    return {
      privateKey: readFileSync(file, 'utf8'),
      publicKey: readFileSync(file + '.pub', 'utf8').trim(),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function appJwt(appId: number, privateKey: string, now: number): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: appId })}`
  return `${body}.${sign('sha256', Buffer.from(body), createPrivateKey(privateKey)).toString('base64url')}`
}

/** The first two lines git printed, without the command line: why a push failed, in short. */
export function gitReason(error: unknown): string {
  const stderr = String((error as { stderr?: unknown })?.stderr ?? '').trim()
  const text = stderr === '' ? String((error as Error)?.message) : stderr
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('Command failed:'))
    .slice(0, 2)
    .join(' ')
}

/** The `owner/repo` part of a GitHub URL the master can give credentials to, or undefined for any other URL. */
export function githubRepositoryName(repository: string): string | undefined {
  return /^(?:https:\/\/github\.com\/|git@github\.com:)(.+)$/.exec(
    repository,
  )?.[1]
}

/** The master's GitHub connection: credentials, API calls and git access. */
export class GitHub {
  private installation: { token: string; expires: number } | undefined
  constructor(
    private readonly connection: () => GitHubConnection | undefined,
    private readonly options: GitHubOptions = {},
    private readonly now: () => number = Date.now,
  ) {}
  private get api(): string {
    return this.options.apiBase ?? 'https://api.github.com'
  }
  private get fetch(): typeof fetch {
    return this.options.fetch ?? fetch
  }

  /** Checks a token: it must work, and a classic token must carry `repo`. */
  async checkToken(token: string): Promise<void> {
    const response = await this.fetch(`${this.api}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error('GitHub refused the token')
    const scopes = response.headers.get('x-oauth-scopes')
    if (
      scopes != null &&
      !scopes
        .split(',')
        .map((scope) => scope.trim())
        .includes('repo')
    )
      throw new Error('The token needs the repo scope')
  }

  /** An installation token for a GitHub App, cached until shortly before it expires. */
  async installationToken(
    appId: number,
    installationId: number,
    privateKey: string,
  ): Promise<string> {
    if (
      this.installation != null &&
      this.installation.expires > this.now() + 60000
    )
      return this.installation.token
    const response = await this.fetch(
      `${this.api}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt(appId, privateKey, this.now())}`,
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(15000),
      },
    )
    if (!response.ok) throw new Error('GitHub refused the app installation')
    const body = (await response.json()) as {
      token?: unknown
      expires_at?: unknown
    }
    if (typeof body.token !== 'string')
      throw new Error('GitHub returned no installation token')
    this.installation = {
      token: body.token,
      expires:
        typeof body.expires_at === 'string'
          ? Date.parse(body.expires_at)
          : this.now() + 3600000,
    }
    return body.token
  }

  /** The `github` settings area: a token, a GitHub App, or a generated SSH key. */
  area(): SettingsArea {
    return {
      secrets: (value) =>
        value?.kind === 'token' ? ['token'] : ['privateKey'],
      validate: async (input, previous): Promise<SettingValue> => {
        const value = (input ?? {}) as Record<string, unknown>
        if (value.kind === 'token') {
          const token = keepSecret(
            value.token,
            previous?.kind === 'token' ? previous.token : undefined,
            (raw) => text(raw, 'token'),
          )
          if (token == null) throw new Error('token is required')
          await this.checkToken(token)
          return { kind: 'token', token }
        }
        if (value.kind === 'app') {
          const appId = Number(value.appId)
          const installationId = Number(value.installationId)
          if (
            !Number.isSafeInteger(appId) ||
            !Number.isSafeInteger(installationId) ||
            appId < 1 ||
            installationId < 1
          )
            throw new Error('appId and installationId are required')
          // Only an app's own stored key is kept: an SSH deploy key is not one.
          const privateKey = keepSecret(
            value.privateKey,
            previous?.kind === 'app' ? previous.privateKey : undefined,
            (raw) => text(raw, 'privateKey'),
          )
          if (privateKey == null) throw new Error('privateKey is required')
          this.installation = undefined
          await this.installationToken(appId, installationId, privateKey)
          return { kind: 'app', appId, installationId, privateKey }
        }
        if (value.kind === 'ssh') {
          // A new key is made unless the stored one is kept.
          if (
            previous?.kind === 'ssh' &&
            (value.privateKey as { keep?: unknown } | undefined)?.keep === true
          )
            return previous
          return { kind: 'ssh', ...generateSshKey() }
        }
        throw new Error('kind is token, app or ssh')
      },
    }
  }

  /** An API token for the connection; none for an SSH deploy key. */
  private async apiToken(): Promise<string | undefined> {
    const connection = this.connection()
    if (connection == null || connection.kind === 'ssh') return undefined
    return connection.kind === 'token'
      ? connection.token
      : await this.installationToken(
          connection.appId,
          connection.installationId,
          connection.privateKey,
        )
  }

  /**
   * Creates the repository's push webhook to `url` with `secret`. Returns
   * false when the connection has no API access (an SSH deploy key), so an
   * administrator adds it by hand.
   */
  async createWebhook(
    repository: string,
    url: string,
    secret: string,
  ): Promise<boolean> {
    const token = await this.apiToken()
    if (token == null) return false
    const name =
      /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
        repository,
      )?.[1]
    if (name == null) throw new Error('Not a GitHub repository')
    const response = await this.fetch(`${this.api}/repos/${name}/hooks`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push'],
        config: { url, content_type: 'json', secret, insecure_ssl: '0' },
      }),
    })
    if (response.status === 422) {
      // GitHub already has a hook for this URL.
      const body = (await response.json().catch(() => ({}))) as {
        errors?: Array<{ message?: string }>
      }
      if (
        body.errors?.some((error) =>
          /already exists/i.test(error.message ?? ''),
        )
      )
        return true
    }
    if (!response.ok)
      throw new Error(`GitHub refused the webhook (${response.status})`)
    return true
  }

  /**
   * How git reaches a repository: the URL to use and the environment that
   * carries the credential. `run` receives a scratch directory for key files.
   */
  async gitAccess(
    repository: string,
    scratch: string,
  ): Promise<{ url: string; env: NodeJS.ProcessEnv }> {
    const connection = this.connection()
    const name = githubRepositoryName(repository)
    const env: NodeJS.ProcessEnv = {
      ...baseEnvironment(),
      GIT_TERMINAL_PROMPT: '0',
    }
    if (name == null || connection == null) return { url: repository, env }
    if (connection.kind === 'ssh') {
      const key = path.join(scratch, 'github-ssh-key')
      writePrivate(key, connection.privateKey)
      return {
        url: `git@github.com:${name}`,
        env: {
          ...env,
          GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(scratch, 'known_hosts')} -o ConnectTimeout=10`,
        },
      }
    }
    const token =
      connection.kind === 'token'
        ? connection.token
        : await this.installationToken(
            connection.appId,
            connection.installationId,
            connection.privateKey,
          )
    return {
      url: `https://github.com/${name}`,
      env: {
        ...env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      },
    }
  }
}

/** The connection stored in the `github` settings area. */
export function storedConnection(
  value: SettingValue | undefined,
): GitHubConnection | undefined {
  if (value?.kind === 'token' || value?.kind === 'app' || value?.kind === 'ssh')
    return value as unknown as GitHubConnection
  return undefined
}

/** Branch heads of a repository: `git ls-remote --heads`, branches only. */
export async function listHeads(
  url: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', ['ls-remote', '--heads', url], {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    const stop = (): void => {
      if (child.pid != null)
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
    }
    const timer = setTimeout(stop, 60000)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 8 * 1024 * 1024) stop()
    })
    child.once('error', () => reject(new Error('git ls-remote failed')))
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (code !== 0) {
        reject(new Error('Could not list the repository branches'))
        return
      }
      const heads = new Map<string, string>()
      for (const line of output.split('\n')) {
        const [sha, ref] = line.split('\t')
        if (sha == null || ref == null || !ref.startsWith('refs/heads/'))
          continue
        try {
          heads.set(ref.slice(11), commitHash(sha))
        } catch {
          /* not a commit */
        }
      }
      resolve(heads)
    })
  })
}
