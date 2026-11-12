// The web app's only way to its node's JSON API. Every answer goes through
// the shared contract's cleaner (src/shared/api), so an answer the app does
// not understand is a ContractError rather than garbage on the page.
import { asMaybe, asNull, type Cleaner } from 'cleaners'
import type { ArgonParameters } from '../../auth/passwordProtocol.js'
import {
  asErrorBody,
  asSessionInfo,
  asSessionParameters,
  asSignInReply,
  CSRF_HEADER,
  SESSION_PARAMETERS_PATH,
  SESSION_PATH,
  type SessionInfo,
  type SignInReply,
} from '../../shared/api/index.js'

/** A request the node refused or never answered: its status (0 when unreachable), message and, for a lock, when to retry. */
export class ApiError extends Error {
  override name = 'ApiError'
  constructor(
    readonly status: number,
    message: string,
    readonly retryAt?: number,
  ) {
    super(message)
  }
}

/** An answer that does not match the shared contract: the node and the app disagree. */
export class ContractError extends ApiError {
  override name = 'ContractError'
}

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface ApiClientOptions {
  /** Where a 401 sends the browser: `/sign-in` on the master, `/auth/login` on the host. */
  signIn: string
  /** The page's fetch; a test supplies its own. */
  fetch?: typeof fetch
  /** How the browser leaves for sign-in: a full load, so its own CSP applies. */
  navigate?: (url: string) => void
}

export interface RequestOptions {
  /** A JSON body. */
  body?: unknown
  /** Whether a 401 leaves for sign-in; the sign-in page itself says no. */
  redirect?: boolean
  /** Whether a non-`GET` sends the session's CSRF proof; sign-in has none yet. */
  csrf?: boolean
  signal?: AbortSignal
}

/** The typed client: CSRF proof from the session, cleaners on every answer. */
export class ApiClient {
  private csrf: string | undefined
  private readonly fetch: typeof fetch
  private readonly navigate: (url: string) => void

  constructor(private readonly options: ApiClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.navigate =
      options.navigate ?? ((url): void => window.location.assign(url))
  }

  async get<T>(
    path: string,
    cleaner: Cleaner<T>,
    options: Omit<RequestOptions, 'body' | 'csrf'> = {},
  ): Promise<T> {
    return await this.request('GET', path, cleaner, options)
  }

  async post<T>(
    path: string,
    cleaner: Cleaner<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    return await this.request('POST', path, cleaner, options)
  }

  async put<T>(
    path: string,
    cleaner: Cleaner<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    return await this.request('PUT', path, cleaner, options)
  }

  async delete<T>(
    path: string,
    cleaner: Cleaner<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    return await this.request('DELETE', path, cleaner, options)
  }

  /** Reads the session, and keeps its CSRF proof for the requests that change something. */
  async session(
    options: Omit<RequestOptions, 'body' | 'csrf'> = {},
  ): Promise<SessionInfo> {
    const session = await this.get(SESSION_PATH, asSessionInfo, options)
    this.csrf = session.csrf
    return session
  }

  /** The Argon2id parameters to hash a username's or an email's password with. */
  async parameters(identifier: string): Promise<ArgonParameters> {
    return await this.post(SESSION_PARAMETERS_PATH, asSessionParameters, {
      body: { identifier },
      csrf: false,
      redirect: false,
    })
  }

  /** Signs in with the password's client hash; the cookie is the node's. */
  async signIn(identifier: string, clientHash: string): Promise<SignInReply> {
    const reply = await this.post(SESSION_PATH, asSignInReply, {
      body: { identifier, clientHash },
      csrf: false,
      redirect: false,
    })
    this.csrf = reply.csrf
    return reply
  }

  /** Ends the session on this node. */
  async signOut(): Promise<void> {
    await this.delete(SESSION_PATH, asNull)
    this.csrf = undefined
  }

  async request<T>(
    method: Method,
    path: string,
    cleaner: Cleaner<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (method !== 'GET' && options.csrf !== false) {
      this.csrf ??= (
        await this.session({
          redirect: options.redirect !== false,
          ...(options.signal == null ? {} : { signal: options.signal }),
        })
      ).csrf
      headers[CSRF_HEADER] = this.csrf
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await this.fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        ...(options.signal == null ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      throw new ApiError(0, 'Mason could not be reached; try again shortly')
    }
    const text = await response.text()
    let value: unknown
    try {
      value = text === '' ? undefined : JSON.parse(text)
    } catch {
      value = undefined
    }
    if (!response.ok) {
      if (response.status === 401) {
        this.csrf = undefined
        if (options.redirect !== false) this.navigate(this.options.signIn)
      }
      const reason = asMaybe(asErrorBody)(value)
      throw new ApiError(
        response.status,
        reason?.error ??
          (response.statusText === ''
            ? `The request failed (${response.status})`
            : response.statusText),
        reason?.retryAt,
      )
    }
    try {
      return cleaner(value)
    } catch (error) {
      throw new ContractError(
        response.status,
        `${method} ${path} answered something this app does not understand: ${(error as Error).message}`,
      )
    }
  }
}
