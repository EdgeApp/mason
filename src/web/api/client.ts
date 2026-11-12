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
  /**
   * Where a 401 sends the browser: `/sign-in` on the master, `/auth/login`
   * on the host; a function is asked at the time, for the current address.
   */
  signIn: string | (() => string)
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

/**
 * Whether a software keyboard covers part of the page: it shrinks the visual
 * viewport but not the layout viewport, while a pinch zoom shrinks the
 * visual viewport by exactly its scale.
 */
export const keyboardUp = (
  viewport: Pick<VisualViewport, 'height' | 'scale'>,
  layoutHeight: number,
): boolean => viewport.height * viewport.scale < layoutHeight - 1

/**
 * Calls `then` once no software keyboard is up: at once when there is none,
 * otherwise after the focused field gives it up (at most `wait` ms later).
 * iOS Safari carries a keyboard that is up into the next page's load and
 * lands that page scrolled about 40 px under its sticky top bar.
 */
export function afterKeyboard(then: () => void, wait = 1000): void {
  const viewport = globalThis.visualViewport
  const focused = globalThis.document?.activeElement
  const up = (): boolean =>
    viewport != null &&
    keyboardUp(viewport, document.documentElement.clientHeight)
  if (
    viewport == null ||
    !(focused instanceof HTMLElement) ||
    focused === document.body ||
    !up()
  ) {
    then()
    return
  }
  const finish = (): void => {
    viewport.removeEventListener('resize', settle)
    clearTimeout(timer)
    then()
  }
  const settle = (): void => {
    if (!up()) finish()
  }
  viewport.addEventListener('resize', settle)
  const timer = setTimeout(finish, wait)
  focused.blur()
}

/**
 * How both nodes refuse a change whose CSRF proof is not the session's (403,
 * with this message): one kept from a session another tab has since replaced.
 */
const STALE_PROOF = 'Invalid request proof'

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

  /**
   * Leaves the app with a full document load (sign-in after signing out),
   * so the page it goes to runs under its own CSP; with a phone's keyboard
   * up, once it is down.
   */
  leave(url: string): void {
    afterKeyboard(() => this.navigate(url))
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
    return await this.send(method, path, cleaner, options, true)
  }

  /**
   * Sends one request; a change refused for a stale proof reads the session
   * again and, when `retry`, is sent once more with its new proof.
   */
  private async send<T>(
    method: Method,
    path: string,
    cleaner: Cleaner<T>,
    options: RequestOptions,
    retry: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const proven = method !== 'GET' && options.csrf !== false
    if (proven) {
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
        if (options.redirect !== false)
          this.navigate(
            typeof this.options.signIn === 'string'
              ? this.options.signIn
              : this.options.signIn(),
          )
      }
      const reason = asMaybe(asErrorBody)(value)
      if (proven && response.status === 403 && reason?.error === STALE_PROOF) {
        this.csrf = undefined
        if (retry) return await this.send(method, path, cleaner, options, false)
      }
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
