import type { Platform } from '../validation.js'
import { breadcrumbs, escape, type Crumb } from '../view/html.js'
import type { ViewerNode } from '../view/shell.js'
import { iosInstallUrl } from './install.js'
import { branchKey, labels } from './platform.js'
import type {
  AppData,
  AppsData,
  BranchData,
  CatalogApp,
  CatalogBuild,
  CompleteData,
  DevicesData,
} from '../shared/api/catalog.js'

export type {
  AppData,
  AppsData,
  BranchData,
  CatalogApp,
  CatalogBuild,
  CompleteData,
  DevicesData,
}

/** Who the catalog pages are for, and where installs happen. */
export interface CatalogViewer {
  /** The node the pages are on, which their breadcrumbs start from. */
  node: ViewerNode
  /** The session's form proof. */
  csrf: string
  /** The origin grants' manifests are served on. */
  origin: string
  /**
   * The host's own origin, when iOS installs and device registration go
   * through it (a master without a public address).
   */
  hostPages?: string
}

/** A catalog page: its title, its content, and how the node wraps it. */
export interface CatalogPage {
  title: string
  body: string
  status?: number
  /** The platform switch, shown in the top bar. */
  platforms?: string
  /** Whether the page loads the catalog script. */
  interactive?: boolean
  /** Seconds after which the page reloads itself. */
  refresh?: number
  /** Where the page is, below the node: Install apps › app › branch, or Devices. */
  crumbs?: Crumb[]
}

/**
 * A catalog page's content in a node's shell: its breadcrumbs and title,
 * its platform switch, which the platform links swap without a reload,
 * then the page.
 */
export function catalogBody(
  page: CatalogPage,
  viewer: { node: ViewerNode },
): string {
  return `<div class="page-head"><div>${page.crumbs == null ? '' : breadcrumbs(viewer, page.crumbs)}<h1>${escape(page.title)}</h1></div></div>${page.platforms == null ? '' : `<nav class="catalog-nav" data-catalog-platforms aria-label="Build platform">${page.platforms}</nav>`}${page.body}`
}

/** Install apps, with the platform the viewer chose. */
const installApps = (query: string): Crumb => ({
  label: 'Install apps',
  href: `/apps${query}`,
})

/** Install apps › the app. */
const appCrumbs = (app: CatalogApp, query: string): Crumb[] => [
  installApps(query),
  { label: app.name, href: `/apps/${app.id}${query}` },
]

/** The side-menu entry a catalog path belongs to: Devices, else Install apps. */
export function catalogActive(path: string): string {
  return path.startsWith('/devices') ? 'devices' : 'catalog'
}

/** The platform switch: only the platforms the apps shown have a channel for. */
export function platformPill(
  path: string,
  chosen: Platform,
  platforms: Platform[],
): string {
  return `<div class="platforms" role="group" aria-label="Build platform">${Object.entries(
    labels,
  )
    .filter(([value]) => platforms.includes(value as Platform))
    .map(
      ([value, label]) =>
        `<a data-platform="${value}" href="${escape(path)}?platform=${value}" aria-current="${chosen === value ? 'true' : 'false'}">${label}</a>`,
    )
    .join('')}</div>`
}

function time(at: number): string {
  const iso = new Date(at).toISOString()
  return `<time datetime="${iso}" title="${iso}">${iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</time>`
}

const hidden = (viewer: CatalogViewer): string =>
  `<input type="hidden" name="csrf" value="${escape(viewer.csrf)}">`

const HOST_INSTALLS =
  'Installs on iPhone and iPad go through the host until the master has a public address.'
/** A master with neither its own public address nor a host's to send iOS installs to. */
const NO_IOS_ADDRESS =
  'Installs on iPhone and iPad need a public address for this master, or a host with one.'

/** Signed in, but not yet a tester. */
export function waitingView(): CatalogPage {
  return {
    title: 'Waiting for tester access',
    body: '<section class="card"><p>Your account is signed in. A Mason administrator needs to grant you tester access before you can view or download builds.</p></section>',
    status: 403,
  }
}

/** An app the viewer may not see, or that does not exist. */
export function appUnavailableView(
  chosen: Platform,
  path: string,
): CatalogPage {
  return {
    title: 'App unavailable',
    body: '<p>This app is unavailable.</p>',
    status: 404,
    platforms: platformPill(path, chosen, []),
  }
}

/** Install apps: the viewer's apps. */
export function catalogView(
  data: AppsData,
  chosen: Platform,
  path: string,
): CatalogPage {
  const query = `?platform=${chosen}`
  const cards = data.apps
    .map(
      (app, index) =>
        `<a class="app-card" href="/apps/${app.id}${query}"><span class="app-index">${String(index + 1).padStart(2, '0')}</span><div><h2>${escape(app.name)}</h2><small>${escape(app.slug)}</small></div><span aria-hidden="true">→</span></a>`,
    )
    .join('')
  return {
    title: 'Apps',
    crumbs: [installApps(query)],
    body: `<p class="intro">Choose an app to browse recent builds.</p><div class="app-list">${cards || '<p>No apps have been configured yet.</p>'}</div>`,
    platforms: platformPill(path, chosen, data.platforms),
    interactive: true,
  }
}

/** An app's branches, or the platforms with builds when the chosen one has none. */
export function appView(
  data: AppData,
  chosen: Platform,
  path: string,
): CatalogPage {
  const query = `?platform=${chosen}`
  const appPath = `/apps/${data.app.id}`
  const rows = data.branches
    .map(
      (branch) =>
        `<a class="list-row" href="${appPath}/branches/${branchKey(branch.name)}${query}"><div><strong>${escape(branch.name)}</strong><small>Last built ${time(branch.time)}</small></div><span aria-hidden="true">→</span></a>`,
    )
    .join('')
  const others = (Object.keys(labels) as Platform[])
    .filter((value) => (data.latest[value] ?? 0) > 0)
    .map(
      (value) =>
        `<a class="list-row" data-platform="${value}" href="${appPath}?platform=${value}"><div><strong>${labels[value]}</strong><small>Last built ${time(data.latest[value]!)}</small></div><span aria-hidden="true">→</span></a>`,
    )
    .join('')
  return {
    title: data.app.name,
    crumbs: appCrumbs(data.app, query),
    body: `<p class="intro">Branches · ${labels[chosen]}</p><div class="build-list">${
      rows === ''
        ? '<section class="card"><p>No retained builds yet.</p></section>'
        : data.latest[chosen] != null
          ? rows
          : `<section class="card"><p>There are currently no builds for ${labels[chosen]}. Select one of these other platforms:</p></section>${others}`
    }</div>`,
    platforms: platformPill(path, chosen, data.platforms),
    interactive: true,
  }
}

const megabytes = (bytes: number): string =>
  `${(bytes / 1024 ** 2).toFixed(1)} MB`

/** A build's version, number and commit, and when it was published. */
function heading(build: CatalogBuild, size?: string): string {
  return `<strong>${escape(build.version)} <span class="build-number">(${escape(build.buildNumber)})</span></strong><small>${time(build.publishedAt)}${size == null ? '' : ` · ${size}`}</small><code title="${escape(build.commit)}">${escape(build.commit.slice(0, 12))}</code>`
}

/** A branch's builds for one platform, each with its install control. */
export function branchView(
  data: BranchData,
  viewer: CatalogViewer,
  chosen: Platform,
  path: string,
): CatalogPage {
  const query = `?platform=${chosen}`
  const appPath = `/apps/${data.app.id}`
  // One install control: a direct link for an IPA the device may install, else a form.
  // A build that is only downloaded (an iPhone Simulator app) is a download, for any device.
  const install = (build: CatalogBuild, variant?: string): string => {
    const download = build.download
    const eligible = build.eligible
    // Without a public master address, iOS installs are the host's.
    const onHost =
      viewer.hostPages != null && build.platform === 'ios' && download == null
    // iOS fetches the manifest by an absolute https address: without one there
    // is nothing to link.
    if (
      build.platform === 'ios' &&
      download == null &&
      viewer.hostPages == null &&
      viewer.origin === ''
    )
      return `<div id="build-${build.id}" class="list-row build-row" aria-disabled="true"><div>${heading(build, megabytes(build.size))}<small>${NO_IOS_ADDRESS}</small></div></div>`
    const verb = onHost
      ? 'Install on the host'
      : download != null
        ? 'Download'
        : eligible
          ? 'Install'
          : !data.device
            ? 'Register Device for'
            : 'Prepare for this device'
    const label = `${verb} ${build.version} build ${build.buildNumber}${variant == null ? '' : ` (${variant})`}${download == null ? '' : ` for the ${download}`}`
    const action = `<span class="download-label">${onHost ? 'Install on the host' : download != null ? 'Download' : eligible ? 'Install' : !data.device ? 'Register Device' : 'Prepare for device'} <span aria-hidden="true">↓</span></span>`
    const size =
      download == null
        ? megabytes(build.size)
        : `${download} · ${megabytes(build.size)}`
    const content =
      variant == null
        ? `<div>${heading(build, size)}</div>${action}`
        : `<div><strong>${escape(variant)} <span class="build-number">(${escape(build.buildNumber)})</span></strong><small>${size}</small></div>${action}`
    if (onHost)
      return `<a id="build-${build.id}" class="list-row build-row" aria-label="${escape(label)}" href="${escape(`${viewer.hostPages!}${appPath}/branches/${branchKey(data.branch)}?platform=ios`)}">${content}</a>`
    // The tap itself must open the native installer. A page-load
    // redirect loses Safari's user gesture and adds an app-open prompt.
    if (build.token != null)
      return `<a id="build-${build.id}" class="list-row build-row" data-install aria-label="${escape(label)}" href="${escape(iosInstallUrl(viewer.origin, build.token))}">${content}</a>`
    return `<form id="build-${build.id}" method="post" action="/builds/${build.id}/install">${hidden(viewer)}<button class="list-row build-row" aria-label="${escape(label)}">${content}</button></form>`
  }
  // A run's variants are one build: grouped, newest run first. The default
  // leads, else the first variant by name in byte order (plain `<`, not
  // `localeCompare`), as the dashboard's `leadsItsBuild` and the run
  // pages order them, so every view names the same lead build.
  const groups = new Map<string, CatalogBuild[]>()
  for (const build of data.builds) {
    const key = build.run == null ? `build:${build.id}` : `run:${build.run}`
    const group = groups.get(key)
    if (group == null) groups.set(key, [build])
    else group.push(build)
  }
  const rows = [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort(
        (a, b) =>
          Number(a.variant !== '') - Number(b.variant !== '') ||
          (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0),
      )
      const head = sorted[0]!
      if (sorted.length === 1 && head.variant === '') return install(head)
      return `<section class="build-group" id="run-${escape(head.run ?? String(head.id))}"><div class="build-group-head">${heading(head)}</div>${sorted
        .map((build) =>
          install(build, build.variant === '' ? 'Default' : build.variant),
        )
        .join('')}</section>`
    })
    .join('')
  const ios = chosen === 'ios' && data.builds.length > 0
  return {
    title: data.branch,
    crumbs: [
      ...appCrumbs(data.app, query),
      {
        label: data.branch,
        href: `${appPath}/branches/${branchKey(data.branch)}${query}`,
      },
    ],
    body: `<p class="intro">${labels[chosen]} builds · newest first${ios ? (viewer.hostPages == null ? '<br>Installation links last up to one hour. Refresh this page if a link expires.' : `<br>${HOST_INSTALLS}`) : ''}</p><div class="build-list">${rows || `<section class="card"><h2>No ${labels[chosen]} builds</h2><p>This branch has no retained builds for the selected platform. Choose another platform or publish a new build.</p></section>`}</div>`,
    platforms: platformPill(path, chosen, data.platforms),
    interactive: true,
  }
}

/** After Install on a build the device cannot run: register or prepare. */
export function prepareYourDeviceView(
  viewer: CatalogViewer,
  refusal: { kind: 'register' } | { kind: 'prepare'; buildId: number },
): CatalogPage {
  return {
    title: 'Prepare your device',
    body:
      refusal.kind === 'register'
        ? `<section class="card"><p>Register or select your iPhone or iPad before installing this build.</p><a class="button register-device" href="${escape(registerHref(viewer))}">Register Device</a></section>`
        : `<section class="card"><p>This build does not yet include your device. Mason can prepare a new build of this branch and commit.</p><form method="post" action="/builds/${refusal.buildId}/prepare">${hidden(viewer)}<button>Prepare for this device</button></form></section>`,
    status: 409,
  }
}

/** The iOS installer page an Install form opens. */
export function installView(viewer: CatalogViewer, token: string): CatalogPage {
  return {
    title: 'Install app',
    body:
      viewer.origin === ''
        ? `<section class="card"><p>${NO_IOS_ADDRESS}</p></section>`
        : `<section class="card"><p>Tap Install on iOS, then confirm the installation on your device.</p><a class="button" data-install href="${escape(iosInstallUrl(viewer.origin, token))}">Install on iOS</a><p>This installation link expires within one hour.</p></section>`,
    interactive: true,
  }
}

/** After Prepare for this device. */
export function preparingView(): CatalogPage {
  return {
    title: 'Preparing build',
    body: '<section class="card"><p>Mason will prepare this branch and commit for your device. This can take several minutes; the new build will appear in the app’s build list.</p><a href="/">Browse apps</a></section>',
  }
}

/** Where Register Device goes: here, or the host's page without a public master address. */
export function registerHref(viewer: CatalogViewer): string {
  return viewer.hostPages == null ? '/devices' : `${viewer.hostPages}/devices`
}

const deviceLabels: Record<string, string> = {
  pending: 'Waiting to register with Apple',
  processing: 'Apple registration is processing',
  registered: 'Registered with Apple',
  error: 'Preparation needs attention',
}

/** Devices: how to register, the person's devices, and every device for an administrator. */
export function devicesView(
  data: DevicesData,
  viewer: CatalogViewer,
): CatalogPage {
  const rows = data.devices
    .map(
      (d) =>
        `<section class="card"><h2>${escape(d.name)}</h2><p>${escape(d.model)} · iOS ${escape(d.os_version)}</p><p class="device-state">${escape(deviceLabels[d.status] ?? d.status)}</p>${d.message ? `<p>${escape(d.message)}</p>` : ''}<small class="device-id">Device identifier: ${escape(d.udid)}</small><form method="post" action="/devices/${d.id}/select">${hidden(viewer)}<button class="secondary">${data.selected === d.id ? 'Selected device' : 'Use this device'}</button></form><form method="post" action="/devices/${d.id}/rename">${hidden(viewer)}<label for="name-${d.id}">Friendly name</label><input id="name-${d.id}" name="name" maxlength="120" value="${escape(d.name)}" required><button class="secondary">Save name</button></form>${d.status === 'error' ? `<form method="post" action="/devices/${d.id}/retry">${hidden(viewer)}<button>Retry preparation</button></form>` : ''}<form method="post" action="/devices/${d.id}/remove">${hidden(viewer)}<button class="secondary">Remove from my account</button></form></section>`,
    )
    .join('')
  const content = !data.registration
    ? '<section class="card"><p>Device registration is being configured. Please try again shortly.</p></section>'
    : viewer.hostPages != null
      ? `<section class="card"><p>Register your iPhone or iPad once to install Mason test builds. ${HOST_INSTALLS}</p><a class="button register-device" href="${escape(registerHref(viewer))}">Register on the host</a><p>Using a computer? Scan this code with your iPhone or iPad, then sign in.</p><img class="device-qr" src="/devices/qr" width="180" height="180" alt="QR code to open Mason device registration"><p>Android and desktop apps can be downloaded without iOS device registration.</p></section>`
      : `<section class="card"><p>Register your iPhone or iPad once to install Mason test builds. The temporary profile shares your device identifier, model and OS version. It does not install a root certificate or enroll your device in management.</p><form method="post" action="/devices/profile">${hidden(viewer)}<button class="register-device">Install Registration Profile</button></form><ol><li>Open this page in Safari on your iPhone or iPad and allow the profile download.</li><li>Open Settings → Profile Downloaded → Install. The registration profile may be shown as unsigned.</li><li>Follow Apple's prompts, then return to Mason. Compatible builds will be prepared automatically.</li></ol><p>If Profile Downloaded is missing, look in Settings → General → VPN &amp; Device Management, or download the profile again. Apple removes uninstalled downloads after eight minutes.</p><p>Using a computer? Scan this code with your iPhone or iPad, then sign in.</p><img class="device-qr" src="/devices/qr" width="180" height="180" alt="QR code to open Mason device registration"><p>Android and desktop apps can be downloaded without iOS device registration.</p></section>`
  const all = data.all
    .map(
      (r) =>
        `<p>${escape(r.name)} · ${escape(r.model)} · ${escape(deviceLabels[r.status] ?? r.status)}</p>`,
    )
    .join('')
  return {
    title: 'Devices',
    crumbs: [{ label: 'Devices', href: '/devices' }],
    body:
      content +
      (rows ? '<h2>Your devices</h2>' + rows : '') +
      (all
        ? '<section class="card"><h2>All registered devices</h2>' +
          all +
          '</section>'
        : '') +
      '<a href="/">Browse apps</a>',
    ...(data.devices.some(
      (d) =>
        d.status === 'pending' ||
        d.status === 'processing' ||
        (d.status === 'registered' && d.message === ''),
    )
      ? { refresh: 15 }
      : {}),
  }
}

/** Where a registration link landed: still registering, or registered. */
export function completeView(
  data: Exclude<CompleteData, { state: 'unavailable' }>,
): CatalogPage {
  if (data.state === 'registering')
    return {
      title: 'Registering device',
      body: '<section class="card"><p>Mason has your device and is registering it with Apple. This page updates by itself.</p></section>',
      refresh: 5,
    }
  const model = data.device.model.replace(
    /^(iPhone|iPad|iPod)(.+)$/,
    (_match, family: string, variant: string) =>
      family + ' ' + variant.replace(/(\d|[a-z])([A-Z])/g, '$1 $2'),
  )
  return {
    title: 'Device registered',
    body: `<section class="card"><p>You've registered the following device: <strong>${escape(model)}</strong>.</p><p>A new build of the applications is required before you can install them on your device. Mason will prepare these builds automatically.</p><p>Builds take approximately <strong>30 to 60 minutes</strong> to become available. Please check back in that time.</p><div class="actions"><a class="button" href="/">Browse apps</a><a href="/devices">View your devices</a></div></section>`,
  }
}
