import express, { Router } from 'express'
import { actorOf, apiErrors, authenticate, json, NotFound } from './api.js'
import { MissingAccount } from './cloud/accounts.js'
import type { Master } from './runtime.js'

/**
 * `/api/v2/cloud/accounts`: the cloud accounts, their keys write-only.
 * `POST …/:id/check` asks the provider again.
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
  router.use('/api/v2/cloud', apiErrors)
  return router
}
