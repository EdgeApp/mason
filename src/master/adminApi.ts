import { Router } from 'express'
import { actorOf, apiErrors, authenticate, json } from './api.js'
import { allow } from './permissions.js'
import { appleSigning } from './reads.js'
import type { Master } from './runtime.js'
import {
  APPLE_SIGNING_PATH,
  APPS_PATH,
  type AppItem,
  type AppleSigning,
} from '../shared/api/index.js'

/**
 * The master-only reads its administration pages need: Settings → Apple
 * (`GET /api/v2/apple/signing`) and every app, also those no project owns,
 * for a group's picker (`GET /api/v2/apps`).
 */
export function adminApi(master: Master): Router {
  const router = Router()
  const paths = [APPLE_SIGNING_PATH, APPS_PATH]
  router.use(paths, authenticate(master))
  router.get(
    APPLE_SIGNING_PATH,
    json(async (_req, res): Promise<AppleSigning> => {
      allow(actorOf(res), 'settings.read')
      return await appleSigning(master)
    }),
  )
  router.get(
    APPS_PATH,
    json((_req, res): AppItem[] => {
      allow(actorOf(res), 'apps.read')
      return apps(master)
    }),
  )
  router.use(paths, apiErrors)
  return router
}

/** Every app, in the order the catalog lists them. */
export function apps(master: Master): AppItem[] {
  return master.database.db
    .prepare('SELECT id,name,slug,enabled FROM apps ORDER BY position,id')
    .all()
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      slug: String(row.slug),
      enabled: Number(row.enabled) === 1,
    }))
}
