import type {
  CertificateKind,
  CertificateView,
} from '../../apple/certificates.js'

/**
 * Apple setup from an Apple ID. The master is signed in to Apple with the
 * Apple ID, its password and the six-digit code (the same session Xcode
 * downloads use); from there it makes the team's App Store Connect API key
 * through App Store Connect's own website calls, stores it in the `apple`
 * settings, and makes the distribution certificate with it. What it made
 * before is kept: a key named for this master whose private key is stored,
 * and certificates it holds the private key of.
 *
 * App Store Connect's website calls are not Apple's public API, so they sit
 * behind `AppleWeb`, and entering a key by hand still works when Apple
 * changes them.
 */

/** A developer team of the Apple ID, with its App Store Connect provider. */
export interface AppleWebTeam {
  id: string
  name: string
  /** None when no App Store Connect provider could be told to be this team. */
  providerId?: number
  /** Without a provider: the providers no team was found for, by name. */
  unmatched?: string[]
}

/** What Mason uses of App Store Connect's website, signed in. */
export interface AppleWeb {
  /** The teams the Apple ID belongs to: Team ID, name, App Store Connect provider. */
  teams(): Promise<AppleWebTeam[]>
  selectTeam(providerId: number): Promise<void>
  /** The selected team's App Store Connect API issuer ID. */
  issuerId(): Promise<string>
  apiKeys(): Promise<Array<{ id: string; nickname: string; active: boolean }>>
  /** Makes a team key with the Admin role; its private key can be downloaded once. */
  createApiKey(nickname: string): Promise<{ id: string }>
  /** The key's `.p8`, PEM. */
  downloadKey(id: string): Promise<string>
  revokeApiKey(id: string): Promise<void>
}

/** A request with the master's Apple session; the website's own JSON API. */
export type AppleRequest = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
    /** A 401 refuses this call only, and leaves the session signed in. */
    keepSession?: boolean
  },
) => Promise<Response>

export class AppleWebError extends Error {}

/** A setup that stopped once its team was known, so the master can say which. */
export class AppleTeamError extends AppleWebError {
  constructor(
    readonly team: { id: string; name: string },
    message: string,
    options?: { cause: unknown },
  ) {
    super(message, options)
  }
}

/** `/olympus/v1/session`: the Apple ID's content providers, one of them current. */
interface OlympusSession {
  provider?: OlympusProvider
  availableProviders?: OlympusProvider[]
}
export interface OlympusProvider {
  providerId: number
  /** The provider's public id, which is its App Store Connect API issuer ID. */
  publicProviderId?: string
  name: string
}

/** Apple's own words for a refusal, when its answer carries them. */
function appleReason(text: string): string {
  try {
    const body = JSON.parse(text) as {
      errors?: Array<{ title?: string; detail?: string }>
      serviceErrors?: Array<{ message?: string }>
    }
    const first = body.errors?.[0]
    const words =
      first != null
        ? [first.title, first.detail].filter(Boolean).join(': ')
        : (body.serviceErrors?.[0]?.message ?? '')
    return words === '' ? '' : `: ${words.slice(0, 300)}`
  } catch {
    return ''
  }
}

/**
 * App Store Connect's website as it answers a signed-in Apple ID, with the
 * developer site for Team IDs. Each takes its own body type: olympus JSON,
 * iris JSON:API, and the developer site a form.
 */
export class AppStoreConnectWeb implements AppleWeb {
  constructor(
    private readonly request: AppleRequest,
    private readonly base = 'https://appstoreconnect.apple.com',
    private readonly developer = 'https://developer.apple.com',
  ) {}

  private async json<T>(
    route: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const site = route.startsWith('/services-account/')
      ? this.developer
      : this.base
    const type = route.startsWith('/iris/')
      ? 'application/vnd.api+json'
      : route.startsWith('/services-account/')
        ? 'application/x-www-form-urlencoded'
        : 'application/json'
    const response = await this.request(`${site}${route}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.api+json, application/json',
        ...(init.body == null ? {} : { 'Content-Type': type }),
        'X-Csrf-Itc': 'itc',
      },
    })
    const text = await response.text()
    if (response.status === 401 || response.status === 403)
      throw new AppleWebError(
        response.status === 403
          ? 'Apple refused: the Apple ID must be the team’s Account Holder or an Admin, and the team must have App Store Connect API access (the Account Holder requests it in Users and Access, Integrations)'
          : 'The Apple session ended: sign in with the Apple ID again',
      )
    if (!response.ok)
      throw new AppleWebError(
        `App Store Connect ${init.method ?? 'GET'} ${route.split('?')[0]}: ${response.status}`,
      )
    return (text === '' ? {} : JSON.parse(text)) as T
  }

  private async session(): Promise<OlympusSession> {
    return await this.json<OlympusSession>('/olympus/v1/session')
  }

  async teams(): Promise<AppleWebTeam[]> {
    const providers = (await this.session()).availableProviders ?? []
    // The developer site has the Team IDs, by much the same names.
    const developer = await this.json<{
      teams?: Array<{ teamId: string; name: string }>
    }>('/services-account/QH65B2/account/listTeams.action', {
      method: 'POST',
      body: '',
    })
    return matchTeams(providers, developer.teams ?? [])
  }

  /**
   * Switches the session's current team, as App Store Connect's own page
   * does. A refused switch fails this team's setup and leaves the session
   * signed in: the session read just before it answered.
   */
  async selectTeam(providerId: number): Promise<void> {
    if ((await this.session()).provider?.providerId === providerId) return
    const response = await this.request(`${this.base}/olympus/v1/session`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'X-Requested-With': 'olympus-ui',
        'X-Csrf-Itc': 'itc',
        Origin: this.base,
        Referer: `${this.base}/`,
      },
      body: { provider: { providerId } },
      keepSession: true,
    })
    const text = await response.text()
    if (!response.ok)
      throw new AppleWebError(
        `App Store Connect refused to switch the session to this team (${response.status}${appleReason(text)})`,
      )
    if ((await this.session()).provider?.providerId !== providerId)
      throw new AppleWebError(
        'App Store Connect did not switch the session to this team',
      )
  }

  async issuerId(): Promise<string> {
    const issuer = (await this.session()).provider?.publicProviderId
    if (issuer == null)
      throw new AppleWebError(
        'App Store Connect did not say the team’s issuer ID',
      )
    return issuer
  }

  async apiKeys(): Promise<
    Array<{ id: string; nickname: string; active: boolean }>
  > {
    const keys = await this.json<{
      data?: Array<{
        id: string
        attributes?: { nickname?: string; isActive?: boolean }
      }>
    }>('/iris/v1/apiKeys?limit=200')
    return (keys.data ?? []).map((key) => ({
      id: key.id,
      nickname: key.attributes?.nickname ?? '',
      active: key.attributes?.isActive !== false,
    }))
  }

  async createApiKey(nickname: string): Promise<{ id: string }> {
    const made = await this.json<{ data: { id: string } }>('/iris/v1/apiKeys', {
      method: 'POST',
      body: {
        data: {
          type: 'apiKeys',
          attributes: {
            nickname,
            roles: ['ADMIN'],
            allAppsVisible: true,
            keyType: 'PUBLIC_API',
          },
        },
      },
    })
    return { id: made.data.id }
  }

  async downloadKey(id: string): Promise<string> {
    const key = await this.json<{
      data?: { attributes?: { privateKey?: string } }
    }>(`/iris/v1/apiKeys/${encodeURIComponent(id)}?fields[apiKeys]=privateKey`)
    const encoded = key.data?.attributes?.privateKey
    if (encoded == null)
      throw new AppleWebError(
        'App Store Connect no longer offers this key’s private key; it is replaced on the next setup',
      )
    const text = Buffer.from(encoded, 'base64').toString('utf8')
    return text.includes('BEGIN PRIVATE KEY') ? text : encoded
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.json(`/iris/v1/apiKeys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: {
        data: { type: 'apiKeys', id, attributes: { isActive: false } },
      },
    })
  }
}

/** Company suffixes one site may carry and the other leave out. */
const companySuffixes = new Set([
  'inc',
  'incorporated',
  'llc',
  'pllc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'ag',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'bv',
  'nv',
  'pty',
  'plc',
  'lp',
  'llp',
  'ab',
  'oy',
  'kk',
])

/** A team's name with case, accents, punctuation and company suffixes set aside. */
export function teamNameKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
  while (words.length > 1 && companySuffixes.has(words[words.length - 1]!))
    words.pop()
  return words.join(' ')
}

/**
 * Pairs App Store Connect's providers with the developer site's teams, which
 * Apple names each on its own: by the same name, then by the same name with
 * case, punctuation and company suffixes set aside, then a provider and a
 * team that are the only ones left. A name pairs only when it picks out one
 * of each. A team left without a provider is still listed, so its setup can
 * say why.
 */
export function matchTeams(
  providers: OlympusProvider[],
  teams: Array<{ teamId: string; name: string }>,
): AppleWebTeam[] {
  const paired = new Map<string, OlympusProvider>()
  const left = (): {
    providers: OlympusProvider[]
    teams: Array<{ teamId: string; name: string }>
  } => {
    const taken = new Set(paired.values())
    return {
      providers: providers.filter((provider) => !taken.has(provider)),
      teams: teams.filter((team) => !paired.has(team.teamId)),
    }
  }
  for (const key of [(name: string): string => name, teamNameKey]) {
    const free = left()
    for (const team of free.teams) {
      const named = free.providers.filter(
        (provider) => key(provider.name) === key(team.name),
      )
      const alike = free.teams.filter(
        (other) => key(other.name) === key(team.name),
      )
      if (named.length === 1 && alike.length === 1)
        paired.set(team.teamId, named[0]!)
    }
  }
  const last = left()
  if (last.providers.length === 1 && last.teams.length === 1)
    paired.set(last.teams[0]!.teamId, last.providers[0]!)
  const unmatched = left().providers.map((provider) => provider.name)
  return teams.map((team) => {
    const provider = paired.get(team.teamId)
    return provider == null
      ? { id: team.teamId, name: team.name, unmatched }
      : {
          id: team.teamId,
          name: provider.name,
          providerId: provider.providerId,
        }
  })
}

/** One step's outcome, as the Apple page shows it. */
export interface SetupResult {
  team: { id: string; name: string }
  key: 'created' | 'kept' | 'replaced'
  keyId: string
  certificate: 'created' | 'kept'
}

export interface AppleSetupOptions {
  /** The website, while the master is signed in to Apple. */
  web: () => AppleWeb | undefined
  /** Why it is not, as the Apple session says (its sign-in lapsed, say). */
  signedOut?: () => string | undefined
  /** The `apple` settings' team keys. */
  teamKey: (team: string) => { keyId: string } | undefined
  saveTeamKey: (
    team: string,
    key: { issuerId: string; keyId: string; privateKey: string; name: string },
  ) => Promise<void>
  /** A certificate the master holds the private key of, and making one. */
  certificate: (
    team: string,
    kind: CertificateKind,
  ) => CertificateView | undefined
  createCertificate: (
    team: string,
    kind: CertificateKind,
  ) => Promise<CertificateView>
  /** The team's distribution certificates at Apple, for a limit's message. */
  appleCertificates: (team: string) => Promise<string[]>
  /** The master's fingerprint: its key is named `Mason <first 8>`. */
  fingerprint: string
}

export class AppleSetup {
  constructor(private readonly options: AppleSetupOptions) {}

  private web(): AppleWeb {
    const web = this.options.web()
    if (web == null)
      throw new AppleWebError(
        this.options.signedOut?.() ?? 'Sign in with the Apple ID first',
      )
    return web
  }

  /** The key this master names for itself. */
  get keyName(): string {
    return `Mason ${this.options.fingerprint.replace(/^mldsa65:/, '').slice(0, 8)}`
  }

  async teams(): Promise<Array<{ id: string; name: string }>> {
    return (await this.web().teams()).map(({ id, name }) => ({ id, name }))
  }

  /**
   * Sets a team up: its API key and its distribution certificate. With one
   * team, that team; with several, the one named.
   */
  async setup(teamId?: string): Promise<SetupResult> {
    const web = this.web()
    const teams = await web.teams()
    const team =
      teamId == null
        ? teams.length === 1
          ? teams[0]
          : undefined
        : teams.find((entry) => entry.id === teamId)
    if (team == null)
      throw new AppleWebError(
        teams.length === 0
          ? 'This Apple ID belongs to no developer team'
          : teamId == null
            ? 'Choose the team to set up'
            : `This Apple ID is not in team ${teamId}`,
      )
    try {
      return await this.setupTeam(web, team)
    } catch (error) {
      throw new AppleTeamError(
        { id: team.id, name: team.name },
        (error as Error).message,
        { cause: error },
      )
    }
  }

  private async setupTeam(
    web: AppleWeb,
    team: AppleWebTeam,
  ): Promise<SetupResult> {
    if (team.providerId == null)
      throw new AppleWebError(
        (team.unmatched ?? []).length === 0
          ? `App Store Connect lists no team for ${team.name} to this Apple ID: add the Apple ID to the team in App Store Connect’s Users and Access, then check signing again`
          : `App Store Connect names this Apple ID’s other teams ${team.unmatched!.join(', ')}, and none is plainly ${team.name}; store the team’s App Store Connect key with mason settings set apple`,
      )
    await web.selectTeam(team.providerId)
    // The key: this master's, kept while its private key is stored here.
    const listed = (await web.apiKeys()).filter((key) => key.active)
    const keys = listed.filter((key) => key.nickname === this.keyName)
    const stored = this.options.teamKey(team.id)
    let key: SetupResult['key'] = 'created'
    let keyId = stored?.keyId
    // This master's key, or one a person entered by hand that still works.
    if (stored != null && listed.some((entry) => entry.id === stored.keyId)) {
      key = 'kept'
    } else {
      for (const old of keys) {
        await web.revokeApiKey(old.id)
        key = 'replaced'
      }
      const made = await web.createApiKey(this.keyName)
      const privateKey = await web.downloadKey(made.id)
      await this.options.saveTeamKey(team.id, {
        issuerId: await web.issuerId(),
        keyId: made.id,
        privateKey,
        name: team.name,
      })
      keyId = made.id
    }
    // The certificate: one the master holds, or a new one made with the key.
    let certificate: SetupResult['certificate'] = 'kept'
    if (this.options.certificate(team.id, 'distribution') == null) {
      try {
        await this.options.createCertificate(team.id, 'distribution')
      } catch (error) {
        // Apple's limit is the team's to resolve; nothing is revoked here.
        if (
          !/limit|maximum|already have a current/i.test(
            (error as Error).message,
          )
        )
          throw error
        const existing = await this.options
          .appleCertificates(team.id)
          .catch((): string[] => [])
        throw new AppleWebError(
          `Apple allows no more distribution certificates for ${team.name}: ${existing.join(', ') || 'see Certificates in the Apple Developer site'}. Revoke one there that no one uses, or import its .p12 on the Apple page, then check signing again.`,
        )
      }
      certificate = 'created'
    }
    return {
      team: { id: team.id, name: team.name },
      key,
      keyId: keyId!,
      certificate,
    }
  }
}
