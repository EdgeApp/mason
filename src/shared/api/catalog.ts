import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
  type Cleaner,
} from 'cleaners'
import { platformNames, type PlatformName } from './dashboard.js'
import { asNullable } from './artifacts.js'

/** `GET /api/v2/catalog/apps`, both nodes: Install apps. */
export const CATALOG_APPS_PATH = '/api/v2/catalog/apps'
/** `GET /api/v2/catalog/apps/:id?platform=`. */
export const catalogAppPath = (id: number): string =>
  `/api/v2/catalog/apps/${id}`
/** `GET /api/v2/catalog/apps/:id/branches/:key?platform=`. */
export const catalogBranchPath = (id: number, key: string): string =>
  `/api/v2/catalog/apps/${id}/branches/${encodeURIComponent(key)}`
/** `POST /api/v2/catalog/builds/:id/install`. */
export const installPath = (id: number): string =>
  `/api/v2/catalog/builds/${id}/install`
/** `POST /api/v2/catalog/builds/:id/prepare`. */
export const preparePath = (id: number): string =>
  `/api/v2/catalog/builds/${id}/prepare`
/** `GET /api/v2/devices`, both nodes. */
export const DEVICES_PATH = '/api/v2/devices'
/** `POST /api/v2/devices/registrations`: a registration profile to download. */
export const REGISTRATIONS_PATH = '/api/v2/devices/registrations'
/** `POST /api/v2/devices/:id/{select,rename,retry,remove}`. */
export const deviceActionPath = (
  id: number,
  action: DeviceActionName,
): string => `/api/v2/devices/${id}/${action}`
/** `GET /api/v2/devices/complete/:token`: where a registration link ended. */
export const deviceCompletePath = (token: string): string =>
  `/api/v2/devices/complete/${encodeURIComponent(token)}`

export const deviceActions = ['select', 'rename', 'retry', 'remove'] as const
export type DeviceActionName = (typeof deviceActions)[number]

/** An app the viewer may install. */
export interface CatalogApp {
  id: number
  name: string
  slug: string
}

/** The apps list: the viewer's apps and the platforms they have channels for. */
export interface AppsData {
  apps: CatalogApp[]
  platforms: PlatformName[]
}

/** An app's branches, newest build first, and each platform's latest build. */
export interface AppData {
  app: CatalogApp
  platforms: PlatformName[]
  /** Every branch with a build on any platform, master first. */
  branches: Array<{ name: string; time: number }>
  /** When each platform's newest build was published. */
  latest: Partial<Record<PlatformName, number>>
}

/** One build on a branch page, with what the selected device may do with it. */
export interface CatalogBuild {
  id: number
  platform: PlatformName
  format: string
  version: string
  buildNumber: string
  commit: string
  publishedAt: number
  size: number
  variant: string
  run: string | null
  /** For a build that is only downloaded: what it runs on. */
  download?: string
  /** Whether the selected device (or none, off iOS) may install it. */
  eligible: boolean
  /** The grant for an eligible iOS app, so the tap opens the installer. */
  token?: string
}

/** A branch's builds for one platform, newest first. */
export interface BranchData {
  app: CatalogApp
  platforms: PlatformName[]
  branch: string
  builds: CatalogBuild[]
  /** Whether the viewer has a device selected. */
  device: boolean
}

/** A registered (or registering) device. */
export interface DeviceInfo {
  id: number
  udid: string
  product: string
  model: string
  os_version: string
  status: 'pending' | 'processing' | 'registered' | 'error'
  message: string
  created_at: number
  updated_at: number
}

/** A person's devices, and every registered device for an administrator. */
export interface DevicesData {
  devices: Array<DeviceInfo & { name: string }>
  selected?: number
  /** Whether device registration is configured here. */
  registration: boolean
  all: Array<{ name: string; model: string; status: string }>
}

/** Where a registration link ended. */
export type CompleteData =
  | { state: 'registering' }
  | { state: 'registered'; device: { id: number; model: string } }
  | { state: 'unavailable' }

/**
 * What Install answers: the installer's `itms-services` link, a download,
 * or what the device needs first (register one, or prepare a build for it).
 */
export interface InstallAnswer {
  kind: 'itms' | 'download' | 'register' | 'prepare'
  url?: string
  /** When the link stops working (ms since the epoch). */
  expiresAt?: number
  /** For `prepare`: the build to prepare the device for. */
  buildId?: number
}

/** What Prepare for this device answers: false without a device of the person's selected. */
export interface PrepareAnswer {
  prepared: boolean
}

/** What a registration answers: where its profile downloads, once, until it expires. */
export interface RegistrationAnswer {
  url: string
  expiresAt: number
}

const asPlatformName: Cleaner<PlatformName> = asValue(...platformNames)

export const asCatalogApp = asObject<CatalogApp>({
  id: asNumber,
  name: asString,
  slug: asString,
})

export const asAppsData = asObject<AppsData>({
  apps: asArray(asCatalogApp),
  platforms: asArray(asPlatformName),
})

export const asAppData = asObject<AppData>({
  app: asCatalogApp,
  platforms: asArray(asPlatformName),
  branches: asArray(asObject({ name: asString, time: asNumber })),
  latest: asObject({
    ios: asOptional(asNumber),
    android: asOptional(asNumber),
    macos: asOptional(asNumber),
    windows: asOptional(asNumber),
    tvos: asOptional(asNumber),
  }),
})

export const asCatalogBuild = asObject<CatalogBuild>({
  id: asNumber,
  platform: asPlatformName,
  format: asString,
  version: asString,
  buildNumber: asString,
  commit: asString,
  publishedAt: asNumber,
  size: asNumber,
  variant: asString,
  run: asNullable(asString),
  download: asOptional(asString),
  eligible: asBoolean,
  token: asOptional(asString),
})

export const asBranchData = asObject<BranchData>({
  app: asCatalogApp,
  platforms: asArray(asPlatformName),
  branch: asString,
  builds: asArray(asCatalogBuild),
  device: asBoolean,
})

export const asDeviceInfo = asObject<DeviceInfo & { name: string }>({
  id: asNumber,
  udid: asString,
  product: asString,
  model: asString,
  os_version: asString,
  status: asValue('pending', 'processing', 'registered', 'error'),
  message: asString,
  created_at: asNumber,
  updated_at: asNumber,
  name: asString,
})

export const asDevicesData = asObject<DevicesData>({
  devices: asArray(asDeviceInfo),
  selected: asOptional(asNumber),
  registration: asBoolean,
  all: asArray(asObject({ name: asString, model: asString, status: asString })),
})

export const asCompleteData: Cleaner<CompleteData> = (raw) => {
  const { state } = asObject({
    state: asValue('registering', 'registered', 'unavailable'),
  })(raw)
  if (state !== 'registered') return { state }
  return asObject({
    state: asValue('registered'),
    device: asObject({ id: asNumber, model: asString }),
  })(raw)
}

export const asInstallAnswer = asObject<InstallAnswer>({
  kind: asValue('itms', 'download', 'register', 'prepare'),
  url: asOptional(asString),
  expiresAt: asOptional(asNumber),
  buildId: asOptional(asNumber),
})

export const asPrepareAnswer = asObject<PrepareAnswer>({ prepared: asBoolean })

export const asRegistrationAnswer = asObject<RegistrationAnswer>({
  url: asString,
  expiresAt: asNumber,
})
