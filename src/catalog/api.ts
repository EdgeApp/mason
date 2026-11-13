import { randomBytes } from 'node:crypto'
import express, {
  Router,
  type ErrorRequestHandler,
  type Request,
  type Response,
} from 'express'
import { DEVICE_COOKIE } from '../devices/store.js'
import {
  CATALOG_APPS_PATH,
  DEVICES_PATH,
  deviceActions,
  REGISTRATIONS_PATH,
  type AppData,
  type AppsData,
  type BranchData,
  type CompleteData,
  type DeviceActionName,
  type DevicesData,
  type InstallAnswer,
  type IosDelivery,
  type PrepareAnswer,
  type RegistrationAnswer,
} from '../shared/api/index.js'
import { asId } from '../validation.js'
import { iosInstallUrl } from './install.js'
import {
  chosenPlatform,
  deviceCookieOptions,
  selectedDevice,
} from './routes.js'
import { CatalogRefused, type CatalogSource } from './source.js'

/** How long a registration profile's download link lasts. */
export const PROFILE_MS = 5 * 60_000
/** Profiles waiting to be downloaded, at most, per node. */
const MAX_PROFILES = 256

/** The signed-in person Install apps and Devices answer for, on one node. */
export interface CatalogApiCaller {
  accountId: number
  source: CatalogSource
  /** Throws unless a state-changing request carries the session's proof from this origin. */
  checkCsrf(req: Request): void
  /** Whether the person may register devices at all. */
  mayRegister: boolean
  /** Whether device registration is configured. */
  registration: boolean
  /** The public origin an iOS installer's manifest is served on; none when the node has none. */
  installOrigin?: string
  /**
   * The host's origin, when iOS installs and device registration go through
   * its own pages (a master without a public address of its own).
   */
  hostPages?: string
}

/** How iOS apps install for a caller: here, through the host's pages, or not at all. */
export function iosDelivery(caller: CatalogApiCaller): IosDelivery {
  if (caller.hostPages != null) return { via: 'host', host: caller.hostPages }
  return caller.installOrigin == null || caller.installOrigin === ''
    ? { via: 'none' }
    : { via: 'here' }
}

export interface CatalogApiOptions {
  /** The signed-in caller, or undefined. */
  caller(req: Request): CatalogApiCaller | undefined
  /** The status and message for an error the node knows (its host unreachable); else undefined. */
  failure?(error: unknown): { status: number; error: string } | undefined
  now?: () => number
}

/** A refusal with its status, answered as `{ error }`. */
class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const REGISTER_FIRST = 'Tester access required'

/**
 * Install apps and Devices as JSON, over the same source as the pages: the
 * host's own cache, or the host's answers relayed over the master's link.
 * Changes need the session's CSRF proof. A registration profile is made by
 * `POST /api/v2/devices/registrations` and downloaded once, with a plain
 * `GET` of the link it answers.
 */
export function catalogApi(options: CatalogApiOptions): Router {
  const router = Router()
  const now = options.now ?? Date.now
  const profiles = new Map<string, { profile: string; expiresAt: number }>()
  router.use(
    ['/api/v2/catalog', DEVICES_PATH],
    express.json({ limit: '16kb', strict: true }),
  )
  const signedIn = (req: Request): CatalogApiCaller => {
    const caller = options.caller(req)
    if (caller == null) throw new Refused(401, 'Not signed in')
    return caller
  }
  const registrant = (req: Request, configured = false): CatalogApiCaller => {
    const caller = signedIn(req)
    if (!caller.mayRegister || (configured && !caller.registration))
      throw new Refused(403, REGISTER_FIRST)
    return caller
  }
  /** A change needs the session's proof from the node's own origin: 403 without it. */
  const proven = (caller: CatalogApiCaller, req: Request): void => {
    try {
      caller.checkCsrf(req)
    } catch (error) {
      throw new Refused(403, (error as Error).message)
    }
  }
  const route =
    <T>(
      handler: (req: Request, res: Response) => Promise<T>,
    ): express.RequestHandler =>
    (req, res, next) => {
      handler(req, res).then((body) => {
        res.json(body ?? null)
      }, next)
    }
  const id = (value: unknown): number => {
    try {
      return asId(Number(value))
    } catch {
      throw new Refused(404, 'Not found')
    }
  }
  const devices = async (
    caller: CatalogApiCaller,
    selected: number | undefined,
  ): Promise<DevicesData> => {
    const data = await caller.source.devices(caller.accountId, selected)
    return caller.hostPages == null ? data : { ...data, via: caller.hostPages }
  }

  router.get(
    CATALOG_APPS_PATH,
    route(async (req): Promise<AppsData> => {
      const caller = signedIn(req)
      return await caller.source.apps(caller.accountId)
    }),
  )
  router.get(
    `${CATALOG_APPS_PATH}/:id`,
    route(async (req): Promise<AppData> => {
      const caller = signedIn(req)
      return await caller.source.app(
        caller.accountId,
        id(req.params.id),
        chosenPlatform(req),
      )
    }),
  )
  router.get(
    `${CATALOG_APPS_PATH}/:id/branches/:key`,
    route(async (req): Promise<BranchData> => {
      const caller = signedIn(req)
      const data = await caller.source.branch(
        caller.accountId,
        id(req.params.id),
        String(req.params.key),
        chosenPlatform(req),
        selectedDevice(req),
      )
      const ios = iosDelivery(caller)
      return {
        ...data,
        ios,
        // A grant links straight to the installer on the node's address.
        builds: data.builds.map((build) =>
          build.token == null || ios.via !== 'here'
            ? build
            : {
                ...build,
                installUrl: iosInstallUrl(caller.installOrigin!, build.token),
              },
        ),
      }
    }),
  )
  router.post(
    '/api/v2/catalog/builds/:id/install',
    route(async (req): Promise<InstallAnswer> => {
      const caller = signedIn(req)
      proven(caller, req)
      const result = await caller.source.install(
        caller.accountId,
        id(req.params.id),
        selectedDevice(req),
      )
      if (result.kind === 'register') return { kind: 'register' }
      if (result.kind === 'prepare')
        return { kind: 'prepare', buildId: result.buildId }
      const expiry =
        result.expiresAt == null ? {} : { expiresAt: result.expiresAt }
      if (result.kind === 'download')
        return {
          kind: 'download',
          url: `/install/${result.token}/artifact`,
          ...expiry,
        }
      return {
        kind: 'itms',
        ...(caller.installOrigin == null || caller.installOrigin === ''
          ? {}
          : { url: iosInstallUrl(caller.installOrigin, result.token) }),
        ...expiry,
      }
    }),
  )
  router.post(
    '/api/v2/catalog/builds/:id/prepare',
    route(async (req): Promise<PrepareAnswer> => {
      const caller = registrant(req, true)
      proven(caller, req)
      const device = selectedDevice(req)
      // A device that is not the person's is as good as none.
      return {
        prepared:
          device != null &&
          (await caller.source.prepare(
            caller.accountId,
            id(req.params.id),
            device,
          )),
      }
    }),
  )
  router.get(
    DEVICES_PATH,
    route(
      async (req): Promise<DevicesData> =>
        await devices(registrant(req), selectedDevice(req)),
    ),
  )
  router.post(
    REGISTRATIONS_PATH,
    route(async (req): Promise<RegistrationAnswer> => {
      const caller = registrant(req, true)
      proven(caller, req)
      const profile = await caller.source.deviceProfile(caller.accountId)
      const at = now()
      for (const [token, entry] of profiles)
        if (entry.expiresAt <= at) profiles.delete(token)
      while (profiles.size >= MAX_PROFILES)
        profiles.delete(profiles.keys().next().value!)
      const token = randomBytes(32).toString('base64url')
      const expiresAt = at + PROFILE_MS
      profiles.set(token, { profile, expiresAt })
      return { url: `/devices/profiles/${token}`, expiresAt }
    }),
  )
  router.get(
    `${DEVICES_PATH}/complete/:token`,
    route(async (req, res): Promise<CompleteData> => {
      const caller = registrant(req)
      const done = await caller.source.complete(
        caller.accountId,
        String(req.params.token),
      )
      if (done.state === 'registered')
        res.cookie(DEVICE_COOKIE, String(done.device.id), deviceCookieOptions)
      return done
    }),
  )
  router.post(
    `${DEVICES_PATH}/:id/:action`,
    route(async (req, res): Promise<DevicesData> => {
      const caller = registrant(req)
      proven(caller, req)
      const device = id(req.params.id)
      const action = String(req.params.action)
      if (!(deviceActions as readonly string[]).includes(action))
        throw new Refused(404, 'Unknown action')
      const name = (req.body as { name?: unknown } | undefined)?.name
      const selected = selectedDevice(req)
      if (
        !(await caller.source.deviceAction(
          caller.accountId,
          device,
          action as DeviceActionName,
          typeof name === 'string' ? name : undefined,
        ))
      )
        throw new Refused(404, 'Device unavailable')
      let chosen = selected
      if (action === 'select') {
        res.cookie(DEVICE_COOKIE, String(device), deviceCookieOptions)
        chosen = device
      }
      if (action === 'remove' && selected === device) {
        res.clearCookie(DEVICE_COOKIE, deviceCookieOptions)
        chosen = undefined
      }
      return await devices(caller, chosen)
    }),
  )
  // The profile a registration made: a plain download, once, until it expires.
  router.get('/devices/profiles/:token', (req, res) => {
    const token = String(req.params.token)
    const entry = profiles.get(token)
    profiles.delete(token)
    if (entry == null || entry.expiresAt <= now()) {
      res
        .status(404)
        .type('text/plain')
        .send('This registration link has expired')
      return
    }
    res
      .set(
        'Content-Disposition',
        'attachment; filename="mason-device-registration.mobileconfig"',
      )
      .set('Cache-Control', 'no-store')
      .type('application/x-apple-aspen-config')
      .send(entry.profile)
  })
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const known =
      error instanceof Refused || error instanceof CatalogRefused
        ? { status: error.status, error: error.message }
        : options.failure?.(error)
    res.status(known?.status ?? 400).json({
      error:
        known?.error ??
        (error instanceof Error ? error.message : 'Request failed'),
    })
  }
  router.use(['/api/v2/catalog', DEVICES_PATH], errors)
  return router
}
