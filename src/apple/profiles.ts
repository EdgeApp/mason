import { createHash } from 'node:crypto'
import type { MasterDatabase } from '../master/database.js'
import type { CertificateKind, Certificates } from './certificates.js'
import { AppleApiError, type AppStoreConnect } from './connect.js'

export const distributions = [
  'development',
  'adHoc',
  'appStore',
  'developerId',
  'macAppStore',
] as const
export type Distribution = (typeof distributions)[number]
export type ApplePlatform = 'ios' | 'macos'

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

/** Capabilities Apple requires on the bundle ID for entitlements an archive carries. */
const capabilityFor: Record<string, string> = {
  'aps-environment': 'PUSH_NOTIFICATIONS',
  'com.apple.developer.aps-environment': 'PUSH_NOTIFICATIONS',
  'com.apple.security.application-groups': 'APP_GROUPS',
  'com.apple.developer.icloud-container-identifiers': 'ICLOUD',
  'com.apple.developer.icloud-services': 'ICLOUD',
  'com.apple.developer.ubiquity-kvstore-identifier': 'ICLOUD',
  'com.apple.developer.associated-domains': 'ASSOCIATED_DOMAINS',
  'com.apple.developer.healthkit': 'HEALTHKIT',
  'com.apple.developer.homekit': 'HOMEKIT',
  'com.apple.developer.in-app-payments': 'APPLE_PAY',
  'com.apple.developer.applesignin': 'APPLE_ID_AUTH',
  'com.apple.developer.networking.wifi-info': 'ACCESS_WIFI_INFORMATION',
  'com.apple.developer.nfc.readersession.formats': 'NFC_TAG_READING',
  'com.apple.developer.siri': 'SIRIKIT',
  'com.apple.developer.pass-type-identifiers': 'WALLET',
  'com.apple.developer.networking.networkextension': 'NETWORK_EXTENSIONS',
  'com.apple.developer.networking.vpn.api': 'PERSONAL_VPN',
  'com.apple.developer.usernotifications.time-sensitive':
    'USER_NOTIFICATIONS_TIME_SENSITIVE',
  'com.apple.developer.game-center': 'GAME_CENTER',
  'com.apple.developer.default-data-protection': 'DATA_PROTECTION',
}
export function capabilitiesOf(
  entitlements: Record<string, unknown>,
): string[] {
  return [
    ...new Set(
      Object.keys(entitlements)
        .map((key) => capabilityFor[key])
        .filter((type): type is string => type != null),
    ),
  ].sort()
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
            platform:
              platforms.includes('ios') && platforms.includes('macos')
                ? 'UNIVERSAL'
                : platforms.includes('macos')
                  ? 'MAC_OS'
                  : 'IOS',
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

  /** The enabled devices for a platform, asked of Apple at most every hour or when `fresh`. */
  async devices(
    team: string,
    platform: ApplePlatform,
    fresh = false,
  ): Promise<string[]> {
    const key = `devices:${team}:${platform}`
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
    const ids = (
      await this.connect(team).all(
        `/v1/devices?filter[status]=ENABLED&filter[platform]=${platform === 'macos' ? 'MAC_OS' : 'IOS'}&limit=200`,
      )
    )
      .map((device) => device.id)
      .sort()
    this.db
      .prepare(
        'INSERT INTO apple_cache(key,value,fetched_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,fetched_at=excluded.fetched_at',
      )
      .run(key, JSON.stringify(ids), this.master.now())
    return ids
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
        'SELECT * FROM apple_profiles WHERE team_id=? AND bundle_id=? AND distribution=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
      )
      .get(team, bundleId, distribution) as Record<string, unknown> | undefined
    if (
      current != null &&
      Number(current.expires_at) > this.master.now() + 14 * DAY &&
      Number(current.certificate_id) === certificate.id &&
      String(current.devices) === digest(devices) &&
      String(current.capabilities) === capabilities
    )
      return stageProfile(current)
    const stamp = new Date(this.master.now())
      .toISOString()
      .replace(/\D/g, '')
      .slice(0, 12)
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
          name: `Mason ${labels[distribution]} ${bundleId} ${stamp}`,
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
          'INSERT INTO apple_profiles(team_id,bundle_id,distribution,apple_id,name,uuid,content,expires_at,certificate_id,devices,capabilities,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          team,
          bundleId,
          distribution,
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
   * Adds the capabilities an archive's entitlements need to its bundle ID;
   * true when any was added, which makes its profiles regenerate.
   */
  async syncCapabilities(
    team: string,
    bundleId: string,
    entitlements: Record<string, unknown>,
    platforms: ApplePlatform[] = ['ios'],
  ): Promise<boolean> {
    const appleBundle = await this.bundleId(team, bundleId, platforms)
    const connect = this.connect(team)
    const existing = new Set(
      (
        await connect.all<{ capabilityType: string }>(
          `/v1/bundleIds/${appleBundle}/bundleIdCapabilities`,
        )
      ).map((item) => item.attributes.capabilityType),
    )
    const missing = capabilitiesOf(entitlements).filter(
      (type) => !existing.has(type),
    )
    for (const capabilityType of missing) {
      await connect.request('POST', '/v1/bundleIdCapabilities', {
        data: {
          type: 'bundleIdCapabilities',
          attributes: { capabilityType },
          relationships: {
            bundleId: { data: { type: 'bundleIds', id: appleBundle } },
          },
        },
      })
      existing.add(capabilityType)
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
    return missing.length > 0
  }

  /** Profiles Mason holds, for the API. */
  list(): Array<
    Omit<StageProfile, 'content'> & {
      team: string
      distribution: string
      expiresAt: number
    }
  > {
    return this.db
      .prepare(
        'SELECT team_id,bundle_id,distribution,name,uuid,expires_at FROM apple_profiles WHERE deleted_at IS NULL ORDER BY team_id,bundle_id,distribution',
      )
      .all()
      .map((row) => ({
        team: String(row.team_id),
        bundleId: String(row.bundle_id),
        distribution: String(row.distribution),
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
