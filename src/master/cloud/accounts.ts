import { allow } from '../permissions.js'
import type { Actor } from '../roles.js'
import type { Settings, SettingsArea, SettingValue } from '../settings.js'

/**
 * Cloud accounts: the API keys of the providers pools and hosts run on. They
 * live in the master's database (the `cloudAccounts` settings area), so they
 * are in its encrypted backups; a key is write-only once stored.
 */

export const cloudProviders = ['digitalocean', 'nomac'] as const
export type CloudProviderName = (typeof cloudProviders)[number]

export interface CloudAccount {
  /** A slug chosen when the account is added; pools and hosts refer to it. */
  id: string
  name: string
  provider: CloudProviderName
  key: string
}

export interface CloudAccountsSetting {
  accounts: CloudAccount[]
}

export const providerNames: Record<CloudProviderName, string> = {
  digitalocean: 'DigitalOcean',
  nomac: 'NoMac',
}

const slug = /^[a-z0-9][a-z0-9-]{0,39}$/
const keyFormats: Record<CloudProviderName, RegExp[]> = {
  digitalocean: [/^dop_v1_[0-9a-f]{64}$/, /^[A-Za-z0-9_-]{20,200}$/],
  nomac: [/^nmk_[A-Za-z0-9_-]{16,200}$/],
}
const keyNames: Record<CloudProviderName, string> = {
  digitalocean: 'a DigitalOcean API token',
  nomac: 'a NoMac API key (nmk_…)',
}

/** The stored accounts, for code on the master. */
export function storedAccounts(
  value: SettingValue | undefined,
): CloudAccount[] {
  return ((value as CloudAccountsSetting | undefined)?.accounts ?? []).filter(
    (account) => typeof account.key === 'string',
  )
}

/** A slug for an account named `name`, unique among `taken`. */
export function accountId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'account'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

/**
 * The `cloudAccounts` settings area. `usedBy` names what refers to an
 * account (pools, hosts), so an account in use cannot be removed.
 */
export function cloudAccountsArea(
  usedBy: (id: string) => string[],
): SettingsArea {
  return {
    validate: (input, previous): SettingValue => {
      const value = (input ?? {}) as Record<string, unknown>
      if (value.accounts != null && !Array.isArray(value.accounts))
        throw new Error('accounts is a list')
      const stored = storedAccounts(previous)
      const accounts = ((value.accounts ?? []) as unknown[]).map(
        (entry): CloudAccount => {
          const account = (entry ?? {}) as Record<string, unknown>
          const id = account.id
          if (typeof id !== 'string' || !slug.test(id))
            throw new Error(
              'account.id is a slug: lowercase letters, digits and dashes',
            )
          const provider = account.provider
          if (!cloudProviders.includes(provider as CloudProviderName))
            throw new Error(
              `account ${id}: provider is ${cloudProviders.join(' or ')}`,
            )
          const name = account.name
          if (
            typeof name !== 'string' ||
            name.trim() === '' ||
            name.length > 80 ||
            /[\p{Cc}]/u.test(name)
          )
            throw new Error(`account ${id}: name is up to 80 characters`)
          let key = account.key
          if (
            key != null &&
            typeof key === 'object' &&
            (key as { keep?: unknown }).keep === true
          ) {
            const kept = stored.find(
              (old) => old.id === id && old.provider === provider,
            )
            if (kept == null)
              throw new Error(`account ${id}: no stored key to keep`)
            key = kept.key
          }
          if (
            typeof key !== 'string' ||
            !keyFormats[provider as CloudProviderName].some((format) =>
              format.test(key as string),
            )
          )
            throw new Error(
              `account ${id}: key is ${keyNames[provider as CloudProviderName]}`,
            )
          return {
            id,
            name: name.trim(),
            provider: provider as CloudProviderName,
            key,
          }
        },
      )
      const ids = new Set<string>()
      for (const account of accounts) {
        if (ids.has(account.id))
          throw new Error(`Account ${account.id} is listed twice`)
        ids.add(account.id)
      }
      for (const old of stored) {
        const kept = accounts.find((account) => account.id === old.id)
        if (kept != null && kept.provider === old.provider) continue
        const users = usedBy(old.id)
        if (users.length > 0)
          throw new Error(
            `Account ${old.id} is used by ${users.join(', ')}; change or remove ${users.length === 1 ? 'it' : 'them'} first`,
          )
      }
      return { accounts }
    },
    // Each account's key is a secret one level down.
    redact: (value): SettingValue => ({
      ...value,
      accounts: ((value.accounts ?? []) as CloudAccount[]).map((account) => ({
        ...account,
        key: { set: typeof account.key === 'string' },
      })),
    }),
  }
}

/** What a check of an account's key found. */
export interface AccountCheck {
  state: 'ok' | 'refused' | 'timeout' | 'unavailable' | 'error'
  checkedAt: number
  /** Why it is not ok. */
  message?: string
  digitalocean?: { email: string; dropletLimit: number; status: string }
  nomac?: {
    /** Spendable credit in dollars. */
    credit: number
    spendableSeconds: number
    concurrency: number
    spendingBlocked: boolean
  }
}

/** An account as the API and the Cloud page show it: the key only as set. */
export interface AccountView {
  id: string
  name: string
  provider: CloudProviderName
  key: { set: true }
  check?: AccountCheck
}

export interface CloudAccountsOptions {
  settings: Settings
  now: () => number
  fetch?: typeof fetch
  /** API bases; fakes in tests. */
  endpoints?: { digitalocean?: string; nomac?: string }
  /** How long a check may take. */
  timeoutMs?: number
}

const CACHE_MS = 60_000

/** Adds, checks and removes cloud accounts through the `cloudAccounts` area. */
export class CloudAccounts {
  private readonly checks = new Map<string, AccountCheck>()
  constructor(private readonly options: CloudAccountsOptions) {}

  /** The stored accounts with their keys, for code on the master. */
  all(): CloudAccount[] {
    return storedAccounts(this.options.settings.value('cloudAccounts'))
  }
  get(id: string): CloudAccount | undefined {
    return this.all().find((account) => account.id === id)
  }

  list(actor: Actor): AccountView[] {
    allow(actor, 'settings.read')
    return this.all().map((account) => this.view(account))
  }

  private view(account: CloudAccount): AccountView {
    const check = this.checks.get(account.id)
    return {
      id: account.id,
      name: account.name,
      provider: account.provider,
      key: { set: true },
      ...(check == null ? {} : { check }),
    }
  }

  /** Every account but one, with their stored keys kept. */
  private kept(except?: string): Record<string, unknown>[] {
    return this.all()
      .filter((account) => account.id !== except)
      .map((account) => ({
        id: account.id,
        name: account.name,
        provider: account.provider,
        key: { keep: true },
      }))
  }

  async add(actor: Actor, input: unknown): Promise<AccountView> {
    allow(actor, 'settings.change')
    const body = (input ?? {}) as Record<string, unknown>
    const taken = this.all().map((account) => account.id)
    const id =
      body.id == null || body.id === ''
        ? accountId(typeof body.name === 'string' ? body.name : '', taken)
        : body.id
    if (typeof id === 'string' && taken.includes(id))
      throw new Error(`An account named ${id} already exists`)
    const key = typeof body.key === 'string' ? body.key.trim() : body.key
    await this.options.settings.set(actor, 'cloudAccounts', {
      accounts: [
        ...this.kept(),
        { id, name: body.name, provider: body.provider, key },
      ],
    })
    this.checks.delete(id as string)
    return this.view(this.get(id as string)!)
  }

  async remove(actor: Actor, id: string): Promise<void> {
    allow(actor, 'settings.change')
    if (this.get(id) == null) throw new MissingAccount(id)
    await this.options.settings.set(actor, 'cloudAccounts', {
      accounts: this.kept(id),
    })
    this.checks.delete(id)
  }

  /** Checks an account's key; a result under a minute old is reused unless forced. */
  async check(actor: Actor, id: string, force = true): Promise<AccountView> {
    allow(actor, 'settings.read')
    const account = this.get(id)
    if (account == null) throw new MissingAccount(id)
    const cached = this.checks.get(id)
    if (
      force ||
      cached == null ||
      this.options.now() - cached.checkedAt >= CACHE_MS
    )
      this.checks.set(id, await this.probe(account))
    return this.view(account)
  }

  /** Every account, checked unless a check under a minute old exists. */
  async checked(actor: Actor): Promise<AccountView[]> {
    allow(actor, 'settings.read')
    return await Promise.all(
      this.all().map(
        async (account) => await this.check(actor, account.id, false),
      ),
    )
  }

  private async probe(account: CloudAccount): Promise<AccountCheck> {
    const checkedAt = this.options.now()
    try {
      return account.provider === 'digitalocean'
        ? {
            state: 'ok',
            checkedAt,
            digitalocean: await this.digitalOcean(account),
          }
        : { state: 'ok', checkedAt, nomac: await this.noMac(account) }
    } catch (error) {
      const failure =
        error instanceof CheckFailed
          ? error
          : new CheckFailed('error', (error as Error).message)
      return { state: failure.state, checkedAt, message: failure.message }
    }
  }

  private async call(
    account: CloudAccount,
    base: string,
    route: string,
  ): Promise<Record<string, unknown>> {
    const label = providerNames[account.provider]
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(`${base}${route}`, {
        headers: {
          Authorization: `Bearer ${account.key}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      })
    } catch (error) {
      const name = (error as Error).name
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new CheckFailed('timeout', `${label} did not answer in time`)
      throw new CheckFailed(
        'unavailable',
        `${label} is unreachable: ${(error as Error).message}`,
      )
    }
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    } catch {
      // A proxy's error page; the status says enough.
    }
    if (response.ok) return body
    if (response.status === 401 || response.status === 403)
      throw new CheckFailed('refused', `${label} refused the key`)
    if (response.status >= 500)
      throw new CheckFailed(
        'unavailable',
        `${label} answered ${response.status}; try again later`,
      )
    const detail =
      (body.message as string | undefined) ??
      (body.error as { message?: string } | undefined)?.message ??
      ''
    throw new CheckFailed(
      'error',
      `${label} answered ${response.status} ${detail}`.trim(),
    )
  }

  private async digitalOcean(
    account: CloudAccount,
  ): Promise<NonNullable<AccountCheck['digitalocean']>> {
    const body = await this.call(
      account,
      this.options.endpoints?.digitalocean ?? 'https://api.digitalocean.com/v2',
      '/account',
    )
    const info = (body.account ?? {}) as {
      email?: unknown
      droplet_limit?: unknown
      status?: unknown
    }
    return {
      email: String(info.email ?? ''),
      dropletLimit: Number(info.droplet_limit ?? 0),
      status: String(info.status ?? ''),
    }
  }

  private async noMac(
    account: CloudAccount,
  ): Promise<NonNullable<AccountCheck['nomac']>> {
    const base = this.options.endpoints?.nomac ?? 'https://nomac.app/api/v1'
    await this.call(account, base, '/me')
    const body = await this.call(account, base, '/mac/credits')
    const credits = (body.credits ?? {}) as {
      spendable_microunits?: unknown
      spendable_seconds?: unknown
      concurrency_limit?: unknown
      spending_blocked?: unknown
    }
    return {
      credit: Number(credits.spendable_microunits ?? 0) / 1_000_000,
      spendableSeconds: Number(credits.spendable_seconds ?? 0),
      concurrency: Number(credits.concurrency_limit ?? 0),
      spendingBlocked: credits.spending_blocked === true,
    }
  }
}

class CheckFailed extends Error {
  constructor(
    readonly state: Exclude<AccountCheck['state'], 'ok'>,
    message: string,
  ) {
    super(message)
  }
}

export class MissingAccount extends Error {
  constructor(id: string) {
    super(`No cloud account named ${id}`)
  }
}
