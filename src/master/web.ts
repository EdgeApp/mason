import type express from 'express'
import { nodeWebApp, type WebAppContext } from '../node/webApp.js'
import { accountsApi } from './accountsApi.js'
import { masterApi } from './api.js'
import { backupApi } from './backupApi.js'
import { buildsApi } from './buildsApi.js'
import { cloudApi } from './cloudApi.js'
import { cloudHostsApi } from './cloudHostsApi.js'
import { storageApi } from './storageApi.js'
import { appleApi } from '../apple/api.js'
import { masterPages } from './pages.js'
import { invitationRoutes } from './invitations.js'
import { projectsApi } from './projectsApi.js'
import { providerSignInRoutes } from './providerSignIn.js'
import { wizardApi } from './wizard.js'
import { runsApi } from './runsApi.js'
import type { Master } from './runtime.js'
import { nodeInfoRoutes, releaseInfo } from '../node/nodeInfo.js'
import type { NodeInfo } from '../shared/api/index.js'
import { version } from '../version.js'
import { secretsApi } from './secretsApi.js'
import { adminApi } from './adminApi.js'
import { masterReader, nodeViews } from './reads.js'
import { readApi } from '../node/readApi.js'
import { masterCatalogApi, masterCatalogShell } from './catalogPages.js'
import { cookie } from '../auth/routes.js'
import { MASTER_SESSION_COOKIE } from './auth.js'

export interface MasterWebContext extends WebAppContext {
  configured: () => boolean
  master: Master
  /** The code the master printed, until the first account exists. */
  setupCode?: () => string | undefined
  onConfigured?: () => void
  restore?: Parameters<typeof accountsApi>[1]['restore']
}

/** The master's `GET /api/v2/node`. */
export function masterNodeInfo(context: MasterWebContext): NodeInfo {
  const settings = context.master.settings
  const origin = (area: string): string | undefined => {
    const value = (settings.value(area) as { origin?: unknown } | undefined)
      ?.origin
    return typeof value === 'string' ? value : undefined
  }
  const masterOrigin = origin('master')
  const hostOrigin = origin('host')
  return {
    role: 'master',
    version,
    ...(masterOrigin == null ? {} : { masterOrigin }),
    ...(hostOrigin == null ? {} : { hostOrigin }),
    setupNeeded: !context.configured(),
    signIn: {
      password: true,
      providers: context.master.providerSignIn
        .offered()
        .map(({ id, name }) => ({ id, name })),
    },
    state: 'ok',
    testEndpoints: context.testEndpoints,
    ...releaseInfo(),
  }
}

/** The master's web listener: its UI and API. */
export function masterApp(context: MasterWebContext): express.Express {
  const app = nodeWebApp(context)
  const master = context.master
  app.use(nodeInfoRoutes(() => masterNodeInfo(context)))
  // The pages' reads, which the host answers the same from its cache.
  app.use(readApi(masterReader(master, context)))
  app.use(adminApi(master))
  // Install apps and Devices, from the host over the link.
  app.use(
    masterCatalogApi(master, (req) =>
      master.auth.session(cookie(req, MASTER_SESSION_COOKIE)),
    ),
  )
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
  // Relayed to the host, which answers from its cache and storage.
  app.use(buildsApi(master))
  app.use(
    masterApi({
      keys: master.keys,
      credentials: master,
      settings: master.settings,
      registry: master.registry,
      nodeDetails: (fingerprint) => master.nodeDetails(fingerprint),
      nodes: () => nodeViews(master),
      apple: {
        status: () => master.apple.status(),
        signIn: async (actor, appleId, password) =>
          await master.appleSignIn(actor, appleId, password),
        code: async (actor, code) => await master.appleCode(actor, code),
      },
    }),
  )
  // After the provider routes, whose limiter covers every /auth request.
  app.use(providerSignInRoutes(master))
  app.use(invitationRoutes(master))
  // Install apps' and Devices' own addresses: the QR code, the completion
  // link and the grants' files; their pages are the web app's.
  app.use(
    masterCatalogShell(master, (req) =>
      master.auth.session(cookie(req, MASTER_SESSION_COOKIE)),
    ),
  )
  masterPages(app, master)
  return app
}
