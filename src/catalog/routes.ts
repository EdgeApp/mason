import { Devices } from '../devices/store.js'
import { Router, type Request } from 'express'
import { Accounts } from '../auth/accounts.js'
import { navigation, sessionContext } from '../auth/routes.js'
import { Store } from '../store.js'
import { asId, type Build, type Platform } from '../validation.js'
import { escape, page } from '../view.js'
import { branchKey, branchName, labels, platform } from './platform.js'

function selected(req: Request): Platform {
  const preferences = (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('mason-platform='))
  return platform(
    req.query.platform,
    preferences.length === 1 ? preferences[0]!.slice(15) : undefined,
    req.get('user-agent') ?? '',
  )
}
function pill(path: string, chosen: Platform): string {
  return `<div class="platforms" role="group" aria-label="Build platform">${Object.entries(
    labels,
  )
    .map(
      ([value, label]) =>
        `<a data-platform="${value}" href="${escape(path)}?platform=${value}" aria-current="${chosen === value ? 'true' : 'false'}">${label}</a>`,
    )
    .join('')}</div>`
}
export function branches(
  builds: Build[],
): Array<{ name: string; time: number }> {
  const map = new Map<string, number>()
  for (const build of builds)
    map.set(
      build.branch,
      Math.max(map.get(build.branch) ?? 0, build.published_at),
    )
  return [...map]
    .map(([name, time]) => ({ name, time }))
    .sort((a, b) =>
      a.name === b.name
        ? 0
        : a.name === 'master'
          ? -1
          : b.name === 'master'
            ? 1
            : b.time - a.time || (a.name < b.name ? -1 : 1),
    )
}
function time(at: number): string {
  const iso = new Date(at).toISOString()
  return `<time datetime="${iso}" title="${iso}">${iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</time>`
}
export function catalogRoutes(
  store: Store,
  accounts = new Accounts(store),
): Router {
  const router = Router()
  router.get(
    ['/', '/apps/:appId', '/apps/:appId/branches/:branchKey'],
    (req, res) => {
      const context = sessionContext(req, accounts)
      if (context == null) {
        res.redirect(
          303,
          '/auth/login?return=' + encodeURIComponent(req.originalUrl),
        )
        return
      }
      const { account, session } = context
      if (!account.is_admin && !account.is_tester) {
        res
          .status(403)
          .send(
            page(
              'Waiting for tester access',
              '<section class="card"><p>Your account is signed in. A Mason administrator needs to grant you tester access before you can view or download builds.</p></section>',
              navigation(session, account),
            ),
          )
        return
      }
      const chosen = selected(req),
        apps = store.apps()
      const nav = pill(req.path, chosen) + navigation(session, account)
      const query = `?platform=${chosen}`
      if (req.params.appId == null) {
        const cards = apps
          .map(
            (app, index) =>
              `<a class="app-card" href="/apps/${app.id}${query}"><span class="app-index">${String(index + 1).padStart(2, '0')}</span><div><h2>${escape(app.name)}</h2><small>${escape(app.slug)}</small></div><span aria-hidden="true">→</span></a>`,
          )
          .join('')
        res.send(
          page(
            'Apps',
            `<p class="intro">Choose an app to browse recent builds.</p><div class="app-list">${cards || '<p>No apps have been configured yet.</p>'}</div>`,
            nav,
            true,
          ),
        )
        return
      }
      const app = apps.find(
        (item) => item.id === asId(Number(req.params.appId)),
      )
      if (app == null) {
        res
          .status(404)
          .send(page('App unavailable', '<p>This app is unavailable.</p>', nav))
        return
      }
      const home = `<a href="/${query}">Apps</a>`,
        appPath = `/apps/${app.id}`
      if (req.params.branchKey == null) {
        const rows = branches(store.builds(app.id))
          .map(
            (branch) =>
              `<a class="list-row" href="${appPath}/branches/${branchKey(branch.name)}${query}"><div><strong>${escape(branch.name)}</strong><small>Last built ${time(branch.time)}</small></div><span aria-hidden="true">→</span></a>`,
          )
          .join('')
        res.send(
          page(
            app.name,
            `<p class="breadcrumbs">${home}</p><p class="intro">Branches · ${labels[chosen]}</p><div class="build-list">${rows || '<section class="card"><p>No retained builds yet.</p></section>'}</div>`,
            nav,
            true,
          ),
        )
        return
      }
      const branch = branchName(req.params.branchKey)
      const builds = store
        .builds(app.id, branch)
        .filter((build) => build.platform === chosen)
      const deviceStore = new Devices(store),
        selectedDevice = deviceStore.selected(account.id, req.headers.cookie)
      const rows = builds
        .map(
          (build) =>
            `<form id="build-${build.id}" method="post" action="/builds/${build.id}/install"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><button class="list-row build-row" aria-label="${deviceStore.eligible(build, selectedDevice) ? 'Install' : selectedDevice == null ? 'Register Device for' : 'Prepare for this device'} ${escape(build.version)} build ${escape(build.build_number)}"><div><strong>${escape(build.version)} <span class="build-number">(${escape(build.build_number)})</span></strong><small>${time(build.published_at)} · ${(build.size / 1024 ** 2).toFixed(1)} MB</small><code title="${escape(build.commit_hash)}">${escape(build.commit_hash.slice(0, 12))}</code></div><span class="download-label">${deviceStore.eligible(build, selectedDevice) ? 'Install' : selectedDevice == null ? 'Register Device' : 'Prepare for device'} <span aria-hidden="true">↓</span></span></button></form>`,
        )
        .join('')
      res.send(
        page(
          branch,
          `<p class="breadcrumbs">${home}<span>/</span><a href="${appPath}${query}">${escape(app.name)}</a></p><p class="intro">${labels[chosen]} builds · newest first</p><div class="build-list">${rows || `<section class="card"><h2>No ${labels[chosen]} builds</h2><p>This branch has no retained builds for the selected platform. Choose another platform or publish a new build.</p></section>`}</div>`,
          nav,
          true,
        ),
      )
    },
  )
  return router
}
