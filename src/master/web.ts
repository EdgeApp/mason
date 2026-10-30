import { readFileSync } from 'node:fs'
import type express from 'express'
import {
  masterContentSecurityPolicy,
  nodeWebApp,
  type WebAppContext,
} from '../node/webApp.js'
import { accountsApi } from './accountsApi.js'
import { masterApi } from './api.js'
import { backupApi } from './backupApi.js'
import { cloudApi } from './cloudApi.js'
import { cloudHostsApi } from './cloudHostsApi.js'
import { storageApi } from './storageApi.js'
import { appleApi } from '../apple/api.js'
import { masterPages } from './pages.js'
import { projectsApi } from './projectsApi.js'
import { wizardApi } from './wizard.js'
import { runsApi } from './runsApi.js'
import type { Master } from './runtime.js'
import { secretsApi } from './secretsApi.js'

export interface MasterWebContext extends WebAppContext {
  configured: () => boolean
  master: Master
  /** The code the master printed, until the first account exists. */
  setupCode?: () => string | undefined
  onConfigured?: () => void
  restore?: Parameters<typeof accountsApi>[1]['restore']
}

const bundle = (name: string): string =>
  readFileSync(
    new URL(`../browser/bundles/${name}.js`, import.meta.url),
    'utf8',
  )

/** The master's web listener: its UI and API. */
export function masterApp(context: MasterWebContext): express.Express {
  const app = nodeWebApp(context)
  const master = context.master
  for (const name of ['master', 'password-worker', 'run', 'secrets'])
    app.get(`/assets/${name}.js`, (_req, res) => {
      if (name === 'password-worker')
        res.set('Content-Security-Policy', masterContentSecurityPolicy)
      res.type('js').send(bundle(name))
    })
  app.use(
    accountsApi(master, {
      setupCode: context.setupCode ?? ((): undefined => undefined),
      ...(context.onConfigured == null
        ? {}
        : { onConfigured: context.onConfigured }),
      ...(context.restore == null ? {} : { restore: context.restore }),
    }),
  )
  app.use(backupApi(master))
  app.use(cloudHostsApi(master))
  app.use(storageApi(master, master.spacesOptions))
  app.use(cloudApi(master))
  app.use(appleApi(master))
  // Before the wizard's and the projects' routes: its larger body limit parses first.
  app.use(secretsApi(master))
  app.use(wizardApi(master))
  app.use(projectsApi(master))
  app.use(runsApi(master))
  app.use(
    masterApi({
      keys: master.keys,
      credentials: master,
      settings: master.settings,
      registry: master.registry,
      nodeDetails: (fingerprint) => master.nodeDetails(fingerprint),
      apple: {
        status: () => master.apple.status(),
        signIn: async (actor, appleId, password) =>
          await master.appleSignIn(actor, appleId, password),
        code: async (actor, code) => await master.appleCode(actor, code),
      },
    }),
  )
  masterPages(app, context, master)
  app.use((_req, res) => {
    res.status(404).send('Not found')
  })
  return app
}
