import express, { Router } from 'express'
import { actorOf, apiErrors, authenticate, json } from './api.js'
import { asSpaceInput } from './cloud/hosts.js'
import { spacesRegions } from './cloud/regions.js'
import { parseSpaceUrl, SpaceClient, SpaceError } from './cloud/spaces.js'
import { allow } from './permissions.js'
import type { Master } from './runtime.js'
import type { StorageLocation } from './storageLocations.js'

/**
 * `/api/v2/storage`: where the host keeps builds. The host's disk and every
 * Space Mason knows are storage locations; one is where new builds go, and
 * each keeps serving the builds already in it. `POST …/space` adds a Space by
 * URL, access key and secret after checking the key can write, read and
 * delete in it; `POST …/space/new` makes one; both use it for new builds
 * unless `use` is false. `POST …/locations/:id/use` switches where new builds
 * go (`POST …/disk` for the disk), and `DELETE …/locations/:id` removes a
 * Space and its builds.
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
    json(async (_req, res) => {
      const storage = master.settings.get(actorOf(res), 'storage')
      return { ...storage, locations: await locationsWithUsage() }
    }),
  )
  /** The locations with the files and bytes the host holds in each, when it answers. */
  const locationsWithUsage = async (): Promise<StorageLocation[]> => {
    const locations = master.storageLocations.list()
    const usage = await master.hosts
      .askHost<
        Array<{
          bucket?: string
          endpoint?: string
          files: number
          bytes: number
        }>
      >('host.storeUsage', {}, 5_000)
      .catch(() => undefined)
    if (usage == null) return locations
    return locations.map((location) => {
      const entries = usage.filter((entry) =>
        location.kind === 'disk'
          ? entry.bucket == null
          : entry.bucket === location.bucket &&
            entry.endpoint === location.endpoint,
      )
      return {
        ...location,
        usage: {
          files: entries.reduce((sum, entry) => sum + entry.files, 0),
          bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        },
      }
    })
  }
  router.post(
    '/api/v2/storage/locations/:id/use',
    json(async (req, res) => {
      const actor = actorOf(res)
      allow(actor, 'settings.change')
      await master.storageLocations.use(actor, String(req.params.id))
      return master.settings.get(actor, 'storage')
    }),
  )
  router.delete(
    '/api/v2/storage/locations/:id',
    json(async (req, res) => {
      const actor = actorOf(res)
      allow(actor, 'settings.change')
      return await master.storageLocations.remove(
        actor,
        String(req.params.id),
        (req.body as { confirm?: unknown } | undefined)?.confirm,
        {
          hostKeys: async (store) =>
            await master.hosts.askHost<string[]>('host.storeKeys', store),
          hostForget: async (store) => {
            await master.hosts.askHost('host.forgetStore', store)
          },
          forgetFiles: (keys) => {
            master.artifacts.forgetFiles(keys)
          },
          provider: (account) => master.cloudHosts.provider(account),
          destroyBucket: async (provider, options) => {
            await master.hostSpace.destroyBucket(provider, options)
          },
          masterId: master.masterId,
        },
      )
    }),
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
      const added = {
        driver: 's3' as const,
        s3: {
          endpoint: location.endpoint,
          bucket: location.bucket,
          region: location.region,
          accessKeyId,
          secretAccessKey: secret.trim(),
        },
      }
      if (body.use === false || body.use === 'false') {
        master.storageLocations.remember(added, actor.label)
        return master.settings.get(actor, 'storage')
      }
      return await master.settings.set(actor, 'storage', added)
    }),
  )
  // A new Space from one of the master's DigitalOcean accounts, with a key
  // limited to it. The Space and key storage used before stay, because the
  // host serves the builds already there with that key.
  router.post(
    '/api/v2/storage/space/new',
    json(async (req, res) => {
      const actor = actorOf(res)
      allow(actor, 'settings.change')
      const body = (req.body ?? {}) as Record<string, unknown>
      const account = typeof body.account === 'string' ? body.account : ''
      const space = asSpaceInput(body)
      if (!spacesRegions.includes(space.region))
        throw new Error(
          `${space.region} has no Spaces; choose one of ${spacesRegions.join(', ')}`,
        )
      if (master.cloudAccounts.get(account)?.provider !== 'digitalocean')
        throw new Error(`${account || 'That'} is not a DigitalOcean account`)
      const provider = master.cloudHosts.provider(account)
      if (provider == null) throw new Error(`${account} has no API key`)
      const keyName = `mason-storage-${master.masterId}-${space.bucket}`
      let bucketMade = false
      // Nothing saved means no new bucket either.
      const dropBucket = async (): Promise<void> => {
        if (bucketMade)
          await master.hostSpace
            .destroyBucket(provider, {
              bucket: space.bucket,
              region: space.region,
              keyName,
            })
            .catch(() => undefined)
      }
      const current = master.settings.value('storage') as
        | {
            s3?: {
              bucket: string
              accessKeyId: string
              secretAccessKey: string
            }
            managed?: { keyId: string }
          }
        | undefined
      const made = await master.hostSpace
        .makeSpace(provider, {
          bucket: space.bucket,
          region: space.region,
          keyName,
          deleteOld: false,
          onMade: () => {
            bucketMade = true
          },
          ...(current?.managed != null &&
          current.s3?.bucket === space.bucket &&
          current.s3.accessKeyId === current.managed.keyId
            ? {
                key: {
                  accessKeyId: current.s3.accessKeyId,
                  secretAccessKey: current.s3.secretAccessKey,
                },
              }
            : {}),
        })
        .catch(async (error: unknown) => {
          await dropBucket()
          throw new Error(`Nothing was saved: ${(error as Error).message}`)
        })
      try {
        const value = {
          driver: 's3' as const,
          s3: {
            endpoint: made.endpoint,
            bucket: made.bucket,
            region: made.region,
            accessKeyId: made.accessKeyId,
            secretAccessKey: made.secret,
          },
          managed: { account, keyId: made.keyId },
        }
        if (body.use === false || body.use === 'false') {
          master.storageLocations.remember(value, actor.label)
          return master.settings.get(actor, 'storage')
        }
        return await master.settings.set(actor, 'storage', value)
      } catch (error) {
        // Nothing saved means no new key either.
        if (made.keyMade)
          await provider.deleteSpacesKey?.(made.keyId).catch(() => undefined)
        await dropBucket()
        throw new Error(`Nothing was saved: ${(error as Error).message}`)
      }
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
