import type express from 'express'
import type { Request } from 'express'
import { catalogApi, type CatalogApiCaller } from '../catalog/api.js'
import { catalogShellRoutes } from '../catalog/shell.js'
import { LinkCatalogSource, type CatalogLink } from '../catalog/source.js'
import { LinkError } from '../link/link.js'
import { sendShell } from '../node/webRoutes.js'
import { HOST_UNREACHABLE_ERROR, NO_HOST_ERROR } from '../shared/api/index.js'
import { checkCsrf, type MasterSession } from './auth.js'
import { noHost, relayDownload } from './buildsApi.js'
import { HostNotConnected } from './hosts.js'
import type { Master } from './runtime.js'

/** The host, reached over the master's link; an error when there is none or it is away. */
export function catalogLink(master: Master): CatalogLink {
  const reachable = (): void => {
    const missing = noHost(master)
    if (missing != null) throw new HostNotConnected(missing)
  }
  return {
    ask: async (method, params): Promise<unknown> => {
      reachable()
      const answer = await master.hosts.askHost(method, params)
      if (answer === undefined)
        throw new HostNotConnected('This cluster has no host')
      return answer
    },
    relay: async (method, params, res): Promise<void> => {
      reachable()
      await relayDownload(master.hosts.openHostStream(method, params), res)
    },
  }
}

/** The master's public origin, and the host's. */
function catalogOrigins(master: Master): { master?: string; host?: string } {
  const host = (master.settings.value('host') ?? {}) as { origin?: string }
  const own = master.providerSignIn.origin()
  return {
    ...(own == null ? {} : { master: own }),
    ...(host.origin == null ? {} : { host: host.origin }),
  }
}

/** Whether an error says the host is away, rather than refusing the request. */
function unreachable(error: unknown): boolean {
  return (
    error instanceof HostNotConnected ||
    (error instanceof LinkError &&
      (error.code === 'closed' || error.code === 'timeout'))
  )
}

/** The person signed in on the master, as the host's catalog answers for them. */
function masterCaller(
  master: Master,
  link: CatalogLink,
  session: (req: Request) => MasterSession | undefined,
  req: Request,
): CatalogApiCaller | undefined {
  const current = master.forwarder.forwarded(req) ? undefined : session(req)
  if (current == null) return undefined
  const { master: own, host } = catalogOrigins(master)
  const origin = own ?? host
  return {
    accountId: current.accountId,
    source: new LinkCatalogSource(
      link,
      {
        id: current.id,
        expiresAt: current.expiresAt,
        permissionVersion: current.permissionVersion,
      },
      own,
    ),
    checkCsrf: (request): void => {
      checkCsrf(request, current)
    },
    mayRegister: true,
    registration: true,
    ...(origin == null ? {} : { installOrigin: origin }),
    ...(own == null && host != null ? { hostPages: host } : {}),
  }
}

/**
 * Install apps and Devices as JSON on the master, for a person signed in
 * here: the host answers over the link, as it does for the pages. Without a
 * host, or with it away, they answer 503.
 */
export function masterCatalogApi(
  master: Master,
  session: (req: Request) => MasterSession | undefined,
): express.Router {
  const link = catalogLink(master)
  return catalogApi({
    caller: (req) => masterCaller(master, link, session, req),
    failure(error) {
      if (noHost(master) != null) return { status: 503, error: NO_HOST_ERROR }
      if (unreachable(error))
        return { status: 503, error: HOST_UNREACHABLE_ERROR }
      return undefined
    },
  })
}

/**
 * Install apps and Devices on the master: their addresses answer the web
 * app's shell, which reads them as JSON relayed from the host over the
 * link. Install grants live on the host; their manifests and packages are
 * relayed from it. The master's public origin (its `master` setting) is
 * what manifests and registration callbacks name; without one iOS installs
 * and registration go to the host's own pages.
 */
export function masterCatalogShell(
  master: Master,
  session: (req: Request) => MasterSession | undefined,
): express.Router {
  const link = catalogLink(master)
  return catalogShellRoutes({
    paths: ['/', '/apps', '/apps/:appId', '/apps/:appId/branches/:branchKey'],
    caller: (req) => masterCaller(master, link, session, req),
    signIn: () => '/sign-in',
    shell: (res, status) => {
      sendShell(res, { status })
    },
    files: () =>
      new LinkCatalogSource(link, undefined, catalogOrigins(master).master),
    qr: () => {
      const { master: own, host } = catalogOrigins(master)
      return `${own ?? host ?? ''}/devices`
    },
    failure: (error, page) => {
      // A cluster without a host yet: its pages say so; a file cannot come.
      if (noHost(master) != null) return page ? 200 : 503
      return unreachable(error) ? 503 : undefined
    },
  })
}
