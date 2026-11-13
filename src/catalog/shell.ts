import { Router, type Request, type Response } from 'express'
import { DEVICE_COOKIE } from '../devices/store.js'
import { asId } from '../validation.js'
import type { CatalogApiCaller } from './api.js'
import { branchName } from './platform.js'
import {
  chosenPlatform,
  deviceCookieOptions,
  qrSvg,
  sendInstallFile,
} from './routes.js'
import { CatalogRefused, type CatalogSource } from './source.js'

export interface CatalogShellOptions {
  /** The signed-in caller, or undefined: the JSON routes' own. */
  caller(req: Request): CatalogApiCaller | undefined
  /** Where a page sends someone who is not signed in. */
  signIn(req: Request): string
  /** Answers the web app's shell with a status. */
  shell(res: Response, status: number): void
  /** Where grant files come from; they carry no session. */
  files(): CatalogSource
  /** The address the device-registration QR code opens. */
  qr(caller: CatalogApiCaller): string
  /**
   * The status for an error the node knows (its host missing or away): a
   * page's (`page`), or a grant file's.
   */
  failure?(error: unknown, page: boolean): number | undefined
  /** Install apps' addresses on this node: `/apps` and below, and `/` where it is the home. */
  paths: string[]
}

/**
 * Install apps and Devices on a node: each page's address answers the web
 * app's shell, with the status of what it will show (a person waiting for
 * tester access 403, an app they may not see 404, a missing registration
 * link 410); the registration's completion link first selects the device
 * it registered. The QR code, the grants' manifests and packages stay the
 * node's own.
 */
export function catalogShellRoutes(options: CatalogShellOptions): Router {
  const router = Router()
  /** The status of a request that failed: a refusal's own, a known failure's, else 400. */
  const failed = (error: unknown): number =>
    error instanceof CatalogRefused
      ? error.status
      : (options.failure?.(error, true) ?? 400)
  /** Signed in, or sent to sign in. */
  const signedIn = (
    req: Request,
    res: Response,
  ): CatalogApiCaller | undefined => {
    const caller = options.caller(req)
    if (caller == null) res.redirect(303, options.signIn(req))
    return caller
  }
  router.get(options.paths, (req, res, next) => {
    const caller = signedIn(req, res)
    if (caller == null) return
    const { appId, branchKey } = req.params as Record<string, string>
    const status = async (): Promise<number> => {
      if (appId == null) {
        await caller.source.apps(caller.accountId)
        return 200
      }
      let id: number
      try {
        id = asId(Number(appId))
        if (branchKey != null) branchName(branchKey)
      } catch {
        return 404
      }
      // The app's page only: a branch's would mint its installs' grants.
      await caller.source.app(caller.accountId, id, chosenPlatform(req))
      return 200
    }
    status().then(
      (code) => {
        options.shell(res, code)
      },
      (error: unknown) => {
        if (res.headersSent) next(error)
        else options.shell(res, failed(error))
      },
    )
  })
  router.get('/devices', (req, res) => {
    const caller = signedIn(req, res)
    if (caller == null) return
    if (!caller.mayRegister) {
      options.shell(res, 403)
      return
    }
    caller.source.devices(caller.accountId).then(
      () => {
        options.shell(res, 200)
      },
      (error: unknown) => {
        options.shell(res, failed(error))
      },
    )
  })
  // Where the Profile Service sends the device's browser back: once the
  // device is registered it becomes the selected one, then the app reads it.
  router.get('/devices/complete/:token', (req, res) => {
    const caller = signedIn(req, res)
    if (caller == null) return
    if (!caller.mayRegister) {
      options.shell(res, 403)
      return
    }
    caller.source.complete(caller.accountId, String(req.params.token)).then(
      (done) => {
        if (done.state === 'registered')
          res.cookie(DEVICE_COOKIE, String(done.device.id), deviceCookieOptions)
        options.shell(res, done.state === 'unavailable' ? 410 : 200)
      },
      (error: unknown) => {
        options.shell(res, failed(error))
      },
    )
  })
  router.get('/devices/qr', (req, res, next) => {
    const caller = signedIn(req, res)
    if (caller == null) return
    if (!caller.mayRegister) {
      res.status(403).type('text/plain').send('Tester access required')
      return
    }
    qrSvg(options.qr(caller)).then((svg) => {
      res.type('image/svg+xml').send(svg)
    }, next)
  })
  router.get('/install/:token/:part', (req, res, next) => {
    sendInstallFile(options.files(), req, res).then(
      (sent) => {
        if (!sent) res.status(404).type('text/plain').send('Not found')
      },
      (error: unknown) => {
        if (res.headersSent) {
          res.destroy()
          return
        }
        const status =
          error instanceof CatalogRefused
            ? error.status
            : options.failure?.(error, false)
        if (status == null) {
          next(error)
          return
        }
        res
          .status(status)
          .type('text/plain')
          .send(error instanceof Error ? error.message : 'Request failed')
      },
    )
  })
  return router
}
