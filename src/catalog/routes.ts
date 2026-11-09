import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'
import QRCode from 'qrcode'
import { Accounts } from '../auth/accounts.js'
import {
  csrf,
  sessionContext,
  standaloneFrame,
  type Frame,
} from '../auth/routes.js'
import { DEVICE_COOKIE, Devices, type DeviceRelay } from '../devices/store.js'
import { Store } from '../store.js'
import { asId, type Platform } from '../validation.js'
import type { FileRequest } from './install.js'
import { platform } from './platform.js'
import {
  CatalogRefused,
  StoreCatalogSource,
  type CatalogSource,
  type DeviceAction,
} from './source.js'
import {
  appUnavailableView,
  appView,
  branchView,
  catalogActive,
  catalogBody,
  catalogView,
  completeView,
  devicesView,
  installView,
  prepareYourDeviceView,
  preparingView,
  waitingView,
  type CatalogPage,
  type CatalogViewer,
} from './views.js'

export { branches } from './source.js'

/** The device cookie each node keeps for its own origin. */
export const deviceCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 30 * 86400000,
}

/** The device a request's cookie selects, unchecked: the source checks it is the caller's. */
export function selectedDevice(req: Request): number | undefined {
  const id = /(?:^|;\s*)__Host-mason-device=(\d+)(?:;|$)/.exec(
    req.headers.cookie ?? '',
  )?.[1]
  return id == null ? undefined : Number(id)
}

function chosenPlatform(req: Request): Platform {
  const preferences = (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('mason-platform='))
  return platform(
    req.query.platform,
    preferences.length === 1 ? preferences[0]!.slice(15) : undefined,
    req.get('user-agent') ?? '',
  )
}

/** The signed-in person the catalog pages are for, on one node. */
export interface CatalogCaller {
  accountId: number
  source: CatalogSource
  viewer: CatalogViewer
  /** Throws unless a state-changing request carries the session's proof from this origin. */
  checkCsrf(req: Request): void
  /** Whether the person may register devices at all. */
  mayRegister: boolean
  /** Whether device registration is configured. */
  registration: boolean
  /** Draws a page in the node's own frame. */
  render(res: Response, page: CatalogPage): void
}

export interface CatalogPagesOptions {
  /** The signed-in caller, or undefined. */
  caller(req: Request): CatalogCaller | undefined
  /** Where a page sends someone who is not signed in. */
  signIn(req: Request): string
  /** A refusal with a short message, such as 403 "Tester access required". */
  refuse(
    res: Response,
    status: number,
    message: string,
    caller?: CatalogCaller,
  ): void
  /** Where grant files come from; they carry no session. */
  files(): CatalogSource
  /** The catalog pages' paths; the master's own `/` is not one. */
  paths?: string[]
  /** The address the device-registration QR code opens. */
  qr(caller: CatalogCaller): string
  /** Answers an error the handlers did not; the node's error page by default. */
  failed?(
    req: Request,
    res: Response,
    error: unknown,
    caller?: CatalogCaller,
  ): void
}

/**
 * Install apps, installs and Devices over a source: the handlers the
 * standalone server, the host and the master share. Each node passes who
 * is signed in, its source, and how its pages are drawn.
 */
export function catalogPages(options: CatalogPagesOptions): {
  catalog: Router
  installs: Router
  devices: Router
} {
  const guarded =
    (
      run: (
        req: Request,
        res: Response,
        caller: CatalogCaller | undefined,
      ) => Promise<void>,
    ): RequestHandler =>
    async (req, res) => {
      const caller = options.caller(req)
      try {
        await run(req, res, caller)
      } catch (error) {
        if (error instanceof CatalogRefused)
          options.refuse(res, error.status, error.message, caller)
        else if (options.failed != null) options.failed(req, res, error, caller)
        else throw error
      }
    }
  const catalog = Router()
  catalog.get(
    options.paths ?? [
      '/',
      '/apps',
      '/apps/:appId',
      '/apps/:appId/branches/:branchKey',
    ],
    guarded(async (req, res, caller) => {
      if (caller == null) {
        res.redirect(303, options.signIn(req))
        return
      }
      const chosen = chosenPlatform(req)
      try {
        if (req.params.appId == null) {
          caller.render(
            res,
            catalogView(
              await caller.source.apps(caller.accountId),
              chosen,
              req.path,
            ),
          )
          return
        }
        const appId = asId(Number(req.params.appId))
        if (req.params.branchKey == null) {
          caller.render(
            res,
            appView(
              await caller.source.app(caller.accountId, appId, chosen),
              chosen,
              req.path,
            ),
          )
          return
        }
        caller.render(
          res,
          branchView(
            await caller.source.branch(
              caller.accountId,
              appId,
              String(req.params.branchKey),
              chosen,
              selectedDevice(req),
            ),
            caller.viewer,
            chosen,
            req.path,
          ),
        )
      } catch (error) {
        // Waiting for access, or an app the person may not see; anything
        // else (a host still waiting for its master) is refused as it came.
        if (
          !(error instanceof CatalogRefused) ||
          (error.status !== 403 && error.status !== 404)
        )
          throw error
        caller.render(
          res,
          error.status === 403
            ? waitingView()
            : appUnavailableView(chosen, req.path),
        )
      }
    }),
  )

  const installs = Router()
  installs.post(
    '/builds/:id/install',
    guarded(async (req, res, caller) => {
      if (caller == null) {
        options.refuse(res, 401, 'Sign in required')
        return
      }
      caller.checkCsrf(req)
      const result = await caller.source.install(
        caller.accountId,
        asId(Number(req.params.id)),
        selectedDevice(req),
      )
      if (result.kind === 'register' || result.kind === 'prepare') {
        caller.render(res, prepareYourDeviceView(caller.viewer, result))
        return
      }
      if (result.kind === 'download') {
        res.redirect(303, `/install/${result.token}/artifact`)
        return
      }
      caller.render(res, installView(caller.viewer, result.token))
    }),
  )
  installs.get(
    '/install/:token/:part',
    guarded(async (req, res) => {
      const part = String(req.params.part)
      if (part !== 'manifest.plist' && part !== 'artifact') {
        options.refuse(res, 404, 'Not found')
        return
      }
      const request: FileRequest = {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        ...(req.get('range') == null ? {} : { range: req.get('range')! }),
        ...(req.get('if-range') == null
          ? {}
          : { ifRange: req.get('if-range')! }),
      }
      await options
        .files()
        .installFile(String(req.params.token), part, request, res)
    }),
  )

  const devices = Router()
  devices.get(
    ['/devices', '/devices/complete/:token', '/devices/qr'],
    guarded(async (req, res, caller) => {
      if (caller == null) {
        res.redirect(303, options.signIn(req))
        return
      }
      if (!caller.mayRegister) {
        options.refuse(res, 403, 'Tester access required', caller)
        return
      }
      if (req.path === '/devices/qr') {
        res.type('image/svg+xml').send(
          await QRCode.toString(options.qr(caller), {
            type: 'svg',
            margin: 2,
            color: { dark: '#10151e', light: '#ffffff' },
          }),
        )
        return
      }
      if (req.params.token != null) {
        const done = await caller.source.complete(
          caller.accountId,
          String(req.params.token),
        )
        if (done.state === 'unavailable') {
          options.refuse(
            res,
            410,
            'Registration link is unavailable. Return to Register Device.',
            caller,
          )
          return
        }
        if (done.state === 'registered')
          res.cookie(DEVICE_COOKIE, String(done.device.id), deviceCookieOptions)
        caller.render(res, completeView(done))
        return
      }
      caller.render(
        res,
        devicesView(
          await caller.source.devices(caller.accountId, selectedDevice(req)),
          caller.viewer,
        ),
      )
    }),
  )
  devices.post(
    '/devices/profile',
    guarded(async (req, res, caller) => {
      if (caller == null || !caller.mayRegister || !caller.registration) {
        options.refuse(res, 403, 'Tester access required', caller)
        return
      }
      caller.checkCsrf(req)
      const profile = await caller.source.deviceProfile(caller.accountId)
      res
        .set(
          'Content-Disposition',
          'attachment; filename="mason-device-registration.mobileconfig"',
        )
        .type('application/x-apple-aspen-config')
        .send(profile)
    }),
  )
  devices.post(
    '/devices/:id/:action',
    guarded(async (req, res, caller) => {
      if (caller == null || !caller.mayRegister) {
        options.refuse(res, 403, 'Tester access required', caller)
        return
      }
      caller.checkCsrf(req)
      const id = asId(Number(req.params.id))
      const action = String(req.params.action) as DeviceAction
      const name = (req.body as { name?: unknown } | undefined)?.name
      const wasSelected = selectedDevice(req) === id
      if (
        !(await caller.source.deviceAction(
          caller.accountId,
          id,
          action,
          typeof name === 'string' ? name : undefined,
        ))
      ) {
        options.refuse(res, 404, 'Device unavailable', caller)
        return
      }
      if (action === 'select')
        res.cookie(DEVICE_COOKIE, String(id), deviceCookieOptions)
      if (action === 'remove' && wasSelected)
        res.clearCookie(DEVICE_COOKIE, deviceCookieOptions)
      res.redirect(303, '/devices')
    }),
  )
  devices.post(
    '/builds/:id/prepare',
    guarded(async (req, res, caller) => {
      if (caller == null || !caller.mayRegister || !caller.registration) {
        options.refuse(res, 403, 'Tester access required', caller)
        return
      }
      caller.checkCsrf(req)
      const device = selectedDevice(req)
      if (device == null) {
        res.redirect(303, '/devices')
        return
      }
      // A device that is not the person's is as good as none.
      if (
        !(await caller.source.prepare(
          caller.accountId,
          asId(Number(req.params.id)),
          device,
        ))
      ) {
        res.redirect(303, '/devices')
        return
      }
      caller.render(res, preparingView())
    }),
  )
  return { catalog, installs, devices }
}

/** How the store pages are drawn and where device registrations go. */
export interface StorePagesOptions {
  /** A host's relay of new devices to the master. */
  relay?: DeviceRelay
  /** The node's shell; the standalone server's by default. */
  frame?: Frame
  /** The node the pages are on: a host, or a standalone server by default. */
  node?: 'host' | 'standalone'
}

/** The catalog pages over a distribution store: a standalone server's, or a host's cache. */
function storePages(
  store: Store,
  accounts: Accounts,
  options: StorePagesOptions = {},
): ReturnType<typeof catalogPages> {
  const relay = options.relay
  const frame = options.frame ?? standaloneFrame(accounts)
  return catalogPages({
    caller(req) {
      const context = sessionContext(req, accounts)
      if (context == null) return undefined
      return {
        accountId: context.account.id,
        source: new StoreCatalogSource(store, {
          session: context.session,
          ...(relay == null ? {} : { relay }),
        }),
        viewer: {
          node: options.node ?? 'standalone',
          csrf: context.session.csrf,
          origin: store.config.origin,
        },
        checkCsrf: (req): void => {
          csrf(req, store, context.session)
        },
        mayRegister: new Devices(store, relay).allowed(context.account),
        registration: store.config.devices != null,
        render(res, view): void {
          if (view.refresh != null) res.set('Refresh', String(view.refresh))
          res.status(view.status ?? 200).send(
            frame(req, {
              title: view.title,
              body: catalogBody(view, { node: options.node ?? 'standalone' }),
              active: catalogActive(req.path),
              ...(view.interactive === true
                ? { scripts: ['/assets/catalog.js'] }
                : {}),
            }),
          )
        },
      }
    },
    signIn: (req) =>
      '/auth/login?return=' + encodeURIComponent(req.originalUrl),
    refuse(res, status, message, caller) {
      // Someone signed in keeps the side menu.
      if (caller == null) res.status(status).send(message)
      else caller.render(res, { title: message, body: '', status })
    },
    files: () => new StoreCatalogSource(store),
    qr: () => store.config.origin + '/devices',
  })
}

/** Install apps on a standalone server or a host: `/`, `/apps` and each app and branch. */
export function catalogRoutes(
  store: Store,
  accounts = new Accounts(store),
  options: StorePagesOptions = {},
): Router {
  return storePages(store, accounts, options).catalog
}

/** Install and a grant's manifest and package, on a standalone server or a host. */
export function installationRoutes(
  store: Store,
  accounts = new Accounts(store),
  options: StorePagesOptions = {},
): Router {
  return storePages(store, accounts, options).installs
}

/** Devices, registration and Prepare for this device, on a standalone server or a host. */
export function deviceRoutes(
  store: Store,
  accounts = new Accounts(store),
  options: StorePagesOptions = {},
): Router {
  return storePages(store, accounts, options).devices
}
