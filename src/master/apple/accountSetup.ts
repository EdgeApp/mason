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

/** What Mason uses of App Store Connect's website, signed in. */
export interface AppleWeb {
  /** The teams the Apple ID belongs to: Team ID, name, App Store Connect provider. */
  teams(): Promise<Array<{ id: string; name: string; providerId: number }>>
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
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
) => Promise<Response>

export class AppleWebError extends Error {}

/** `/olympus/v1/session`: the Apple ID's content providers, one of them current. */
interface OlympusSession {
  provider?: OlympusProvider
  availableProviders?: OlympusProvider[]
}
interface OlympusProvider {
  providerId: number
  /** The provider's public id, which is its App Store Connect API issuer ID. */
  publicProviderId?: string
  name: string
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

  async teams(): Promise<
    Array<{ id: string; name: string; providerId: number }>
  > {
    const providers = (await this.session()).availableProviders ?? []
    // The developer site has the Team IDs, by the same names.
    const developer = await this.json<{
      teams?: Array<{ teamId: string; name: string }>
    }>('/services-account/QH65B2/account/listTeams.action', {
      method: 'POST',
      body: '',
    })
    const teams = developer.teams ?? []
    return providers.flatMap((provider) => {
      const team =
        teams.find((entry) => entry.name === provider.name) ??
        (providers.length === 1 && teams.length === 1 ? teams[0] : undefined)
      return team == null
        ? []
        : [
            {
              id: team.teamId,
              name: provider.name,
              providerId: provider.providerId,
            },
          ]
    })
  }

  async selectTeam(providerId: number): Promise<void> {
    if ((await this.session()).provider?.providerId === providerId) return
    await this.json('/olympus/v1/session', {
      method: 'POST',
      body: { provider: { providerId } },
    })
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
    if (web == null) throw new AppleWebError('Sign in with the Apple ID first')
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
          `Apple allows no more distribution certificates for ${team.name}: ${existing.join(', ') || 'see Certificates in the Apple Developer site'}. Revoke one there that no one uses, or import its .p12 on the Apple page, then set up again.`,
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
