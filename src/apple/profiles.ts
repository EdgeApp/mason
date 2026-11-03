import { createHash, randomBytes } from 'node:crypto'
import type { MasterDatabase } from '../master/database.js'
import type { CertificateKind, Certificates } from './certificates.js'
import {
  capabilitiesFor,
  publicCapabilityTypes,
  unknownKeys,
  type NeededCapability,
} from './capabilities.js'
import { AppleApiError, type AppStoreConnect } from './connect.js'

export const distributions = [
  'development',
  'adHoc',
  'appStore',
  'developerId',
  'macAppStore',
] as const
export type Distribution = (typeof distributions)[number]
export type ApplePlatform = 'ios' | 'macos' | 'tvos'
export const applePlatforms: readonly ApplePlatform[] = ['ios', 'macos', 'tvos']
export const isApplePlatform = (value: string): value is ApplePlatform =>
  (applePlatforms as readonly string[]).includes(value)

/**
 * The platform a stage signs for: macOS for Developer ID and Mac App
 * Store; else the stage's `apple.platform`, which must be one of the app's;
 * else iOS when the app has it, tvOS when it has it, macOS otherwise.
 */
export function signingPlatform(
  platforms: readonly string[],
  distribution: Distribution,
  wanted?: string,
): ApplePlatform {
  const apple = platforms.filter(isApplePlatform)
  if (distribution === 'developerId' || distribution === 'macAppStore') {
    if (wanted != null && wanted !== 'macos')
      throw new Error(`A ${distribution} build is for macOS, not ${wanted}`)
    return 'macos'
  }
  if (wanted != null) {
    if (
      !isApplePlatform(wanted) ||
      (apple.length > 0 && !apple.includes(wanted))
    )
      throw new Error(
        `apple.platform ${wanted} is not one of the app's platforms (${apple.join(', ')})`,
      )
    return wanted
  }
  return apple.includes('ios')
    ? 'ios'
    : apple.includes('tvos')
      ? 'tvos'
      : 'macos'
}

/**
 * The device classes each platform's profiles carry. Apple lists Apple TVs
 * under platform `IOS` too, then refuses them on an iOS profile (HTTP 409),
 * so a profile's devices are chosen by class. An iOS profile keeps Apple
 * Watches (a watch app is signed with its iPhone app's profile) and Apple
 * Vision Pros, as Fastlane's does.
 */
export const deviceClasses: Record<ApplePlatform, readonly string[]> = {
  ios: ['IPHONE', 'IPAD', 'IPOD', 'APPLE_WATCH', 'APPLE_VISION_PRO'],
  macos: ['MAC'],
  tvos: ['APPLE_TV'],
}
/** Every class some platform's profiles carry. */
const profiledClasses = (): string[] => Object.values(deviceClasses).flat()

/** The platform App Store Connect lists a platform's devices under: Apple TVs are `IOS`. */
const devicePlatform: Record<ApplePlatform, string> = {
  ios: 'IOS',
  macos: 'MAC_OS',
  tvos: 'IOS',
}

/** A device's class from its product type (`iPhone14,5`, `AppleTV11,1`), as Apple names classes. */
export function deviceClassOf(product: string): string | undefined {
  const prefixes: Array<[string, string]> = [
    ['iPhone', 'IPHONE'],
    ['iPad', 'IPAD'],
    ['iPod', 'IPOD'],
    ['AppleTV', 'APPLE_TV'],
    ['Watch', 'APPLE_WATCH'],
    ['RealityDevice', 'APPLE_VISION_PRO'],
    ['Mac', 'MAC'],
  ]
  return prefixes.find(([prefix]) => product.startsWith(prefix))?.[1]
}

const classNames: Record<string, [string, string]> = {
  IPHONE: ['iPhone', 'iPhones'],
  IPAD: ['iPad', 'iPads'],
  IPOD: ['iPod', 'iPods'],
  APPLE_TV: ['Apple TV', 'Apple TVs'],
  APPLE_WATCH: ['Apple Watch', 'Apple Watches'],
  APPLE_VISION_PRO: ['Apple Vision Pro', 'Apple Vision Pros'],
  MAC: ['Mac', 'Macs'],
}
const platformNames: Record<ApplePlatform, string> = {
  ios: 'iOS',
  macos: 'macOS',
  tvos: 'tvOS',
}

/** The certificate each distribution signs with. */
export function certificateKindFor(
  distribution: Distribution,
): CertificateKind {
  return distribution === 'development'
    ? 'development'
    : distribution === 'developerId'
      ? 'developerIdApplication'
      : 'distribution'
}

/** App Store Connect's profile type for a distribution on a platform. */
export function profileType(
  distribution: Distribution,
  platform: ApplePlatform,
): string {
  const types: Record<ApplePlatform, Partial<Record<Distribution, string>>> = {
    ios: {
      development: 'IOS_APP_DEVELOPMENT',
      adHoc: 'IOS_APP_ADHOC',
      appStore: 'IOS_APP_STORE',
    },
    macos: {
      development: 'MAC_APP_DEVELOPMENT',
      appStore: 'MAC_APP_STORE',
      macAppStore: 'MAC_APP_STORE',
      developerId: 'MAC_APP_DIRECT',
    },
    tvos: {
      development: 'TVOS_APP_DEVELOPMENT',
      adHoc: 'TVOS_APP_ADHOC',
      appStore: 'TVOS_APP_STORE',
    },
  }
  const type = types[platform][distribution]
  if (type == null)
    throw new Error(`There is no ${distribution} distribution for ${platform}`)
  return type
}

const labels: Record<Distribution, string> = {
  development: 'Development',
  adHoc: 'AdHoc',
  appStore: 'AppStore',
  developerId: 'DeveloperID',
  macAppStore: 'MacAppStore',
}

/** The developer site with the signed-in Apple ID's session. */
export interface DeveloperPortal {
  /** `https://developer.apple.com`, or a fake's. */
  base: string
  request: (
    url: string,
    init: {
      method?: string
      headers?: Record<string, string>
      body?: unknown
    },
  ) => Promise<Response>
  /** Whether the session holds the developer site's CSRF tokens, which `request` sends. */
  tokens: () => boolean
}

/** A profile a stage installs. */
export interface StageProfile {
  bundleId: string
  name: string
  uuid: string
  /** The `.mobileprovision` or `.provisionprofile`, base64. */
  content: string
}

const DAY = 24 * 60 * 60 * 1000
const digest = (values: string[]): string =>
  values.length === 0
    ? ''
    : createHash('sha256')
        .update([...values].sort().join('\n'))
        .digest('hex')

/**
 * Provisioning profiles, made and kept by the master: one per bundle ID and
 * distribution, created when missing and regenerated when it expires within
 * 14 days, its certificate changed, the bundle ID's capabilities changed or
 * — for development and ad hoc — the enabled devices changed. A replacement
 * is made before the profile it replaces is deleted, and only profiles
 * Mason made are ever deleted.
 */
export class Profiles {
  constructor(
    private readonly master: MasterDatabase,
    private readonly options: {
      connect: (team: string) => AppStoreConnect | undefined
      certificates: Certificates
      /** How long the enabled device list is trusted before asking Apple again. */
      devicesMs?: number
      log?: (line: string) => void
      /** The signed-in Apple ID's session on the developer site, when there is one. */
      portal?: () => DeveloperPortal | undefined
    },
  ) {}
  private get db(): MasterDatabase['db'] {
    return this.master.db
  }
  private connect(team: string): AppStoreConnect {
    const connect = this.options.connect(team)
    if (connect == null)
      throw new Error(`Team ${team} has no App Store Connect key`)
    return connect
  }

  /** The bundle ID's ID at Apple, creating it when the account lacks it. */
  async bundleId(
    team: string,
    identifier: string,
    platforms: ApplePlatform[],
  ): Promise<string> {
    const row = this.db
      .prepare(
        'SELECT apple_id FROM apple_bundle_ids WHERE team_id=? AND identifier=?',
      )
      .get(team, identifier) as { apple_id: string } | undefined
    if (row != null) return row.apple_id
    const connect = this.connect(team)
    const listed = await connect.all<{ identifier: string; platform: string }>(
      `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`,
    )
    let found = listed.find((item) => item.attributes.identifier === identifier)
    if (found == null) {
      const created = await connect.request<{
        data: {
          id: string
          attributes: { identifier: string; platform: string }
        }
      }>('POST', '/v1/bundleIds', {
        data: {
          type: 'bundleIds',
          attributes: {
            identifier,
            name: `Mason ${identifier.replace(/[^A-Za-z0-9 ]/g, ' ')}`,
            // App Store Connect has no tvOS bundle ID platform: a tvOS
            // app's is IOS, and one shared with macOS UNIVERSAL.
            platform: !platforms.includes('macos')
              ? 'IOS'
              : platforms.some((entry) => entry !== 'macos')
                ? 'UNIVERSAL'
                : 'MAC_OS',
          },
        },
      })
      found = { ...created.data, type: 'bundleIds' }
    }
    const capabilities = (
      await connect.all<{ capabilityType: string }>(
        `/v1/bundleIds/${found.id}/bundleIdCapabilities`,
      )
    )
      .map((item) => item.attributes.capabilityType)
      .sort()
    this.db
      .prepare(
        'INSERT INTO apple_bundle_ids(team_id,identifier,apple_id,platform,capabilities,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,identifier) DO UPDATE SET apple_id=excluded.apple_id,capabilities=excluded.capabilities,updated_at=excluded.updated_at',
      )
      .run(
        team,
        identifier,
        found.id,
        String(found.attributes.platform),
        JSON.stringify(capabilities),
        this.master.now(),
      )
    return found.id
  }

  /**
   * The enabled devices a platform's profiles carry, asked of Apple at most
   * every hour or when `fresh`: those of the platform's device classes only.
   * The devices left out are logged whenever that set changes.
   */
  async devices(
    team: string,
    platform: ApplePlatform,
    fresh = false,
  ): Promise<string[]> {
    // `devices:` lists, cached before device classes were kept, may hold Apple TVs.
    const key = `devices2:${team}:${platform}`
    const cached = this.db
      .prepare('SELECT value,fetched_at FROM apple_cache WHERE key=?')
      .get(key) as { value: string; fetched_at: number } | undefined
    if (
      !fresh &&
      cached != null &&
      cached.fetched_at >
        this.master.now() - (this.options.devicesMs ?? 60 * 60 * 1000)
    )
      return JSON.parse(cached.value) as string[]
    const classes = deviceClasses[platform]
    const listed = await this.connect(team).all<{
      name?: string
      deviceClass?: string
    }>(
      `/v1/devices?filter[status]=ENABLED&filter[platform]=${devicePlatform[platform]}&limit=200`,
    )
    const ids = listed
      .filter((device) => classes.includes(device.attributes.deviceClass ?? ''))
      .map((device) => device.id)
      .sort()
    // Only a device no platform's profiles carry is worth a line.
    this.leftOut(
      team,
      platform,
      listed.filter(
        (device) =>
          !profiledClasses().includes(device.attributes.deviceClass ?? ''),
      ),
    )
    this.db
      .prepare(
        'INSERT INTO apple_cache(key,value,fetched_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,fetched_at=excluded.fetched_at',
      )
      .run(key, JSON.stringify(ids), this.master.now())
    this.db
      .prepare('DELETE FROM apple_cache WHERE key=?')
      .run(`devices:${team}:${platform}`)
    return ids
  }

  /** Logs the enabled devices of no class Mason makes profiles for, once per change of that set. */
  private leftOut(
    team: string,
    platform: ApplePlatform,
    devices: Array<{
      id: string
      attributes: { name?: string; deviceClass?: string }
    }>,
  ): void {
    const key = `devicesLeftOut:${team}:${platform}`
    const value = digest(devices.map((device) => device.id))
    const stored = this.db
      .prepare('SELECT value FROM apple_cache WHERE key=?')
      .get(key) as { value: string } | undefined
    if ((stored?.value ?? '') === value) return
    this.db
      .prepare(
        'INSERT INTO apple_cache(key,value,fetched_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,fetched_at=excluded.fetched_at',
      )
      .run(key, value, this.master.now())
    if (devices.length === 0) return
    const counts = new Map<string, number>()
    for (const device of devices) {
      const kind = device.attributes.deviceClass ?? ''
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    const kinds = [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, count]) => {
        const [one, many] =
          classNames[kind] ??
          (kind === ''
            ? ['device of no class', 'devices of no class']
            : [`${kind} device`, `${kind} devices`])
        return `${count} ${count === 1 ? one : many}`
      })
    const names = devices
      .map((device) => device.attributes.name ?? device.id)
      .sort()
    this.options.log?.(
      `Left ${kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)!}` : kinds[0]!} off ${platformNames[platform]} profiles for team ${team}: ${names.join(', ')}`,
    )
  }

  /** A valid profile for a bundle ID and distribution, made or replaced when the rules say so. */
  async ensure(input: {
    team: string
    bundleId: string
    distribution: Distribution
    platform: ApplePlatform
    platforms?: ApplePlatform[]
  }): Promise<StageProfile> {
    const { team, bundleId, distribution, platform } = input
    const type = profileType(distribution, platform)
    const kind = certificateKindFor(distribution)
    const certificate = this.options.certificates.current(team, kind)
    if (certificate == null)
      throw new Error(
        `Team ${team} has no usable ${kind} certificate; import or create one on the master`,
      )
    if (certificate.appleId == null) {
      await this.options.certificates.sync(team)
      const synced = this.options.certificates.current(team, kind)
      if (synced?.appleId == null)
        throw new Error(
          `The certificate ${certificate.name} is not in team ${team}’s App Store Connect account`,
        )
      certificate.appleId = synced.appleId
    }
    const appleBundle = await this.bundleId(
      team,
      bundleId,
      input.platforms ?? [platform],
    )
    const capabilities = (
      this.db
        .prepare(
          'SELECT capabilities FROM apple_bundle_ids WHERE team_id=? AND identifier=?',
        )
        .get(team, bundleId) as { capabilities: string }
    ).capabilities
    const withDevices =
      distribution === 'development' || distribution === 'adHoc'
    const devices = withDevices ? await this.devices(team, platform) : []
    const current = this.db
      .prepare(
        'SELECT * FROM apple_profiles WHERE team_id=? AND bundle_id=? AND distribution=? AND platform=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
      )
      .get(team, bundleId, distribution, platform) as
      | Record<string, unknown>
      | undefined
    if (
      current != null &&
      Number(current.expires_at) > this.master.now() + 14 * DAY &&
      Number(current.certificate_id) === certificate.id &&
      String(current.devices) === digest(devices) &&
      String(current.capabilities) === capabilities
    )
      return stageProfile(current)
    // To the second, with a few random characters: profile names are unique
    // per team, and several masters may share one.
    const stamp = `${new Date(this.master.now())
      .toISOString()
      .replace(/\D/g, '')
      .slice(0, 14)}-${randomBytes(2).toString('hex')}`
    const created = await this.connect(team).request<{
      data: {
        id: string
        attributes: {
          name: string
          uuid: string
          profileContent: string
          expirationDate: string
        }
      }
    }>('POST', '/v1/profiles', {
      data: {
        type: 'profiles',
        attributes: {
          name: `Mason ${platform === 'tvos' ? 'tvOS ' : ''}${labels[distribution]} ${bundleId} ${stamp}`,
          profileType: type,
        },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: appleBundle } },
          certificates: {
            data: [{ type: 'certificates', id: certificate.appleId }],
          },
          ...(withDevices
            ? {
                devices: {
                  data: devices.map((id) => ({ type: 'devices', id })),
                },
              }
            : {}),
        },
      },
    })
    const attributes = created.data.attributes
    const id = Number(
      this.db
        .prepare(
          'INSERT INTO apple_profiles(team_id,bundle_id,distribution,platform,apple_id,name,uuid,content,expires_at,certificate_id,devices,capabilities,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          team,
          bundleId,
          distribution,
          platform,
          created.data.id,
          attributes.name,
          attributes.uuid,
          attributes.profileContent,
          Date.parse(attributes.expirationDate),
          certificate.id,
          digest(devices),
          capabilities,
          this.master.now(),
        ).lastInsertRowid,
    )
    // The replacement exists; now the profile it replaces goes.
    if (current != null) await this.delete(team, current)
    return stageProfile(
      this.db.prepare('SELECT * FROM apple_profiles WHERE id=?').get(id)!,
    )
  }

  private async delete(
    team: string,
    row: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.connect(team).request(
        'DELETE',
        `/v1/profiles/${String(row.apple_id)}`,
      )
    } catch (error) {
      if (!(error instanceof AppleApiError && error.status === 404)) throw error
    }
    this.db
      .prepare('UPDATE apple_profiles SET deleted_at=? WHERE id=?')
      .run(this.master.now(), Number(row.id))
  }

  /**
   * Enables on its bundle ID the capabilities an archive's entitlements
   * need for the stage's platform and distribution, with the settings Apple
   * needs for them; true when any was enabled, which makes every profile of
   * the bundle ID — development, ad hoc and App Store alike — be made again
   * at its next `ensure`. The App Store Connect API enables the types its
   * specification lists; the others go through the developer site with the
   * master's Apple ID session, as Xcode enables them. Entitlement keys Mason
   * does not know fail before anything changes at Apple, and a capability
   * Apple does not enable fails once the others are enabled — unless `warn`
   * takes them, for a build that signed already.
   */
  async syncCapabilities(
    team: string,
    bundleId: string,
    entitlements: Record<string, unknown>,
    stage: {
      platform: ApplePlatform
      distribution: Distribution
      platforms?: ApplePlatform[]
      warn?: (message: string) => void
    },
  ): Promise<boolean> {
    const { needed, unknown } = capabilitiesFor(
      entitlements,
      stage.platform,
      stage.distribution,
    )
    if (unknown.length > 0) {
      if (stage.warn == null) throw new Error(unknownKeys(unknown))
      stage.warn(unknownKeys(unknown))
    }
    const appleBundle = await this.bundleId(
      team,
      bundleId,
      stage.platforms ?? [stage.platform],
    )
    const connect = this.connect(team)
    const existing = new Set(
      (
        await connect.all<{ capabilityType: string }>(
          `/v1/bundleIds/${appleBundle}/bundleIdCapabilities`,
        )
      ).map((item) => item.attributes.capabilityType),
    )
    const missing = needed.filter((entry) => !existing.has(entry.type))
    let enabled = 0
    let failure: Error | undefined
    for (const capability of missing) {
      try {
        if (!publicCapabilityTypes.has(capability.type))
          await this.enableOnPortal(team, bundleId, appleBundle, capability)
        else
          await connect
            .request('POST', '/v1/bundleIdCapabilities', {
              data: {
                type: 'bundleIdCapabilities',
                attributes: {
                  capabilityType: capability.type,
                  ...(capability.settings == null
                    ? {}
                    : { settings: capability.settings }),
                },
                relationships: {
                  bundleId: { data: { type: 'bundleIds', id: appleBundle } },
                },
              },
            })
            .catch(async (error: unknown) => {
              // The API's enum may lag behind a type it lists.
              if (
                !(error instanceof AppleApiError) ||
                error.status !== 409 ||
                error.code !== 'ENTITY_ERROR.ATTRIBUTE.INVALID'
              )
                throw error
              await this.enableOnPortal(team, bundleId, appleBundle, capability)
            })
      } catch (error) {
        const refusal =
          error instanceof AppleApiError
            ? new AppleApiError(
                error.status,
                `${bundleId} needs the ${capability.name} capability (${capability.type}) for ${capability.keys.join(', ')}${capability.requested ? ', which Apple grants a team only on request' : ''}: ${error.message}`,
                error.code,
              )
            : (error as Error)
        // The other capabilities are still enabled.
        if (stage.warn == null) failure ??= refusal
        else stage.warn(refusal.message)
        continue
      }
      existing.add(capability.type)
      enabled++
    }
    this.db
      .prepare(
        'UPDATE apple_bundle_ids SET capabilities=?,updated_at=? WHERE team_id=? AND identifier=?',
      )
      .run(
        JSON.stringify([...existing].sort()),
        this.master.now(),
        team,
        bundleId,
      )
    if (failure != null) throw failure
    return enabled > 0
  }

  /**
   * Enables a capability the App Store Connect API does not take through
   * the developer site's own API with the Apple ID session, the request
   * Fastlane's `patch_bundle_id_capability` sends: the team chosen by
   * `teamId`, the bundle ID's seed ID beside it, and the site's CSRF tokens.
   */
  private async enableOnPortal(
    team: string,
    bundleId: string,
    appleBundle: string,
    capability: NeededCapability,
  ): Promise<void> {
    const remedy = `enable ${capability.name} for ${bundleId} in the Apple Developer portal, or sign the Apple ID in on the master`
    const portal = this.options.portal?.()
    if (portal == null)
      throw new Error(
        `${bundleId} needs ${capability.name} (${capability.type}) for ${capability.keys.join(', ')}, which only the developer site enables: ${remedy}`,
      )
    const bundle = await this.connect(team).request<{
      data?: { attributes?: { seedId?: string } }
    }>('GET', `/v1/bundleIds/${appleBundle}?fields[bundleIds]=seedId`)
    const url = `${portal.base}/services-account/v1/bundleIds/${appleBundle}`
    const failed = (error: unknown): never => {
      throw new Error(
        `${bundleId} needs ${capability.name} (${capability.type}): ${(error as Error).message}; ${remedy}`,
      )
    }
    // A change needs the site's CSRF tokens, which come with its answers:
    // with none yet, read the bundle ID first, as Fastlane's proxied GET.
    if (!portal.tokens())
      await (
        await portal
          .request(url, {
            method: 'POST',
            headers: {
              Accept: 'application/vnd.api+json, application/json',
              'Content-Type': 'application/vnd.api+json',
              'X-HTTP-Method-Override': 'GET',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body: {
              urlEncodedQueryParams: new URLSearchParams({
                'fields[bundleIds]': 'seedId',
              }).toString(),
              teamId: team,
            },
          })
          .catch(failed)
      ).body?.cancel()
    const response = await portal
      .request(url, {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.api+json, application/json',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: {
          data: {
            type: 'bundleIds',
            id: appleBundle,
            attributes: {
              permissions: { edit: true, delete: true },
              seedId: bundle.data?.attributes?.seedId ?? team,
              teamId: team,
            },
            relationships: {
              bundleIdCapabilities: {
                data: [
                  {
                    type: 'bundleIdCapabilities',
                    attributes: {
                      enabled: true,
                      settings: capability.settings ?? [],
                    },
                    relationships: {
                      capability: {
                        data: { type: 'capabilities', id: capability.type },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      })
      .catch(failed)
    const text = await response.text()
    if (response.status === 401)
      throw new Error(
        `${bundleId} needs ${capability.name} (${capability.type}), and the Apple ID session has ended: ${remedy}`,
      )
    if (!response.ok) {
      let detail = text.slice(0, 300)
      try {
        const first = (
          JSON.parse(text) as {
            errors?: Array<{ title?: string; detail?: string }>
          }
        ).errors?.[0]
        if (first != null)
          detail = [first.title, first.detail].filter(Boolean).join(': ')
      } catch {}
      throw new AppleApiError(
        response.status,
        `PATCH /services-account/v1/bundleIds/${appleBundle}: HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`,
      )
    }
  }

  /** Profiles Mason holds, for the API. */
  list(): Array<
    Omit<StageProfile, 'content'> & {
      team: string
      distribution: string
      platform: string
      expiresAt: number
    }
  > {
    return this.db
      .prepare(
        'SELECT team_id,bundle_id,distribution,platform,name,uuid,expires_at FROM apple_profiles WHERE deleted_at IS NULL ORDER BY team_id,bundle_id,distribution,platform',
      )
      .all()
      .map((row) => ({
        team: String(row.team_id),
        bundleId: String(row.bundle_id),
        distribution: String(row.distribution),
        platform: String(row.platform),
        name: String(row.name),
        uuid: String(row.uuid),
        expiresAt: Number(row.expires_at),
      }))
  }
}

function stageProfile(row: Record<string, unknown>): StageProfile {
  return {
    bundleId: String(row.bundle_id),
    name: String(row.name),
    uuid: String(row.uuid),
    content: String(row.content),
  }
}
