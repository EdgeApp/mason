// Install apps and Devices rules the server pages and the web app share:
// which platform a visit is for, how a run's variants group into one build,
// what a device's state and model read as, and when Devices refreshes.
import { platformNames, type PlatformName } from './api/dashboard.js'
import type { CatalogBuild, DeviceInfo } from './api/catalog.js'

/** The cookie that remembers the platform a person chose on the catalog. */
export const PLATFORM_COOKIE = 'mason-platform'

/** Whether a value names a platform Mason builds for. */
export const isPlatform = (value: unknown): value is PlatformName =>
  typeof value === 'string' &&
  (platformNames as readonly string[]).includes(value)

/**
 * The platform a catalog visit is for: the address's choice, else the
 * remembered one, else the browser's own (an iPhone or iPad is iOS).
 */
export function choosePlatform(
  query: string | null | undefined,
  preference: string | undefined,
  userAgent: string,
): PlatformName {
  if (isPlatform(query)) return query
  if (isPlatform(preference)) return preference
  if (/iPad|iPhone|iPod/i.test(userAgent)) return 'ios'
  if (/Android/i.test(userAgent)) return 'android'
  if (/Macintosh|Mac OS/i.test(userAgent)) return 'macos'
  if (/Windows/i.test(userAgent)) return 'windows'
  return 'ios'
}

/**
 * A run's variants are one build: grouped, newest run first. The default
 * leads, else the first variant by name in byte order (plain `<`, not
 * `localeCompare`), as the dashboard's `leadsItsBuild` and the run pages
 * order them, so every view names the same lead build.
 */
export function groupBuilds<
  T extends Pick<CatalogBuild, 'id' | 'run' | 'variant'>,
>(builds: readonly T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const build of builds) {
    const key = build.run == null ? `build:${build.id}` : `run:${build.run}`
    const group = groups.get(key)
    if (group == null) groups.set(key, [build])
    else group.push(build)
  }
  return [...groups.values()].map((group) =>
    [...group].sort(
      (a, b) =>
        Number(a.variant !== '') - Number(b.variant !== '') ||
        (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0),
    ),
  )
}

/** A device's state in words: the same words on every page that lists devices. */
export const DEVICE_STATE_LABELS: Record<DeviceInfo['status'], string> = {
  pending: 'Waiting to register with Apple',
  processing: 'Apple registration is processing',
  registered: 'Registered with Apple',
  error: 'Preparation needs attention',
}

/** A device state's words, or the state itself when it is not one Mason knows. */
export const deviceStateLabel = (status: string): string =>
  (DEVICE_STATE_LABELS as Record<string, string>)[status] ?? status

/** `iPhone15Pro` → `iPhone 15 Pro`: the model a registration names, for people. */
export const humanModel = (model: string): string =>
  model.replace(
    /^(iPhone|iPad|iPod)(.+)$/,
    (_match, family: string, variant: string) =>
      family + ' ' + variant.replace(/(\d|[a-z])([A-Z])/g, '$1 $2'),
  )

/**
 * Whether Devices should look again shortly: a device is still with Apple,
 * or registered but not yet told whether its builds are prepared.
 */
export const devicesPending = (
  devices: ReadonlyArray<Pick<DeviceInfo, 'status' | 'message'>>,
): boolean =>
  devices.some(
    (d) =>
      d.status === 'pending' ||
      d.status === 'processing' ||
      (d.status === 'registered' && d.message === ''),
  )

/**
 * A branch's key in catalog addresses: its UTF-8 bytes in base64url, as the
 * server's `branchKey` makes it, in any JavaScript runtime.
 */
export function branchKey(branch: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(branch))
    binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
