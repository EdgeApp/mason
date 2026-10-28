import { generateKeyPairSync, randomBytes } from 'node:crypto'

/**
 * App Store Connect's website and the developer site's team list, as a
 * signed-in Apple ID's session sees them, in the shapes Apple answers: the
 * session's content providers (one is always current; its public id is the
 * team's API issuer ID), the developer teams with their Team IDs, and the
 * current team's API keys (a key's private key can be downloaded once). A
 * request function, as the master's Apple session gives one.
 */
export class FakeAppleWebSession {
  teams = [
    {
      providerId: 1,
      publicProviderId: 'a1b2c3d4-0000-0000-0000-000000000000',
      name: 'Example Team',
      teamId: 'ABCDE12345',
    },
  ]
  current: number | undefined
  readonly keys: Array<{
    id: string
    nickname: string
    active: boolean
    team: number
    downloaded: boolean
    privateKey?: string
  }> = []
  /** Answer this status to every call, as Apple does for a role without access. */
  refuse: number | undefined
  readonly calls: string[] = []
  /** The next keys Apple makes, as a fake App Store Connect API trusts them; else new ones. */
  readonly nextKeys: Array<{ keyId: string; privateKey: string }> = []

  /** The current team: the one selected, else the first. */
  private team(): (typeof this.teams)[number] | undefined {
    return (
      this.teams.find((team) => team.providerId === this.current) ??
      this.teams[0]
    )
  }

  readonly request = async (
    url: string,
    init: {
      method?: string
      headers?: Record<string, string>
      body?: unknown
    } = {},
  ): Promise<Response> => {
    const method = init.method ?? 'GET'
    const target = new URL(url)
    this.calls.push(`${method} ${target.pathname}`)
    const json = (status: number, value: unknown): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (this.refuse != null) return json(this.refuse, {})
    const type = Object.entries(init.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'content-type',
    )?.[1]
    // Each of Apple's sites takes its own body type, and answers 415 to another.
    if (method !== 'GET') {
      const wanted = target.pathname.startsWith('/iris/')
        ? 'application/vnd.api+json'
        : target.pathname.startsWith('/services-account/')
          ? 'application/x-www-form-urlencoded'
          : 'application/json'
      if (type !== wanted)
        return new Response('Unsupported Media Type', { status: 415 })
    }
    const body = (
      typeof init.body === 'string' && init.body !== ''
        ? JSON.parse(init.body)
        : init.body
    ) as Record<string, never> | undefined
    const route = `${method} ${target.pathname}`
    const provider = (team: (typeof this.teams)[number]): unknown => ({
      providerId: team.providerId,
      publicProviderId: team.publicProviderId,
      name: team.name,
      contentTypes: ['SOFTWARE'],
      subType: 'INDIVIDUAL',
    })
    const current = this.team()
    if (route === 'GET /olympus/v1/session')
      return json(200, {
        ...(current == null ? {} : { provider: provider(current) }),
        availableProviders: this.teams.map(provider),
      })
    if (route === 'POST /services-account/QH65B2/account/listTeams.action')
      return json(200, {
        resultCode: 0,
        teams: this.teams.map((team) => ({
          teamId: team.teamId,
          name: team.name,
          type: 'Company/Organization',
          status: 'active',
        })),
      })
    if (route === 'POST /olympus/v1/session') {
      const id = (body as { provider?: { providerId?: number } } | undefined)
        ?.provider?.providerId
      if (!this.teams.some((team) => team.providerId === id))
        return json(400, {})
      this.current = id
      return json(200, {})
    }
    if (current == null) return json(400, {})
    if (route === 'GET /iris/v1/apiKeys')
      return json(200, {
        data: this.keys
          .filter((key) => key.team === current.providerId)
          .map((key) => ({
            type: 'apiKeys',
            id: key.id,
            attributes: {
              nickname: key.nickname,
              isActive: key.active,
              canDownload: !key.downloaded,
              keyType: 'PUBLIC_API',
            },
          })),
        meta: { paging: { total: this.keys.length, limit: 200 } },
      })
    if (route === 'POST /iris/v1/apiKeys') {
      const attributes = (
        body as unknown as {
          data: { attributes: { nickname: string; roles: string[] } }
        }
      ).data.attributes
      if (!attributes.roles.includes('ADMIN')) return json(400, {})
      const next = this.nextKeys.shift()
      const key = {
        id: next?.keyId ?? randomBytes(5).toString('hex').toUpperCase(),
        nickname: attributes.nickname,
        active: true,
        team: current.providerId,
        downloaded: false,
        privateKey:
          next?.privateKey ??
          generateKeyPairSync('ec', { namedCurve: 'P-256' })
            .privateKey.export({ type: 'pkcs8', format: 'pem' })
            .toString(),
      }
      this.keys.push(key)
      return json(201, { data: { type: 'apiKeys', id: key.id } })
    }
    const match = /^(GET|PATCH) \/iris\/v1\/apiKeys\/([A-Z0-9]+)$/.exec(route)
    const key =
      match == null
        ? undefined
        : this.keys.find((entry) => entry.id === match[2])
    if (key == null) return json(404, {})
    if (match![1] === 'PATCH') {
      key.active = false
      return json(200, {})
    }
    // Apple offers a key's private key once.
    if (key.downloaded)
      return json(200, { data: { attributes: { privateKey: null } } })
    key.downloaded = true
    return json(200, {
      data: {
        attributes: {
          privateKey: Buffer.from(key.privateKey ?? '').toString('base64'),
        },
      },
    })
  }
}
