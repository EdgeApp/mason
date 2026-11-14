import { asArray, asNumber, asObject, asString, asValue } from 'cleaners'
import { asNullable } from './artifacts.js'
import { platformNames, type PlatformName } from './dashboard.js'

/**
 * `GET /api/v2/builds?project=&app=&branch=&platform=&variant=&run=&latest=&limit=`:
 * published builds, newest first, answered by the host (relayed by the master).
 */
export const BUILDS_PATH = '/api/v2/builds'

/** A published build as the builds API answers it. */
export interface BuildView {
  id: number
  /** The app ID. */
  app: string
  appName: string
  project: string | null
  branch: string
  platform: PlatformName
  variant: string
  version: string
  buildNumber: string
  commit: string
  bundleId: string
  format: string
  size: number
  digest: string
  publishedAt: number
  expiresAt: number
  /** The run that published it. */
  run: string | null
  /** Where its file downloads. */
  download: string
}

export const asBuildView = asObject<BuildView>({
  id: asNumber,
  app: asString,
  appName: asString,
  project: asNullable(asString),
  branch: asString,
  platform: asValue(...platformNames),
  variant: asString,
  version: asString,
  buildNumber: asString,
  commit: asString,
  bundleId: asString,
  format: asString,
  size: asNumber,
  digest: asString,
  publishedAt: asNumber,
  expiresAt: asNumber,
  run: asNullable(asString),
  download: asString,
})
export const asBuildViews = asArray(asBuildView)
