import express, { Router } from 'express'
import {
  actorOf,
  apiErrors,
  authenticate,
  json,
  NotFound,
} from '../master/api.js'
import { allow } from '../master/permissions.js'
import type { Master } from '../master/runtime.js'
import { certificateKinds, type CertificateKind } from './certificates.js'

const asTeam = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Z0-9]{10}$/.test(value))
    throw new Error('team is an Apple team ID')
  return value
}

/**
 * `/api/v2/apple/certificates` and `/api/v2/apple/profiles`: signing
 * certificates imported from a `.p12` or a Fastlane Match repository, or
 * created through App Store Connect; their private keys are never returned.
 */
export function appleApi(master: Master): Router {
  const router = Router()
  router.use(
    ['/api/v2/apple/certificates', '/api/v2/apple/profiles'],
    express.json({ limit: '2mb' }),
    authenticate(master),
  )
  const service = master.appleSigning
  router.get(
    '/api/v2/apple/certificates',
    json((_req, res) => {
      allow(actorOf(res), 'apple.change')
      return service.certificates.list()
    }),
  )
  router.post(
    '/api/v2/apple/certificates',
    json(async (req, res) => {
      const actor = actorOf(res)
      allow(actor, 'apple.change')
      const body = (req.body ?? {}) as {
        team?: unknown
        p12?: unknown
        password?: unknown
        match?: { repository?: unknown; passphrase?: unknown; branch?: unknown }
        create?: unknown
      }
      const team = asTeam(body.team)
      let out: unknown
      if (typeof body.p12 === 'string') {
        if (typeof body.password !== 'string')
          throw new Error('A .p12 import needs its password')
        out = await service.certificates.importP12(
          team,
          Buffer.from(body.p12, 'base64'),
          body.password,
        )
      } else if (body.match != null) {
        const { repository, passphrase, branch } = body.match
        if (typeof repository !== 'string' || typeof passphrase !== 'string')
          throw new Error(
            'A Match import needs the repository and its passphrase',
          )
        out = await service.certificates.importMatch(
          team,
          repository,
          passphrase,
          typeof branch === 'string' ? branch : 'master',
        )
      } else if (
        typeof body.create === 'string' &&
        (certificateKinds as readonly string[]).includes(body.create)
      )
        out = await service.certificates.create(
          team,
          body.create as CertificateKind,
        )
      else
        throw new Error(
          'Give a .p12 and its password, a Match repository and passphrase, or create: one of development, distribution, developerIdApplication, developerIdInstaller',
        )
      master.database.audit(actor, 'apple.certificate', team)
      // App IDs of the team still missing profiles get them now.
      master.setupApple(
        (app) => app.apple?.team === team && service.incomplete(app),
      )
      res.status(201)
      return out
    }),
  )
  router.delete(
    '/api/v2/apple/certificates/:id',
    json((req, res) => {
      const actor = actorOf(res)
      allow(actor, 'apple.change')
      const id = Number(req.params.id)
      if (!service.certificates.list().some((item) => item.id === id))
        throw new NotFound('No such certificate')
      service.certificates.remove(id)
      master.database.audit(actor, 'apple.certificate.remove', String(id))
      return null
    }),
  )
  router.get(
    '/api/v2/apple/profiles',
    json((_req, res) => {
      allow(actorOf(res), 'apple.change')
      return service.profiles.list()
    }),
  )
  router.use(
    ['/api/v2/apple/certificates', '/api/v2/apple/profiles'],
    apiErrors,
  )
  return router
}
