import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { MasterDatabase } from '../database.js'

/**
 * The master's Apple ID session for Xcode downloads. Apple serves `.xip`
 * files only to a signed-in Apple ID, so the master signs in (SRP with
 * Apple's `s2k` password derivation, then two-factor), keeps the session,
 * lists Xcode releases, and for each install obtains the download-only
 * `ADCDownloadAuth` cookie for one file. Only that cookie reaches a node.
 * The flow is the one the open-source `xcodes` tool uses.
 */

export interface AppleEndpoints {
  /** https://idmsa.apple.com */
  idmsa: string
  /** https://appstoreconnect.apple.com */
  olympus: string
  /** https://developer.apple.com */
  developer: string
  /** https://download.developer.apple.com */
  download: string
}

export const appleEndpoints: AppleEndpoints = {
  idmsa: 'https://idmsa.apple.com',
  olympus: 'https://appstoreconnect.apple.com',
  developer: 'https://developer.apple.com',
  download: 'https://download.developer.apple.com',
}

// SRP-6a over the RFC 5054 2048-bit group with SHA-256, as Apple's GSA uses it:
// padded `k` and `u`, and no account name inside `x`.
export const srpN = BigInt(
  '0xAC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73',
)
export const srpG = 2n
const width = 256

export function toBytes(n: bigint): Buffer {
  let hex = n.toString(16)
  if (hex.length % 2 === 1) hex = '0' + hex
  return Buffer.from(hex, 'hex')
}
export const fromBytes = (bytes: Buffer): bigint =>
  bytes.length === 0 ? 0n : BigInt('0x' + bytes.toString('hex'))
const pad = (n: bigint): Buffer => {
  const bytes = toBytes(n)
  return Buffer.concat([Buffer.alloc(width - bytes.length), bytes])
}
export const sha256 = (...parts: Array<Buffer | string>): Buffer => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}
export function modPow(
  base: bigint,
  exponent: bigint,
  modulus: bigint,
): bigint {
  let result = 1n
  let b = base % modulus
  let e = exponent
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % modulus
    e >>= 1n
    b = (b * b) % modulus
  }
  return result
}
export const srpK = fromBytes(sha256(pad(srpN), pad(srpG)))
export const srpU = (A: bigint, B: bigint): bigint =>
  fromBytes(sha256(pad(A), pad(B)))
export const srpX = (salt: Buffer, password: Buffer): bigint =>
  fromBytes(sha256(salt, sha256(':', password)))

/** M1 = H(H(N) xor H(g) | H(I) | s | A | B | K). */
export function srpM1(
  account: string,
  salt: Buffer,
  A: bigint,
  B: bigint,
  K: Buffer,
): Buffer {
  const hN = sha256(toBytes(srpN))
  const hg = sha256(pad(srpG))
  const xor = Buffer.from(hN.map((byte, i) => byte ^ hg[i]!))
  return sha256(xor, sha256(account), salt, toBytes(A), toBytes(B), K)
}
export const srpM2 = (A: bigint, M1: Buffer, K: Buffer): Buffer =>
  sha256(toBytes(A), M1, K)

/** Apple's password derivation: PBKDF2-SHA256 of the password's SHA-256 (hex for `s2k_fo`). */
export function derivePassword(
  password: string,
  protocol: string,
  salt: Buffer,
  iterations: number,
): Buffer {
  const digest = sha256(password)
  const input =
    protocol === 's2k_fo' ? Buffer.from(digest.toString('hex')) : digest
  return pbkdf2Sync(input, salt, iterations, 32, 'sha256')
}

/** The client half of one SRP exchange. */
export function srpClient(random = (): Buffer => randomBytes(32)): {
  A: bigint
  proof(
    account: string,
    salt: Buffer,
    password: Buffer,
    B: bigint,
  ): { M1: Buffer; M2: Buffer }
} {
  const a = fromBytes(random())
  const A = modPow(srpG, a, srpN)
  return {
    A,
    proof(account, salt, password, B): { M1: Buffer; M2: Buffer } {
      if (B % srpN === 0n) throw new Error('Apple sent an invalid SRP value')
      const u = srpU(A, B)
      const x = srpX(salt, password)
      const base =
        (((B - ((srpK * modPow(srpG, x, srpN)) % srpN)) % srpN) + srpN) % srpN
      const S = modPow(base, a + u * x, srpN)
      const K = sha256(toBytes(S))
      const M1 = srpM1(account, salt, A, B, K)
      return { M1, M2: srpM2(A, M1, K) }
    },
  }
}

/** Apple's proof of work: `1:bits:date:challenge::counter` whose SHA-1 starts with `bits` zero bits. */
export function hashcash(
  bits: number,
  challenge: string,
  now = new Date(),
): string {
  const date = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  for (let counter = 0; ; counter++) {
    const stamp = `1:${bits}:${date}:${challenge}::${counter}`
    const digest = createHash('sha1').update(stamp).digest()
    let zero = 0
    for (const byte of digest) {
      if (byte === 0) {
        zero += 8
        continue
      }
      zero += Math.clz32(byte) - 24
      break
    }
    if (zero >= bits) return stamp
  }
}

interface Cookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  expires?: number
}

/** Just enough of a cookie jar for Apple's sign-in and download flow. */
export class CookieJar {
  cookies: Cookie[]
  constructor(cookies: Cookie[] = []) {
    this.cookies = cookies
  }
  store(url: URL, headers: Headers, now: number): void {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';')
      const eq = pair!.indexOf('=')
      if (eq <= 0) continue
      const cookie: Cookie = {
        name: pair!.slice(0, eq).trim(),
        value: pair!.slice(eq + 1).trim(),
        domain: url.hostname,
        hostOnly: true,
        path: '/',
      }
      let foreign = false
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.split('=')
        const value = rest.join('=').trim()
        switch (key!.trim().toLowerCase()) {
          case 'domain': {
            const domain = value.replace(/^\./, '').toLowerCase()
            // A cookie for another site is dropped, as browsers do.
            if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`))
              foreign = true
            cookie.domain = domain
            cookie.hostOnly = false
            break
          }
          case 'path':
            cookie.path = value === '' ? '/' : value
            break
          case 'max-age':
            cookie.expires = now + Number(value) * 1000
            break
          case 'expires':
            cookie.expires ??= Date.parse(value)
            break
        }
      }
      if (foreign) continue
      this.cookies = this.cookies.filter(
        (old) =>
          !(
            old.name === cookie.name &&
            old.domain === cookie.domain &&
            old.path === cookie.path
          ),
      )
      if (cookie.expires == null || cookie.expires > now)
        this.cookies.push(cookie)
    }
  }
  header(url: URL, now: number): string {
    return this.cookies
      .filter(
        (cookie) =>
          (cookie.expires == null || cookie.expires > now) &&
          (cookie.hostOnly
            ? url.hostname === cookie.domain
            : url.hostname === cookie.domain ||
              url.hostname.endsWith(`.${cookie.domain}`)) &&
          url.pathname.startsWith(cookie.path),
      )
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
  }
  get(name: string): string | undefined {
    return this.cookies.find((cookie) => cookie.name === name)?.value
  }
}

/** An Xcode release Apple offers. */
export interface AppleXcode {
  /** `26.1`, `26.2-beta3`, `26.1-rc`. */
  version: string
  beta: boolean
  /** The `.xip`'s path on download.developer.apple.com. */
  remotePath: string
  size?: number
}

/** `Xcode 26.2 beta 3` → `26.2-beta3`; anything that is not an Xcode is skipped. */
export function xcodeVersionOf(name: string): string | undefined {
  const match =
    /^Xcode (\d+(?:\.\d+){0,2})(?: (beta|Release Candidate|RC)(?: (\d+))?)?$/i.exec(
      name.trim(),
    )
  if (match == null) return undefined
  const [, version, kind, n] = match
  if (kind == null) return version
  return /beta/i.test(kind)
    ? `${version}-beta${n ?? ''}`
    : `${version}-rc${n ?? ''}`
}

export type AppleState =
  | 'signedOut'
  | 'needsCode'
  | 'signedIn'
  | 'expired'
  | 'failed'

export interface AppleStatus {
  appleId?: string
  state: AppleState
  /** When the state last changed. */
  since?: number
  /** Why a person must act, for the API, `mason status` and the dashboard. */
  notice?: string
  /** How Apple delivers the code: a trusted device, or a text to a number ending in these digits. */
  codeVia?: string
  error?: string
}

/** What is stored encrypted: never in settings, the change log or a stage snapshot. */
interface Stored {
  appleId: string
  password: string
  cookies: Cookie[]
  state: AppleState
  since: number
  error?: string
  /** Headers Apple's two-factor calls need between sign-in and the code. */
  pending?: {
    sessionId: string
    scnt: string
    widgetKey: string
    phoneId?: number
    codeVia: string
  }
}

export class AppleError extends Error {}

/** AES-256-GCM under a key file in the master's data directory. */
class Box {
  constructor(private readonly keyFile: string) {}
  private key(): Buffer {
    if (!existsSync(this.keyFile)) {
      mkdirSync(path.dirname(this.keyFile), { recursive: true, mode: 0o700 })
      writeFileSync(this.keyFile, randomBytes(32).toString('base64') + '\n', {
        mode: 0o600,
        flag: 'wx',
      })
    }
    return Buffer.from(readFileSync(this.keyFile, 'utf8').trim(), 'base64')
  }
  seal(value: unknown): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv)
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ])
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
  }
  open(text: string): unknown {
    const data = Buffer.from(text, 'base64')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      data.subarray(0, 12),
    )
    decipher.setAuthTag(data.subarray(12, 28))
    return JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString(),
    )
  }
}

const META = 'apple_session'

export interface AppleOptions {
  endpoints?: AppleEndpoints
  /** The key that encrypts the stored session: `<data>/apple.key`. */
  keyFile: string
  /** How often the session is checked; six hours. */
  checkMs?: number
  onChange?: (status: AppleStatus) => void
}

export class AppleDownloads {
  private readonly endpoints: AppleEndpoints
  private readonly box: Box
  private releases: { at: number; list: AppleXcode[] } | undefined
  private timer: NodeJS.Timeout | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly master: MasterDatabase,
    private readonly options: AppleOptions,
  ) {
    this.endpoints = options.endpoints ?? appleEndpoints
    this.box = new Box(options.keyFile)
  }

  start(): void {
    this.timer = setInterval(
      () => {
        void this.check().catch(() => undefined)
      },
      this.options.checkMs ?? 6 * 60 * 60 * 1000,
    )
    this.timer.unref()
  }
  stop(): void {
    clearInterval(this.timer)
  }

  /** One Apple operation at a time: they share the cookie jar. */
  private serial<T>(body: () => Promise<T>): Promise<T> {
    const next = this.queue.then(body, body)
    this.queue = next.catch(() => undefined)
    return next
  }

  private load(): Stored | undefined {
    const row = this.master.db
      .prepare('SELECT value FROM meta WHERE key=?')
      .get(META) as { value: string } | undefined
    if (row == null) return undefined
    try {
      return this.box.open(row.value) as Stored
    } catch {
      // The key file is gone (a restored backup): sign in again.
      return undefined
    }
  }
  private save(stored: Stored | undefined): void {
    if (stored == null)
      this.master.db.prepare('DELETE FROM meta WHERE key=?').run(META)
    else
      this.master.db
        .prepare(
          'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(META, this.box.seal(stored))
    this.options.onChange?.(this.status())
  }
  private setState(
    stored: Stored,
    state: AppleState,
    error?: string,
  ): AppleStatus {
    if (stored.state !== state) stored.since = this.master.now()
    stored.state = state
    if (error == null) delete stored.error
    else stored.error = error
    if (state !== 'needsCode') delete stored.pending
    this.save(stored)
    return this.status()
  }

  status(): AppleStatus {
    const stored = this.load()
    if (stored == null) return { state: 'signedOut' }
    const notice: Partial<Record<AppleState, string>> = {
      needsCode: `Apple asks for a two-factor code for ${stored.appleId}: enter it with mason apple sign-in or on the Settings page`,
      expired: `The Apple ID session for ${stored.appleId} has lapsed: sign in again with mason apple sign-in`,
      failed: `Apple refused the sign-in for ${stored.appleId}: ${stored.error ?? ''}`,
    }
    return {
      appleId: stored.appleId,
      state: stored.state,
      since: stored.since,
      ...(notice[stored.state] == null ? {} : { notice: notice[stored.state] }),
      ...(stored.pending == null ? {} : { codeVia: stored.pending.codeVia }),
      ...(stored.error == null ? {} : { error: stored.error }),
    }
  }

  /** Whether Xcode downloads can be authorized now. */
  ready(): boolean {
    return this.load()?.state === 'signedIn'
  }

  private async request(
    stored: Stored,
    url: string,
    init: {
      method?: string
      headers?: Record<string, string>
      body?: unknown
    } = {},
  ): Promise<Response> {
    const jar = new CookieJar(stored.cookies)
    let target = new URL(url)
    for (let hop = 0; hop < 6; hop++) {
      const response = await fetch(target, {
        method: init.method ?? 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mason',
          ...(init.body == null ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
          ...(jar.header(target, this.master.now()) === ''
            ? {}
            : { Cookie: jar.header(target, this.master.now()) }),
        },
        ...(init.body == null
          ? {}
          : {
              body:
                typeof init.body === 'string'
                  ? init.body
                  : JSON.stringify(init.body),
            }),
      })
      jar.store(target, response.headers, this.master.now())
      stored.cookies = jar.cookies
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location != null) {
        await response.body?.cancel()
        target = new URL(location, target)
        if (/\/unauthorized/.test(target.pathname))
          return new Response(null, { status: 401 })
        init = { ...init, method: 'GET', body: undefined }
        continue
      }
      return response
    }
    throw new AppleError('Apple redirected too many times')
  }

  /**
   * Stores the Apple ID and password and signs in. Apple usually asks for
   * a two-factor code next; `submitCode` completes the sign-in.
   */
  async signIn(appleId: string, password: string): Promise<AppleStatus> {
    if (!/^[^\s@]+@[^\s@]+$/.test(appleId))
      throw new AppleError('An Apple ID is an email address')
    if (password === '') throw new AppleError('The password is empty')
    return await this.serial(async () => {
      const stored: Stored = {
        appleId,
        password,
        cookies: [],
        state: 'signedOut',
        since: this.master.now(),
      }
      return await this.authenticate(stored)
    })
  }

  /**
   * Apple's sign-in widget key. App Store Connect names it in the redirect
   * its sign-out page answers with; that request carries no session cookies
   * and the redirect is not followed, since following it signs out. The
   * older configuration endpoint is the fallback.
   */
  private async widgetKey(stored: Stored): Promise<string> {
    const { olympus } = this.endpoints
    const signout = await fetch(`${olympus}/logout`, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'Mason' },
    })
    const location = signout.headers.get('location')
    const key =
      location == null
        ? null
        : URL.parse(location)?.searchParams.get('widgetKey')
    if (key != null && key !== '') return key
    const config = await this.request(
      stored,
      `${olympus}/olympus/v1/app/config?hostname=itunesconnect.apple.com`,
    )
    if (!config.ok)
      throw new AppleError(
        `Apple's sign-in configuration failed (${config.status})`,
      )
    const configured = String(
      ((await config.json()) as { authServiceKey?: unknown }).authServiceKey ??
        '',
    )
    if (configured === '')
      throw new AppleError("Apple's sign-in configuration has no widget key")
    return configured
  }

  private async authenticate(stored: Stored): Promise<AppleStatus> {
    const { idmsa } = this.endpoints
    const widgetKey = await this.widgetKey(stored)
    const probe = await this.request(
      stored,
      `${idmsa}/appleauth/auth/signin?widgetKey=${encodeURIComponent(widgetKey)}`,
    )
    await probe.body?.cancel()
    const bits = Number(probe.headers.get('x-apple-hc-bits'))
    const challenge = probe.headers.get('x-apple-hc-challenge')
    const headers: Record<string, string> = {
      Accept: 'application/json, text/javascript',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Apple-Widget-Key': widgetKey,
    }
    const client = srpClient()
    const init = await this.request(
      stored,
      `${idmsa}/appleauth/auth/signin/init`,
      {
        method: 'POST',
        headers,
        body: {
          a: toBytes(client.A).toString('base64'),
          accountName: stored.appleId,
          protocols: ['s2k', 's2k_fo'],
        },
      },
    )
    if (!init.ok)
      return this.setState(
        stored,
        'failed',
        `Apple refused the sign-in (${init.status})`,
      )
    const offer = (await init.json()) as {
      iteration: number
      salt: string
      protocol: string
      b: string
      c: string
    }
    const salt = Buffer.from(offer.salt, 'base64')
    const { M1, M2 } = client.proof(
      stored.appleId,
      salt,
      derivePassword(stored.password, offer.protocol, salt, offer.iteration),
      fromBytes(Buffer.from(offer.b, 'base64')),
    )
    const complete = await this.request(
      stored,
      `${idmsa}/appleauth/auth/signin/complete?isRememberMeEnabled=false`,
      {
        method: 'POST',
        headers: {
          ...headers,
          ...(challenge == null || !Number.isFinite(bits)
            ? {}
            : { 'X-Apple-HC': hashcash(bits, challenge) }),
        },
        body: {
          accountName: stored.appleId,
          c: offer.c,
          m1: M1.toString('base64'),
          m2: M2.toString('base64'),
          rememberMe: false,
        },
      },
    )
    await complete.body?.cancel()
    const sessionId = complete.headers.get('x-apple-id-session-id') ?? ''
    const scnt = complete.headers.get('scnt') ?? ''
    if (complete.status === 401 || complete.status === 403)
      return this.setState(stored, 'failed', 'Wrong Apple ID or password')
    if (complete.status === 409) {
      // Two-factor: Apple pushes a code to trusted devices, or texts it.
      const twoFactor = { ...headers, 'X-Apple-ID-Session-Id': sessionId, scnt }
      const options = (await (
        await this.request(stored, `${idmsa}/appleauth/auth`, {
          headers: twoFactor,
        })
      ).json()) as {
        noTrustedDevices?: boolean
        trustedPhoneNumbers?: Array<{ id: number; numberWithDialCode?: string }>
      }
      let phoneId: number | undefined
      let codeVia = 'a trusted device'
      const phone = options.trustedPhoneNumbers?.[0]
      if (options.noTrustedDevices === true && phone != null) {
        phoneId = phone.id
        codeVia = `a text to the number ending ${String(phone.numberWithDialCode ?? '').slice(-2)}`
        const sent = await this.request(
          stored,
          `${idmsa}/appleauth/auth/verify/phone`,
          {
            method: 'PUT',
            headers: twoFactor,
            body: { phoneNumber: { id: phone.id }, mode: 'sms' },
          },
        )
        await sent.body?.cancel()
      }
      stored.pending = {
        sessionId,
        scnt,
        widgetKey,
        codeVia,
        ...(phoneId == null ? {} : { phoneId }),
      }
      return this.setState(stored, 'needsCode')
    }
    if (!complete.ok)
      return this.setState(
        stored,
        'failed',
        `Apple refused the sign-in (${complete.status})`,
      )
    return await this.finish(stored)
  }

  /** Completes two-factor with the code Apple sent. */
  async submitCode(code: string): Promise<AppleStatus> {
    if (!/^\d{6}$/.test(code)) throw new AppleError('The code is six digits')
    return await this.serial(async () => {
      const stored = this.load()
      if (stored?.state !== 'needsCode' || stored.pending == null)
        throw new AppleError('No sign-in is waiting for a code')
      const { idmsa } = this.endpoints
      const headers = {
        Accept: 'application/json, text/javascript',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Apple-Widget-Key': stored.pending.widgetKey,
        'X-Apple-ID-Session-Id': stored.pending.sessionId,
        scnt: stored.pending.scnt,
      }
      const verify =
        stored.pending.phoneId == null
          ? await this.request(
              stored,
              `${idmsa}/appleauth/auth/verify/trusteddevice/securitycode`,
              { method: 'POST', headers, body: { securityCode: { code } } },
            )
          : await this.request(
              stored,
              `${idmsa}/appleauth/auth/verify/phone/securitycode`,
              {
                method: 'POST',
                headers,
                body: {
                  securityCode: { code },
                  phoneNumber: { id: stored.pending.phoneId },
                  mode: 'sms',
                },
              },
            )
      await verify.body?.cancel()
      if (!verify.ok) {
        this.save(stored)
        throw new AppleError(`Apple did not accept the code (${verify.status})`)
      }
      const trust = await this.request(
        stored,
        `${idmsa}/appleauth/auth/2sv/trust`,
        {
          headers,
        },
      )
      await trust.body?.cancel()
      return await this.finish(stored)
    })
  }

  /** Opens the developer session and checks that downloads are listed. */
  private async finish(stored: Stored): Promise<AppleStatus> {
    const session = await this.request(
      stored,
      `${this.endpoints.olympus}/olympus/v1/session`,
    )
    await session.body?.cancel()
    const list = await this.fetchReleases(stored)
    if (list == null)
      return this.setState(
        stored,
        'failed',
        'Signed in, but Apple lists no downloads for this Apple ID',
      )
    this.releases = { at: this.master.now(), list }
    return this.setState(stored, 'signedIn')
  }

  async signOut(): Promise<void> {
    await this.serial(async () => {
      this.releases = undefined
      this.save(undefined)
    })
  }

  private async fetchReleases(
    stored: Stored,
  ): Promise<AppleXcode[] | undefined> {
    const response = await this.request(
      stored,
      `${this.endpoints.developer}/services-account/QH65B2/downloadws/listDownloads.action`,
      { method: 'POST', body: '' },
    )
    if (!response.ok) return undefined
    const body = (await response.json()) as {
      resultCode?: number
      downloads?: Array<{
        name?: string
        files?: Array<{ remotePath?: string; fileSize?: number }>
      }>
    }
    if (body.resultCode !== 0 || body.downloads == null) return undefined
    const out: AppleXcode[] = []
    for (const download of body.downloads) {
      const version = xcodeVersionOf(String(download.name ?? ''))
      const file = download.files?.find((entry) =>
        /\.xip$/.test(entry.remotePath ?? ''),
      )
      if (version == null || file?.remotePath == null) continue
      out.push({
        version,
        beta: /-(beta|rc)/.test(version),
        remotePath: file.remotePath,
        ...(file.fileSize == null ? {} : { size: file.fileSize }),
      })
    }
    return out
  }

  /** Checks the session; a lapsed one is renewed with the stored password, which usually needs a code. */
  async check(): Promise<AppleStatus> {
    return await this.serial(async () => {
      const stored = this.load()
      if (stored == null || stored.state !== 'signedIn') return this.status()
      const list = await this.fetchReleases(stored)
      if (list != null) {
        this.releases = { at: this.master.now(), list }
        this.save(stored)
        return this.status()
      }
      return await this.renew(stored)
    })
  }

  private async renew(stored: Stored): Promise<AppleStatus> {
    this.releases = undefined
    stored.cookies = stored.cookies.filter((cookie) =>
      // Apple's device trust cookie can spare the next code.
      /^(dslang|site|DES[0-9a-f]+)$/i.test(cookie.name),
    )
    const status = await this.authenticate(stored).catch((error: unknown) =>
      this.setState(stored, 'expired', (error as Error).message),
    )
    return status.state === 'signedIn' || status.state === 'needsCode'
      ? status
      : this.setState(stored, 'expired', status.error)
  }

  /** Xcode releases Apple offers, refreshed hourly. */
  async xcodes(): Promise<AppleXcode[]> {
    if (
      this.releases != null &&
      this.master.now() - this.releases.at < 60 * 60 * 1000
    )
      return this.releases.list
    await this.check()
    return this.releases?.list ?? []
  }

  /** Releases known without asking Apple, for placement decisions. */
  cachedXcodes(): AppleXcode[] {
    return this.releases?.list ?? []
  }

  /**
   * Obtains the download-only authorization for one Xcode: the
   * `ADCDownloadAuth` cookie Apple issues for that file, and its URL.
   * Nothing else of the session leaves the master.
   */
  async authorize(
    version: string,
  ): Promise<{ url: string; cookie: string; size?: number }> {
    const release = (await this.xcodes()).find(
      (entry) => entry.version === version,
    )
    return await this.serial(async () => {
      const stored = this.load()
      if (stored?.state !== 'signedIn')
        throw new AppleError(
          this.status().notice ??
            'No Apple ID is signed in: run mason apple sign-in',
        )
      if (release == null)
        throw new AppleError(`Apple offers no Xcode ${version}`)
      const response = await this.request(
        stored,
        `${this.endpoints.developer}/devcenter/download.action?path=${encodeURIComponent(release.remotePath)}`,
      )
      await response.body?.cancel()
      const jar = new CookieJar(stored.cookies)
      const auth = jar.get('ADCDownloadAuth')
      // The authorization belongs to the node; the master does not keep it.
      stored.cookies = stored.cookies.filter(
        (cookie) => cookie.name !== 'ADCDownloadAuth',
      )
      if (response.status === 401 || auth == null) {
        await this.renew(stored)
        throw new AppleError(
          this.status().notice ?? 'Apple refused the download authorization',
        )
      }
      this.save(stored)
      return {
        url: `${this.endpoints.download}${release.remotePath}`,
        cookie: `ADCDownloadAuth=${auth}`,
        ...(release.size == null ? {} : { size: release.size }),
      }
    })
  }
}

/** The `apple` settings area holds the Apple ID only; the password goes through sign-in. */
export function appleSetting(input: unknown): Record<string, unknown> {
  const value = (input ?? {}) as { appleId?: unknown }
  if (value.appleId == null) return {}
  if (
    typeof value.appleId !== 'string' ||
    !/^[^\s@]+@[^\s@]+$/.test(value.appleId)
  )
    throw new Error('appleId is an email address')
  return { appleId: value.appleId }
}
