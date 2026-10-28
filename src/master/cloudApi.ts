import express, { Router } from 'express'
import {
  actorOf,
  apiErrors,
  authenticate,
  Conflict,
  json,
  NotFound,
} from './api.js'
import { MissingAccount } from './cloud/accounts.js'
import type { CloudSetting, PoolSetting } from './cloud/pools.js'
import { allow } from './permissions.js'
import type { Master } from './runtime.js'

/**
 * A pool as a form sends it: numbers and labels arrive as text. Anything
 * else is left for the `cloud` area to check.
 */
export function poolInput(body: unknown): Record<string, unknown> {
  const input = { ...((body ?? {}) as Record<string, unknown>) }
  for (const field of ['maxNodes', 'slots', 'ttlMinutes', 'maxHoursPerNode'])
    if (typeof input[field] === 'string')
      input[field] =
        input[field] === '' ? undefined : Number(input[field] as string)
  if (typeof input.labels === 'string')
    input.labels = input.labels
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label !== '')
  return input
}

/**
 * `/api/v2/cloud/accounts`: the cloud accounts, their keys write-only.
 * `POST …/:id/check` asks the provider again, and `GET …/:id/catalog` lists
 * the regions, sizes and images a pool may use. `/api/v2/cloud/pools` adds,
 * edits and removes pools in the `cloud` area.
 */
export function cloudApi(master: Master): Router {
  const router = Router()
  router.use(
    '/api/v2/cloud',
    express.json({ limit: '64kb' }),
    authenticate(master),
  )
  const missing = (error: unknown): never => {
    throw error instanceof MissingAccount ? new NotFound(error.message) : error
  }
  router.get(
    '/api/v2/cloud/accounts',
    json((_req, res) => master.cloudAccounts.list(actorOf(res))),
  )
  router.post(
    '/api/v2/cloud/accounts',
    json(async (req, res) => {
      const account = await master.cloudAccounts.add(actorOf(res), req.body)
      res.status(201)
      return account
    }),
  )
  router.post(
    '/api/v2/cloud/accounts/:id/check',
    json(
      async (req, res) =>
        await master.cloudAccounts
          .check(actorOf(res), String(req.params.id))
          .catch(missing),
    ),
  )
  router.delete(
    '/api/v2/cloud/accounts/:id',
    json(async (req, res) => {
      await master.cloudAccounts
        .remove(actorOf(res), String(req.params.id))
        .catch(missing)
      return null
    }),
  )
  router.get(
    '/api/v2/cloud/accounts/:id/catalog',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.read')
      const id = String(req.params.id)
      if (master.cloudAccounts.get(id) == null)
        throw new NotFound(`No cloud account named ${id}`)
      const catalog = await master.pools.catalog(id)
      if (catalog == null)
        throw new Error(
          `Account ${id}'s provider has no regions or sizes to choose`,
        )
      return catalog
    }),
  )

  const setting = (): CloudSetting =>
    (master.settings.value('cloud') ?? {
      monthlyBudget: 200,
      pools: [],
    }) as unknown as CloudSetting
  const save = async (
    res: express.Response,
    pools: unknown[],
  ): Promise<PoolSetting[]> =>
    (
      (await master.settings.set(actorOf(res), 'cloud', {
        monthlyBudget: setting().monthlyBudget ?? 200,
        pools,
      })) as unknown as CloudSetting
    ).pools
  const known = (name: string): PoolSetting => {
    const pool = setting().pools.find((entry) => entry.name === name)
    if (pool == null) throw new NotFound(`No pool named ${name}`)
    return pool
  }
  router.get(
    '/api/v2/cloud/pools',
    json((_req, res) => {
      allow(actorOf(res), 'settings.read')
      return master.pools.pools().map((pool) => ({
        ...pool,
        machines: master.pools.machines(pool.name).map((machine) => ({
          id: machine.id,
          state: machine.state,
          address: machine.address,
          created: machine.created_at,
        })),
      }))
    }),
  )
  router.post(
    '/api/v2/cloud/pools',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      const input = poolInput(req.body)
      if (setting().pools.some((pool) => pool.name === input.name))
        throw new Conflict(`A pool named ${String(input.name)} already exists`)
      const pools = await save(res, [...setting().pools, input])
      res.status(201)
      return pools.find((pool) => pool.name === input.name)
    }),
  )
  router.put(
    '/api/v2/cloud/pools/:name',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      const name = String(req.params.name)
      known(name)
      // A pool keeps its name, so its machines stay its own.
      const input = { ...poolInput(req.body), name }
      const pools = await save(
        res,
        setting().pools.map((pool) => (pool.name === name ? input : pool)),
      )
      return pools.find((pool) => pool.name === name)
    }),
  )
  router.delete(
    '/api/v2/cloud/pools/:name',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      const name = String(req.params.name)
      known(name)
      // Its machines retire on the next pass: their pool is gone.
      await save(
        res,
        setting().pools.filter((pool) => pool.name !== name),
      )
      return null
    }),
  )
  router.use('/api/v2/cloud', apiErrors)
  return router
}
