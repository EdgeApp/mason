import type { Duplex } from 'node:stream'
import type { ConnectionOptions } from 'node:tls'
import { openTunnel, type GatewayAccess } from '../../link/sshGateway.js'
import {
  ProviderError,
  type CloudProvider,
  type MachineSpec,
  type ProviderMachine,
  type ProviderSnapshot,
} from './digitalocean.js'

/**
 * NoMac Macs for pools. A machine is a NoMac session: created with an
 * idempotency key, the master's SSH key and limits from its pool; once the
 * Mac is ready its first-boot script runs as a NoMac job; and the link
 * reaches its worker through NoMac's SSH gateway. A NoMac Mac is never
 * snapshotted: retiring it stops the session.
 */

interface Session {
  id: string
  state: 'queued' | 'provisioning' | 'ready' | 'stopping' | 'stopped' | 'failed'
  failure_code?: string
  cleanup_confirmed?: boolean
}

interface Job {
  id: string
  state: string
  exit_code?: number | null
  stdout?: string
  stderr?: string
}

export interface NoMacOptions {
  api?: string
  fetch?: typeof fetch
  /** The master's NoMac SSH key pair, OpenSSH format. */
  sshKey: () => { privateKey: string; publicKey: string }
  /** TLS options for the gateway (a test CA). */
  gatewayTls?: Pick<ConnectionOptions, 'ca'>
  wait?: (ms: number) => Promise<void>
}

export const NOMAC_LINK_PORT = 9310

export class NoMac implements CloudProvider {
  /** NoMac Macs keep no snapshots. */
  readonly supportsSnapshots = false
  /** First-boot scripts not yet run, and their jobs, by session. */
  private readonly setups = new Map<
    string,
    { script: string; job?: string; done?: boolean }
  >()
  private rate: number | undefined

  constructor(
    private readonly key: string,
    private readonly options: NoMacOptions,
  ) {}

  private get api(): string {
    return this.options.api ?? 'https://nomac.app/api/v1'
  }

  private async call<T>(
    method: string,
    route: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(`${this.api}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          Accept: 'application/json',
          ...(body == null ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey == null
            ? {}
            : { 'Idempotency-Key': idempotencyKey }),
        },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      })
    } catch (error) {
      throw new ProviderError(
        `NoMac is unreachable: ${(error as Error).message}`,
        'unavailable',
      )
    }
    const text = await response.text()
    let parsed: Record<string, unknown> = {}
    try {
      parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    } catch {
      // An error page; the status says enough.
    }
    if (response.ok) return parsed as T
    const error = (parsed.error ?? {}) as { code?: string; message?: string }
    const message =
      `NoMac ${method} ${route.split('?')[0]}: ${response.status} ${error.message ?? error.code ?? ''}`.trim()
    if (response.status === 402)
      throw new ProviderError(
        `${message}: add credit to the NoMac account`,
        'quota',
      )
    if (response.status === 401 || response.status === 403)
      throw new ProviderError(message, 'auth')
    if (response.status === 404) throw new ProviderError(message, 'missing')
    if (response.status === 429) throw new ProviderError(message, 'rate')
    if (response.status >= 500) throw new ProviderError(message, 'unavailable')
    throw new ProviderError(message, 'other')
  }

  private machine(session: Session, ready: boolean): ProviderMachine {
    return {
      id: session.id,
      name: session.id,
      status:
        ready && session.state === 'ready'
          ? 'active'
          : session.state === 'stopped' || session.state === 'failed'
            ? 'off'
            : 'new',
      tags: [],
      ...(ready && session.state === 'ready'
        ? { address: `nomac:${session.id}`, port: NOMAC_LINK_PORT }
        : {}),
    }
  }

  async create(spec: MachineSpec): Promise<ProviderMachine> {
    const limits = spec.limits ?? {}
    const { session } = await this.call<{ session: Session }>(
      'POST',
      '/mac/sessions',
      {
        public_key: this.options.sshKey().publicKey,
        profile: 'standard',
        limits: {
          ...(limits.maxSeconds == null
            ? {}
            : { max_duration_seconds: limits.maxSeconds }),
          ...(limits.idleSeconds == null
            ? {}
            : { idle_timeout_seconds: limits.idleSeconds }),
        },
        access: { prompts: 'auto' },
      },
      spec.name,
    )
    this.setups.set(session.id, { script: spec.userData })
    return this.machine(session, false)
  }

  /**
   * The session, and once it is ready its first-boot script run as a job: the
   * machine is active only after the script succeeded.
   */
  async get(id: string): Promise<ProviderMachine | undefined> {
    let session: Session
    try {
      session = (
        await this.call<{ session: Session }>('GET', `/mac/sessions/${id}`)
      ).session
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'missing')
        return undefined
      throw error
    }
    if (session.state === 'failed')
      throw new ProviderError(
        `NoMac session ${id} failed${session.failure_code == null ? '' : `: ${session.failure_code}`}`,
        session.failure_code === 'capacity_unavailable'
          ? 'unavailable'
          : 'other',
      )
    const setup = this.setups.get(id)
    if (session.state !== 'ready' || setup == null || setup.done === true)
      return this.machine(session, setup?.done === true)
    const job =
      setup.job == null
        ? await this.call<Job>(
            'POST',
            `/mac/sessions/${id}/jobs?wait=50`,
            {
              argv: ['/bin/bash', '-lc', setup.script],
              timeout_seconds: 1800,
            },
            `mason-setup-${id}`,
          )
        : await this.call<Job>('GET', `/mac/sessions/${id}/jobs/${setup.job}`)
    setup.job = job.id
    if (job.exit_code == null) return this.machine(session, false)
    if (job.exit_code !== 0) {
      // install.sh says why on stdout as often as on stderr.
      const output = [job.stderr, job.stdout].find(
        (text) => text != null && text.trim() !== '',
      )
      throw new ProviderError(
        `Setting up NoMac session ${id} ended with exit code ${job.exit_code}${output == null ? '' : `: ${output.trim().split('\n').slice(-3).join(' ')}`}`,
        'setup',
      )
    }
    setup.done = true
    return this.machine(session, true)
  }

  /**
   * NoMac sessions carry no tags, so none is ever another master's or a
   * person's to the master: cleanup at startup leaves NoMac alone.
   */
  async list(): Promise<ProviderMachine[]> {
    return []
  }

  /** Stops the session and waits until NoMac confirms the Mac is wiped. */
  async destroy(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/mac/sessions/${id}`)
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'missing') return
      throw error
    }
    this.setups.delete(id)
    const wait =
      this.options.wait ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms)))
    for (let i = 0; i < 60; i++) {
      const { session } = await this.call<{ session: Session }>(
        'GET',
        `/mac/sessions/${id}`,
      )
      if (session.cleanup_confirmed === true || session.state === 'failed')
        return
      await wait(5000)
    }
    throw new ProviderError(
      `NoMac session ${id} did not confirm its cleanup`,
      'unavailable',
    )
  }

  /** A Mac is stopped, not powered off: retiring it destroys the session. */
  async powerOff(): Promise<void> {}
  async snapshot(): Promise<ProviderSnapshot> {
    throw new ProviderError('NoMac Macs are not snapshotted', 'other')
  }
  async snapshots(): Promise<ProviderSnapshot[]> {
    return []
  }
  async hasSnapshot(): Promise<boolean> {
    return false
  }
  async deleteSnapshot(): Promise<void> {}
  /** A NoMac Mac accepts no inbound connection; its link is the gateway. */
  async firewall(): Promise<void> {}

  async priceHourly(): Promise<number> {
    if (this.rate == null) {
      const { credits } = await this.call<{
        credits?: {
          pricing?: { offer?: { rate_microunits_per_hour?: string } }
        }
      }>('GET', '/mac/credits')
      this.rate =
        Number(credits?.pricing?.offer?.rate_microunits_per_hour ?? 800_000) /
        1_000_000
    }
    return this.rate
  }

  /** A stream to a port on the session's Mac, through NoMac's SSH gateway. */
  async tunnel(id: string, port: number): Promise<Duplex> {
    const access = await this.call<GatewayAccess>(
      'POST',
      `/mac/sessions/${id}/access`,
    )
    return await openTunnel({
      sessionId: id,
      access,
      privateKey: this.options.sshKey().privateKey,
      port,
      ...(this.options.gatewayTls == null
        ? {}
        : { tls: this.options.gatewayTls }),
    })
  }
}
