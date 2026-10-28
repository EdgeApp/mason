import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import { connect } from 'node:net'
import path from 'node:path'
import ssh2 from 'ssh2'
import { WebSocketServer, createWebSocketStream } from 'ws'
import { createCertificate, publicKeyPin } from '../node/certificate.js'
import { PAIRING_FILE } from '../node/identity.js'
import { pinnedAgent } from '../node/pinnedFetch.js'
import { startNode, type RunningNode } from '../node/serve.js'
import { quietMac } from './fakeMac.js'

const { Server: SshServer, utils } = ssh2

interface FakeSession {
  id: string
  state: 'provisioning' | 'ready' | 'stopping' | 'stopped'
  publicKey: string
  limits: Record<string, unknown>
  polls: number
  node?: RunningNode
  cleanup_confirmed?: boolean
}

/**
 * NoMac's REST API and SSH gateway on 127.0.0.1, over HTTPS. A session
 * becomes ready after a few polls; its setup job starts a real worker from
 * the pairing file in the script; the gateway is an ssh2 server over the
 * WebSocket that admits only the session's key and forwards `direct-tcpip`
 * to that worker's link port.
 */
export class FakeNoMac {
  origin = ''
  readonly sessions = new Map<string, FakeSession>()
  readonly requests: Array<{
    method: string
    path: string
    key?: string
    body?: unknown
  }> = []
  /** Credit left; at zero a new session is refused with 402. */
  credit = 10_000_000
  /** Make the next setup job exit with this code. */
  failSetup: number | undefined
  /** Polls before a new session is ready. */
  readyAfter = 2
  /** A fetch and TLS options that trust this server. */
  fetch: typeof fetch = fetch
  ca = ''
  private server: Server | undefined
  private readonly hostKey = utils.generateKeyPairSync('ed25519')
  private readonly tokens = new Map<string, string>()
  private readonly byKey = new Map<string, string>()

  constructor(private readonly root: string) {}

  async start(): Promise<void> {
    const certificate = createCertificate(['127.0.0.1'])
    this.ca = certificate.cert
    const agent = pinnedAgent(publicKeyPin(certificate.cert))
    this.fetch = ((url: string | URL, init?: RequestInit) =>
      fetch(url, {
        ...init,
        // @ts-expect-error undici's dispatcher option
        dispatcher: agent,
      })) as typeof fetch
    const server = createServer(
      { cert: certificate.cert, key: certificate.key },
      (req, res) => {
        void this.handle(req, res).catch((error: unknown) => {
          res.writeHead(500)
          res.end(
            JSON.stringify({
              error: { code: 'fake', message: (error as Error).message },
            }),
          )
        })
      },
    )
    const gateway = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const match = /^\/api\/v1\/mac\/sessions\/([^/]+)\/ssh$/.exec(
        new URL(req.url ?? '/', 'https://x').pathname,
      )
      const session = match == null ? undefined : this.sessions.get(match[1]!)
      const token = String(req.headers.authorization ?? '').replace(
        /^Bearer /,
        '',
      )
      if (session == null || this.tokens.get(token) !== session.id) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }
      gateway.handleUpgrade(req, socket, head, (ws) => this.ssh(session, ws))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  get api(): string {
    return `${this.origin}/api/v1`
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) await session.node?.close()
    const server = this.server
    if (server == null) return
    this.server = undefined
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** SSH over the gateway's WebSocket: the session's key, then a forward to its worker. */
  private ssh(session: FakeSession, ws: import('ws').WebSocket): void {
    const sshd = new SshServer(
      { hostKeys: [this.hostKey.private] },
      (client) => {
        client.on('authentication', (ctx) => {
          if (
            ctx.method === 'publickey' &&
            ctx.username === 'agent' &&
            ctx.key.data.equals(
              Buffer.from(session.publicKey.split(' ')[1] ?? '', 'base64'),
            )
          )
            ctx.accept()
          else ctx.reject(['publickey'])
        })
        client.on('ready', () => {
          client.on('tcpip', (accept, reject, info) => {
            const port = session.node?.link?.port
            if (port == null || info.destPort !== 9310) return reject()
            const channel = accept()
            const socket = connect(port, '127.0.0.1')
            channel.pipe(socket).pipe(channel)
            socket.on('error', () => channel.close())
            channel.on('close', () => socket.destroy())
          })
        })
        client.on('error', () => undefined)
      },
    )
    sshd.injectSocket(createWebSocketStream(ws) as unknown as Socket)
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString()
    const body =
      text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>)
    const url = new URL(req.url ?? '/', this.origin)
    const key = req.headers['idempotency-key'] as string | undefined
    this.requests.push({
      method: req.method ?? '',
      path: url.pathname,
      ...(key == null ? {} : { key }),
      ...(body == null ? {} : { body }),
    })
    const send = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.headers.authorization !== `Bearer ${FakeNoMac.KEY}`)
      return send(401, {
        error: { code: 'invalid_api_key', message: 'API key is malformed' },
      })
    const route = `${req.method} ${url.pathname.replace(/^\/api\/v1/, '')}`
    let match: RegExpExecArray | null
    if (route === 'POST /mac/sessions') {
      const known = key == null ? undefined : this.byKey.get(key)
      if (known != null)
        return send(200, { session: this.view(this.sessions.get(known)!) })
      if (this.credit <= 0)
        return send(402, {
          error: { code: 'insufficient_credit', message: 'No credit left' },
        })
      const session: FakeSession = {
        id: `ses_${randomBytes(6).toString('hex')}`,
        state: 'provisioning',
        publicKey: String(body?.public_key ?? ''),
        limits: (body?.limits ?? {}) as Record<string, unknown>,
        polls: 0,
      }
      this.sessions.set(session.id, session)
      if (key != null) this.byKey.set(key, session.id)
      return send(201, { session: this.view(session) })
    }
    if (route === 'GET /mac/sessions')
      return send(200, {
        sessions: [...this.sessions.values()].map((session) =>
          this.view(session),
        ),
      })
    if (route === 'GET /mac/credits')
      return send(200, {
        credits: {
          spendable_microunits: String(this.credit),
          pricing: { offer: { rate_microunits_per_hour: '800000' } },
        },
      })
    if (
      (match = /^(GET|DELETE) \/mac\/sessions\/([^/]+)$/.exec(route)) != null
    ) {
      const session = this.sessions.get(match[2]!)
      if (session == null)
        return send(404, {
          error: { code: 'not_found', message: 'No session' },
        })
      if (match[1] === 'DELETE') {
        session.state = 'stopping'
        await session.node?.close()
        session.node = undefined
        return send(202, { session: this.view(session) })
      }
      session.polls++
      if (session.state === 'provisioning' && session.polls >= this.readyAfter)
        session.state = 'ready'
      if (session.state === 'stopping') {
        session.state = 'stopped'
        session.cleanup_confirmed = true
      }
      return send(200, { session: this.view(session) })
    }
    if ((match = /^POST \/mac\/sessions\/([^/]+)\/jobs$/.exec(route)) != null) {
      const session = this.sessions.get(match[1]!)!
      const argv = (body?.argv ?? []) as string[]
      if (this.failSetup != null) {
        const code = this.failSetup
        this.failSetup = undefined
        return send(200, {
          id: 'job_failed',
          state: 'exited',
          exit_code: code,
          // As NoMac answers install.sh's failure: its reason on stdout.
          stdout: 'Downloading\ninstall.sh: no such release',
          stderr: '',
        })
      }
      await this.boot(session, argv.at(-1) ?? '')
      return send(200, {
        id: `job_${randomBytes(20).toString('hex')}`,
        state: 'exited',
        exit_code: 0,
        stdout: 'installed',
      })
    }
    if (
      (match = /^POST \/mac\/sessions\/([^/]+)\/access$/.exec(route)) != null
    ) {
      const session = this.sessions.get(match[1]!)!
      const token = randomBytes(16).toString('hex')
      this.tokens.set(token, session.id)
      return send(200, {
        session_id: session.id,
        gateway: this.origin,
        token,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        generation: 1,
        ssh: { username: 'agent', host_key: `${this.hostKey.public} nomac` },
      })
    }
    send(404, { error: { code: 'not_found', message: `No route ${route}` } })
  }

  /** What the setup job does on a real Mac: the worker, from the pairing file in the script. */
  private async boot(session: FakeSession, script: string): Promise<void> {
    const match = /<<'MASON_PAIRING'\n([\s\S]*?)\nMASON_PAIRING/.exec(script)
    if (match == null) throw new Error('No pairing file in the setup script')
    const data = path.join(mkdtempSync(path.join(this.root, 'mac-')), 'data')
    mkdirSync(data, { mode: 0o700 })
    writeFileSync(path.join(data, PAIRING_FILE), match[1]!, { mode: 0o600 })
    session.node = await startNode(
      {
        role: 'worker',
        data,
        linkPort: 0,
        listen: '127.0.0.1',
        heartbeatMs: 0,
        workerOptions: { flushMs: 50, systemRun: quietMac() },
      },
      () => undefined,
    )
  }

  private view(session: FakeSession): Record<string, unknown> {
    return {
      id: session.id,
      state: session.state,
      ...(session.cleanup_confirmed === true
        ? { cleanup_confirmed: true }
        : {}),
    }
  }

  static readonly KEY = 'nmk_' + 'f'.repeat(40)
}
