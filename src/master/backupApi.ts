import express, { Router } from 'express'
import { actorOf, apiErrors, authenticate, json } from './api.js'
import { allow, can } from './permissions.js'
import type { Actor } from './roles.js'
import type { Master } from './runtime.js'

/**
 * The `backup` settings area with what only administrators see — the
 * backup key — and the backup runs: `POST /api/v2/backups` takes one now.
 */
export function backupApi(master: Master): Router {
  const router = Router()
  router.use(
    ['/api/v2/settings/backup', '/api/v2/backups'],
    express.json({ limit: '64kb' }),
    authenticate(master),
  )
  /** The account behind an actor: a session's, or the creator of a key. */
  const account = (actor: Actor): number | undefined => {
    if (actor.accountId != null) return actor.accountId
    if (actor.keyId == null) return undefined
    const row = master.database.db
      .prepare('SELECT creator FROM api_keys WHERE id=?')
      .get(actor.keyId) as { creator: number | null } | undefined
    return row?.creator ?? undefined
  }
  const view = (actor: Actor): Record<string, unknown> => {
    const value = master.settings.get(actor, 'backup')
    const configured = master.backups.status().configured
    if (!configured || !can(actor, 'backups.key'))
      return { ...value, ...master.backups.status() }
    const id = account(actor)
    return {
      ...value,
      ...master.backups.status(),
      backupKey: master.backups.keyText(),
      ...(id == null
        ? {}
        : { keyConfirmed: !master.backups.needsConfirmation(id) }),
    }
  }
  router.get(
    '/api/v2/settings/backup',
    json((_req, res) => view(actorOf(res))),
  )
  router.put(
    '/api/v2/settings/backup',
    json(async (req, res) => {
      const actor = actorOf(res)
      await master.settings.set(actor, 'backup', req.body)
      return view(actor)
    }),
  )
  router.post(
    '/api/v2/settings/backup/confirm',
    json((_req, res) => {
      const actor = actorOf(res)
      allow(actor, 'backups.key')
      const id = account(actor)
      if (id == null)
        throw new Error('Confirm as an administrator or with their key')
      if (!master.backups.status().configured)
        throw new Error('Backups are not configured')
      master.backups.confirm(id)
      master.database.audit(actor, 'backup.confirm', String(id))
      return { keyConfirmed: true }
    }),
  )
  router.get(
    '/api/v2/backups',
    json((_req, res) => {
      allow(actorOf(res), 'backups.run')
      return master.backups.status()
    }),
  )
  router.post(
    '/api/v2/backups',
    json(async (_req, res) => {
      allow(actorOf(res), 'backups.run')
      return await master.backups.backup()
    }),
  )
  router.use(['/api/v2/settings/backup', '/api/v2/backups'], apiErrors)
  return router
}
