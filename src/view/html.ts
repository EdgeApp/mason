import type { ViewerNode } from './shell.js'

/** Escapes text for HTML content and attribute values. */
export function escape(value: string | number): string {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  )
}

/** A time as UTC text in a `<time>` element. */
export function time(at: number): string {
  const iso = new Date(at).toISOString()
  return `<time datetime="${iso}" title="${iso}">${iso.slice(0, 16).replace('T', ' ')} UTC</time>`
}

/**
 * A time zone's short name: the generic one where it is short (`PT`, `ET`),
 * else the specific one (`UTC`, `GMT+1`).
 */
function zoneName(at: Date, timeZone: string | undefined): string {
  const name = (style: 'shortGeneric' | 'short'): string =>
    new Intl.DateTimeFormat('en-US', {
      ...(timeZone == null ? {} : { timeZone }),
      timeZoneName: style,
    })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? ''
  const generic = name('shortGeneric')
  return /\s|^GMT/.test(generic) || generic === '' ? name('short') : generic
}

/**
 * A date and 24-hour time with its zone, `2026-11-01 1435 PT`: in the
 * given zone, or the viewer's own in a browser.
 */
export function stamp(at: number, timeZone?: string): string {
  const date = new Date(at)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      ...(timeZone == null ? {} : { timeZone }),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}${parts.minute} ${zoneName(date, timeZone)}`
}

/** Within a day, hours and minutes ago (`2:31 ago`); after that the date and time, as {@link stamp}. */
export function since(at: number, now: number, timeZone?: string): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes >= 24 * 60) return stamp(at, timeZone)
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')} ago`
}

/**
 * A time the browser shows in the viewer's own zone: `since` (`2:31 ago`,
 * or the date and time after a day) or `date`. The server writes it in UTC
 * until the page's script rewrites it.
 */
export function localTime(
  at: number,
  now: number,
  format: 'since' | 'date',
): string {
  const iso = new Date(at).toISOString()
  return `<time datetime="${iso}" title="${iso}" data-at="${at}" data-format="${format}">${escape(format === 'since' ? since(at, now, 'UTC') : stamp(at, 'UTC'))}</time>`
}

/** A run as pages and lists name it: `Run 12`, with its workflow when that is not `build`. */
export function runName(workflow: string, number: number): string {
  return `Run ${number}${workflow === 'build' ? '' : ` · ${workflow}`}`
}

/** A duration such as `4m 12s`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** How long ago, coarsely: `now`, `5m ago`, `3h ago`, `2d ago`. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

/** One level of a page's breadcrumb trail. */
export interface Crumb {
  label: string
  href: string
  /** `data-*` attributes, for a script that keeps the label current (`group-title`). */
  data?: Record<string, string>
}

/**
 * Where the page is, as a row of pill links: Mason Master (on the master)
 * or Mason Host (on a host or a standalone server), linking to `/`, then
 * each level down to this page, the last one current. Every page draws its
 * trail with this.
 */
export function breadcrumbs(
  viewer: { node: ViewerNode },
  items: Crumb[],
): string {
  const trail: Crumb[] = [
    {
      label: viewer.node === 'master' ? 'Mason Master' : 'Mason Host',
      href: '/',
    },
    ...items,
  ]
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${trail
    .map(
      (item, index) =>
        `<li>${index === 0 ? '' : '<span class="crumb-sep" aria-hidden="true">›</span>'}<a class="crumb" href="${escape(item.href)}"${index === trail.length - 1 ? ' aria-current="page"' : ''}${Object.entries(
          item.data ?? {},
        )
          .map(([key, value]) => ` data-${key}="${escape(value)}"`)
          .join('')}>${escape(item.label)}</a></li>`,
    )
    .join('')}</ol></nav>`
}

/** The first levels of every project page: Projects, then the project. */
export function projectCrumbs(slug: string, name: string): Crumb[] {
  return [
    { label: 'Projects', href: '/projects' },
    { label: name, href: `/projects/${encodeURIComponent(slug)}` },
  ]
}

/**
 * A project's Runs and builds, then the branch picked there: the branch's
 * runs are `?branch=`, and Runs and builds itself is All branches.
 */
export function runsCrumbs(
  slug: string,
  name: string,
  branch?: string,
): Crumb[] {
  const runs = `/projects/${encodeURIComponent(slug)}/runs`
  return [
    ...projectCrumbs(slug, name),
    { label: 'Runs and builds', href: runs },
    ...(branch == null
      ? []
      : [
          {
            label: branch,
            href: `${runs}?branch=${encodeURIComponent(branch)}`,
          },
        ]),
  ]
}

/** Where an app ID's pages are: `/projects/:slug/apps/:appId`, its Runs and builds. */
export function appPath(slug: string, appId: string): string {
  return `/projects/${encodeURIComponent(slug)}/apps/${encodeURIComponent(appId)}`
}

/**
 * An app ID's pages, one level below its project: the app ID, then its tab
 * (Runs and builds, which is the app ID's own page, or Build numbers), then
 * the branch picked on Runs and builds.
 */
export function appCrumbs(
  slug: string,
  name: string,
  appId: string,
  tab: 'runs' | 'build-numbers',
  branch?: string,
): Crumb[] {
  const base = appPath(slug, appId)
  return [
    ...projectCrumbs(slug, name),
    { label: appId, href: base },
    tab === 'runs'
      ? { label: 'Runs and builds', href: base }
      : { label: 'Build numbers', href: `${base}/build-numbers` },
    ...(tab === 'runs' && branch != null
      ? [
          {
            label: branch,
            href: `${base}?branch=${encodeURIComponent(branch)}`,
          },
        ]
      : []),
  ]
}
