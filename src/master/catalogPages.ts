import express, { type Request, type Response } from 'express'
import { catalogPages, type CatalogCaller } from '../catalog/routes.js'
import { LinkCatalogSource, type CatalogLink } from '../catalog/source.js'
import { registerHref, type CatalogPage } from '../catalog/views.js'
import { LinkError } from '../link/link.js'
import { escape } from '../view/html.js'
import { checkCsrf, type MasterSession } from './auth.js'
import { noHost, relayDownload } from './buildsApi.js'
import { HostNotConnected } from './hosts.js'
import type { Master } from './runtime.js'

/** How the master draws a page in its shell. */
export type MasterSend = (
  res: Response,
  title: string,
  content: string,
  current?: MasterSession,
  code?: number,
  active?: string,
  scripts?: string[],
) => void

type MasterCaller = CatalogCaller & { session: MasterSession }

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

/**
 * Install apps and Devices on the master: the pages the host serves, with
 * their data from the host over the link, drawn in the master's shell for
 * a person signed in on the master. Install grants live on the host;
 * their manifests and packages are relayed from it. The master's public
 * origin (its `master` setting) is what manifests and registration
 * callbacks name; without one iOS installs and Register Device go to the
 * host's own pages.
 */
export function masterCatalogPages(
  app: express.Express,
  master: Master,
  session: (req: Request) => MasterSession | undefined,
  send: MasterSend,
): void {
  const link = catalogLink(master)
  const origins = (): { master?: string; host?: string } => {
    const host = (master.settings.value('host') ?? {}) as { origin?: string }
    const own = master.providerSignIn.origin()
    return {
      ...(own == null ? {} : { master: own }),
      ...(host.origin == null ? {} : { host: host.origin }),
    }
  }
  const unreachable = (error: unknown): boolean =>
    error instanceof HostNotConnected ||
    (error instanceof LinkError &&
      (error.code === 'closed' || error.code === 'timeout'))
  const pages = catalogPages({
    paths: ['/apps', '/apps/:appId', '/apps/:appId/branches/:branchKey'],
    caller(req): MasterCaller | undefined {
      const current = session(req)
      if (current == null) return undefined
      const { master: own, host } = origins()
      const viewer = {
        csrf: current.csrf,
        origin: own ?? '',
        ...(own == null && host != null ? { hostPages: host } : {}),
      }
      const active = req.path.startsWith('/devices') ? 'devices' : 'catalog'
      return {
        session: current,
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
        viewer,
        checkCsrf: (request): void => {
          checkCsrf(request, current)
        },
        mayRegister: true,
        registration: true,
        render(res, page: CatalogPage): void {
          if (page.refresh != null) res.set('Refresh', String(page.refresh))
          send(
            res,
            page.title,
            `<nav class="catalog-nav" aria-label="Install apps">${page.platforms ?? ''}<a class="button register-device" href="${escape(registerHref(viewer))}">Register Device</a></nav>${page.body}`,
            current,
            page.status ?? 200,
            active,
            page.interactive === true ? ['/assets/catalog.js'] : [],
          )
        },
      }
    },
    signIn: () => '/sign-in',
    refuse(res, status, message, caller) {
      send(
        res,
        'Mason',
        `<p class="empty-state">${escape(message)}</p>`,
        (caller as MasterCaller | undefined)?.session,
        status,
      )
    },
    files: () => new LinkCatalogSource(link, undefined, origins().master),
    qr: () => {
      const { master: own, host } = origins()
      return `${own ?? host ?? ''}/devices`
    },
    failed(_req, res, error, caller) {
      const current = (caller as MasterCaller | undefined)?.session
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (unreachable(error)) {
        send(
          res,
          'The host is unreachable',
          '<section class="card"><p>Install apps and Devices come from the Mason host, which the master cannot reach right now. Try again in a moment.</p></section>',
          current,
          503,
        )
        return
      }
      send(
        res,
        'Request could not be completed',
        '<p>The request is invalid or has expired. Go back and try again.</p>',
        current,
        400,
      )
    },
  })
  // The pages' forms post URL-encoded fields.
  app.use(
    ['/builds', '/devices'],
    express.urlencoded({ extended: false, limit: '16kb' }),
  )
  app.use(pages.devices)
  app.use(pages.installs)
  app.use(pages.catalog)
}
