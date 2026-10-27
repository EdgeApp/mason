import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  derivePassword,
  fromBytes,
  modPow,
  sha256,
  srpG,
  srpK,
  srpM1,
  srpM2,
  srpN,
  srpU,
  srpX,
  toBytes,
  type AppleEndpoints,
} from '../master/apple/developerDownloads.js'

/**
 * Apple's sign-in, two-factor and download services as the master uses
 * them, checked the way Apple checks them: the SRP proof against a verifier,
 * the hashcash stamp, the two-factor code, the session cookie for the
 * download list and the per-file `ADCDownloadAuth` cookie for a `.xip`.
 */
export class FakeApple {
  server!: Server
  endpoints!: AppleEndpoints
  readonly code = '123456'
  /** Xcode releases offered, with each `.xip`'s contents (`xcode:<version>:<build>`). */
  readonly xcodes = new Map<string, { name: string; build: string }>([
    ['26.1', { name: 'Xcode 26.1', build: '17B55' }],
    ['26.2-beta3', { name: 'Xcode 26.2 beta 3', build: '17C5013d' }],
  ])
  /** Cookie headers each `.xip` download arrived with. */
  readonly downloadCookies: string[] = []
  readonly signIns: string[] = []
  twoFactor = true
  /** Where the widget key comes from: the sign-out redirect (today), the older configuration endpoint, a configuration without it, or nowhere. */
  widgetKeyFrom: 'signout' | 'config' | 'empty' | 'gone' = 'signout'
  /** Cookie headers the sign-out request arrived with. */
  readonly signoutCookies: string[] = []
  private salt = randomBytes(16)
  private verifier: bigint
  private pending = new Map<string, { b: bigint; B: bigint; A: bigint }>()
  private sessions = new Set<string>()
  private downloads = new Map<string, string>()
  private trusted = false

  constructor(
    readonly appleId: string,
    password: string,
  ) {
    const p = derivePassword(password, 's2k', this.salt, 1000)
    this.verifier = modPow(srpG, srpX(this.salt, p), srpN)
  }

  /** Ends every session, as Apple does every few weeks. */
  expire(): void {
    this.sessions.clear()
    this.trusted = false
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body, headers }) => {
          res.writeHead(status, {
            'Content-Type': 'application/json',
            ...headers,
          })
          res.end(
            body == null
              ? ''
              : typeof body === 'string'
                ? body
                : JSON.stringify(body),
          )
        },
        (error: unknown) => {
          res.writeHead(500)
          res.end(String(error))
        },
      )
    })
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    )
    const base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    this.endpoints = {
      idmsa: base,
      olympus: base,
      developer: base,
      download: base,
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private cookie(req: IncomingMessage, name: string): string | undefined {
    return new RegExp(`(?:^|; )${name}=([^;]+)`).exec(
      req.headers.cookie ?? '',
    )?.[1]
  }

  private async handle(req: IncomingMessage): Promise<{
    status: number
    body?: unknown
    headers?: Record<string, string | string[]>
  }> {
    const url = new URL(req.url ?? '/', 'http://apple')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString()
    const body = (text === '' ? {} : JSON.parse(text)) as Record<string, never>
    const session = this.cookie(req, 'myacinfo')
    const signedIn = session != null && this.sessions.has(session)
    switch (url.pathname) {
      case '/logout':
        this.signoutCookies.push(req.headers.cookie ?? '')
        return {
          status: 302,
          headers: {
            Location:
              this.widgetKeyFrom === 'signout'
                ? `${this.endpoints.idmsa}/appleauth/signout?widgetKey=widget-key&asop=destroy-session&asoc=/&rv=3`
                : `${this.endpoints.idmsa}/appleauth/signout?asop=destroy-session`,
          },
        }
      case '/olympus/v1/app/config':
        return this.widgetKeyFrom === 'gone'
          ? { status: 404 }
          : {
              status: 200,
              body:
                this.widgetKeyFrom === 'empty'
                  ? {}
                  : { authServiceKey: 'widget-key' },
            }
      case '/appleauth/auth/signin':
        return {
          status: 200,
          headers: {
            'X-Apple-HC-Bits': '8',
            'X-Apple-HC-Challenge': 'challenge',
          },
        }
      case '/appleauth/auth/signin/init': {
        if (req.headers['x-apple-widget-key'] !== 'widget-key')
          return { status: 400 }
        const A = fromBytes(Buffer.from(String(body.a), 'base64'))
        const b = fromBytes(randomBytes(32))
        const B = (srpK * this.verifier + modPow(srpG, b, srpN)) % srpN
        const c = randomBytes(8).toString('hex')
        this.pending.set(c, { b, B, A })
        return {
          status: 200,
          body: {
            iteration: 1000,
            salt: this.salt.toString('base64'),
            protocol: 's2k',
            b: toBytes(B).toString('base64'),
            c,
          },
        }
      }
      case '/appleauth/auth/signin/complete': {
        const stamp = String(req.headers['x-apple-hc'] ?? '')
        const digest = createHash('sha1').update(stamp).digest()
        if (!stamp.includes(':challenge::') || digest[0] !== 0)
          return { status: 400, body: { error: 'hashcash' } }
        const pending = this.pending.get(String(body.c))
        this.pending.delete(String(body.c))
        if (pending == null || body.accountName !== this.appleId)
          return { status: 401 }
        const u = srpU(pending.A, pending.B)
        const S = modPow(
          (pending.A * modPow(this.verifier, u, srpN)) % srpN,
          pending.b,
          srpN,
        )
        const K = sha256(toBytes(S))
        const M1 = srpM1(this.appleId, this.salt, pending.A, pending.B, K)
        if (Buffer.from(String(body.m1), 'base64').compare(M1) !== 0)
          return { status: 401 }
        if (
          Buffer.from(String(body.m2), 'base64').compare(
            srpM2(pending.A, M1, K),
          ) !== 0
        )
          return { status: 401 }
        this.signIns.push(this.appleId)
        if (this.twoFactor && !this.trusted)
          return {
            status: 409,
            headers: {
              'X-Apple-ID-Session-Id': 'session-id',
              scnt: 'scnt-value',
            },
          }
        return { status: 200, headers: { 'Set-Cookie': this.newSession() } }
      }
      case '/appleauth/auth':
        if (
          req.headers['x-apple-id-session-id'] !== 'session-id' ||
          req.headers.scnt !== 'scnt-value'
        )
          return { status: 401 }
        return {
          status: 200,
          body: {
            trustedPhoneNumbers: [
              { id: 1, numberWithDialCode: '+1 (•••) •••-••42' },
            ],
            securityCode: { length: 6 },
          },
        }
      case '/appleauth/auth/verify/trusteddevice/securitycode': {
        if (req.headers['x-apple-id-session-id'] !== 'session-id')
          return { status: 401 }
        const code = (body as { securityCode?: { code?: string } }).securityCode
          ?.code
        if (code !== this.code)
          return {
            status: 400,
            body: {
              serviceErrors: [{ message: 'Incorrect verification code' }],
            },
          }
        this.trusted = true
        return { status: 204 }
      }
      case '/appleauth/auth/2sv/trust':
        if (!this.trusted) return { status: 401 }
        return {
          status: 204,
          headers: {
            'Set-Cookie': [
              this.newSession(),
              'DES6f5e=trusted; Path=/; Max-Age=2592000',
            ],
          },
        }
      case '/olympus/v1/session':
        return { status: signedIn ? 200 : 401 }
      case '/services-account/QH65B2/downloadws/listDownloads.action':
        if (!signedIn)
          return {
            status: 200,
            body: { resultCode: 1100, resultString: 'Session expired' },
          }
        return {
          status: 200,
          body: {
            resultCode: 0,
            downloads: [
              ...[...this.xcodes].map(([version, entry]) => ({
                name: entry.name,
                files: [
                  {
                    remotePath: `/Developer_Tools/Xcode_${version}/Xcode_${version}.xip`,
                    fileSize: 42,
                  },
                ],
              })),
              {
                name: 'Command Line Tools for Xcode 26.1',
                files: [{ remotePath: '/Developer_Tools/CLT_26.1/CLT.dmg' }],
              },
            ],
          },
        }
      case '/devcenter/download.action': {
        if (!signedIn)
          return { status: 302, headers: { Location: '/unauthorized' } }
        const token = randomBytes(12).toString('hex')
        this.downloads.set(token, String(url.searchParams.get('path')))
        return {
          status: 200,
          headers: {
            'Set-Cookie': `ADCDownloadAuth=${token}; Path=/; HttpOnly`,
          },
        }
      }
      default: {
        const match =
          /^\/Developer_Tools\/Xcode_([^/]+)\/Xcode_[^/]+\.xip$/.exec(
            url.pathname,
          )
        if (match == null) return { status: 404 }
        this.downloadCookies.push(req.headers.cookie ?? '')
        const token = this.cookie(req, 'ADCDownloadAuth')
        if (token == null || this.downloads.get(token) !== url.pathname)
          return { status: 403 }
        const entry = this.xcodes.get(match[1]!)!
        return {
          status: 200,
          body: `xcode:${match[1]!.replace(/-beta\d*/, '')}:${entry.build}`,
          headers: { 'Content-Type': 'application/octet-stream' },
        }
      }
    }
  }

  private newSession(): string {
    const id = randomBytes(12).toString('hex')
    this.sessions.add(id)
    return `myacinfo=${id}; Path=/; HttpOnly`
  }
}
