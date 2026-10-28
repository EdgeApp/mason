import express, { Router } from 'express'
import { actorOf, apiErrors, authenticate, json } from './api.js'
import { parseSpaceUrl, SpaceClient, SpaceError } from './cloud/spaces.js'
import { allow } from './permissions.js'
import type { Master } from './runtime.js'

/**
 * `/api/v2/storage`: where the host keeps builds. `POST …/space` takes a
 * DigitalOcean Space's URL, access key and secret, checks that the key can
 * write, read and delete in it, and only then saves it as the `storage`
 * area; `POST …/disk` returns to the host's own disk. New files go to the
 * new storage; earlier ones are still served from where they were written.
 */
export function storageApi(
  master: Master,
  options: {
    fetch?: typeof fetch
    /** A Spaces region's S3 endpoint; DigitalOcean's by default (a fake in tests). */
    endpoint?: (region: string) => string
  } = {},
): Router {
  const router = Router()
  router.use(
    '/api/v2/storage',
    express.json({ limit: '64kb' }),
    authenticate(master),
  )
  router.get(
    '/api/v2/storage',
    json((_req, res) => master.settings.get(actorOf(res), 'storage')),
  )
  router.post(
    '/api/v2/storage/space',
    json(async (req, res) => {
      const actor = actorOf(res)
      allow(actor, 'settings.change')
      const body = (req.body ?? {}) as Record<string, unknown>
      const parsed = parseSpaceUrl(body.url, body.bucket)
      const location = {
        ...parsed,
        endpoint: options.endpoint?.(parsed.region) ?? parsed.endpoint,
      }
      const accessKeyId =
        typeof body.accessKeyId === 'string' ? body.accessKeyId.trim() : ''
      let secret = body.secretAccessKey
      if (
        secret != null &&
        typeof secret === 'object' &&
        (secret as { keep?: unknown }).keep === true
      )
        secret = (
          master.settings.value('storage')?.s3 as
            | { secretAccessKey?: string }
            | undefined
        )?.secretAccessKey
      if (
        typeof secret !== 'string' ||
        secret.trim() === '' ||
        accessKeyId === ''
      )
        throw new Error('The Space’s access key and secret are required')
      try {
        await new SpaceClient(
          location,
          { accessKeyId, secretAccessKey: secret.trim() },
          options.fetch,
        ).check(location.bucket)
      } catch (error) {
        throw new Error(
          `Nothing was saved: ${error instanceof SpaceError ? error.message : (error as Error).message}`,
        )
      }
      return await master.settings.set(actor, 'storage', {
        driver: 's3',
        s3: {
          endpoint: location.endpoint,
          bucket: location.bucket,
          region: location.region,
          accessKeyId,
          secretAccessKey: secret.trim(),
        },
      })
    }),
  )
  router.post(
    '/api/v2/storage/disk',
    json(
      async (_req, res) =>
        await master.settings.set(actorOf(res), 'storage', { driver: 'disk' }),
    ),
  )
  router.use('/api/v2/storage', apiErrors)
  return router
}
