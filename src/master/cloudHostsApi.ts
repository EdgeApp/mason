import express, { Router } from 'express'
import { actorOf, apiErrors, authenticate, json, NotFound } from './api.js'
import { MissingHost, type CloudHostRow } from './cloud/hosts.js'
import { allow } from './permissions.js'
import type { Master } from './runtime.js'

/** A cloud host as the API shows it: no pairing secret. */
export function hostView(row: CloudHostRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...row,
    labels: JSON.parse(row.labels) as string[],
    pairing: row.pairing_secret != null,
    // A host with a DNS name waits for Caddy's Let's Encrypt certificate.
    certificate:
      row.dns_domain == null
        ? 'internal'
        : row.certificate_at == null
          ? 'waiting'
          : 'trusted',
  }
  delete out.pairing_hash
  delete out.pairing_secret
  delete out.space_secret
  return out
}

/**
 * `/api/v2/cloud/hosts`: Mason hosts the master makes on a cloud provider.
 * `POST` records one and starts making it; `…/:name/reconcile` checks it
 * again; `DELETE …/:name` with `{ confirm: <name> }` destroys it.
 */
export function cloudHostsApi(master: Master): Router {
  const router = Router()
  router.use(
    '/api/v2/cloud/hosts',
    express.json({ limit: '64kb' }),
    authenticate(master),
  )
  const missing = (error: unknown): never => {
    throw error instanceof MissingHost ? new NotFound(error.message) : error
  }
  router.get(
    '/api/v2/cloud/hosts',
    json((_req, res) => {
      allow(actorOf(res), 'settings.read')
      return master.cloudHosts.list().map(hostView)
    }),
  )
  router.post(
    '/api/v2/cloud/hosts',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      const row = await master.cloudHosts.create(req.body)
      res.status(201)
      return hostView(row)
    }),
  )
  router.post(
    '/api/v2/cloud/hosts/:name/reconcile',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      return hostView(
        await master.cloudHosts
          .reconcile(String(req.params.name))
          .catch(missing),
      )
    }),
  )
  router.post(
    '/api/v2/cloud/hosts/:name/space',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      return hostView(
        await master.cloudHosts
          .setSpace(String(req.params.name), req.body)
          .catch(missing),
      )
    }),
  )
  router.delete(
    '/api/v2/cloud/hosts/:name',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      await master.cloudHosts
        .remove(
          String(req.params.name),
          (req.body as { confirm?: unknown } | undefined)?.confirm,
          {
            // The form sends its select's value; the API takes true.
            deleteSpace: ['delete', true].includes(
              (req.body as { deleteSpace?: unknown } | undefined)
                ?.deleteSpace as string,
            ),
          },
        )
        .catch(missing)
      return null
    }),
  )
  router.use('/api/v2/cloud/hosts', apiErrors)
  // Permanent cloud nodes: workers the master keeps on a cloud provider.
  router.use(
    '/api/v2/cloud/nodes',
    express.json({ limit: '64kb' }),
    authenticate(master),
  )
  router.get(
    '/api/v2/cloud/nodes',
    json((_req, res) => {
      allow(actorOf(res), 'settings.read')
      return master.cloudHosts.list('worker').map(hostView)
    }),
  )
  router.post(
    '/api/v2/cloud/nodes',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      const row = await master.cloudHosts.createNode(req.body)
      res.status(201)
      return hostView(row)
    }),
  )
  router.post(
    '/api/v2/cloud/nodes/:name/reconcile',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      return hostView(
        await master.cloudHosts
          .reconcile(String(req.params.name), 'worker')
          .catch(missing),
      )
    }),
  )
  router.delete(
    '/api/v2/cloud/nodes/:name',
    json(async (req, res) => {
      allow(actorOf(res), 'settings.change')
      await master.cloudHosts
        .remove(
          String(req.params.name),
          (req.body as { confirm?: unknown } | undefined)?.confirm,
          { role: 'worker' },
        )
        .catch(missing)
      return null
    }),
  )
  router.use('/api/v2/cloud/nodes', apiErrors)
  return router
}
