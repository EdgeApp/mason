import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'

/** An App Store Connect API key: it stays on the master. */
export interface ConnectKey {
  issuerId: string
  keyId: string
  /** The `.p8` private key, PEM. */
  privateKey: string
}

/** Apple's API hosts; tests point them at a fake only with `--test-endpoints`. */
export interface AppleApiBases {
  /** App Store Connect API, e.g. `https://api.appstoreconnect.apple.com`. */
  api: string
  /** The notary web API, e.g. `https://appstoreconnect.apple.com/notary/v2`. */
  notary: string
  /** A fake S3 for notary uploads (tests only); Apple's bucket otherwise. */
  s3?: string
}
export const appleApiBases: AppleApiBases = {
  api: 'https://api.appstoreconnect.apple.com',
  notary: 'https://appstoreconnect.apple.com/notary/v2',
}

/** A refusal from Apple's API, with Apple's own explanation and never the key. */
export class AppleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

/** A JSON:API resource as App Store Connect returns it. */
export interface Resource<A = Record<string, unknown>> {
  type: string
  id: string
  attributes: A
  relationships?: Record<string, { data?: { type: string; id: string } | null }>
}

const TOKEN_SECONDS = 20 * 60

/** An ES256 JWT for App Store Connect: issuer, key ID, audience, twenty minutes. */
export function connectToken(key: ConnectKey, now: number): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const issued = Math.floor(now / 1000)
  const body = `${encode({ alg: 'ES256', kid: key.keyId, typ: 'JWT' })}.${encode(
    {
      iss: key.issuerId,
      iat: issued,
      exp: issued + TOKEN_SECONDS,
      aud: 'appstoreconnect-v1',
    },
  )}`
  const signature = createSign('sha256')
    .update(body)
    .sign({ key: privateKey(key), dsaEncoding: 'ieee-p1363' })
  return `${body}.${signature.toString('base64url')}`
}

const keys = new WeakMap<ConnectKey, KeyObject>()
function privateKey(key: ConnectKey): KeyObject {
  let out = keys.get(key)
  if (out == null) {
    out = createPrivateKey(key.privateKey)
    if (out.asymmetricKeyType !== 'ec')
      throw new Error('An App Store Connect key is an EC (P-256) .p8 key')
    keys.set(key, out)
  }
  return out
}

/** Checks a key the way the settings area stores it. */
export function asConnectKey(value: unknown): ConnectKey {
  const input = (value ?? {}) as Record<string, unknown>
  const issuerId = input.issuerId
  const keyId = input.keyId
  const pem = input.privateKey
  if (
    typeof issuerId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      issuerId,
    )
  )
    throw new Error('issuerId is the App Store Connect issuer ID (a UUID)')
  if (typeof keyId !== 'string' || !/^[A-Z0-9]{10}$/.test(keyId))
    throw new Error('keyId is the ten-character App Store Connect key ID')
  if (typeof pem !== 'string' || !pem.includes('PRIVATE KEY'))
    throw new Error('privateKey is the .p8 key file’s contents')
  const key = { issuerId, keyId, privateKey: pem }
  try {
    privateKey(key)
  } catch {
    throw new Error('privateKey is not an EC (P-256) .p8 key')
  }
  return key
}

/**
 * The App Store Connect API (and the notary API, which takes the same key):
 * JWTs renewed before they expire, JSON:API pagination, and backoff when
 * Apple answers 429.
 */
export class AppStoreConnect {
  private cached: { token: string; until: number } | undefined
  constructor(
    readonly key: ConnectKey,
    private readonly options: {
      bases?: AppleApiBases
      fetch?: typeof fetch
      now?: () => number
      sleep?: (ms: number) => Promise<void>
      /** Attempts for a 429 or 5xx answer before giving up. */
      attempts?: number
    } = {},
  ) {}

  get bases(): AppleApiBases {
    return this.options.bases ?? appleApiBases
  }
  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  token(): string {
    const now = this.now()
    if (this.cached == null || this.cached.until <= now) {
      this.cached = {
        token: connectToken(this.key, now),
        until: now + (TOKEN_SECONDS - 60) * 1000,
      }
    }
    return this.cached.token
  }

  /** One call: `path` is `/v1/…` on the API host, or a full URL. */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    base: keyof AppleApiBases = 'api',
  ): Promise<T> {
    const url = /^https?:/.test(path) ? path : this.bases[base] + path
    const attempts = this.options.attempts ?? 5
    const sleep =
      this.options.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms)))
    for (let attempt = 1; ; attempt++) {
      const response = await (this.options.fetch ?? fetch)(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token()}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120_000),
      })
      const text = await response.text()
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < attempts
      ) {
        const after = Number(response.headers.get('retry-after'))
        await sleep(
          Number.isFinite(after) && after > 0
            ? Math.min(after, 60) * 1000
            : 1000 * 2 ** (attempt - 1),
        )
        continue
      }
      if (!response.ok) throw failure(response.status, text, method, url)
      return (text === '' ? null : JSON.parse(text)) as T
    }
  }

  /** Every page of a collection, following `links.next`. */
  async all<A = Record<string, unknown>>(
    path: string,
  ): Promise<Array<Resource<A>>> {
    const out: Array<Resource<A>> = []
    let next: string | undefined = path
    for (let pages = 0; next != null && pages < 100; pages++) {
      const page: { data: Array<Resource<A>>; links?: { next?: string } } =
        await this.request('GET', next)
      out.push(...page.data)
      next = page.links?.next
    }
    return out
  }
}

/** Apple's error document as a message: title and detail, never the request's token. */
function failure(
  status: number,
  text: string,
  method: string,
  url: string,
): AppleApiError {
  let message = `${method} ${new URL(url).pathname}: HTTP ${status}`
  let code: string | undefined
  try {
    const body = JSON.parse(text) as {
      errors?: Array<{ code?: string; title?: string; detail?: string }>
    }
    const first = body.errors?.[0]
    if (first != null) {
      code = first.code
      message = `${message}: ${[first.title, first.detail].filter(Boolean).join(': ')}`
    }
  } catch {
    if (text !== '') message = `${message}: ${text.slice(0, 300)}`
  }
  return new AppleApiError(status, message, code)
}
