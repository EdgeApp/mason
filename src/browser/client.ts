// Progressive enhancement: links and forms work without JavaScript.
const platforms = new Set(['ios', 'android', 'macos', 'windows'])
function localTimes(): void {
  for (const node of document.querySelectorAll<HTMLTimeElement>(
    'time[datetime]',
  )) {
    const date = new Date(node.dateTime)
    if (Number.isFinite(date.valueOf()))
      node.textContent = date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'long',
      })
  }
}
let lastScrollWrite = -Infinity
function saveScroll(throttle = false): void {
  const now = Date.now()
  if (throttle && now - lastScrollWrite < 1000) return
  lastScrollWrite = now
  try {
    history.replaceState({ x: scrollX, y: scrollY }, '', location.href)
  } catch {
    // A browser quota must never prevent the actual navigation.
  }
}
let navigationId = 0
async function replace(
  url: URL,
  mode: 'push' | 'replace' | 'pop',
  x: number,
  y: number,
): Promise<void> {
  const id = ++navigationId
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'follow',
    })
    if (id !== navigationId) return
    if (!response.ok || response.url !== url.href) {
      location.assign(response.url)
      return
    }
    const body = await response.text()
    if (id !== navigationId) return
    const parsed = new DOMParser().parseFromString(body, 'text/html')
    const main = parsed.querySelector('main'),
      nav = parsed.querySelector('nav')
    if (main == null || nav == null) throw new Error('Invalid page')
    document.querySelector('main')!.replaceWith(main)
    document.querySelector('nav')!.replaceWith(nav)
    document.title = parsed.title
    if (mode === 'push') history.pushState({ x, y }, '', url)
    if (mode === 'replace') history.replaceState({ x, y }, '', url)
    const platform = url.searchParams.get('platform')
    if (platform != null && platforms.has(platform))
      document.cookie = `mason-platform=${platform}; Path=/; Max-Age=31536000; Secure; SameSite=Lax`
    localTimes()
    requestAnimationFrame(() => scrollTo(x, y))
  } catch {
    if (id === navigationId) location.assign(url)
  }
}
const current = new URL(location.href)
const catalogPage =
  current.pathname === '/' ||
  /^\/apps\/[0-9]+(?:\/branches\/[A-Za-z0-9_-]+)?$/.test(current.pathname)
if (catalogPage) {
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const link = event.target.closest<HTMLAnchorElement>('a[data-platform]')
    if (
      link == null ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    event.preventDefault()
    saveScroll()
    const url = new URL(link.href)
    if (url.href === location.href) ++navigationId
    else void replace(url, 'push', scrollX, scrollY)
  })
  window.addEventListener('popstate', (event) => {
    const state: unknown = event.state
    const position =
      state != null && typeof state === 'object'
        ? (state as Record<string, unknown>)
        : {}
    void replace(
      new URL(location.href),
      'pop',
      typeof position.x === 'number' ? position.x : 0,
      typeof position.y === 'number' ? position.y : 0,
    )
  })
  window.addEventListener('pagehide', () => saveScroll())
  window.addEventListener('scroll', () => saveScroll(true), { passive: true })
  localTimes()

  if (!current.searchParams.has('platform')) {
    const hasPreference = document.cookie
      .split(';')
      .some((part) =>
        /^\s*mason-platform=(ios|android|macos|windows)$/.test(part),
      )
    const ipad =
      !hasPreference &&
      /Mac/.test(navigator.platform) &&
      navigator.maxTouchPoints > 1
    const chosen = document.querySelector<HTMLAnchorElement>(
      'nav a[data-platform][aria-current="true"]',
    )?.dataset.platform
    if (ipad) {
      current.searchParams.set('platform', 'ios')
      void replace(current, 'replace', scrollX, scrollY)
    } else if (chosen != null && platforms.has(chosen)) {
      current.searchParams.set('platform', chosen)
      try {
        history.replaceState(
          history.state ?? { x: scrollX, y: scrollY },
          '',
          current,
        )
      } catch {
        /* Links remain usable when the browser denies a history write. */
      }
    }
  }
}
export {}
