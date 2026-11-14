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
import { sendShell, type PageAnswer } from '../node/webRoutes.js'

export interface CatalogShellOptions {
  /** The signed-in caller, or undefined: the JSON routes' own. */
  caller(req: Request): CatalogApiCaller | undefined
  /** Where a page sends someone who is not signed in. */
  signIn(req: Request): string
  /** Where grant files come from; they carry no session. */
  files(): CatalogSource
  /** The address the device-registration QR code opens. */
  qr(caller: CatalogApiCaller): string
  /**
   * The status for an error the node knows (its host missing or away): a
   * page's (`page`), or a grant file's.
   */
  failure?(error: unknown, page: boolean): number | undefined
}

/** The status of a request that failed: a refusal's own, a known failure's, else 400. */
function failed(options: CatalogShellOptions, error: unknown): number {
  return error instanceof CatalogRefused
    ? error.status
    : (options.failure?.(error, true) ?? 400)
}

/**
 * The status an Install apps page (`catalog`: `/apps`, an app, a branch)
 * or Devices answers with, for a signed-in caller: what the web app will
 * show there (a person waiting for tester access 403, an app they may not
 * see 404, a node without its host its own status), or sign-in.
 */
export async function catalogStatus(
  options: CatalogShellOptions,
  subject: 'catalog' | 'devices',
  req: Request,
): Promise<PageAnswer> {
  const caller = options.caller(req)
  if (caller == null) return { redirect: options.signIn(req) }
  try {
    if (subject === 'devices') {
      if (!caller.mayRegister) return 403
      await caller.source.devices(caller.accountId)
      return 200
    }
    const { appId, branchKey } = req.params as Record<string, string>
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
  } catch (error) {
    return failed(options, error)
  }
}

/**
 * Install apps' and Devices' own addresses on a node, beside the pages
 * (which answer the web app's shell, src/node/webRoutes.ts): the
 * registration's completion link, which first selects the device it
 * registered and then answers the shell (410 for a link that is gone);
 * the QR code; the grants' manifests and packages.
 */
export function catalogShellRoutes(options: CatalogShellOptions): Router {
  const router = Router()
  /** Signed in, or sent to sign in. */
  const signedIn = (
    req: Request,
    res: Response,
  ): CatalogApiCaller | undefined => {
    const caller = options.caller(req)
    if (caller == null) res.redirect(303, options.signIn(req))
    return caller
  }
  router.get('/devices/complete/:token', (req, res) => {
    const caller = signedIn(req, res)
    if (caller == null) return
    if (!caller.mayRegister) {
      sendShell(res, { status: 403 })
      return
    }
    caller.source.complete(caller.accountId, String(req.params.token)).then(
      (done) => {
        if (done.state === 'registered')
          res.cookie(DEVICE_COOKIE, String(done.device.id), deviceCookieOptions)
        sendShell(res, { status: done.state === 'unavailable' ? 410 : 200 })
      },
      (error: unknown) => {
        sendShell(res, { status: failed(options, error) })
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
