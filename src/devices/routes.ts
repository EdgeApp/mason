import express, { Router } from 'express'
import { Store, digest } from '../store.js'
import { verifyCms } from './cms.js'
import { decodePlist } from './plist.js'
import { Devices, type DeviceRelay } from './store.js'

/**
 * The Profile Service callback: a device's signed answer, verified and
 * recorded, then a 301 back to the origin that asked for the profile.
 * Devices, Register Device and the selected device are in
 * `src/catalog/routes.ts`.
 */
export function deviceCallbackRoutes(
  store: Store,
  relay?: DeviceRelay,
): Router {
  const router = Router(),
    devices = new Devices(store, relay)
  let active = 0
  const windows = new Map<string, { count: number; at: number }>()
  router.post(
    '/devices/callback/:token',
    (req, res, next) => {
      if (
        !store.config.devices ||
        !/^[A-Za-z0-9_-]{43}$/.test(req.params.token) ||
        active >= 4
      ) {
        res.status(400).send('Registration is unavailable')
        return
      }
      const now = Date.now(),
        key = req.ip ?? 'unknown'
      for (const [ip, w] of windows) if (now - w.at > 60000) windows.delete(ip)
      const w = windows.get(key) ?? { count: 0, at: now }
      windows.set(key, w)
      if (++w.count > 30) {
        res.status(429).send('Try again shortly')
        return
      }
      const row = store.db
        .prepare(
          'SELECT hash,return_origin FROM device_challenges WHERE hash=? AND expires_at>? AND device_id IS NULL',
        )
        .get(digest(req.params.token), store.now())
      if (!row) {
        res
          .status(410)
          .send(
            'This registration request has expired. Return to Mason and try again.',
          )
        return
      }
      res.locals.returnOrigin =
        typeof row.return_origin === 'string'
          ? row.return_origin
          : store.config.origin
      next()
    },
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      active++
      let stage = 'signature'
      try {
        const cfg = store.config.devices!
        const bytes = await verifyCms(
          req.body as Buffer,
          cfg.trustStoreFile,
          true,
          cfg.openssl,
        )
        stage = 'attributes'
        const attributes = decodePlist(bytes)
        stage = 'registration'
        devices.receive(String(req.params.token), attributes)
        // Profile Service recognizes 301 as the handoff back to Safari.
        // A normal 303 makes Settings follow the HTML page as another profile.
        // Back to the origin that asked: the master's, for a registration
        // started there, where the person is signed in.
        res.redirect(
          301,
          String(res.locals.returnOrigin) +
            '/devices/complete/' +
            String(req.params.token),
        )
      } catch {
        // Never log the token, signed payload, UDID or certificate contents.
        console.error('Mason device callback failed at ' + stage)
        res
          .status(400)
          .send(
            'Device registration could not be verified. Open Mason in Safari and start again.',
          )
      } finally {
        active--
      }
    },
  )
  return router
}
